"""
"Cérebro" do agente de IA (sem chaves, sem custódia).

Entradas:
  - EventBridge: findings do GuardDuty / Security Hub (produção)
  - POST /agent/propose (empresa autenticada): alerta sintético para a demo

Fluxo:
  finding → severidade normalizada → orçamento pela tabela (policy.py)
          → LLM redige título/alvos/plano (llm.py, com fallback)
          → documento de escopo + scope_hash
          → decisão: AUTO_APPROVED (≤ teto) | NEEDS_HUMAN (> teto)

As "mãos" do agente ficam no executor (agent/core.ts, como CLI ou Lambda): ele
busca as propostas AUTO_APPROVED, assina `initialize_job_by_agent` e informa o
resultado em /executed ou /rejected (este último manda a proposta para revisão
humana). Mesmo que este serviço seja comprometido, o limite real é imposto
on-chain pela AgentPolicy, e jobs do agente exigem atribuição humana e revisão
mínima de 72 h (PS-05).
"""
import hmac
import hashlib
import json
import os
import time

from common import alerts, db, log
from common.b58 import is_pubkey
from common.http import HttpError, auth_wallet, handler, header, ok, parse_body, path_param, query_param
from common.llm import generate_scope
from common.policy import decide, normalize_severity, recommend
from common.scope import build_scope_document, canonical_json, new_job_id, scope_hash, usdc_to_base
from common.secret_store import get_secret
from common.sync import sync_job

COMPANY_WALLET = os.environ.get("COMPANY_WALLET", "")  # dono dos alertas vindos do EventBridge
# ADR-019: no máximo N propostas autônomas por evento; o excesso vai para revisão humana
MAX_PROPOSALS_PER_EVENT = max(int(os.environ.get("MAX_PROPOSALS_PER_EVENT", "10")), 0)
# Abaixo disso (ms restantes) o resto do lote usa o escopo de template, sem LLM
LLM_MIN_REMAINING_MS = 8_000
SECURITY_HUB_ELIGIBLE_LABELS = {"MEDIUM", "HIGH", "CRITICAL"}
SECURITY_HUB_ELIGIBLE_WORKFLOW = {"NEW", "NOTIFIED"}
GUARDDUTY_MIN_SEVERITY = 4.0
STAGE = os.environ.get("STAGE", "dev")
DEMO_SOURCE = "proofsec.demo"  # alertas sintéticos: só no stage dev (PS-35)
# Jobs do agente exigem janela de revisão ≥ 72 h on-chain (PS-05 / MIN_AGENT_REVIEW_PERIOD)
AGENT_MIN_REVIEW_HOURS = 72.0
DEFAULT_REVIEW_HOURS = max(float(os.environ.get("DEFAULT_REVIEW_HOURS", "72")), AGENT_MIN_REVIEW_HOURS)
# Cota por carteira para alertas simulados (PS-08): limita custo de LLM e spam
PROPOSE_QUOTA_PER_HOUR = int(os.environ.get("PROPOSE_QUOTA_PER_HOUR", "10"))


def _normalize_security_hub(f: dict) -> dict:
    res = (f.get("Resources") or [{}])[0]
    return {
        "source": "securityhub",
        "findingId": str(f.get("Id") or f.get("GeneratorId") or ""),
        "type": f.get("Title") or (f.get("Types") or ["SecurityHub finding"])[0],
        "description": f.get("Description", ""),
        "severity": (f.get("Severity") or {}).get("Label", "MEDIUM"),
        "resource": res.get("Id", ""),
        "recordState": f.get("RecordState"),
        "workflowStatus": (f.get("Workflow") or {}).get("Status"),
        "accountId": f.get("AwsAccountId"),
    }


