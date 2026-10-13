"""
Jobs: metadados off-chain + espelho do estado on-chain.

Ciclo de vida do campo `status` (off-chain):
  DRAFT          → criado pelo cliente, ainda não existe on-chain
  NEEDS_HUMAN    → proposta do agente acima do teto, aguardando assinatura humana
  AUTO_APPROVED  → proposta do agente dentro do teto, aguardando o executor do agente
  ONCHAIN        → existe on-chain; o status real fica em `onchainStatus`
                   (OPEN, IN_PROGRESS, EVIDENCE_SUBMITTED, DISPUTED, COMPLETED, RESOLVED, REFUNDED, CANCELLED)
"""
import os
import time
from decimal import Decimal, InvalidOperation

from common import db, log
from common.b58 import is_pubkey
from common.http import HttpError, auth_wallet, handler, ok, parse_body, path_param, query_param
from common.scope import build_scope_document, canonical_json, new_job_id, scope_hash
from common.solana import RpcError
from common.sync import sync_job

# `scopeDocument` (alvos e regras do pentest) só vai ao cliente e ao pesquisador atribuído (PS-40)
PRIVATE_FIELDS = {"evidenceS3Key", "findingDetails", "syncError", "applicants", "scopeDocument"}
DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 200
MAX_PAGE_OFFSET = 100_000
# Rascunhos novos por carteira em 24 h: limita spam na tabela e o custo das listagens
MAX_DRAFTS_PER_DAY = int(os.environ.get("MAX_DRAFTS_PER_DAY", "50"))
MAX_APPLICANTS = 50
MAX_TITLE_LENGTH = 120
MAX_TARGETS = 50
MAX_TARGET_LENGTH = 500
MAX_RULES = 50
MAX_RULE_LENGTH = 1_000


def public_view(item: dict) -> dict:
    return {k: v for k, v in item.items() if k not in PRIVATE_FIELDS}


def owner_view(item: dict, wallet: str) -> dict:
    """Visão para participantes: o cliente vê as candidaturas; cliente e pesquisador atribuído veem o escopo."""
    view = public_view(item)
    if item.get("clientWallet") == wallet and item.get("applicants"):
        view["applicants"] = list(item["applicants"])
    if wallet in (item.get("clientWallet"), item.get("researcherWallet")) and item.get("scopeDocument"):
        view["scopeDocument"] = item["scopeDocument"]
    return view


def _page_params(event) -> tuple[int, int]:
    def read(name: str, default: int, low: int, high: int) -> int:
        raw = query_param(event, name)
        if raw is None or raw == "":
            return default
        try:
            value = int(raw)
        except (TypeError, ValueError):
            raise HttpError(400, f"invalid {name}")
        if not low <= value <= high:
            raise HttpError(400, f"{name} out of range")
        return value

    return read("limit", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE), read("offset", 0, 0, MAX_PAGE_OFFSET)


def _paged(items: list[dict], limit: int, offset: int) -> tuple[list[dict], int, int | None]:
    """Mais recentes primeiro, em janela fixa: a resposta nunca passa do limite de 6 MB da Lambda."""
    end = offset + limit
    return items[offset:end], len(items), end if end < len(items) else None


def _jobs_of(wallet: str) -> list[dict]:
    items = {i["jobId"]: i for i in db.list_jobs_by_client(wallet)}
    items.update({i["jobId"]: i for i in db.list_jobs_by_researcher(wallet)})
    return sorted(items.values(), key=lambda j: j.get("createdAt") or 0, reverse=True)


def _validated_targets(value) -> list[str] | str:
    if isinstance(value, str):
        targets = [t.strip() for t in value.replace("\n", ",").split(",") if t.strip()]
        if not targets:
            raise HttpError(400, "scope must contain at least one target")
        if len(targets) > MAX_TARGETS or any(len(t) > MAX_TARGET_LENGTH for t in targets):
            raise HttpError(400, "scope exceeds the allowed limits")
        return value
    if not isinstance(value, list) or not value or len(value) > MAX_TARGETS:
        raise HttpError(400, "scope must be text or a non-empty list of strings")
    if any(not isinstance(t, str) or not t.strip() or len(t.strip()) > MAX_TARGET_LENGTH for t in value):
        raise HttpError(400, "scope must contain only valid textual targets")
    return [t.strip() for t in value]


