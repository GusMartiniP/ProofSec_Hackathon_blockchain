/**
 * ADR-025: a visão por papel decide só o que a UI exibe; não autoriza nada.
 *
 *   npm --prefix agent exec tsx -- --test ../tests/role.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canConfigureAgent,
  canCreateEscrow,
  defaultView,
  isArbiterAnywhere,
  jobsForRoleView,
  loadRole,
  saveRole,
  viewsFor,
} from "../frontend/src/lib/role";

const ME = "Me111111111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";
const ARB = "Arb1111111111111111111111111111111111111111";

const job = (over: Partial<{ client: string; researcher: string | null; arbiter: string; status: string }>) => ({
  client: OTHER,
  researcher: null,
  arbiter: ARB,
  status: "OPEN",
  ...over,
});

const mine = job({ client: ME, status: "OPEN" });
const openByOther = job({});
const assignedToMe = job({ researcher: ME, status: "IN_PROGRESS" });
const takenByOther = job({ researcher: OTHER, status: "IN_PROGRESS" });
const disputed = job({ status: "DISPUTED", arbiter: ME });
const all = [mine, openByOther, assignedToMe, takenByOther, disputed];

describe("visão por papel", () => {
  it("empresa só vê os escrows que criou", () => {
    assert.deepEqual(jobsForRoleView(all, "company", "mine", ME), [mine]);
  });

  it("pesquisador vê vagas abertas sem pesquisador e que não são dele como cliente", () => {
    assert.deepEqual(jobsForRoleView(all, "researcher", "open", ME), [openByOther]);
  });

  it("pesquisador vê só os trabalhos em que foi atribuído", () => {
    assert.deepEqual(jobsForRoleView(all, "researcher", "mine", ME), [assignedToMe]);
  });

  it("árbitro vê os jobs em que é árbitro, nunca os próprios como cliente", () => {
    const own = job({ client: ME, arbiter: ME });
    assert.deepEqual(jobsForRoleView([disputed, own], "company", "arbiter", ME), [disputed]);
    assert.equal(isArbiterAnywhere([disputed], ME), true);
    assert.equal(isArbiterAnywhere([own], ME), false);
    assert.equal(isArbiterAnywhere(all, null), false);
  });

  it("sem carteira mostra a lista pública completa (modo leitura)", () => {
    assert.deepEqual(jobsForRoleView(all, "company", "mine", null), all);
  });

  it("a visão de árbitro só aparece quando a carteira é árbitro", () => {
    assert.deepEqual(viewsFor("company", false), ["mine"]);
    assert.deepEqual(viewsFor("researcher", false), ["open", "mine"]);
    assert.deepEqual(viewsFor("company", true), ["mine", "arbiter"]);
    assert.equal(defaultView("company"), "mine");
    assert.equal(defaultView("researcher"), "open");
  });
});

describe("o que o painel mostra", () => {
  it("só a empresa cria escrow e configura o agente", () => {
    assert.equal(canCreateEscrow("company"), true);
    assert.equal(canConfigureAgent("company"), true);
    assert.equal(canCreateEscrow("researcher"), false);
    assert.equal(canConfigureAgent("researcher"), false);
    assert.equal(canCreateEscrow(null), false);
    assert.equal(canConfigureAgent(null), false);
  });
});

describe("persistência da preferência", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it("guarda e lê o papel por carteira", () => {
    const s = memory();
    saveRole(ME, "researcher", s);
    assert.equal(loadRole(ME, s), "researcher");
    assert.equal(loadRole(OTHER, s), null);
  });

  it("valor inválido ou storage que falha não quebram a tela", () => {
    const s = memory();
    s.m.set(`proofsec:role:${ME}`, "admin");
    assert.equal(loadRole(ME, s), null);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(loadRole(ME, broken), null);
    assert.doesNotThrow(() => saveRole(ME, "company", broken));
    assert.equal(loadRole(null, s), null);
  });
});
