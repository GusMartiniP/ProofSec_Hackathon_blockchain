# Decisões de arquitetura (ADRs) — ProofSec

Formato: **Decisão · Motivo · Alternativas · Impacto de segurança · Impacto operacional.**
Status: Aceita · Proposta (aguarda o dono do projeto) · Substituída.
Qualquer agente pode propor; só o dono do projeto aprova (via Antigravity).

---

## ADR-001 — A Solana é a fonte da verdade · Aceita

- **Decisão:** status, valores e hashes vivem no programa. O DynamoDB só espelha e guarda
  metadados.
- **Motivo:** o dinheiro não pode depender de um banco centralizado nem do backend estar no ar.
- **Alternativas:** backend autoritativo com a chain só como liquidação.
- **Segurança:** elimina a manipulação de status via API e reduz a superfície de confiança.
- **Operação:** precisa de indexador/sync. O frontend funciona sem backend ("modo só on-chain").

## ADR-002 — AWS SAM como IaC (não Terraform) · Aceita

- **Decisão:** infraestrutura em `backend-serverless/template.yaml` (SAM/CloudFormation).
- **Motivo:** a stack é Lambda + HTTP API + eventos, que é o caso de uso nativo do SAM.
  Não exige backend de estado e tem menos boilerplate. O Kiro trabalha bem com SAM.
- **Alternativas:** Terraform (estado remoto S3 + lock, mais código), CDK (mais abstração).
- **Segurança:** o changeset (`--no-execute-changeset`) funciona como `plan` revisável;
  não há arquivo de estado sensível para proteger.
- **Operação:** um comando de deploy; rollback automático do CloudFormation.

## ADR-003 — Liberação otimista com janela de revisão e árbitro · Aceita

- **Decisão:** depois de `submit_evidence`, o cliente aprova ou contesta dentro da janela.
  Em silêncio, o pesquisador saca. Contestação vai para o árbitro, que decide a divisão
  em bps.
- **Motivo:** o hash prova integridade e data, não qualidade. Sem isso, qualquer lado
  podia travar os fundos.
- **Alternativas:** aprovação obrigatória do cliente (trava), oráculo automático
  (inviável para qualidade de pentest).
- **Segurança:** garante INV-4. Abre o risco PS-05 (cliente desatento), mitigado por
  alertas e janela mínima.
- **Operação:** o árbitro precisa de chave segura (multisig em produção) e de prazo (PS-02).

## ADR-004 — Agente "cérebro/mãos" com política on-chain via delegate SPL · Aceita

- **Decisão:** a Lambda (cérebro) propõe sem chaves. O executor (mãos) assina
  `initialize_job_by_agent`. A `AgentPolicy` limita valor por job e por período, e a
  empresa aprova o PDA da política como delegate da sua ATA de USDC.
- **Motivo:** "a IA propõe, a chain impõe". O comprometimento da LLM, do backend ou da
  chave do executor fica limitado ao teto.
- **Alternativas:** Squads v4 spending limits (melhor para produção, alinhado ao Altitude),
  checagem só no backend (insuficiente).
- **Segurança:** a chave do agente não tem custódia; o dinheiro movido sempre cai em
  escrow reembolsável da empresa.
- **Operação:** o delegate SPL é único por conta (PS-15) e o agente precisa de SOL para
  rent (PS-14).

## ADR-005 — Relatório cifrado no navegador, chave derivada de assinatura · Aceita

- **Decisão:** envelope XSalsa20-Poly1305 com a chave embrulhada por X25519 para cliente,
  pesquisador e árbitro. O par X25519 de cada carteira é derivado de `SHA-256(assinatura
  de mensagem fixa)`. O hash on-chain é do envelope cifrado.
- **Motivo:** o backend e a AWS nunca veem o relatório em claro, e não é preciso gerenciar
  chaves privadas extras.
- **Alternativas:** KMS por usuário (o backend ganharia acesso), PGP manual (UX ruim).
- **Segurança:** risco de phishing da assinatura (PS-06).
- **Operação:** trocar a mensagem exige migração versionada.

