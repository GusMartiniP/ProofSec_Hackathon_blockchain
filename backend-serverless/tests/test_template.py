"""Regressão de template: o API Gateway precisa de permissão para invocar o authorizer.

Sem o AWS::Lambda::Permission, toda rota autenticada devolvia 500
("doesn't have permissions to call the authorizer") e só /auth/* e /jobs funcionavam.
"""
import re
import unittest
from pathlib import Path

TEMPLATE = (Path(__file__).resolve().parents[1] / "template.yaml").read_text(encoding="utf-8")


def _block(name: str) -> str:
    m = re.search(rf"^  {name}:\n(.*?)(?=^  \w|\Z)", TEMPLATE, re.S | re.M)
    assert m, f"recurso {name} ausente no template"
    return m.group(1)


class AuthorizerPermissionTest(unittest.TestCase):
    def test_apigateway_can_invoke_authorizer(self):
        block = _block("AuthorizerInvokePermission")
        self.assertIn("Type: AWS::Lambda::Permission", block)
        self.assertIn("FunctionName: !Ref AuthorizerFunction", block)
        self.assertIn("Principal: apigateway.amazonaws.com", block)

    def test_permission_is_scoped_to_this_api(self):
        block = _block("AuthorizerInvokePermission")
        self.assertIn("${ProofSecApi}/authorizers/*", block)
        self.assertNotIn('SourceArn: "*"', block)


class ApiAccessLogDriftTest(unittest.TestCase):
    def test_destination_arn_has_no_log_stream_wildcard(self):
        block = _block("ProofSecApi")
        self.assertIn("AccessLogSettings:", block)
        self.assertIn("log-group:/proofsec/${Stage}/api-access\"", block)
        self.assertNotIn("DestinationArn: !GetAtt ApiAccessLogGroup.Arn", block)


class AgentBudgetScaleTest(unittest.TestCase):
    """ADR-026: a escala só existe para o dev; fora dele o template exige 1."""

    def test_parameter_is_wired_to_both_agent_functions(self):
        self.assertEqual(TEMPLATE.count("AGENT_BUDGET_SCALE: !Ref AgentBudgetScale"), 2)

    def test_non_dev_stages_must_use_scale_one(self):
        rule = re.search(r"^  NonDevHardening:\n(.*?)(?=^\w)", TEMPLATE, re.S | re.M).group(1)
        self.assertIn("!Equals [!Ref AgentBudgetScale, '1']", rule)

    def test_only_reductions_are_accepted(self):
        param = re.search(r"^  AgentBudgetScale:\n(.*?)(?=^  \w|\Z)", TEMPLATE, re.S | re.M).group(1)
        self.assertIn("AllowedPattern: '^(1|0\\.[0-9]{1,3})$'", param)


class AwsHardeningTest(unittest.TestCase):
    """Keep cost alerts independent of credits and audit within the selected Region."""

    def test_ceiling_never_exceeds_the_approved_140_usd(self):
        block = _block("MonthlyCeilingUsd")
        self.assertIn("Default: 140", block)
        self.assertIn("MinValue: 1", block)
        self.assertIn("MaxValue: 140", block)

    def test_ceiling_adds_early_and_forecast_alerts_without_removing_operating_budget(self):
        ceiling = _block("MonthlyCeilingBudget")
        self.assertIn("Condition: HasAlertEmail", ceiling)
        self.assertIn("Amount: !Ref MonthlyCeilingUsd", ceiling)
        self.assertIn("IncludeCredit: false", ceiling)
        self.assertIn("IncludeRefund: false", ceiling)
        for threshold in (50, 75, 90, 100):
            self.assertIn(f"NotificationType: ACTUAL, ComparisonOperator: GREATER_THAN, Threshold: {threshold},", ceiling)
        self.assertIn("NotificationType: FORECASTED", ceiling)
        self.assertEqual(ceiling.count("Address: !Ref AlertEmail"), 5)
        self.assertNotIn("AWS::Budgets::BudgetsAction", TEMPLATE)
        self.assertIn("Amount: !Ref MonthlyBudgetUsd", _block("MonthlyBudget"))

    def test_cloudtrail_is_single_region_validated_and_covers_report_access(self):
        trail = _block("Trail")
        self.assertIn("IsMultiRegionTrail: false", trail)
        self.assertIn("IsLogging: true", trail)
        self.assertIn("EnableLogFileValidation: true", trail)
        self.assertIn("IncludeManagementEvents: true", trail)
        self.assertIn("AWS::S3::Object", trail)
        self.assertIn("proofsec-reports-${Stage}", trail)
        bucket = _block("TrailBucket")
        self.assertIn("DeletionPolicy: Retain", bucket)
        self.assertIn("UpdateReplacePolicy: Retain", bucket)
        for setting in ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"):
            self.assertIn(f"{setting}: true", bucket)


if __name__ == "__main__":
    unittest.main()
