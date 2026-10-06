"""Helpers HTTP compartilhados pelas Lambdas (API Gateway HTTP API, payload v2)."""
import json
import os
from decimal import Decimal

from . import log

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")


def _default(o):
    # DynamoDB devolve números como Decimal; json.dumps não sabe serializar.
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    if isinstance(o, (set, frozenset)):
        return list(o)
    raise TypeError(f"tipo não serializável: {type(o).__name__}")


def dumps(body) -> str:
    return json.dumps(body, default=_default, ensure_ascii=False)


def response(status_code: int, body) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Authorization,Content-Type,x-agent-key",
        },
        "body": dumps(body),
    }


def ok(body, status_code=200):
    return response(status_code, body)


def error(status_code: int, message: str, **extra):
    return response(status_code, {"success": False, "error": message, **extra})


class HttpError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def parse_body(event) -> dict:
    raw = event.get("body") or "{}"
    if not isinstance(raw, (str, bytes, bytearray)):
        raise HttpError(400, "corpo deve ser JSON textual")
    if event.get("isBase64Encoded"):
        import base64
        try:
            raw = base64.b64decode(raw, validate=True).decode("utf-8")
        except (TypeError, ValueError, UnicodeError):
            raise HttpError(400, "corpo base64 inválido")
    try:
        body = json.loads(raw)
    except (ValueError, RecursionError):  # JSONDecodeError, UnicodeError e o limite de dígitos de int
        raise HttpError(400, "JSON inválido")
    if not isinstance(body, dict):
        raise HttpError(400, "corpo deve ser um objeto JSON")
    return body


def path_param(event, name: str) -> str:
    value = (event.get("pathParameters") or {}).get(name)
    if not value:
        raise HttpError(400, f"parâmetro de rota ausente: {name}")
    return value


def query_param(event, name: str, default=None):
    return (event.get("queryStringParameters") or {}).get(name, default)


def header(event, name: str):
    headers = event.get("headers") or {}
    return headers.get(name.lower()) or headers.get(name)


def auth_wallet(event) -> str:
    """Carteira autenticada, injetada pelo Lambda authorizer (nunca vem do body)."""
    ctx = (event.get("requestContext") or {}).get("authorizer") or {}
    wallet = (ctx.get("lambda") or {}).get("wallet")
    if not wallet:
        raise HttpError(401, "não autenticado")
    return wallet


def handler(fn):
    """Decorator: converte HttpError/exceções em respostas JSON."""

    def wrapped(event, context):
        try:
            return fn(event, context)
        except HttpError as e:
            return error(e.status_code, e.message)
        except Exception as e:  # noqa: BLE001
            ctx = (event or {}).get("requestContext") or {}
            log.error("unhandled", handler=fn.__name__, error=type(e).__name__, detail=str(e)[:300],
                      requestId=ctx.get("requestId"))
            return error(500, "erro interno")

    wrapped.__name__ = fn.__name__
    return wrapped
