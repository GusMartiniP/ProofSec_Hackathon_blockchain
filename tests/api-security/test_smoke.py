"""Regression properties: probes stay in dev and malformed data cannot pass.

IR-1 attacks redirect probes to production; IR-2 replaces a listing with an
error-shaped HTTP 200 response. Both fail against the original smoke runner.
All responses are synthetic; no network, wallet, token, or AWS call is used.
"""
import contextlib
import importlib.util
import io
import json
from email.message import Message
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.request import Request

spec = importlib.util.spec_from_file_location("proofsec_smoke", Path(__file__).with_name("smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeSafetyTest(unittest.TestCase):
    def run_listing(self, payload):
        headers = {
            "Content-Security-Policy": (
                f"connect-src 'self' {smoke.DEV_API_URL} "
                f"https://{smoke.DEV_REPORTS_BUCKET}.s3.amazonaws.com "
                f"https://{smoke.DEV_REPORTS_BUCKET}.s3.us-east-1.amazonaws.com; "
                "frame-ancestors 'none'; object-src 'none'"
            ),
            "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
            "Strict-Transport-Security": "max-age=31536000",
        }

        def response(url, method="GET", token=None):
            if url == smoke.DEV_FRONTEND_URL:
                return 200, headers, b""
            if url.endswith("/jobs?limit=5&offset=0"):
                return 200, {}, json.dumps(payload).encode()
            return 403, {}, b""

        with patch.object(smoke, "request", side_effect=response), contextlib.redirect_stdout(io.StringIO()):
            return smoke.run(smoke.DEV_API_URL, smoke.DEV_FRONTEND_URL, smoke.DEV_REPORTS_BUCKET)

    def test_unreviewed_destinations_abort_before_probes(self):
        baseline = [smoke.DEV_API_URL, smoke.DEV_FRONTEND_URL, smoke.DEV_REPORTS_BUCKET, "proofsec-dev", "devnet"]
        for index, attack in enumerate(("https://prod.example.com", "https://prod.example.com", "prod-reports", "proofsec-prod", "mainnet-beta")):
            args = baseline.copy()
            args[index] = attack
            with self.subTest(attack=attack), patch.object(smoke, "request") as request:
                with self.assertRaises(ValueError):
                    smoke.run(*args)
                request.assert_not_called()

    def test_direct_request_to_unreviewed_origin_is_rejected(self):
        with patch.object(smoke, "build_opener") as opener:
            with self.assertRaises(ValueError):
                smoke.request("https://prod.example.com/jobs", "POST")
            opener.assert_not_called()

    def test_redirect_handler_never_sends_redirected_request(self):
        handler = smoke.NoRedirects()
        headers = Message()
        headers["Location"] = "https://prod.example.com/jobs"
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status), patch.object(handler, "parent", create=True) as parent:
                with self.assertRaises(smoke.RedirectBlocked):
                    handler.http_error_302(Request(smoke.DEV_API_URL + "/jobs", data=b"{}"), io.BytesIO(), status, "redirect", headers)
                parent.open.assert_not_called()

    def test_error_shaped_success_response_fails(self):
        for payload in ({}, {"error": "failed"}, [], {"success": False, "jobs": []}, {"success": True, "jobs": {}}, {"success": True, "jobs": ["bad"]}):
            with self.subTest(payload=payload):
                self.assertEqual(self.run_listing(payload), 1)

    def test_drafts_and_private_scope_fail(self):
        for job in ({"status": "DRAFT"}, {"status": "ONCHAIN", "scopeDocument": "synthetic private scope"}):
            with self.subTest(job=job):
                self.assertEqual(self.run_listing({"success": True, "jobs": [job]}), 1)

    def test_valid_public_and_empty_listings_pass(self):
        for jobs in ([], [{"status": "ONCHAIN", "jobId": "synthetic"}]):
            with self.subTest(jobs=jobs):
                self.assertEqual(self.run_listing({"success": True, "jobs": jobs}), 0)


if __name__ == "__main__":
    unittest.main()
