"""
Bateria de casos de borda / adversariais do backend (sem AWS).

Reusa os fakes de `test_backend.py`. Casos EC-* são regressões permanentes de
defeitos confirmados; nenhum deve voltar a ser marcado como `expectedFailure`.

    python -m unittest discover -s tests -v
"""
import base64
import json
import struct
import unittest

from test_backend import (  # noqa: F401 - importa também os fakes/ambiente
    Base,
    S3,
    TABLES,
    authed,
    body_of,
    get_item,
    keypair,
    make_job_account,
    onchain_for,
)

import auth
import evidence
import jobs
from common import b58, db, http, jwt, policy, solana, sync


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def forged_token(header: bytes, body: bytes = b"{}", sig: bytes = b"x") -> str:
    return f"{b64u(header)}.{b64u(body)}.{b64u(sig)}"


def create(wallet, **over):
    body = {"title": "Pentest", "scope": "api.x.com", "budgetUsdc": 100, "deadlineDays": 7, "reviewHours": 72}
    body.update(over)
    return jobs.create_job(authed(wallet, body), None)


# ======================================================================
class TestAuthorizerRobustness(Base):
    """O authorizer recebe lixo não autenticado: nunca pode lançar exceção (vira HTTP 500 + alarme)."""

    def _call(self, token):
        return auth.authorizer({"headers": {"authorization": f"Bearer {token}"}}, None)

    def test_garbage_tokens_are_denied(self):
        for tok in ["", "abc", "a.b", "a.b.c", "....", "💥.💥.💥", "A" * 10_000]:
            self.assertEqual(self._call(tok), {"isAuthorized": False}, tok[:20])

    def test_non_object_json_header_is_denied_not_crash(self):
        # Cabeçalho JWT que é JSON válido mas não é objeto: `.get` explode com AttributeError
        for header in (b"[]", b"null", b'"x"', b"123"):
            self.assertEqual(self._call(forged_token(header)), {"isAuthorized": False}, header)

    def test_alg_none_and_wrong_alg_rejected(self):
        for alg in ("none", "None", "HS512", "RS256"):
            hdr = json.dumps({"alg": alg, "typ": "JWT"}).encode()
            body = json.dumps({"sub": "x", "exp": 9_999_999_999}).encode()
            self.assertEqual(self._call(forged_token(hdr, body, b"")), {"isAuthorized": False}, alg)

    def test_expired_and_tampered_tokens(self):
        secret = "x" * 40
        good = jwt.encode({"sub": "W", "exp": 9_999_999_999}, secret)
        self.assertTrue(self._call(good)["isAuthorized"])
        h, b, s = good.split(".")
        tampered = f"{h}.{b64u(json.dumps({'sub': 'ATTACKER', 'exp': 9_999_999_999}).encode())}.{s}"
        self.assertEqual(self._call(tampered), {"isAuthorized": False})
        self.assertEqual(self._call(jwt.encode({"sub": "W", "exp": 1}, secret)), {"isAuthorized": False})
        self.assertEqual(self._call(jwt.encode({"sub": "W"}, secret)), {"isAuthorized": False})  # sem exp
        for invalid_exp in (float("nan"), float("inf"), True, "9999999999"):
            self.assertEqual(self._call(jwt.encode({"sub": "W", "exp": invalid_exp}, secret)),
                             {"isAuthorized": False})


class TestHttpHelpers(Base):
    def test_invalid_base64_body_is_400_not_500(self):
        for raw in ("%%%não-é-base64%%%", ["not", "text"], {"not": "text"}, 123):
            ev = {"body": raw, "isBase64Encoded": True}
            with self.assertRaises(http.HttpError) as cm:
                http.parse_body(ev)
            self.assertEqual(cm.exception.status_code, 400)

    def test_non_object_body(self):
        for raw in ("[]", "1", "null", '"x"'):
            with self.assertRaises(http.HttpError):
                http.parse_body({"body": raw})

    def test_unhandled_error_is_generic_500(self):
        @http.handler
        def boom(event, context):
            raise RuntimeError("segredo-interno")

        r = boom({}, None)
        self.assertEqual(r["statusCode"], 500)
        self.assertNotIn("segredo", r["body"])


