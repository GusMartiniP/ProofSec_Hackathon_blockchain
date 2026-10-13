/**
 * A mensagem de cada versão da chave é a SEMENTE da chave de criptografia (assinatura determinística).
 * Mudar um byte de v1/v2 impede abrir relatórios já cifrados, então o texto é congelado aqui.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEGACY_V1_MESSAGE, keyMessageV2, keyMessageV3 } from "../frontend/src/lib/keymessages";

const W = "4vkdHeLPVSNsThnfmsgqrs6cL8Ln8jJgujJPNRHPu5At";
const HOST = "staging.dhkblca1hli2z.amplifyapp.com";
const ORIGIN = `https://${HOST}`;

describe("mensagens de derivação da chave de criptografia", () => {
  it("v2 está congelada (byte a byte)", () => {
    assert.equal(
      keyMessageV2(W, HOST, ORIGIN, "devnet"),
      `${HOST} wants you to sign in with your Solana account:\n${W}\n\n` +
        `ProofSec: gerar a chave de criptografia de relatorios (v2). Assine somente em ${ORIGIN}. Esta assinatura nao autoriza nenhuma transacao.\n\n` +
        `URI: ${ORIGIN}\nVersion: 1\nChain ID: devnet\nNonce: proofsecencryptionkeyv2\nIssued At: 2026-01-01T00:00:00.000Z`
    );
  });

  it("v1 está congelada (byte a byte)", () => {
    assert.equal(
      LEGACY_V1_MESSAGE,
      "ProofSec encryption key v1\n\nEsta assinatura gera, no seu navegador, a chave usada para cifrar e abrir relatórios de segurança.\nEla não autoriza nenhuma transação."
    );
  });

  it("v3 é em inglês, no formato SIWS, e deriva chave diferente da v2", () => {
    const v3 = keyMessageV3(W, HOST, ORIGIN, "devnet");
    assert.ok(v3.startsWith(`${HOST} wants you to sign in with your Solana account:\n${W}\n\nProofSec: generate the report encryption key (v3).`));
    assert.ok(v3.includes("This signature does not authorize any transaction."));
    assert.ok(v3.includes("Nonce: proofsecencryptionkeyv3"));
    assert.notEqual(v3, keyMessageV2(W, HOST, ORIGIN, "devnet"));
    assert.ok(!/[^\x00-\x7f]/.test(v3), "SIWS pede statement ASCII");
  });
});
