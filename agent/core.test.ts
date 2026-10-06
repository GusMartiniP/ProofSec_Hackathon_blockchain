/**
 * Testes do executor sem rede: RPC, programa e API são injetados (ExecutorDeps).
 *   cd agent && npm test
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TokenAccountNotFoundError, TokenInvalidAccountOwnerError } from "@solana/spl-token";
import {
  MIN_AGENT_REVIEW_SECONDS,
  PermanentRejection,
  computeTimes,
  createExecutor,
  hostOf,
  isPermanent,
  periodAllows,
  parseOwnerList,
  pickConnection,
  tokenAccountOrNull,
  validateProposal,
  type Proposal,
  type TokenAccountInfo,
} from "./core.js";

const NOW = 1_800_000_000;
const PROGRAM_ID = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const silent = () => {};

const SCOPE_DOC = '{"jobId":"agabc123def456","targets":["api.x.com"],"version":1}';
const SCOPE_HASH = createHash("sha256").update(SCOPE_DOC, "utf8").digest("hex");

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    jobId: "agabc123def456",
    clientWallet: Keypair.generate().publicKey.toBase58(),
    amountBase: 350_000_000,
    deadlineDays: 7,
    reviewHours: "72.0",
    scopeHash: SCOPE_HASH,
    scopeDocument: SCOPE_DOC,
    ...over,
  };
}

type World = {
  agent: Keypair;
  existing: Set<string>;
  policy: any | null;
  ata: TokenAccountInfo | null;
  rpcError?: unknown;
  calls: { rpc: any[][]; api: { path: string; body: any }[] };
  proposals: Proposal[];
  primaryDown?: boolean;
};

function world(over: Partial<World> = {}): World {
  const agent = Keypair.generate();
  return {
    agent,
    existing: new Set(),
    policy: {
      agent: agent.publicKey,
      active: true,
      maxPerJob: new BN("500000000"),
      maxPerPeriod: new BN("1000000000"),
      periodSeconds: new BN("86400"),
      periodStart: new BN(String(NOW - 100)),
      spentInPeriod: new BN("0"),
    },
    ata: null, // preenchido em run() com o delegate correto
    calls: { rpc: [], api: [] },
    proposals: [proposal()],
    ...over,
  };
}

function policyPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("policy"), owner.toBuffer()], PROGRAM_ID)[0];
}

async function run(w: World, ataFor?: (owner: PublicKey) => TokenAccountInfo | null, allowedOwners?: PublicKey[]) {
  const owners = new Map(w.proposals.map((p) => [p.jobId, p.clientWallet]));
  const connection: any = {
    url: "",
    getLatestBlockhash: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }),
    getAccountInfo: async (k: PublicKey) => (w.existing.has(k.toBase58()) ? { data: Buffer.alloc(0), lamports: 1 } : null),
    getBalance: async () => 1_000_000_000,
  };
  const fakeFetch = (async (url: string, init: any) => {
    const path = url.replace("https://api.test", "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    w.calls.api.push({ path, body });
    assert.equal(init.headers["x-agent-key"], "k".repeat(24));
    const payload = path.startsWith("/agent/proposals?") ? { proposals: w.proposals } : { success: true };
    return { ok: true, status: 200, json: async () => payload };
  }) as unknown as typeof fetch;
  const program: any = {
    account: {
      agentPolicy: { fetchNullable: async () => w.policy },
      config: { fetch: async () => ({ allowedMint: MINT }) },
    },
    methods: {
      initializeJobByAgent: (...args: any[]) => ({
        accountsPartial: (accounts: any) => ({
          rpc: async () => {
            w.calls.rpc.push([...args, accounts]);
            if (w.rpcError) throw w.rpcError;
            return "SIG";
          },
        }),
      }),
    },
  };
  const ex = createExecutor(
    { apiUrl: "https://api.test/", apiKey: "k".repeat(24), rpcUrls: ["https://primary.rpc/?api-key=SECRET", "https://fallback.rpc"], programId: PROGRAM_ID, agent: w.agent, allowedOwners, log: silent },
    {
      fetch: fakeFetch,
      makeConnection: (url) => {
        if (w.primaryDown && url.includes("primary")) return { ...connection, getLatestBlockhash: async () => { throw new Error("503"); } };
        return connection;
      },
      makeProgram: () => program,
      getTokenAccount: async (_c, _addr) => {
        const owner = new PublicKey(owners.values().next().value as string);
        if (ataFor) return ataFor(owner);
        return w.ata ?? { amount: 10_000_000_000n, delegate: policyPda(owner), delegatedAmount: 10_000_000_000n };
      },
      nowSeconds: () => NOW,
    },
  );
  return ex.runOnce();
}

describe("validação e prazos", () => {
  it("revisão mínima de 72 h e prazo dentro do máximo", () => {
    const t = computeTimes(proposal({ reviewHours: "1", deadlineDays: 180 }), NOW);
    assert.equal(t.reviewPeriod, MIN_AGENT_REVIEW_SECONDS);
    assert.ok(t.deadline - NOW < 180 * 86_400);
  });

  it("recusa propostas malformadas como definitivas", () => {
    for (const bad of [
      { jobId: "UPPER" },
      { jobId: "a".repeat(33) },
      { scopeHash: "zz" },
      { scopeHash: "cd".repeat(32) }, // formato válido, mas não é o hash do scopeDocument
      { scopeDocument: undefined },
      { scopeDocument: SCOPE_DOC.replace("api.x.com", "evil.com") },
      { amountBase: 0 },
      { amountBase: 1.5 },
      { deadlineDays: 0 },
      { clientWallet: "nao-e-pubkey" },
    ]) {
      assert.throws(() => validateProposal(proposal(bad as any)), PermanentRejection, JSON.stringify(bad));
    }
  });

  it("período da política zera quando vence (igual ao contrato)", () => {
    const pol = { periodStart: new BN(String(NOW - 90_000)), periodSeconds: new BN("86400"), spentInPeriod: new BN("1000"), maxPerPeriod: new BN("1000") };
    assert.equal(periodAllows(pol, new BN("1000"), NOW), true);
    assert.equal(periodAllows({ ...pol, periodStart: new BN(String(NOW - 10)) }, new BN("1"), NOW), false);
  });

  it("classifica erros do programa", () => {
    assert.equal(isPermanent({ error: { errorCode: { code: "ExceedsPeriodLimit" } } }), true);
    assert.equal(isPermanent({ logs: ["Program log: AnchorError ... Error Code: PolicyInactive."] }), true);
    assert.equal(isPermanent(new Error("Blockhash not found")), false);
  });

  it("não registra a URL completa do RPC", () => {
    assert.equal(hostOf("https://rpc.example/?api-key=SECRET"), "rpc.example");
  });
});

describe("rodada do executor", () => {
  it("abre o escrow sem pesquisador e com revisão ≥ 72 h", async () => {
    const w = world();
    const s = await run(w);
    assert.equal(s.opened, 1);
    const [jobId, amount, , review, scope, accounts] = w.calls.rpc[0];
    assert.equal(w.calls.rpc[0].length, 6, "5 argumentos + contas: sem argumento de pesquisador (PS-05)");
    assert.equal(jobId, "agabc123def456");
    assert.equal(amount.toString(), "350000000");
    assert.ok(Number(review.toString()) >= MIN_AGENT_REVIEW_SECONDS);
    assert.equal(scope.length, 32);
    assert.ok(accounts.agent.equals(w.agent.publicKey));
    const executed = w.calls.api.find((c) => c.path.endsWith("/executed"));
    assert.equal(executed?.body.signature, "SIG");
  });

  it("job já existente: só sincroniza, sem reenviar (sem reenvio cego)", async () => {
    const w = world();
    const p = w.proposals[0];
    const owner = new PublicKey(p.clientWallet);
    w.existing.add(PublicKey.findProgramAddressSync([Buffer.from("job"), owner.toBuffer(), Buffer.from(p.jobId)], PROGRAM_ID)[0].toBase58());
    const s = await run(w);
    assert.equal(s.synced, 1);
    assert.equal(w.calls.rpc.length, 0);
  });

  it("acima do limite por job → recusa definitiva e revisão humana", async () => {
    const w = world({ proposals: [proposal({ amountBase: 600_000_000 })] });
    const s = await run(w);
    assert.equal(s.rejected, 1);
    assert.equal(w.calls.rpc.length, 0);
    assert.ok(w.calls.api.some((c) => c.path.endsWith("/rejected")));
  });

  it("política inativa, de outro agente ou inexistente → recusa", async () => {
    for (const policy of [
      (w: World) => ({ ...w.policy, active: false }),
      (w: World) => ({ ...w.policy, agent: Keypair.generate().publicKey }),
      () => null,
    ]) {
      const w = world();
      w.policy = policy(w);
      const s = await run(w);
      assert.equal(s.rejected, 1);
      assert.equal(w.calls.rpc.length, 0);
    }
  });

  it("sem delegate da política na ATA → recusa (PS-15)", async () => {
    const w = world();
    const s = await run(w, () => ({ amount: 10n ** 12n, delegate: Keypair.generate().publicKey, delegatedAmount: 10n ** 12n }));
    assert.equal(s.rejected, 1);
  });

  it("erro transitório de RPC → adia, sem marcar como recusada", async () => {
    const w = world({ rpcError: new Error("Blockhash not found") });
    const s = await run(w);
    assert.equal(s.deferred, 1);
    assert.ok(!w.calls.api.some((c) => c.path.endsWith("/rejected")));
  });

  it("falha transitória ao ler a ATA → adia, não rebaixa para revisão humana", async () => {
    const w = world();
    const s = await run(w, () => {
      throw new Error("429 Too Many Requests");
    });
    assert.equal(s.deferred, 1);
    assert.equal(s.rejected, 0);
    assert.ok(!w.calls.api.some((c) => c.path.endsWith("/rejected")));
  });

  it("tokenAccountOrNull: só 'conta inexistente' vira null; o resto propaga", async () => {
    const info: TokenAccountInfo = { amount: 1n, delegate: null, delegatedAmount: 0n };
    assert.equal(await tokenAccountOrNull(async () => info), info);
    for (const err of [new TokenAccountNotFoundError(), new TokenInvalidAccountOwnerError()]) {
      assert.equal(await tokenAccountOrNull(async () => { throw err; }), null);
    }
    await assert.rejects(tokenAccountOrNull(async () => { throw new Error("fetch failed"); }), /fetch failed/);
  });

  it("lista de donos permitidos: fora dela é recusa definitiva, dentro abre o escrow (PS-39)", async () => {
    const outsider = world();
    const sOut = await run(outsider, undefined, [Keypair.generate().publicKey]);
    assert.equal(sOut.rejected, 1);
    assert.equal(outsider.calls.rpc.length, 0, "nenhuma transação para empresa fora da lista");
    assert.ok(outsider.calls.api.some((c) => c.path.endsWith("/rejected")));

    const insider = world();
    const sIn = await run(insider, undefined, [new PublicKey(insider.proposals[0].clientWallet)]);
    assert.equal(sIn.opened, 1);
  });

  it("parseOwnerList: vazio = sem restrição; pubkey inválida = erro", () => {
    assert.equal(parseOwnerList(undefined), undefined);
    assert.equal(parseOwnerList(" , "), undefined);
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    assert.deepEqual(parseOwnerList(`${a.toBase58()}, ${b.toBase58()}`)?.map((k) => k.toBase58()), [a.toBase58(), b.toBase58()]);
    assert.throws(() => parseOwnerList("nao-e-pubkey"));
  });

  it("erro definitivo do programa → recusa", async () => {
    const w = world({ rpcError: { error: { errorCode: { code: "ExceedsPeriodLimit" } }, message: "limit" } });
    const s = await run(w);
    assert.equal(s.rejected, 1);
  });

  it("RPC principal fora → usa o secundário (PS-13)", async () => {
    const w = world({ primaryDown: true });
    const s = await run(w);
    assert.equal(s.rpc, "fallback.rpc");
    assert.equal(s.opened, 1);
  });

  it("todos os RPCs fora → erro da rodada", async () => {
    await assert.rejects(
      pickConnection(["https://a", "https://b"], silent, () => ({ getLatestBlockhash: async () => { throw new Error("down"); } }) as any),
      /todos os RPCs falharam/,
    );
  });
});
