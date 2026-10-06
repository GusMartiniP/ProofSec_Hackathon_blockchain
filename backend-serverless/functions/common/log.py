"""Log estruturado (uma linha JSON por evento) para o CloudWatch Logs.

Nunca registrar segredos, JWTs, assinaturas ou conteúdo de relatórios.
"""
import json
import time


def log(level: str, event: str, **fields) -> None:
    record = {"level": level, "event": event, "ts": int(time.time()), **fields}
    print(json.dumps(record, default=str, ensure_ascii=False))


def info(event: str, **fields) -> None:
    log("info", event, **fields)


def warning(event: str, **fields) -> None:
    log("warning", event, **fields)


def error(event: str, **fields) -> None:
    log("error", event, **fields)
