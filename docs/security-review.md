# Security review — ProofSec

Revisão independente (orquestrador), aplicando as políticas dos `AGENTS.md` ao código.
Última revisão independente: 2026-10-06 · Correções estáticas adicionais: 2026-10-05/06 ·
Escopo: `contracts/`, `backend-serverless/`, `agent/`, `frontend/`.

**Estado da validação local:** o primeiro ciclo completo de build e testes foi concluído
(PS-17). Nesta etapa permanecem pendentes as verificações que exigem uma conta AWS real e a
remediação coordenada das dependências
(PS-44/45), além dos demais achados abertos da tabela.

## Formato obrigatório de achado

ID · Severidade · Componente · Arquivo · Vulnerabilidade · Cenário de ataque · Impacto ·
Remediação · Verificação · Dono · Status.

Severidades: Critical · High · Medium · Low · Info.
Status: Aberto · Em andamento · Corrigido · Aceito (risco aceito, com justificativa).

---

## Status após a rodada de correções (2026-10-06)

Decisões P1–P6 tomadas com os padrões recomendados (ADR-012 a ADR-018, `decisions.md`).
"Corrigido no código" = implementado e verificado localmente; integrações com serviços AWS
reais continuam dependentes da futura conta dev.

| ID | Sev. | Correção | Verificação | Status |
|---|---|---|---|---|
| PS-01 | High | aceite só do pesquisador **atribuído**; candidaturas off-chain (`POST /jobs/{id}/apply`) e o cliente atribui on-chain (ADR-013) | `proofsec.ts` "PS-01"; `test_apply_flow_and_applicants_visibility` | Corrigido no código |
| PS-02 | High | `dispute_deadline` na abertura; `resolve_dispute_timeout` sem signer aplica 50/50 após o prazo (ADR-014) | `proofsec.ts` "PS-02" (time travel) | Corrigido no código |
| PS-03 | Medium | `initialize_config` exige a upgrade authority (`ProgramData`) | `proofsec.ts` "PS-03" | Corrigido no código |
| PS-04 | Medium | `arbiter`, `fee_bps`, `dispute_period` congelados no `JobAccount` (antes de `job_id`, ADR-015/018) | `proofsec.ts` "PS-04"; `test_layout_matches_rust_offsets` | Corrigido no código |
| PS-05 | Medium | jobs do agente sem pesquisador e revisão ≥ 72 h (contrato); executor nunca atribui; alertas SNS em job do agente, evidência e disputa (ADR-016) | `proofsec.ts` "PS-05"; `core.test.ts`; `test_ps05_alerts_on_agent_job_and_evidence` | Corrigido no código |
| PS-06 | Medium | chave v2 com mensagem SIWS ligada à origem; v1 só para envelopes antigos (ADR-017) | teste de derivação (determinística, por origem, v1≠v2, round-trip) | Corrigido no código |
| PS-07 | Medium | segredos no SSM SecureString, lidos em runtime; JWT só em auth/authorizer | checker offline do template (IAM por função derivado do código) | Corrigido no código |
| PS-08 | Medium | throttling por rota no HTTP API + cota por carteira no `propose` | `test_ps08_propose_quota`; template | Corrigido no código · limite por IP = backlog (CloudFront+WAF) |
| PS-09 | Low | tabela de nonces (um item por nonce, TTL, consumo atômico) | `test_ps09_regression_nonce_griefing`, `test_replay_rejected` | Corrigido no código |
| PS-10 | Low | IAM explícito por função (upload só `PutObject`, verify `Get/Delete(+Version)`, etc.) | checker: falta/sobra de permissão = erro (mutação 9/9) | Corrigido no código |
| PS-11 | Low | log groups com retenção, SNS, DLQ, alarmes, PITR, orçamento, CloudTrail opcional | template | Corrigido no código |
| PS-12 | Low | CSP e headers em `next.config.mjs`; replicar no host em export estático | revisão manual | Corrigido no código (host: pendente) |
| PS-13 | Low | fallback de RPC no backend e no executor (uma troca por rodada, sem reenvio cego) | `test_rpc_fallback_*`; `core.test.ts` | Corrigido · **UI: pendente** |
| PS-14 | Info | `rent_payer` no job: o rent volta para quem pagou (agente ou cliente) | `proofsec.ts` "PS-14" | Corrigido no código |
| PS-15 | Info | aviso na UI (um delegate por conta) e checagem do delegate no executor | revisão manual; `core.test.ts` | Corrigido no código |
| PS-16 | Info | `surfnet_timeTravel` no lugar de `sleep` | `proofsec.ts` bloco "dependentes do relógio" | Corrigido no código |
| PS-17 | Info | primeiro `anchor build`/`anchor test`, `sam validate/build`, export estático e testes | contrato 34/34; backend 95/95; agente 18/18; meta/CSP 21/21; frontend build/typecheck; `sam validate --lint` nos dois templates | **Corrigido localmente** |
| PS-18 | Low | `.gitignore` completo | — | Corrigido |
| PS-19 | Info | sem pausa de emergência (ADR-011) | — | Aceito |
| PS-20 | Medium | tamanho do relatório integra a assinatura SigV4 do PUT; entrada malformada retorna 400 | `test_upload_only_for_linked_researcher`; `test_malformed_numeric_and_hash_inputs_are_400` | Corrigido no código · testes OK |
| PS-21 | Medium | backend e executor restritos a devnet; ambientes não-dev rejeitam CORS aberto, localhost, e ProgramId provisório | revisão do template; `sam validate --lint` aprovado nos dois templates | Corrigido localmente · revisão independente pendente |
| PS-22 | Info | documentação esclarece que o indexador de 1 min não usa DLQ; a próxima rodada reconcilia e falhas persistentes disparam alarme | revisão documental | Corrigido no código |
| PS-23 | Medium | consultas das GSIs percorrem `LastEvaluatedKey`, evitando omissão de jobs e propostas após a primeira página | `test_public_listing_does_not_silently_drop_jobs_past_100`; `test_propose_quota_counts_beyond_first_100_items` | Corrigido no código · testes OK |
| PS-24 | Medium | regras GuardDuty/Security Hub limitadas à conta AWS local; findings agregados de outras contas não alimentam a carteira/LLM | revisão do template; `sam validate --lint` e `sam build` aprovados | Corrigido localmente · revisão independente pendente |
| PS-25 | Medium | eventos do agente usam ID determinístico, `PutItem` condicional e processam todo o lote Security Hub | `test_event_batch_is_idempotent` | Confirmado (idempotência); lote sem refiltro → PS-32 |
| PS-26 | Medium | JWT, base64 e corpos JSON malformados são negados sem exceção; `alg`, `exp` finito e `sub` são obrigatórios | `TestAuthorizerRobustness`; `TestHttpHelpers` | Parcial: ainda havia 500 pré-auth → PS-33 (corrigido) |
| PS-27 | Medium | metric filters cobrem 500 convertidos pelo decorator e falhas por item capturadas pelo indexador | revisão do template; `sam validate --lint` e `sam build` aprovados | Confirmado localmente; integração CloudWatch pendente |
| PS-28 | Medium | candidatura usa `UpdateItem` condicional e não regrava snapshot obsoleto sobre estado reconciliado | `test_apply_does_not_overwrite_concurrent_sync`; testes de candidatura | Confirmado; corrida inversa → PS-36 |
| PS-29 | Medium | criação/evidência validam tipos, limites, precisão USDC, inteiros e buffers truncados | `TestCreateJobValidation`; `TestEvidenceInputs`; `TestDecoders` | Parcial: Decimal/CPU/overflow → PS-33 (corrigido) |
| PS-30 | Low | `INFORMATIONAL` vira LOW; chave interna menor que 32 caracteres falha fechada | duas regressões dedicadas | Confirmado (ver PS-32 sobre INFORMATIONAL) |
| PS-31 | Low | download diferencia objeto S3 ausente de indisponibilidade/erro de autorização | `test_download_distinguishes_missing_object_from_s3_outage` | Lógica confirmada; sem `s3:ListBucket` ausência vira 503 → PS-34 |
| PS-32 | Medium | `on_event` processa o lote Security Hub inteiro sem refiltrar severidade, estado do finding nem tamanho; LLM roda antes do dedup `TestReview25to31Regressions` (5 testes de lote) | Corrigido no código · revisão independente pendente |
| PS-33 | Medium | entradas hostis ainda geravam 500 ou CPU alto (JSON com int > 4300 dígitos, `uri` não textual, `Decimal` extremo, assinatura enorme, JWT) | `TestReview25to31Regressions` | Corrigido no código · revisão independente pendente |
| PS-34 | Low | `evidence.download_url` sem `s3:ListBucket`: objeto ausente vira 403 do S3 → 503 e log de erro | `check:template` (IAM derivado do código; mutação detectada) | Corrigido no código · revisão independente pendente |
| PS-35 | Low | regra `Demo` do EventBridge sem guarda de stage | `test_demo_events_only_create_proposals_in_dev_stage` | Corrigido no código · revisão independente pendente |
| PS-36 | Low | `apply_onchain`/`mark_executed`/`mark_rejected` regravam o item inteiro lido antes (perda de candidatura, snapshot antigo da chain) | — | **Aberto** (aceitável no MVP) |
| PS-37 | Medium | contrato: `config.treasury` não é congelada no job e liquidações exigem ATAs (tesouraria, pesquisador, cliente) existentes e não congeladas; sem saída se uma delas travar | `contracts/tests/proofsec.ts` (5 testes PS-37; 3 mutações detectadas) | Corrigido na branch `fix/ps-37-treasury-freeze` · ADR-021 · revisão do Codex pendente |
| PS-38 | Medium | chaves públicas de criptografia vêm do backend sem prova de posse: um backend comprometido troca a chave do cliente/árbitro e lê relatórios (INV-6) | `TestReview25to31Regressions` (2 testes) e `tests/key-binding.test.ts` (3, fixture cruzada Python↔TS) | Corrigido no código · ADR-022 · revisão independente pendente |
| PS-39 | Medium | qualquer carteira com `AgentPolicy` apontando para a chave do agente gasta SOL do agente (rent do `JobAccount` nunca devolvido) | `core.test.ts` (allowlist) e `test_propose_outside_dev_is_manual_unless_company_wallet` | Corrigido fora da chain · ADR-023 · rent do `JobAccount` aceito (ADR-021) |
| PS-40 | Medium | `GET /jobs` devolve todos os jobs, com `scopeDocument` de até ~75 KB cada, numa só resposta (limite de 6 MB) e expõe alvos de pentest publicamente | `TestReview25to31Regressions` (5 testes; 4 mutações detectadas) | Corrigido no código · ADR-020 · revisão independente pendente |
| PS-41 | Low | executor tratava qualquer erro de leitura da ATA como "empresa sem ATA" (recusa definitiva) | `core.test.ts` (2 testes; mutação detectada) | Corrigido no código · revisão independente pendente |
| PS-42 | Medium | frontend assinava o financiamento com valor, prazos, pesquisador e hash do escopo vindos do backend sem conferir | `tests/meta-integrity.test.ts` (6 testes) | Corrigido no código · revisão independente pendente |
| PS-43 | Low | `POST /jobs` sem limite de rascunhos por carteira (spam na tabela e nas listagens) | `test_draft_quota_per_wallet` | Corrigido no código · revisão independente pendente |
| PS-44 | High | frontend fixa Next.js 14.2.35, versão reportada pelo `npm audit` com vulnerabilidades críticas; export estático reduz a superfície de servidor, mas não protege `next dev`/`next start` nem uma futura migração para SSR | `npm audit` (críticos 0), build estático, typecheck e `test:meta` | Corrigido no código (Next 16.4.0) · revisão independente pendente · React 19 pendente |
| PS-45 | Medium | dependências JavaScript compartilhadas de Solana/Anchor carregam cadeias vulneráveis (`toml`, `jayson`, `stream-json`, `uuid`, `bigint-buffer`) nos três workspaces | migração coordenada; não usar `npm audit fix --force` | **Aberto** |
| PS-46 | Medium | Program ID declarado/provisório não coincide com a chave pública gerada em `target/deploy`; o build local passa com aviso, mas o deploy real não pode prosseguir com identidades divergentes | escolher a keypair oficial devnet, sincronizar todas as áreas e regerar IDLs | **Corrigido em devnet (2026-10-06)** |
| PS-47 | Medium | CSP com `connect-src https://*.amazonaws.com`: qualquer bucket/API AWS de terceiros serve de destino de exfiltração do token de sessão | `tests/csp.test.ts` (3); `next.config.mjs`, `customHttp.yml`, `hosting.yaml` | Corrigido no código · exige `NEXT_PUBLIC_REPORTS_BUCKET` no build e novo upload ao Amplify · revisão independente pendente |
| PS-48 | Medium | `contracts/Anchor.toml` com `[provider] cluster = "devnet"`: `anchor test` não sobe validador local e roda (e pode implantar) contra a devnet real | revisão; `contracts/AGENTS.md` | Corrigido no código (cluster padrão `localnet`) · Codex confirma com `anchor test` |
| PS-49 | Low | o agente de revisão escreve no bucket de artefatos do SAM e o `sam deploy` pula o upload de objeto com o mesmo hash: pacote trocado entre revisão e execução seria reaproveitado | `force_upload = true` nos `samconfig.toml`; runbook | Corrigido no código · residual: build/deploy ainda saem da máquina do agente |
| PS-50 | Info | hospedagem do frontend sem WAF nem log de acesso | `hosting.yaml` (`EnableWaf`, `EnableAccessLogs`, desligados por padrão, custo); `unsafe-inline` segue (limitação do Next sem nonce, PS-12) | Mitigação opcional · Amplify em uso não tem WAF/logs |
| PS-52 | Medium | o árbitro (da `Config`, congelado no job) podia ser o cliente ou o pesquisador do mesmo job e decidir a própria disputa; ex.: carteira de deploy usada como empresa ou pesquisador | `initialize_job`, `initialize_job_by_agent`, `assign_researcher` e `accept_job` exigem árbitro ≠ cliente e ≠ pesquisador (`ArbiterConflict`, código 6031); testes `PS-52 regression` (config e agente) | Corrigido e **implantado na devnet** (slot 510483884) · `anchor test` 36/36 · conferido por simulação no programa implantado (ADR-028) |
| PS-51 | Info | `AccessLogSettings.DestinationArn` usava `GetAtt LogGroup.Arn` com `:*`; o API Gateway persiste o ARN sem o sufixo e deixava `proofsec-dev` permanentemente `DRIFTED`, ocultando drift futuro | `test_destination_arn_has_no_log_stream_wildcard`; detecção CloudFormation | Corrigido localmente · próximo changeset dev precisa reconciliar a stack |

