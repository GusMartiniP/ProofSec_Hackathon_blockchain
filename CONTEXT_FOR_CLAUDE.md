# ProofSec — Contexto para assistentes de IA (v0.4, 2026-10-06)

## O que é

MVP para o hackathon **Superteam Brasil / Colosseum (Solana)**: **escrow programável para contratação de segurança ofensiva** (pentest/auditoria; bug bounty na V2).

- **Empresa:** trava USDC num vault PDA e registra on-chain o hash do escopo autorizado (autorização formal do teste).
- **Pesquisador:** se candidata, é atribuído pelo cliente, aceita, entrega o relatório cifrado e registra o SHA-256 on-chain.
- **Liquidação:** aprovação do cliente · **liberação automática** quando a janela de revisão termina · **disputa** decidida pelo árbitro do job · se o árbitro não decidir até `dispute_deadline`, qualquer um aplica **50/50**.
- **Agente de IA:** alertas (GuardDuty/Security Hub) → propostas de pentest. Orçamento por tabela determinística; a LLM só redige texto. O executor usa uma chave **sem custódia**, limitada on-chain pela `AgentPolicy`; jobs do agente nascem sem pesquisador e com revisão ≥ 72 h.

## Stack

| Camada | Tecnologia |
|---|---|
| Contrato | Solana + **Anchor 1.2.x** (Rust), SPL Token `transfer_checked`. `init-if-needed` só em `set_agent_policy`; ATAs de destino são criadas pelos clientes (idempotente) |
| Backend | AWS SAM: HTTP API (throttling, access logs) + Lambda authorizer (SIWS → JWT), Lambdas Python 3.12 **sem dependências externas**, DynamoDB (Jobs, Users, Nonces+TTL), S3 (blobs cifrados), SSM SecureString (segredos), SNS (alertas), SQS (DLQ), alarmes, orçamento, CloudTrail opcional |
| Frontend | Next.js 16.4 (App Router, webpack) + React 18.3 + Tailwind + `@anchor-lang/core` + wallet-adapter (Wallet Standard) + tweetnacl; export estático e CSP em `next.config.mjs` |
| Agente | Cérebro: `backend-serverless/functions/agent.py`. Mãos: `agent/core.ts` via CLI (`executor.ts`) ou Lambda agendada (`lambda.ts`, stack separada `agent/template.yaml`) |
| Rede | Devnet; USDC da Circle `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## Programa (`contracts/programs/proofsec/src`)

- `Config` `["config"]`: admin, arbiter, treasury, fee_bps (≤ 10%), allowed_mint, dispute_period. Criada **só pela upgrade authority** (PS-03).
- `JobAccount` `["job", client, job_id]`: offsets fixos (client 8 … status 232, arbiter 236, rent_payer 268, fee_bps 300, dispute_period 302, dispute_deadline 310) e `job_id` no fim (318). Campos novos entram **antes** de `job_id` (ADR-018). Árbitro, taxa e prazo de disputa são **congelados** na criação (PS-04).
- `AgentPolicy` `["policy", owner]`; vault `["vault", client, job_id]` com autoridade = PDA do job.
- 15 instruções: `initialize_config`, `update_config`, `set_agent_policy`, `initialize_job`, `initialize_job_by_agent`, `assign_researcher`, `accept_job`, `submit_evidence`, `approve_and_release`, `claim_after_review`, `open_dispute`, `resolve_dispute(bps)`, `resolve_dispute_timeout`, `refund_expired`, `cancel_job`.
- Status: `Open → InProgress → EvidenceSubmitted → (Completed | Disputed → Resolved)`, além de `Refunded` e `Cancelled`. O rent volta para quem pagou (`rent_payer`).
- IDL real: `anchor build` + hook `post_build` (`scripts/sync-idl.mjs`). `scripts/gen_idl_preview.py --check` confere o IDL provisório contra o Rust.

## Backend (`backend-serverless/`)

- `status` off-chain: `DRAFT`, `NEEDS_HUMAN`/`AUTO_APPROVED` (propostas), `ONCHAIN` (+ `onchainStatus`). **A chain é a fonte da verdade** (`common/sync.py`).
- Rotas: `POST /auth/nonce` `{wallet, domain, uri}` e `/auth/verify` · `GET /jobs`, `GET /jobs/{id}` (públicos, só on-chain), `GET /jobs/mine` (auth; o cliente vê candidaturas), `POST /jobs`, `POST /jobs/{id}/apply` (auth), `POST /jobs/{id}/sync` · `POST /evidence/upload-url` e `/download-url` (auth; árbitro = o do job) · chaves de criptografia em `/users/...` · `POST /agent/propose` (auth, cota por hora) · `GET /agent/proposals`, `POST /agent/proposals/{id}/executed` e `/rejected` (`x-agent-key`).
- Sem rota: `indexer.handler` (1 min; vigia a `Config`), `evidence.verify_upload` (S3), `agent.on_event` (EventBridge).
- Segredos: SSM `/proofsec/<stage>/{jwt-secret, agent-api-key, anthropic-api-key, agent-keypair}`; env só com nomes.
- Testes: `python -m unittest discover -s tests -v` (95 em 2026-10-06).

## Frontend (`frontend/src`)

`lib/program.ts` (PDAs e wrappers; ATAs criadas antes das liquidações), `lib/api.ts`, `lib/evidence.ts` (chave X25519 **v2 ligada à origem**, v1 só para envelopes antigos), `hooks/useProofSec.tsx`, componentes `JobCard` (candidatura, atribuição, revisão com re-hash, árbitro, timeout 50/50), `CreateJobPanel`, `AgentPanel`, `AdminSetup`. Sem `NEXT_PUBLIC_API_URL` roda em "modo só on-chain".

## Agentes e documentação

- `AGENTS.md` na raiz + um por área. Nunca criar `CLAUDE.md`.
- Papéis: Antigravity orquestra e revisa · Codex = `contracts/` · Claude Code = construção de código e AWS (`frontend/`, `agent/`, `tests/`, `backend-serverless/`, ADR-024; o humano executa o changeset) · Kiro saiu do projeto.
- Docs: `docs/architecture.md`, `program-design.md`, `threat-model.md`, `security-review.md` (status PS-01..PS-51), `resilience.md`, `runbook.md` (segredos, ordem de deploy, incidentes), `decisions.md` (ADR-001..025).

## Pendências

- **Estado validado em 2026-10-06:** contrato 34/34, backend 95/95, executor 18/18, meta/CSP 21/21, tipos, bundle, templates e export estático passam. O backend `proofsec-dev` e o frontend no Amplify estão no ar; o executor continua não implantado.
- **PS-44 e PS-46 corrigidos; PS-45 aberto:** Next.js está em 16.4, mas a cadeia Solana/Anchor ainda tem dependências transitivas vulneráveis. O programa devnet é
  `HCYkSp64qdMRjiCbauEzPhx9VtNGB6fp5NvKdCRb8tjj`; use este valor em
  `NEXT_PUBLIC_PROGRAM_ID` quando a configuração local do frontend for criada. A `Config` devnet
  já existe em `2qX6gWqAiTjLcQCg53UiCpfTnnNgs89GkwbSWfVNRyXQ`.
- Troca automática de RPC na UI (PS-13, parte frontend); `tests/api-security`; republicar no Amplify a CSP PS-47 sem curinga AWS.
- AWS: a sessão atual ainda é root; CloudTrail e WAF não existem; ADR-024 e o template IAM continuam propostos, sem deploy.
- `docs/ProofSec_Manual_Tecnico.pdf` é da rodada anterior (não mostra timeout de disputa, Nonces/SSM/SNS/DLQ nem o executor Lambda).
- V2: árbitro/tesouraria em multisig Squads, atestação de reputação (SAS), vault em USDC+.
