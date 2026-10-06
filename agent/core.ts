/**
 * Núcleo do executor do agente ("mãos"), compartilhado pela CLI (executor.ts) e
 * pela Lambda (lambda.ts).
 *
 * Fluxo de uma rodada:
 *   1. escolhe um RPC saudável (principal → secundário; uma troca por rodada, PS-13);
 *   2. busca as propostas AUTO_APPROVED no backend (x-agent-key);
 *   3. para cada proposta: valida, confere a política on-chain e o delegate SPL,
 *      e assina `initialize_job_by_agent`;
 *   4. avisa o backend: `/executed` (abriu ou já existia) ou `/rejected` (recusa
 *      definitiva → a proposta vai para revisão humana). Erros transitórios ficam
 *      para a próxima rodada.
 *
 * Garantias:
 *   - A chave do agente não tem custódia: só move USDC da empresa para escrows
 *     reembolsáveis dela, dentro dos limites da AgentPolicy (INV-2).
 *   - Nunca pré-atribui pesquisador; o contrato nem aceita (PS-05).
 *   - Sem reenvio cego: antes de enviar, verifica se o PDA do job já existe. O PDA
 *     é único por (empresa, job_id), então um reenvio nunca abre dois escrows.
 */
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  TokenInvalidAccountSizeError,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "./idl/proofsec.json" with { type: "json" };

/** Iguais às constantes do programa (constants.rs). */
export const MIN_AGENT_REVIEW_SECONDS = 72 * 3600;
export const MAX_REVIEW_SECONDS = 30 * 86_400;
export const MAX_JOB_DURATION_SECONDS = 180 * 86_400;
const DEADLINE_MARGIN_SECONDS = 3600; // folga para diferença entre o relógio local e o da chain
export const LOW_BALANCE_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
const HTTP_TIMEOUT_MS = 10_000;
const RPC_PROBE_TIMEOUT_MS = 8_000;

export type Proposal = {
  jobId: string;
  title?: string;
  clientWallet: string;
  amountBase: number | string;
  deadlineDays: number | string;
  reviewHours: number | string;
  scopeHash: string;
  /** JSON canônico do escopo; o SHA-256 dos bytes UTF-8 é o `scopeHash` (o backend sempre envia). */
  scopeDocument?: string;
};

export type Logger = (level: "info" | "warning" | "error", event: string, fields?: Record<string, unknown>) => void;

/** Uma linha JSON por evento (mesmo formato do backend). */
export const jsonLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ level, event, ts: Math.floor(Date.now() / 1000), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

export type ExecutorConfig = {
  apiUrl: string;
  apiKey: string;
  rpcUrls: string[];
  programId: PublicKey;
  agent: Keypair;
  /** Mint de USDC; obrigatório só se a config on-chain aceitar qualquer mint. */
  usdcMint?: PublicKey;
  /**
   * Empresas (donos da AgentPolicy) para as quais o executor pode abrir escrow (PS-39). Vazio ou
   * ausente = qualquer empresa cuja política aponte para esta chave, o que deixa terceiros gastarem o
   * SOL do agente (rent dos escrows). A stack da Lambda exige a lista fora do dev.
   */
  allowedOwners?: PublicKey[];
  cluster?: string;
  log?: Logger;
};

export type TokenAccountInfo = { amount: bigint; delegate: PublicKey | null; delegatedAmount: bigint };

/** Pontos de injeção (testes). Os padrões usam as bibliotecas reais. */
export type ExecutorDeps = {
  fetch: typeof fetch;
  makeConnection: (url: string) => Connection;
  makeProgram: (connection: Connection, agent: Keypair, programId: PublicKey) => anchor.Program<any>;
  getTokenAccount: (connection: Connection, address: PublicKey) => Promise<TokenAccountInfo | null>;
  nowSeconds: () => number;
};

/**
 * Só "a conta não existe / não é uma conta de token" vira `null` (recusa definitiva). Qualquer outro
 * erro (RPC, timeout, 429) propaga e a proposta fica para a próxima rodada: tratá-lo como "sem ATA"
 * rebaixaria a proposta para revisão humana por causa de uma falha transitória.
 */
