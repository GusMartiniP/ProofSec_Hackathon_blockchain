/**
 * Regressão (revisão geral, 2026-10-06): o frontend só assina o financiamento se o rascunho que o
 * backend devolveu bater com o escopo e com o que o usuário digitou.
 * A fixture vem do `build_scope_document` do backend Python (floats como `72.0`), para provar que
 * o hash é conferido sobre os mesmos bytes sem recanonicalizar.
 *
 *   npm --prefix agent exec tsx -- --test ../tests/meta-integrity.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertMetaIntegrity } from "../frontend/src/lib/meta";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/scope-draft.json", import.meta.url), "utf8"));
const WALLET = fixture.clientWallet as string;
const meta = (over: Record<string, unknown> = {}) => ({ ...fixture, ...over }) as any;
const rejects = (m: any, expected = {}, wallet = WALLET) =>
  assert.rejects(assertMetaIntegrity(m, wallet, expected), /nothing was signed/);

describe("assertMetaIntegrity", () => {
  it("aceita o rascunho íntegro gerado pelo backend", async () => {
    await assertMetaIntegrity(meta(), WALLET, { amountBase: 350_000_000, deadlineDays: 7, reviewHours: 72, researcher: null });
  });

  it("recusa valor, prazo ou revisão trocados pelo backend", async () => {
    await rejects(meta({ amountBase: 3_500_000_000 }));
    await rejects(meta({ deadlineDays: 30 }));
    await rejects(meta({ reviewHours: "1" }));
  });

  it("recusa escopo adulterado, ausente ou de outro job/cliente", async () => {
    await rejects(meta({ scopeHash: "00".repeat(32) }));
    await rejects(meta({ scopeDocument: undefined }));
    await rejects(meta({ scopeDocument: fixture.scopeDocument.replace("api.x.com", "evil.com") }));
    await rejects(meta({ jobId: "outrojob" }));
    await rejects(meta(), {}, "OutraCarteira1111111111111111111111111111111");
    await rejects(meta({ clientWallet: "OutraCarteira1111111111111111111111111111111" }));
  });

  it("recusa divergência com o que o usuário digitou", async () => {
    await rejects(meta(), { amountBase: 1_000_000 });
    await rejects(meta(), { deadlineDays: 1 });
    await rejects(meta(), { reviewHours: 1 });
  });

  it("recusa pesquisador pré-atribuído que o usuário não pediu", async () => {
    await rejects(meta({ assignedResearcher: "Atacante1111111111111111111111111111111111" }), { researcher: null });
    await assertMetaIntegrity(meta({ assignedResearcher: "Pesq1111111111111111111111111111111111111" }), WALLET, {
      researcher: "Pesq1111111111111111111111111111111111111",
    });
  });

  it("proposta do agente nunca vem com pesquisador", async () => {
    await rejects(meta({ createdByAgent: true, assignedResearcher: "Atacante1111111111111111111111111111111111" }));
    await assertMetaIntegrity(meta({ createdByAgent: true }), WALLET);
  });
});
