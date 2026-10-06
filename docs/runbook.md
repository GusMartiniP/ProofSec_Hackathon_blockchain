# Runbook — deploy, incidentes e recuperação

## 0. Preparação local (não exige conta AWS)

Antes de receber credenciais ou criar recursos, execute na raiz:

```
npm run preflight:local
```

O preflight roda testes do backend e do executor, valida os dois templates SAM offline,
verifica tipos, gera e carrega o bundle CommonJS da Lambda do executor, compila o frontend e
confere o IDL provisório contra o Rust. Ele não acessa AWS, não usa carteira e não faz deploy.

Ainda são verificações obrigatórias quando as ferramentas estiverem instaladas: `sam validate
--lint`, `sam build`, `anchor build` e `anchor test`. Para o primeiro uso da conta, instale AWS
CLI v2 e SAM CLI, prefira IAM Identity Center + MFA, escolha a região e confirme a identidade
antes de qualquer changeset:

```
aws configure sso
aws sts get-caller-identity
aws configure get region
```

Não coloque as respostas desses comandos, IDs de conta, credenciais ou segredos no git.

## 1. Ambientes

`local` → `dev` (stack `proofsec-dev`, devnet) → produção (futuro: conta AWS separada e mainnet).
Nunca usar credenciais ou carteiras de produção em dev.

## 2. Deploy (ordem)

1. **Programa** (Codex): `anchor build` (sincroniza o IDL) → `anchor test` →
   `anchor deploy --provider.cluster devnet` → inicializar a `Config` com a carteira que fez o
   deploy (só a upgrade authority consegue, PS-03), pelo card do frontend.
2. **Segredos** (uma vez por stage; nunca no git nem no template, PS-07):
   ```
   aws ssm put-parameter --name /proofsec/dev/jwt-secret     --type SecureString --value "<64+ caracteres aleatórios>"
   aws ssm put-parameter --name /proofsec/dev/agent-api-key  --type SecureString --value "<32+ caracteres aleatórios>"
   # opcionais
   aws ssm put-parameter --name /proofsec/dev/anthropic-api-key --type SecureString --value "<chave>"   # com EnableLlm=true
   aws ssm put-parameter --name /proofsec/dev/agent-keypair  --type SecureString --value file://agent/agent-keypair.json  # executor Lambda
   ```
   Rotação: `put-parameter --overwrite`; as Lambdas releem em até 5 min (cache).
3. **Backend** (Kiro), em `backend-serverless/` (usa `samconfig.toml`):
   ```
   sam validate --lint
   sam build            # precisa do Python da runtime (3.12) ou use --use-container
   sam deploy --no-execute-changeset
   ```
   Revisar o changeset → **aprovação humana** → `sam deploy`. Parâmetros principais:
   `ProgramId`, `SiwsDomains`, `AllowedOrigin`, `AlertEmail` (confirme o e-mail do SNS),
   `CompanyWallet`, `EnableLlm`. Fora de `dev`, as `Rules` do template recusam
   `AllowedOrigin='*'`, `localhost` em `SiwsDomains`, `AlertEmail` vazio e o `ProgramId`
   provisório. A rede permanece restrita à devnet neste MVP. Tabelas e bucket têm `Retain`.
4. **Frontend** (Claude Code): `.env.local` com `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_API_URL`
   (output `ApiEndpoint`) e, se houver, `NEXT_PUBLIC_RPC_URL_FALLBACK` → `npm run build`.
   Em `next start`/Amplify SSR/Vercel os headers de segurança saem do `next.config.mjs`; em
   export estático (S3+CloudFront) replique-os numa response headers policy.
5. **Agente** (opcional):
   - CLI: `cd agent && npm install && npm run keygen` → pubkey na política (painel) →
     `API_URL=... AGENT_API_KEY=... npm run executor`.
   - Lambda (ADR-012): `cd agent && npm install && sam build && sam deploy` com `ApiUrl` e
     `AlertsTopicArn` dos outputs do backend (ver `agent/samconfig.toml`). O primeiro deploy
     fica com `ScheduleState=DISABLED`; habilite somente depois de conferir a chave pública,
     o delegate SPL, a `AgentPolicy` on-chain e uma rodada manual do executor. Fora do dev o
     parâmetro `AllowedOwners` (pubkeys das empresas, separadas por vírgula) é obrigatório
     (ADR-023); na CLI use `ALLOWED_OWNERS`.
   - Parar o agente: `ScheduleState=DISABLED` (stack do executor) **ou** "Desativar" no painel.
6. **Smoke test:** criar job de 1 USDC → pesquisador se candidata → cliente atribui → aceite →
   evidência → aprovar → conferir no explorer. O árbitro precisa clicar em "Ativar
   criptografia" uma vez para receber relatórios cifrados.

## 3. Resposta a incidentes

Fluxo: detecção → contenção → investigação → erradicação → recuperação → revisão
pós-incidente (com teste de regressão).
Não destruir recursos antes de preservar evidências (logs, objetos, transações).

| Incidente | Contenção imediata | Erradicação / recuperação |
|---|---|---|
| Chave do executor vazada | `set_agent_policy(active=false)` + allowance 0 (botão "Desativar" no painel) | nova keypair, nova política, revisar jobs criados pelo agente e contestar os suspeitos |
| Backend comprometido | desativar a política do agente; restringir `AllowedOrigin`; girar o segredo do JWT | revisar propostas `AUTO_APPROVED`, logs e IAM; redeploy limpo via SAM |
| Segredo do JWT vazado | rotacionar o parâmetro no SSM; sessões antigas deixam de funcionar após os caches do SSM/authorizer expirarem (até cerca de 10 min) | investigar a origem; para revogação imediata, reduzir/invalidar temporariamente o cache do authorizer; PS-07 |
| `AGENT_API_KEY` vazada | `put-parameter --overwrite` em `/proofsec/<stage>/agent-api-key` (cache de 5 min) | auditar propostas executadas e recusadas |
| Executor com erro em loop | `ScheduleState=DISABLED` | ver logs `/proofsec/<stage>/agent-executor` e a fila de propostas |
| Relatório exposto | conferir que só o envelope cifrado vazou (a chave não está no servidor) | se a chave de uma carteira vazou (PS-06), nova mensagem v2 e reenvio |
| Bug no programa | avisar os usuários; não criar novos jobs | correção + teste de regressão → upgrade com **aprovação** (ADR-011) |
| Árbitro indisponível | nada a fazer on-chain: após `dispute_deadline` qualquer um aplica 50/50 | trocar o árbitro na `Config` (vale para jobs novos; aprovação humana) |
| Custo inesperado na AWS | identificar o recurso (Cost Explorer); baixar throttling da rota | orçamento (`AlertEmail`) e alarmes |

Relatório pós-incidente: linha do tempo, causa raiz, impacto, componentes, contenção,
correção, controles preventivos e testes de regressão.

## 4. Recuperação de desastre

| Dado / recurso | Fonte de recuperação |
|---|---|
| Estado dos jobs (status, valores, hashes) | **chain** → indexador reconstrói o DynamoDB |
| Títulos e escopos (metadados de draft) | DynamoDB (PITR em produção); o `scope_hash` on-chain prova a versão |
| Relatórios | S3 versionado; se perdidos, o pesquisador reenvia (hash precisa bater) |
| Chaves públicas X25519 | usuários republicam ("Ativar criptografia") |
| Infraestrutura | `sam deploy` numa conta nova (tudo está no template) |
| Credenciais | novos parâmetros SSM; nova keypair do agente; nova política |

Validação depois da recuperação: smoke test do §2, contagem de jobs igual à da chain e
alarmes ativos.
