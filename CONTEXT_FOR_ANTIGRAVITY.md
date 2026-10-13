# ProofSec — Handoff para o Antigravity (orquestrador) · atualizado em 2026-10-06

Este arquivo diz **onde o projeto está e o que fazer agora**. O que o sistema é está em
`CONTEXT_FOR_CLAUDE.md` (vale para qualquer agente). As regras estão em `AGENTS.md`
(raiz + um por área) e prevalecem sobre este arquivo.

## 1. Situação em uma frase

O programa e a `Config` estão na devnet; o backend `proofsec-dev` e o frontend no Amplify estão
no ar em `us-east-1`. O executor do agente não foi implantado. A sessão AWS ainda usa root;
CloudTrail e WAF não existem e o e2e com duas carteiras continua pendente.

## 2. Leia nesta ordem

1. `AGENTS.md` (raiz) e o `AGENTS.md` da área da tarefa.
2. `CONTEXT_FOR_CLAUDE.md` — visão do sistema (contas, instruções, rotas, segredos).
3. `docs/security-review.md` — status PS-01..PS-51 e backlog por agente.
4. `docs/decisions.md` — ADR-001..025; ADR-024 continua proposta e ADR-025 está aceita.
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

## 4. O que já foi verificado localmente

| Verificação | Resultado | Como rodar |
|---|---|---|
| Testes do backend | 95 OK | `npm run test:backend` |
| Testes do executor (rede injetada) | 18 OK | `npm run test:agent` |
| IDL provisório × Rust | confere | `python contracts/scripts/gen_idl_preview.py --check` |
| Templates SAM (refs, condições, rotas, IAM derivado do código) | backend: 51 recursos/16 rotas OK; executor: 7 recursos OK | `npm run check:templates` |
| Tipos do frontend e do agente | OK (com stubs das libs) | `npm --prefix frontend run typecheck` |
| Bundle da Lambda do executor (esbuild, `.cjs`) | carrega, lê o SSM | `cd agent && sam build` |
| Criptografia v2 | determinística, por origem, v1≠v2, round-trip | revisão manual |

Dois bugs reais achados na revisão: o `template.yaml` antigo era YAML inválido (rotas com
`{param}` dentro de `{ }`), e o bundle CJS do executor seria lido como ESM por causa do
`"type": "module"` (agora sai como `lambda.cjs`).

## 5. Resultado do primeiro build (PS-17)

- `anchor build` passou; o sync do IDL real não produziu diferença no git.
- `anchor test` passou com **34/34 testes**, incluindo os cenários de relógio e PS-37.
- `sam validate --lint` e `sam build` passaram nos templates do backend e do executor. No
  executor, o PowerShell precisou incluir `agent/node_modules/.bin` no `PATH` para o SAM achar o
  `esbuild` local.
- Backend 95/95, agente 18/18, meta/CSP 21/21, frontend export estático/typecheck e bundle Lambda passam.
- PS-44 e PS-46 foram corrigidos. Permanecem PS-45 (cadeia Solana/Anchor), React 19 e os avisos
  não fatais de `unexpected cfg` emitidos pelos macros Anchor/Solana.

## 6. Próximas tarefas (ordem, dono, critério de aceite)

**Fase A — validar (nada aqui pede aprovação)**

| # | Dono | Tarefa | Aceite |
|---|---|---|---|
| A0 | Antigravity | Atualizar `docs/program-design.md` (layout novo: arbiter 236 … job_id 318; `resolve_dispute_timeout`; P-7 e P-11 resolvidos; taxa congelada), `docs/architecture.md` (SSM, SNS, SQS, Nonces, executor em stack própria; `executor.ts` → `core.ts`) e `docs/threat-model.md` (T4–T11 apontando para as correções) | docs batem com o código |
| A1 | Codex | `cd contracts && anchor build && anchor test` | **Concluído:** build OK; 34/34 testes; PS-17 registrado |
| A2 | Kiro | `npm run test:backend`, `sam validate --lint`, `sam build` | **Concluído:** 95/95; lint e build OK |
| A3 | Claude Code | `npm run build:web`; `npm install && npm test && npm run typecheck` (agent) | **Concluído:** export estático, tipos, 18/18 do executor e 21/21 meta/CSP |
| A4 | Antigravity | Revisão independente de A1–A3; novos achados no formato do `security-review.md` | PS-17, PS-44 e PS-46 fechados; PS-45 aberto; PS-47–PS-51 registrados |

