# ProofSec — Análise Técnica Completa (Arquitetura, Fluxo, Stack e Conflitos)

> **Documento histórico — não representa o estado atual do repositório.** Esta análise
> registrou os problemas encontrados em 02/10/2026 antes da rodada de correções. Para o
> estado vigente, consulte `CONTEXT_FOR_ANTIGRAVITY.md`, `CONTEXT_FOR_CLAUDE.md` e
> `docs/security-review.md`. Achados abaixo marcados como presentes podem já estar corrigidos.

> Revisão feita sobre todos os arquivos-fonte da pasta `proofsec/` (contrato Anchor, SAM/Lambdas, agente CLI, frontend Next.js) e o `CONTEXT_FOR_CLAUDE.md`. Data: 02/10/2026.

---

## 0. Veredito em 30 segundos

A **ideia é boa e o encaixe com a Solana faz sentido** (escrow em USDC + commit de hash + agente com teto de gasto é uma narrativa forte para Colosseum/Superteam). Mas hoje existem **três problemas estruturais** que um jurado técnico vai encontrar rápido:

1. **O contrato tem 2 falhas críticas que quebram exatamente a promessa do produto** — o cliente consegue mandar o pagamento para si mesmo em `approve_and_release`, e qualquer pessoa consegue sacar o vault de um job expirado em `refund_expired`. Um produto de *segurança* não pode ir para a demo com isso.
2. **O fluxo de confiança tem um deadlock**: depois que o pesquisador envia a evidência, nem o cliente consegue reembolso nem o pesquisador consegue receber se o cliente simplesmente não aprovar. O SHA-256 prova *integridade e data*, não *qualidade* — falta um mecanismo de resolução (janela de contestação / árbitro).
3. **Três "fontes da verdade" que não conversam**: Solana, DynamoDB e o estado mock do frontend usam IDs, status e regras diferentes, e o backend aceita qualquer escrita sem autenticação.

Além disso, a stack está **desatualizada em pontos que travam o build** (Anchor 0.30.1 sem a feature `idl-build`, sem `Anchor.toml`; Anchor 1.0 já saiu e renomeou o pacote TS) e há um **mismatch de narrativa com os sponsors** (o Altitude é da Squads — a integração natural é via Squads spending limits, não um Lambda em Python).

Tudo isso é corrigível em poucos dias. Abaixo, o detalhamento e uma ordem de execução.

---

## 1. Validação do fluxo (ordem faz sentido?)

### Fluxo atual (do pitch)
```
1. Agente detecta falha → 2. Deposita 350 USDC → 3. Pesquisador aceita
→ 4. SHA-256 on-chain → 5. Cliente valida hash e aprova → 6. Libera USDC + certificado
```

### Problemas de ordem/lógica

| # | Problema | Impacto |
|---|---|---|
| F1 | **Não existe passo de "autorização de escopo"** (Rules of Engagement). Em segurança ofensiva, o pesquisador precisa de autorização formal para testar o alvo — sem isso o pentest é ilegal. | Jurídico + credibilidade do pitch |
| F2 | **Qualquer um pode aceitar o job** (first-come-first-served). Em pentest a empresa escolhe quem testa sua infra. | Segurança do cliente |
| F3 | **Passo 5 é "trust me"**: o cliente lê o relatório e pode nunca aprovar. O pesquisador entrega o relatório antes de ter garantia de recebimento — exatamente a assimetria que o projeto diz resolver. | Quebra a proposta de valor |
| F4 | **Passo 4 sem conteúdo real**: o pesquisador pode commitar o hash de um arquivo vazio e travar os fundos para sempre (refund bloqueado em `EvidenceSubmitted`). | Griefing |
| F5 | **"Agente detecta falha e contrata pentest"** é estranho: se a IA já achou a falha, por que contratar? | Narrativa |
| F6 | **"Certificado on-chain" no passo 6 não existe no código.** | Promessa sem entrega |
| F7 | Deadline definido livremente pelo cliente (pode ser no passado) → cliente cria job, pesquisador aceita e trabalha, cliente pede refund antes da evidência. | Griefing |

