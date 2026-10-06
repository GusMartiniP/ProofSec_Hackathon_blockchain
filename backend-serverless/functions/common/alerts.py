"""Alertas operacionais e de segurança via SNS (PS-05, PS-11)."""
import json
import os

from . import log

ALERT_TOPIC_ARN = os.environ.get("ALERT_TOPIC_ARN", "")
_sns = None


def _client():
    global _sns
    if _sns is None:
        import boto3

        _sns = boto3.client("sns")
    return _sns


def alert(subject: str, severity: str = "WARNING", **fields) -> bool:
    """Registra no log e publica no tópico de alertas (se configurado).

    severity: INFORMATIONAL | WARNING | CRITICAL | SECURITY_INCIDENT
    """
    log.warning("alert", subject=subject, severity=severity, **fields)
    if not ALERT_TOPIC_ARN:
        return False
    try:
        _client().publish(
            TopicArn=ALERT_TOPIC_ARN,
            Subject=f"[ProofSec][{severity}] {subject}"[:100],
            Message=json.dumps({"subject": subject, "severity": severity, **fields}, default=str, ensure_ascii=False),
        )
        return True
    except Exception as e:  # noqa: BLE001 - alerta nunca derruba o fluxo principal
        log.error("alert_publish_failed", subject=subject, error=type(e).__name__)
        return False
