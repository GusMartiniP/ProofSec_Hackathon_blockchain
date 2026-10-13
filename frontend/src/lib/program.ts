import { AnchorProvider, BN, Program, type Idl } from "@anchor-lang/core";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import idl from "@/idl/proofsec.json";
import { PROGRAM_ID, USDC_DECIMALS } from "./config";
import { bytesToHex, hexToBytes32 } from "./encoding";

export type JobStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "EVIDENCE_SUBMITTED"
  | "DISPUTED"
  | "COMPLETED"
  | "RESOLVED"
  | "REFUNDED"
  | "CANCELLED";

export interface OnchainJob {
  pda: string;
  jobId: string;
  client: string;
  researcher: string | null;
  mint: string;
  vault: string;
  amount: number; // unidades base
  deadline: number;
  reviewPeriod: number;
  reviewDeadline: number;
  scopeHash: string;
  evidenceSha256: string | null;
  status: JobStatus;
  createdByAgent: boolean;
  /** Termos congelados na criação (PS-04): mudanças na config não afetam este job. */
  arbiter: string;
  feeBps: number;
  disputePeriod: number;
  disputeDeadline: number;
  /** Quem pagou o rent e recebe de volta no fechamento (PS-14). */
  rentPayer: string;
  /** Tesouraria congelada na criação (PS-37): a taxa só vai para a ATA dela. */
  treasury: string;
}

export interface PlatformConfig {
  admin: string;
  arbiter: string;
  treasury: string;
  feeBps: number;
  allowedMint: string;
  disputePeriod: number;
}

export interface AgentPolicy {
  owner: string;
  agent: string;
  maxPerJob: number;
  maxPerPeriod: number;
  periodSeconds: number;
  periodStart: number;
  spentInPeriod: number;
  active: boolean;
}

const STATUS_MAP: Record<string, JobStatus> = {
  open: "OPEN",
  inProgress: "IN_PROGRESS",
  evidenceSubmitted: "EVIDENCE_SUBMITTED",
  disputed: "DISPUTED",
  completed: "COMPLETED",
  resolved: "RESOLVED",
  refunded: "REFUNDED",
  cancelled: "CANCELLED",
};

const DEFAULT_KEY = PublicKey.default.toBase58();
const ZERO_HASH = "0".repeat(64);
const num = (v: any) => (BN.isBN(v) ? Number(v.toString()) : Number(v));
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// ------------------------------------------------------------------ PDAs
export const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
export const jobPda = (client: PublicKey, jobId: string) =>
  PublicKey.findProgramAddressSync([Buffer.from("job"), client.toBuffer(), Buffer.from(jobId)], PROGRAM_ID)[0];
export const vaultPda = (client: PublicKey, jobId: string) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), client.toBuffer(), Buffer.from(jobId)], PROGRAM_ID)[0];
export const policyPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("policy"), owner.toBuffer()], PROGRAM_ID)[0];
/** Conta ProgramData do programa (guarda a upgrade authority, usada no PS-03). */
export const programDataPda = () => PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];

// ------------------------------------------------------------------ Programa
export function getProgram(connection: Connection, wallet: AnchorWallet): Program<Idl> {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program({ ...(idl as Idl), address: PROGRAM_ID.toBase58() } as Idl, provider);
}

/** Programa somente leitura (sem carteira conectada). */
export function getReadonlyProgram(connection: Connection): Program<Idl> {
  const dummy = {
    publicKey: PublicKey.default,
    signTransaction: async () => {
      throw new Error("wallet not connected");
    },
    signAllTransactions: async () => {
      throw new Error("wallet not connected");
    },
  } as unknown as AnchorWallet;
  return getProgram(connection, dummy);
}

