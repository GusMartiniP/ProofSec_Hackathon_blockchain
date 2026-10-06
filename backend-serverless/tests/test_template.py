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


if __name__ == "__main__":
    unittest.main()