def normalize_findings(raw: dict) -> list[dict]:
    """Normaliza todos os findings de um evento, sem descartar lotes do Security Hub."""
    detail = raw.get("detail") if isinstance(raw.get("detail"), dict) else raw
    if isinstance(detail.get("findings"), list) and detail["findings"]:  # Security Hub (ASFF)
        return [_normalize_security_hub(f) for f in detail["findings"] if isinstance(f, dict)]
    resource = detail.get("resource")
    if isinstance(resource, dict):  # GuardDuty
        resource = resource.get("resourceType", "") + ":" + json.dumps(resource)[:200]
    return [{
            "source": raw.get("source", "manual"),
            "findingId": str(detail.get("id") or raw.get("id") or ""),
            "type": detail.get("type") or detail.get("title") or "Security anomaly",
            "description": detail.get("description", ""),
            "severity": detail.get("severity", "MEDIUM"),
            "resource": resource or detail.get("target_asset") or "",
        }]


def normalize_finding(raw: dict) -> dict:
    """Compatibilidade para payloads de um único finding."""
    findings = normalize_findings(raw)
    return findings[0] if findings else {
        "source": "manual", "findingId": "", "type": "Security anomaly",
        "description": "", "severity": "MEDIUM", "resource": "",
    }


def ineligibility_reason(finding: dict, account_id: str | None = None) -> str | None:
    """Motivo para NÃO abrir proposta de um finding (ADR-019), ou None se elegível.

    Determinístico e sem LLM. Campos ausentes não bloqueiam (só o ASFF real os traz); o padrão
    do EventBridge já filtra por conta e severidade, aqui o filtro vale para cada finding do lote.
    """
    if finding.get("source") == "securityhub":
        label = str(finding.get("severity") or "").upper()
        if label not in SECURITY_HUB_ELIGIBLE_LABELS:
            return f"severity {label or 'missing'} below MEDIUM"
        if finding.get("recordState") not in (None, "ACTIVE"):
            return f"RecordState {finding['recordState']}"
        if finding.get("workflowStatus") not in (None, *SECURITY_HUB_ELIGIBLE_WORKFLOW):
            return f"Workflow {finding['workflowStatus']}"
        if account_id and finding.get("accountId") not in (None, account_id):
            return "finding from another account"
    elif finding.get("source") == "aws.guardduty":
        try:
            if float(finding.get("severity")) < GUARDDUTY_MIN_SEVERITY:
                return "GuardDuty severity below 4"
        except (TypeError, ValueError):
            return "invalid GuardDuty severity"
    return None


def _severity_rank(finding: dict) -> int:
    return ["LOW", "MEDIUM", "HIGH", "CRITICAL"].index(normalize_severity(finding.get("severity")))


def build_proposal(finding: dict, client_wallet: str, job_id: str | None = None,
                   *, use_llm: bool = True, force_human: str | None = None) -> dict:
    rec = recommend(finding["severity"])
    scope = generate_scope(finding, use_llm=use_llm)  # LLM só escreve texto
    decision = decide(rec["budgetUsdc"])
    if force_human:  # ADR-019: nunca AUTO_APPROVED acima do limite por evento
        decision = {**decision, "autonomous": False, "status": "NEEDS_HUMAN", "reason": force_human}
    job_id = job_id or new_job_id("ag")
    doc = build_scope_document(
        job_id=job_id,
        client_wallet=client_wallet,
        title=scope["title"],
        targets=scope["targets"],
        budget_usdc=rec["budgetUsdc"],
        deadline_days=rec["deadlineDays"],
        review_hours=DEFAULT_REVIEW_HOURS,
        test_plan=scope["testPlan"],
        source=f"agent:{scope.get('generatedBy', 'template')}",
    )
    return {
        "jobId": job_id,
        "title": scope["title"],
        "scopeDocument": canonical_json(doc),
        "scopeHash": scope_hash(doc),
        "budgetUsdc": str(rec["budgetUsdc"]),
        "amountBase": usdc_to_base(rec["budgetUsdc"]),
        "deadlineDays": rec["deadlineDays"],
        "reviewHours": str(DEFAULT_REVIEW_HOURS),
        "clientWallet": client_wallet,
        "status": decision["status"],
        "severity": rec["severity"],
        "agentDecision": decision["reason"],
        "findingDetails": json.dumps(finding, ensure_ascii=False)[:4000],
        "createdByAgent": True,
        "createdAt": int(time.time()),
    }