function parseJob(pda: PublicKey, a: any): OnchainJob {
  const researcher = (a.researcher as PublicKey).toBase58();
  const evidence = bytesToHex(a.evidenceSha256);
  return {
    pda: pda.toBase58(),
    jobId: a.jobId,
    client: a.client.toBase58(),
    researcher: researcher === DEFAULT_KEY ? null : researcher,
    mint: a.mint.toBase58(),
    vault: a.vault.toBase58(),
    amount: num(a.amount),
    deadline: num(a.deadline),
    reviewPeriod: num(a.reviewPeriod),
    reviewDeadline: num(a.reviewDeadline),
    scopeHash: bytesToHex(a.scopeHash),
    evidenceSha256: evidence === ZERO_HASH ? null : evidence,
    status: STATUS_MAP[Object.keys(a.status)[0]] ?? "OPEN",
    createdByAgent: Boolean(a.createdByAgent),
    arbiter: a.arbiter.toBase58(),
    feeBps: Number(a.feeBps),
    disputePeriod: num(a.disputePeriod),
    disputeDeadline: num(a.disputeDeadline),
    rentPayer: a.rentPayer.toBase58(),
    treasury: a.treasury.toBase58(),
  };
}

export async function fetchAllJobs(program: Program<Idl>): Promise<OnchainJob[]> {
  const all = await (program.account as any).jobAccount.all();
  return all.map((x: any) => parseJob(x.publicKey, x.account));
}

export async function fetchConfig(program: Program<Idl>): Promise<PlatformConfig | null> {
  const c: any = await (program.account as any).config.fetchNullable(configPda());
  if (!c) return null;
  return {
    admin: c.admin.toBase58(),
    arbiter: c.arbiter.toBase58(),
    treasury: c.treasury.toBase58(),
    feeBps: Number(c.feeBps),
    allowedMint: c.allowedMint.toBase58(),
    disputePeriod: num(c.disputePeriod),
  };
}

export async function fetchPolicy(program: Program<Idl>, owner: PublicKey): Promise<AgentPolicy | null> {
  const p: any = await (program.account as any).agentPolicy.fetchNullable(policyPda(owner));
  if (!p) return null;
  return {
    owner: p.owner.toBase58(),
    agent: p.agent.toBase58(),
    maxPerJob: num(p.maxPerJob),
    maxPerPeriod: num(p.maxPerPeriod),
    periodSeconds: num(p.periodSeconds),
    periodStart: num(p.periodStart),
    spentInPeriod: num(p.spentInPeriod),
    active: Boolean(p.active),
  };
}

// ------------------------------------------------------------------ Instruções
const m = (program: Program<Idl>) => program.methods as any;
const me = (program: Program<Idl>) => program.provider.publicKey as PublicKey;

/**
 * O programa não cria ATAs (sem init_if_needed nas liquidações). Quem assina a
 * liquidação cria, de forma idempotente, as contas de destino que faltarem.
 * Os destinos são sempre ATAs derivadas das carteiras on-chain (INV-5).
 */
