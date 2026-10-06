/**
 * CLI do executor do agente ("mãos"). Mesma lógica da Lambda (core.ts).
 *
 *   npm run keygen          # gera agent-keypair.json e mostra a pubkey
 *   npm run executor        # loop (a cada POLL_SECONDS)
 *   npm run executor:once   # processa uma vez e sai
 *
 * Variáveis: API_URL, AGENT_API_KEY, RPC_URL, RPC_URL_FALLBACK (opcional),
 *            PROGRAM_ID (opcional, padrão = IDL), USDC_MINT (opcional),
 *            ALLOWED_OWNERS (opcional: pubkeys das empresas permitidas, separadas por vírgula; PS-39),
 *            AGENT_KEYPAIR (padrão ./agent-keypair.json), POLL_SECONDS (padrão 20),
 *            CLUSTER (padrão devnet, só para links do explorer)
 *
 * A chave fica fora do git (.gitignore) e só precisa de SOL para rent e taxas.
 * Em produção use a Lambda (agent/template.yaml), com a chave no SSM.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createExecutor, parseOwnerList, type Logger } from "./core.js";
import idl from "./idl/proofsec.json" with { type: "json" };

const KEYPAIR_PATH = process.env.AGENT_KEYPAIR ?? "./agent-keypair.json";
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 20);

const humanLogger: Logger = (level, event, fields = {}) => {
  const details = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  const line = `[executor] ${level === "info" ? "" : level.toUpperCase() + " "}${event} ${details}`.trim();
  if (level === "error") console.error(line);
  else console.log(line);
};

function loadKeypair(): Keypair {
  if (!existsSync(KEYPAIR_PATH)) throw new Error(`keypair não encontrado em ${KEYPAIR_PATH} (rode npm run keygen)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"))));
}

async function main() {
  if (process.argv.includes("--keygen")) {
    if (existsSync(KEYPAIR_PATH)) throw new Error(`${KEYPAIR_PATH} já existe`);
    const kp = Keypair.generate();
    writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.log(`Chave do agente criada em ${KEYPAIR_PATH}\nPubkey: ${kp.publicKey.toBase58()}`);
    console.log("Use esta pubkey no painel 'Política do agente' e envie ~0,1 SOL de devnet para ela (rent e taxas).");
    return;
  }

  const apiUrl = process.env.API_URL ?? "";
  const apiKey = process.env.AGENT_API_KEY ?? "";
  if (!apiUrl || !apiKey) throw new Error("defina API_URL e AGENT_API_KEY");

  const agent = loadKeypair();
  const programId = new PublicKey(process.env.PROGRAM_ID ?? (idl as any).address);
  const executor = createExecutor({
    apiUrl,
    apiKey,
    rpcUrls: [process.env.RPC_URL ?? "https://api.devnet.solana.com", process.env.RPC_URL_FALLBACK ?? ""],
    programId,
    agent,
    usdcMint: process.env.USDC_MINT ? new PublicKey(process.env.USDC_MINT) : undefined,
    allowedOwners: parseOwnerList(process.env.ALLOWED_OWNERS),
    cluster: process.env.CLUSTER ?? "devnet",
    log: humanLogger,
  });
  humanLogger("info", "start", { agent: agent.publicKey.toBase58(), program: programId.toBase58() });

  do {
    try {
      const summary = await executor.runOnce();
      humanLogger("info", "run", summary);
    } catch (e: any) {
      humanLogger("error", "run_failed", { error: String(e?.message ?? e) });
    }
    if (process.argv.includes("--once")) break;
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  } while (true);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
