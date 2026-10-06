import bs58 from "bs58";
import nacl from "tweetnacl";

/**
 * Mensagem canônica assinada pela carteira para vincular sua pubkey de criptografia X25519 (PS-38, ADR-022).
 * Deve bater exatamente com `backend-serverless/functions/common/keybinding.py`.
 */
export function keyBindingMessage(wallet: string, publicKeyB64: string): string {
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
    const message = new TextEncoder().encode(keyBindingMessage(wallet, publicKeyB64));
    const sigBytes = bs58.decode(signature);
    const pubkeyBytes = bs58.decode(wallet);
    return nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}
