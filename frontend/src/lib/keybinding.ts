import bs58 from "bs58";
import nacl from "tweetnacl";

/**
 * Mensagem canônica assinada pela carteira para vincular sua pubkey de criptografia X25519 (PS-38, ADR-022).
 * Deve bater exatamente com `backend-serverless/functions/common/keybinding.py`.
 */
export function keyBindingMessage(wallet: string, publicKeyB64: string): string {
  return (
    "ProofSec: publish encryption key\n" +
    `Wallet: ${wallet}\n` +
    `Key: ${publicKeyB64}\n` +
    "This signature does not authorize any transaction."
  );
}

/** Mensagem antiga (português). Chaves já publicadas foram assinadas com ela e continuam válidas. */
export function legacyKeyBindingMessage(wallet: string, publicKeyB64: string): string {
  return (
    "ProofSec: publicar chave de criptografia\n" +
    `Carteira: ${wallet}\n` +
    `Chave: ${publicKeyB64}\n` +
    "Esta assinatura nao autoriza nenhuma transacao."
  );
}

/**
 * Valida se a chave pública X25519 foi de fato autorizada pela carteira Solana (Ed25519).
 */
export function verifyKeyBinding(wallet: string, publicKeyB64: string, signature: string): boolean {
  try {
    const sigBytes = bs58.decode(signature);
    const pubkeyBytes = bs58.decode(wallet);
    return [keyBindingMessage, legacyKeyBindingMessage].some((build) =>
      nacl.sign.detached.verify(new TextEncoder().encode(build(wallet, publicKeyB64)), sigBytes, pubkeyBytes)
    );
  } catch {
    return false;
  }
}
