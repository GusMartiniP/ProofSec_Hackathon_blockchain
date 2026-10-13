"""
Testes locais do backend (sem AWS): `python -m unittest discover -s tests -v`
boto3 é substituído por fakes em memória. Requer apenas `cryptography` (requirements-dev.txt).
"""
import base64
import hashlib
import io
import json
import os
import re
import struct
import sys
import time
import types
import unittest
from decimal import Decimal
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "functions"))
os.environ.update({
    "JWT_SECRET": "x" * 40,
    "AGENT_API_KEY": "agent-key-12345678901234567890123456789012",
    "REPORTS_BUCKET": "bucket",
    "SIWS_DOMAINS": "localhost:3000,proofsec.app",
    "ALERT_TOPIC_ARN": "arn:aws:sns:us-east-1:000000000000:alerts",
    "SOLANA_RPC_URL": "https://primary.rpc",
    "SOLANA_RPC_URL_FALLBACK": "https://fallback.rpc",
})


# ---------------------------------------------------------------- fakes boto3
class ConditionalCheckFailedException(Exception):
    pass


class FakeTable:
    def __init__(self, key):
        self.key, self.items, self.writes = key, {}, 0

    @staticmethod
    def _load(item):
        return json.loads(json.dumps(item), parse_float=Decimal, parse_int=Decimal)

    def get_item(self, Key):
        item = self.items.get(Key[self.key])
        return {"Item": self._load(item)} if item else {}

    def put_item(self, Item, ConditionExpression=None):
        for v in Item.values():
            if isinstance(v, float):
                raise TypeError("Float types are not supported. Use Decimal types instead.")
        if ConditionExpression and "attribute_not_exists" in ConditionExpression and Item[self.key] in self.items:
            raise ConditionalCheckFailedException("ConditionalCheckFailed")
        self.items[Item[self.key]] = json.loads(json.dumps(Item, default=str))
        self.writes += 1

    def delete_item(self, Key, ConditionExpression=None):
        if ConditionExpression and "attribute_exists" in ConditionExpression and Key[self.key] not in self.items:
            raise ConditionalCheckFailedException("ConditionalCheckFailed")
        self.items.pop(Key[self.key], None)

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ReturnValues):
        item = self.items.get(Key[self.key])
        values = ExpressionAttributeValues
        valid = (
            item
            and item.get("status") == values[":onchain"]
            and item.get("onchainStatus") == values[":open"]
            and not item.get("researcherWallet")
        )
        applicants = list((item or {}).get("applicants") or [])
        wallet = values[":wallet"]
        if not valid or wallet in applicants or len(applicants) >= values[":max"]:
            raise ConditionalCheckFailedException("ConditionalCheckFailed")
        applicants.append(wallet)
        item["applicants"] = applicants
        item["updatedAt"] = values[":now"]
        self.writes += 1
        return {"Attributes": self._load(item)}

    def query(self, IndexName, KeyConditionExpression, Limit=100, ExclusiveStartKey=None):
        attr, value = KeyConditionExpression
        rows = sorted(
            (i for i in self.items.values() if i.get(attr) == value),
            key=lambda i: i[self.key],
        )
        if ExclusiveStartKey:
            start = next((i + 1 for i, row in enumerate(rows) if row[self.key] == ExclusiveStartKey[self.key]), len(rows))
            rows = rows[start:]
        page = rows[:Limit]
        result = {"Items": [self._load(r) for r in page]}
        if len(rows) > Limit:
            result["LastEvaluatedKey"] = {self.key: page[-1][self.key]}
        return result


TABLES = {"ProofSec-Jobs": FakeTable("jobId"), "ProofSec-Users": FakeTable("wallet"), "ProofSec-Nonces": FakeTable("nonce")}


class FakeKey:
    def __init__(self, attr):
        self.attr = attr

    def eq(self, value):
        return (self.attr, value)


class FakeS3:
    def __init__(self):
        self.objects, self.deleted, self.last_presign = {}, [], None

    def generate_presigned_url(self, op, Params, ExpiresIn):
        self.last_presign = {"op": op, "Params": Params, "ExpiresIn": ExpiresIn}
        return f"https://s3.fake/{op}/{Params['Key']}"

    def head_object(self, **kw):
        if kw["Key"] not in self.objects:
            raise Exception("404")
        return {}

    def get_object(self, **kw):
        return {"Body": io.BytesIO(self.objects[kw["Key"]])}

    def delete_object(self, **kw):
        self.deleted.append(kw)
        self.objects.pop(kw["Key"], None)


