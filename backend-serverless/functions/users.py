"""Chaves públicas de criptografia (X25519) usadas para cifrar relatórios.

A chave é derivada no navegador a partir de uma assinatura da carteira
(ver frontend/src/lib/evidence.ts). Aqui só guardamos a parte pública.
"""
import base64

from common import db
from common.b58 import is_pubkey
from common.http import HttpError, auth_wallet, handler, ok, parse_body, path_param
from common.keybinding import verify_key_binding
from common.siginput import decode_signature


@handler
def put_encryption_key(event, context):
    """PUT /users/me/encryption-key {publicKey: base64(32 bytes), signature}

    `signature` é a assinatura da carteira sobre `key_binding_message` (PS-38): sem ela quem cifra
    não tem como saber se a chave devolvida pelo backend é mesmo desta carteira.
    """
    wallet = auth_wallet(event)
    body = parse_body(event)
    pub = body.get("publicKey")
    try:
        if not isinstance(pub, str) or len(pub) > 64 or len(base64.b64decode(pub, validate=True)) != 32:
            raise ValueError
    except Exception:  # noqa: BLE001
        raise HttpError(400, "publicKey deve ser base64 de 32 bytes")
    signature = body.get("signature")
    if not verify_key_binding(wallet, pub, decode_signature(signature)):
        raise HttpError(400, "assinatura da chave não confere com a carteira")
    user = db.get_user(wallet) or {"wallet": wallet}
    db.put_user({**user, "encPublicKey": pub, "encSignature": signature})
    return ok({"success": True, "wallet": wallet, "publicKey": pub, "signature": signature})


@handler
def get_encryption_key(event, context):
    """GET /users/{wallet}/encryption-key (público)"""
    wallet = path_param(event, "wallet")
    if not is_pubkey(wallet):
        raise HttpError(400, "wallet inválida")
    user = db.get_user(wallet)
    if not user or not user.get("encPublicKey"):
        raise HttpError(404, "esta carteira ainda não publicou chave de criptografia")
    # `signature` ausente = chave antiga, sem prova de posse: o frontend não a usa para cifrar
    return ok({"success": True, "wallet": wallet, "publicKey": user["encPublicKey"],
               "signature": user.get("encSignature")})
