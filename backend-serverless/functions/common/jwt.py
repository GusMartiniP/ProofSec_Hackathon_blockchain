"""JWT HS256 mínimo (sem dependências)."""
import base64
import hashlib
import hmac
import json
import math
import time


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def encode(payload: dict, secret: str) -> str:
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
    return f"{header}.{body}.{_b64(sig)}"


def decode(token: str, secret: str) -> dict:
    """Retorna o payload ou lança ValueError."""
    try:
        header, body, sig = token.split(".")
        header_obj = json.loads(_unb64(header))  # ainda sem assinatura: entrada hostil
        if not isinstance(header_obj, dict) or header_obj.get("alg") != "HS256":
            raise ValueError("unsupported algorithm")
        expected = hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(sig)):
            raise ValueError("invalid signature")
        payload = json.loads(_unb64(body))
    except (ValueError, TypeError, AttributeError, RecursionError):
        # JSON profundo demais (RecursionError), base64/UTF-8 inválidos, não-texto etc.
        raise ValueError("invalid token")
    if not isinstance(payload, dict):
        raise ValueError("invalid payload")
    exp = payload.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise ValueError("token expired")
    try:
        valid_exp = math.isfinite(exp) and exp >= time.time()
    except OverflowError:  # inteiro gigante
        valid_exp = False
    if not valid_exp:
        raise ValueError("token expired")
    if not isinstance(payload.get("sub"), str) or not payload["sub"]:
        raise ValueError("invalid subject")
    return payload