**Fase B — deploy em dev**

| # | Dono | Tarefa | Aprovação |
|---|---|---|---|
| B1 | Dono do projeto | Escolher a conta AWS (ideal: separada, IAM Identity Center + MFA, nunca root) e a região; `aws configure sso`; carteira dev com SOL de devnet | — |
| B2 | Codex | `anchor keys sync`, `anchor build`, `anchor deploy --provider.cluster devnet` e inicialização da `Config` concluídos para `HCYkSp64qdMRjiCbauEzPhx9VtNGB6fp5NvKdCRb8tjj` | concluído em devnet com aprovação humana |
| B3 | Kiro | Backend `proofsec-dev` implantado; dois SecureStrings criados; confirmar drift e e2e | changesets futuros exigem aprovação humana |
| B4 | Claude Code | Frontend publicado no Amplify; republicar build/headers PS-47 e concluir smoke e2e | — |
| B5 | Claude Code + Kiro | Executor: CLI primeiro; depois a stack `agent/template.yaml` | changeset com IAM exige aprovação |

**Fase C — pendências menores (não bloqueiam a demo)**

- Troca automática de RPC na UI (PS-13, parte frontend).
- `tests/api-security` (caixa-preta, pula sem `API_URL`).
- CSP PS-47 preparada localmente; ainda precisa ser republicada no Amplify.
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
- **ID do programa devnet:** `HCYkSp64qdMRjiCbauEzPhx9VtNGB6fp5NvKdCRb8tjj`, sincronizado em
  `declare_id!`, `Anchor.toml`, IDLs gerados e defaults das stacks. A `Config` on-chain
  `2qX6gWqAiTjLcQCg53UiCpfTnnNgs89GkwbSWfVNRyXQ` está inicializada com a carteira dev como
  admin/árbitro/tesouraria, 250 bps, USDC devnet e prazo de disputa de 24 h.

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
- **Validação executada:** `npm run preflight:local` — backend 95/95; agente 18/18 e
  typecheck; checker offline dos dois templates; bundle Node 22 carregando `handler`; typecheck
  e build estático do frontend; IDL conferido contra o Rust. O audit online posterior invalidou
  o resultado offline limitado ao cache e abriu PS-44/45.
- **Riscos abertos:** PS-45 (cadeias Solana/Anchor), React 19 e cold start real do executor;
  CloudFront+WAF continua sendo o controle futuro para limite por IP. O programa, a `Config`,
  o backend e o Amplify foram implantados; o executor continua fora do ar.
- **Docs atualizados:** `README.md`, `ANALISE_TECNICA_PROOFSEC.md`, `docs/runbook.md`,
  `docs/security-review.md`, `docs/resilience.md` e `backend-serverless/AGENTS.md`.
- **Revisão:** PS-25–PS-31 e as alterações desta rodada aguardam revisão independente, pois o
  autor da correção não pode aprovar a própria mudança.

## 10. Handoff — preparação sem conta AWS (2026-10-06)

- **Automação local:** `npm run preflight:local` concentra todas as verificações que não
  dependem de AWS, Solana CLI ou credenciais; executado com sucesso.
- **Fail-closed do executor:** `ScheduleState` agora começa `DISABLED` no template e no
  `samconfig.toml`; habilitação só depois dos segredos, delegate, policy e rodada manual.
- **Ferramentas instaladas:** AWS CLI 2.37.9, SAM CLI 1.166.2 e Docker Desktop 4.94.0 no
  Windows; WSL 3.0.1 + Ubuntu 26.04.1 com Rust 1.99, Agave 3.1.10, Anchor 1.2.0, Surfpool
  1.6.0 e Node 22.22.1. O Docker ainda exige a primeira abertura e aceitação interativa dos
  termos; nenhuma licença foi aceita automaticamente.
- **Validações nativas:** `sam validate --lint`/`sam build` nos dois templates e
  `anchor build`/`anchor test` passaram; contrato 34/34. O `package-lock.json` de contratos já
  existia e permaneceu sem alteração. O audit online abriu PS-44/45; PS-46 foi corrigido e o
  programa foi publicado na devnet e a `Config` foi inicializada após aprovação humana.
- **Conta amanhã:** usar IAM Identity Center + MFA, confirmar `aws sts get-caller-identity`,
  escolher região, criar SecureStrings, gerar changeset sem executar e pedir aprovação antes
  de qualquer execução.