### Detalhamento PS-20–PS-24

- **PS-20 · Medium · evidências/S3 · `functions/evidence.py`:** o cliente declarava até
  50 MB, mas esse tamanho não integrava a assinatura; um pesquisador autorizado poderia enviar
  objeto maior e gerar custo antes da remoção assíncrona. `ContentLength` agora é assinado, e
  entrada numérica inválida retorna 400. Verificação: regressões aprovadas na suíte 72/72.
  Dono: Kiro. Status: corrigido no código.
- **PS-21 · Medium · configuração SAM · ambos os templates:** opções de mainnet/testnet e
  defaults não-dev coerentes com devnet permitiam erro operacional contrário ao escopo do MVP.
  A rede foi restrita a devnet, e ambientes não-dev rejeitam CORS aberto, localhost e ProgramId
  provisório. Verificação: `sam validate --lint` e `sam build` aprovados nos dois templates.
  Dono: Kiro. Status: corrigido localmente; integração AWS pendente.
- **PS-22 · Info · resiliência/documentação:** a política dizia que todos os alvos EventBridge
  usavam DLQ, mas o indexador deliberadamente depende da próxima rodada e do alarme persistente.
  A documentação agora explicita essa exceção; não houve mudança de IAM. Verificação: revisão
  documental. Dono: Antigravity. Status: corrigido.