class TestCreateJobValidation(Base):
    def setUp(self):
        super().setUp()
        _, _, self.w = keypair()

    def test_nan_inf_and_negatives_rejected(self):
        for v in ("nan", "inf", "-1", 0, -5, 1_000_001):
            r = create(self.w, budgetUsdc=v)
            self.assertEqual(r["statusCode"], 400, v)
        for v in ("nan", "inf"):
            self.assertEqual(create(self.w, reviewHours=v)["statusCode"], 400, v)

    def test_non_string_title_is_400_not_500(self):
        for title in (5, ["a"], {"a": 1}):
            self.assertEqual(create(self.w, title=title)["statusCode"], 400, title)

    def test_dust_budget_rejected(self):
        # 1e-7 USDC arredonda para 0 unidades base: o contrato recusaria (amount > 0)
        r = create(self.w, budgetUsdc=1e-7)
        self.assertEqual(r["statusCode"], 400)

    def test_deadline_requires_integer_and_boole_are_not_numbers(self):
        for deadline in (1.5, "1.5", True, float("nan"), float("inf")):
            self.assertEqual(create(self.w, deadlineDays=deadline)["statusCode"], 400, deadline)
        self.assertEqual(create(self.w, reviewHours=True)["statusCode"], 400)

    def test_scope_must_be_text_or_list_of_text(self):
        for scope in (123, {"a": 1}, [1, 2], [{"x": 1}], True):
            self.assertEqual(create(self.w, scope=scope)["statusCode"], 400, scope)

    def test_rules_must_be_list_of_text(self):
        for rules in ("texto", 5, [1, 2], {"a": 1}):
            self.assertEqual(create(self.w, rulesOfEngagement=rules)["statusCode"], 400, rules)

    def test_scope_doc_hash_is_stable_and_server_side(self):
        r = body_of(create(self.w))["job"]
        import hashlib

        self.assertEqual(hashlib.sha256(r["scopeDocument"].encode()).hexdigest(), r["scopeHash"])

    def test_review_minimum_matches_chain(self):
        # 1/60 h = 60 s: a menor janela que o contrato aceita
        self.assertEqual(create(self.w, reviewHours=1 / 60)["statusCode"], 201)
        self.assertEqual(create(self.w, reviewHours=1 / 61)["statusCode"], 400)


class TestEvidenceInputs(Base):
    def setUp(self):
        super().setUp()
        _, _, self.w = keypair()

    def _upload(self, **body):
        base = {"jobId": "abc123", "sha256Hex": "a" * 64, "sizeBytes": 10}
        base.update(body)
        return evidence.upload_url(authed(self.w, base), None)

    def test_malformed_numeric_and_hash_inputs_are_400(self):
        for over in ({"sizeBytes": "abc"}, {"sizeBytes": "10"}, {"sizeBytes": 1.5}, {"sizeBytes": True},
                     {"sizeBytes": [1]}, {"sizeBytes": {}}, {"sha256Hex": 123}, {"sha256Hex": ["a"]}):
            self.assertEqual(self._upload(**over)["statusCode"], 400, over)

    def test_bad_job_id_and_hash_and_size(self):
        for over in ({"jobId": "../x"}, {"jobId": "A" * 5}, {"jobId": "a" * 33}, {"sha256Hex": "g" * 64},
                     {"sizeBytes": 0}, {"sizeBytes": 50 * 1024 * 1024 + 1}, {"sizeBytes": -1}):
            self.assertEqual(self._upload(**over)["statusCode"], 400, over)

    def test_download_with_non_string_job_id_is_400(self):
        for jid in (["a"], {"a": 1}, 5):
            r = evidence.download_url(authed(self.w, {"jobId": jid}), None)
            self.assertIn(r["statusCode"], (400, 404), jid)