class FakeSSM:
    def __init__(self):
        self.params, self.calls = {}, 0

    def get_parameter(self, Name, WithDecryption):
        self.calls += 1
        if Name not in self.params:
            raise Exception("ParameterNotFound")
        return {"Parameter": {"Value": self.params[Name]}}


class FakeSNS:
    def __init__(self):
        self.messages = []

    def publish(self, **kw):
        self.messages.append(kw)
        return {"MessageId": "1"}


S3, SSM, SNS = FakeS3(), FakeSSM(), FakeSNS()
CLIENTS = {"s3": S3, "ssm": SSM, "sns": SNS}

boto3 = types.ModuleType("boto3")
boto3.resource = lambda name: types.SimpleNamespace(Table=lambda n: TABLES[n])
boto3.client = lambda name, config=None: CLIENTS[name]
conditions = types.ModuleType("boto3.dynamodb.conditions")
conditions.Key = FakeKey
dynamodb_mod = types.ModuleType("boto3.dynamodb")
botocore = types.ModuleType("botocore")
botocore_config = types.ModuleType("botocore.config")


class Config:
    def __init__(self, **kw):
        self.kw = kw


botocore_config.Config = Config
sys.modules.update({
    "boto3": boto3, "boto3.dynamodb": dynamodb_mod, "boto3.dynamodb.conditions": conditions,
    "botocore": botocore, "botocore.config": botocore_config,
})

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

import agent  # noqa: E402
import auth  # noqa: E402
import evidence  # noqa: E402
import indexer  # noqa: E402
import jobs  # noqa: E402
from common import b58, ed25519, http, jwt, policy, scope, secret_store, solana, sync  # noqa: E402


def keypair():
    sk = Ed25519PrivateKey.generate()
    pk = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return sk, pk, b58.b58encode(pk)


def authed(wallet, body=None, path=None, query=None):
    return {
        "body": json.dumps(body or {}),
        "pathParameters": path,
        "queryStringParameters": query,
        "requestContext": {"authorizer": {"lambda": {"wallet": wallet}}},
        "headers": {},
    }


def body_of(resp):
    return json.loads(resp["body"])


def make_job_account(job_id, client, researcher=b"\0" * 32, status=0, evidence=b"\0" * 32,
                     scope_hash=b"\1" * 32, by_agent=True, arbiter=b"\4" * 32, rent_payer=b"\5" * 32,
                     fee_bps=250, dispute_period=120, dispute_deadline=0, treasury=b"" * 32):
    data = solana.JOB_DISCRIMINATOR + client + researcher + b"\2" * 32 + b"\3" * 32
    data += struct.pack("<Qqqq", 350_000_000, 2_000_000_000, 3600, 0)
    data += scope_hash + evidence + bytes([status, int(by_agent), 254, 253])
    data += arbiter + rent_payer + struct.pack("<Hqq", fee_bps, dispute_period, dispute_deadline) + treasury
    data += struct.pack("<I", len(job_id)) + job_id.encode()
    return data + b"\0" * (32 - len(job_id))


def onchain_for(job, client_b, **kw):
    oc = solana.decode_job(make_job_account(job["jobId"], client_b, scope_hash=bytes.fromhex(job["scopeHash"]), **kw))
    oc["jobPda"] = "PDA" + job["jobId"]
    return oc


def get_item(job_id):
    return TABLES["ProofSec-Jobs"].get_item(Key={"jobId": job_id}).get("Item")


def login(sk, wallet, domain="localhost:3000", uri="http://localhost:3000"):
    r = auth.nonce({"body": json.dumps({"wallet": wallet, "domain": domain, "uri": uri})}, None)
    msg = body_of(r)["message"]
    sig = b58.b58encode(sk.sign(msg.encode()))
    return msg, sig, auth.verify_signature({"body": json.dumps({"wallet": wallet, "message": msg, "signature": sig})}, None)


class Base(unittest.TestCase):
    def setUp(self):
        for t in TABLES.values():
            t.items.clear()
            t.writes = 0
        SNS.messages.clear()
        S3.objects.clear()
        S3.deleted.clear()
        S3.last_presign = None