## ADR-006 — Autoridade do vault = PDA do job · Aceita

- **Decisão:** o token account do vault tem como autoridade o PDA `["job", client, job_id]`.
- **Motivo:** evita a dúvida sobre auto-autoridade no `init` e amarra o vault ao estado do job.
- **Segurança:** só o programa assina saídas do vault, e sempre pelas regras do job.

## ADR-007 — Lambdas sem dependências externas · Aceita

- **Decisão:** stdlib + boto3 do runtime. Ed25519, JWT e base58 em Python puro, testados
  contra a biblioteca `cryptography`.
- **Motivo:** pacote mínimo, sem binários nativos no build (Windows/SAM), menor superfície
  de supply chain.
- **Alternativas:** PyNaCl/PyJWT/solders.
- **Segurança:** implementações próprias exigem testes de vetor (existentes para Ed25519 e JWT).

## ADR-008 — Anchor 1.x · Aceita

- **Decisão:** Anchor 1.2.x e `@anchor-lang/core`.
- **Motivo:** é a versão estável atual. A 0.30.1 tinha problemas de geração de IDL.
- **Operação:** exige Solana 3.x. Os testes usam Surfpool/LiteSVM por padrão.

## ADR-009 — Hierarquia de AGENTS.md e donos por área · Aceita

- **Decisão:** um `AGENTS.md` na raiz (regras invioláveis e orquestração) e um por área.
  - Antigravity orquestra e revisa.
  - Codex é dono de `contracts/`.
  - Kiro é dono de `backend-serverless/`.
  - Claude Code é dono de `frontend/`, `agent/` e `tests/`.
- **Motivo:** as quatro ferramentas leem `AGENTS.md` nativamente e por pasta. Donos
  separados evitam dois agentes editando a mesma área. Quem escreve não revisa.
- **Restrições:**
  - nada de `CLAUDE.md` (desliga a leitura de `AGENTS.md` no Claude Code);
  - nada de `AGENTS.override.md` ou `.agents/` para regras compartilhadas;
  - raiz ≤ 8 KB (o Codex corta em 32 KiB).

## ADR-010 — Rotas públicas só expõem jobs on-chain · Aceita

- **Decisão:** `GET /jobs` e `GET /jobs/{id}` retornam só `status = ONCHAIN`. Rascunhos e
  propostas do agente só aparecem em `GET /jobs/mine`, com autenticação.
- **Motivo:** propostas do agente revelam o que está vulnerável na infraestrutura do cliente.

## ADR-011 — Sem instrução de pausa · Aceita

- **Decisão:** o programa não tem "pause".
- **Motivo:** uma pausa dá ao admin poder de congelar fundos de terceiros (conflita com INV-4).
- **Alternativa de emergência:** upgrade do programa com aprovação humana (`docs/runbook.md`).
  Em produção, upgrade authority em multisig e plano de congelar upgrades depois da auditoria.

---

## Decisões da rodada de correções (2026-10-02)

As propostas P1–P6 foram aceitas com o padrão recomendado (o dono do projeto pediu para
resolver tudo). Qualquer uma pode ser revista por novo ADR.

## ADR-012 — Executor do agente como Lambda opcional, em stack separada (P4) · Aceita

- **Decisão:** `agent/lambda.ts` (mesmo núcleo da CLI, `core.ts`) agendado a cada minuto pela
  stack `agent/template.yaml`; chave em SSM SecureString lida só pelo role do executor.
- **Motivo:** 100% serverless sem pôr chave na stack do backend; build isolado (falha no
  bundle do agente não bloqueia o backend); kill switch `ScheduleState=DISABLED`.
- **Alternativas:** função na stack do backend (acopla build e blast radius); só CLI local.
- **Segurança:** a chave continua sem custódia (limites da `AgentPolicy`); recusas
  definitivas viram `NEEDS_HUMAN` via `POST /agent/proposals/{id}/rejected`.

## ADR-013 — Aceite só por atribuição, com candidaturas off-chain (P1) · Aceita

