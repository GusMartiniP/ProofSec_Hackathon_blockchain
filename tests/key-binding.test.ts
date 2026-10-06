/**
 * PS-38: o frontend só cifra para uma chave se a carteira provou ser dona dela. A fixture é
 * produzida pelo backend Python (`common/keybinding.py` + assinatura Ed25519), então este teste
 * também garante que a mensagem é idêntica nos dois lados.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { keyBindingMessage, verifyKeyBinding } from "../frontend/src/lib/keybinding";

const f = JSON.parse(readFileSync(new URL("./fixtures/key-binding.json", import.meta.url), "utf8"));

describe("vínculo carteira ↔ chave de criptografia", () => {
  it("a mensagem é idêntica à do backend", () => {
    assert.equal(keyBindingMessage(f.wallet, f.publicKey), f.message);
  });

  it("aceita a assinatura gerada pelo backend/carteira", () => {
    assert.equal(verifyKeyBinding(f.wallet, f.publicKey, f.signature), true);
  });

  it("recusa chave trocada, carteira trocada, assinatura ausente, corrompida ou enorme", () => {
    const otherKey = Buffer.alloc(32, 7).toString("base64");
    assert.equal(verifyKeyBinding(f.wallet, otherKey, f.signature), false);
    assert.equal(verifyKeyBinding("11111111111111111111111111111112", f.publicKey, f.signature), false);
    assert.equal(verifyKeyBinding(f.wallet, f.publicKey, null), false);
    assert.equal(verifyKeyBinding(f.wallet, f.publicKey, undefined), false);
    assert.equal(verifyKeyBinding(f.wallet, f.publicKey, "não-é-assinatura"), false);
    assert.equal(verifyKeyBinding(f.wallet, f.publicKey, "z".repeat(10_000)), false);
    const flipped = f.signature.slice(0, -1) + (f.signature.endsWith("A") ? "B" : "A");
    assert.equal(verifyKeyBinding(f.wallet, f.publicKey, flipped), false);
    assert.equal(verifyKeyBinding("nao-e-pubkey", f.publicKey, f.signature), false);
  });
});
