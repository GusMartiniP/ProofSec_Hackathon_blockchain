"""
Policy Engine DETERMINÍSTICO do agente.

Regra de ouro: a LLM nunca decide valores. O orçamento sai desta tabela a
partir da severidade do alerta (que vem do GuardDuty/Security Hub, não da LLM),
e a decisão final de gasto é imposta on-chain pela conta AgentPolicy.
Este módulo é só a primeira barreira (evita propor o que a chain vai recusar).
"""
import os

MAX_AGENT_SPENDING_LIMIT_USDC = float(os.environ.get("MAX_AGENT_SPENDING_LIMIT_USDC", "500"))

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
    return {"severity": sev, "budgetUsdc": budget, "deadlineDays": days}


def decide(budget_usdc: float, limit: float | None = None) -> dict:
    limit = MAX_AGENT_SPENDING_LIMIT_USDC if limit is None else limit
    autonomous = 0 < budget_usdc <= limit
    return {
        "autonomous": autonomous,
        "status": "AUTO_APPROVED" if autonomous else "NEEDS_HUMAN",
        "limitUsdc": limit,
        "reason": (
            f"Budget {budget_usdc:.2f} USDC dentro do teto autônomo ({limit:.2f} USDC). "
            "A execução ainda passa pelo limite on-chain da AgentPolicy."
            if autonomous
            else f"Budget {budget_usdc:.2f} USDC excede o teto autônomo ({limit:.2f} USDC): requer assinatura humana."
        ),
    }
