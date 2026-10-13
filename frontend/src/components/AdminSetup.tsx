"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Settings } from "lucide-react";
import { useProofSec } from "@/hooks/useProofSec";
import { USDC_MINT } from "@/lib/config";
import { initializeConfig } from "@/lib/program";
import { Button, Card, Field, SectionTitle } from "./ui";

/** Shown only while the platform config account does not exist on-chain. */
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
    await run("Initializing the platform", () =>
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
      <SectionTitle icon={<Settings className="w-4 h-4 text-amber-300" />}>Initial platform setup</SectionTitle>
      <p className="text-xs text-slate-400 mb-4">
        The program does not have a config account yet. Only the program's upgrade authority (the wallet that
        deployed it) can initialize it (PS-03). For the demo, leaving arbiter and treasury blank uses your own wallet
        (in production, use a Squads multisig). Fee, arbiter and dispute period are frozen into each job at creation.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Arbiter (pubkey)" placeholder={wallet ?? ""} value={arbiter} onChange={(e) => setArbiter(e.target.value)} />
        <Field label="Treasury (pubkey)" placeholder={wallet ?? ""} value={treasury} onChange={(e) => setTreasury(e.target.value)} />
        <Field label="Platform fee (%)" type="number" step="0.1" min="0" max="10" value={fee} onChange={(e) => setFee(e.target.value)} />
        <Field label="Allowed mint" hint="Empty = any token" value={mint} onChange={(e) => setMint(e.target.value)} />
        <Field
          label="Arbiter deadline (h)"
          hint="After it, anyone can apply the 50/50 split (min. 1 min, max. 30 days)"
          type="number"
          step="0.01"
          min="0.02"
          max="720"
          value={disputeHours}
          onChange={(e) => setDisputeHours(e.target.value)}
        />
      </div>
      <Button className="mt-4" onClick={submit} busy={busy} disabled={!wallet}>
        Initialize config
      </Button>
    </Card>
  );
}