def _require_agent_key(event):
    key = header(event, "x-agent-key") or ""
    try:
        expected = get_secret("AGENT_API_KEY_PARAM", "AGENT_API_KEY")
    except Exception as e:  # noqa: BLE001
        log.error("agent_key_unavailable", error=type(e).__name__)
        raise HttpError(500, "agent configuration unavailable")
    if len(expected) < 32:
        log.error("agent_key_misconfigured", reason="too_short")
        raise HttpError(500, "agent configuration unavailable")
    if not hmac.compare_digest(key.encode(), expected.encode()):
        log.warning("agent_key_rejected")
        raise HttpError(401, "invalid x-agent-key")


def on_event(event, context):
    """Alvo da regra do EventBridge (GuardDuty/Security Hub)."""
    if not is_pubkey(COMPANY_WALLET):
        log.warning("agent_event_ignored", reason="COMPANY_WALLET not configured")
        return {"ok": False}
    if event.get("source") == DEMO_SOURCE and STAGE != "dev":
        log.warning("agent_event_ignored", reason="demo source outside the dev stage", stage=STAGE)
        return {"ok": False}
    arn = getattr(context, "invoked_function_arn", "") or ""
    account_id = arn.split(":")[4] if arn.count(":") >= 4 else None
    eligible, skipped = [], 0
    for finding in normalize_findings(event):
        reason = ineligibility_reason(finding, account_id)
        if reason:
            skipped += 1
            log.info("agent_finding_skipped", findingId=finding.get("findingId"), reason=reason,
                     source=event.get("source"))
        else:
            eligible.append(finding)
    # Mais graves primeiro; o desempate pelo ID mantém a ordem estável entre retries
    eligible.sort(key=lambda f: (-_severity_rank(f), str(f.get("findingId"))))
    created, duplicates, demoted = [], [], 0
    for index, finding in enumerate(eligible):
        identity = finding.get("findingId") or json.dumps(finding, sort_keys=True, ensure_ascii=False)
        digest = hashlib.sha256(f"{finding.get('source')}|{identity}|{COMPANY_WALLET}".encode()).hexdigest()
        job_id = "ag" + digest[:30]
        if db.get_job(job_id):  # dedup antes do LLM: o retry não repete o custo (o PutItem condicional cobre a corrida)
            duplicates.append(job_id)
            log.info("agent_event_duplicate", jobId=job_id, source=event.get("source"))
            continue
        over_limit = index >= MAX_PROPOSALS_PER_EVENT
        remaining = getattr(context, "get_remaining_time_in_millis", None)
        use_llm = remaining is None or remaining() >= LLM_MIN_REMAINING_MS
        proposal = build_proposal(
            finding, COMPANY_WALLET, job_id=job_id, use_llm=use_llm,
            force_human=(f"Batch with more than {MAX_PROPOSALS_PER_EVENT} eligible findings: "
                         "requires human review.") if over_limit else None,
        )
        item = db.put_job_once(proposal)
        if item is None:
            duplicates.append(job_id)
            log.info("agent_event_duplicate", jobId=job_id, source=event.get("source"))
            continue
        demoted += over_limit
        created.append({"jobId": item["jobId"], "status": item["status"]})
        log.info("agent_proposal", jobId=item["jobId"], status=item["status"], source=event.get("source"))
    if demoted:
        alerts.alert(
            "Findings batch above the per-event limit",
            client=COMPANY_WALLET, eligible=len(eligible), limit=MAX_PROPOSALS_PER_EVENT, demoted=demoted,
            action="The excess proposals were left in NEEDS_HUMAN; review them in the dashboard.",
        )
    return {"ok": True, "created": created, "duplicates": duplicates, "skipped": skipped, "demoted": demoted}


