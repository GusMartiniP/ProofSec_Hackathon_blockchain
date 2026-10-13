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

/** Creates the on-chain escrow from a backend draft/proposal. */
export async function fundFromMeta(
  program: Program<Idl>,
  meta: JobMeta,
  config: PlatformConfig | null,
  expected?: ExpectedDraft
) {
  // The backend does not decide what the user funds: verify before asking for a signature
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
  const [title, setTitle] = useState("API and authentication pentest");
  const [scope, setScope] = useState("api.company.com, app.company.com/login");
  const [budget, setBudget] = useState("350");
  const [days, setDays] = useState("7");
  const [reviewHours, setReviewHours] = useState("72");
  const [researcher, setResearcher] = useState("");
  const [busy, setBusy] = useState(false);
  const arbiterWallet = !!wallet && wallet === config?.arbiter;

  const submit = async () => {
    if (researcher && !isPubkey(researcher)) {
      return run("Validation", async () => {
        throw new Error("invalid researcher pubkey");
      });
    }
    // PS-52: the program refuses an arbiter that is a party of the job; checking here avoids a doomed wallet prompt
    if (researcher && config && researcher === config.arbiter) {
      return run("Validation", async () => {
        throw new Error("the platform arbiter cannot be the researcher of a job");
      });
    }
    setBusy(true);
    await run("Creating escrow", async () => {
      if (HAS_API) {
        if (!(await login())) throw new Error("login required");
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
      // On-chain-only mode: the scope document is built and hashed in the browser
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
      <SectionTitle icon={<FilePlus2 className="w-4 h-4 text-solana-purple" />}>New pentest escrow</SectionTitle>
      <div className="space-y-3">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea label="Scope (targets separated by commas)" rows={2} value={scope} onChange={(e) => setScope(e.target.value)} />
        <div className="grid grid-cols-3 gap-2">
          <Field label="USDC" type="number" min="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <Field label="Deadline (days)" type="number" min="1" max="180" value={days} onChange={(e) => setDays(e.target.value)} />
          <Field label="Review (h)" type="number" min="0.02" step="0.01" value={reviewHours} onChange={(e) => setReviewHours(e.target.value)} />
        </div>
        <Field
          label="Researcher (optional)"
          hint="Accepting requires an assignment (PS-01). Empty = researchers apply and you choose later."
          placeholder="pubkey"
          value={researcher}
          onChange={(e) => setResearcher(e.target.value.trim())}
        />
        <p className="text-[11px] text-slate-500">
          The SHA-256 of the scope + rules of engagement goes on-chain as the formal testing authorization.
          After the evidence is submitted, the client has the review window to approve or dispute; with no response, payment is released.
        </p>
        {arbiterWallet && (
          <p className="text-[11px] text-amber-300/90">
            This wallet is the platform arbiter, so it cannot be the client of a job (PS-52). Switch to another wallet to create escrows.
          </p>
        )}
        <Button onClick={submit} busy={busy} disabled={!wallet || !config || arbiterWallet} className="w-full">
          Sign and lock {budget || 0} USDC
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