### Fluxo recomendado
```
0. Empresa conecta carteira (SIWS) e configura política do agente (Squads spending limit ou delegate SPL)
1. Agente detecta MUDANÇA/RISCO (novo deploy, novo endpoint, alerta GuardDuty/Security Hub)
   → LLM gera escopo + orçamento sugerido  (não "achou a falha", e sim "precisa validar")
2. Policy Guard DETERMINÍSTICO (fora da LLM) decide: ≤ teto → auto-fund | > teto → pede assinatura humana
3. initialize_job: deposita USDC + grava scope_hash (hash do RoE/escopo assinado = autorização legal)
4. Pesquisador se candidata → empresa seleciona (assign_researcher) → pesquisador aceita (accept_job)
5. Pesquisador sobe o relatório CRIPTOGRAFADO para o S3 (com checksum SHA-256 forçado) e commita o hash on-chain
   (opcional: resumo público com severidade + contagem de achados, sem PoC)
6. Janela de revisão (ex.: 72h):
     ├─ cliente aprova            → release
     ├─ cliente não faz nada      → pesquisador chama claim_after_review → release automático
     └─ cliente abre disputa      → árbitro (multisig Squads da plataforma) decide split
7. Release: USDC → pesquisador (+ fee da plataforma) + atestação de reputação (Solana Attestation Service)
8. Fechar contas (devolver rent ao cliente)
```

O ponto 6 (**liberação otimista com janela de contestação**) é o que de fato resolve a assimetria. É o padrão usado por escrows de freelance on-chain e é simples de implementar.

---

## 2. Smart Contract (Anchor/Rust) — achados

### 🔴 Críticos

**C1 — `approve_and_release` não valida a conta de destino.**
`researcher_token_account` não tem constraint alguma. O cliente pode passar a **própria** token account e receber o dinheiro de volta depois de ler o relatório. Corrigir:
```rust
#[account(
    mut,
    constraint = researcher_token_account.owner == job_account.researcher.unwrap() @ ProofSecError::UnauthorizedResearcher,
    constraint = researcher_token_account.mint == job_account.mint @ ProofSecError::InvalidMint,
)]
pub researcher_token_account: Account<'info, TokenAccount>,
```
(melhor ainda: usar `associated_token::mint = mint, associated_token::authority = researcher`.)

**C2 — `refund_expired` não verifica quem é o cliente nem para onde vai o dinheiro.**
Não há `require!(job.client == client.key())` nem constraint em `client_token_account`. **Qualquer carteira pode drenar qualquer job expirado** para si. Corrigir com `has_one = client` no `job_account` e `constraint = client_token_account.owner == job_account.client`.

**C3 — Deadlock em `EvidenceSubmitted`** (ver F3/F4). Adicionar `review_deadline`, `claim_after_review` (pesquisador saca se o cliente silenciar), `open_dispute` e `resolve_dispute` (árbitro).

### 🟠 Altos

| ID | Achado | Correção |
|---|---|---|
| A1 | Seeds `[b"job", job_id]` são **globais** → qualquer um pode ocupar ("squat") o ID que o backend gerou. | Seeds `[b"job", client.key().as_ref(), job_id.as_bytes()]` (idem vault). |
| A2 | `job_account` e `vault_account` em `ApproveAndRelease`/`RefundExpired` sem `seeds`/`bump`/`has_one`. O vault "se salva" porque a assinatura PDA falharia, mas é frágil. | Declarar `seeds = [...], bump = job_account.vault_bump` em todas as instruções. |
| A3 | Mint não validado: dá para criar job com token falso e o frontend/backend mostrar "350 USDC". | Guardar `mint` no `JobAccount` e restringir ao mint do USDC (devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). |
| A4 | `accept_job` aberto a qualquer um, sem checar deadline. | `assign_researcher` pelo cliente (ou allowlist) + `require!(now < deadline)`. |
| A5 | `deadline` e `amount` sem validação. | `require!(amount > 0)`, `require!(deadline > now + MIN_DURATION)`. |
| A6 | Contas nunca são fechadas (rent fica preso; `CloseAccount` importado e não usado). | Fechar `vault` (token CPI `close_account`) e `job_account` (`close = client`) no release/refund. |
| A7 | Sem `emit!` de eventos. | Emitir `JobCreated`, `JobAccepted`, `EvidenceSubmitted`, `JobReleased`, `JobRefunded` → alimenta o indexador (ver §3). |