# ======================================================================
class TestPrimitives(Base):
    def test_b58_roundtrip(self):
        for data in [b"\0\0abc", os.urandom(32), b"\0" * 32]:
            self.assertEqual(b58.b58decode(b58.b58encode(data)), data)
        self.assertEqual(b58.b58encode(b"\0" * 32), b58.DEFAULT_PUBKEY)
        self.assertTrue(b58.is_pubkey("PrfSec1111111111111111111111111111111111111"))

    def test_ed25519_against_cryptography(self):
        for _ in range(3):
            sk, pk, _ = keypair()
            msg = os.urandom(50)
            sig = sk.sign(msg)
            self.assertTrue(ed25519.verify(pk, msg, sig))
            self.assertFalse(ed25519.verify(pk, msg + b"x", sig))
            bad = bytearray(sig)
            bad[5] ^= 1
            self.assertFalse(ed25519.verify(pk, msg, bytes(bad)))

    def test_jwt(self):
        t = jwt.encode({"sub": "w", "exp": 9999999999}, "s" * 40)
        self.assertEqual(jwt.decode(t, "s" * 40)["sub"], "w")
        with self.assertRaises(ValueError):
            jwt.decode(t, "o" * 40)
        with self.assertRaises(ValueError):
            jwt.decode(jwt.encode({"sub": "w", "exp": 1}, "s" * 40), "s" * 40)

    def test_decimal_serialization(self):
        # Bug B1 original: json.dumps(Decimal) quebrava GET /jobs
        out = json.loads(http.dumps({"a": Decimal("10"), "b": Decimal("1.5")}))
        self.assertEqual(out, {"a": 10, "b": 1.5})

    def test_policy(self):
        self.assertEqual(policy.normalize_severity(8.2), "HIGH")
        self.assertEqual(policy.normalize_severity("critical"), "CRITICAL")
        self.assertTrue(policy.decide(350, 500)["autonomous"])
        self.assertEqual(policy.decide(750, 500)["status"], "NEEDS_HUMAN")

    def test_scope_hash_is_canonical(self):
        a = scope.build_scope_document(job_id="j", client_wallet="c", title="t", targets="a.com, b.com",
                                       budget_usdc=10, deadline_days=7, review_hours=72)
        b = dict(reversed(list(a.items())))
        self.assertEqual(scope.scope_hash(a), scope.scope_hash(b))
        self.assertEqual(a["targets"], ["a.com", "b.com"])

    def test_secret_store_reads_ssm_with_cache(self):
        SSM.params["/proofsec/test/jwt"] = "s" * 40
        with mock.patch.dict(os.environ, {"JWT_SECRET_PARAM": "/proofsec/test/jwt"}):
            secret_store.clear_cache()
            calls = SSM.calls
            self.assertEqual(secret_store.get_secret("JWT_SECRET_PARAM", "JWT_SECRET"), "s" * 40)
            self.assertEqual(secret_store.get_secret("JWT_SECRET_PARAM", "JWT_SECRET"), "s" * 40)
            self.assertEqual(SSM.calls - calls, 1, "segunda leitura vem do cache")
        secret_store.clear_cache()


