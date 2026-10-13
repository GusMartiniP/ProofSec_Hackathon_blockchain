"""Base58 (alfabeto Bitcoin/Solana) sem dependências."""

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_INDEX = {c: i for i, c in enumerate(ALPHABET)}


def b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    pad = len(data) - len(data.lstrip(b"\0"))
    return "1" * pad + out


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        if c not in _INDEX:
            raise ValueError("invalid base58 character")
        n = n * 58 + _INDEX[c]
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\0" * pad + body


def is_pubkey(s) -> bool:
    if not isinstance(s, str) or not (32 <= len(s) <= 44):
        return False
    try:
        return len(b58decode(s)) == 32
    except ValueError:
        return False


DEFAULT_PUBKEY = "11111111111111111111111111111111"