def _validated_rules(value) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not value or len(value) > MAX_RULES:
        raise HttpError(400, "rulesOfEngagement must be a non-empty list of strings")
    if any(not isinstance(r, str) or not r.strip() or len(r.strip()) > MAX_RULE_LENGTH for r in value):
        raise HttpError(400, "rulesOfEngagement contains an invalid rule")
    return [r.strip() for r in value]


@handler
def list_jobs(event, context):
    """GET /jobs[?wallet=<pubkey>] — público: só jobs que já existem on-chain.
    Rascunhos e propostas do agente (que revelam o que está vulnerável) nunca saem aqui."""
    wallet = query_param(event, "wallet")
    limit, offset = _page_params(event)
    if wallet:
        if not is_pubkey(wallet):
            raise HttpError(400, "invalid wallet")
        jobs = [j for j in _jobs_of(wallet) if j.get("status") == "ONCHAIN"]
    else:
        jobs = db.list_jobs_by_status("ONCHAIN")
        jobs.sort(key=lambda j: j.get("createdAt") or 0, reverse=True)
    window, total, next_offset = _paged(jobs, limit, offset)
    return ok({"success": True, "jobs": [public_view(j) for j in window], "total": total, "nextOffset": next_offset})


@handler
def my_jobs(event, context):
    """GET /jobs/mine (autenticado) — inclui rascunhos e propostas do agente da carteira."""
    wallet = auth_wallet(event)
    limit, offset = _page_params(event)
    window, total, next_offset = _paged(_jobs_of(wallet), limit, offset)
    return ok({"success": True, "jobs": [owner_view(j, wallet) for j in window], "total": total,
               "nextOffset": next_offset})


@handler
def get_job(event, context):
    item = db.get_job(path_param(event, "jobId"))
    if not item or item.get("status") != "ONCHAIN":
        raise HttpError(404, "job not found")
    return ok({"success": True, "job": public_view(item)})