### 🟡 Médios / estrutura do projeto

- **`Cargo.toml` sem a feature `idl-build`** — a partir do Anchor 0.30 o IDL não é gerado sem ela. Ou seja, o item "importar o IDL no frontend" do backlog **não funciona** com o setup atual:
  ```toml
  [features]
  idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
  ```
- **Falta o workspace Anchor**: não existe `Anchor.toml`, `Cargo.toml` de workspace, `tests/` nem `migrations/`. `anchor build` dentro de `contracts/` não roda. Recomendo recriar com `anchor init` e colar o `lib.rs`.
- `token::transfer` → preferir `transfer_checked` (valida decimais/mint).
- `Sysvar<Rent>` é desnecessário no `InitializeJob`.
- Falta um campo `scope_hash: [u8; 32]` (escopo/RoE assinado) e `review_deadline: i64`.
- O ID placeholder `PrfSec111…` é base58 válido, mas o deploy vai gerar outro — use `anchor keys sync` em vez de trocar à mão.

---

## 3. Backend AWS (SAM + Lambda + DynamoDB + S3) — achados

### 🔴 Críticos

**B1 — `GET /jobs` vai quebrar em produção.** O DynamoDB retorna números como `Decimal` (`createdAt`, `deadlineTimestamp`), e `json.dumps` não serializa `Decimal` → **HTTP 500 em toda listagem** assim que houver um item. Corrigir com um encoder:
```python
from decimal import Decimal
def _default(o):
    if isinstance(o, Decimal): return int(o) if o % 1 == 0 else float(o)
    raise TypeError
json.dumps(body, default=_default)
```

**B2 — Nenhuma autenticação.** Qualquer pessoa pode chamar `POST /evidence/presigned-url` para qualquer `job_id`, trocar o `researcherWallet` e marcar o job como `EVIDENCE_SUBMITTED`. Também pode criar jobs em nome de qualquer `client_wallet`.
→ **Sign-In With Solana (SIWS)**: o usuário assina uma mensagem com o Phantom, uma Lambda verifica a assinatura ed25519 (`PyNaCl`) e emite um JWT; o HTTP API usa um **JWT authorizer** nativo. As Lambdas passam a usar a wallet do token, nunca a do body.

**B3 — DynamoDB como fonte da verdade de status.** O backend grava status com base no que o cliente HTTP diz, sem olhar a chain. Status on-chain e off-chain vão divergir.
→ **A Solana é a fonte da verdade.** O DynamoDB vira **indexador/cache**, alimentado por eventos on-chain (webhook Helius → Lambda, ou polling agendado via EventBridge). O DynamoDB guarda só o que não cabe on-chain: título, descrição, chave do S3, metadados.

### 🟠 Altos

