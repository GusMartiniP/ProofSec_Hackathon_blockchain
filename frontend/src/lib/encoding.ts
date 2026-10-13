export function bytesToHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Converte hex (64 chars) no formato `[u8; 32]` esperado pelo programa. */
export function hexToBytes32(hex: string): number[] {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("invalid SHA-256 hash (expected 64 hex characters)");
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Cópia em ArrayBuffer "puro" (evita incompatibilidades de tipo com SharedArrayBuffer no TS 5.7+). */
export function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export async function sha256(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(data)));
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return bytesToHex(await sha256(data));
}

/** JSON canônico (chaves ordenadas, sem espaços) — igual ao `canonical_json` do backend. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function usdcToBase(amount: number): number {
  return Math.round(amount * 1_000_000);
}

export function baseToUsdc(base: number | string | bigint): number {
  return Number(base) / 1_000_000;
}

export function randomJobId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
