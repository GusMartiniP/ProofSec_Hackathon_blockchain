# ProofSec — Handoff para o Antigravity (orquestrador) · 2026-10-02

Este arquivo diz **onde o projeto está e o que fazer agora**. O que o sistema é está em
`CONTEXT_FOR_CLAUDE.md` (vale para qualquer agente). As regras estão em `AGENTS.md`
(raiz + um por área) e prevalecem sobre este arquivo.

## 1. Situação em uma frase

O código das quatro partes (contrato, backend AWS, frontend, agente) está escrito, revisado
e com os achados de segurança corrigidos, mas **nada foi compilado nem implantado**: nem o
programa na devnet, nem a stack na AWS. A conta AWS ainda não foi escolhida; será a do dono
do projeto, usada pela AWS CLI da máquina dele (nenhuma conta está configurada no repo).

## 2. Leia nesta ordem

1. `AGENTS.md` (raiz) e o `AGENTS.md` da área da tarefa.
2. `CONTEXT_FOR_CLAUDE.md` — visão do sistema (contas, instruções, rotas, segredos).
3. `docs/security-review.md` — status PS-01..PS-19 e backlog por agente.
4. `docs/decisions.md` — ADR-001..018 (P1–P6 viraram ADR-012..017; ADR-018 = regra de layout).
5. `docs/runbook.md` — segredos no SSM, ordem de deploy, incidentes.

## 3. O que foi feito na rodada de 2026-10-02

- **Contrato (Codex):** aceite só do pesquisador atribuído (PS-01); `dispute_deadline` +
  `resolve_dispute_timeout` 50/50 (PS-02); `initialize_config` só pela upgrade authority
  (PS-03); árbitro, taxa e prazo de disputa congelados no job (PS-04); jobs do agente sem
  pesquisador e revisão ≥ 72 h (PS-05); `rent_payer` (PS-14); testes com `surfnet_timeTravel`
  no lugar de `sleep` (PS-16). Novos campos entraram **antes** de `job_id` (ADR-018).
- **Backend (Kiro):** login SIWS com domínio permitido e tabela de nonces com TTL (PS-09);
  segredos no SSM SecureString (PS-07); throttling por rota e cota no `propose` (PS-08); IAM
  explícito por função (PS-10); logs com retenção, SNS, DLQ, alarmes, PITR, orçamento,
  CloudTrail opcional e `Rules` que barram valores de dev em prod (PS-11); RPC de fallback
  (PS-13); candidaturas (`POST /jobs/{id}/apply`); alertas de job do agente, evidência,
  disputa e mudança de `Config` (PS-05); `samconfig.toml`.
- **Agente (Claude Code):** `core.ts` compartilhado por CLI (`executor.ts`) e Lambda
  (`lambda.ts`, stack opcional `agent/template.yaml`, chave no SSM) (ADR-012). Checa
  política e delegate antes de assinar, nunca reenvia às cegas, recusa definitiva vai para
  revisão humana (`POST /agent/proposals/{id}/rejected` → `NEEDS_HUMAN`).
- **Frontend (Claude Code):** chamadas no layout novo; candidatura e atribuição; botão de
  timeout 50/50; árbitro vindo do job; chave de criptografia v2 ligada à origem (PS-06,
  ADR-017); CSP e headers em `next.config.mjs` (PS-12); aviso de delegate único (PS-15).
- **Docs/regras:** `security-review.md`, `decisions.md`, `runbook.md`, `resilience.md`,
  todos os `AGENTS.md`, `README.md` e `CONTEXT_FOR_CLAUDE.md` atualizados.

## 4. O que já foi verificado (sem rede; registries bloqueados no ambiente da revisão)

| Verificação | Resultado | Como rodar |
|---|---|---|
| Testes do backend | 72 OK | `npm run test:backend` |
| Testes do executor (rede injetada) | 14 OK; mutação 7/7 detectada | `npm run test:agent` |
| IDL provisório × Rust | confere | `python contracts/scripts/gen_idl_preview.py --check` |
| Templates SAM (refs, condições, rotas, IAM derivado do código) | backend: 48 recursos/16 rotas OK; executor: 7 recursos OK | `npm run check:templates` |
| Tipos do frontend e do agente | OK (com stubs das libs) | `npm --prefix frontend run typecheck` |
| Bundle da Lambda do executor (esbuild, `.cjs`) | carrega, lê o SSM | `cd agent && sam build` |
| Criptografia v2 | determinística, por origem, v1≠v2, round-trip | revisão manual |

