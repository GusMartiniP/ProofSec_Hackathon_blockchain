"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { FilePlus2 } from "lucide-react";
import type { Idl, Program } from "@anchor-lang/core";
import { useProofSec } from "@/hooks/useProofSec";
import { api, type JobMeta } from "@/lib/api";
import { HAS_API, USDC_MINT } from "@/lib/config";
import { canonicalJson, randomJobId, sha256Hex, usdcToBase } from "@/lib/encoding";
import { assertMetaIntegrity, type ExpectedDraft } from "@/lib/meta";
import { createJobOnchain, jobPda, type PlatformConfig } from "@/lib/program";
import { Button, Card, Field, SectionTitle, TextArea } from "./ui";

export function jobMint(config: PlatformConfig | null): PublicKey {
  return config && config.allowedMint !== PublicKey.default.toBase58() ? new PublicKey(config.allowedMint) : USDC_MINT;
}

/** Cria o escrow on-chain a partir de um rascunho/proposta do backend. */
export async function fundFromMeta(
  program: Program<Idl>,
  meta: JobMeta,
  config: PlatformConfig | null,
  expected?: ExpectedDraft
) {
  // O backend não decide o que o usuário financia: confere antes de pedir a assinatura
  await assertMetaIntegrity(meta, program.provider.publicKey!.toBase58(), expected);
  const now = Math.floor(Date.now() / 1000);
  const sig = await createJobOnchain(program, {
    jobId: meta.jobId,
    amountBase: Number(meta.amountBase),
    deadline: now + Number(meta.deadlineDays) * 86_400,
    reviewPeriod: Math.round(Number(meta.reviewHours) * 3600),
    scopeHashHex: meta.scopeHash,
    researcher: meta.assignedResearcher ?? null,
    mint: jobMint(config),
  });
  const pda = jobPda(program.provider.publicKey!, meta.jobId).toBase58();
  if (HAS_API) await api.syncJob(meta.jobId, pda).catch(() => undefined);
  return sig as string;
}

export function CreateJobPanel() {
  const { program, wallet, config, run, login } = useProofSec();
  const [title, setTitle] = useState("Pentest de API e autenticação");
  const [scope, setScope] = useState("api.empresa.com, app.empresa.com/login");
  const [budget, setBudget] = useState("350");
  const [days, setDays] = useState("7");
  const [reviewHours, setReviewHours] = useState("72");
  const [researcher, setResearcher] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (researcher && !isPubkey(researcher)) {
      return run("Validação", async () => {
        throw new Error("pubkey do pesquisador inválida");
      });
    }
    setBusy(true);
    await run("Criando escrow", async () => {
      if (HAS_API) {
        if (!(await login())) throw new Error("login necessário");
        const meta = await api.createDraft({
          title,
          scope,
          budgetUsdc: Number(budget),
          deadlineDays: Number(days),
          reviewHours: Number(reviewHours),
          researcher: researcher || undefined,
        });
        return fundFromMeta(program, meta, config, {
          amountBase: usdcToBase(Number(budget)),
          deadlineDays: Number(days),
          reviewHours: Number(reviewHours),
          researcher: researcher || null,
        });
      }
      // Modo só on-chain: o documento de escopo é montado e hasheado no navegador
      const jobId = randomJobId();
      const doc = {
        version: 1,
        jobId,
        client: wallet,
        title,
        targets: scope.split(",").map((s) => s.trim()).filter(Boolean),
        budgetUsdc: Number(budget),
        deadlineDays: Number(days),
        reviewHours: Number(reviewHours),
        source: "manual",
      };
      const scopeHashHex = await sha256Hex(new TextEncoder().encode(canonicalJson(doc)));
      const now = Math.floor(Date.now() / 1000);
      return createJobOnchain(program, {
        jobId,
        amountBase: usdcToBase(Number(budget)),
        deadline: now + Number(days) * 86_400,
        reviewPeriod: Math.round(Number(reviewHours) * 3600),
        scopeHashHex,
        researcher: researcher || null,
        mint: jobMint(config),
      });
    });
    setBusy(false);
  };

  return (
    <Card>
      <SectionTitle icon={<FilePlus2 className="w-4 h-4 text-solana-purple" />}>Novo escrow de pentest</SectionTitle>
      <div className="space-y-3">
        <Field label="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea label="Escopo (alvos separados por vírgula)" rows={2} value={scope} onChange={(e) => setScope(e.target.value)} />
        <div className="grid grid-cols-3 gap-2">
          <Field label="USDC" type="number" min="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <Field label="Prazo (dias)" type="number" min="1" max="180" value={days} onChange={(e) => setDays(e.target.value)} />
          <Field label="Revisão (h)" type="number" min="0.02" step="0.01" value={reviewHours} onChange={(e) => setReviewHours(e.target.value)} />
        </div>
        <Field
          label="Pesquisador (opcional)"
          hint="O aceite exige atribuição (PS-01). Vazio = pesquisadores se candidatam e você escolhe depois."
          placeholder="pubkey"
          value={researcher}
          onChange={(e) => setResearcher(e.target.value.trim())}
        />
        <p className="text-[11px] text-slate-500">
          O SHA-256 do escopo + regras de engajamento vai on-chain como autorização formal de teste.
          Após a evidência, o cliente tem a janela de revisão para aprovar ou contestar; sem resposta, o pagamento é liberado.
        </p>
        <Button onClick={submit} busy={busy} disabled={!wallet || !config} className="w-full">
          Assinar e travar {budget || 0} USDC
        </Button>
      </div>
    </Card>
  );
}

function isPubkey(s: string) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