class TestSeverityMapping(unittest.TestCase):
    def test_informational_is_not_medium(self):
        # Security Hub (ASFF) usa INFORMATIONAL; hoje cai no default MEDIUM = 350 USDC aprovados
        self.assertEqual(policy.normalize_severity("INFORMATIONAL"), "LOW")

    def test_numeric_and_label_mapping(self):
        cases = {"low": "LOW", "CRITICAL": "CRITICAL", 9: "CRITICAL", 8.9: "HIGH", 7: "HIGH", 4: "MEDIUM", 3.9: "LOW",
                 0: "LOW", -5: "LOW", "nan": "LOW", "9.5": "CRITICAL", True: "LOW"}
        for k, v in cases.items():
            self.assertEqual(policy.normalize_severity(k), v, k)

    def test_unknown_defaults(self):
        for v in (None, "", "weird", [], {}):
            self.assertIn(policy.normalize_severity(v), policy.BUDGET_TABLE)

    def test_decide_boundary(self):
        self.assertTrue(policy.decide(500.0, 500.0)["autonomous"])
        self.assertFalse(policy.decide(500.01, 500.0)["autonomous"])
        self.assertFalse(policy.decide(0, 500.0)["autonomous"])
        self.assertFalse(policy.decide(float("nan"), 500.0)["autonomous"])


class TestDecoders(unittest.TestCase):
    def test_decode_job_truncated_everywhere(self):
        data = make_job_account("abc", b"\1" * 32)
        for n in range(0, len(data) - 29):  # tudo antes do fim do job_id real
            try:
                solana.decode_job(data[:n])
            except ValueError:
                continue
            except Exception as e:  # noqa: BLE001
                self.fail(f"len={n}: {type(e).__name__} em vez de ValueError")

    def test_decode_job_bad_status_and_utf8(self):
        data = bytearray(make_job_account("abc", b"\1" * 32))
        data[232] = 99
        self.assertEqual(solana.decode_job(bytes(data))["status"], "UNKNOWN_99")
        data = bytearray(make_job_account("abc", b"\1" * 32))
        data[354:357] = b"\xff\xfe\xfd"
        with self.assertRaises(UnicodeDecodeError):  # fetch_all_jobs captura este erro
            solana.decode_job(bytes(data))

    def test_decode_policy_and_config_short_data_raise_valueerror(self):
        for fn, disc in ((solana.decode_policy, solana.POLICY_DISCRIMINATOR), (solana.decode_config, solana.CONFIG_DISCRIMINATOR)):
            for n in (0, 8, 20, 60):
                with self.assertRaises(ValueError):
                    fn((disc + b"\0" * 200)[:n])


class TestBase58(unittest.TestCase):
    def test_pubkey_validation_edges(self):
        self.assertFalse(b58.is_pubkey(""))
        self.assertFalse(b58.is_pubkey("0" * 44))      # '0' não está no alfabeto
        self.assertFalse(b58.is_pubkey("l" * 44))
        self.assertFalse(b58.is_pubkey("1" * 31))
        self.assertFalse(b58.is_pubkey("z" * 44))      # decodifica para > 32 bytes
        self.assertFalse(b58.is_pubkey(None))
        self.assertFalse(b58.is_pubkey(["a"]))
        self.assertTrue(b58.is_pubkey(b58.DEFAULT_PUBKEY))
        self.assertEqual(b58.b58decode("1" * 32), b"\0" * 32)

    def test_roundtrip_leading_zeros(self):
        for raw in (b"", b"\0", b"\0\0\1", b"\xff" * 32, b"\0" * 31 + b"\1"):
            self.assertEqual(b58.b58decode(b58.b58encode(raw)), raw)


class TestListingLimits(Base):
    def setUp(self):
        super().setUp()
        _, _, self.w = keypair()

    def _seed(self, n):
        t = TABLES["ProofSec-Jobs"]
        for i in range(n):
            t.items[f"job{i:04d}"] = {
                "jobId": f"job{i:04d}", "status": "ONCHAIN", "clientWallet": self.w,
                "createdAt": 1_000 + i, "onchainStatus": "OPEN",
            }

    def test_public_listing_does_not_silently_drop_jobs_past_100(self):
        self._seed(150)
        # A consulta percorre todas as páginas da GSI (nada some), a resposta é paginada (PS-40)
        first = body_of(jobs.list_jobs({"queryStringParameters": None}, None))
        self.assertEqual((len(first["jobs"]), first["total"], first["nextOffset"]), (100, 150, 100))
        second = body_of(jobs.list_jobs({"queryStringParameters": {"offset": "100"}}, None))
        self.assertEqual((len(second["jobs"]), second["nextOffset"]), (50, None))
        ids = {j["jobId"] for j in first["jobs"]} | {j["jobId"] for j in second["jobs"]}
        self.assertEqual(len(ids), 150)
        self.assertEqual(first["jobs"][0]["jobId"], "job0149", "mais recentes primeiro")

    def test_propose_quota_counts_beyond_first_100_items(self):
        import agent

        t = TABLES["ProofSec-Jobs"]
        import time

        for i in range(120):  # 110 antigos + 10 recentes do agente; o limite é 10/h
            t.items[f"o{i:03d}"] = {"jobId": f"o{i:03d}", "status": "ONCHAIN", "clientWallet": self.w,
                                    "createdByAgent": False, "createdAt": 1}
        for i in range(10):
            t.items[f"z{i:03d}"] = {"jobId": f"z{i:03d}", "status": "AUTO_APPROVED", "clientWallet": self.w,
                                    "createdByAgent": True, "createdAt": int(time.time())}
        r = agent.propose(authed(self.w, {}), None)
        self.assertEqual(r["statusCode"], 429)