Dois bugs reais achados na revisão: o `template.yaml` antigo era YAML inválido (rotas com
`{param}` dentro de `{ }`), e o bundle CJS do executor seria lido como ESM por causa do
`"type": "module"` (agora sai como `lambda.cjs`).

## 5. Riscos para conferir no primeiro build (PS-17)

- Import de `ProgramData` pelo prelude do Anchor 1.2.
- Surfpool implantando o programa como upgradeable com a carteira do provider como
  autoridade (`[test] upgradeable = true`). Se falhar: `anchor test --validator legacy`
  (os testes de relógio são pulados).
- Semântica de `#[account(mut, dup)]` no `treasury_token_account`.
- SAM aceitar `RouteSettings` e `LoggingConfig` como escritos; `sam build` exige Python 3.12
  local (ou `--use-container`).

## 6. Próximas tarefas (ordem, dono, critério de aceite)

**Fase A — validar (nada aqui pede aprovação)**

| # | Dono | Tarefa | Aceite |
|---|---|---|---|
| A0 | Antigravity | Atualizar `docs/program-design.md` (layout novo: arbiter 236 … job_id 318; `resolve_dispute_timeout`; P-7 e P-11 resolvidos; taxa congelada), `docs/architecture.md` (SSM, SNS, SQS, Nonces, executor em stack própria; `executor.ts` → `core.ts`) e `docs/threat-model.md` (T4–T11 apontando para as correções) | docs batem com o código |
| A1 | Codex | `cd contracts && anchor build && anchor test` | build limpo; testes passam; resultado registrado no PS-17 |
| A2 | Kiro | `npm run test:backend`, `sam validate --lint`, `sam build` | sem erro de lint; build OK |
| A3 | Claude Code | `npm install && npm run build` (frontend); `npm install && npm test && npm run typecheck` (agent) | builds e testes OK |
| A4 | Antigravity | Revisão independente de A1–A3; novos achados no formato do `security-review.md` | PS-17 → Corrigido ou achados abertos |

**Fase B — deploy em dev**

| # | Dono | Tarefa | Aprovação |
|---|---|---|---|
| B1 | Dono do projeto | Escolher a conta AWS (ideal: separada, IAM Identity Center + MFA, nunca root) e a região; `aws configure sso`; carteira dev com SOL de devnet | — |
| B2 | Codex | `anchor keys sync`, `anchor build` (sincroniza o IDL), `anchor deploy --provider.cluster devnet`; inicializar a `Config` com a carteira do deploy | permitido em devnet |
| B3 | Kiro | Criar os segredos no SSM (runbook §2) → `sam deploy --no-execute-changeset` → revisar o changeset | **executar o changeset exige aprovação humana** |
| B4 | Claude Code | `.env.local` do frontend (`NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_API_URL`) e smoke test do runbook §2.6 | — |
| B5 | Claude Code + Kiro | Executor: CLI primeiro; depois a stack `agent/template.yaml` | changeset com IAM exige aprovação |

**Fase C — pendências menores (não bloqueiam a demo)**

- Troca automática de RPC na UI (PS-13, parte frontend).
- `tests/api-security` (caixa-preta, pula sem `API_URL`).
- Headers de segurança no host se o frontend for export estático (CloudFront/Amplify).
- Atualizar `docs/ProofSec_Manual_Tecnico.pdf` (não mostra timeout de disputa, Nonces/SSM/SNS/DLQ nem o executor Lambda).
- Roteiro da demo e pitch do hackathon. V2: Squads (árbitro/tesouraria), SAS, USDC+.

## 7. Contratos entre áreas que não podem quebrar

- **IDL:** gerado pelo `anchor build` e copiado pelo hook; nunca editar `frontend/src/idl` nem `agent/idl` à mão.
- **Layout do `JobAccount`:** offsets lidos em `backend-serverless/functions/common/solana.py`
  (teste `test_layout_matches_rust_offsets`). Campo novo só antes de `job_id`, e depois do
  primeiro deploy, com migração.