- **PS-23 · Medium · DynamoDB/API:** as queries terminavam na primeira página de 100 itens;
  jobs públicos, a cota do agente e propostas `AUTO_APPROVED` podiam ser omitidos ou ficar
  presos. As três GSIs agora percorrem `LastEvaluatedKey`. Verificação: regressões aprovadas na
  suíte 72/72. Dono: Kiro. Status: corrigido no código.
- **PS-24 · Medium · EventBridge/LLM:** findings agregados de outra conta poderiam ser
  associados à `CompanyWallet` local e enviados ao provedor de LLM. Os padrões agora exigem a
  conta AWS local, inclusive `findings[].AwsAccountId` no Security Hub. Verificação: `sam
  validate --lint` e `sam build` aprovados. Dono: Kiro. Status: corrigido localmente; revisão
  independente e evento AWS real pendentes.

### Detalhamento PS-25–PS-31

- **PS-25 · Medium · agente/EventBridge · `functions/agent.py`, `common/db.py`:** retries
  do EventBridge criavam novas propostas porque o ID era aleatório, e eventos Security Hub
  com vários findings processavam apenas o primeiro. Isso podia duplicar escrows autônomos
  dentro do limite on-chain e perder alertas. O ID agora deriva de origem, finding e carteira;
  a criação é condicional e o lote inteiro é percorrido. Verificação:
  `test_event_batch_is_idempotent`. Dono: Kiro. Status: corrigido no código; revisão
  independente pendente.
- **PS-26 · Medium · autenticação/API · `common/jwt.py`, `common/http.py`:** JSON JWT não
  objeto, `exp` ausente/não finito e corpos/base64 de tipo inválido podiam lançar exceções em
  entrada não autenticada. O decoder valida estrutura, algoritmo, expiração e subject; o
  parser retorna 400 para entradas inválidas. Verificação: `TestAuthorizerRobustness` e
  `TestHttpHelpers`. Dono: Kiro. Status: corrigido no código; revisão independente pendente.
- **PS-27 · Medium · observabilidade · `template.yaml`:** o decorator converte exceções do
  login em HTTP 500 e o indexador captura falhas por item, portanto a métrica nativa
  `AWS/Lambda Errors` permanecia em zero nesses casos. Filtros do log estruturado e alarmes
  específicos agora cobrem ambos. Verificação: revisão estática, `sam validate --lint` e
  `sam build` aprovados. Dono: Kiro. Status: corrigido localmente; integração CloudWatch e
  revisão independente pendentes.