# ======================================================================
class TestSolanaDecode(Base):
    def test_decode_job_new_layout(self):
        client = os.urandom(32)
        j = solana.decode_job(make_job_account("abc123", client, status=3, evidence=b"\x09" * 32,
                                               dispute_deadline=1_700_000_000))
        self.assertEqual(j["jobId"], "abc123")
        self.assertEqual(j["client"], b58.b58encode(client))
        self.assertIsNone(j["researcher"])
        self.assertEqual(j["amount"], 350_000_000)
        self.assertEqual(j["status"], "DISPUTED")
        self.assertEqual(j["evidenceSha256"], "09" * 32)
        self.assertTrue(j["createdByAgent"])
        self.assertEqual((j["bump"], j["vaultBump"]), (254, 253))
        self.assertEqual(j["arbiter"], b58.b58encode(b"\4" * 32))
        self.assertEqual(j["rentPayer"], b58.b58encode(b"\5" * 32))
        self.assertEqual((j["feeBps"], j["disputePeriod"], j["disputeDeadline"]), (250, 120, 1_700_000_000))

    def test_layout_matches_rust_offsets(self):
        # Offsets documentados em state.rs: status 232, arbiter 236, rent_payer 268, fee 300,
        # treasury 318 (PS-37), job_id 350
        data = make_job_account("x", b"\7" * 32, status=4)
        self.assertEqual(data[232], 4)
        self.assertEqual(data[236:268], b"\4" * 32)
        self.assertEqual(data[268:300], b"\5" * 32)
        self.assertEqual(struct.unpack_from("<H", data, 300)[0], 250)
        self.assertEqual(data[318:350], b"" * 32)
        self.assertEqual(solana.decode_job(data)["treasury"], b58.b58encode(b"" * 32))
        self.assertEqual(struct.unpack_from("<I", data, 350)[0], 1)

    def test_decode_job_rejects_garbage(self):
        with self.assertRaises(ValueError):
            solana.decode_job(b"\0" * 400)
        bad = bytearray(make_job_account("abc", os.urandom(32)))
        struct.pack_into("<I", bad, 350, 200)
        with self.assertRaises(ValueError):
            solana.decode_job(bytes(bad))

    def test_decode_config(self):
        data = solana.CONFIG_DISCRIMINATOR + b"\1" * 32 + b"\2" * 32 + b"\3" * 32 + struct.pack("<H", 250)
        data += b"\4" * 32 + struct.pack("<q", 600) + bytes([255])
        cfg = solana.decode_config(data)
        self.assertEqual(cfg["feeBps"], 250)
        self.assertEqual(cfg["disputePeriod"], 600)
        self.assertEqual(cfg["allowedMint"], b58.b58encode(b"\4" * 32))

    def test_discriminators_match_idl(self):
        with open(os.path.join(ROOT, "..", "frontend", "src", "idl", "proofsec.json"), encoding="utf-8") as f:
            idl = json.load(f)
        by_name = {a["name"]: bytes(a["discriminator"]) for a in idl["accounts"]}
        self.assertEqual(by_name["JobAccount"], solana.JOB_DISCRIMINATOR)
        self.assertEqual(by_name["Config"], solana.CONFIG_DISCRIMINATOR)
        fields = [f["name"] for t in idl["types"] if t["name"] == "JobAccount" for f in t["type"]["fields"]]
        self.assertEqual(fields[-7:], ["arbiter", "rent_payer", "fee_bps", "dispute_period", "dispute_deadline", "treasury", "job_id"])

    def test_rpc_fallback_on_transport_error(self):
        calls = []

        def fake_call(url, method, params):
            calls.append(url)
            if url == "https://primary.rpc":
                raise solana.RpcUnavailable("HTTP 503")
            return {"value": None}

        with mock.patch.object(solana, "_call", side_effect=fake_call):
            self.assertEqual(solana.rpc("getAccountInfo", ["x"]), {"value": None})
        self.assertEqual(calls, ["https://primary.rpc", "https://fallback.rpc"])

    def test_rpc_does_not_failover_on_application_error(self):
        with mock.patch.object(solana, "_call", side_effect=solana.RpcError("invalid params")) as m:
            with self.assertRaises(solana.RpcError):
                solana.rpc("getAccountInfo", ["x"])
        self.assertEqual(m.call_count, 1)