| ID | Achado | Correção |
|---|---|---|
| B4 | **Três máquinas de estado diferentes**: on-chain `Open/InProgress/EvidenceSubmitted/Completed/Refunded`; backend `OPEN/ACCEPTED/…/CANCELLED/PROPOSED_BY_AGENT`; frontend `OPEN/IN_PROGRESS/…`. | Um enum canônico único (gerado do IDL) + um estado off-chain `DRAFT/PROPOSED` *antes* de existir on-chain. |
| B5 | **IDs desacoplados**: o backend gera `uuid[:8]`, o agente gera `AGENT-xxxxxx` (12 chars), o contrato usa um `job_id` próprio. Não há garantia de que o `escrowPda` enviado corresponda ao job. | O backend cria o draft e devolve o `jobId` → o frontend usa esse ID nas seeds → o backend **deriva o PDA e confere on-chain** antes de marcar `OPEN`. |
| B6 | **Presigned URL não garante que o arquivo bate com o hash.** O status vai para `EVIDENCE_SUBMITTED` antes de o upload acontecer, e o arquivo enviado pode ser outro. | Gerar a URL com `ChecksumSHA256` (base64 do hash): **o próprio S3 rejeita o upload se o conteúdo não bater**. Marcar status só após o evento `s3:ObjectCreated` + confirmação on-chain. |
| B7 | **Relatório de pentest = dado altamente sensível** (vulnerabilidades abertas). Bucket com SSE padrão, CORS `*`, e não existe endpoint de download controlado. | Criptografia no cliente (chave do cliente/X25519 derivada da wallet ou chave simétrica compartilhada via ECDH) + SSE-KMS + presigned GET só para `client` e `researcher` autenticados. CORS restrito ao domínio do frontend. |
| B8 | `ContentType: application/pdf` fixo, mas o frontend aceita `.txt/.json` → a assinatura da URL falha (403) para esses tipos. | Alinhar os tipos aceitos ou parametrizar. |
| B9 | O Policy Engine (Lambda) só **grava um registro** com status `OPEN`; ninguém assina transação nenhuma. "AUTO_ESCROW_READY" não deposita nada. | Ver §5 (agente). |

### 🟡 Médios
- `scan(Limit=50)` sem paginação; a GSI `StatusIndex` existe mas não é usada → usar `query` na GSI.
- `deadline_days * 86400` quebra se vier string; validar inputs (pydantic ou validação manual).
- Três cópias da função `response()` → criar um Lambda Layer `common/`.
- `budgetUsdc` como string → guardar em **unidades base (u64, 6 decimais)**, igual ao on-chain, para não ter erro de arredondamento.

---

## 4. Frontend (Next.js 14 + Wallet Adapter) — achados

| ID | Severidade | Achado | Correção |
|---|---|---|---|
| W1 | 🟠 | **Next 14.2.24 tem CVE conhecida** (CVE-2025-29927, bypass de middleware, corrigida na 14.2.25). Hoje não há middleware, mas um produto de segurança com dependência vulnerável pega mal na banca. | Subir no mínimo para 14.2.x mais recente, ou migrar para Next 15/16 (versões corrigidas). Rodar `npm audit`. |
| W2 | 🟠 | "Vincular ao Job" sempre usa `jobs[0]`, seja qual for o job/status/papel. | Seletor de job filtrado por `researcher == wallet && status == InProgress`. |
| W3 | 🟠 | "Validar Hash & Liberar" **não valida nada**. | Baixar o arquivo (presigned GET), recalcular SHA-256 no browser, comparar com `job_account.evidence_sha256` on-chain e só então assinar `approve_and_release`. Isso vira um ótimo momento visual na demo. |
| W4 | 🟡 | "Aceitar Job" não muda estado; não existe `IN_PROGRESS` na UI. | Plugar `accept_job` real. |
| W5 | 🟡 | `alert()` dizendo "commitado on-chain com sucesso" sem transação real. | Na demo, mostrar o link real do Solana Explorer (o README já promete isso no minuto 3). |
| W6 | 🟡 | `PhantomWalletAdapter` explícito é desnecessário: Phantom implementa **Wallet Standard** e é detectado automaticamente com `wallets=[]`. | Simplificar; habilita Solflare/Backpack de graça. |
| W7 | 🟡 | `clusterApiUrl('devnet')` público tem rate limit agressivo (vai falhar durante a demo ao vivo). | RPC dedicado (Helius/Triton free tier) em `NEXT_PUBLIC_RPC_URL`. |
| W8 | 🟡 | Hash em hex no front/back, `[u8; 32]` no contrato. | Helper único `hexToBytes32()`; testar a conversão. |
| W9 | ℹ️ | `@phantom/wallet-sdk` citado no contexto para embedded wallet. | O SDK atual é o **Phantom Connect** (`@phantom/react-sdk`); se quiser login social / sem extensão, é ele. |

