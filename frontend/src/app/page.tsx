'use client';

import React, { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Coins, KeyRound, LogIn, RefreshCw, Shield } from 'lucide-react';
import { useProofSec } from '@/hooks/useProofSec';
import { HAS_API } from '@/lib/config';
import { AdminSetup } from '@/components/AdminSetup';
import { AgentPanel } from '@/components/AgentPanel';
import { CreateJobPanel } from '@/components/CreateJobPanel';
import { JobCard } from '@/components/JobCard';
import { NoticeBar } from '@/components/NoticeBar';
import { Button } from '@/components/ui';

const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
  { ssr: false }
);

type Tab = 'all' | 'client' | 'researcher';

export default function Home() {
  const { wallet, config, configLoaded, jobs, loading, refresh, loggedIn, login, ensureEncryptionKey, run } = useProofSec();
  const [tab, setTab] = useState<Tab>('all');

  const visible = useMemo(() => {
    if (tab === 'client') return jobs.filter((j) => j.client === wallet);
    if (tab === 'researcher') return jobs.filter((j) => j.researcher === wallet);
    return jobs;
  }, [jobs, tab, wallet]);

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
                  modo só on-chain
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">Programmable Security Escrow & Agentic Trust Layer</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {HAS_API && wallet && !loggedIn && (
            <Button variant="ghost" onClick={login}>
              <LogIn className="w-3.5 h-3.5" /> Entrar (SIWS)
            </Button>
          )}
          {HAS_API && wallet && loggedIn && (
            <Button
              variant="ghost"
              title="Gera sua chave de criptografia de relatórios a partir de uma assinatura e publica a parte pública"
              onClick={() => run('Ativando criptografia de relatórios', async () => (await ensureEncryptionKey()).publicKeyB64)}
            >
              <KeyRound className="w-3.5 h-3.5" /> Ativar criptografia
            </Button>
          )}
          <WalletMultiButton className="!bg-slate-900 !border !border-slate-700 !rounded-xl !text-xs !font-semibold !h-10 hover:!bg-slate-800" />
        </div>
      </header>

      <section className="py-8 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 p-6 rounded-2xl border border-slate-800">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-solana-green bg-solana-green/10 px-2.5 py-1 rounded-full mb-3">
            <Coins className="w-3.5 h-3.5" /> USDC travado on-chain · liberação otimista · disputa com árbitro
          </span>
          <h2 className="text-2xl font-bold text-white mb-2">Auditorias técnicas sem assimetria de confiança</h2>
          <p className="text-sm text-slate-400 max-w-xl leading-relaxed">
            O cliente trava USDC e registra on-chain o hash do escopo autorizado. O pesquisador entrega o relatório cifrado
            e grava o SHA-256 dele na Solana. O cliente aprova ou contesta dentro da janela de revisão — se ficar em
            silêncio, o pagamento é liberado. A IA propõe; a chain impõe os limites de gasto.
          </p>
        </div>
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 grid grid-cols-2 gap-4 content-center">
          <Stat label="Jobs on-chain" value={String(jobs.length)} />
          <Stat label="USDC em escrow" value={(locked / 1_000_000).toLocaleString('pt-BR')} />
          <Stat label="Taxa da plataforma" value={config ? `${config.feeBps / 100}%` : '—'} />
          <Stat label="Em revisão" value={String(jobs.filter((j) => j.status === 'EVIDENCE_SUBMITTED').length)} />
        </div>
      </section>

      {configLoaded && !config && (
        <div className="mb-6">
          <AdminSetup />
        </div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="bg-slate-900 p-1 rounded-xl border border-slate-800 flex text-xs font-semibold">
              {([
                ['all', 'Todos'],
                ['client', 'Sou cliente'],
                ['researcher', 'Sou pesquisador'],
              ] as [Tab, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  disabled={key !== 'all' && !wallet}
                  className={`px-3 py-1.5 rounded-lg transition-all disabled:opacity-40 ${
                    tab === key ? 'bg-solana-purple text-white shadow-md' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button onClick={refresh} className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
          </div>

          {visible.length === 0 && (
            <div className="border border-dashed border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
              {loading ? 'Lendo a chain…' : 'Nenhum escrow por aqui ainda.'}
            </div>
          )}
          {visible.map((job) => (
            <JobCard key={job.pda} job={job} />
          ))}
        </div>

        <aside className="space-y-4">
          {wallet ? (
            <>
              <CreateJobPanel />
              <AgentPanel />
            </>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 text-sm text-slate-400">
              Conecte sua carteira (Phantom, Solflare, Backpack…) na devnet para criar escrows, aceitar jobs ou configurar o
              agente.
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
