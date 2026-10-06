"""Vínculo carteira ↔ chave pública de criptografia (PS-38, ADR-022).

A carteira assina esta mensagem fixa no navegador; quem cifra um relatório confere a
assinatura antes de usar a chave, então um backend comprometido não consegue trocar a chave
do cliente ou do árbitro. A mesma mensagem é montada em `frontend/src/lib/keybinding.ts`
(a fixture `tests/fixtures/key-binding.json` garante que os dois lados concordam).
"""
from .b58 import b58decode
from .ed25519 import verify


def key_binding_message(wallet: str, public_key_b64: str) -> str:
    return (
        "ProofSec: publicar chave de criptografia\n"
        f"Carteira: {wallet}\n"
        f"Chave: {public_key_b64}\n"
        "Esta assinatura nao autoriza nenhuma transacao."
    )


def verify_key_binding(wallet: str, public_key_b64: str, signature: bytes) -> bool:
    try:
        return verify(b58decode(wallet), key_binding_message(wallet, public_key_b64).encode("utf-8"), signature)
    except ValueError:
        return False