---

## 5. Agente de IA e Policy Guard — o maior gap conceitual

Hoje o "Policy Guard" é um `if budget <= 500` em Python. Isso **não é um guardrail**, por três motivos:

1. **Não há chave assinando nada.** Para o agente abrir escrow "autonomamente", ele precisa de uma keypair. Onde ela fica? (Secrets Manager/KMS resolvem o armazenamento, mas o ideal é que a chave do agente tenha **poder limitado on-chain**, para que um vazamento não esvazie a tesouraria — ver abaixo.)
2. **O limite está fora da chain.** Se a Lambda for comprometida (ou a LLM sofrer *prompt injection* via um alerta malicioso), o limite some.
3. **É por job, não por período.** 1.000 jobs de US$ 499 passam no guard.

### Opções de enforcement real (da mais simples para a mais completa)

| Opção | Como | Prós | Contras |
|---|---|---|---|
| **A. SPL Token `approve` (delegate)** | A empresa aprova a pubkey do agente como *delegate* na sua conta USDC com allowance de X. O agente assina `initialize_job` como delegate. | Nativo, 1 instrução, o limite é imposto pelo Token Program. | Limite total (não por job/período); precisa reaprovar. |
| **B. Squads v4 Spending Limits** ⭐ | Tesouraria da empresa = multisig Squads; o agente é membro com *spending limit* (valor + período). Acima disso → proposta para assinatura humana. | **Alinha direto com o sponsor Altitude (que é da Squads)**, limite por período, aprovação humana nativa. | Mais integração (SDK `@sqds/multisig`). |
| **C. Policy PDA no próprio ProofSec** | Conta `AgentPolicy { owner, agent, max_per_job, max_per_period, spent_in_period, period_start }` + instrução `initialize_job_by_agent`. | Controle total, ótimo para demo. | Mais código a auditar. |

**Recomendação para o hackathon:** **B** se houver tempo (é a melhor história com Altitude/Squads); **A ou C** como fallback. Em qualquer caso, **a LLM só propõe; quem decide é código determinístico + regra on-chain.** Diga isso no pitch — jurados de AI+crypto perguntam exatamente sobre prompt injection e custódia de chave do agente.

### Integração com a LLM
- Use a LLM para: classificar o alerta, gerar o escopo/RoE em texto, estimar orçamento por tabela (não "inventar" valor).
- Entrada da LLM = dados não confiáveis (texto de alerta pode conter injeção). Saída em JSON com schema validado; orçamento sempre *clampado* pelo guard.
- GuardDuty/Security Hub → EventBridge → Lambda do agente (em vez de botão). Para a demo, um evento sintético via `aws events put-events` funciona e é verdadeiro.

---

## 6. Conflitos e compatibilidade entre tecnologias

