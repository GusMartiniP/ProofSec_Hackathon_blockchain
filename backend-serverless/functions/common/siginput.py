"""Decodificação de assinaturas Ed25519 recebidas pela API (base58 ou base64)."""
import base64

from .b58 import b58decode
from .http import HttpError

MAX_SIGNATURE_CHARS = 128  # base58/base64 de 64 bytes têm até 88 caracteres


def decode_signature(sig) -> bytes:
    """64 bytes ou HttpError 400. O tamanho é limitado antes de decodificar (b58decode é quadrático)."""
    if not isinstance(sig, str) or len(sig) > MAX_SIGNATURE_CHARS:
        raise HttpError(400, "invalid signature (expected base58 or base64 of 64 bytes)")
    try:
        raw = b58decode(sig)
        if len(raw) == 64:
            return raw
    except ValueError:
        pass
    try:
        raw = base64.b64decode(sig, validate=True)
        if len(raw) == 64:
            return raw
    except Exception:  # noqa: BLE001
        pass
    raise HttpError(400, "invalid signature (expected base58 or base64 of 64 bytes)")