- **PS-28 · Medium · DynamoDB/jobs · `functions/jobs.py`, `common/db.py`, `template.yaml`:**
  `apply` lia e regravava o item inteiro; uma reconciliação concorrente podia ser perdida,
  contrariando a precedência da chain. A candidatura agora é um `UpdateItem` condicional que
  toca somente `applicants`/`updatedAt`; o IAM da função foi ajustado de `PutItem` para
  `UpdateItem` com aprovação humana. Verificação: regressão de corrida e suíte de candidatura.
  Dono: Kiro. Status: corrigido no código; revisão independente pendente.
- **PS-29 · Medium · validação/decoders · `functions/jobs.py`, `evidence.py`,
  `common/solana.py`:** tipos compostos, budget abaixo de uma unidade base, casas decimais
  excedentes, prazos fracionários e buffers curtos podiam produzir 500, dados impossíveis de
  executar on-chain ou truncamento silencioso. Limites e tipos são validados antes do uso.
  Verificação: `TestCreateJobValidation`, `TestEvidenceInputs` e `TestDecoders`. Dono: Kiro.
  Status: corrigido no código; revisão independente pendente.
- **PS-30 · Low · política/segredo interno · `common/policy.py`, `functions/agent.py`:** o
  rótulo Security Hub `INFORMATIONAL` caía no default MEDIUM (budget maior), e uma chave
  interna curta era aceita. Agora `INFORMATIONAL` é LOW e configuração menor que 32
  caracteres falha fechada. Verificação: duas regressões dedicadas. Dono: Kiro. Status:
  corrigido no código; revisão independente pendente.
- **PS-31 · Low · evidências/S3 · `functions/evidence.py`:** qualquer falha de `HeadObject`
  era apresentada como 404, ocultando indisponibilidade, IAM incorreto ou erro do S3. Apenas
  códigos de ausência viram 404; demais falhas são registradas e retornam 503. Verificação:
  `test_download_distinguishes_missing_object_from_s3_outage`. Dono: Kiro. Status: corrigido
  no código; revisão independente pendente.

### Revisão independente PS-25–PS-31 (2026-10-06) e novos achados PS-32–PS-36

Revisor desta rodada: Claude Code (não é o autor das correções PS-25–PS-31; fez a correção
de PS-33, que precisa de revisão por outro agente). Sem deploy e sem acesso à AWS;
naquele ponto, `sam validate`/`sam build` ainda estavam pendentes; foram aprovados depois no
fechamento do PS-17. Suíte backend 78/78 e `check:template` OK.
Invariantes: INV-8 intacto (identidade só vem do authorizer, de `x-agent-key` ou de
`COMPANY_WALLET`; `researcher` no body é alvo de atribuição validado como pubkey, nunca
identidade); INV-1 com ressalva em PS-36; IDL e arquivos gerados não foram tocados.

**Veredito por achado**

| ID | Veredito | Observação |
|---|---|---|
| PS-25 | Confirmado, com novos achados | ID `ag`+30 hex (120 bits) é estável entre retries; `attribute_not_exists` correto; falha no meio do lote é segura porque o retry reprocessa e deduplica. Faltam testes de falha parcial e de LLM antes do dedup (PS-32). `on_event` não usa o retorno (invocação assíncrona). |
| PS-26 | Parcial | `jwt.py` e authorizer corretos para o que cobrem, mas `parse_body` e `/auth/nonce` ainda davam 500 (PS-33). JWTs emitidos por `auth.verify_signature` (`sub` texto, `exp` inteiro) continuam válidos. Validar `sub` como pubkey no authorizer é defesa em profundidade opcional (Info): o token é assinado pelo backend. |
| PS-27 | Confirmado (estático) | Sintaxe dos `FilterPattern` JSON válida; namespace `ProofSec/${Stage}` coerente; `handler=verify_signature` é único no log group compartilhado; 5 falhas em 15 min com o indexador a cada minuto representa falha persistente. Atenção: os filtros dependem de o `print()` JSON sair cru; se alguém ligar `LogFormat: JSON` no `Globals`, deixam de casar. |
| PS-28 | Confirmado | Expressão válida (`size`, `contains`, `attribute_not_exists`); `applicants` ausente é tratado; `researcherWallet` só existe quando atribuído (`solana.py:285` devolve `None` para a chave default e `sync.py:316` descarta `None`). IAM derivado bate com o template. Não testado em DynamoDB real. Corrida inversa em PS-36. |
| PS-29 | Parcial | `deadlineDays` e `budgetUsdc` extremos ainda causavam `decimal.Overflow` (500) e `int(Decimal)` de vários segundos de CPU; `reviewHours` inteiro enorme dava `OverflowError`. Corrigido em PS-33. Compatível com `frontend/src/lib/api.ts` e `CreateJobPanel.tsx` (dias inteiros 1–180, revisão ≥ 0,02 h, USDC com até 6 casas). |
| PS-30 | Confirmado | Rótulos do Security Hub são só INFORMATIONAL/LOW/MEDIUM/HIGH/CRITICAL. Mede caracteres, não bytes (aceitável para segredo ASCII; o runbook pede 32+ caracteres aleatórios). Ver PS-32 sobre INFORMATIONAL. |
| PS-31 | Parcial | Códigos do botocore corretos (`ClientError.response["Error"]["Code"]`) e a resposta não vaza detalhe interno. Mas `HeadObject` de bucket inexistente também devolve `404` sem corpo, indistinguível de objeto ausente, e sem `s3:ListBucket` a ausência vira 403 (PS-34). |

**Contratos entre áreas:** `api.ts` ↔ rotas (`/jobs`, `/jobs/{id}/apply`, `/sync`,
`/evidence/*`, `/agent/propose`) e `agent/core.ts` ↔ `/agent/proposals` (`{proposals}`,
`/executed {jobPda, signature}`, `/rejected {reason}`) estão consistentes. Nenhuma mudança de
contrato nesta rodada. O `jobId` determinístico do agente (`ag`+30 hex, 32 caracteres)
respeita o limite de seed do PDA e a regex `[a-z0-9]{1,32}`.

