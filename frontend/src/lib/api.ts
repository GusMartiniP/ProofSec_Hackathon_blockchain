import bs58 from "bs58";
import { API_URL, HAS_API } from "./config";
import { verifyKeyBinding } from "./keybinding";

/** Metadados off-chain de um job (DynamoDB). A chain continua sendo a fonte da verdade. */
export interface JobMeta {
  jobId: string;
  title: string;
  scopeDocument?: string; // JSON canônico (o SHA-256 dele é o scope_hash on-chain)
  scopeHash: string;
  budgetUsdc: string;
  amountBase: number;
  deadlineDays: number;
  reviewHours: string;
  clientWallet: string;
  assignedResearcher?: string;
  researcherWallet?: string;
  status: "DRAFT" | "NEEDS_HUMAN" | "AUTO_APPROVED" | "ONCHAIN";
  onchainStatus?: string;
  jobPda?: string;
  createdByAgent?: boolean;
  severity?: string;
  agentDecision?: string;
  createdAt?: number;
  /** Candidaturas (só o cliente do job recebe, via /jobs/mine). */
  applicants?: string[];
}

const TOKEN_KEY = "proofsec.session";
let session: { token: string; wallet: string; expiresAt: number } | null = null;

function loadSession() {
  if (session) return session;
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (raw) session = JSON.parse(raw);
  } catch {
    /* storage indisponível: segue só em memória */
  }
  return session;
}

export function currentSession(wallet?: string | null) {
  const s = loadSession();
  if (!s || s.expiresAt * 1000 < Date.now() || (wallet && s.wallet !== wallet)) return null;
  return s;
}

export function logout() {
  session = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  if (!HAS_API) throw new Error("API não configurada (NEXT_PUBLIC_API_URL)");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.auth) {
    const s = loadSession();
    if (!s) throw new Error("faça login com a carteira primeiro");
    headers.Authorization = `Bearer ${s.token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

/**
 * Sign-In With Solana: assina uma mensagem (não é transação, não custa nada).
 * A mensagem segue o formato SIWS com o domínio desta página; o backend só aceita
 * domínios da lista dele, e carteiras como a Phantom recusam se o domínio da
 * mensagem não for o da página aberta.
 */
export async function login(wallet: string, signMessage: (m: Uint8Array) => Promise<Uint8Array>) {
  const { message } = await request<{ message: string }>("/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ wallet, domain: window.location.host, uri: window.location.origin }),
  });
  const signature = await signMessage(new TextEncoder().encode(message));
  const out = await request<{ token: string; expiresAt: number }>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ wallet, message, signature: bs58.encode(signature) }),
  });
  session = { token: out.token, wallet, expiresAt: out.expiresAt };
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
  return session;
}

export const api = {
  listJobs: (wallet?: string) =>
    request<{ jobs: JobMeta[] }>(`/jobs${wallet ? `?wallet=${wallet}` : ""}`).then((r) => r.jobs),

  myJobs: () => request<{ jobs: JobMeta[] }>("/jobs/mine", { auth: true }).then((r) => r.jobs),

  createDraft: (input: {
    title: string;
    scope: string;
    budgetUsdc: number;
    deadlineDays: number;
    reviewHours: number;
    researcher?: string;
  }) => request<{ job: JobMeta }>("/jobs", { method: "POST", auth: true, body: JSON.stringify(input) }).then((r) => r.job),

  /** Candidatura a um job aberto (a atribuição continua on-chain, feita pelo cliente). */
  apply: (jobId: string) =>
    request<{ applied: boolean }>(`/jobs/${encodeURIComponent(jobId)}/apply`, { method: "POST", auth: true, body: "{}" }),

  syncJob: (jobId: string, jobPda?: string) =>
    request<{ job: JobMeta }>(`/jobs/${encodeURIComponent(jobId)}/sync`, { method: "POST", body: JSON.stringify({ jobPda }) }).then(
      (r) => r.job
    ),

  uploadUrl: (jobId: string, sha256Hex: string, sizeBytes: number) =>
    request<{ uploadUrl: string; headers: Record<string, string>; s3Key: string }>("/evidence/upload-url", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ jobId, sha256Hex, sizeBytes }),
    }),

  downloadUrl: (jobId: string) =>
    request<{ downloadUrl: string; evidenceSha256: string }>("/evidence/download-url", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ jobId }),
    }),

  /** `signature` = assinatura da carteira sobre `keyBindingMessage(wallet, publicKey)` (PS-38). */
  putEncryptionKey: (publicKey: string, signature: string) =>
    request("/users/me/encryption-key", { method: "PUT", auth: true, body: JSON.stringify({ publicKey, signature }) }),

  /** Só devolve a chave se a carteira provou ser dona dela; o backend sozinho não vale como fonte. */
  getEncryptionKey: (wallet: string) =>
    request<{ publicKey: string; signature?: string | null }>(`/users/${wallet}/encryption-key`).then((r) => {
      if (!verifyKeyBinding(wallet, r.publicKey, r.signature)) {
        throw new Error("a chave de criptografia desta carteira não tem prova de posse válida (assinatura ausente ou inválida)");
      }
      return r.publicKey;
    }),

  agentPropose: (input: { severity: number; target_asset: string; type: string }) =>
    request<{ job: JobMeta }>("/agent/propose", { method: "POST", auth: true, body: JSON.stringify(input) }).then(
      (r) => r.job
    ),
};
