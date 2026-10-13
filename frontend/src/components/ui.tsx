"use client";

import React from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { explorerAddress, explorerTx, shortKey } from "@/lib/config";
import type { JobStatus } from "@/lib/program";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-slate-900/70 border border-slate-800 rounded-xl p-5 ${className}`}>{children}</div>;
}

export function SectionTitle({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h3 className="text-sm font-bold text-white">{children}</h3>
    </div>
  );
}

type Variant = "primary" | "success" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-solana-purple text-white hover:bg-purple-600",
  success: "bg-solana-green text-black hover:bg-emerald-400",
  danger: "bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25",
  ghost: "bg-slate-800 text-slate-200 hover:bg-slate-700",
};

export function Button({
  variant = "primary",
  busy,
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 text-xs font-bold px-3.5 py-2 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    >
      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block text-xs">
      <span className="text-slate-400 font-semibold">{label}</span>
      <input
        {...rest}
        className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-solana-purple"
      />
      {hint && <span className="text-[10px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function TextArea({
  label,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <label className="block text-xs">
      <span className="text-slate-400 font-semibold">{label}</span>
      <textarea
        {...rest}
        className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-solana-purple"
      />
    </label>
  );
}

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-blue-500/10 text-blue-300 border-blue-500/20",
  IN_PROGRESS: "bg-indigo-500/10 text-indigo-300 border-indigo-500/20",
  EVIDENCE_SUBMITTED: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  DISPUTED: "bg-red-500/10 text-red-300 border-red-500/20",
  COMPLETED: "bg-green-500/10 text-green-300 border-green-500/20",
  RESOLVED: "bg-teal-500/10 text-teal-300 border-teal-500/20",
  REFUNDED: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  CANCELLED: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  DRAFT: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  NEEDS_HUMAN: "bg-orange-500/10 text-orange-300 border-orange-500/20",
  AUTO_APPROVED: "bg-purple-500/10 text-purple-300 border-purple-500/20",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  EVIDENCE_SUBMITTED: "In review",
  DISPUTED: "Em disputa",
  COMPLETED: "Paid",
  RESOLVED: "Resolved (arbiter)",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
  DRAFT: "Draft",
  NEEDS_HUMAN: "Awaiting human approval",
  AUTO_APPROVED: "Approved by policy (executor)",
};

export function StatusBadge({ status }: { status: JobStatus | string }) {
  return (
    <span className={`px-2 py-0.5 rounded-md font-semibold text-[11px] border ${STATUS_STYLE[status] ?? STATUS_STYLE.DRAFT}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function TxLink({ sig }: { sig: string }) {
  return (
    <a href={explorerTx(sig)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
      ver no Explorer <ExternalLink className="w-3 h-3" />
    </a>
  );
}

export function AddressLink({ address, n = 4 }: { address?: string | null; n?: number }) {
  if (!address) return <span className="text-slate-500">—</span>;
  return (
    <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="font-mono hover:text-white underline-offset-2 hover:underline">
      {shortKey(address, n)}
    </a>
  );
}

export function formatCountdown(target: number, now: number): string {
  const d = target - now;
  if (d <= 0) return "expired";
  const days = Math.floor(d / 86400);
  const h = Math.floor((d % 86400) / 3600);
  const m = Math.floor((d % 3600) / 60);
  if (days > 0) return `${days}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${d % 60}s`;
}
