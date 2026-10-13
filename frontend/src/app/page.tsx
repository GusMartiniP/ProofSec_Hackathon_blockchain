'use client';

import React, { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Coins, KeyRound, LogIn, RefreshCw, Shield } from 'lucide-react';
import { useProofSec } from '@/hooks/useProofSec';
import { useRole } from '@/hooks/useRole';
import { HAS_API } from '@/lib/config';
import {
  ROLE_LABEL,
  VIEW_LABEL,
  canConfigureAgent,
  canCreateEscrow,
  defaultView,
  isArbiterAnywhere,
  jobsForRoleView,
  viewsFor,
  type Role,
  type RoleView,
} from '@/lib/role';
import { AdminSetup } from '@/components/AdminSetup';
import { AgentPanel } from '@/components/AgentPanel';
import { CreateJobPanel } from '@/components/CreateJobPanel';
import { JobCard } from '@/components/JobCard';
import { NoticeBar } from '@/components/NoticeBar';
import { RolePicker } from '@/components/RolePicker';
import { Button } from '@/components/ui';

const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
  { ssr: false }
);

export default function Home() {
  const { wallet, config, configLoaded, jobs, loading, refresh, loggedIn, login, ensureEncryptionKey, run } = useProofSec();
  const { role, setRole } = useRole(wallet);
  const [pickedView, setPickedView] = useState<RoleView | null>(null);

  // No wallet or no role chosen: full public list, read-only.
  const arbiter = isArbiterAnywhere(jobs, wallet);
  const views = role ? viewsFor(role, arbiter) : [];
  const view: RoleView | null = role ? (pickedView && views.includes(pickedView) ? pickedView : defaultView(role)) : null;

  const visible = useMemo(
    () => (role && view ? jobsForRoleView(jobs, role, view, wallet) : jobs),
    [jobs, role, view, wallet]
  );

  const locked = jobs
    .filter((j) => ['OPEN', 'IN_PROGRESS', 'EVIDENCE_SUBMITTED', 'DISPUTED'].includes(j.status))
    .reduce((s, j) => s + j.amount, 0);

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <header className="flex flex-col sm:flex-row justify-between items-center pb-8 border-b border-slate-800 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-tr from-solana-purple to-solana-green rounded-xl shadow-lg shadow-solana-purple/20">
            <Shield className="w-7 h-7 text-black stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-black tracking-tight text-white">ProofSec</h1>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-solana-green/10 text-solana-green border border-solana-green/30">
                Solana Devnet
              </span>
              {!HAS_API && (
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                  on-chain-only mode
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">Programmable Security Escrow & Agentic Trust Layer</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-center">
          {wallet && role && (
            <div className="bg-slate-900 p-1 rounded-xl border border-slate-800 flex text-xs font-semibold" role="group" aria-label="Role">
              {(['company', 'researcher'] as Role[]).map((r) => (
                <button
                  key={r}
                  onClick={() => {
                    setRole(r);
                    setPickedView(null);
                  }}
                  className={`px-3 py-1.5 rounded-lg transition-all ${
                    role === r ? 'bg-solana-purple text-white shadow-md' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
          )}
          {HAS_API && wallet && !loggedIn && (
            <Button variant="ghost" onClick={login}>
              <LogIn className="w-3.5 h-3.5" /> Sign in (SIWS)
            </Button>
          )}
          {HAS_API && wallet && loggedIn && (
            <Button
              variant="ghost"
              title="Derives your report encryption key from a signature and publishes the public half"
              onClick={() => run('Activating report encryption', async () => (await ensureEncryptionKey()).publicKeyB64)}
            >
              <KeyRound className="w-3.5 h-3.5" /> Activate encryption
            </Button>
          )}
          <WalletMultiButton className="!bg-slate-900 !border !border-slate-700 !rounded-xl !text-xs !font-semibold !h-10 hover:!bg-slate-800" />
        </div>
      </header>

      <section className="py-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 p-6 rounded-2xl border border-slate-800">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-solana-green bg-solana-green/10 px-2.5 py-1 rounded-full mb-3">
            <Coins className="w-3.5 h-3.5" /> USDC locked on-chain · optimistic release · arbiter-backed disputes
          </span>
          <h2 className="text-2xl font-bold text-white mb-2">Security audits without trust asymmetry</h2>
          <p className="text-sm text-slate-400 max-w-xl leading-relaxed">
            The client locks USDC and records the hash of the authorized scope on-chain. The researcher delivers the
            encrypted report and records its SHA-256 on Solana. The client approves or disputes within the review
            window — if they stay silent, payment is released. The AI proposes; the chain enforces the spending limits.
          </p>
        </div>
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 grid grid-cols-2 gap-4 content-center">
          <Stat label="Jobs on-chain" value={String(jobs.length)} />
          <Stat label="USDC in escrow" value={(locked / 1_000_000).toLocaleString('en-US')} />
          <Stat label="Platform fee" value={config ? `${config.feeBps / 100}%` : '—'} />
          <Stat label="In review" value={String(jobs.filter((j) => j.status === 'EVIDENCE_SUBMITTED').length)} />
        </div>
      </section>

      {wallet && !role && <RolePicker onPick={setRole} />}

      {configLoaded && !config && (
        <div className="mb-6">
          <AdminSetup />
        </div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="bg-slate-900 p-1 rounded-xl border border-slate-800 flex text-xs font-semibold">
              {role && view ? (
                views.map((v) => (
                  <button
                    key={v}
                    onClick={() => setPickedView(v)}
                    className={`px-3 py-1.5 rounded-lg transition-all ${
                      view === v ? 'bg-solana-purple text-white shadow-md' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {VIEW_LABEL[v][role]}
                  </button>
                ))
              ) : (
                <span className="px-3 py-1.5 text-slate-400">All escrows</span>
              )}
            </div>
            <button onClick={refresh} className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {visible.length === 0 && (
            <div className="border border-dashed border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
              {loading ? 'Reading the chain…' : 'No escrows here yet.'}
            </div>
          )}
          {visible.map((job) => (
            <JobCard key={job.pda} job={job} />
          ))}
        </div>

        <aside className="space-y-4">
          {wallet && role ? (
            <>
              {canCreateEscrow(role) && <CreateJobPanel />}
              {canConfigureAgent(role) && <AgentPanel />}
              {role === 'researcher' && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 text-sm text-slate-400 space-y-2">
                  <div className="font-semibold text-white">To deliver reports</div>
                  <p>
                    1. Sign in (SIWS) and use <span className="text-slate-200">Activate encryption</span> once.
                    <br />
                    2. Apply to an open job and wait for the client to assign you.
                    <br />
                    3. Accept the job, upload the encrypted report and follow the review window.
                  </p>
                </div>
              )}
            </>
          ) : wallet ? null : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 text-sm text-slate-400">
              Connect your wallet (Phantom, Solflare, Backpack…) on devnet to create escrows, accept jobs or configure the
              agent.
            </div>
          )}
        </aside>
      </section>

      <NoticeBar />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">{label}</div>
      <div className="text-xl font-black text-white">{value}</div>
    </div>
  );
}
