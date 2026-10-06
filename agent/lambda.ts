/**
 * Executor do agente como Lambda agendada (ADR-012 / P4). Stack separada e
 * opcional: agent/template.yaml.
 *
 * - A chave do agente e a x-agent-key ficam no SSM Parameter Store (SecureString);
 *   só o role desta função pode lê-las. Nada de segredo em variável de ambiente.
 * - Cada invocação processa as propostas uma vez. Concorrência não abre escrow em
 *   dobro: o PDA do job é único e `init` falha se já existir.
 * - Kill switch: desabilitar o agendamento (ScheduleState=DISABLED) ou desativar a
 *   AgentPolicy on-chain no painel da empresa.
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createExecutor, jsonLogger, parseOwnerList, type RunSummary } from "./core.js";

const SECRETS_TTL_MS = 5 * 60_000;
const ssm = new SSMClient({});
let cache: { agent: Keypair; apiKey: string; loadedAt: number } | undefined;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`variável ${name} não definida`);
  return v;
}

async function getParameter(name: string): Promise<string> {
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`parâmetro SSM vazio: ${name}`);
  return value;
}

async function loadSecrets() {
  if (cache && Date.now() - cache.loadedAt < SECRETS_TTL_MS) return cache;
  const [keypairJson, apiKey] = await Promise.all([
    getParameter(env("AGENT_KEYPAIR_PARAM")),
    getParameter(env("AGENT_API_KEY_PARAM")),
  ]);
  const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairJson)));
  cache = { agent, apiKey, loadedAt: Date.now() };
  return cache;
}

export async function handler(): Promise<RunSummary> {
  const { agent, apiKey } = await loadSecrets();
  const executor = createExecutor({
    apiUrl: env("API_URL"),
    apiKey,
    rpcUrls: [env("SOLANA_RPC_URL"), process.env.SOLANA_RPC_URL_FALLBACK ?? ""],
    programId: new PublicKey(env("PROGRAM_ID")),
    agent,
    usdcMint: process.env.USDC_MINT ? new PublicKey(process.env.USDC_MINT) : undefined,
    allowedOwners: parseOwnerList(process.env.ALLOWED_OWNERS),
    cluster: process.env.CLUSTER ?? "devnet",
    log: jsonLogger,
  });
  const summary = await executor.runOnce();
  jsonLogger("info", "executor_run", { agent: agent.publicKey.toBase58(), ...summary });
  return summary;
}