- **PS-32 · Medium · agente/EventBridge · `functions/agent.py:139-150`, `template.yaml:737-795`:**
  a regra do Security Hub casa se *algum* finding do lote for MEDIUM+, mas `on_event` abre
  proposta para *todos* (inclusive LOW/INFORMATIONAL, `RecordState` ARCHIVED e workflow
  RESOLVED/SUPPRESSED), sem limite de tamanho (até 100 por evento). Cada LOW/MEDIUM vira
  `AUTO_APPROVED` (150/350 USDC), limitado só pela `AgentPolicy` on-chain. Além disso
  `build_proposal` chama o LLM antes do dedup, então cada retry repete o custo e um lote grande
  estoura o timeout de 30 s. Impacto: escrows autônomos para findings fora da intenção da
  regra; custo de LLM. Remediação (precisa de ADR, pois muda política, e de IAM `GetItem` se o
  dedup for antes do LLM): refiltrar por severidade/`RecordState`/`Workflow.Status`, limitar o
  lote (rebaixar o excesso para `NEEDS_HUMAN`) e checar existência antes do LLM. **Corrigido**
  (ADR-019, aprovada pelo dono): filtro de elegibilidade por finding, limite de 10 propostas
  autônomas por evento com alerta SNS, `get_job` antes do LLM e fallback para o template com
  menos de 8 s restantes. IAM da `AgentEventFunction`: +`dynamodb:GetItem` e +`sns:Publish`.
  Verificação: 5 testes (lote misto, GuardDuty abaixo de 4, excesso, retry sem LLM, orçamento de
  tempo) e 3 mutações detectadas. Não testado com LLM nem DynamoDB reais. Dono: Claude Code
  (Kiro revisa). Status: corrigido no código; revisão independente pendente.
- **PS-33 · Medium · API pré-autenticação · `common/http.py:262`, `auth.py:59,79`,
  `jobs.py:120-130`, `common/jwt.py`:** reproduzido localmente: JSON com inteiro de mais de
  4300 dígitos lança `ValueError` (não `JSONDecodeError`) → 500; `/auth/nonce` com `uri` lista
  ou objeto → `TypeError` → 500; `deadlineDays` `"1E+400000"` gasta ~4,6 s em `int(Decimal)`
  (cresce de forma quadrática), `budgetUsdc` `"1E+999999999"` → `decimal.Overflow`,
  `reviewHours` inteiro enorme → `OverflowError`; `b58decode` da assinatura é quadrático e sem
  limite de tamanho (medido só em 20 mil caracteres, o resto é extrapolação); JWT com header
  muito aninhado pode lançar `RecursionError` antes da verificação da assinatura (plausível no
  runtime 3.12, não reproduzido em 3.14). Impacto: 500s e CPU por entrada hostil, alarmes
  `Api5xx`/`Errors` acionáveis por qualquer cliente. **Corrigido:** `parse_body` captura
  `ValueError`/`RecursionError`; `validate_origin` exige texto; assinatura limitada a 128
  caracteres; `jwt.decode` converte toda falha de parsing e `exp` gigante em `ValueError`;
  `create_job` valida o intervalo antes de `int()` e da multiplicação. Verificação:
  `TestReview25to31Regressions` (6 testes; mutação em `parse_body` detectada). Dono: Claude
  Code. Status: corrigido no código; revisão independente pendente.
- **PS-34 · Low · evidências/S3 · `evidence.py:125-132`, `template.yaml:603-610`:** a função só
  tem `s3:GetObject` em `reports/*`. Sem `s3:ListBucket`, `HeadObject` de chave inexistente
  retorna 403, que a lógica de PS-31 trata como indisponibilidade: o caso normal "hash on-chain
  registrado, blob ainda não enviado" passa a dar 503 e `evidence_head_failed`. **Corrigido** (aprovado pelo dono no chat): `s3:ListBucket` no ARN do
  bucket, só para `EvidenceDownloadFunction`, **sem** `Condition` de prefixo, porque `s3:prefix`
  não existe no contexto de `HeadObject` e uma condição negaria tudo. Efeito colateral: a função
  passa a poder listar as chaves do bucket, que só tem blobs cifrados e nomes já derivados de
  dados on-chain. `check_template.py` agora deriva `s3:ListBucket` de `head_object` (mutação
  detectada). Não testado contra S3 real. Dono: Claude Code (Kiro revisa). Status: corrigido no
  código; revisão independente pendente.
- **PS-35 · Low · EventBridge · `template.yaml:796-801`:** a regra `Demo` casa
  `source: proofsec.demo` sem condição de stage nem de conta; fora do dev, quem tiver
  `events:PutEvents` no barramento cria propostas `AUTO_APPROVED`. **Corrigido:** a regra saiu do SAM `Events`
  (que não aceita `Condition` por evento) e virou `AgentDemoRule` + `AgentDemoRulePermission`
  com a condição `DemoEventsEnabled` (dev e `CompanyWallet`), filtrando também a conta; além
  disso `agent.on_event` ignora `proofsec.demo` quando `STAGE != dev`. `check_template.py` passou
  a entender `Fn::And` como condição que implica a condição do alvo. `sam validate --lint` e
  `sam build` foram aprovados no fechamento do PS-17. Dono: Claude Code (Kiro revisa). Status:
  corrigido no código; revisão independente pendente.
- **PS-36 · Low · DynamoDB · `common/sync.py:317`, `agent.py:200,220`:** `apply_onchain`,
  `mark_executed` e `mark_rejected` regravam o item inteiro lido antes. Uma candidatura
  concorrente pode ser perdida, e dois syncs concorrentes podem fazer um snapshot mais antigo da
  chain sobrescrever o mais novo até a próxima rodada do indexador (INV-1 mitigado, não
  eliminado). Remediação: `UpdateItem` condicional por campo ou versão otimista. Dono: Kiro.
  Status: aberto (aceitável no MVP).

### Revisão geral arquivo a arquivo (2026-10-06): PS-37–PS-42

Escopo lido: todo o backend (`functions/`, `common/`, `template.yaml`), o executor (`core.ts`,
`lambda.ts`, `executor.ts`), o contrato (`lib.rs`, `state.rs`, `constants.rs`) e o frontend
(`api.ts`, `evidence.ts`, `program.ts`, `CreateJobPanel.tsx`, `JobCard.tsx`, `next.config.mjs`).
Não lidos em detalhe: `AgentPanel.tsx`, `AdminSetup.tsx`, `page.tsx`, `hooks/`, `agent/agent.py`,
`agent/template.yaml` e `contracts/tests`. O contrato não foi compilado: os achados dele vêm só de
leitura.