class TestApplyRace(Base):
    def test_apply_does_not_overwrite_concurrent_sync(self):
        """apply lê o item, o indexador atualiza o status on-chain, apply grava o item velho por cima."""
        _, _, client = keypair()
        _, _, researcher = keypair()
        t = TABLES["ProofSec-Jobs"]
        t.items["j1"] = {"jobId": "j1", "status": "ONCHAIN", "clientWallet": client, "onchainStatus": "OPEN",
                         "scopeHash": "00" * 32, "createdAt": 1}
        real_get = db.get_job

        def stale_get(job_id):
            item = real_get(job_id)
            # entre a leitura e a escrita do apply, o indexador grava o novo estado
            t.items["j1"]["onchainStatus"] = "IN_PROGRESS"
            t.items["j1"]["researcherWallet"] = "SOMEONE"
            return item

        from unittest import mock

        with mock.patch.object(db, "get_job", stale_get):
            jobs.apply(authed(researcher, path={"jobId": "j1"}), None)
        self.assertEqual(get_item("j1")["onchainStatus"], "IN_PROGRESS")


class TestSyncSafety(Base):
    def test_sync_never_overwrites_foreign_draft(self):
        _, cpk, client = keypair()
        _, opk, other = keypair()
        job = body_of(create(client))["job"]
        oc = onchain_for(job, opk)  # outro cliente on-chain com o mesmo job_id
        sync.apply_onchain(oc, get_item(job["jobId"]))
        item = get_item(job["jobId"])
        self.assertEqual(item["clientWallet"], client)
        self.assertEqual(item["status"], "DRAFT")
        self.assertIn("syncError", item)

    def test_indexer_flag_is_not_rewritten_each_round(self):
        _, _, client = keypair()
        _, opk, _ = keypair()
        job = body_of(create(client))["job"]
        oc = onchain_for(job, opk)
        sync.apply_onchain(oc, get_item(job["jobId"]))
        writes = TABLES["ProofSec-Jobs"].writes
        for _ in range(5):
            sync.apply_onchain(oc, get_item(job["jobId"]))
        self.assertEqual(TABLES["ProofSec-Jobs"].writes, writes)

    def test_researcher_unassign_clears_researcher_wallet(self):
        _, cpk, client = keypair()
        job = body_of(create(client))["job"]
        oc = onchain_for(job, cpk, researcher=b"\7" * 32)
        sync.apply_onchain(oc, get_item(job["jobId"]))
        self.assertTrue(get_item(job["jobId"]).get("researcherWallet"))
        oc2 = onchain_for(job, cpk)
        sync.apply_onchain(oc2, get_item(job["jobId"]))
        self.assertNotIn("researcherWallet", get_item(job["jobId"]))