| Conexão | Status | Observação |
|---|---|---|
| **Anchor 0.30.1 (Rust) ↔ toolchain atual** | 🔴 Conflito | O 0.30.1 tem problemas conhecidos de geração de IDL com versões novas do Rust/proc-macro2. O **Anchor 1.0 já é estável** (anchor-lang 1.1.x), exige Solana 3.x, usa Surfpool/LiteSVM para testes e não depende mais da Solana CLI. Para um projeto que ainda nem compilou, **comece direto no 1.x** (via `avm`). |
| **`@coral-xyz/anchor` (front) ↔ programa** | 🔴 Conflito | No Anchor 1.0 o pacote TS passou a ser **`@anchor-lang/core`**. Front e programa precisam estar na mesma major. |
| `@solana/web3.js` v1 ↔ Anchor TS | 🟢 OK | Ainda é a base do client Anchor; o `@solana/kit` (web3.js v2) não é necessário para o MVP. |
| Next.js App Router ↔ Wallet Adapter | 🟢 OK | Já usa `'use client'` e `dynamic(..., {ssr:false})` corretamente. |
| `next.config` fallbacks (`crypto:false`) ↔ `crypto.subtle` | 🟢 OK | `crypto.subtle` é Web API do browser, não o módulo Node. Pode precisar de polyfill de `Buffer` quando entrar o Anchor client. |
| **Windows ↔ Anchor** | 🟠 Atrito | Build só em WSL2/Linux. Plano B para a demo: **Solana Playground** (beta.solpg.io) compila e faz deploy do Anchor na devnet pelo navegador. |
| Frontend deploy: **S3+CloudFront ↔ Next App Router** | 🟠 Atenção | S3 exige `output: 'export'` (estático). Funciona porque a página é 100% client-side, mas some qualquer SSR/API route. Amplify ou Vercel evitam a questão. |
| **AWS (SAM) ↔ Solana** | 🟡 Complexidade | Duas plataformas, dois deploys, duas fontes de estado. Ver §7 — vale enxugar. |
| API Gateway CORS `*` ↔ JWT | 🟡 | Ao adicionar auth, restringir `AllowOrigins` ao domínio do front. |
| S3 presigned PUT ↔ checksum | 🟢 Oportunidade | O S3 suporta `x-amz-checksum-sha256` → o mesmo hash do on-chain é verificado pela AWS. Conecta as duas pontas da arquitetura de forma elegante. |
| **Sponsor Altitude ↔ implementação** | 🟠 Desalinhado | O Altitude é a conta operacional da Squads (stablecoin treasury com limites por código, aprovações multi-parte). A ponte técnica real é **Squads v4 spending limits** — hoje o código só mostra um badge "pronto para Altitude Rail". |
| **Sponsor Reflect ↔ escrow** | 🟢 Viável (V2) | O Reflect emite o **USDC+** (stablecoin com rendimento). Basta o vault guardar USDC+ em vez de USDC → o yield acumula sozinho, sem CPI complexa. Cuidado: definir quem fica com o yield e o risco de depeg. |
| **Sponsor Meteora ↔ reputação** | 🔴 Não recomendado | Tokenizar reputação com bonding curve cria incentivo para comprar reputação — o oposto do que um marketplace de segurança precisa. Reputação deve ser **não transferível**. |

---

## 7. O que adicionar, remover ou trocar

### ➕ Adicionar
1. **Liberação otimista + disputa** (resolve a assimetria de verdade).
2. **`scope_hash` on-chain** = autorização de teste (RoE) assinada pela carteira do cliente. É um diferencial legal forte: "a autorização para atacar o sistema fica registrada e datada on-chain".
3. **Solana Attestation Service (SAS)** para o "certificado on-chain": no release, o programa (ou a plataforma) emite uma atestação `{researcher, job, severity_summary, client}` → reputação verificável e **não transferível**. Substitui a ideia do Meteora.
4. **Relatório criptografado** ponta a ponta (só cliente e pesquisador leem).
5. **Indexador por eventos** (Helius webhook → Lambda → DynamoDB).
6. **Fee da plataforma** (ex.: 2–5% no release) → modelo de negócio na banca.
7. **Testes do programa** (LiteSVM/Surfpool no Anchor 1.x) cobrindo: release para conta errada, refund por terceiro, deadline no passado, disputa.
8. **Milestones** (V2): liberar em partes (ex.: 30% no kickoff, 70% no relatório) — padrão de pentest.

### ➖ Remover / adiar
- **Meteora** (ver acima).
- **"Bug bounty"** do escopo do MVP: bounty é pagamento por achado, com vários pesquisadores e severidade variável — outro modelo de contrato. Foque em **pentest/retest com valor fixo** e cite bounty como V2.
- **DynamoDB como dono do status** (vira só cache/metadados).
- `agent/agent.py` CLI duplicado do Lambda: mantenha um só núcleo de política (módulo compartilhado) usado pelo CLI e pela Lambda.

