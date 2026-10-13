import type { JobMeta } from "./api";
import { sha256Hex } from "./encoding";

/** O que o usuário digitou no formulário (só no fluxo de rascunho novo). */
export type ExpectedDraft = {
  amountBase?: number;
  deadlineDays?: number;
  reviewHours?: number;
  /** `null` = sem pesquisador. `undefined` = não conferir. */
  researcher?: string | null;
};

/**
 * Confere o que o backend devolveu ANTES de assinar o financiamento on-chain.
 * O backend não pode decidir sozinho quanto, para quem e com que escopo o usuário financia
 * (INV-1/INV-5): um backend comprometido ou com bug poderia trocar valor, prazos ou pré-atribuir
 * um pesquisador. O hash é calculado sobre os mesmos bytes do `scopeDocument` guardado
 * (o backend faz SHA-256 do JSON canônico em UTF-8), sem recanonicalizar no navegador.
 */
export async function assertMetaIntegrity(meta: JobMeta, wallet: string, expected: ExpectedDraft = {}): Promise<void> {
  const fail = (why: string): never => {
    throw new Error(`the backend returned inconsistent data (${why}); nothing was signed`);
  };
  if (!wallet || meta.clientWallet !== wallet) fail("client wallet");
  if (typeof meta.scopeDocument !== "string") fail("missing scope");
  if ((await sha256Hex(new TextEncoder().encode(meta.scopeDocument))) !== meta.scopeHash) fail("scope hash");

  let doc: any;
  try {
    doc = JSON.parse(meta.scopeDocument as string);
  } catch {
    return fail("unreadable scope");
  }
  if (doc?.jobId !== meta.jobId || doc?.client !== wallet) fail("scope belongs to another job or client");

  const amountBase = Number(meta.amountBase);
  if (!Number.isSafeInteger(amountBase) || amountBase <= 0) fail("amount");
  if (Math.round(Number(doc.budgetUsdc) * 1_000_000) !== amountBase) fail("amount differs from scope");
  if (Number(doc.deadlineDays) !== Number(meta.deadlineDays)) fail("deadline differs from scope");
  if (Number(doc.reviewHours) !== Number(meta.reviewHours)) fail("review period differs from scope");

  if (expected.amountBase !== undefined && expected.amountBase !== amountBase) fail("amount differs from what was entered");
  if (expected.deadlineDays !== undefined && expected.deadlineDays !== Number(meta.deadlineDays)) fail("deadline differs from what was entered");
  if (expected.reviewHours !== undefined && expected.reviewHours !== Number(meta.reviewHours)) fail("review period differs from what was entered");
  if (expected.researcher !== undefined && (expected.researcher ?? null) !== (meta.assignedResearcher ?? null)) {
    fail("researcher differs from what was entered");
  }
  // Jobs do agente nascem sem pesquisador (PS-05): quem financia depois também não pode receber um
  if (meta.createdByAgent && meta.assignedResearcher) fail("researcher set on an agent proposal");
}
