import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  approve,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  freezeAccount,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  revoke,
  transfer,
} from "@solana/spl-token";
import { createHash, randomBytes } from "crypto";
import { assert } from "chai";

/**
 * Testes do programa ProofSec — `anchor test`.
 *
 * Cada ataque verifica (1) que a transação falha com o erro esperado e (2) que o estado
 * fica intacto. Os cenários que dependem do relógio da chain usam o cheatcode
 * `surfnet_timeTravel` do Surfpool (validator padrão do Anchor 1.x) — sem `sleep`.
 * Em validators sem esse cheatcode, esses testes são marcados como pendentes.
 */
describe("proofsec", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Proofsec as anchor.Program<any>;
  const conn = provider.connection;
  const P: any = program.methods;
  const A: any = program.account;

  const admin = (provider.wallet as anchor.Wallet).payer; // upgrade authority do programa nos testes
  const arbiter = Keypair.generate();
  const treasury = Keypair.generate();
  const client = Keypair.generate();
  const researcher = Keypair.generate();
  const attacker = Keypair.generate();
  const agent = Keypair.generate();

  const DECIMALS = 6;
  const FEE_BPS = 250; // 2,5%
  const DISPUTE_PERIOD = 120; // s
  const AGENT_MIN_REVIEW = 72 * 3600;

  let mint: PublicKey;
  let otherMint: PublicKey;
  let clientAta: PublicKey;
  let vaultRent: number;
  let canTimeTravel = false;

  const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE);
  const jobPda = (owner: PublicKey, id: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("job"), owner.toBuffer(), Buffer.from(id)], program.programId)[0];
  const vaultPda = (owner: PublicKey, id: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer(), Buffer.from(id)], program.programId)[0];
  const policyPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("policy"), owner.toBuffer()], program.programId)[0];
  const ata = (m: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(m, owner);

  const units = (n: number) => n * 10 ** DECIMALS;
  const usdc = (n: number) => new BN(units(n));
  const sha = (s: string) => Array.from(createHash("sha256").update(s).digest());
  const newId = () => randomBytes(6).toString("hex");

  // ------------------------------------------------------------------ tempo da chain
  async function chainNow(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    return Number(info!.data.readBigInt64LE(32)); // Clock.unix_timestamp
  }

  async function rpc(method: string, params: unknown[]): Promise<any> {
    return (conn as any)._rpcRequest(method, params);
  }

  /** Avança o relógio da chain (Surfpool) e espera o próximo bloco refletir. */
  async function timeTravel(seconds: number) {
    const target = (await chainNow()) + seconds;
    const res = await rpc("surfnet_timeTravel", [{ absoluteTimestamp: target * 1000 }]);
    if (res?.error) throw new Error(`surfnet_timeTravel falhou: ${JSON.stringify(res.error)}`);
    for (let i = 0; i < 100; i++) {
      if ((await chainNow()) >= target) return;
      await new Promise((r) => setTimeout(r, 100)); // sincronização com a produção de blocos
    }
    throw new Error("o relógio da chain não avançou");
  }

  // ------------------------------------------------------------------ helpers
  async function airdrop(pk: PublicKey, sol = 10) {
    const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  function ataIxs(m: PublicKey, owners: PublicKey[]): TransactionInstruction[] {
    return owners.map((o) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(m, o), o, m));
  }

  async function balance(account: PublicKey): Promise<number> {
    try {
      return Number((await getAccount(conn, account)).amount);
    } catch {
      return 0;
    }
  }

  async function expectError(p: Promise<unknown>, contains?: string) {
    try {
      await p;
    } catch (e: any) {
      if (contains) assert.include(String(e) + JSON.stringify(e?.logs ?? []), contains);
      return;
    }
    assert.fail(`era esperado erro${contains ? ` (${contains})` : ""}`);
  }

  async function job(id: string, owner = client.publicKey): Promise<any> {
    return A.jobAccount.fetch(jobPda(owner, id));
  }

  type JobOpts = { amount?: number; researcher?: PublicKey | null; review?: number; deadlineIn?: number; m?: PublicKey };

  async function createJob(opts: JobOpts = {}): Promise<string> {
    const id = newId();
    const m = opts.m ?? mint;
    const now = await chainNow();
    await P.initializeJob(
      id,
      usdc(opts.amount ?? 10),
      new BN(now + (opts.deadlineIn ?? 3600)),
      new BN(opts.review ?? 60),
      sha(`scope-${id}`),
      opts.researcher === undefined ? researcher.publicKey : opts.researcher ?? PublicKey.default
    )
      .accountsPartial({
        config: configPda,
        jobAccount: jobPda(client.publicKey, id),
        vault: vaultPda(client.publicKey, id),
        client: client.publicKey,
        clientTokenAccount: ata(m, client.publicKey),
        mint: m,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();
    return id;
  }

  async function accept(id: string, who = researcher, owner = client.publicKey) {
    await P.acceptJob().accountsPartial({ jobAccount: jobPda(owner, id), researcher: who.publicKey }).signers([who]).rpc();
  }

  async function submit(id: string, who = researcher, owner = client.publicKey, hash = sha(`report-${id}`)) {
    await P.submitEvidence(hash).accountsPartial({ jobAccount: jobPda(owner, id), researcher: who.publicKey }).signers([who]).rpc();
  }

  async function readyForReview(opts: JobOpts = {}) {
    const id = await createJob(opts);
    await accept(id);
    await submit(id);
    return id;
  }

  async function settleAccounts(id: string, owner = client.publicKey) {
    const j = await job(id, owner);
    return {
      config: configPda,
      jobAccount: jobPda(owner, id),
      vault: j.vault,
      mint: j.mint,
      client: j.client,
      clientTokenAccount: ata(j.mint, j.client),
      researcher: j.researcher,
      researcherTokenAccount: ata(j.mint, j.researcher),
      treasury: j.treasury ?? treasury.publicKey,
      treasuryTokenAccount: ata(j.mint, j.treasury ?? treasury.publicKey),
      rentPayer: j.rentPayer,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  async function approveTx(id: string, overrides: Record<string, PublicKey> = {}) {
    const a = await settleAccounts(id);
    const { clientTokenAccount, ...accounts } = a;
    return P.approveAndRelease()
      .accountsPartial({ ...accounts, ...overrides })
      .preInstructions(ataIxs(a.mint, [a.researcher, treasury.publicKey]))
      .signers([client])
      .rpc();
  }

  async function claimTx(id: string, who = researcher) {
    const a = await settleAccounts(id);
    const { clientTokenAccount, client: _c, ...accounts } = a;
    return P.claimAfterReview()
      .accountsPartial({ ...accounts, researcher: who.publicKey, researcherTokenAccount: ata(a.mint, who.publicKey) })
      .preInstructions(ataIxs(a.mint, [who.publicKey, treasury.publicKey]))
      .signers([who])
      .rpc();
  }

  async function openDisputeTx(id: string, who = client) {
    return P.openDispute().accountsPartial({ jobAccount: jobPda(client.publicKey, id), client: who.publicKey }).signers([who]).rpc();
  }

  async function resolveTx(id: string, bps: number, who = arbiter) {
    const a = await settleAccounts(id);
    return P.resolveDispute(bps)
      .accountsPartial({ ...a, arbiter: who.publicKey })
      .preInstructions(ataIxs(a.mint, [a.client, a.researcher, treasury.publicKey]))
      .signers([who])
      .rpc();
  }

  async function timeoutTx(id: string) {
    const a = await settleAccounts(id);
    return P.resolveDisputeTimeout()
      .accountsPartial(a)
      .preInstructions(ataIxs(a.mint, [a.client, a.researcher, treasury.publicKey]))
      .rpc();
  }

  async function refundTx(kind: "cancelJob" | "refundExpired", id: string, who = client) {
    const a = await settleAccounts(id);
    return P[kind]()
      .accountsPartial({
        jobAccount: a.jobAccount,
        vault: a.vault,
        mint: a.mint,
        client: who.publicKey,
        clientTokenAccount: ata(a.mint, who.publicKey),
        rentPayer: a.rentPayer,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(ataIxs(a.mint, [who.publicKey]))
      .signers([who])
      .rpc();
  }

  async function recoverTx(id: string, overrides: Record<string, PublicKey> = {}) {
    const a = await settleAccounts(id);
    return P.recoverStuckFunds()
      .accountsPartial({
        jobAccount: a.jobAccount,
        vault: a.vault,
        mint: a.mint,
        client: a.client,
        clientTokenAccount: ata(a.mint, a.client),
        rentPayer: a.rentPayer,
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      })
      .preInstructions(ataIxs(a.mint, [a.client]))
      .rpc(); // sem signer de instrução: qualquer pessoa chama
  }

  function configArgs(over: Partial<{ arbiter: PublicKey; treasury: PublicKey; fee: number; mint: PublicKey; dispute: number }> = {}) {
    return [
      over.arbiter ?? arbiter.publicKey,
      over.treasury ?? treasury.publicKey,
      over.fee ?? FEE_BPS,
      over.mint ?? mint,
      new BN(over.dispute ?? DISPUTE_PERIOD),
    ];
  }

  async function updateConfig(over: Parameters<typeof configArgs>[0] = {}, signer = admin) {
    return P.updateConfig(signer.publicKey, ...configArgs(over))
      .accountsPartial({ config: configPda, admin: signer.publicKey })
      .signers(signer === admin ? [] : [signer])
      .rpc();
  }

  /** Roda `fn` com um mint cuja freeze authority é o admin (como o USDC real) liberado na config. */
  async function withFreezableMint<T>(fn: (m: PublicKey) => Promise<T>): Promise<T> {
    const fm = await createMint(conn, admin, admin.publicKey, admin.publicKey, DECIMALS);
    const cAta = (await getOrCreateAssociatedTokenAccount(conn, admin, fm, client.publicKey)).address;
    await mintTo(conn, admin, fm, cAta, admin, units(1_000));
    await updateConfig({ mint: fm });
    try {
      return await fn(fm);
    } finally {
      await updateConfig({});
    }
  }

  async function freezeAtaOf(owner: PublicKey, m: PublicKey) {
    const a = (await getOrCreateAssociatedTokenAccount(conn, admin, m, owner)).address;
    await freezeAccount(conn, admin, a, m, admin);
  }

  // ------------------------------------------------------------------ setup
  before(async () => {
    for (const kp of [arbiter, treasury, client, researcher, attacker, agent]) await airdrop(kp.publicKey);
    mint = await createMint(conn, admin, admin.publicKey, null, DECIMALS);
    otherMint = await createMint(conn, admin, admin.publicKey, null, DECIMALS);
    clientAta = (await getOrCreateAssociatedTokenAccount(conn, admin, mint, client.publicKey)).address;
    await mintTo(conn, admin, mint, clientAta, admin, units(100_000));
    const otherAta = (await getOrCreateAssociatedTokenAccount(conn, admin, otherMint, client.publicKey)).address;
    await mintTo(conn, admin, otherMint, otherAta, admin, units(1_000));
    vaultRent = await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

    try {
      const now = await chainNow();
      const res = await rpc("surfnet_timeTravel", [{ absoluteTimestamp: (now + 1) * 1000 }]);
      canTimeTravel = !res?.error;
    } catch {
      canTimeTravel = false;
    }
  });

  // ==================================================================
  describe("configuração", () => {
    it("PS-03 regression: quem não é upgrade authority não inicializa a config", async () => {
      await expectError(
        P.initializeConfig(...configArgs({ arbiter: attacker.publicKey, treasury: attacker.publicKey }))
          .accountsPartial({ config: configPda, admin: attacker.publicKey, program: program.programId, programData, systemProgram: SystemProgram.programId })
          .signers([attacker])
          .rpc(),
        "InvalidAuthority"
      );
      assert.isNull(await conn.getAccountInfo(configPda), "config não pode existir");
    });

    it("upgrade authority inicializa a config", async () => {
      await P.initializeConfig(...configArgs())
        .accountsPartial({ config: configPda, admin: admin.publicKey, program: program.programId, programData, systemProgram: SystemProgram.programId })
        .rpc();
      const cfg: any = await A.config.fetch(configPda);
      assert.ok(cfg.arbiter.equals(arbiter.publicKey));
      assert.equal(cfg.feeBps, FEE_BPS);
      assert.equal(cfg.disputePeriod.toNumber(), DISPUTE_PERIOD);
    });

    it("não reinicializa a config", async () => {
      await expectError(
        P.initializeConfig(...configArgs({ arbiter: attacker.publicKey }))
          .accountsPartial({ config: configPda, admin: admin.publicKey, program: program.programId, programData, systemProgram: SystemProgram.programId })
          .rpc()
      );
      const cfg: any = await A.config.fetch(configPda);
      assert.ok(cfg.arbiter.equals(arbiter.publicKey));
    });

    it("update_config: só o admin, taxa ≤ 10%, prazo de disputa e chaves válidos", async () => {
      await expectError(updateConfig({}, attacker), "ConstraintHasOne");
      await expectError(updateConfig({ fee: 1001 }), "FeeTooHigh");
      await expectError(updateConfig({ dispute: 10 }), "InvalidDisputePeriod");
      await expectError(updateConfig({ dispute: 31 * 86400 }), "InvalidDisputePeriod");
      await expectError(updateConfig({ arbiter: PublicKey.default }), "InvalidAuthority");
      await expectError(updateConfig({ treasury: PublicKey.default }), "InvalidAuthority");
      const cfg: any = await A.config.fetch(configPda);
      assert.equal(cfg.feeBps, FEE_BPS);
    });
  });

  // ==================================================================
  describe("fluxo principal", () => {
    it("cria, aceita, envia evidência e aprova: taxa congelada, vault fechado, rent ao pagador", async () => {
      const id = await readyForReview({ amount: 350 });
      const j = await job(id);
      assert.equal(j.feeBps, FEE_BPS);
      assert.ok(j.arbiter.equals(arbiter.publicKey));
      assert.ok(j.rentPayer.equals(client.publicKey));

      const rBefore = await balance(ata(mint, researcher.publicKey));
      const tBefore = await balance(ata(mint, treasury.publicKey));
      const lamportsBefore = await conn.getBalance(client.publicKey);
      await approveTx(id);

      const fee = (units(350) * FEE_BPS) / 10_000;
      assert.equal((await balance(ata(mint, treasury.publicKey))) - tBefore, fee);
      assert.equal((await balance(ata(mint, researcher.publicKey))) - rBefore, units(350) - fee);
      assert.isNull(await conn.getAccountInfo(j.vault), "vault deveria estar fechado");
      assert.equal((await conn.getBalance(client.publicKey)) - lamportsBefore, vaultRent, "rent do vault volta ao pagador");
      assert.ok((await job(id)).status.completed);
    });

    it("PS-01 regression: job sem pesquisador atribuído não pode ser aceito", async () => {
      const id = await createJob({ researcher: null });
      await expectError(accept(id, researcher), "ResearcherNotAssigned");
      await expectError(accept(id, attacker), "ResearcherNotAssigned");
      assert.ok((await job(id)).status.open);

      await P.assignResearcher(researcher.publicKey).accountsPartial({ jobAccount: jobPda(client.publicKey, id), client: client.publicKey }).signers([client]).rpc();
      await expectError(accept(id, attacker), "UnauthorizedResearcher");
      await accept(id, researcher);
      assert.ok((await job(id)).status.inProgress);
    });

    it("só o cliente atribui; cliente não pode ser o pesquisador; sem atribuição depois do aceite", async () => {
      const id = await createJob({ researcher: null });
      const jobAccount = jobPda(client.publicKey, id);
      await expectError(
        P.assignResearcher(attacker.publicKey).accountsPartial({ jobAccount, client: attacker.publicKey }).signers([attacker]).rpc(),
        "ConstraintHasOne"
      );
      await expectError(
        P.assignResearcher(client.publicKey).accountsPartial({ jobAccount, client: client.publicKey }).signers([client]).rpc(),
        "InvalidResearcher"
      );
      await expectError(createJob({ researcher: client.publicKey }), "InvalidResearcher");

      const id2 = await createJob();
      await accept(id2);
      await expectError(
        P.assignResearcher(attacker.publicKey).accountsPartial({ jobAccount: jobPda(client.publicKey, id2), client: client.publicKey }).signers([client]).rpc(),
        "JobNotOpen"
      );
    });

    it("valida parâmetros de criação", async () => {
      await expectError(createJob({ deadlineIn: 30 }), "InvalidDeadline");
      await expectError(createJob({ deadlineIn: 181 * 86400 }), "InvalidDeadline");
      await expectError(createJob({ review: 59 }), "InvalidReviewPeriod");
      await expectError(createJob({ review: 31 * 86400 }), "InvalidReviewPeriod");
      await expectError(createJob({ amount: 0 }), "InvalidAmount");
      await expectError(createJob({ m: otherMint }), "MintNotAllowed");

      const id = newId();
      const now = await chainNow();
      await expectError(
        P.initializeJob(id, usdc(1), new BN(now + 3600), new BN(60), new Array(32).fill(0), researcher.publicKey)
          .accountsPartial({
            config: configPda, jobAccount: jobPda(client.publicKey, id), vault: vaultPda(client.publicKey, id),
            client: client.publicKey, clientTokenAccount: clientAta, mint,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .signers([client])
          .rpc(),
        "InvalidHash"
      );
    });

    it("evidência: só o pesquisador vinculado e hash diferente de zero", async () => {
      const id = await createJob();
      await accept(id);
      await expectError(submit(id, attacker), "UnauthorizedResearcher");
      await expectError(submit(id, researcher, client.publicKey, new Array(32).fill(0)), "InvalidHash");
      assert.ok((await job(id)).status.inProgress);
    });
  });

  // ==================================================================
  describe("ataques na liquidação", () => {
    it("C1 regression: cliente NÃO desvia o pagamento para a própria conta", async () => {
      const id = await readyForReview();
      await expectError(approveTx(id, { researcherTokenAccount: clientAta }));
      assert.ok((await job(id)).status.evidenceSubmitted);
    });

    it("vault de outro job não é aceito (has_one = vault)", async () => {
      const a = await readyForReview();
      const b = await readyForReview();
      const vaultB = (await job(b)).vault;
      await expectError(approveTx(a, { vault: vaultB }), "ConstraintHasOne");
      assert.equal(await balance(vaultB), units(10));
    });

    it("PS-14: rent_payer diferente do registrado é recusado", async () => {
      const id = await readyForReview();
      await expectError(approveTx(id, { rentPayer: attacker.publicKey }), "ConstraintHasOne");
    });

    it("aprovação dupla falha", async () => {
      const id = await readyForReview();
      await approveTx(id);
      await expectError(approveTx(id));
    });

    it("não saca antes do fim da janela; terceiro não saca", async () => {
      const id = await readyForReview({ review: 3600 });
      await expectError(claimTx(id), "ReviewWindowOpen");
      await expectError(claimTx(id, attacker));
      assert.ok((await job(id)).status.evidenceSubmitted);
    });

    it("C2 regression: terceiro não cancela; reembolso só após o prazo; sem cancelamento após o aceite", async () => {
      const id = await createJob({ amount: 20 });
      await expectError(refundTx("cancelJob", id, attacker), "ConstraintHasOne");
      await expectError(refundTx("refundExpired", id), "DeadlineNotExpired");

      const before = await balance(clientAta);
      await refundTx("cancelJob", id);
      assert.equal((await balance(clientAta)) - before, units(20));
      assert.ok((await job(id)).status.cancelled);

      const id2 = await createJob();
      await accept(id2);
      await expectError(refundTx("cancelJob", id2), "CannotRefund");
    });

    it("tokens doados ao vault não travam o fechamento (vão para o pesquisador)", async () => {
      const id = await readyForReview({ amount: 10 });
      const j = await job(id);
      await transfer(conn, client, clientAta, j.vault, client, units(5));
      const before = await balance(ata(mint, researcher.publicKey));
      await approveTx(id);
      const fee = (units(15) * FEE_BPS) / 10_000;
      assert.equal((await balance(ata(mint, researcher.publicKey))) - before, units(15) - fee);
      assert.isNull(await conn.getAccountInfo(j.vault));
    });
  });

  // ==================================================================
  describe("disputa", () => {
    it("só o árbitro do job resolve; bps ≤ 10000; divisão 60/40", async () => {
      const id = await readyForReview({ amount: 100, review: 3600 });
      await openDisputeTx(id);
      const j = await job(id);
      assert.ok(j.status.disputed);
      assert.isAbove(j.disputeDeadline.toNumber(), 0);

      await expectError(resolveTx(id, 5000, attacker), "ConstraintHasOne");
      await expectError(resolveTx(id, 10_001), "InvalidBps");
      await expectError(timeoutTx(id), "DisputeWindowOpen");

      const cBefore = await balance(clientAta);
      const rBefore = await balance(ata(mint, researcher.publicKey));
      await resolveTx(id, 6000);
      const fee = (units(60) * FEE_BPS) / 10_000;
      assert.equal((await balance(clientAta)) - cBefore, units(40));
      assert.equal((await balance(ata(mint, researcher.publicKey))) - rBefore, units(60) - fee);
      assert.ok((await job(id)).status.resolved);
    });

    it("só o cliente contesta", async () => {
      const id = await readyForReview({ review: 3600 });
      await expectError(openDisputeTx(id, attacker), "ConstraintHasOne");
    });

    it("PS-04 regression: taxa e árbitro ficam congelados no job", async () => {
      const id = await readyForReview({ amount: 100, review: 3600 });
      await updateConfig({ fee: 1000, arbiter: attacker.publicKey });
      try {
        await openDisputeTx(id);
        await expectError(resolveTx(id, 10_000, attacker), "ConstraintHasOne"); // novo árbitro não manda no job antigo
        const rBefore = await balance(ata(mint, researcher.publicKey));
        await resolveTx(id, 10_000, arbiter);
        const fee = (units(100) * FEE_BPS) / 10_000; // taxa antiga (2,5%), não 10%
        assert.equal((await balance(ata(mint, researcher.publicKey))) - rBefore, units(100) - fee);

        const novo = await createJob();
        assert.equal((await job(novo)).feeBps, 1000, "jobs novos usam a config nova");
      } finally {
        await updateConfig({});
      }
    });
  });

  // ==================================================================
  describe("PS-37: tesouraria congelada e recuperação de último recurso", () => {
    it("PS-37 regression: trocar a tesouraria da config não redireciona a taxa de jobs existentes", async () => {
      const id = await readyForReview({ amount: 100, review: 3600 });
      assert.ok((await job(id)).treasury.equals(treasury.publicKey), "tesouraria gravada no job");
      await updateConfig({ treasury: attacker.publicKey });
      try {
        const attackerAta = (await getOrCreateAssociatedTokenAccount(conn, admin, mint, attacker.publicKey)).address;
        await expectError(
          approveTx(id, { treasury: attacker.publicKey, treasuryTokenAccount: attackerAta }),
          "ConstraintAddress"
        );
        const before = await balance(ata(mint, treasury.publicKey));
        await approveTx(id);
        assert.equal((await balance(ata(mint, treasury.publicKey))) - before, (units(100) * FEE_BPS) / 10_000);
        assert.equal(await balance(attackerAta), 0, "a nova tesouraria não recebe a taxa do job antigo");

        const novo = await createJob();
        assert.ok((await job(novo)).treasury.equals(attacker.publicKey), "jobs novos usam a tesouraria nova");
      } finally {
        await updateConfig({});
      }
    });

    it("recover_stuck_funds só vale para evidência submetida ou disputa", async () => {
      const open = await createJob();
      await expectError(recoverTx(open), "CannotRecover");
      const working = await createJob();
      await accept(working);
      await expectError(recoverTx(working), "CannotRecover");
    });

    it("ATA do pesquisador congelada trava a aprovação; a recuperação respeita a carência", async () => {
      await withFreezableMint(async (fm) => {
        const id = await readyForReview({ m: fm, amount: 10, review: 3600 });
        await freezeAtaOf(researcher.publicKey, fm);
        await expectError(approveTx(id), "0x11"); // spl-token AccountFrozen
        await expectError(recoverTx(id), "RecoveryGraceNotElapsed");
        assert.ok((await job(id)).status.evidenceSubmitted, "estado intacto");
        assert.equal(await balance(ata(fm, client.publicKey)), units(1_000 - 10));
      });
    });
  });

  // ==================================================================
  describe("agente de IA", () => {
    const policy = () => policyPda(client.publicKey);

    async function agentCreate(amount: number, opts: { review?: number; signer?: Keypair; owner?: PublicKey; pol?: PublicKey } = {}) {
      const owner = opts.owner ?? client.publicKey;
      const id = newId();
      const now = await chainNow();
      await P.initializeJobByAgent(id, usdc(amount), new BN(now + 3600 * 24 * 7), new BN(opts.review ?? AGENT_MIN_REVIEW), sha(`agent-${id}`))
        .accountsPartial({
          config: configPda,
          policy: opts.pol ?? policy(),
          agent: (opts.signer ?? agent).publicKey,
          owner,
          jobAccount: jobPda(owner, id),
          vault: vaultPda(owner, id),
          ownerTokenAccount: ata(mint, owner),
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([opts.signer ?? agent])
        .rpc();
      return id;
    }

    async function setPolicy(active = true, maxJob = 500, maxPeriod = 700, period = 86_400) {
      await P.setAgentPolicy(agent.publicKey, usdc(maxJob), usdc(maxPeriod), new BN(period), active)
        .accountsPartial({ policy: policy(), owner: client.publicKey, systemProgram: SystemProgram.programId })
        .signers([client])
        .rpc();
    }

    before(async () => {
      await setPolicy();
      await approve(conn, client, clientAta, policy(), client, units(10_000));
    });

    it("respeita limite por job e por período", async () => {
      await agentCreate(350); // 350 / 700
      await expectError(agentCreate(501), "ExceedsPerJobLimit");
      await expectError(agentCreate(400), "ExceedsPeriodLimit");
      await agentCreate(300); // 650 / 700
      const p: any = await A.agentPolicy.fetch(policy());
      assert.equal(p.spentInPeriod.toNumber(), units(650));
    });

    it("PS-05 regression: job do agente nasce sem pesquisador, com revisão ≥ 72 h e só humano atribui", async () => {
      await setPolicy(true, 500, 10_000);
      await expectError(agentCreate(10, { review: 3600 }), "InvalidReviewPeriod");

      const id = await agentCreate(10);
      const j = await job(id);
      assert.ok(j.researcher.equals(PublicKey.default));
      assert.ok(j.createdByAgent);
      assert.ok(j.rentPayer.equals(agent.publicKey));
      await expectError(accept(id, researcher), "ResearcherNotAssigned");
      await expectError(
        P.assignResearcher(researcher.publicKey).accountsPartial({ jobAccount: jobPda(client.publicKey, id), client: agent.publicKey }).signers([agent]).rpc(),
        "ConstraintHasOne"
      );
      await P.assignResearcher(researcher.publicKey).accountsPartial({ jobAccount: jobPda(client.publicKey, id), client: client.publicKey }).signers([client]).rpc();
      await accept(id, researcher);
    });

    it("PS-14 regression: rent do vault de job do agente volta para o agente", async () => {
      const id = await agentCreate(10);
      const before = await conn.getBalance(agent.publicKey);
      await refundTx("cancelJob", id);
      assert.equal((await conn.getBalance(agent.publicKey)) - before, vaultRent);
    });

    it("política inativa, agente errado e política de outro dono são recusados", async () => {
      await expectError(agentCreate(10, { signer: attacker }), "ConstraintHasOne");

      // política do atacante não autoriza mexer na conta da empresa
      await P.setAgentPolicy(attacker.publicKey, usdc(500), usdc(500), new BN(86_400), true)
        .accountsPartial({ policy: policyPda(attacker.publicKey), owner: attacker.publicKey, systemProgram: SystemProgram.programId })
        .signers([attacker])
        .rpc();
      await expectError(agentCreate(10, { signer: attacker, pol: policyPda(attacker.publicKey) }), "ConstraintHasOne");

      await setPolicy(false);
      await expectError(agentCreate(10), "PolicyInactive");
      await setPolicy(true, 500, 10_000);
    });

    it("sem allowance (delegate revogado) o agente não move fundos", async () => {
      await revoke(conn, client, clientAta, client);
      try {
        await expectError(agentCreate(10));
      } finally {
        await approve(conn, client, clientAta, policy(), client, units(10_000));
      }
    });
  });

  // ==================================================================
  describe("dependentes do relógio (surfnet_timeTravel)", () => {
    beforeEach(function () {
      if (!canTimeTravel) this.skip();
    });

    it("liberação otimista: pesquisador saca após a janela", async () => {
      const id = await readyForReview({ review: 60 });
      await timeTravel(61);
      await claimTx(id);
      assert.ok((await job(id)).status.completed);
    });

    it("não contesta depois da janela", async () => {
      const id = await readyForReview({ review: 60 });
      await timeTravel(61);
      await expectError(openDisputeTx(id), "ReviewWindowClosed");
    });

    it("PS-02 regression: árbitro inativo → qualquer um encerra com 50/50 após o prazo", async () => {
      const id = await readyForReview({ amount: 100, review: 3600 });
      await openDisputeTx(id);
      await expectError(timeoutTx(id), "DisputeWindowOpen");
      await timeTravel(DISPUTE_PERIOD + 1);

      const cBefore = await balance(clientAta);
      const rBefore = await balance(ata(mint, researcher.publicKey));
      await timeoutTx(id); // assinado só pelo fee payer, sem papel no job
      const fee = (units(50) * FEE_BPS) / 10_000;
      assert.equal((await balance(clientAta)) - cBefore, units(50));
      assert.equal((await balance(ata(mint, researcher.publicKey))) - rBefore, units(50) - fee);
      assert.ok((await job(id)).status.resolved);
    });

    it("após o prazo: reembolso funciona, aceite e evidência são recusados", async () => {
      const open = await createJob({ deadlineIn: 600 });
      const working = await createJob({ deadlineIn: 600 });
      await accept(working);
      await timeTravel(601);

      await expectError(accept(open), "DeadlineExpired");
      await expectError(submit(working), "DeadlineExpired");
      const before = await balance(clientAta);
      await refundTx("refundExpired", working);
      assert.equal((await balance(clientAta)) - before, units(10));
      assert.ok((await job(working)).status.refunded);
    });

    it("PS-37: após a carência qualquer um devolve ao cliente o saldo preso por ATA congelada", async () => {
      await withFreezableMint(async (fm) => {
        const id = await readyForReview({ m: fm, amount: 10, review: 60 });
        await freezeAtaOf(researcher.publicKey, fm);
        await timeTravel(61);
        await expectError(claimTx(id), "0x11");
        await expectError(recoverTx(id), "RecoveryGraceNotElapsed");
        await timeTravel(30 * 86_400 + 1);

        // o destino é sempre a ATA do cliente do job (INV-5)
        const attackerAta = (await getOrCreateAssociatedTokenAccount(conn, admin, fm, attacker.publicKey)).address;
        await expectError(recoverTx(id, { clientTokenAccount: attackerAta }), "ConstraintTokenOwner");

        const cAta = ata(fm, client.publicKey);
        const before = await balance(cAta);
        const vault = (await job(id)).vault;
        await recoverTx(id);
        assert.equal((await balance(cAta)) - before, units(10));
        assert.isNull(await conn.getAccountInfo(vault), "vault fechado");
        assert.ok((await job(id)).status.refunded);
      });
    });

    it("PS-37: disputa travada pelo timeout 50/50 (ATA congelada) também tem saída após a carência", async () => {
      await withFreezableMint(async (fm) => {
        const id = await readyForReview({ m: fm, amount: 10, review: 3600 });
        await openDisputeTx(id);
        await freezeAtaOf(researcher.publicKey, fm);
        await timeTravel(DISPUTE_PERIOD + 1);
        await expectError(timeoutTx(id), "0x11");
        await expectError(recoverTx(id), "RecoveryGraceNotElapsed");
        await timeTravel(30 * 86_400 + 1);
        const cAta = ata(fm, client.publicKey);
        const before = await balance(cAta);
        await recoverTx(id);
        assert.equal((await balance(cAta)) - before, units(10));
        assert.ok((await job(id)).status.refunded);
      });
    });

    it("política do agente reinicia o gasto quando o período vira", async () => {
      const pol = policyPda(client.publicKey);
      await P.setAgentPolicy(agent.publicKey, usdc(100), usdc(100), new BN(3600), true)
        .accountsPartial({ policy: pol, owner: client.publicKey, systemProgram: SystemProgram.programId })
        .signers([client])
        .rpc();
      const create = async () => {
        const id = newId();
        const now = await chainNow();
        await P.initializeJobByAgent(id, usdc(100), new BN(now + 86_400 * 7), new BN(AGENT_MIN_REVIEW), sha(id))
          .accountsPartial({
            config: configPda, policy: pol, agent: agent.publicKey, owner: client.publicKey,
            jobAccount: jobPda(client.publicKey, id), vault: vaultPda(client.publicKey, id),
            ownerTokenAccount: clientAta, mint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .signers([agent])
          .rpc();
      };
      await timeTravel(3601); // garante período novo
      await create();
      await expectError(create(), "ExceedsPeriodLimit");
      await timeTravel(3601);
      await create();
    });
  });
});
