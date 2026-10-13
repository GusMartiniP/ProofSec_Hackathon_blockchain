"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Bot, Cpu, Lock } from "lucide-react";
import { useProofSec } from "@/hooks/useProofSec";
import { api } from "@/lib/api";
import { HAS_API } from "@/lib/config";
import { baseToUsdc, usdcToBase } from "@/lib/encoding";
import { fetchPolicy, setAgentPolicy, type AgentPolicy } from "@/lib/program";
import { fundFromMeta, jobMint } from "./CreateJobPanel";
import { AddressLink, Button, Card, Field, SectionTitle, StatusBadge } from "./ui";

export function AgentPanel() {
  const { program, wallet, config, offchain, run, login, refresh } = useProofSec();
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [agent, setAgent] = useState("");
  const [maxJob, setMaxJob] = useState("500");
  const [maxPeriod, setMaxPeriod] = useState("1500");
  const [periodHours, setPeriodHours] = useState("24");
  const [allowance, setAllowance] = useState("1500");
  const [severity, setSeverity] = useState("5");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wallet) return setPolicy(null);
    const p = await fetchPolicy(program, new PublicKey(wallet)).catch(() => null);
    setPolicy(p);
    if (p) {
      setAgent(p.agent);
      setMaxJob(String(baseToUsdc(p.maxPerJob)));
      setMaxPeriod(String(baseToUsdc(p.maxPerPeriod)));
      setPeriodHours(String(p.periodSeconds / 3600));
    }
  }, [program, wallet]);

  useEffect(() => {
    load();
  }, [load]);

  const savePolicy = async (active: boolean) => {
    setBusy("policy");
    await run(active ? "Saving agent policy" : "Deactivating agent", () =>
      setAgentPolicy(program, {
        agent: new PublicKey(agent),
        maxPerJobBase: usdcToBase(Number(maxJob)),
        maxPerPeriodBase: usdcToBase(Number(maxPeriod)),
        periodSeconds: Math.round(Number(periodHours) * 3600),
        active,
        allowanceBase: active ? usdcToBase(Number(allowance)) : 0,
        mint: jobMint(config),
      })
    );
    await load();
    setBusy(null);
  };

  const simulate = async () => {
    setBusy("scan");
    await run("Agent analyzing alert", async () => {
      if (!(await login())) throw new Error("login required");
      const job = await api.agentPropose({
        severity: Number(severity),
        target_asset: "assets.company.io/v2",
        type: "Policy:S3/BucketBlockPublicAccessDisabled",
      });
      return `${job.status}: ${job.title}`;
    });
    setBusy(null);
  };

  const spentPct = policy && policy.maxPerPeriod > 0 ? Math.min(100, (policy.spentInPeriod / policy.maxPerPeriod) * 100) : 0;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle icon={<Lock className="w-4 h-4 text-solana-purple" />}>Agent policy (on-chain)</SectionTitle>
        {policy ? (
          <div className="mb-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Agent</span>
              <AddressLink address={policy.agent} />
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Status</span>
              <span className={policy.active ? "text-solana-green" : "text-red-300"}>{policy.active ? "active" : "inactive"}</span>
            </div>
            <div>
              <div className="flex justify-between text-slate-400">
                <span>Spent in period</span>
                <span>
                  {baseToUsdc(policy.spentInPeriod)} / {baseToUsdc(policy.maxPerPeriod)} USDC
                </span>
              </div>
              <div className="h-1.5 bg-slate-800 rounded mt-1">
                <div className="h-1.5 bg-solana-purple rounded" style={{ width: `${spentPct}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-400 mb-4">
            No policy yet. The agent key can only open escrows within these limits — enforced by the program,
            not by the backend or the AI.
          </p>
        )}
        <div className="space-y-3">
          <Field label="Agent pubkey" placeholder="npm run keygen in /agent (or the SSM key, on Lambda)" value={agent} onChange={(e) => setAgent(e.target.value.trim())} />
          <div className="grid grid-cols-3 gap-2">
            <Field label="Max/job" type="number" value={maxJob} onChange={(e) => setMaxJob(e.target.value)} />
            <Field label="Max/period" type="number" value={maxPeriod} onChange={(e) => setMaxPeriod(e.target.value)} />
            <Field label="Period (h)" type="number" value={periodHours} onChange={(e) => setPeriodHours(e.target.value)} />
          </div>
          <Field
            label="Allowance (USDC)"
            hint="How much the policy PDA can move from your account (spl-token approve)"
            type="number"
            value={allowance}
            onChange={(e) => setAllowance(e.target.value)}
          />
          <p className="text-[10px] text-amber-300/80">
            Note: SPL Token accepts only one delegate per account. Approving the policy PDA replaces any previous delegate
            on your USDC account (PS-15). Agent jobs are created without a researcher: you assign one, and the minimum review period is 72 h.
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" busy={busy === "policy"} disabled={!wallet || !agent} onClick={() => savePolicy(true)}>
              Save policy + allowance
            </Button>
            {policy?.active && (
              <Button variant="danger" busy={busy === "policy"} onClick={() => savePolicy(false)}>
                Deactivate
              </Button>
            )}
          </div>
        </div>
      </Card>

      {HAS_API && (
        <Card>
          <SectionTitle icon={<Bot className="w-4 h-4 text-solana-green" />}>AI agent</SectionTitle>
          <p className="text-xs text-slate-400 mb-3">
            In production, alerts arrive from GuardDuty/Security Hub via EventBridge. Here you simulate one.
            Severity sets the budget (deterministic table); the AI only drafts the scope.
          </p>
          <div className="flex items-end gap-2">
            <Field label="Severity (0-10)" type="number" min="0" max="10" step="0.5" value={severity} onChange={(e) => setSeverity(e.target.value)} />
            <Button busy={busy === "scan"} disabled={!wallet} onClick={simulate}>
              <Cpu className="w-3.5 h-3.5" /> Simulate alert
            </Button>
          </div>

          {offchain.length > 0 && (
            <div className="mt-4 space-y-2">
              <span className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">Proposals and drafts</span>
              {offchain.map((p) => (
                <div key={p.jobId} className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs space-y-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold text-white">{p.title}</span>
                    <span className="text-solana-green font-bold whitespace-nowrap">{p.budgetUsdc} USDC</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusBadge status={p.status} />
                    {p.severity && <span className="text-slate-500">sev. {p.severity}</span>}
                  </div>
                  {p.agentDecision && <p className="text-slate-400">{p.agentDecision}</p>}
                  {p.status !== "AUTO_APPROVED" && (
                    <Button
                      variant="success"
                      className="w-full"
                      busy={busy === p.jobId}
                      onClick={async () => {
                        setBusy(p.jobId);
                        await run("Funding proposal", () => fundFromMeta(program, p, config));
                        setBusy(null);
                        refresh();
                      }}
                    >
                      Sign and fund in Phantom
                    </Button>
                  )}
                  {p.status === "AUTO_APPROVED" && (
                    <p className="text-[11px] text-purple-300">Waiting for the agent executor to open the on-chain escrow.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
