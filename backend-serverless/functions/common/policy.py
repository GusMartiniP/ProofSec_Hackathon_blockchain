"""
Policy Engine DETERMINÍSTICO do agente.

Regra de ouro: a LLM nunca decide valores. O orçamento sai desta tabela a
partir da severidade do alerta (que vem do GuardDuty/Security Hub, não da LLM),
e a decisão final de gasto é imposta on-chain pela conta AgentPolicy.
Este módulo é só a primeira barreira (evita propor o que a chain vai recusar).
"""
import os

MAX_AGENT_SPENDING_LIMIT_USDC = float(os.environ.get("MAX_AGENT_SPENDING_LIMIT_USDC", "500"))


def parse_budget_scale(raw) -> float:
    """Fator (0, 1] aplicado à tabela de orçamentos. Só REDUZ: um valor inválido, zero, negativo ou
    acima de 1 volta para 1, então configuração errada nunca aumenta quanto o agente propõe.
    Existe para o dev/devnet, onde o USDC do faucet é pouco (ver ADR-026); prod exige 1 no template."""
    try:
        scale = float(raw)
    except (TypeError, ValueError):
        return 1.0
    return scale if 0 < scale <= 1 else 1.0


AGENT_BUDGET_SCALE = parse_budget_scale(os.environ.get("AGENT_BUDGET_SCALE", "1"))

# Severidade normalizada → orçamento sugerido (USDC) e prazo (dias)
BUDGET_TABLE = {
    "LOW": (150.0, 7),
    "MEDIUM": (350.0, 7),
    "HIGH": (750.0, 10),
    "CRITICAL": (1500.0, 14),
}


def normalize_severity(value) -> str:
    """Aceita rótulo (LOW..CRITICAL) ou número 0-10 do GuardDuty."""
    if isinstance(value, str) and value.upper() == "INFORMATIONAL":
        return "LOW"
    if isinstance(value, str) and value.upper() in BUDGET_TABLE:
        return value.upper()
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "MEDIUM"
    if n >= 9:
        return "CRITICAL"
    if n >= 7:
        return "HIGH"
    if n >= 4:
        return "MEDIUM"
    return "LOW"


def recommend(severity) -> dict:
    sev = normalize_severity(severity)
    budget, days = BUDGET_TABLE[sev]
    return {"severity": sev, "budgetUsdc": round(budget * AGENT_BUDGET_SCALE, 6), "deadlineDays": days}


def decide(budget_usdc: float, limit: float | None = None) -> dict:
    limit = MAX_AGENT_SPENDING_LIMIT_USDC if limit is None else limit
    autonomous = 0 < budget_usdc <= limit
    return {
        "autonomous": autonomous,
        "status": "AUTO_APPROVED" if autonomous else "NEEDS_HUMAN",
        "limitUsdc": limit,
        "reason": (
            f"Budget {budget_usdc:.2f} USDC is within the autonomous ceiling ({limit:.2f} USDC). "
            "Execution still goes through the on-chain AgentPolicy limit."
            if autonomous
            else f"Budget {budget_usdc:.2f} USDC exceeds the autonomous ceiling ({limit:.2f} USDC): requires a human signature."
        ),
    }