export async function tokenAccountOrNull(read: () => Promise<TokenAccountInfo>): Promise<TokenAccountInfo | null> {
  try {
    return await read();
  } catch (e) {
    if (
      e instanceof TokenAccountNotFoundError ||
      e instanceof TokenInvalidAccountOwnerError ||
      e instanceof TokenInvalidAccountSizeError
    ) {
      return null;
    }
    throw e;
  }
}

const defaultDeps: ExecutorDeps = {
  fetch: (...args) => fetch(...args),
  makeConnection: (url) => new Connection(url, { commitment: "confirmed" }),
  makeProgram: (connection, agent, programId) =>
    new anchor.Program(
      { ...(idl as any), address: programId.toBase58() },
      new anchor.AnchorProvider(connection, new anchor.Wallet(agent), { commitment: "confirmed" }),
    ),
  getTokenAccount: (connection, address) => tokenAccountOrNull(() => getAccount(connection, address, "confirmed")),
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

export type RunSummary = {
  rpc: string;
  proposals: number;
  opened: number;
  synced: number;
  rejected: number;
  deferred: number;
};

/** Erro definitivo: a proposta vai para revisão humana (NEEDS_HUMAN) e não é retentada. */
export class PermanentRejection extends Error {}

/** Erros do programa que não mudam com uma nova tentativa (errors.rs). */
const PERMANENT_PROGRAM_ERRORS = new Set([
  "PolicyInactive",
  "ExceedsPerJobLimit",
  "ExceedsPeriodLimit",
  "InvalidPolicy",
  "MintNotAllowed",
  "InvalidAmount",
  "InvalidDeadline",
  "InvalidReviewPeriod",
  "InvalidJobId",
  "InvalidHash",
  "InvalidTokenAccount",
]);

export function programErrorCode(e: any): string | undefined {
  const code = e?.error?.errorCode?.code ?? e?.errorCode?.code;
  if (typeof code === "string") return code;
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  for (const line of logs) {
    const m = /Error Code: (\w+)/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

export function isPermanent(e: unknown): boolean {
  if (e instanceof PermanentRejection) return true;
  const code = programErrorCode(e);
  return code !== undefined && PERMANENT_PROGRAM_ERRORS.has(code);
}

const JOB_ID_RE = /^[a-z0-9]{1,32}$/;
const HEX32_RE = /^[0-9a-f]{64}$/;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Primeiro RPC que responde (PS-13). Uma troca por rodada; nada é reenviado às cegas. */
export async function pickConnection(
  rpcUrls: string[],
  log: Logger,
  makeConnection: (url: string) => Connection = defaultDeps.makeConnection,
): Promise<{ connection: Connection; url: string }> {
  const urls = rpcUrls.filter(Boolean);
  if (!urls.length) throw new Error("nenhum RPC configurado");
  for (const [i, url] of urls.entries()) {
    const connection = makeConnection(url);
    try {
      await withTimeout(connection.getLatestBlockhash("confirmed"), RPC_PROBE_TIMEOUT_MS, "getLatestBlockhash");
      return { connection, url };
    } catch (e: any) {
      log("warning", "rpc_unavailable", { rpcIndex: i, error: String(e?.message ?? e) });
    }
  }
  throw new Error("todos os RPCs falharam");
}

/** Nunca registrar a URL inteira do RPC: ela pode conter api-key. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

/** Lê "pubkey1,pubkey2" (variável ALLOWED_OWNERS). Vazio = sem restrição; pubkey inválida = erro. */
export function parseOwnerList(raw: string | undefined): PublicKey[] | undefined {
  const items = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items.map((s) => new PublicKey(s)) : undefined;
}

export function validateProposal(p: Proposal): { owner: PublicKey; amount: BN; scopeHash: number[] } {
  if (typeof p.jobId !== "string" || !JOB_ID_RE.test(p.jobId)) throw new PermanentRejection("jobId inválido");
  let owner: PublicKey;
  try {
    owner = new PublicKey(p.clientWallet);
  } catch {
    throw new PermanentRejection("clientWallet inválida");
  }
  const amountNum = Number(p.amountBase);
  if (!Number.isSafeInteger(amountNum) || amountNum <= 0) throw new PermanentRejection("amountBase inválido");
  if (typeof p.scopeHash !== "string" || !HEX32_RE.test(p.scopeHash)) throw new PermanentRejection("scopeHash inválido");
  // Defesa em profundidade: o hash que vai on-chain precisa ser o do escopo que a empresa vê no painel
  if (typeof p.scopeDocument !== "string" || createHash("sha256").update(p.scopeDocument, "utf8").digest("hex") !== p.scopeHash) {
    throw new PermanentRejection("scopeHash não confere com o scopeDocument");
  }
  const days = Number(p.deadlineDays);
  if (!Number.isFinite(days) || days < 1 || days > 180) throw new PermanentRejection("deadlineDays fora de 1..180");
  if (!Number.isFinite(Number(p.reviewHours))) throw new PermanentRejection("reviewHours inválido");
  return { owner, amount: new BN(String(amountNum)), scopeHash: Array.from(Buffer.from(p.scopeHash, "hex")) };
}

/** Prazos dentro das faixas do contrato; jobs do agente têm revisão mínima de 72 h (PS-05). */
export function computeTimes(p: Proposal, nowSeconds: number): { deadline: number; reviewPeriod: number } {
  const duration = Math.min(Math.round(Number(p.deadlineDays) * 86_400), MAX_JOB_DURATION_SECONDS - DEADLINE_MARGIN_SECONDS);
  const review = Math.min(Math.max(Math.round(Number(p.reviewHours) * 3600), MIN_AGENT_REVIEW_SECONDS), MAX_REVIEW_SECONDS);
  return { deadline: nowSeconds + duration, reviewPeriod: review };
}

/** Mesma regra do contrato: o gasto do período zera quando o período vence. */
export function periodAllows(policy: any, amount: BN, nowSeconds: number): boolean {
  const periodEnd = new BN(policy.periodStart.toString()).add(new BN(policy.periodSeconds.toString()));
  const spent = new BN(String(nowSeconds)).gte(periodEnd) ? new BN(0) : new BN(policy.spentInPeriod.toString());
  return spent.add(amount).lte(new BN(policy.maxPerPeriod.toString()));
}

export function createExecutor(cfg: ExecutorConfig, overrides: Partial<ExecutorDeps> = {}) {
  const deps: ExecutorDeps = { ...defaultDeps, ...overrides };
  const log = cfg.log ?? jsonLogger;
  const apiUrl = cfg.apiUrl.replace(/\/$/, "");
  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, cfg.programId)[0];
  const explorer = (sig: string) =>
    `https://explorer.solana.com/tx/${sig}${cfg.cluster && cfg.cluster !== "mainnet" ? `?cluster=${cfg.cluster}` : ""}`;

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await deps.fetch(`${apiUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-agent-key": cfg.apiKey, ...(init.headers ?? {}) },
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${body?.error ?? ""}`.trim());
      return body as T;
    } finally {
      clearTimeout(t);
    }
  }

  async function processProposal(
    program: anchor.Program<any>,
    connection: Connection,
    mint: PublicKey,
    p: Proposal,
  ): Promise<"opened" | "synced"> {
    const { owner, amount, scopeHash } = validateProposal(p);
    if (cfg.allowedOwners?.length && !cfg.allowedOwners.some((o) => o.equals(owner))) {
      throw new PermanentRejection("empresa fora da lista de donos permitidos do executor (PS-39)");
    }
    const config = pda([Buffer.from("config")]);
    const policy = pda([Buffer.from("policy"), owner.toBuffer()]);
    const jobAccount = pda([Buffer.from("job"), owner.toBuffer(), Buffer.from(p.jobId)]);
    const vault = pda([Buffer.from("vault"), owner.toBuffer(), Buffer.from(p.jobId)]);

    // Sem reenvio cego: se o escrow já existe (rodada anterior ou timeout), só sincroniza.
    if (await connection.getAccountInfo(jobAccount, "confirmed")) {
      await api(`/agent/proposals/${p.jobId}/executed`, { method: "POST", body: JSON.stringify({ jobPda: jobAccount.toBase58() }) });
      return "synced";
    }

    // Pré-checagens (a chain checa de novo e é quem decide)
    const pol: any = await (program.account as any).agentPolicy.fetchNullable(policy);
    if (!pol) throw new PermanentRejection("empresa sem AgentPolicy on-chain");
    if (!pol.agent.equals(cfg.agent.publicKey)) throw new PermanentRejection("esta chave não é o agente autorizado na política");
    if (!pol.active) throw new PermanentRejection("política inativa");
    if (amount.gt(new BN(pol.maxPerJob.toString()))) throw new PermanentRejection("acima do limite por job da política");
    const now = deps.nowSeconds();
    if (!periodAllows(pol, amount, now)) throw new PermanentRejection("acima do limite do período da política");

    const ownerTokenAccount = getAssociatedTokenAddressSync(mint, owner);
    const ata = await deps.getTokenAccount(connection, ownerTokenAccount);
    if (!ata) throw new PermanentRejection("empresa sem conta de USDC (ATA)");
    if (!ata.delegate || !ata.delegate.equals(policy)) {
      throw new PermanentRejection("o PDA da política não é o delegate da conta de USDC da empresa (PS-15)");
    }
    const needed = BigInt(amount.toString());
    if (ata.delegatedAmount < needed) throw new PermanentRejection("allowance do delegate insuficiente");
    if (ata.amount < needed) throw new PermanentRejection("saldo de USDC insuficiente");

    const { deadline, reviewPeriod } = computeTimes(p, now);
    const sig: string = await program.methods
      .initializeJobByAgent(p.jobId, amount, new BN(String(deadline)), new BN(String(reviewPeriod)), scopeHash)
      .accountsPartial({
        config,
        policy,
        agent: cfg.agent.publicKey,
        owner,
        jobAccount,
        vault,
        ownerTokenAccount,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log("info", "escrow_opened", { jobId: p.jobId, jobPda: jobAccount.toBase58(), signature: sig, explorer: explorer(sig) });
    await api(`/agent/proposals/${p.jobId}/executed`, {
      method: "POST",
      body: JSON.stringify({ jobPda: jobAccount.toBase58(), signature: sig }),
    });
    return "opened";
  }

  async function resolveMint(program: anchor.Program<any>): Promise<PublicKey> {
    const onchainConfig: any = await (program.account as any).config.fetch(pda([Buffer.from("config")]));
    const allowed: PublicKey = onchainConfig.allowedMint;
    if (!allowed.equals(PublicKey.default)) {
      if (cfg.usdcMint && !cfg.usdcMint.equals(allowed)) throw new Error("USDC_MINT diverge do allowed_mint da config on-chain");
      return allowed;
    }
    if (cfg.usdcMint) return cfg.usdcMint;
    throw new Error("a config on-chain aceita qualquer mint: defina USDC_MINT");
  }

  async function runOnce(): Promise<RunSummary> {
    const { connection, url } = await pickConnection(cfg.rpcUrls, log, deps.makeConnection);
    const program = deps.makeProgram(connection, cfg.agent, cfg.programId);
    const summary: RunSummary = { rpc: hostOf(url), proposals: 0, opened: 0, synced: 0, rejected: 0, deferred: 0 };

    const balance = await connection.getBalance(cfg.agent.publicKey, "confirmed");
    if (balance < LOW_BALANCE_LAMPORTS) {
      log("warning", "agent_low_balance", { agent: cfg.agent.publicKey.toBase58(), lamports: balance });
    }

    const { proposals } = await api<{ proposals: Proposal[] }>("/agent/proposals?status=AUTO_APPROVED");
    summary.proposals = proposals.length;
    if (!proposals.length) return summary;
    const mint = await resolveMint(program);

    for (const p of proposals) {
      try {
        summary[await processProposal(program, connection, mint, p)] += 1;
      } catch (e: any) {
        const code = programErrorCode(e);
        const reason = (code ? `${code}: ` : "") + String(e?.message ?? e).slice(0, 300);
        if (isPermanent(e)) {
          summary.rejected += 1;
          log("warning", "proposal_rejected", { jobId: p?.jobId, reason });
          try {
            await api(`/agent/proposals/${encodeURIComponent(String(p?.jobId))}/rejected`, {
              method: "POST",
              body: JSON.stringify({ reason }),
            });
          } catch (err: any) {
            log("error", "reject_report_failed", { jobId: p?.jobId, error: String(err?.message ?? err) });
          }
        } else {
          // Transitório (RPC, blockhash, rede): tenta de novo na próxima rodada
          summary.deferred += 1;
          log("warning", "proposal_deferred", { jobId: p?.jobId, reason });
        }
      }
    }
    return summary;
  }

  return { runOnce };
}