- **Decisão:** `accept_job` exige pesquisador atribuído. Pesquisadores se candidatam pela API
  e o cliente escolhe e atribui on-chain.
- **Motivo:** fecha PS-01 sem janela extra nem stake. **Custo:** uma transação a mais.

## ADR-014 — Prazo do árbitro e divisão padrão 50/50 (P2) · Aceita

- **Decisão:** `dispute_deadline = abertura + dispute_period` (congelado no job). Depois dele,
  qualquer pessoa chama `resolve_dispute_timeout` e aplica 50/50 (resto ao cliente, taxa normal).
- **Motivo:** INV-4 — nenhum estado prende fundos para sempre.

## ADR-015 — Termos congelados por job (P3) · Aceita

- **Decisão:** `arbiter`, `fee_bps` e `dispute_period` copiados da `Config` na criação; mudanças
  na `Config` só valem para jobs novos. O indexador alerta (CRITICAL) quando a `Config` muda.

## ADR-016 — Jobs do agente com atribuição humana e revisão ≥ 72 h (P5) · Aceita

- **Decisão:** `initialize_job_by_agent` não recebe pesquisador e exige revisão ≥ 72 h; o rent
  volta para o agente (`rent_payer`, PS-14); alertas SNS a cada job do agente e evidência.

## ADR-017 — Chave de criptografia v2 ligada à origem (P6) · Aceita

- **Decisão:** a mensagem de derivação segue o formato SIWS com domínio e URI da página
  (campos fixos para a assinatura ser determinística). A chave passa a ser por origem; a v1
  só é usada para abrir envelopes antigos (`keyVersion` ausente).
- **Alternativa:** Wallet Standard `signIn` — descartada porque as carteiras podem preencher
  campos variáveis e a chave deixaria de ser determinística.

## ADR-018 — Regra de layout do `JobAccount` · Aceita (substitui a regra antiga)

- **Decisão:** campos novos de tamanho fixo entram **imediatamente antes** de `job_id` (único
  campo variável). Os offsets existentes não mudam e os novos ficam fixos. A regra antiga
  ("acrescentar depois de `job_id`") deixaria os offsets dependentes do tamanho do id.
- **Operação:** o programa nunca foi implantado; depois do primeiro deploy, qualquer mudança
  de layout exige migração.

## ADR-019 — Elegibilidade, limite por evento e dedup antes do LLM nos alertas do agente (PS-32) · Aceita

- **Contexto:** a regra do Security Hub casa quando *algum* finding do lote é MEDIUM+, mas
  `agent.on_event` abre proposta para *todos* os findings do lote. Isso inclui LOW e
  INFORMATIONAL, findings ARCHIVED, RESOLVED ou SUPPRESSED, e lotes de até 100 itens. Cada
  LOW/MEDIUM vira `AUTO_APPROVED` (150/350 USDC); o único teto é a `AgentPolicy` on-chain.
  `build_proposal` também chama o LLM antes do dedup, então cada retry repete o custo e um lote
  grande estoura o timeout de 30 s.
- **Decisão proposta:**
  1. **Elegibilidade determinística em código** (espelha o intento da regra, sem LLM): Security
     Hub só com `Severity.Label` em MEDIUM/HIGH/CRITICAL, `RecordState` ACTIVE e
     `Workflow.Status` NEW ou NOTIFIED, e `AwsAccountId` igual à conta local; GuardDuty só com
     severidade ≥ 4. Findings inelegíveis geram só o log `agent_finding_skipped` com o motivo.
     `INFORMATIONAL` nunca abre escrow. Ele continua mapeado para LOW em `policy.py`, que só
     afeta o fluxo manual `POST /agent/propose`.
  2. **Limite por evento** `MAX_PROPOSALS_PER_EVENT` (padrão 10): os findings elegíveis são
     ordenados por severidade e depois pelo ID; os primeiros N seguem a regra normal; o excesso
     é criado como `NEEDS_HUMAN` (nunca `AUTO_APPROVED`), com a razão registrada, e dispara um
     alerta SNS WARNING.
  3. **Dedup antes do LLM:** `get_job(job_id)` antes de `build_proposal`; o `PutItem` condicional
     continua sendo a barreira contra corrida. Orçamento de tempo: abaixo de ~8 s restantes
     (`context.get_remaining_time_in_millis()`), o resto do lote usa o escopo de template, sem
     LLM (`generate_scope` já tem esse fallback).
