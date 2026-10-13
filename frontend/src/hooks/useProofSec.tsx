"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Idl, Program } from "@anchor-lang/core";
import bs58 from "bs58";
import { api, currentSession, login as apiLogin, logout as apiLogout, type JobMeta } from "@/lib/api";
import { keyBindingMessage } from "@/lib/keybinding";
import { HAS_API } from "@/lib/config";
import { deriveEncryptionKeypair, type EncryptionKeypair } from "@/lib/evidence";
import {
  fetchAllJobs,
  fetchConfig,
  friendlyError,
  getProgram,
  getReadonlyProgram,
  type OnchainJob,
  type PlatformConfig,
} from "@/lib/program";

export interface JobView extends OnchainJob {
  meta?: JobMeta;
}

export interface Notice {
  kind: "info" | "success" | "error";
  text: string;
  tx?: string;
}

interface Ctx {
  program: Program<Idl>;
  wallet: string | null;
  canSign: boolean;
  config: PlatformConfig | null;
  configLoaded: boolean;
  jobs: JobView[];
  offchain: JobMeta[]; // drafts and agent proposals not yet on-chain
  loading: boolean;
  refresh: () => Promise<void>;
  loggedIn: boolean;
  login: () => Promise<boolean>;
  logout: () => void;
  ensureEncryptionKey: () => Promise<EncryptionKeypair>;
  notice: Notice | null;
  notify: (n: Notice | null) => void;
  /** Runs an action with standard feedback. Returns the result, or null on error. */
  run: <T>(label: string, fn: () => Promise<T>, opts?: { txFrom?: (r: T) => string | undefined }) => Promise<T | null>;
  now: number;
}

const ProofSecContext = createContext<Ctx | null>(null);

export function ProofSecProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const program = useMemo(
    () => (anchorWallet ? getProgram(connection, anchorWallet) : getReadonlyProgram(connection)),
    [connection, anchorWallet]
  );

  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [offchain, setOffchain] = useState<JobMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, notify] = useState<Notice | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setLoggedIn(Boolean(currentSession(wallet)));
  }, [wallet]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, onchain] = await Promise.all([fetchConfig(program), fetchAllJobs(program)]);
      setConfig(cfg);
      setConfigLoaded(true);

      let metas: JobMeta[] = [];
      if (HAS_API) {
        try {
          const [publicList, mine] = await Promise.all([
            api.listJobs(),
            // Drafts/proposals only come with an authenticated session (private endpoint)
            wallet && currentSession(wallet) ? api.myJobs() : Promise.resolve([] as JobMeta[]),
          ]);
          const byId = new Map<string, JobMeta>();
          [...publicList, ...mine].forEach((j) => byId.set(j.jobId, j));
          metas = Array.from(byId.values());
        } catch (e) {
          console.warn("API unavailable, using on-chain data only:", e);
        }
      }
      const metaByKey = new Map(metas.map((mt) => [`${mt.clientWallet}:${mt.jobId}`, mt]));
      const views = onchain
        .map((j) => ({ ...j, meta: metaByKey.get(`${j.client}:${j.jobId}`) }))
        .sort((a, b) => b.deadline - a.deadline);
      const onchainKeys = new Set(onchain.map((j) => `${j.client}:${j.jobId}`));
      setJobs(views);
      setOffchain(
        metas.filter(
          (mt) =>
            mt.status !== "ONCHAIN" &&
            mt.clientWallet === wallet &&
            !onchainKeys.has(`${mt.clientWallet}:${mt.jobId}`)
        )
      );
    } catch (e) {
      setConfigLoaded(true);
      notify({ kind: "error", text: `Failed to read the chain: ${friendlyError(e)}` });
    } finally {
      setLoading(false);
    }
  }, [program, wallet, loggedIn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async () => {
    if (!HAS_API) return false;
    if (!wallet || !signMessage) {
      notify({ kind: "error", text: "Connect a wallet that supports message signing." });
      return false;
    }
    if (currentSession(wallet)) return true;
    try {
      await apiLogin(wallet, signMessage);
      setLoggedIn(true);
      return true;
    } catch (e) {
      notify({ kind: "error", text: `Login failed: ${friendlyError(e)}` });
      return false;
    }
  }, [wallet, signMessage]);

  const logout = useCallback(() => {
    apiLogout();
    setLoggedIn(false);
  }, []);

  const ensureEncryptionKey = useCallback(async () => {
    if (!wallet || !signMessage) throw new Error("connect your wallet");
    const kp = await deriveEncryptionKeypair(wallet, signMessage);
    if (HAS_API) {
      let published: string | null = null;
      try {
        published = await api.getEncryptionKey(wallet);
      } catch {
        published = null;
      }
      if (published !== kp.publicKeyB64) {
        if (!(await login())) throw new Error("login required to publish the key");
        // Proof of possession (PS-38): whoever encrypts to this wallet checks this signature
        const proof = await signMessage(new TextEncoder().encode(keyBindingMessage(wallet, kp.publicKeyB64)));
        await api.putEncryptionKey(kp.publicKeyB64, bs58.encode(proof));
      }
    }
    return kp;
  }, [wallet, signMessage, login]);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, opts?: { txFrom?: (r: T) => string | undefined }) => {
      notify({ kind: "info", text: `${label}…` });
      try {
        const r = await fn();
        const isSig = (v: unknown) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v);
        const tx = opts?.txFrom ? opts.txFrom(r) : isSig(r) ? (r as string) : undefined;
        notify({ kind: "success", text: `${label}: done.`, tx });
        refresh();
        return r;
      } catch (e) {
        console.error(e);
        notify({ kind: "error", text: `${label}: ${friendlyError(e)}` });
        return null;
      }
    },
    [refresh]
  );

  const value: Ctx = {
    program,
    wallet,
    canSign: Boolean(anchorWallet),
    config,
    configLoaded,
    jobs,
    offchain,
    loading,
    refresh,
    loggedIn,
    login,
    logout,
    ensureEncryptionKey,
    notice,
    notify,
    run,
    now,
  };
  return <ProofSecContext.Provider value={value}>{children}</ProofSecContext.Provider>;
}

export function useProofSec() {
  const ctx = useContext(ProofSecContext);
  if (!ctx) throw new Error("useProofSec used outside ProofSecProvider");
  return ctx;
}