# ======================================================================
class TestAuth(Base):
    def test_siws_message_format_and_login(self):
        sk, _, wallet = keypair()
        msg, sig, res = login(sk, wallet)
        self.assertTrue(msg.startswith(f"localhost:3000 wants you to sign in with your Solana account:\n{wallet}\n\n"))
        for line in ("URI: http://localhost:3000", "Version: 1", "Chain ID: devnet"):
            self.assertIn(line, msg)
        self.assertRegex(msg, r"Nonce: [0-9a-f]{24}\n")
        self.assertRegex(msg, r"Issued At: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
        self.assertTrue(msg.isascii(), "SIWS exige ASCII")
        self.assertEqual(res["statusCode"], 200, res["body"])
        token = body_of(res)["token"]
        ok = auth.authorizer({"headers": {"authorization": f"Bearer {token}"}}, None)
        self.assertEqual(ok, {"isAuthorized": True, "context": {"wallet": wallet}})
        self.assertFalse(auth.authorizer({"headers": {"authorization": "Bearer lixo"}}, None)["isAuthorized"])

    def test_replay_rejected(self):
        sk, _, wallet = keypair()
        msg, sig, res = login(sk, wallet)
        self.assertEqual(res["statusCode"], 200)
        again = auth.verify_signature({"body": json.dumps({"wallet": wallet, "message": msg, "signature": sig})}, None)
        self.assertEqual(again["statusCode"], 401)

    def test_wrong_signer_rejected(self):
        _, _, wallet = keypair()
        other_sk, _, _ = keypair()
        r = auth.nonce({"body": json.dumps({"wallet": wallet, "domain": "localhost:3000", "uri": "http://localhost:3000"})}, None)
        msg = body_of(r)["message"]
        sig = b58.b58encode(other_sk.sign(msg.encode()))
        res = auth.verify_signature({"body": json.dumps({"wallet": wallet, "message": msg, "signature": sig})}, None)
        self.assertEqual(res["statusCode"], 401)

    def test_domain_allowlist_and_uri(self):
        _, _, wallet = keypair()
        bad_domain = auth.nonce({"body": json.dumps({"wallet": wallet, "domain": "evil.com", "uri": "https://evil.com"})}, None)
        self.assertEqual(bad_domain["statusCode"], 400)
        bad_uri = auth.nonce({"body": json.dumps({"wallet": wallet, "domain": "proofsec.app", "uri": "http://proofsec.app"})}, None)
        self.assertEqual(bad_uri["statusCode"], 400, "http só é aceito para localhost")
        good = auth.nonce({"body": json.dumps({"wallet": wallet, "domain": "proofsec.app", "uri": "https://proofsec.app"})}, None)
        self.assertEqual(good["statusCode"], 200)

    def test_ps09_regression_nonce_griefing(self):
        # Pedir outro nonce para a mesma carteira NÃO invalida o login em andamento
        sk, _, wallet = keypair()
        first = body_of(auth.nonce({"body": json.dumps({"wallet": wallet, "domain": "localhost:3000", "uri": "http://localhost:3000"})}, None))["message"]
        for _ in range(3):  # atacante spamma nonces para a carteira da vítima
            auth.nonce({"body": json.dumps({"wallet": wallet, "domain": "localhost:3000", "uri": "http://localhost:3000"})}, None)
        sig = b58.b58encode(sk.sign(first.encode()))
        res = auth.verify_signature({"body": json.dumps({"wallet": wallet, "message": first, "signature": sig})}, None)
        self.assertEqual(res["statusCode"], 200)

    def test_expired_nonce_rejected(self):
        sk, _, wallet = keypair()
        r = body_of(auth.nonce({"body": json.dumps({"wallet": wallet, "domain": "localhost:3000", "uri": "http://localhost:3000"})}, None))
        nonce = re.search(r"Nonce: (\w+)", r["message"]).group(1)
        TABLES["ProofSec-Nonces"].items[nonce]["expiresAt"] = 1
        sig = b58.b58encode(sk.sign(r["message"].encode()))
        res = auth.verify_signature({"body": json.dumps({"wallet": wallet, "message": r["message"], "signature": sig})}, None)
        self.assertEqual(res["statusCode"], 401)

    def test_jwt_secret_from_ssm(self):
        SSM.params["/proofsec/test/jwt2"] = "z" * 48
        with mock.patch.dict(os.environ, {"JWT_SECRET_PARAM": "/proofsec/test/jwt2"}):
            secret_store.clear_cache()
            sk, _, wallet = keypair()
            _, _, res = login(sk, wallet)
            token = body_of(res)["token"]
            self.assertEqual(jwt.decode(token, "z" * 48)["sub"], wallet)
        secret_store.clear_cache()


# ======================================================================
class TestJobs(Base):
    def _draft(self, wallet, **extra):
        res = jobs.create_job(authed(wallet, {"title": "Pentest API", "scope": "api.x.com", "budgetUsdc": 350,
                                              "deadlineDays": 7, "reviewHours": 72, **extra}), None)
        self.assertEqual(res["statusCode"], 201, res["body"])
        return body_of(res)["job"]

    def test_create_and_privacy(self):
        _, _, wallet = keypair()
        job = self._draft(wallet)
        self.assertEqual(job["status"], "DRAFT")
        self.assertEqual(job["amountBase"], 350_000_000)
        self.assertEqual(scope.scope_hash(json.loads(job["scopeDocument"])), job["scopeHash"])
        public = body_of(jobs.list_jobs({"queryStringParameters": {"wallet": wallet}}, None))
        self.assertEqual(len(public["jobs"]), 0, "rascunho não aparece publicamente")
        self.assertEqual(jobs.get_job({"pathParameters": {"jobId": job["jobId"]}}, None)["statusCode"], 404)
        self.assertEqual(len(body_of(jobs.my_jobs(authed(wallet), None))["jobs"]), 1)

    def test_create_requires_auth_and_valid_researcher(self):
        self.assertEqual(jobs.create_job({"body": "{}", "requestContext": {}}, None)["statusCode"], 401)
        _, _, wallet = keypair()
        res = jobs.create_job(authed(wallet, {"title": "t", "scope": "s", "budgetUsdc": 1, "researcher": wallet}), None)
        self.assertEqual(res["statusCode"], 400)

    def test_sync_rejects_divergent_client_without_rewrites(self):
        _, _, wallet = keypair()
        job = self._draft(wallet)
        oc = onchain_for(job, os.urandom(32))
        item = sync.apply_onchain(oc, get_item(job["jobId"]))
        self.assertEqual(item["status"], "DRAFT")
        self.assertIn("syncError", item)
        writes = TABLES["ProofSec-Jobs"].writes
        sync.apply_onchain(oc, get_item(job["jobId"]))
        self.assertEqual(TABLES["ProofSec-Jobs"].writes, writes, "não regrava a cada rodada")

    def test_apply_flow_and_applicants_visibility(self):
        _, _, client = keypair()
        _, _, r1 = keypair()
        job = self._draft(client)
        sync.apply_onchain(onchain_for(job, b58.b58decode(client), status=0, by_agent=False), get_item(job["jobId"]))

        self.assertEqual(jobs.apply(authed(client, path={"jobId": job["jobId"]}), None)["statusCode"], 400)
        self.assertEqual(jobs.apply(authed(r1, path={"jobId": job["jobId"]}), None)["statusCode"], 200)
        self.assertEqual(jobs.apply(authed(r1, path={"jobId": job["jobId"]}), None)["statusCode"], 200)  # idempotente

        public = body_of(jobs.list_jobs({"queryStringParameters": None}, None))["jobs"][0]
        self.assertNotIn("applicants", public, "candidaturas não são públicas")
        mine = body_of(jobs.my_jobs(authed(client), None))["jobs"][0]
        self.assertEqual(mine["applicants"], [r1])

        # Atribuição on-chain encerra candidaturas
        sync.apply_onchain(onchain_for(job, b58.b58decode(client), researcher=b58.b58decode(r1), by_agent=False),
                           get_item(job["jobId"]))
        self.assertNotIn("applicants", get_item(job["jobId"]))
        _, _, r2 = keypair()
        self.assertEqual(jobs.apply(authed(r2, path={"jobId": job["jobId"]}), None)["statusCode"], 409)

    def test_apply_cap(self):
        _, _, client = keypair()
        job = self._draft(client)
        sync.apply_onchain(onchain_for(job, b58.b58decode(client), by_agent=False), get_item(job["jobId"]))
        for _ in range(jobs.MAX_APPLICANTS):
            self.assertEqual(jobs.apply(authed(keypair()[2], path={"jobId": job["jobId"]}), None)["statusCode"], 200)
        self.assertEqual(jobs.apply(authed(keypair()[2], path={"jobId": job["jobId"]}), None)["statusCode"], 409)


# ======================================================================
class TestEvidence(Base):
    def _onchain_job(self, status=1):
        _, _, client = keypair()
        _, rpk, researcher = keypair()
        job = body_of(jobs.create_job(authed(client, {"title": "t", "scope": "s", "budgetUsdc": 5}), None))["job"]
        sync.apply_onchain(onchain_for(job, b58.b58decode(client), researcher=rpk, status=status, by_agent=False),
                           get_item(job["jobId"]))
        return job, client, researcher

    def test_upload_only_for_linked_researcher(self):
        job, client, researcher = self._onchain_job()
        sha = hashlib.sha256(b"relatorio").hexdigest()
        req = {"jobId": job["jobId"], "sha256Hex": sha, "sizeBytes": 100}
        with mock.patch.object(evidence, "sync_job", side_effect=lambda jid: get_item(jid)):
            self.assertEqual(evidence.upload_url(authed(client, req), None)["statusCode"], 403)
            res = evidence.upload_url(authed(researcher, req), None)
            self.assertEqual(evidence.upload_url(authed(researcher, {**req, "jobId": "../x"}), None)["statusCode"], 400)
        self.assertEqual(res["statusCode"], 200, res["body"])
        out = body_of(res)
        self.assertEqual(out["s3Key"], f"reports/{job['jobId']}/{sha}.bin")
        self.assertEqual(base64.b64decode(out["headers"]["x-amz-checksum-sha256"]).hex(), sha)
        self.assertEqual(S3.last_presign["Params"]["ContentLength"], 100)

    def test_download_allows_job_arbiter_only(self):
        job, client, researcher = self._onchain_job(status=3)
        sha = "ab" * 32
        item = get_item(job["jobId"])
        item.update({"evidenceSha256": sha})
        TABLES["ProofSec-Jobs"].items[job["jobId"]] = json.loads(json.dumps(item, default=str))
        S3.objects[f"reports/{job['jobId']}/{sha}.bin"] = b"blob"
        arbiter = item["arbiterWallet"]
        with mock.patch.object(evidence, "sync_job", side_effect=lambda jid: get_item(jid)):
            self.assertEqual(evidence.download_url(authed(arbiter, {"jobId": job["jobId"]}), None)["statusCode"], 200)
            self.assertEqual(evidence.download_url(authed(keypair()[2], {"jobId": job["jobId"]}), None)["statusCode"], 403)

    def test_download_distinguishes_missing_object_from_s3_outage(self):
        job, client, _ = self._onchain_job(status=3)
        item = get_item(job["jobId"])
        item["evidenceSha256"] = "ab" * 32
        TABLES["ProofSec-Jobs"].items[job["jobId"]] = json.loads(json.dumps(item, default=str))
        request = authed(client, {"jobId": job["jobId"]})
        with mock.patch.object(evidence, "sync_job", side_effect=lambda jid: get_item(jid)):
            self.assertEqual(evidence.download_url(request, None)["statusCode"], 404)
            with mock.patch.object(S3, "head_object", side_effect=RuntimeError("AccessDenied")):
                self.assertEqual(evidence.download_url(request, None)["statusCode"], 503)

    def test_verify_upload_deletes_mismatch_version_and_alerts(self):
        good = b"conteudo"
        sha = hashlib.sha256(good).hexdigest()
        key = f"reports/abc123/{sha}.bin"
        S3.objects[key] = b"outro conteudo"
        evidence.verify_upload({"Records": [{"s3": {"bucket": {"name": "b"}, "object": {"key": key, "size": 14, "versionId": "v1"}}}]}, None)
        self.assertEqual(S3.deleted[-1], {"Bucket": "b", "Key": key, "VersionId": "v1"})
        self.assertTrue(any("mismatched hash" in m["Subject"] for m in SNS.messages))

        S3.objects[key] = good
        before = len(S3.deleted)
        evidence.verify_upload({"Records": [{"s3": {"bucket": {"name": "b"}, "object": {"key": key, "size": 8}}}]}, None)
        self.assertEqual(len(S3.deleted), before, "arquivo correto permanece")


# ======================================================================
class TestAgentAndAlerts(Base):
    def test_proposal_policy_and_review_minimum(self):
        _, _, wallet = keypair()
        low = body_of(agent.propose(authed(wallet, {"severity": 5}), None))["job"]
        high = body_of(agent.propose(authed(wallet, {"severity": 8.5}), None))["job"]
        self.assertEqual(low["status"], "AUTO_APPROVED")
        self.assertEqual(high["status"], "NEEDS_HUMAN")
        self.assertGreaterEqual(float(low["reviewHours"]), 72)
        self.assertTrue(low["jobId"].startswith("ag") and len(low["jobId"]) <= 32)
        self.assertNotIn("assignedResearcher", low, "agente nunca pré-atribui pesquisador")

    def test_ps08_propose_quota(self):
        _, _, wallet = keypair()
        for _ in range(agent.PROPOSE_QUOTA_PER_HOUR):
            self.assertEqual(agent.propose(authed(wallet, {"severity": 5}), None)["statusCode"], 201)
        self.assertEqual(agent.propose(authed(wallet, {"severity": 5}), None)["statusCode"], 429)

    def test_executor_key_required(self):
        _, _, wallet = keypair()
        agent.propose(authed(wallet, {"severity": 5}), None)
        self.assertEqual(agent.list_proposals({"headers": {}, "queryStringParameters": None}, None)["statusCode"], 401)
        ok = agent.list_proposals({"headers": {"x-agent-key": os.environ["AGENT_API_KEY"]}, "queryStringParameters": None}, None)
        self.assertEqual(len(body_of(ok)["proposals"]), 1)

    def test_executor_key_rejects_short_configuration(self):
        with mock.patch.dict(os.environ, {"AGENT_API_KEY": "curta"}):
            self.assertEqual(
                agent.list_proposals({"headers": {"x-agent-key": "curta"}, "queryStringParameters": None}, None)["statusCode"],
                500,
            )

    def test_event_batch_is_idempotent(self):
        _, _, wallet = keypair()
        event = {
            "source": "aws.securityhub",
            "detail": {
                "findings": [
                    {"Id": "finding-1", "Title": "Primeiro", "Severity": {"Label": "MEDIUM"},
                     "Resources": [{"Id": "arn:one"}]},
                    {"Id": "finding-2", "Title": "Segundo", "Severity": {"Label": "HIGH"},
                     "Resources": [{"Id": "arn:two"}]},
                ]
            },
        }
        with mock.patch.object(agent, "COMPANY_WALLET", wallet):
            first = agent.on_event(event, None)
            second = agent.on_event(event, None)
        self.assertEqual(len(first["created"]), 2)
        self.assertEqual(len(second["created"]), 0)
        self.assertEqual(len(second["duplicates"]), 2)
        self.assertEqual(len(TABLES["ProofSec-Jobs"].items), 2)

    def test_executor_rejection_sends_to_human_review(self):
        _, _, wallet = keypair()
        prop = body_of(agent.propose(authed(wallet, {"severity": 5}), None))["job"]
        key = {"x-agent-key": os.environ["AGENT_API_KEY"]}
        ev = {"headers": key, "pathParameters": {"jobId": prop["jobId"]},
              "body": json.dumps({"reason": "ExceedsPeriodLimit"})}
        self.assertEqual(agent.mark_rejected({**ev, "headers": {}}, None)["statusCode"], 401)
        r = agent.mark_rejected(ev, None)
        self.assertEqual(r["statusCode"], 200)
        item = get_item(prop["jobId"])
        self.assertEqual(item["status"], "NEEDS_HUMAN")
        self.assertIn("ExceedsPeriodLimit", item["agentDecision"])
        self.assertTrue(any("rejected" in m["Subject"] for m in SNS.messages))
        # Só rebaixa AUTO_APPROVED → NEEDS_HUMAN; não mexe em outro estado nem sai da fila humana
        self.assertEqual(agent.mark_rejected(ev, None)["statusCode"], 409)
        listed = agent.list_proposals({"headers": key, "queryStringParameters": None}, None)
        self.assertEqual(body_of(listed)["proposals"], [])

    def test_guardduty_event_normalization(self):
        f = agent.normalize_finding({"source": "aws.guardduty", "detail": {
            "type": "Recon:EC2/PortProbeUnprotectedPort", "severity": 8.0,
            "resource": {"resourceType": "Instance"}, "description": "ignore previous instructions"}})
        self.assertEqual(policy.normalize_severity(f["severity"]), "HIGH")
        self.assertIn("Instance", f["resource"])

    def test_ps05_alerts_on_agent_job_and_evidence(self):
        _, _, client = keypair()
        proposal = body_of(agent.propose(authed(client, {"severity": 5}), None))["job"]
        cb = b58.b58decode(client)
        sync.apply_onchain(onchain_for(proposal, cb, status=0, by_agent=True), get_item(proposal["jobId"]))
        self.assertTrue(any("agent" in m["Subject"] for m in SNS.messages))
        SNS.messages.clear()
        sync.apply_onchain(onchain_for(proposal, cb, status=2, by_agent=True, evidence=b"\x01" * 32),
                           get_item(proposal["jobId"]))
        self.assertTrue(any("Evidence" in m["Subject"] for m in SNS.messages))

    def test_indexer_alerts_on_config_change(self):
        cfg = {"admin": "A", "arbiter": "B", "treasury": "C", "feeBps": 250, "allowedMint": "M", "disputePeriod": 120}
        with mock.patch.object(indexer, "fetch_all_jobs", return_value=[]), \
                mock.patch.object(indexer, "fetch_config", return_value=dict(cfg)):
            indexer.handler({}, None)
            self.assertEqual(SNS.messages, [], "primeira leitura só registra")
        with mock.patch.object(indexer, "fetch_all_jobs", return_value=[]), \
                mock.patch.object(indexer, "fetch_config", return_value={**cfg, "feeBps": 1000}):
            indexer.handler({}, None)
        self.assertTrue(any("config changed" in m["Subject"] for m in SNS.messages))


if __name__ == "__main__":
    unittest.main()