- **Alternativas:**
  - Filtrar só no padrão do EventBridge: não resolve, porque o padrão casa o evento, não cada
    elemento do array.
  - Um finding por mensagem via SQS/Step Functions: mais robusto em escala, porém mais
    infraestrutura para um MVP de devnet. Fica como evolução.
  - Manter o comportamento atual e confiar só na `AgentPolicy` on-chain: aceita gasto
    autônomo com findings que a regra não pretendia cobrir.
- **Segurança:** reduz o vetor de gasto autônomo e de custo de LLM sem mexer em INV-2 nem
  INV-3 (valores continuam vindo de `policy.py`; limites continuam on-chain). Nenhum dado
  do evento vira identidade (INV-8). Findings ignorados ficam rastreáveis por log.
- **Operacional:** mais propostas `NEEDS_HUMAN` em picos; requer `dynamodb:GetItem` em Jobs para
  a `AgentEventFunction` (mudança de IAM, exige aprovação, AGENTS.md §5); nova variável de
  ambiente; novos testes: lote misto elegível/inelegível, lote acima do limite, retry sem nova
  chamada ao LLM, estouro de orçamento de tempo.
- **Status:** aprovada pelo dono do projeto no chat em 2026-10-06 e implementada em
  `functions/agent.py`, `common/llm.py` (`use_llm`) e `template.yaml`. Mudanças de IAM na
  `AgentEventFunction`: `dynamodb:GetItem` em Jobs e `sns:Publish` no `AlertsTopic`. Variável
  `MAX_PROPOSALS_PER_EVENT` (padrão 10). Campos ausentes no finding não bloqueiam (só o ASFF real
  traz `RecordState`/`Workflow`). Testes em `TestReview25to31Regressions` (5 casos; mutações
  de dedup, limite e elegibilidade detectadas).

## ADR-020 — Escopo privado e listagens paginadas (PS-40) · Aceita (emenda a ADR-010)

- **Decisão:** `scopeDocument` (alvos e regras do pentest) deixa de aparecer em `GET /jobs` e
  `GET /jobs/{id}`. Só o cliente e o pesquisador atribuído o recebem, em `GET /jobs/mine` e na
  resposta de `POST /jobs`. `GET /jobs` e `GET /jobs/mine` passam a aceitar `limit` (1–200,
  padrão 100) e `offset`, ordenam do mais recente e devolvem `total` e `nextOffset`. `POST /jobs`
  limita rascunhos novos a 50 por carteira em 24 h (`MAX_DRAFTS_PER_DAY`, 429).
- **Motivo:** a listagem paginava toda a GSI e devolvia tudo numa resposta; com escopos de até
  ~75 KB, ~80 jobs passavam do limite de 6 MB da Lambda (500). Além disso os alvos de todos os
  pentests eram públicos.
- **Alternativas:** manter o escopo público (pesquisadores avaliam antes de se candidatar);
  rota autenticada só para o escopo de jobs abertos; cursor do DynamoDB (a GSI não tem chave de
  ordenação, então não ordena por data).
- **Segurança:** menos exposição de alvos (reduz o que ADR-010 já protegia para propostas do
  agente). Efeito colateral: quem ainda não foi atribuído não lê o escopo; ele continua
  verificável pelo hash on-chain. Reverter é uma linha em `PRIVATE_FIELDS` (`jobs.py`).
- **Operacional:** o frontend não exibia `scopeDocument`; só o usa para conferir o hash antes
  de assinar (`lib/meta.ts`). Páginas além da primeira exigem `offset` (a UI mostra as 100
  mais recentes).

## ADR-021 — Tesouraria congelada no job e saída para contas de token travadas (PS-37) · Aceita

