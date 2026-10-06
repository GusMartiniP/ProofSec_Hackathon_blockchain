# Resiliência e monitoramento — ProofSec

Princípio: **os fundos não dependem da AWS.** Se o backend cair, toda liquidação continua
possível com transações diretas na Solana ("modo só on-chain").

## 1. Dependências críticas

| Dependência | Falha | Detecção | Fallback | Recuperação | Verificação |
|---|---|---|---|---|---|
| RPC Solana | timeout, 429, fora do ar | erro no frontend/Lambda; alarme de erro do indexador | RPC secundário (PS-13); modo leitura degradado | trocar o provedor em `NEXT_PUBLIC_RPC_URL` / `SolanaRpcUrl` | `getLatestBlockhash` ok; jobs listados |
| Rede Solana (congestão) | tx não confirma, blockhash expira | erro de confirmação | usuário reassina; **sem reenvio cego** | prioridade de fee (futuro) | tx no explorer |
| API Gateway / Lambda | 5xx, throttling | alarme 5xx / Throttles (PS-11) | frontend em modo só on-chain | redeploy via SAM | `GET /jobs` 200 |
| DynamoDB | indisponível, dados apagados | erros nas Lambdas | a chain continua valendo | reindexar pela chain (indexer); PITR em produção | contagem de jobs = chain |
| S3 | objeto ausente ou removido | 404 no download | pesquisador reenvia o mesmo arquivo (hash igual ao on-chain) | versionamento recupera objetos | re-hash = on-chain |
| `verify_upload` | falha | DLQ com mensagens (PS-11) | reprocessar a DLQ | corrigir e redrive | objeto verificado |
| LLM | fora do ar, saída inválida | log de fallback | template determinístico | — | proposta gerada |
| Executor do agente | host/Lambda parado | propostas presas em `AUTO_APPROVED`; alarme de erros | humano financia pelo painel | Lambda agendada (ADR-012); recusas viram `NEEDS_HUMAN` | proposta vira `ONCHAIN` |
| Árbitro | inativo | prazo de disputa vencendo (alerta SNS na abertura) | qualquer um aplica 50/50 após `dispute_deadline` | ADR-014 | job `RESOLVED` |
| Conta AWS perdida | — | — | modo só on-chain | runbook §4 (recriação via SAM) | health checks |

## 2. Monitoramento

**MVP**
- Alarmes nativos de `Errors` e `Throttles` no authorizer, evidence, indexer e agent.
- Metric filters no log estruturado cobrem exceções de `auth/verify` convertidas em HTTP 500
  e falhas por item/configuração que o indexador captura para continuar a rodada.
- 5xx do API Gateway.
- Retenção de logs de 14 dias.
- Tópico SNS de alertas.

**Eventos de segurança a alertar**
- Falhas repetidas de login.
- Muitas propostas do agente por hora.
- Cada job criado pelo agente (PS-05).
- `verify_upload` apagando objeto (hash divergente).
- Mudança de `Config` (evento on-chain, via indexador).

**Produção**
- CloudTrail.
- Orçamento de custo (AWS Budgets) e detecção de anomalia de custo.
- Dashboard.

**Níveis de alerta:** Informational · Warning · Critical · Security Incident.

## 3. Idempotência e reenvio

- `POST /jobs/{id}/sync` e o indexador são idempotentes.
- A criação de draft e de proposta usa `ConditionExpression`.
- Propostas de EventBridge usam ID determinístico por finding; retries retornam duplicata sem
  criar novo item. Lotes do Security Hub são processados por inteiro.
- Candidaturas usam `UpdateItem` condicional e não substituem o snapshot completo do job.
- O executor verifica se o PDA já existe antes de reenviar.
- Nenhum componente reenvia transação assinada automaticamente.
