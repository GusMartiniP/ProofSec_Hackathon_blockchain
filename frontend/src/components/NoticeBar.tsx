"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useProofSec } from "@/hooks/useProofSec";
import { TxLink } from "./ui";

export function NoticeBar() {
  const { notice, notify } = useProofSec();
  if (!notice) return null;
  const style =
    notice.kind === "error"
      ? "bg-red-500/10 border-red-500/30 text-red-200"
      : notice.kind === "success"
        ? "bg-solana-green/10 border-solana-green/30 text-emerald-200"
        : "bg-slate-800/80 border-slate-700 text-slate-200";
  const Icon = notice.kind === "error" ? XCircle : notice.kind === "success" ? CheckCircle2 : Info;
  return (
    <div className={`fixed bottom-4 right-4 left-4 sm:left-auto sm:max-w-md z-50 border rounded-xl p-3 text-xs flex gap-2 shadow-xl ${style}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="flex-1 space-y-1 break-words">
        <p>{notice.text}</p>
        {notice.tx && <TxLink sig={notice.tx} />}
      </div>
      <button onClick={() => notify(null)} aria-label="Fechar" className="opacity-70 hover:opacity-100">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
