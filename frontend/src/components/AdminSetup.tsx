"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Settings } from "lucide-react";
import { useProofSec } from "@/hooks/useProofSec";
import { USDC_MINT } from "@/lib/config";
import { initializeConfig } from "@/lib/program";
import { Button, Card, Field, SectionTitle } from "./ui";

/** Exibido só enquanto a conta de configuração da plataforma não existe on-chain. */
export function AdminSetup() {
  const { program, wallet, run } = useProofSec();
  const [arbiter, setArbiter] = useState("");
  const [treasury, setTreasury] = useState("");
  const [fee, setFee] = useState("2.5");
  const [mint, setMint] = useState(USDC_MINT.toBase58());
  const [disputeHours, setDisputeHours] = useState("24");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    await run("Inicializando a plataforma", () =>
      initializeConfig(program, {
        arbiter: new PublicKey(arbiter || wallet!),
        treasury: new PublicKey(treasury || wallet!),
        feeBps: Math.round(Number(fee) * 100),
        allowedMint: new PublicKey(mint || PublicKey.default.toBase58()),
        disputePeriod: Math.round(Number(disputeHours) * 3600),
      })
    );
    setBusy(false);
  };

  return (
    <Card className="border-amber-500/30">
      <SectionTitle icon={<Settings className="w-4 h-4 text-amber-300" />}>Configuração inicial da plataforma</SectionTitle>
      <p className="text-xs text-slate-400 mb-4">
        O programa ainda não tem a conta de configuração. Só a upgrade authority do programa (a carteira que fez o
        deploy) consegue inicializar (PS-03). Para a demo, árbitro e tesouraria em branco usam a sua carteira (em produção,
        use um multisig Squads). Taxa, árbitro e prazo de disputa ficam congelados em cada job na criação.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Árbitro (pubkey)" placeholder={wallet ?? ""} value={arbiter} onChange={(e) => setArbiter(e.target.value)} />
        <Field label="Tesouraria (pubkey)" placeholder={wallet ?? ""} value={treasury} onChange={(e) => setTreasury(e.target.value)} />
        <Field label="Taxa da plataforma (%)" type="number" step="0.1" min="0" max="10" value={fee} onChange={(e) => setFee(e.target.value)} />
        <Field label="Mint permitido" hint="Vazio = qualquer token" value={mint} onChange={(e) => setMint(e.target.value)} />
        <Field
          label="Prazo do árbitro (h)"
          hint="Depois dele, qualquer um aplica a divisão 50/50 (mín. 1 min, máx. 30 dias)"
          type="number"
          step="0.01"
          min="0.02"
          max="720"
          value={disputeHours}
          onChange={(e) => setDisputeHours(e.target.value)}
        />
      </div>
      <Button className="mt-4" onClick={submit} busy={busy} disabled={!wallet}>
        Inicializar configuração
      </Button>
    </Card>
  );
}
