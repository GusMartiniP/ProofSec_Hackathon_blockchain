/**
 * Mensagens assinadas pela carteira para DERIVAR a chave de criptografia dos relatórios.
 * Módulo puro (sem imports) para ser testável fora do Next.
 *
 * A assinatura (determinística) vira a semente da chave: qualquer byte alterado em v1/v2 muda a chave
 * e impede abrir relatórios já cifrados. Por isso o texto de v1 e v2 é CONGELADO (tests/key-versions.test.ts).
 * Para mudar o texto, crie uma versão nova e mantenha as antigas só para decifrar.
 */

/** Mensagem antiga (sem domínio). Mantida só para decifrar relatórios v1. */
export const LEGACY_V1_MESSAGE =
  "ProofSec encryption key v1\n\n" +
  "Esta assinatura gera, no seu navegador, a chave usada para cifrar e abrir relatórios de segurança.\n" +
  "Ela não autoriza nenhuma transação.";

/**
 * Mensagens v2 e v3 no formato SIWS. Tudo fixo (inclusive nonce e data) para que a
 * assinatura, e portanto a chave, seja sempre a mesma para (carteira, origem).
 * O statement é ASCII e sem quebras de linha, como pede a ABNF do SIWS.
 *
 * v2 (statement em português) só existe para abrir relatórios cifrados com ela: NÃO altere o texto,
 * ele é a semente da chave. v3 é a mensagem atual (statement em inglês, o que a carteira mostra).
 */
function siwsKeyMessage(statement: string, nonce: string, wallet: string, host: string, origin: string, chainId: string) {
  return (
    `${host} wants you to sign in with your Solana account:\n` +
    `${wallet}\n` +
    "\n" +
    `${statement}\n` +
    "\n" +
    `URI: ${origin}\n` +
    "Version: 1\n" +
    `Chain ID: ${chainId}\n` +
    `Nonce: ${nonce}\n` +
    "Issued At: 2026-01-01T00:00:00.000Z"
  );
}

export function keyMessageV2(wallet: string, host: string, origin: string, chainId: string): string {
  return siwsKeyMessage(
    `ProofSec: gerar a chave de criptografia de relatorios (v2). Assine somente em ${origin}. ` +
      "Esta assinatura nao autoriza nenhuma transacao.",
    "proofsecencryptionkeyv2",
    wallet,
    host,
    origin,
    chainId
  );
}

export function keyMessageV3(wallet: string, host: string, origin: string, chainId: string): string {
  return siwsKeyMessage(
    `ProofSec: generate the report encryption key (v3). Sign only on ${origin}. ` +
      "This signature does not authorize any transaction.",
    "proofsecencryptionkeyv3",
    wallet,
    host,
    origin,
    chainId
  );
}
