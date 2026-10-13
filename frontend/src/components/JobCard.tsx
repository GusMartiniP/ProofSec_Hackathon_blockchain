"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { CheckCircle2, Download, FileCheck, Gavel, ShieldAlert, Upload, XCircle } from "lucide-react";
import { useProofSec, type JobView } from "@/hooks/useProofSec";
import { api } from "@/lib/api";
import { HAS_API, RECOVERY_GRACE_SECONDS } from "@/lib/config";
import { baseToUsdc, sha256Hex, toArrayBuffer } from "@/lib/encoding";
import { decryptReport, deriveEncryptionKeypair, encryptReport, envelopeKeyVersion } from "@/lib/evidence";
import {
  acceptJob,
  approveAndRelease,
  assignResearcher,
  cancelJob,
  claimAfterReview,
  openDispute,
  recoverStuckFunds,
  refundExpired,
  resolveDispute,
  resolveDisputeTimeout,
  submitEvidence,
} from "@/lib/program";
import { AddressLink, Button, Field, StatusBadge, formatCountdown } from "./ui";

export function JobCard({ job }: { job: JobView }) {
  const { program, wallet, config, run, now, login, ensureEncryptionKey, refresh } = useProofSec();
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const isClient = wallet === job.client;
  const isResearcher = !!wallet && wallet === job.researcher;
  // Arbiter frozen into the job at creation (PS-04), not the current config's
  const isArbiter = !!wallet && wallet === job.arbiter;
  const deadlinePassed = now > job.deadline;
  const reviewOpen = job.status === "EVIDENCE_SUBMITTED" && now <= job.reviewDeadline;
  const disputeExpired = job.status === "DISPUTED" && job.disputeDeadline > 0 && now > job.disputeDeadline;
  // PS-37: after the grace period, anyone can return an unsettled job to the client
  const recoverAfter =
    job.status === "DISPUTED" && job.disputeDeadline > 0
      ? job.disputeDeadline + RECOVERY_GRACE_SECONDS
      : job.status === "EVIDENCE_SUBMITTED" && job.reviewDeadline > 0
        ? job.reviewDeadline + RECOVERY_GRACE_SECONDS
        : null;
  const canRecover = recoverAfter !== null && now > recoverAfter;
  // PS-01: only the researcher assigned by the client can accept
  const canAccept = job.status === "OPEN" && isResearcher && !deadlinePassed;
  const canApply = HAS_API && job.status === "OPEN" && !job.researcher && !!wallet && !isClient && !deadlinePassed;

  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    await run(label, fn);
    if (HAS_API) await api.syncJob(job.jobId, job.pda).catch(() => undefined);
    setBusy(null);
    refresh();
  };

  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all space-y-3">
      <div className="flex justify-between items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-mono font-bold text-solana-purple">
            <span>{job.jobId}</span>
            {job.createdByAgent && (
              <span className="px-1.5 py-0.5 rounded bg-solana-green/10 text-solana-green border border-solana-green/30 font-sans">
                AI Agent
              </span>
            )}
          </div>
          <h4 className="text-base font-bold text-white mt-0.5 truncate">{job.meta?.title ?? "On-chain job"}</h4>
          <p className="text-[11px] text-slate-400 mt-1">
            Client <AddressLink address={job.client} /> · Researcher <AddressLink address={job.researcher} />
          </p>
        </div>
        <div className="text-right shrink-0">
          <span className="text-lg font-black text-solana-green">{baseToUsdc(job.amount)} USDC</span>
          <div className="text-[10px] text-slate-400">
            vault <AddressLink address={job.vault} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 border-t border-slate-800/80 text-[11px] text-slate-400">
        <StatusBadge status={job.status} />
        {["OPEN", "IN_PROGRESS"].includes(job.status) && <span>deadline: {formatCountdown(job.deadline, now)}</span>}
        {job.status === "EVIDENCE_SUBMITTED" && <span>review: {formatCountdown(job.reviewDeadline, now)}</span>}
        <span className="font-mono truncate max-w-[14rem]" title={`scope_hash ${job.scopeHash}`}>
          scope {job.scopeHash.slice(0, 10)}…
        </span>
        {job.evidenceSha256 && (
          <span className="flex items-center gap-1 font-mono truncate max-w-[16rem]" title={job.evidenceSha256}>
            <FileCheck className="w-3.5 h-3.5 text-solana-green shrink-0" />
            {job.evidenceSha256.slice(0, 16)}…
          </span>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {/* ----- Client ----- */}
        {isClient && job.status === "OPEN" && (
          <>
            <AssignBox
              applicants={job.meta?.applicants ?? []}
              current={job.researcher}
              onAssign={(r) => act("assign", r ? "Assigning researcher" : "Removing assignment", () => assignResearcher(program, job, r))}
              busy={busy === "assign"}
            />
            <Button variant="ghost" busy={busy === "cancel"} onClick={() => act("cancel", "Cancelling and refunding", () => cancelJob(program, job))}>
              Cancel
            </Button>
          </>
        )}
        {isClient && deadlinePassed && ["OPEN", "IN_PROGRESS"].includes(job.status) && (
          <Button variant="ghost" busy={busy === "refund"} onClick={() => act("refund", "Refunding (deadline expired)", () => refundExpired(program, job))}>
            Refund
          </Button>
        )}

        {/* ----- Researcher ----- */}
        {canApply && (
          <Button
            variant="ghost"
            disabled={applied}
            busy={busy === "apply"}
            onClick={async () => {
              setBusy("apply");
              const r = await run("Submitting application", async () => {
                if (!(await login())) throw new Error("login required");
                return api.apply(job.jobId);
              });
              if (r) setApplied(true);
              setBusy(null);
            }}
          >
            {applied ? "Application sent" : "Apply"}
          </Button>
        )}
        {canAccept && (
          <Button busy={busy === "accept"} onClick={() => act("accept", "Accepting job", () => acceptJob(program, job))}>
            Accept pentest job
          </Button>
        )}
        {isResearcher && job.status === "EVIDENCE_SUBMITTED" && !reviewOpen && config && (
          <Button variant="success" busy={busy === "claim"} onClick={() => act("claim", "Claiming after the review window", () => claimAfterReview(program, job, config))}>
            Claim payment
          </Button>
        )}
      </div>

      {canRecover && !!wallet && (
        <div className="flex justify-end">
          <Button variant="ghost" busy={busy === "recover"} onClick={() => act("recover", "Recovering funds (grace period over)", () => recoverStuckFunds(program, job))}>
            Recover funds to the client (last resort)
          </Button>
        </div>
      )}

      {isResearcher && job.status === "IN_PROGRESS" && (
        <EvidenceSubmit
          job={job}
          busy={busy === "evidence"}
          onSubmit={async (file) => {
            setBusy("evidence");
            await run("Submitting evidence", async () => {
              let shaHex: string;
              if (HAS_API) {
                if (!(await login())) throw new Error("login required");
                const mine = await ensureEncryptionKey();
                const clientKey = await api.getEncryptionKey(job.client).catch((e) => {
                  if (/proof of possession/.test(String(e?.message))) throw e; // key published without a valid signature (PS-38)
                  throw new Error("the client has not activated encryption yet (they need to open the app and click 'Activate encryption')");
                });
                const recipients = [
                  { label: "client", publicKeyB64: clientKey },
                  { label: "researcher", publicKeyB64: mine.publicKeyB64 },
                ];
                // The job's arbiter also needs to open the report in case of a dispute
                const arbiterKey = await api.getEncryptionKey(job.arbiter).catch(() => null);
                if (arbiterKey) recipients.push({ label: "arbiter", publicKeyB64: arbiterKey });
                else if (
                  !window.confirm(
                    "This job's arbiter has not activated encryption yet. In case of a dispute they will not be able to open the report. Submit anyway?"
                  )
                )
                  throw new Error("submission cancelled");
                const enc = await encryptReport(file, recipients);
                shaHex = enc.sha256Hex;
                const up = await api.uploadUrl(job.jobId, shaHex, enc.blob.length);
                const put = await fetch(up.uploadUrl, { method: "PUT", headers: up.headers, body: toArrayBuffer(enc.blob) });
                if (!put.ok) throw new Error(`S3 upload failed (HTTP ${put.status})`);
              } else {
                // On-chain-only mode: the file stays with you; only the hash goes to the chain
                shaHex = await sha256Hex(await file.arrayBuffer());
              }
              return submitEvidence(program, job, shaHex);
            });
            if (HAS_API) await api.syncJob(job.jobId, job.pda).catch(() => undefined);
            setBusy(null);
            refresh();
          }}
        />
      )}

      {isClient && job.status === "EVIDENCE_SUBMITTED" && config && (
        <ReviewBox
          job={job}
          reviewOpen={reviewOpen}
          busy={busy}
          onApprove={() => act("approve", "Approving and releasing payment", () => approveAndRelease(program, job, config))}
          onDispute={() => act("dispute", "Opening dispute", () => openDispute(program, job))}
        />
      )}

      {job.status === "DISPUTED" && (
        <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3 text-xs space-y-2">
          <div className="flex items-center gap-2 text-red-200 font-semibold flex-wrap">
            <Gavel className="w-4 h-4" /> In dispute — arbiter <AddressLink address={job.arbiter} /> · deadline{" "}
            {formatCountdown(job.disputeDeadline, now)}
          </div>
          {isArbiter && !disputeExpired && config && (
            <ArbiterBox busy={busy === "resolve"} job={job} onResolve={(bps) => act("resolve", "Resolving dispute", () => resolveDispute(program, job, config, bps))} />
          )}
          {(isArbiter || isClient || isResearcher) && HAS_API && job.evidenceSha256 && <ReportDownload job={job} />}
          {disputeExpired && wallet && config && (
            <Button
              variant="ghost"
              busy={busy === "timeout"}
              onClick={() => act("timeout", "Applying default 50/50 split", () => resolveDisputeTimeout(program, job, config))}
            >
              Arbiter deadline passed: apply 50/50 split
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function AssignBox({
  applicants,
  current,
  onAssign,
  busy,
}: {
  applicants: string[];
  current: string | null;
  onAssign: (r: string | null) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  return (
    <div className="w-full space-y-2">
      {applicants.length > 0 && !current && (
        <div className="space-y-1">
          <span className="text-[11px] text-slate-400">Applicants</span>
          {applicants.map((a) => (
            <div key={a} className="flex items-center justify-between gap-2">
              <AddressLink address={a} n={6} />
              <Button variant="ghost" busy={busy} onClick={() => onAssign(a)}>
                Assign
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {current && (
          <Button variant="ghost" busy={busy} onClick={() => onAssign(null)}>
            Remove assignment
          </Button>
        )}
        {!open ? (
          <Button variant="ghost" onClick={() => setOpen(true)}>
            {current ? "Change researcher" : "Assign researcher"}
          </Button>
        ) : (
          <div className="flex gap-2 items-end w-full sm:w-auto">
            <Field label="Researcher pubkey" value={value} onChange={(e) => setValue(e.target.value.trim())} />
            <Button busy={busy} disabled={!value} onClick={() => onAssign(value)}>
              Assign
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Downloads the envelope, checks its hash against the ON-CHAIN one and decrypts in the browser (v2, or legacy v1). */
function useReportOpener(job: JobView) {
  const { ensureEncryptionKey, login, wallet } = useProofSec();
  const { signMessage } = useWallet();
  return async (onBytes?: (b: Uint8Array) => Promise<boolean>) => {
    if (!(await login())) throw new Error("login required");
    const { downloadUrl } = await api.downloadUrl(job.jobId);
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const blob = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(blob)) !== job.evidenceSha256) throw new Error("hash differs from the one recorded on-chain");
    if (onBytes && !(await onBytes(blob))) return null;
    const kp =
      envelopeKeyVersion(blob) === 2
        ? await ensureEncryptionKey()
        : await deriveEncryptionKeypair(wallet!, signMessage!, 1); // old report (v1 key)
    return decryptReport(blob, kp);
  };
}

function ReportDownload({ job }: { job: JobView }) {
  const open = useReportOpener(job);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const out = await open();
            if (out) setDownload({ url: URL.createObjectURL(out.file), name: out.fileName });
            setMsg("Hash matches the on-chain record; report decrypted in your browser.");
          } catch (e: any) {
            setMsg(e.message ?? String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download className="w-3.5 h-3.5" /> Download and decrypt report
      </Button>
      {download && (
        <a href={download.url} download={download.name} className="underline">
          {download.name}
        </a>
      )}
      {msg && <span className="text-slate-300">{msg}</span>}
    </div>
  );
}

function EvidenceSubmit({ job, busy, onSubmit }: { job: JobView; busy: boolean; onSubmit: (f: File) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2 text-xs">
      <div className="flex items-center gap-2 font-semibold text-white">
        <Upload className="w-4 h-4 text-solana-green" /> Deliver report
      </div>
      <p className="text-slate-400">
        {HAS_API
          ? "The report is encrypted in your browser (only the client, you and the arbiter can open it), uploaded to S3, and the SHA-256 of the encrypted file goes on-chain."
          : "On-chain-only mode: the file's SHA-256 is recorded on-chain; deliver the file to the client through the agreed channel."}
      </p>
      <input
        type="file"
        onChange={async (e) => {
          const f = e.target.files?.[0] ?? null;
          setFile(f);
          setHash(f ? await sha256Hex(await f.arrayBuffer()) : null);
        }}
        className="w-full text-xs text-slate-400 file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200"
      />
      {hash && <p className="font-mono text-[10px] text-slate-500 break-all">Original SHA-256: {hash}</p>}
      <Button variant="success" className="w-full" busy={busy} disabled={!file} onClick={() => file && onSubmit(file)}>
        Record evidence on-chain ({job.jobId})
      </Button>
    </div>
  );
}

function ReviewBox({
  job,
  reviewOpen,
  busy,
  onApprove,
  onDispute,
}: {
  job: JobView;
  reviewOpen: boolean;
  busy: string | null;
  onApprove: () => void;
  onDispute: () => void;
}) {
  const openReport = useReportOpener(job);
  const [verified, setVerified] = useState<null | boolean>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);

  const verifyBytes = async (bytes: ArrayBuffer | Uint8Array) => {
    const h = await sha256Hex(bytes);
    const ok = h === job.evidenceSha256;
    setVerified(ok);
    setMessage(ok ? "Hash matches the on-chain record." : `Hash differs from the on-chain one (${h.slice(0, 16)}…).`);
    return ok;
  };

  const fetchAndVerify = async () => {
    setChecking(true);
    setMessage(null);
    try {
      const out = await openReport(verifyBytes);
      if (!out) return;
      setDownload({ url: URL.createObjectURL(out.file), name: out.fileName });
      setMessage("Hash matches the on-chain record and the report was decrypted in your browser.");
    } catch (e: any) {
      setMessage(e.message ?? String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 space-y-2 text-xs">
      <div className="flex items-center gap-2 font-semibold text-amber-200">
        <ShieldAlert className="w-4 h-4" /> Review evidence
      </div>
      <div className="flex flex-wrap gap-2">
        {HAS_API ? (
          <Button variant="ghost" busy={checking} onClick={fetchAndVerify}>
            <Download className="w-3.5 h-3.5" /> Download, verify hash and decrypt
          </Button>
        ) : (
          <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
            <span className="bg-slate-800 px-3 py-2 rounded-lg font-bold">Verify received file</span>
            <input type="file" className="hidden" onChange={async (e) => e.target.files?.[0] && verifyBytes(await e.target.files[0].arrayBuffer())} />
          </label>
        )}
        {download && (
          <a href={download.url} download={download.name} className="inline-flex items-center gap-1.5 text-xs font-bold px-3.5 py-2 rounded-lg bg-slate-800 text-white">
            <FileCheck className="w-3.5 h-3.5" /> {download.name}
          </a>
        )}
      </div>
      {message && (
        <p className={`flex items-center gap-1.5 ${verified ? "text-solana-green" : "text-amber-200"}`}>
          {verified ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} {message}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="success" className="flex-1" busy={busy === "approve"} onClick={onApprove}>
          <CheckCircle2 className="w-3.5 h-3.5" /> Approve and release
        </Button>
        {reviewOpen && (
          <Button variant="danger" busy={busy === "dispute"} onClick={onDispute}>
            Dispute
          </Button>
        )}
      </div>
      <p className="text-[10px] text-slate-500">
        With no approval or dispute by the end of the window, the researcher can claim the payment.
      </p>
    </div>
  );
}

function ArbiterBox({ job, busy, onResolve }: { job: JobView; busy: boolean; onResolve: (bps: number) => void }) {
  const [pct, setPct] = useState(50);
  return (
    <div className="space-y-2">
      <label className="block text-slate-300">
        To the researcher: <b>{pct}%</b> ({((baseToUsdc(job.amount) * pct) / 100).toFixed(2)} USDC) · the client receives the rest
        <input type="range" min={0} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="w-full" />
      </label>
      <Button busy={busy} onClick={() => onResolve(pct * 100)}>
        <Gavel className="w-3.5 h-3.5" /> Resolve dispute
      </Button>
    </div>
  );
}
