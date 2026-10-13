"""Render reviewable SSO permission sets from the ADR-024 policy source; no AWS calls.

Run with Python + PyYAML. Never creates users, credentials, or live assignments.
See docs/decisions.md (ADR-029) and docs/aws-hardening-2026-10-12.md.
"""
import copy
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


class Loader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    value = loader.construct_scalar(node)
    return {"Ref" if tag == "Ref" else "Fn::" + tag: value}


Loader.add_multi_constructor("!", intrinsic)


def render():
    source = yaml.load((ROOT / "docs/iam/agent-users.yaml").read_text(encoding="utf-8"), Loader=Loader)
    resources = {}
    for key in ("GuardrailsPolicy", "ReadBaselinePolicy", "ClaudeCodeDeployReviewPolicy"):
        resources[key] = copy.deepcopy(source["Resources"][key])
        props = resources[key]["Properties"]
        props["ManagedPolicyName"] = {"Fn::Sub": "${AWS::StackName}-" + key.lower()}
        props["Path"] = "/proofsec/agents/"
        resources[key]["Metadata"] = {"com.aws.cloudformation.Context": {
            "why": "Reuse ADR-024 permissions with temporary SSO sessions.",
            "must": ["No IAM writes, secret/report access, or changeset execution by agents."],
        }}
    parameters = {
        "Stage": {"Type": "String", "Default": "dev", "AllowedValues": ["dev"]},
        "AppRegion": {"Type": "String", "Default": "us-east-1", "AllowedValues": ["us-east-1"]},
        "InstanceArn": {"Type": "String", "AllowedPattern": "arn:aws:sso:::instance/ssoins-[a-zA-Z0-9]+", "Description": "Existing IAM Identity Center instance in the selected Region."},
    }
    conditions = {}
    outputs = {}
    for agent, name, policies, audit in (
        ("Codex", "ProofSecCodexReadOnly", ["GuardrailsPolicy", "ReadBaselinePolicy"], False),
        ("Claude", "ProofSecClaudePlan", ["GuardrailsPolicy", "ReadBaselinePolicy", "ClaudeCodeDeployReviewPolicy"], False),
        ("Review", "ProofSecReviewReadOnly", ["GuardrailsPolicy", "ReadBaselinePolicy"], True),
    ):
        principal = agent + "PrincipalId"
        parameters[principal] = {"Type": "String", "Default": "", "AllowedPattern": "^$|^[a-zA-Z0-9-]+$", "Description": "Existing dedicated SSO user ID; empty creates no account assignment."}
        conditions["Has" + agent] = {"Fn::Not": [{"Fn::Equals": [{"Ref": principal}, ""]}]}
        ps = agent + "PermissionSet"
        resources[ps] = {
            "Type": "AWS::SSO::PermissionSet", "DependsOn": policies,
            "Metadata": {"com.aws.cloudformation.Context": {
                "why": "Separate agent capabilities; existing administrator access remains human-controlled.",
                "must": ["Temporary sessions only; no persistent keys or administrator policy for agents."],
            }},
            "Properties": {
                "InstanceArn": {"Ref": "InstanceArn"}, "Name": name, "SessionDuration": "PT1H",
                "Description": "ProofSec dev-only agent access; ADR-024 and ADR-029.",
                "ManagedPolicies": [{"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/AWSMCPSignInOAuthAccessPolicy"}] + ([{"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/SecurityAudit"}] if audit else []),
                "CustomerManagedPolicyReferences": [{"Name": resources[p]["Properties"]["ManagedPolicyName"], "Path": "/proofsec/agents/"} for p in policies],
                "Tags": [{"Key": "Project", "Value": "proofsec"}, {"Key": "Environment", "Value": "dev"}],
            },
        }
        resources[agent + "Assignment"] = {
            "Type": "AWS::SSO::Assignment", "Condition": "Has" + agent,
            "Properties": {"InstanceArn": {"Ref": "InstanceArn"}, "PermissionSetArn": {"Fn::GetAtt": [ps, "PermissionSetArn"]}, "PrincipalId": {"Ref": principal}, "PrincipalType": "USER", "TargetId": {"Ref": "AWS::AccountId"}, "TargetType": "AWS_ACCOUNT"},
        }
        outputs[ps] = {"Description": "Permission set ARN; human configures its dedicated SSO profile.", "Value": {"Fn::GetAtt": [ps, "PermissionSetArn"]}}
    return {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Description": "ProofSec agent permission sets using existing Identity Center; no users or credentials created; human executes changeset.",
        "Metadata": {"AWSToolsMetrics": {"AWSAgentToolkit": "aws-cloudformation@3"}, "com.aws.cloudformation.Context": {"ref": ["docs/decisions.md", "docs/aws-hardening-2026-10-12.md"], "must": ["ADR-029 requires approval before deployment.", "No removal of existing administrator assignments."]}},
        "Parameters": parameters, "Conditions": conditions, "Resources": resources, "Outputs": outputs,
    }


if __name__ == "__main__":
    target = ROOT / "docs/iam/agent-permission-sets.json"
    target.write_text(json.dumps(render(), indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {target.name}; no AWS configuration changed.")