- **Contexto:** PS-04 congela árbitro, taxa e prazo de disputa no `JobAccount`, mas a tesouraria
  usada nas liquidações é a da `Config` atual (`address = config.treasury`). Toda liquidação exige
  as ATAs de tesouraria, pesquisador e cliente existentes, mesmo com taxa zero. Se uma delas for
  congelada pelo emissor do mint (o USDC real tem autoridade de freeze) ou a tesouraria for
  trocada para um endereço problemático, `approve`, `claim` e `resolve` falham e
  `resolve_dispute_timeout` (50/50) também. INV-4 fica dependente do admin.
- **Decisão proposta:**
  1. campo `treasury: Pubkey` no `JobAccount`, imediatamente antes de `job_id` (ADR-018): offset
     318, `job_id` passa para 350 e `JOB_FIXED_SIZE` para 354; as quatro liquidações usam
     `address = job_account.treasury`;
  2. instrução pública de último recurso para jobs `Disputed` ou `EvidenceSubmitted` depois de
     `dispute_deadline` (ou `review_deadline`) mais uma carência longa (ex.: 30 dias): devolve o
     saldo do vault ao cliente. Só ATAs derivadas do job (INV-5);
  3. decoder do backend (`solana.py`), `gen_idl_preview.py`, fixtures de teste e testes
     adversariais (ATA congelada, tesouraria trocada) atualizados na mesma tarefa.
- **Alternativas:** (a) pular a transferência da taxa quando a tesouraria falhar (não dá: uma CPI
  que falha desfaz a transação); (b) aceitar o risco e documentar (só importa em mainnet); (c) um
  `claim` por conta de credito em PDA (mais estado e mais instruções).
- **Fechar o `JobAccount` em estado terminal (PS-39):** descartado por ora. A conta é a única
  fonte do status final para o indexador (`sync_job`/`fetch_all_jobs`); fechá-la deixaria o
  espelho com o último status antigo. PS-39 foi mitigado fora da chain (ADR-023).
- **Segurança:** remove a dependência do admin para liberar fundos; a instrução nova é permissionless
  e com destino fixo. **Operacional:** muda layout e IDL, então só antes do primeiro deploy.
- **Implementação (branch `fix/ps-37-treasury-freeze`, aprovada pelo dono no chat):**
  `JobAccount.treasury` (offset 318; `job_id` em 350; `JOB_FIXED_SIZE` 354); as quatro liquidações usam
  `address = job_account.treasury` (a conta `config` continua nas instruções, só deixou de ser a fonte
  da tesouraria); `recover_stuck_funds` (sem signer), erros `CannotRecover` e `RecoveryGraceNotElapsed`,
  evento `JobRecovered`, constante `RECOVERY_GRACE_PERIOD` de 30 dias. Backend (`solana.py`,
  `sync.py`), frontend (`program.ts`, botão no `JobCard`) e `gen_idl_preview.py` atualizados.
- **Decisão sobre o status:** a recuperação reaproveita `Refunded` (sem nova variante no enum, que
  mudaria os índices de status no backend e na UI); o evento `JobRecovered` distingue o caso.
- **Residual:** se a ATA do cliente estiver congelada, não há saída on-chain. Se a ATA da tesouraria
  estiver congelada, aprovações com taxa > 0 falham até a carência, e o pesquisador perde o
  pagamento naquele job (a recuperação devolve tudo ao cliente).

## ADR-022 — Chaves de criptografia com prova de posse da carteira (PS-38) · Aceita

- **Decisão:** `PUT /users/me/encryption-key` recebe `{publicKey, signature}`, onde `signature` é a
  assinatura Ed25519 da carteira sobre uma mensagem fixa
  (`common/keybinding.py` e `frontend/src/lib/keybinding.ts`). O backend verifica e guarda
  `encSignature`; `GET /users/{wallet}/encryption-key` devolve `{publicKey, signature}`. O frontend
  só cifra para uma chave depois de verificar a assinatura contra o próprio endereço da carteira.
