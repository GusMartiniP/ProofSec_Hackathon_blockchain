import bs58 from "bs58";
import { API_URL, HAS_API } from "./config";
import { verifyKeyBinding } from "./keybinding";

/** Off-chain job metadata (DynamoDB). The chain remains the source of truth. */
export interface JobMeta {
  jobId: string;
  title: string;
  scopeDocument?: string; // canonical JSON (its SHA-256 is the on-chain scope_hash)
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
  /** Applications (only the job's client receives them, via /jobs/mine). */
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
    /* storage unavailable: keep in memory only */
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
  if (!HAS_API) throw new Error("API not configured (NEXT_PUBLIC_API_URL)");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.auth) {
    const s = loadSession();
    if (!s) throw new Error("sign in with your wallet first");
    headers.Authorization = `Bearer ${s.token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

/**
 * Sign-In With Solana: signs a message (not a transaction, costs nothing).
 * The message follows the SIWS format with this page's domain; the backend only accepts
 * domains from its own list, and wallets such as Phantom refuse if the message's domain
 * is not the open page's.
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

  /** Application to an open job (assignment remains on-chain, done by the client). */
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

  /** `signature` = wallet signature over `keyBindingMessage(wallet, publicKey)` (PS-38). */
  putEncryptionKey: (publicKey: string, signature: string) =>
    request("/users/me/encryption-key", { method: "PUT", auth: true, body: JSON.stringify({ publicKey, signature }) }),

  /** Only returns the key if the wallet proved it owns it; the backend alone is not a trusted source. */
  getEncryptionKey: (wallet: string) =>
    request<{ publicKey: string; signature?: string | null }>(`/users/${wallet}/encryption-key`).then((r) => {
      if (!verifyKeyBinding(wallet, r.publicKey, r.signature)) {
        throw new Error("this wallet's encryption key has no valid proof of possession (missing or invalid signature)");
      }
      return r.publicKey;
    }),

  agentPropose: (input: { severity: number; target_asset: string; type: string }) =>
    request<{ job: JobMeta }>("/agent/propose", { method: "POST", auth: true, body: JSON.stringify(input) }).then(
      (r) => r.job
    ),
};