function ensureAtas(payer: PublicKey, mint: PublicKey, owners: PublicKey[]): TransactionInstruction[] {
  const seen = new Set<string>();
  return owners
    .filter((o) => {
      const k = o.toBase58();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((owner) =>
      createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(mint, owner), owner, mint)
    );
}

export async function initializeConfig(
  program: Program<Idl>,
  args: { arbiter: PublicKey; treasury: PublicKey; feeBps: number; allowedMint: PublicKey; disputePeriod: number }
) {
  return m(program)
    .initializeConfig(args.arbiter, args.treasury, args.feeBps, args.allowedMint, new BN(args.disputePeriod))
    .accountsPartial({
      config: configPda(),
      admin: me(program),
      program: PROGRAM_ID,
      programData: programDataPda(),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function createJobOnchain(
  program: Program<Idl>,
  args: {
    jobId: string;
    amountBase: number;
    deadline: number;
    reviewPeriod: number;
    scopeHashHex: string;
    researcher?: string | null;
    mint: PublicKey;
  }
) {
  const client = me(program);
  return m(program)
    .initializeJob(
      args.jobId,
      new BN(args.amountBase),
      new BN(args.deadline),
      new BN(args.reviewPeriod),
      hexToBytes32(args.scopeHashHex),
      args.researcher ? new PublicKey(args.researcher) : PublicKey.default
    )
    .accountsPartial({
      config: configPda(),
      jobAccount: jobPda(client, args.jobId),
      vault: vaultPda(client, args.jobId),
      client,
      clientTokenAccount: getAssociatedTokenAddressSync(args.mint, client),
      mint: args.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Atribui (ou remove, com `null`) o pesquisador. Só o cliente, só com o job aberto. */
export async function assignResearcher(program: Program<Idl>, job: OnchainJob, researcher: string | null) {
  return m(program)
    .assignResearcher(researcher ? new PublicKey(researcher) : PublicKey.default)
    .accountsPartial({ jobAccount: new PublicKey(job.pda), client: me(program) })
    .rpc();
}

export async function acceptJob(program: Program<Idl>, job: OnchainJob) {
  return m(program)
    .acceptJob()
    .accountsPartial({ jobAccount: new PublicKey(job.pda), researcher: me(program) })
    .rpc();
}

export async function submitEvidence(program: Program<Idl>, job: OnchainJob, shaHex: string) {
  return m(program)
    .submitEvidence(hexToBytes32(shaHex))
    .accountsPartial({ jobAccount: new PublicKey(job.pda), researcher: me(program) })
    .rpc();
}

/**
 * Contas comuns das liquidações. O árbitro, o rent_payer e a tesouraria vêm do próprio job
 * (PS-04, PS-14, PS-37): trocar a tesouraria da config não afeta jobs existentes.
 * `config` só é usado para a conta `config` das instruções.
 */
function settleBase(job: OnchainJob, _config: PlatformConfig) {
  if (!job.researcher) throw new Error("job has no researcher");
  const mint = new PublicKey(job.mint);
  const researcher = new PublicKey(job.researcher);
  const treasury = new PublicKey(job.treasury);
  return {
    mint,
    researcher,
    treasury,
    accounts: {
      config: configPda(),
      jobAccount: new PublicKey(job.pda),
      vault: new PublicKey(job.vault),
      mint,
      researcher,
      researcherTokenAccount: getAssociatedTokenAddressSync(mint, researcher),
      treasury,
      treasuryTokenAccount: getAssociatedTokenAddressSync(mint, treasury),
      rentPayer: new PublicKey(job.rentPayer),
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  };
}

export async function approveAndRelease(program: Program<Idl>, job: OnchainJob, config: PlatformConfig) {
  const { mint, researcher, treasury, accounts } = settleBase(job, config);
  return m(program)
    .approveAndRelease()
    .accountsPartial({ ...accounts, client: me(program) })
    .preInstructions(ensureAtas(me(program), mint, [researcher, treasury]))
    .rpc();
}

export async function claimAfterReview(program: Program<Idl>, job: OnchainJob, config: PlatformConfig) {
  const { mint, researcher, treasury, accounts } = settleBase(job, config);
  return m(program)
    .claimAfterReview()
    .accountsPartial(accounts)
    .preInstructions(ensureAtas(me(program), mint, [researcher, treasury]))
    .rpc();
}

export async function openDispute(program: Program<Idl>, job: OnchainJob) {
  return m(program)
    .openDispute()
    .accountsPartial({ jobAccount: new PublicKey(job.pda), client: me(program) })
    .rpc();
}

function disputeAccounts(job: OnchainJob, config: PlatformConfig) {
  const base = settleBase(job, config);
  const client = new PublicKey(job.client);
  return {
    ...base,
    client,
    accounts: { ...base.accounts, client, clientTokenAccount: getAssociatedTokenAddressSync(base.mint, client) },
  };
}

/** Só o árbitro congelado no job (job.arbiter) consegue assinar. */
export async function resolveDispute(program: Program<Idl>, job: OnchainJob, config: PlatformConfig, researcherBps: number) {
  const { mint, client, researcher, treasury, accounts } = disputeAccounts(job, config);
  return m(program)
    .resolveDispute(researcherBps)
    .accountsPartial({ ...accounts, arbiter: me(program) })
    .preInstructions(ensureAtas(me(program), mint, [client, researcher, treasury]))
    .rpc();
}

/** Depois do prazo do árbitro, qualquer pessoa aplica a divisão padrão 50/50 (PS-02). */
export async function resolveDisputeTimeout(program: Program<Idl>, job: OnchainJob, config: PlatformConfig) {
  const { mint, client, researcher, treasury, accounts } = disputeAccounts(job, config);
  return m(program)
    .resolveDisputeTimeout()
    .accountsPartial(accounts)
    .preInstructions(ensureAtas(me(program), mint, [client, researcher, treasury]))
    .rpc();
}

function refundAccounts(job: OnchainJob) {
  const mint = new PublicKey(job.mint);
  const client = new PublicKey(job.client);
  return {
    mint,
    client,
    accounts: {
      jobAccount: new PublicKey(job.pda),
      vault: new PublicKey(job.vault),
      mint,
      client,
      clientTokenAccount: getAssociatedTokenAddressSync(mint, client),
      rentPayer: new PublicKey(job.rentPayer),
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  };
}

export async function refundExpired(program: Program<Idl>, job: OnchainJob) {
  const { mint, client, accounts } = refundAccounts(job);
  return m(program).refundExpired().accountsPartial(accounts).preInstructions(ensureAtas(me(program), mint, [client])).rpc();
}

/**
 * Último recurso (PS-37 / INV-4): depois da carência, qualquer pessoa devolve o saldo ao cliente
 * quando as contas de token da liquidação ficaram inutilizáveis. O destino é a ATA do cliente.
 */
export async function recoverStuckFunds(program: Program<Idl>, job: OnchainJob) {
  const { mint, client, accounts } = refundAccounts(job);
  const { client: _signer, ...rest } = accounts; // sem signer: `client` é só a conta do cliente
  return m(program)
    .recoverStuckFunds()
    .accountsPartial({ ...rest, client })
    .preInstructions(ensureAtas(me(program), mint, [client]))
    .rpc();
}

export async function cancelJob(program: Program<Idl>, job: OnchainJob) {
  const { mint, client, accounts } = refundAccounts(job);
  return m(program).cancelJob().accountsPartial(accounts).preInstructions(ensureAtas(me(program), mint, [client])).rpc();
}

/**
 * Configura a política do agente E aprova o PDA da política como delegate da
 * conta de USDC da empresa (allowance), numa única transação.
 * Atenção (PS-15): o SPL Token aceita um só delegate por conta; este approve
 * substitui qualquer delegate anterior.
 */
export async function setAgentPolicy(
  program: Program<Idl>,
  args: {
    agent: PublicKey;
    maxPerJobBase: number;
    maxPerPeriodBase: number;
    periodSeconds: number;
    active: boolean;
    allowanceBase: number;
    mint: PublicKey;
  }
) {
  const owner = me(program);
  const policy = policyPda(owner);
  const ata = getAssociatedTokenAddressSync(args.mint, owner);
  const approveIx: TransactionInstruction = createApproveCheckedInstruction(
    ata,
    args.mint,
    policy,
    owner,
    BigInt(args.allowanceBase),
    USDC_DECIMALS
  );
  return m(program)
    .setAgentPolicy(
      args.agent,
      new BN(args.maxPerJobBase),
      new BN(args.maxPerPeriodBase),
      new BN(args.periodSeconds),
      args.active
    )
    .accountsPartial({ policy, owner, systemProgram: SystemProgram.programId })
    .postInstructions([approveIx])
    .rpc();
}

export function friendlyError(e: unknown): string {
  const msg = (e as any)?.error?.errorMessage || (e as any)?.message || String(e);
  if (/User rejected/i.test(msg)) return "Transaction cancelled in the wallet.";
  if (/insufficient funds|0x1\b/i.test(msg)) return "Insufficient balance (SOL for fees or USDC).";
  if (/AccountNotInitialized|could not find account/i.test(msg)) return "Account not found on-chain (USDC/ATA or config).";
  if (/Blockhash not found|block height exceeded/i.test(msg)) return "The transaction expired before confirming. Please sign again.";
  return msg.length > 220 ? msg.slice(0, 220) + "…" : msg;
}

/** Falha de transporte do RPC (vale trocar para o secundário). Erros do programa não entram. */
export function isRpcTransportError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e);
  return /failed to fetch|fetch failed|networkerror|network request failed|429|too many requests|502|503|504|timed? ?out|ECONN/i.test(msg);
}