- **Motivo:** o backend sozinho decidia qual chave valia para cada carteira. Um backend ou banco
  comprometido trocaria a chave do cliente/árbitro e leria os relatórios (INV-6).
- **Migração:** chaves antigas sem assinatura são tratadas como inexistentes por quem cifra;
  o dono republica ao abrir o app ("Ativar criptografia"), com um pedido extra de assinatura.
- **Alternativas:** servir a chave pela chain (conta on-chain por usuário: custo e transação a
  mais); confiar no backend (status anterior).
- **Segurança:** o backend ainda pode ocultar uma chave ou servir uma chave antiga e válida, mas
  não forjar a de outra carteira. A mensagem não autoriza transação e inclui carteira e chave.
- **Verificação:** a fixture `tests/fixtures/key-binding.json` (assinada em Python) é conferida
  pelo frontend em `tests/key-binding.test.ts`.

## ADR-023 — Donos permitidos no executor e propostas autônomas só da CompanyWallet fora do dev (PS-39) · Aceita

- **Decisão:** (1) o executor aceita `allowedOwners` (variável `ALLOWED_OWNERS`; parâmetro
  `AllowedOwners` da stack do agente, obrigatório fora do dev): empresa fora da lista é recusa
  definitiva (`NEEDS_HUMAN`); (2) fora do dev, `POST /agent/propose` de uma carteira diferente da
  `CompanyWallet` cria a proposta já como `NEEDS_HUMAN` (financiamento manual).
- **Motivo:** `set_agent_policy` aceita qualquer `agent`, então um terceiro apontava a própria
  política para a chave pública do agente e fazia o executor gastar SOL dele em rent (o rent do
  `JobAccount` não volta).
- **Alternativas:** fechar o `JobAccount` (ver ADR-021); allowlist on-chain (mais estado).
- **Segurança:** o executor só financia empresas conhecidas. No dev o comportamento é o antigo,
  para a demo. **Operacional:** em staging/prod é preciso preencher `AllowedOwners`.

## ADR-024 — Backend sai do Kiro; Claude Code sobe e testa o ambiente AWS; um usuário IAM por agente · Proposta

- **Decisão:** (1) `backend-serverless/` passa do Kiro para o **Claude Code** (o Kiro deixa de
  atuar no projeto); a tabela do §1 do `AGENTS.md` e o item "template.yaml revisado por Kiro"
  passam a refletir isso. (2) O Claude Code gera o changeset (`sam deploy --no-execute-changeset`)
  e roda os testes contra a stack no ar; **a execução do changeset é humana** (§5). (3) O
  Antigravity revisa o changeset, o IAM e os resultados; o Codex fica em `contracts/` e só lê a AWS.
  (4) Identidades: um usuário IAM por agente (Claude Code, Codex, Antigravity), sem console e
  sem chave no template, com política de bloqueios comum (sem IAM, sem executar changeset, sem
  ler segredos do SSM nem relatórios do S3). Template: `docs/iam/agent-users.yaml`.
- **Motivo:** o Kiro foi removido do fluxo e o backend ficou sem dono. O Claude Code já é dono dos
  consumidores do contrato HTTP (`frontend/src/lib/api.ts`, `agent/core.ts`) e de `tests/`;
  atribuir-lhe o backend permite mudar contrato e consumidores na mesma tarefa (§4.3).
- **Alternativas:** Codex como dono do backend (desvia do foco em `contracts/`); Antigravity
  (perde a independência de revisor); um único usuário IAM compartilhado (sem atribuição no
  CloudTrail e sem revogação individual).
- **Segurança:** o autor do backend e dos testes é o mesmo agente; a mitigação é a revisão
  independente do Antigravity e a execução humana do changeset. Os testes de segurança da API
  podem ser escritos pelo Codex para separar autoria. Nenhum agente tem `ExecuteChangeSet`.
- **Operacional:** atualizar o §1 do `AGENTS.md`, `backend-serverless/AGENTS.md` e as
  referências ao Kiro no runbook depois da aprovação; trocar o perfil do MCP da AWS do root
  para o usuário do agente. Criar os usuários exige aprovação (IAM, §5).