- **PS-37 · Medium · contrato · `lib.rs:757` (`settle`) e `lib.rs:1117,1156,1214,1265` (`address = config.treasury`):** PS-04
  congela árbitro, taxa e prazo de disputa, mas a tesouraria usada na liquidação é a da `Config`
  *atual*. Toda liquidação exige a ATA da tesouraria (e as do pesquisador e do cliente)
  existente, mesmo com taxa zero. Cenários: o admin troca a tesouraria para um endereço cuja ATA
  está congelada pelo emissor do mint (o USDC real tem autoridade de freeze) e todo
  `approve/claim/resolve` com taxa > 0 falha até o admin corrigir; uma ATA congelada do
  pesquisador faz `resolve_dispute_timeout` (50/50) falhar e só o árbitro destrava. Contraria
  INV-4 (saída por regras públicas) e depende do admin. Remediação: congelar a tesouraria no
  job (campo novo antes de `job_id`, ADR-018; a correção integrou o binário devnet) e prever uma
  saída pública final (ex.: reembolso ao cliente após `dispute_deadline` + carência) para ATAs
  congeladas. Verificação: testes com ATA congelada. Dono: Codex. Status: corrigido na branch (ADR-021). Em devnet o
  mint de teste não tem freeze, então o risco é de mainnet.
- **PS-38 · Medium · INV-6 · `api.ts:getEncryptionKey`, `JobCard.tsx:152-160`, `users.py`:** o
  pesquisador cifra o relatório para as chaves que o backend devolve, sem prova de que pertencem
  ao cliente/árbitro. Um backend comprometido (ou um atacante com escrita na tabela Users)
  publica a própria chave como a do cliente e lê os relatórios. Remediação: a carteira assina
  uma mensagem fixa com a chave pública e o backend guarda `{publicKey, signature}`; o frontend
  verifica com `nacl.sign.detached.verify` contra a pubkey da carteira antes de cifrar. Muda o
  contrato HTTP `PUT/GET /users/.../encryption-key` (frontend e backend juntos): precisa de ADR.
  Dono: Claude Code + Kiro. Status: corrigido (ADR-022).
- **PS-39 · Medium · agente · `core.ts:processProposal`, `lib.rs:InitializeJobByAgent`:** o
  agente é o `payer` do `JobAccount` e do vault; o rent do vault volta, mas o do `JobAccount`
  (~0,0034 SOL) nunca é fechado. Como `set_agent_policy` aceita qualquer `agent` e
  `/agent/propose` aceita qualquer carteira autenticada (cota por carteira, não global), um
  atacante cria políticas apontando para a chave pública do agente, delega USDC próprio e faz o
  executor abrir escrows em série, esgotando o SOL do agente. Remediação: lista de donos
  permitidos no executor (`ALLOWED_OWNERS`) ou só marcar `AUTO_APPROVED` quando a carteira é a
  `CompanyWallet`; opcionalmente fechar o `JobAccount` em estado terminal devolvendo o rent a
  `rent_payer`. Dono: Claude Code (executor) e Kiro (backend). Status: corrigido fora da chain (ADR-023).
- **PS-40 · Medium · API · `jobs.py:public_view`, `db.py:_query_all`, `template.yaml:ListJobsFunction`:**
  `GET /jobs` pagina toda a GSI (PS-23) e devolve tudo numa resposta. O `scopeDocument` é público
  e pode ter até ~75 KB (50 alvos × 500 + 50 regras × 1000), então cerca de 80 jobs estouram o
  limite de 6 MB da Lambda e a listagem vira 500; um atacante cria os jobs por pouco custo.
  Além disso a listagem expõe alvos e regras de todos os pentests a qualquer pessoa: confirmar se
  é intencional (ADR-010). Remediação: tirar `scopeDocument` da listagem (manter em
  `GET /jobs/{id}`), paginar com `limit` e cursor e aplicar um teto. Dono: Kiro (+ Claude Code
  para o consumidor). Status: corrigido (ADR-020).
- **PS-41 · Low · agente · `core.ts` (`getTokenAccount`):** `getAccount(...).catch(() => null)`
  convertia timeout/429 em "empresa sem ATA" (recusa definitiva, vai para `NEEDS_HUMAN`),
  quebrando a promessa de adiar erros transitórios. **Corrigido:** `tokenAccountOrNull` só mapeia
  `TokenAccountNotFound/InvalidAccountOwner/InvalidAccountSize` para `null`. Verificação: 2
  testes novos; a mutação (voltar a engolir tudo) foi detectada. Dono: Claude Code. Status:
  corrigido no código; revisão independente pendente.
- **PS-42 · Medium · frontend · `CreateJobPanel.tsx:fundFromMeta`, `lib/meta.ts`:** o
  financiamento on-chain usava `amountBase`, `deadlineDays`, `reviewHours`, `assignedResearcher`
  e `scopeHash` do backend sem conferir. Um backend comprometido poderia trocar o valor ou
  pré-atribuir um pesquisador antes de o usuário assinar. **Corrigido:** `assertMetaIntegrity`
  confere carteira, `sha256(scopeDocument) == scopeHash`, valor/prazos contra o escopo e contra
  o que o usuário digitou, e proíbe pesquisador em proposta do agente. Também o executor passou
  a exigir `sha256(scopeDocument) == scopeHash` (`validateProposal`). Verificação:
  `tests/meta-integrity.test.ts` (6, com fixture gerada pelo `build_scope_document` do backend) e
  testes do executor (16). Dono: Claude Code. Status: corrigido no código; revisão independente
  pendente.

**Resolução (mesma data, pedida pelo dono no chat):**

- **PS-40 → ADR-020.** `scopeDocument` saiu das visões públicas e só vai ao cliente e ao
  pesquisador atribuído; `GET /jobs` e `GET /jobs/mine` são paginados (`limit` ≤ 200, `offset`,
  `total`, `nextOffset`); `POST /jobs` devolve o escopo ao dono (o frontend precisa dele para
  conferir o hash). Mesma rodada, **PS-43 (Low):** `POST /jobs` não tinha limite de rascunhos;
  agora são 50 por carteira em 24 h (429), com `dynamodb:Query` em `ClientIndex` para o
  `CreateJobFunction`. Teste de tamanho: 250 jobs de 75 KB geram resposta < 6 MB.
- **PS-38 → ADR-022.** `PUT /users/me/encryption-key` exige a assinatura da carteira sobre uma
  mensagem fixa; o frontend só cifra para chaves cuja assinatura confere. Chaves antigas, sem
  assinatura, são ignoradas até o dono republicar.
