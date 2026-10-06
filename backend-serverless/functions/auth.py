"""
Sign-In With Solana (SIWS) + JWT.

1. POST /auth/nonce   {wallet, domain, uri}             → {message}
2. Usuário assina `message` na carteira (signMessage). A mensagem segue o formato
   SIWS; a Phantom confere se o domínio bate com a página e recusa se não bater.
3. POST /auth/verify  {wallet, message, signature}      → {token}
4. Rotas protegidas usam `Authorization: Bearer <token>`; o Lambda authorizer
   valida o JWT e injeta a carteira no contexto (nunca confiamos no body).

Nonces ficam numa tabela própria, um item por nonce, com TTL (PS-09), e são
consumidos de forma atômica (uso único, sem corrida).
"""
import os
import re
import secrets
import time
from datetime import datetime, timezone

from common import db, jwt, log
from common.b58 import b58decode, is_pubkey
from common.ed25519 import verify
from common.http import HttpError, handler, header, ok, parse_body
from common.secret_store import get_secret
from common.siginput import decode_signature as _decode_signature

SIWS_DOMAINS = [d.strip() for d in os.environ.get("SIWS_DOMAINS", "localhost:3000").split(",") if d.strip()]
CHAIN_ID = os.environ.get("SOLANA_CHAIN_ID", "devnet")
STATEMENT = "Entrar no ProofSec. Esta assinatura nao autoriza nenhuma transacao."
NONCE_TTL = 300
TOKEN_TTL = 12 * 3600
_NONCE_RE = re.compile(r"^Nonce: ([0-9a-f]{16,64})$", re.M)


def _secret() -> str:
    try:
        value = get_secret("JWT_SECRET_PARAM", "JWT_SECRET")
    except Exception as e:  # noqa: BLE001
        log.error("jwt_secret_unavailable", error=type(e).__name__)
        raise HttpError(500, "configuração de autenticação indisponível")
    if len(value) < 32:
        raise HttpError(500, "JWT secret ausente ou curto (mínimo 32 caracteres)")
    return value


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_origin(domain, uri) -> None:
    """O domínio precisa estar na lista permitida e a URI precisa ser a origem dele."""
    if not isinstance(domain, str) or domain not in SIWS_DOMAINS:
        raise HttpError(400, "domínio não permitido para login")
    host = domain.split(":")[0]
    allowed = {f"https://{domain}"}
    if host in ("localhost", "127.0.0.1"):
        allowed.add(f"http://{domain}")
    if not isinstance(uri, str) or uri not in allowed:
        raise HttpError(400, "uri não corresponde ao domínio")


def build_message(domain: str, uri: str, wallet: str, nonce: str, issued_at: int, expires_at: int) -> str:
    """Mensagem no formato Sign-In With Solana (ABNF)."""
    return (
        f"{domain} wants you to sign in with your Solana account:\n"
        f"{wallet}\n"
        "\n"
        f"{STATEMENT}\n"
        "\n"
        f"URI: {uri}\n"
        "Version: 1\n"
        f"Chain ID: {CHAIN_ID}\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {_iso(issued_at)}\n"
        f"Expiration Time: {_iso(expires_at)}"
    )


@handler
def nonce(event, context):
    body = parse_body(event)
    wallet = body.get("wallet")
    if not is_pubkey(wallet):
        raise HttpError(400, "wallet inválida")
    validate_origin(body.get("domain"), body.get("uri"))
    n = secrets.token_hex(12)
    issued = int(time.time())
    expires = issued + NONCE_TTL
    message = build_message(body["domain"], body["uri"], wallet, n, issued, expires)
    db.put_nonce(n, wallet, message, expires)
    return ok({"success": True, "message": message, "expiresAt": expires})


@handler
def verify_signature(event, context):
    body = parse_body(event)
    wallet, message, signature = body.get("wallet"), body.get("message"), body.get("signature")
    if not is_pubkey(wallet) or not isinstance(message, str) or not isinstance(signature, str):
        raise HttpError(400, "campos obrigatórios: wallet, message, signature")

    m = _NONCE_RE.search(message)
    item = db.get_nonce(m.group(1)) if m else None
    if not item or item.get("wallet") != wallet or item.get("message") != message:
        log.warning("login_rejected", reason="nonce_invalid", wallet=wallet)
        raise HttpError(401, "nonce inválido ou já utilizado")
    if int(item.get("expiresAt", 0)) < time.time():
        raise HttpError(401, "nonce expirado")
    if not verify(b58decode(wallet), message.encode("utf-8"), _decode_signature(signature)):
        log.warning("login_rejected", reason="bad_signature", wallet=wallet)
        raise HttpError(401, "assinatura não confere")
    if not db.consume_nonce(m.group(1)):
        log.warning("login_rejected", reason="replay", wallet=wallet)
        raise HttpError(401, "nonce inválido ou já utilizado")

    now = int(time.time())
    token = jwt.encode({"sub": wallet, "iat": now, "exp": now + TOKEN_TTL}, _secret())
    log.info("login_ok", wallet=wallet)
    return ok({"success": True, "token": token, "wallet": wallet, "expiresAt": now + TOKEN_TTL})


def authorizer(event, context):
    """Lambda authorizer (HTTP API, payload 2.0, respostas simples)."""
    auth = header(event, "authorization") or ""
    if not auth.lower().startswith("bearer "):
        return {"isAuthorized": False}
    try:
        payload = jwt.decode(auth[7:].strip(), _secret())
    except (ValueError, HttpError):
        return {"isAuthorized": False}
    return {"isAuthorized": True, "context": {"wallet": payload["sub"]}}
