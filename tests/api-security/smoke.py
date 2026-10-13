"""Dev-only live checks: reject unauthenticated access and verify deployed CSP.

No wallet, token, nonce creation, funding, or report download is used.
This is not the two-wallet escrow test; see docs/aws-hardening-2026-10-12.md.
"""
import argparse
import json
import sys
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEV_API_URL = "https://mgzbzfov0g.execute-api.us-east-1.amazonaws.com"
DEV_FRONTEND_URL = "https://staging.dhkblca1hli2z.amplifyapp.com"
DEV_REPORTS_BUCKET = "proofsec-reports-dev-189393508938-us-east-1"


def validate_environment(api_url, frontend_url, reports_bucket, stack_name, cluster):
    expected = (DEV_API_URL, DEV_FRONTEND_URL, DEV_REPORTS_BUCKET, "proofsec-dev", "devnet")
    if (api_url, frontend_url, reports_bucket, stack_name, cluster) != expected:
        raise ValueError("Destination differs from the reviewed ProofSec dev environment; no probes sent.")


class RedirectBlocked(RuntimeError):
    pass


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RedirectBlocked("Redirect refused; no request sent to its destination.")


def check_url(value):
    url = urlparse(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise argparse.ArgumentTypeError("Use an HTTPS origin without credentials, query, or fragment.")
    if url.path not in ("", "/"):
        raise argparse.ArgumentTypeError("Use the origin without a path.")
    return value.rstrip("/")


def request(url, method="GET", token=None):
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in (DEV_API_URL, DEV_FRONTEND_URL):
        raise ValueError("Probe destination is outside the reviewed dev environment.")
    headers = {"Accept": "application/json", "User-Agent": "ProofSec-dev-security-smoke/1"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = b"{}" if method != "GET" else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with build_opener(NoRedirects()).open(req, timeout=20) as response:
            return response.status, response.headers, response.read(1_000_000)
    except HTTPError as response:
        return response.code, response.headers, response.read(1_000_000)


def run(api_url, frontend_url, reports_bucket, stack_name="proofsec-dev", cluster="devnet"):
    validate_environment(api_url, frontend_url, reports_bucket, stack_name, cluster)
    failures = []

    def record(label, ok):
        print(("PASS " if ok else "FAIL ") + label)
        if not ok:
            failures.append(label)

    for method, path in (("GET", "/jobs/mine"), ("POST", "/jobs"), ("PUT", "/users/me/encryption-key"), ("POST", "/evidence/upload-url"), ("POST", "/evidence/download-url"), ("POST", "/agent/propose")):
        for token in (None, "not-a-jwt"):
            status, _, _ = request(api_url + path, method, token)
            record(f"{method} {path}: {'missing' if token is None else 'invalid'} token denied", status in (401, 403))
    status, _, body = request(api_url + "/jobs?limit=5&offset=0")
    record("public job listing available", status == 200)
    if status == 200:
        payload = json.loads(body)
        valid_shape = (isinstance(payload, dict) and payload.get("success") is True
                       and isinstance(payload.get("jobs"), list)
                       and all(isinstance(j, dict) for j in payload["jobs"]))
        record("public listing has the expected response shape", valid_shape)
        jobs = payload["jobs"] if valid_shape else []
        record("public listing excludes drafts and proposals", valid_shape and all(j.get("status") == "ONCHAIN" for j in jobs))
        record("public listing excludes private scope documents", valid_shape and all("scopeDocument" not in j for j in jobs))
    status, headers, _ = request(frontend_url)
    record("frontend available", status == 200)
    csp = headers.get("Content-Security-Policy", "")
    directives = dict((parts[0], parts[1:]) for d in csp.split(";") if (parts := d.strip().split()))
    allowed = directives.get("connect-src", [])
    record("CSP limits AWS connections", bool(allowed) and not any("*" in host for host in allowed))
    record("CSP includes both S3 report endpoint formats", all(origin in allowed for origin in (f"https://{reports_bucket}.s3.amazonaws.com", f"https://{reports_bucket}.s3.us-east-1.amazonaws.com")))
    record("CSP allows the configured API", api_url in allowed)
    record("CSP blocks framing and plugin objects", directives.get("frame-ancestors") == ["'none'"] and directives.get("object-src") == ["'none'"])
    record("security headers served", headers.get("X-Content-Type-Options") == "nosniff" and headers.get("X-Frame-Options") == "DENY" and bool(headers.get("Strict-Transport-Security")))
    print(f"{len(failures)} failed checks; no tokens, report contents, or wallet credentials logged.")
    return 1 if failures else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", type=check_url, required=True)
    parser.add_argument("--frontend-url", type=check_url, required=True)
    parser.add_argument("--reports-bucket", required=True)
    parser.add_argument("--stack-name", choices=["proofsec-dev"], required=True)
    parser.add_argument("--cluster", choices=["devnet"], required=True)
    args = parser.parse_args()
    try:
        sys.exit(run(args.api_url, args.frontend_url, args.reports_bucket, args.stack_name, args.cluster))
    except Exception as exc:
        print(f"FAIL transport or response validation ({type(exc).__name__}); test incomplete.", file=sys.stderr)
        sys.exit(1)