- **API HTTP:** `backend-serverless/template.yaml` ↔ `frontend/src/lib/api.ts` ↔ `agent/core.ts`.
- **Segredos:** nomes `/proofsec/<stage>/{jwt-secret, agent-api-key, anthropic-api-key, agent-keypair}`
  usados pelos dois templates e pelo código.
- **ID do programa:** `PrfSec111…` é provisório; depois do deploy, trocar em `declare_id!`,
  `Anchor.toml`, IDL (via build), `.env` do frontend e parâmetro `ProgramId` das stacks.

## 8. Lembretes de governança

Quem escreve não revisa. Deploy fora de dev, IAM, troca de autoridades e qualquer coisa com
fundos reais pedem aprovação humana (`AGENTS.md` §5). Nunca criar `CLAUDE.md`. Nunca
commitar keypairs, `.env*` ou segredos. Toda tarefa termina com handoff: o que mudou,
testes rodados, riscos abertos, docs atualizados.

## 9. Handoff — correções da revisão estática AWS (2026-10-05/06)

- **Alterado:** templates restritos a devnet; hardening aplicado também a `staging`;
  eventos GuardDuty/Security Hub limitados à conta
  local; tamanho do PUT S3 incluído na assinatura; consultas DynamoDB agora percorrem todas
  as páginas; eventos do agente idempotentes e em lote; candidatura atômica; validação de
  JWT/JSON/valores reforçada; alarmes para falhas absorvidas; erros S3 distinguidos de 404;
  documentação histórica e de operação reconciliada.
- **IAM:** com aprovação humana, `ApplyJobFunction` trocou `dynamodb:PutItem` por
  `dynamodb:UpdateItem`; a permissão continua limitada à tabela Jobs. Nenhuma outra ampliação.
- **Testes adicionados/ativados:** regressões para `ContentLength`, entradas malformadas,
  paginação além de 100 itens, corrida de candidatura, JWT adversarial, idempotência/lote do
  EventBridge, severidade e chave curta do executor.
- **Validação executada:** `npm run preflight:local` — backend 72/72; agente 14/14 e
  typecheck; checker offline dos dois templates; bundle Node 22 carregando `handler`; typecheck
  e build estático do frontend; IDL provisório conferido contra o Rust. Auditoria npm offline
  de frontend e agente não encontrou vulnerabilidades (resultado limitado ao cache local).
- **Riscos abertos:** PS-17 continua aberto (`sam validate --lint`, `sam build`, demais builds
  Anchor e cold start real do executor); CloudFront+WAF continua sendo o controle futuro para limite por IP.
  Não houve deploy, execução de changeset nem contato com uma conta AWS.
- **Docs atualizados:** `README.md`, `ANALISE_TECNICA_PROOFSEC.md`, `docs/runbook.md`,
  `docs/security-review.md`, `docs/resilience.md` e `backend-serverless/AGENTS.md`.
- **Revisão:** PS-25–PS-31 e as alterações desta rodada aguardam revisão independente, pois o
  autor da correção não pode aprovar a própria mudança.

## 10. Handoff — preparação sem conta AWS (2026-10-06)

- **Automação local:** `npm run preflight:local` concentra todas as verificações que não
  dependem de AWS, Solana CLI ou credenciais; executado com sucesso.
- **Fail-closed do executor:** `ScheduleState` agora começa `DISABLED` no template e no
  `samconfig.toml`; habilitação só depois dos segredos, delegate, policy e rodada manual.
- **Ferramentas ausentes neste host:** AWS CLI, SAM CLI, Docker, Rust/Cargo, Solana CLI e
  Anchor. Por isso `sam validate/build` e `anchor build/test` continuam pendentes.
- **Contratos:** `contracts/` ainda não tem `package-lock.json`; a tentativa offline de gerar
  um lock falhou porque o cache npm não contém `@anchor-lang/core`. Resolver junto da instalação
  do toolchain, com acesso ao registry, antes de `anchor test`.
- **Conta amanhã:** usar IAM Identity Center + MFA, confirmar `aws sts get-caller-identity`,
  escolher região, criar SecureStrings, gerar changeset sem executar e pedir aprovação antes
  de qualquer execução.
