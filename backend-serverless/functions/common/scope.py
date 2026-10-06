"""
Documento de escopo / Rules of Engagement (RoE).

O SHA-256 do JSON canônico vai on-chain como `scope_hash`: fica registrado,
com data, exatamente o que o cliente autorizou o pesquisador a testar.
"""
import hashlib
import json
import secrets
import string

_ID_ALPHABET = string.ascii_lowercase + string.digits

DEFAULT_RULES = [
    "Testar somente os ativos listados no escopo.",
    "Proibido DoS/DDoS, engenharia social e acesso a dados reais de clientes além do mínimo para PoC.",
    "Reportar vulnerabilidades críticas imediatamente ao cliente pelo canal combinado.",
    "Não divulgar achados publicamente sem autorização por escrito do cliente.",
]


def new_job_id(prefix: str = "") -> str:
    """ID curto (<= 32 bytes, vai nas seeds do PDA)."""
    return (prefix + "".join(secrets.choice(_ID_ALPHABET) for _ in range(12)))[:32]


def build_scope_document(
    *,
    job_id: str,
    client_wallet: str,
    title: str,
    targets: list[str] | str,
    budget_usdc: float,
    deadline_days: int,
    review_hours: float,
    rules: list[str] | None = None,
    test_plan: list[str] | None = None,
    source: str = "manual",
) -> dict:
    if isinstance(targets, str):
        targets = [t.strip() for t in targets.replace("\n", ",").split(",") if t.strip()]
    return {
        "version": 1,
        "jobId": job_id,
        "client": client_wallet,
        "title": title,
        "targets": targets,
        "budgetUsdc": round(float(budget_usdc), 6),
        "deadlineDays": int(deadline_days),
        "reviewHours": float(review_hours),
        "rulesOfEngagement": rules or DEFAULT_RULES,
        "testPlan": test_plan or [],
        "source": source,
    }


def canonical_json(doc: dict) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def scope_hash(doc: dict) -> str:
    return hashlib.sha256(canonical_json(doc).encode("utf-8")).hexdigest()


def usdc_to_base(amount) -> int:
    """USDC tem 6 casas decimais."""
    return int(round(float(amount) * 1_000_000))