- **PS-39 → ADR-023.** `ALLOWED_OWNERS`/`AllowedOwners` no executor (obrigatório fora do dev) e
  `propose` fora do dev só autônomo para a `CompanyWallet`. Residual aceito: o rent do
  `JobAccount` continua sem devolução para empresas permitidas. Fechar a conta quebraria o
  espelho do indexador (ver ADR-021).
- **PS-37 → ADR-021 (implementado na branch `fix/ps-37-treasury-freeze`).** Com o toolchain
  instalado no WSL (Rust 1.99, Agave 3.1.10, Anchor 1.2.0, Surfpool 1.6.0): `anchor build` limpo
  (SBPF v3, IDL real copiado para frontend e agente), `anchor test` com o validator padrão:
  **34 passando, 0 falhando**, incluindo os testes antigos de relógio (PS-02 etc.) e 5 novos do
  PS-37. Este foi o primeiro build e a primeira execução real da suíte do contrato. PS-17 foi
  concluído localmente depois que `sam validate --lint` e `sam build` também passaram nos dois
  templates. Mutações no contrato detectadas: tesouraria da
  config em `approve_and_release`, recuperação sem carência e recuperação em qualquer estado.
  O validator legado (`solana-test-validator` 3.1.10) não carrega SBPF v3 ("Program is not
  deployed"); com `anchor build --arch v0` ele roda 27 testes e deixa 7 pendentes.

### Achados de toolchain e dependências — PS-44–PS-46 (2026-10-06)

- **PS-44 · High · frontend · `frontend/package.json`, `frontend/package-lock.json`,
  `frontend/next.config.mjs`:** o `npm audit` online classifica o Next.js 14.2.35 como crítico,
  incluindo avisos de RCE sem autenticação, XSS, SSRF, envenenamento de cache, request smuggling
  e DoS. A arquitetura atual usa export estático para S3/CloudFront, o que reduz materialmente
  a superfície dos avisos de servidor em produção, mas `next dev`, `next start` ou uma futura
  migração para SSR continuam expostos. Impacto: comprometimento ou indisponibilidade do host
  caso um modo servidor vulnerável seja publicado. Remediação: Claude Code deve atualizar para
  ao menos a linha corrigida 15.5.24 (ou avaliar o Next 16.3.8 sugerido pelo audit), reconciliar
  React e wallet adapters e repetir build/typecheck; manter export estático e nunca expor o
  servidor de desenvolvimento até a correção. Verificação: `npm audit`, build estático e revisão
  do artefato. Dono: Claude Code. Status: **corrigido (2026-10-06)** na branch
  `fix/ps-44-next-upgrade`: Next.js 16.4.0 (fixado), React 18.3.1 mantido, `next dev/build --webpack`
  (o Turbopack, padrão do Next 16, recusa o `webpack()` de `next.config.mjs` que dá `Buffer` ao
  Anchor/web3.js). `npm audit`: críticos 1 → 0; `next` e `postcss` deixaram a lista. Typecheck, build
  estático e `test:meta` (18) passam. Residual: React 18 está obsoleto no Next 16 (removido no 17),
  o que pede migrar para React 19 junto com os wallet adapters; o script `lint` (`next lint`, removido
  no Next 16 e sem ESLint configurado) foi retirado. Revisão independente: pendente.
- **PS-45 · Medium · frontend/agente/contratos · respectivos `package.json` e lockfiles:** a
  cadeia compartilhada inclui `@anchor-lang/core@1.2.0` → `toml@3.0.0`,
  `@solana/web3.js@1.99.0` → `jayson`, `stream-json` e `uuid`, e
  `@solana/spl-token@0.4.15` → `bigint-buffer`; o workspace de contratos também tem avisos na
  cadeia do Mocha. Os totais observados foram frontend 38 (1 crítico, 22 altos, 15 moderados),
  agente 12 (5 altos, 7 moderados) e contratos 16 (9 altos, 7 moderados). Cenário: RPC ou entrada
  configurada maliciosamente explora DoS/prototype pollution nas bibliotecas transitivas.
  Impacto: indisponibilidade, comportamento inesperado ou risco de cadeia de suprimentos. O
  `npm audit fix --force` propõe saltos incompatíveis (inclusive downgrade de SPL Token e versões
  inválidas/incompatíveis de Anchor/Mocha), portanto não deve ser usado. Remediação: migração
  coordenada de Solana/Anchor nos três consumidores, RPCs confiáveis e testes completos antes de
  aceitar novos lockfiles. Verificação: audits sem achados aplicáveis, testes e builds das três
  áreas. Donos: Claude Code (frontend/agente) e Codex (contratos). Status: aberto.
- **PS-46 · Medium · contrato/configuração cross-area · `contracts/Anchor.toml`,
  `contracts/programs/proofsec/src/lib.rs`, templates SAM, defaults do backend/agente e IDLs
  gerados:** o endereço provisório `PrfSec111…` não coincide com a chave pública da keypair
  criada em `contracts/target/deploy`. O build e os testes locais passam com aviso porque o
  validator consegue implantar o binário, mas um deploy devnet não pode usar duas identidades.
  Impacto: falha de deploy ou clientes consultando/assinando para o programa errado. Remediação:
  escolher e proteger a keypair oficial do programa devnet, executar `anchor keys sync`, compilar
  para regerar e sincronizar os IDLs e atualizar `ProgramId`/variáveis dos consumidores na mesma
  tarefa; nunca commitar a keypair. Verificação: `anchor build` sem aviso de divergência, IDLs sem
  edição manual e todos os testes cross-area aprovados. Dono: Codex, coordenado com Kiro e Claude
  Code. Status: corrigido em devnet em 2026-10-06: `anchor keys sync --provider.cluster devnet`,
  `anchor build`, 34 testes Anchor e `anchor deploy --provider.cluster devnet` publicaram
  `HCYkSp64qdMRjiCbauEzPhx9VtNGB6fp5NvKdCRb8tjj`. Verificação independente:
  `solana program show HCYkSp64qdMRjiCbauEzPhx9VtNGB6fp5NvKdCRb8tjj --url devnet` confirmou
  BPF upgradeable, ProgramData `CxG6HXsy82bJSeCmyrMjHDBpzVhMX41PWp2draP3AR23` e a autoridade
  de upgrade da carteira dev. A `Config` foi inicializada após aprovação humana na transação
  `38Zz2Tn1FzemgLi1pC9GEq8bRLH9YoHUnacdLTwrn28exDMA3mRgwjrY5Q1Z2EGbSr5uYJqGAsMW3SqJmcdMvcnT`:
  PDA `2qX6gWqAiTjLcQCg53UiCpfTnnNgs89GkwbSWfVNRyXQ`, 250 bps, USDC devnet e 24 h; a leitura
  on-chain confirmou admin, árbitro e tesouraria na carteira dev aprovada.

**Observações (Info, sem ID):** a taxa de throttling por rota é global, então um cliente esgota o
login de todos (backlog CloudFront+WAF já registrado); `claim_after_review` só aceita o
pesquisador como signer e poderia ser sem signer, como `resolve_dispute_timeout`, porque o
destino é fixo; `policy` em `InitializeJobByAgent` não tem `seeds` (seguro porque a transferência
exige o PDA como delegate, mas vale como defesa em profundidade); durações de demo no contrato
(`MIN_JOB_DURATION` 10 min, `MIN_REVIEW_PERIOD` 60 s) precisam subir antes de mainnet; a regra
`NonDevHardening` só barra o domínio exato `localhost:3000`; o JWT de 12 h não tem revogação; o
frontend mapeia status desconhecido para `OPEN`; a chave de criptografia é por origem (ADR-017),
então relatórios cifrados em `localhost` não abrem em produção.

**Riscos residuais após o primeiro build:** o build do contrato emite 18 avisos não fatais de
`unexpected cfg` vindos dos macros Anchor/Solana (`custom-heap`, `custom-panic`,
`anchor-debug`); PS-44/45 exigem atualização coordenada de dependências; e filtros, eventos, permissões e cold
start das Lambdas ainda precisam ser confirmados numa conta AWS dev real.

## Corrigidos (com teste de regressão)

| ID | Vulnerabilidade | Correção | Regressão |
|---|---|---|---|
| C1 | Cliente desviava o pagamento para a própria conta | `associated_token::authority = researcher` + `has_one = researcher` | `proofsec.ts` "C1" |
| C2 | Qualquer um drenava job expirado | `has_one = client`; destino é a ATA do cliente | `proofsec.ts` "C2" |
| C3 | Fundos travavam após a evidência (cliente silencioso) | janela de revisão + `claim_after_review` + disputa | "pesquisador não saca antes…" |
| A1 | `job_id` global ocupável | cliente nas seeds | implícito (PDA) |
| A3 | Token falso | `allowed_mint` + `has_one = mint` | falta teste (mint errado) |
| A5 | Prazo no passado | `MIN/MAX_JOB_DURATION` | "valida parâmetros" |
| A6 | Rent preso / vault aberto | `close_vault` ao liquidar | "fluxo feliz" (vault fechado) |
| B1 | `GET /jobs` com erro 500 (Decimal) | encoder de Decimal | `test_decimal_serialization` |
| B2 | API sem autenticação | SIWS + JWT + authorizer | `test_siws_login_and_authorizer` |
| B3 | DynamoDB como dono do status | sync a partir da chain | `test_sync_rejects_divergent_client` |
| B6 | Upload sem garantia de hash | checksum + `verify_upload` | `test_evidence_upload_only_for_linked_researcher` |
| R1 | Rascunhos e propostas expostos publicamente | `/jobs/mine` autenticado | `test_create_and_list_jobs` |

---

## Backlog por agente (ordem de prioridade)

| Agente | Itens |
|---|---|
| **Codex** (`contracts/`) | PS-45: acompanhar migração Anchor/Solana · confirmar PS-48 com `anchor test` · completar o catálogo de ataques em `contracts/tests/AGENTS.md` |
| **Claude Code** (`backend-serverless/`, `agent/template.yaml`, desde o ADR-024) | confirmar drift/filtros/eventos na conta dev · preparar CloudTrail opcional · revisar o executor sem implantá-lo |
| **Claude Code** (`frontend/`, `agent/`, `tests/`) | republicar CSP PS-47 no Amplify · PS-45: migração coordenada de dependências · React 19 · troca automática de RPC na UI (PS-13) · `tests/api-security`/`tests/e2e` · atualizar o manual em PDF |
| **Antigravity** | revisar cada entrega · manter este arquivo e `decisions.md` |

## Revisão AWS — 12/10/2026

Handoff: `docs/aws-hardening-2026-10-12.md`. Status de implantação separados do código:
PS-47 continua pendente no host; drift observado IN_SYNC; CloudTrail continua desativado;
alerta adicional US$140 e permission sets SSO ainda não implantados (proposta ADR-029).
Sessão local SSO funciona, mas MCP mantém root até reiniciar o Codex. Nenhuma escrita AWS realizada.

| ID | Severidade | Componente / arquivo | Cenário e impacto | Remediação | Verificação | Responsável | Status |
|---|---|---|---|---|---|---|---|
| AWS-IR-1 | Low | teste live / `tests/api-security/smoke.py` | Parâmetros dev não restringiam o destino real; sondagens POST/PUT poderiam seguir redirects para outro ambiente | Fixar origens e bucket revisados, validar stack/cluster antes de sondar e proibir redirects | `tests/api-security/test_smoke.py`: produção/mainnet e redirects abortam sem enviar sondagem ao destino; reproduzido no runner antigo | Autor da entrega AWS | Corrigido no código · revisão independente concluída |
| AWS-IR-2 | Low | teste live / `tests/api-security/smoke.py` | HTTP 200 `{}` passava confidencialidade por lista vazia implícita, mascarando falha | Exigir `success=true`, lista `jobs` e itens dict antes das asserções | Respostas inválidas, drafts e escopos privados sintéticos falham; fixtures públicas e vazias válidas passam; reproduzido no runner antigo | Autor da entrega AWS | Corrigido no código · revisão independente concluída |

Correção de validação na policy fonte: removida a ação inexistente `account:Cancel*` de
`docs/iam/agent-users.yaml`; template SSO regenerado. Access Analyzer confirmou as três policies
sem erros; guardrails sensíveis preservados e revisados independentemente. Regra sem efeito
removida, sem conceder escrita IAM ou desabilitar um controle efetivo.
