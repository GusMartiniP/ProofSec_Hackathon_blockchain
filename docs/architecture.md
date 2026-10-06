# Arquitetura — ProofSec

Visão completa com diagramas: `docs/ProofSec_Manual_Tecnico.pdf`.
Este arquivo é o resumo de referência para os agentes.

## 1. Domínios

| Domínio | Responsabilidade | Código |
|---|---|---|
| Navegador | carteira, assinatura de transações, cifragem e verificação de relatórios | `frontend/` |
| Solana | dinheiro, regras, prazos, limites do agente (fonte da verdade) | `contracts/` |
| AWS (backend) | login SIWS, metadados, S3, indexador, cérebro do agente e alertas | `backend-serverless/` |
| Executor do agente | assina `initialize_job_by_agent` dentro da política on-chain | `agent/core.ts` (CLI `executor.ts` ou Lambda `lambda.ts`) |

## 2. Componentes AWS (SAM)

- **API:** HTTP API Gateway com throttling por rota e Lambda authorizer (JWT HS256 emitido via SIWS).
- **Segredos (PS-07):** AWS SSM Parameter Store (`SecureString`, `/proofsec/<stage>/*`). Nenhum segredo em variáveis de ambiente abertas nem no git.
- **Lambdas (Python 3.12, arm64, sem dependências externas):**
  - `auth`: emissão de nonce com TTL, verificação de assinatura SIWS e autorizador JWT;
  - `jobs`: listagem pública, `mine`, candidaturas (`apply`), criação de draft, sync com fallback de RPC;
  - `evidence`: URLs pré-assinadas com checksum SHA-256 forçado e verificação pós-upload no S3;
  - `users`: chave pública X25519 para cifragem assimétrica de ponta a ponta;
  - `agent`: endpoint `propose` (com quota horária), `on_event` (GuardDuty/Security Hub) e fila para o executor;
  - `indexer`: reconciliação periódica a cada 1 minuto (Solana → DynamoDB).
- **Dados & Storage:**
  - DynamoDB `ProofSec-Jobs` (GSIs Status, Client, Researcher), `ProofSec-Users` e `ProofSec-Nonces` (com TTL atômico, PS-09);
  - S3 `proofsec-reports-*`: bloqueio público total, versionamento, SSE e notificações via DLQ/SNS.
- **Eventos & Observabilidade (PS-05, PS-11):**
  - EventBridge com regras para GuardDuty, Security Hub, `proofsec.demo` (somente stage dev) e scheduler do indexador;
  - SNS (`AlertsTopic`) para alertas operacionais e de segurança (jobs do agente, upload de evidências, abertura de disputas e alterações de `Config`);
  - SQS DLQ para falhas de processamento assíncrono;
  - Logs CloudWatch com retenção explícita e alarmes de erro / orçamento mensal.
- **Stack do Executor (`agent/template.yaml`, ADR-012):**
  - Lambda agendada opcional em stack isolada, consumindo chave privada do SSM e operando `agent/core.ts`.

## 3. Fluxo principal

1. Login SIWS → nonce em DynamoDB com TTL → verificação Ed25519 → JWT emitido.
2. `POST /jobs` → `jobId` + `scope_hash` (SHA-256 canônico do escopo/RoE). O `scopeDocument` só
   volta ao cliente e ao pesquisador atribuído; listagens são paginadas (`limit`, `offset`, ADR-020).
   O frontend confere `sha256(scopeDocument) == scope_hash` e os valores antes de assinar.
3. `initialize_job` (ou `initialize_job_by_agent`): USDC transferido para o vault PDA on-chain.
4. `POST /jobs/{id}/sync`: DynamoDB espelha o estado on-chain validado.
5. Candidatura e Seleção:
   - Pesquisadores enviam candidaturas (`POST /jobs/{id}/apply`);
   - Cliente seleciona e atribui on-chain (`assign_researcher`);
   - Pesquisador atribuído aceita o trabalho on-chain (`accept_job`).
6. Pesquisador cifra o relatório no navegador com TweetNaCl (usando a chave do cliente, só depois de
   verificar a assinatura da carteira sobre ela, ADR-022) → PUT pré-assinado com checksum no S3 → transação on-chain `submit_evidence(sha256)` iniciando janela de revisão (≥ 72h).
7. Cliente baixa o relatório do S3 → recalcula SHA-256 → compara com o registro da chain → decifra no navegador.
8. Liquidação dos fundos:
   - **Aprovação direta:** cliente chama `approve_and_release`;
   - **Liberação otimista:** silêncio do cliente após a janela → pesquisador chama `claim_after_review`;
   - **Disputa:** cliente abre disputa (`open_dispute`) → árbitro decide divisão (`resolve_dispute`);
   - **Timeout de disputa:** árbitro inerte após o prazo → qualquer parte chama `resolve_dispute_timeout` (divisão automática 50/50);
   - **Reembolso / Cancelamento:** `refund_expired` após deadline sem entrega ou `cancel_job` antes do aceite.

## 4. Agente de IA

1. Alerta recebido (AWS GuardDuty, Security Hub ou demo sintetizada).
2. Severidade avaliada pelo **Policy Engine determinístico** (fora da LLM) → orçamento e prazos calculados.
3. A LLM gera apenas o texto descritivo e o plano de teste do escopo.
4. Decisão autônoma vs. humana:
   - **AUTO_APPROVED** (≤ teto configurado): proposta gravada; o executor (`agent/core.ts`) verifica a `AgentPolicy` e o delegate SPL on-chain e assina `initialize_job_by_agent`;
   - **NEEDS_HUMAN** (> teto ou falha de política): proposta aguarda aprovação manual do cliente via carteira (Phantom/Solflare).

## 5. Fronteiras e invariantes

Ver `AGENTS.md` (INV-1 a INV-8) e `docs/threat-model.md`.

## 6. Modos de operação

- **Completo:** com `NEXT_PUBLIC_API_URL` ativa e backend serverless.
- **Só on-chain:** sem a API. Criação, atribuição, aceite, registro de hash e liquidação ocorrem diretamente via chamadas RPC na Solana. Sem metadados off-chain, sem upload de arquivos no S3 e sem propostas automáticas do agente.
