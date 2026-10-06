"use client";

import { Building2, Search } from "lucide-react";
import type { Role } from "@/lib/role";

/** Primeiro acesso: escolha da visão. Não é permissão — qualquer carteira pode usar as duas. */
export function RolePicker({ onPick }: { onPick: (r: Role) => void }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-6">
      <h3 className="text-lg font-bold text-white mb-1">Como você vai usar o ProofSec?</h3>
      <p className="text-sm text-slate-400 mb-4">
        Você pode trocar a qualquer momento no cabeçalho. Isso muda só o que aparece na tela.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          onClick={() => onPick("company")}
          className="text-left p-4 rounded-xl border border-slate-700 hover:border-solana-purple bg-slate-950 transition-colors"
        >
          <Building2 className="w-5 h-5 text-solana-purple mb-2" />
          <div className="font-semibold text-white text-sm">Empresa</div>
          <div className="text-xs text-slate-400">Contratar um pentest: travar USDC, definir o escopo, revisar e aprovar.</div>
        </button>
        <button
          onClick={() => onPick("researcher")}
          className="text-left p-4 rounded-xl border border-slate-700 hover:border-solana-green bg-slate-950 transition-colors"
        >
          <Search className="w-5 h-5 text-solana-green mb-2" />
          <div className="font-semibold text-white text-sm">Pesquisador</div>
          <div className="text-xs text-slate-400">Encontrar vagas, se candidatar, entregar o relatório cifrado e receber.</div>
        </button>
      </div>
    </div>
  );
}