@handler
def propose(event, context):
    """POST /agent/propose (empresa autenticada) — simula um alerta para a demo."""
    wallet = auth_wallet(event)
    body = parse_body(event)
    hour_ago = time.time() - 3600
    recent = [
        j for j in db.list_jobs_by_client(wallet)
        if j.get("createdByAgent") and int(j.get("createdAt") or 0) > hour_ago
    ]
    if len(recent) >= PROPOSE_QUOTA_PER_HOUR:
        raise HttpError(429, "hourly limit of simulated alerts reached")
    finding = normalize_finding(
        {
            "source": "demo",
            "detail": {
                "type": str(body.get("type", "UnauthorizedAccess:EC2/ExposedEndpoint"))[:200],
                "description": str(body.get("description", "Exposed endpoint without authentication detected"))[:1000],
                "severity": body.get("severity", 5.0),
                "target_asset": str(body.get("target_asset", "api.company.internal/v1"))[:200],
            },
        }
    )
    # PS-39: fora do dev só a CompanyWallet pode gerar proposta autônoma; as demais ficam para
    # financiamento manual, senão qualquer carteira com política apontando para o agente gastaria o SOL dele
    force = None
    if STAGE != "dev" and wallet != COMPANY_WALLET:
        force = "Wallet differs from CompanyWallet: manual funding (autonomous execution restricted)."
    item = db.put_job(build_proposal(finding, wallet, force_human=force), only_if_new=True)
    return ok({"success": True, "job": item}, 201)


@handler
def list_proposals(event, context):
    """GET /agent/proposals?status=AUTO_APPROVED (executor do agente, x-agent-key)."""
    _require_agent_key(event)
    status = query_param(event, "status", "AUTO_APPROVED")
    if status not in {"AUTO_APPROVED", "NEEDS_HUMAN"}:
        raise HttpError(400, "invalid status")
    return ok({"success": True, "proposals": db.list_jobs_by_status(status)})


@handler
def mark_executed(event, context):
    """POST /agent/proposals/{jobId}/executed {jobPda, signature} (executor do agente)."""
    _require_agent_key(event)
    job_id = path_param(event, "jobId")
    body = parse_body(event)
    if not is_pubkey(body.get("jobPda")):
        raise HttpError(400, "invalid jobPda")
    item = sync_job(job_id, body["jobPda"])
    if item and body.get("signature"):
        item = db.put_job({**item, "fundingSignature": str(body["signature"])[:128]})
    return ok({"success": True, "job": item})


@handler
def mark_rejected(event, context):
    """POST /agent/proposals/{jobId}/rejected {reason} (executor do agente).

    A política on-chain recusou a proposta (limite, política inativa, sem delegate...)
    ou ela é inválida: sai da fila AUTO_APPROVED e vai para revisão humana. Só existe
    esse sentido (rebaixar para humano), nunca o contrário.
    """
    _require_agent_key(event)
    job_id = path_param(event, "jobId")
    reason = str(parse_body(event).get("reason") or "rejected by the executor")[:300]
    item = db.get_job(job_id)
    if not item:
        raise HttpError(404, "proposal not found")
    if item.get("status") != "AUTO_APPROVED":
        raise HttpError(409, "the proposal is not waiting for the executor")
    item = db.put_job({**item, "status": "NEEDS_HUMAN", "agentDecision": f"Executor rejected: {reason}"})
    alerts.alert(
        "Agent proposal rejected by the executor",
        jobId=job_id,
        client=item.get("clientWallet"),
        reason=reason,
        action="Review the proposal; if it makes sense, open the escrow manually in the dashboard.",
    )
    return ok({"success": True, "job": item})
