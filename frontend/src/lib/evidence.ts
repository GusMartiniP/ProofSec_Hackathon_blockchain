/**
 * Criptografia ponta a ponta dos relatórios.
 *
 * - Cada carteira deriva um par X25519 a partir de uma ASSINATURA de uma mensagem
 *   fixa (assinaturas Ed25519 são determinísticas → mesma chave sempre). A
 *   chave privada nunca sai do navegador; só a pública vai para o backend.
 * - O relatório é cifrado com uma chave aleatória (XSalsa20-Poly1305) e essa
 *   chave é "embrulhada" para cada destinatário (cliente, pesquisador, árbitro).
 * - O SHA-256 on-chain é do envelope cifrado (exatamente o que fica no S3).
 *   Dentro do envelope vai também o SHA-256 do arquivo original.
 *
 * Chave v2 (ADR-017, PS-06): a mensagem segue o formato Sign-In With Solana com o
 * domínio e a origem da página. Um site de phishing que copie a mensagem precisa
 * colocar o domínio verdadeiro nela, e carteiras como a Phantom avisam/recusam
 * quando o domínio da mensagem não é o da página. Consequência: a chave é por
 * origem (localhost e produção geram chaves diferentes).
 * A chave v1 (mensagem sem domínio) só é usada para abrir envelopes antigos.
 */
import nacl from "tweetnacl";
import { CLUSTER } from "./config";
import { LEGACY_V1_MESSAGE, keyMessageV2, keyMessageV3 } from "./keymessages";
import { base64ToBytes, bytesToBase64, sha256, sha256Hex, toArrayBuffer } from "./encoding";

export type KeyVersion = 1 | 2 | 3;
export const CURRENT_KEY_VERSION: KeyVersion = 3;
/** Versões legadas continuam derivando a chave, só para abrir relatórios já cifrados com elas. */
export const KEY_VERSIONS_NEWEST_FIRST: KeyVersion[] = [3, 2, 1];

export interface EncryptionKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyB64: string;
  version: KeyVersion;
}

const cache = new Map<string, EncryptionKeypair>();

export async function deriveEncryptionKeypair(
  wallet: string,
  signMessage: (m: Uint8Array) => Promise<Uint8Array>,
  version: KeyVersion = CURRENT_KEY_VERSION
): Promise<EncryptionKeypair> {
  const origin = window.location.origin;
  const cacheKey = `${version}|${wallet}|${origin}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const host = window.location.host;
  const message =
    version === 3 ? keyMessageV3(wallet, host, origin, CLUSTER) : version === 2 ? keyMessageV2(wallet, host, origin, CLUSTER) : LEGACY_V1_MESSAGE;
  const signature = await signMessage(new TextEncoder().encode(message));
  const seed = await sha256(signature);
  const kp = nacl.box.keyPair.fromSecretKey(seed);
  const out = { publicKey: kp.publicKey, secretKey: kp.secretKey, publicKeyB64: bytesToBase64(kp.publicKey), version };
  cache.set(cacheKey, out);
  return out;
}

interface Recipient {
  label: string;
  recipientPub: string;
  ephemeralPub: string;
  nonce: string;
  wrappedKey: string;
}

interface Envelope {
  v: 1;
  alg: "xsalsa20poly1305+x25519";
  /** Versão da chave dos destinatários (ausente = v1). */
  keyVersion?: KeyVersion;
  fileName: string;
  mime: string;
  plainSha256: string;
  nonce: string;
  recipients: Recipient[];
  ciphertext: string;
}

export async function encryptReport(
  file: File,
  recipients: { label: string; publicKeyB64: string }[]
): Promise<{ blob: Uint8Array; sha256Hex: string; plainSha256: string }> {
  const plain = new Uint8Array(await file.arrayBuffer());
  const dataKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plain, nonce, dataKey);

  const seen = new Set<string>();
  const wrapped: Recipient[] = [];
  for (const r of recipients) {
    if (!r.publicKeyB64 || seen.has(r.publicKeyB64)) continue;
    seen.add(r.publicKeyB64);
    const eph = nacl.box.keyPair();
    const n = nacl.randomBytes(nacl.box.nonceLength);
    wrapped.push({
      label: r.label,
      recipientPub: r.publicKeyB64,
      ephemeralPub: bytesToBase64(eph.publicKey),
      nonce: bytesToBase64(n),
      wrappedKey: bytesToBase64(nacl.box(dataKey, n, base64ToBytes(r.publicKeyB64), eph.secretKey)),
    });
  }

  const envelope: Envelope = {
    v: 1,
    alg: "xsalsa20poly1305+x25519",
    keyVersion: CURRENT_KEY_VERSION,
    fileName: file.name,
    mime: file.type || "application/octet-stream",
    plainSha256: await sha256Hex(plain),
    nonce: bytesToBase64(nonce),
    recipients: wrapped,
    ciphertext: bytesToBase64(ciphertext),
  };
  const blob = new TextEncoder().encode(JSON.stringify(envelope));
  return { blob, sha256Hex: await sha256Hex(blob), plainSha256: envelope.plainSha256 };
}

function parseEnvelope(blob: Uint8Array): Envelope {
  const env = JSON.parse(new TextDecoder().decode(blob)) as Envelope;
  if (env.v !== 1 || !Array.isArray(env.recipients)) throw new Error("unknown envelope version");
  return env;
}

/** Versão de chave com que o envelope foi cifrado (decide qual chave tentar primeiro). */
export function envelopeKeyVersion(blob: Uint8Array): KeyVersion {
  const v = parseEnvelope(blob).keyVersion;
  return v === 3 ? 3 : v === 2 ? 2 : 1;
}

/** Ordem de tentativa para abrir um envelope: a versão declarada nele e depois as demais. */
export function keyVersionsToTry(blob: Uint8Array): KeyVersion[] {
  const first = envelopeKeyVersion(blob);
  return [first, ...KEY_VERSIONS_NEWEST_FIRST.filter((v) => v !== first)];
}

/** Erro de "não sou destinatário": vale tentar outra versão de chave. */
export const NOT_A_RECIPIENT = "this report was not encrypted to your key";

export async function decryptReport(
  blob: Uint8Array,
  keypair: EncryptionKeypair
): Promise<{ file: Blob; fileName: string; plainSha256: string }> {
  const env = parseEnvelope(blob);
  const mine = env.recipients.find((r) => r.recipientPub === keypair.publicKeyB64);
  if (!mine) throw new Error(NOT_A_RECIPIENT);
  const dataKey = nacl.box.open(
    base64ToBytes(mine.wrappedKey),
    base64ToBytes(mine.nonce),
    base64ToBytes(mine.ephemeralPub),
    keypair.secretKey
  );
  if (!dataKey) throw new Error("failed to unwrap the report key");
  const plain = nacl.secretbox.open(base64ToBytes(env.ciphertext), base64ToBytes(env.nonce), dataKey);
  if (!plain) throw new Error("failed to decrypt the report");
  const plainSha = await sha256Hex(plain);
  if (plainSha !== env.plainSha256) throw new Error("decrypted content hash does not match");
  return { file: new Blob([toArrayBuffer(plain)], { type: env.mime }), fileName: env.fileName, plainSha256: plainSha };
}