@handler
def create_job(event, context):
    """POST /jobs (autenticado) — cria o DRAFT e devolve job_id + scope_hash
    que o frontend usa em `initialize_job`."""
    wallet = auth_wallet(event)
    body = parse_body(event)

    raw_title = body.get("title")
    if not isinstance(raw_title, str):
        raise HttpError(400, "title must be text")
    title = raw_title.strip()
    scope = _validated_targets(body.get("scope"))
    rules = _validated_rules(body.get("rulesOfEngagement"))
    raw_deadline = body.get("deadlineDays", 7)
    raw_review = body.get("reviewHours", 72)
    if isinstance(raw_deadline, bool) or isinstance(raw_review, bool):
        raise HttpError(400, "budgetUsdc, deadlineDays and reviewHours must be numeric")
    try:
        budget_decimal = Decimal(str(body.get("budgetUsdc", 0)))
        deadline_decimal = Decimal(str(raw_deadline))
        review_hours = float(raw_review)
    except (InvalidOperation, TypeError, ValueError, OverflowError):
        raise HttpError(400, "budgetUsdc, deadlineDays and reviewHours must be numeric")
    if not deadline_decimal.is_finite() or deadline_decimal != deadline_decimal.to_integral_value():
        raise HttpError(400, "deadlineDays must be an integer")
    if not (1 <= deadline_decimal <= 180):  # antes do int(): "1E+999999" custaria segundos de CPU
        raise HttpError(400, "deadlineDays must be between 1 and 180")
    deadline_days = int(deadline_decimal)
    if not budget_decimal.is_finite() or not (0 < budget_decimal <= 1_000_000):
        raise HttpError(400, "budgetUsdc out of range")  # antes da multiplicação (decimal.Overflow)
    budget = float(budget_decimal)
    amount_decimal = budget_decimal * Decimal(1_000_000)
    researcher = body.get("researcher") or None

    if not title:
        raise HttpError(400, "required fields: title, scope")
    if len(title) > MAX_TITLE_LENGTH:
        raise HttpError(400, "title exceeds 120 characters")
    if not (0 < budget <= 1_000_000):
        raise HttpError(400, "budgetUsdc out of range")
    if amount_decimal != amount_decimal.to_integral_value() or amount_decimal < 1:
        raise HttpError(400, "budgetUsdc must have at most 6 decimal places")
    if not (1 <= deadline_days <= 180):
        raise HttpError(400, "deadlineDays must be between 1 and 180")
    if not (1 / 60 <= review_hours <= 720):
        raise HttpError(400, "reviewHours must be between 1 minute and 720 hours")
    if researcher and not is_pubkey(researcher):
        raise HttpError(400, "invalid researcher")
    if researcher == wallet:
        raise HttpError(400, "the client cannot be the researcher of their own job")

    day_ago = time.time() - 86_400
    recent_drafts = [
        j for j in db.list_jobs_by_client(wallet)
        if j.get("status") == "DRAFT" and not j.get("createdByAgent") and int(j.get("createdAt") or 0) > day_ago
    ]
    if len(recent_drafts) >= MAX_DRAFTS_PER_DAY:
        raise HttpError(429, "daily draft limit reached")

    job_id = new_job_id()
    doc = build_scope_document(
        job_id=job_id,
        client_wallet=wallet,
        title=title,
        targets=scope,
        budget_usdc=budget,
        deadline_days=deadline_days,
        review_hours=review_hours,
        rules=rules,
    )
    item = db.put_job(
        {
            "jobId": job_id,
            "title": title,
            # Guardado como JSON canônico (string): preserva o hash e evita floats no DynamoDB
            "scopeDocument": canonical_json(doc),
            "scopeHash": scope_hash(doc),
            "budgetUsdc": str(budget),
            "amountBase": int(amount_decimal),
            "deadlineDays": deadline_days,
            "reviewHours": str(review_hours),
            "clientWallet": wallet,
            "assignedResearcher": researcher,
            "status": "DRAFT",
            "createdAt": int(time.time()),
            "createdByAgent": False,
        },
        only_if_new=True,
    )
    # O cliente precisa do `scopeDocument` para conferir o hash antes de assinar (frontend/lib/meta.ts)
    return ok({"success": True, "job": owner_view(item, wallet)}, 201)


@handler
def apply(event, context):
    """POST /jobs/{jobId}/apply (pesquisador autenticado) — candidatura a um job aberto.

    A atribuição continua sendo on-chain e só o cliente faz (PS-01); isto apenas
    mostra ao cliente quem quer o job, sem troca de pubkeys por fora.
    """
    wallet = auth_wallet(event)
    job_id = path_param(event, "jobId")
    item = db.get_job(job_id)
    if not item or item.get("status") != "ONCHAIN":
        raise HttpError(404, "job not found")
    if item.get("onchainStatus") != "OPEN" or item.get("researcherWallet"):
        raise HttpError(409, "this job is not accepting applications")
    if wallet == item.get("clientWallet"):
        raise HttpError(400, "the client cannot apply to their own job")
    applicants = list(item.get("applicants") or [])
    if wallet in applicants:
        return ok({"success": True, "applied": True})
    updated = db.add_applicant(job_id, wallet, MAX_APPLICANTS)
    if not updated:
        current = db.get_job(job_id)
        if current and wallet in (current.get("applicants") or []):
            return ok({"success": True, "applied": True})
        if not current or current.get("status") != "ONCHAIN":
            raise HttpError(404, "job not found")
        if current.get("onchainStatus") != "OPEN" or current.get("researcherWallet"):
            raise HttpError(409, "this job is not accepting applications")
        raise HttpError(409, "application limit reached")
    log.info("job_application", jobId=job_id, wallet=wallet)
    return ok({"success": True, "applied": True})


@handler
def sync(event, context):
    """POST /jobs/{jobId}/sync {jobPda?} — público e idempotente: só reflete a chain."""
    job_id = path_param(event, "jobId")
    body = parse_body(event)
    try:
        item = sync_job(job_id, body.get("jobPda"))
    except (ValueError, RpcError) as e:
        raise HttpError(400, f"failed to sync: {e}")
    if not item:
        raise HttpError(404, "job not found on-chain or in the database")
    return ok({"success": True, "job": public_view(item)})