### 🔄 Trocar
| De | Para | Por quê |
|---|---|---|
| Anchor 0.30.1 / `@coral-xyz/anchor` | Anchor 1.x / `@anchor-lang/core` | Build quebrado hoje + versão estável atual |
| Policy `if` em Python | Squads spending limit / delegate SPL / Policy PDA | Enforcement real, on-chain |
| Wallet no body da requisição | SIWS + JWT authorizer | Autenticação |
| `clusterApiUrl` público | RPC Helius/Triton | Estabilidade da demo |
| Next 14.2.24 | Next 14.2 mais recente ou 15/16 | CVE |

---

## 8. Ordem de execução recomendada (prioridade para o MVP)

**Fase 1 — Contrato correto (bloqueia todo o resto)**
1. `anchor init` com Anchor 1.x em WSL (ou Solana Playground) → colar o `lib.rs`.
2. Corrigir C1, C2, A1–A5; adicionar `mint`, `scope_hash`, `review_deadline`, eventos.
3. Adicionar `claim_after_review` (+ disputa simples com árbitro fixo, se der tempo).
4. Testes LiteSVM dos casos maliciosos → `anchor deploy` na devnet → `anchor keys sync`.

**Fase 2 — Frontend real on-chain (já dá uma demo honesta sem AWS)**
5. Importar o IDL; `initialize_job`, `accept_job`, `submit_evidence`, `approve_and_release` via Phantom.
6. Listar jobs direto da chain (`program.account.jobAccount.all()` com filtro `memcmp` por cliente/pesquisador).
7. Fluxo "baixar → re-hashear → comparar com on-chain → aprovar" + links do Explorer.

**Fase 3 — Backend com papel claro**
8. Corrigir B1 (Decimal), SIWS + JWT authorizer.
9. Presigned PUT com `ChecksumSHA256` + criptografia no cliente + presigned GET autenticado.
10. Indexador por eventos (Helius webhook → DynamoDB) para metadados e busca.

**Fase 4 — Agente e sponsors**
11. Policy on-chain (Squads spending limit ⭐ ou delegate SPL).
12. LLM gerando escopo/RoE com saída JSON validada; trigger via EventBridge (evento sintético na demo).
13. Atestação SAS no release.
14. (V2) Vault em USDC+ (Reflect).

**Fase 5 — Deploy e pitch**
15. Front no Amplify/Vercel; RPC dedicado; ensaiar a demo com transações reais no Explorer.

---

## 9. Ajuste sugerido para o pitch (3 min)

1. **Problema:** assimetria de confiança *e* de autorização legal em contratações de segurança ofensiva.
2. **Demo:** alerta do GuardDuty → agente propõe escopo → guard on-chain (Squads/Altitude) libera 350 USDC sem humano → pesquisador comita hash do relatório criptografado → cliente re-hasheia no browser → release + atestação de reputação. Tudo com links do Explorer.
3. **Diferencial:** "A IA propõe, a chain impõe" — limite de gasto do agente imposto on-chain, autorização de escopo datada on-chain, pagamento garantido por janela de contestação.

---

## Fontes consultadas
- [Anchor 1.0.0 — release notes](https://www.anchor-lang.com/docs/updates/release-notes/1-0-0) · [anchor-lang 1.1.2 (docs.rs)](https://docs.rs/crate/anchor-lang/latest) · [Anchor CHANGELOG](https://github.com/solana-foundation/anchor/blob/master/CHANGELOG.md)
- [Altitude](https://altitude.xyz/) · [Introducing Altitude (Squads)](https://squads.xyz/blog/introducing-altitude-and-a-strategic-investment-from-haun-ventures) · [Squads v4](https://squads.xyz/blog/v4-and-new-squads-app)
- [Reflect Money — USDC+](https://solanacompass.com/projects/reflect-money)
- [Phantom React SDK / Phantom Connect](https://docs.phantom.com/sdks/react-sdk)
- [Solana Attestation Service — Schemas](https://solana.com/docs/tools/attestations/schemas)
