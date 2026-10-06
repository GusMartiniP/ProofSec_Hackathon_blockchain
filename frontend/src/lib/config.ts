import { PublicKey, clusterApiUrl } from "@solana/web3.js";
import idl from "@/idl/proofsec.json";

export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER || "devnet";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl("devnet");
/** RPC secundário (PS-13): usado quando o principal falha na leitura. */
export const RPC_URL_FALLBACK = process.env.NEXT_PUBLIC_RPC_URL_FALLBACK || "";
export const RPC_URLS = [RPC_URL, RPC_URL_FALLBACK].filter((u, i, all) => u && all.indexOf(u) === i);

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
export const HAS_API = API_URL.length > 0;

export const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID || (idl as { address: string }).address);
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);
export const USDC_DECIMALS = 6;
/** Carência da recuperação de último recurso (constants.rs: RECOVERY_GRACE_PERIOD, PS-37). */
export const RECOVERY_GRACE_SECONDS = 30 * 24 * 60 * 60;

const clusterParam = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`;
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${clusterParam}`;
export const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}${clusterParam}`;

export const shortKey = (k?: string | null, n = 4) => (k ? `${k.slice(0, n)}…${k.slice(-n)}` : "—");