# ======================================================================
class TestReview25to31Regressions(Base):
    """Defeitos achados na revisão independente de PS-25..PS-31 (PS-32..PS-34). Não remover."""

    def test_huge_json_integer_body_is_400_not_500(self):
        # json.loads lança ValueError (não JSONDecodeError) acima de 4300 dígitos
        for raw in ("1" * 5000, '{"a":' + "1" * 5000 + "}"):
            with self.assertRaises(http.HttpError) as cm:
                http.parse_body({"body": raw})
            self.assertEqual(cm.exception.status_code, 400)

    def test_nonce_rejects_non_text_uri_without_500(self):
        _, _, w = keypair()
        for uri in ([], {}, ["https://localhost:3000"], 5, None):
            ev = {"body": json.dumps({"wallet": w, "domain": "localhost:3000", "uri": uri})}
            self.assertEqual(auth.nonce(ev, None)["statusCode"], 400, uri)

    def test_oversized_signature_is_rejected_before_decoding(self):
        with self.assertRaises(http.HttpError):
            auth._decode_signature("z" * 100_000)

    def test_jwt_hostile_header_only_raises_valueerror(self):
        for header in (b"[" * 6000 + b"]" * 6000, b"1" * 5000, b"\xff\xfe\xfd"):
            tok = forged_token(header, b"{}", b"x")
            with self.assertRaises(ValueError):
                jwt.decode(tok, "s" * 32)
            self.assertEqual(auth.authorizer({"headers": {"authorization": f"Bearer {tok}"}}, None),
                             {"isAuthorized": False})

    def test_jwt_huge_integer_exp_is_denied(self):
        secret = "x" * 40
        tok = jwt.encode({"sub": "W", "exp": 10 ** 400}, secret)
        with self.assertRaises(ValueError):
            jwt.decode(tok, secret)

    def test_demo_events_only_create_proposals_in_dev_stage(self):
        # PS-35: a regra Demo só existe no dev; o código também se recusa fora dele
        import agent
        from unittest import mock

        _, _, wallet = keypair()
        event = {"source": "proofsec.demo", "id": "evt-1",
                 "detail": {"type": "Teste", "severity": 5, "target_asset": "x.example"}}
        with mock.patch.object(agent, "COMPANY_WALLET", wallet):
            with mock.patch.object(agent, "STAGE", "prod"):
                self.assertEqual(agent.on_event(event, None), {"ok": False})
                self.assertEqual(len(TABLES["ProofSec-Jobs"].items), 0)
            with mock.patch.object(agent, "STAGE", "dev"):
                self.assertEqual(len(agent.on_event(event, None)["created"]), 1)

    # ---- ADR-019 / PS-32 -------------------------------------------------
    @staticmethod
    def _finding(i, label="MEDIUM", **over):
        f = {"Id": f"finding-{i:03d}", "Title": f"Achado {i}", "Severity": {"Label": label},
             "Resources": [{"Id": f"arn:r{i}"}], "RecordState": "ACTIVE",
             "Workflow": {"Status": "NEW"}, "AwsAccountId": "123456789012"}
        f.update(over)
        return f

    def _run(self, findings, **ctx):
        import agent
        from unittest import mock

        if not hasattr(self, "_company"):
            self._company = keypair()[2]  # mesma carteira entre chamadas: o ID do finding depende dela
        wallet = self._company
        event = {"source": "aws.securityhub", "detail": {"findings": findings}}
        ctx.setdefault("get_remaining_time_in_millis", lambda: 25_000)
        context = mock.Mock(invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:f", **ctx)
        with mock.patch.object(agent, "COMPANY_WALLET", wallet):
            return agent.on_event(event, context)

    def test_ineligible_findings_never_open_proposals(self):
        batch = [
            self._finding(1, "MEDIUM"),
            self._finding(2, "LOW"),
            self._finding(3, "INFORMATIONAL"),
            self._finding(4, "HIGH", RecordState="ARCHIVED"),
            self._finding(5, "HIGH", Workflow={"Status": "RESOLVED"}),
            self._finding(6, "HIGH", Workflow={"Status": "SUPPRESSED"}),
            self._finding(7, "CRITICAL", AwsAccountId="999999999999"),
        ]
        out = self._run(batch)
        self.assertEqual(len(out["created"]), 1)
        self.assertEqual(out["skipped"], 6)
        self.assertEqual(len(TABLES["ProofSec-Jobs"].items), 1)

    def test_guardduty_below_threshold_is_skipped(self):
        import agent
        from unittest import mock

        _, _, wallet = keypair()
        with mock.patch.object(agent, "COMPANY_WALLET", wallet):
            low = agent.on_event({"source": "aws.guardduty", "detail": {"id": "g1", "severity": 2.0}}, None)
            ok_ = agent.on_event({"source": "aws.guardduty", "detail": {"id": "g2", "severity": 5.0}}, None)
        self.assertEqual((low["skipped"], len(low["created"])), (1, 0))
        self.assertEqual(len(ok_["created"]), 1)

    def test_batch_over_limit_is_demoted_to_human_review_and_alerts(self):
        import agent
        from unittest import mock
        from test_backend import SNS

        batch = [self._finding(i, "MEDIUM") for i in range(15)] + [self._finding(99, "CRITICAL")]
        with mock.patch.object(agent, "MAX_PROPOSALS_PER_EVENT", 10):
            out = self._run(batch)
        self.assertEqual(len(out["created"]), 16)
        statuses = [i["status"] for i in TABLES["ProofSec-Jobs"].items.values()]
        # O CRITICAL (índice 0, acima do teto autônomo) vai para humano pela política; dos 15 MEDIUM,
        # 9 cabem no limite de 10 e 6 são rebaixados pelo limite por evento
        self.assertEqual(statuses.count("AUTO_APPROVED"), 9)
        self.assertEqual(statuses.count("NEEDS_HUMAN"), 7)
        self.assertEqual(out["demoted"], 6)
        self.assertTrue(any("above the per-event limit" in m["Subject"] for m in SNS.messages))

    def test_retry_does_not_call_llm_again_for_existing_findings(self):
        import agent
        from unittest import mock

        batch = [self._finding(i, "MEDIUM") for i in range(3)]
        real = agent.generate_scope
        with mock.patch.object(agent, "generate_scope", side_effect=real) as spy:
            first = self._run(batch)
            calls_after_first = spy.call_count
            second = self._run(batch)
        self.assertEqual(len(first["created"]), 3)
        self.assertEqual(calls_after_first, 3)
        self.assertEqual(spy.call_count, 3, "retry não pode chamar o LLM de novo")
        self.assertEqual(len(second["duplicates"]), 3)

    def test_low_time_budget_falls_back_to_template_without_llm(self):
        import agent
        from unittest import mock

        real = agent.generate_scope
        seen = []

        def spy(finding, use_llm=True):
            seen.append(use_llm)
            return real(finding, use_llm=use_llm)

        with mock.patch.object(agent, "generate_scope", side_effect=spy):
            self._run([self._finding(1)], get_remaining_time_in_millis=lambda: 1_000)
            self._run([self._finding(2)], get_remaining_time_in_millis=lambda: 25_000)
        self.assertEqual(seen, [False, True])

    # ---- revisão geral: PS-38 / PS-39 / PS-40 / PS-43 -----------------------
    def _onchain_item(self, job_id, client, researcher=None, doc_size=10):
        item = {"jobId": job_id, "status": "ONCHAIN", "onchainStatus": "IN_PROGRESS", "clientWallet": client,
                "createdAt": 1_000, "scopeDocument": "x" * doc_size, "title": "t"}
        if researcher:
            item["researcherWallet"] = researcher
        TABLES["ProofSec-Jobs"].items[job_id] = item
        return item

    def test_public_views_never_expose_the_scope_document(self):
        _, _, client = keypair()
        self._onchain_item("jobscope1", client)
        listed = body_of(jobs.list_jobs({"queryStringParameters": None}, None))["jobs"]
        self.assertNotIn("scopeDocument", listed[0])
        single = jobs.get_job({"pathParameters": {"jobId": "jobscope1"}}, None)
        self.assertNotIn("scopeDocument", body_of(single)["job"])

    def test_scope_document_only_for_client_and_assigned_researcher(self):
        _, _, client = keypair()
        _, _, researcher = keypair()
        _, _, stranger = keypair()
        self._onchain_item("jobscope2", client, researcher)
        for wallet, expected in ((client, True), (researcher, True), (stranger, False)):
            mine = body_of(jobs.my_jobs(authed(wallet), None))["jobs"]
            if wallet == stranger:
                self.assertEqual(mine, [])
                continue
            self.assertEqual("scopeDocument" in mine[0], expected, wallet)

    def test_create_job_returns_the_scope_document_to_its_owner(self):
        _, _, w = keypair()
        job = body_of(create(w))["job"]
        self.assertIn("scopeDocument", job)

    def test_listing_is_paginated_and_bounded_in_size(self):
        _, _, client = keypair()
        for i in range(250):
            self._onchain_item(f"big{i:04d}", client, doc_size=75_000)
        r = jobs.list_jobs({"queryStringParameters": {"limit": "200"}}, None)
        self.assertEqual(r["statusCode"], 200)
        self.assertLess(len(r["body"]), 6_000_000)
        self.assertEqual(body_of(r)["nextOffset"], 200)
        for bad in ({"limit": "0"}, {"limit": "201"}, {"limit": "abc"}, {"offset": "-1"}, {"offset": "1e3"}):
            self.assertEqual(jobs.list_jobs({"queryStringParameters": bad}, None)["statusCode"], 400, bad)

    def test_draft_quota_per_wallet(self):
        from unittest import mock

        _, _, w = keypair()
        with mock.patch.object(jobs, "MAX_DRAFTS_PER_DAY", 3):
            self.assertEqual([create(w)["statusCode"] for _ in range(3)], [201, 201, 201])
            self.assertEqual(create(w)["statusCode"], 429)
            _, _, other = keypair()
            self.assertEqual(create(other)["statusCode"], 201, "a cota é por carteira")

    def test_propose_outside_dev_is_manual_unless_company_wallet(self):
        import agent
        from unittest import mock

        _, _, company = keypair()
        _, _, other = keypair()
        with mock.patch.object(agent, "STAGE", "prod"), mock.patch.object(agent, "COMPANY_WALLET", company):
            mine = body_of(agent.propose(authed(company, {"severity": 5}), None))["job"]
            theirs = body_of(agent.propose(authed(other, {"severity": 5}), None))["job"]
        self.assertEqual(mine["status"], "AUTO_APPROVED")
        self.assertEqual(theirs["status"], "NEEDS_HUMAN")
        with mock.patch.object(agent, "STAGE", "dev"):
            self.assertEqual(body_of(agent.propose(authed(other, {"severity": 5}), None))["job"]["status"], "AUTO_APPROVED")

    def _put_key(self, wallet, body):
        import users

        return users.put_encryption_key(authed(wallet, body), None)

    def test_encryption_key_requires_a_valid_wallet_signature(self):
        import os as _os
        import users
        from common.keybinding import key_binding_message

        sk, _, wallet = keypair()
        other_sk, _, _ = keypair()
        pub = base64.b64encode(_os.urandom(32)).decode()
        good = b58.b58encode(sk.sign(key_binding_message(wallet, pub).encode()))
        self.assertEqual(self._put_key(wallet, {"publicKey": pub})["statusCode"], 400, "sem assinatura")
        self.assertEqual(self._put_key(wallet, {"publicKey": pub, "signature": 5})["statusCode"], 400)
        forged = b58.b58encode(other_sk.sign(key_binding_message(wallet, pub).encode()))
        self.assertEqual(self._put_key(wallet, {"publicKey": pub, "signature": forged})["statusCode"], 400)
        other_key = base64.b64encode(_os.urandom(32)).decode()  # assinatura de OUTRA chave
        self.assertEqual(self._put_key(wallet, {"publicKey": other_key, "signature": good})["statusCode"], 400)
        _, _, intruder = keypair()  # a assinatura da vítima não vale para outro token
        self.assertEqual(self._put_key(intruder, {"publicKey": pub, "signature": good})["statusCode"], 400)
        self.assertEqual(self._put_key(wallet, {"publicKey": pub, "signature": good})["statusCode"], 200)
        got = body_of(users.get_encryption_key({"pathParameters": {"wallet": wallet}}, None))
        self.assertEqual((got["publicKey"], got["signature"]), (pub, good))

    def test_legacy_unsigned_key_is_served_without_signature(self):
        import users

        _, _, wallet = keypair()
        TABLES["ProofSec-Users"].items[wallet] = {"wallet": wallet, "encPublicKey": "AAAA"}
        got = body_of(users.get_encryption_key({"pathParameters": {"wallet": wallet}}, None))
        self.assertIsNone(got["signature"])

    def test_create_job_extreme_numeric_inputs_are_400_and_fast(self):
        import time as _t

        _, _, w = keypair()
        started = _t.time()
        for over in ({"budgetUsdc": "1E+999999999"}, {"deadlineDays": "1E+999999"},
                     {"reviewHours": 10 ** 400}, {"budgetUsdc": "1E+400000"}):
            self.assertEqual(create(w, **over)["statusCode"], 400, over)
        self.assertLess(_t.time() - started, 2.0)


if __name__ == "__main__":
    unittest.main()
