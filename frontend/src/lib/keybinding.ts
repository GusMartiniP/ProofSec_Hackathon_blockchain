import bs58 from "bs58";
import nacl from "tweetnacl";

/**
 * Vínculo carteira ↔ chave pública de criptografia (PS-38, ADR-022).
 *
 * A carteira assina esta mensagem fixa ao publicar a chave. Quem vai cifrar um relatório confere a
 * assinatura contra a pubkey da carteira (que é o próprio endereço) antes de usar a chave devolvida
 * pelo backend: um backend comprometido não consegue trocar a chave do cliente ou do árbitro.
 * O texto precisa ser idêntico ao de `backend-serverless/functions/common/keybinding.py`
 * (a fixture `tests/fixtures/key-binding.json` garante isso nos dois lados).
 */
export function keyBindingMessage(wallet: string, publicKeyB64: string): string {
  return (
    "ProofSec: publicar chave de criptografia\n" +
    `Carteira: ${wallet}\n` +
    `Chave: ${publicKeyB64}\n` +
    "Esta assinatura nao autoriza nenhuma transacao."
  );
}

function decodeSignature(signature: string): Uint8Array | null {
  if (signature.length > 128) return null;
  try {
    const raw = bs58.decode(signature);
    if (raw.length === 64) return raw;
  } catch {
    /* tenta base64 */
  }
  try {
    const bin = atob(signature);
    if (bin.length === 64) return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    /* inválida */
  }
  return null;
}

/** `false` para assinatura ausente (chave antiga, sem prova de posse), malformada ou de outra carteira/chave. */
export function verifyKeyBinding(wallet: string, publicKeyB64: string, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const sig = decodeSignature(signature);
  if (!sig) return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(keyBindingMessage(wallet, publicKeyB64)), sig, bs58.decode(wallet));
  } catch {
    return false;
  }
}
