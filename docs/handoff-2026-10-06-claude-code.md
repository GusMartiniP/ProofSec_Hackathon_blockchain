# Handoff — Claude Code · deploy AWS dev, hospedagem do frontend e papéis (2026-10-06)

Para o **Codex** (e qualquer agente que assuma depois). Resume a sessão do Claude Code: o que foi feito,
o estado real da AWS, as decisões, os erros que custaram tempo e o que falta. Não contém segredos.
Regras gerais continuam no `AGENTS.md` da raiz. Autor das mudanças: Claude Code; revisão independente
(Antigravity) ainda **pendente** para tudo abaixo.

## 1. Estado em uma olhada

| Item | Estado |
|---|---|
| Programa Solana (devnet) | `HCYkSp64qdMRjiCbauEzPhx9VtNGB6fp5NvKdCRb8tjj`; `Config` devnet em `2qX6gWqAiTjLcQCg53UiCpfTnnNgs89GkwbSWfVNRyXQ` (README). Deploy feito por outro agente, não por esta sessão |
| Backend (`proofsec-dev`, us-east-1) | **no ar**, `UPDATE_COMPLETE`, `ProgramId` = o de cima |
| API | `https://mgzbzfov0g.execute-api.us-east-1.amazonaws.com` |
| Frontend | **Amplify Hosting** (deploy manual por zip): `https://staging.dhkblca1hli2z.amplifyapp.com`; Next.js 16.4.0 |
| CloudFront | **bloqueado pela conta** (ver §5); por isso o Amplify |
| Executor do agente (`agent/template.yaml`) | **não implantado** (precisa de keypair com fundos e `AgentPolicy`) |
| Usuários IAM dos agentes | template pronto (`docs/iam/agent-users.yaml`), **não criado**; o MCP da AWS ainda usa o perfil `ProofSec` = **root** |
| Teste ponta a ponta com carteira | **não feito**; só login SIWS e rotas públicas/401 validados |

Última ação do usuário: tentou criar o primeiro escrow de 1 USDC e a Phantom falhou com
"Attempt to debit an account but found no record of a prior credit" = **carteira com saldo zero na devnet**
(airdrop foi para outra rede ou endereço). O teste e2e está parado nisso.

## 2. Commits desta sessão (`main`, sem push)

```
6d07ba8 Merge fix/ps-44-next-upgrade: Next.js 16.4.0 (PS-44)
4f1b405 security: Next.js 14.2.35 → 16.4.0 (PS-44)
8259c97 feat: experiência por papel Empresa/Pesquisador (ADR-025)
c50d0c0 docs: ADR-025
509ebf2 fix: permite ao API Gateway invocar o authorizer
6030fa2 docs: ADR-024, runbook, revisão de segurança e contexto
1b55a30 infra: hosting.yaml, customHttp.yml e agent-users.yaml
11b2f17 infra: ProgramId padrão do backend e do executor
9b8dbfb chore: Program ID devnet oficial nos contratos e IDLs   <- mudanças do Codex/outro agente, só commitadas aqui
```

## 3. O que foi feito, por área

**Backend (`backend-serverless/`)** — validado (`sam validate --lint`, `sam build`) e implantado com
`sam deploy` (executado pelo **usuário**; o classificador de permissões do Claude Code bloqueou `sam deploy`
duas vezes, ver §6). Parâmetros ativos: `Stage=dev`, `AlertEmail` definido (assinatura SNS confirmada),
`SiwsDomains=<host do Amplify>,localhost:3000`, `AllowedOrigin=https://<host do Amplify>`.
Segredos criados no SSM como SecureString, valores nunca exibidos: `/proofsec/dev/jwt-secret` e
`/proofsec/dev/agent-api-key`. **Não existem** `agent-keypair` nem `anthropic-api-key`.

**Bug corrigido (509ebf2):** o template declarava o `WalletAuthorizer` mas **não** o
`AWS::Lambda::Permission` para o API Gateway invocar o authorizer; o SAM não o cria em HTTP API. Toda
rota autenticada devolvia 500 ("doesn't have permissions to call the authorizer") e só `/auth/*` e
`GET /jobs` funcionavam. Teste de regressão: `backend-serverless/tests/test_template.py`.
Hoje: sem token → 401, token inválido → 403, origem estranha sem `allow-origin`.

**Frontend (`frontend/`)**
- `hosting.yaml`: S3 privado + CloudFront (OAC) + response headers policy. Validado, **nunca criado**.
- `customHttp.yml`: headers de segurança (CSP, HSTS, `X-Frame-Options`...) para colar em *Amplify > Custom headers*
  (PS-12). Está aplicado no app. Se mudar RPC/API/domínio, atualizar o `connect-src` aqui **e** em `next.config.mjs`.
- **ADR-025 (Aceita):** papéis de visão Empresa/Pesquisador (+ aba de árbitro). Só UI, `localStorage` por
  carteira, sem mudança no contrato HTTP. Código: `src/lib/role.ts`, `src/hooks/useRole.ts`,
  `src/components/RolePicker.tsx`, `src/app/page.tsx`. Teste: `tests/role.test.ts` (9 casos, dentro de `npm run test:meta`, 18/18).
- **PS-44:** Next 16.4.0 (fixado). `next dev/build` usam `--webpack` porque o Turbopack (padrão no 16)
  recusa o `webpack()` de `next.config.mjs` (dá `Buffer` ao Anchor/web3.js). React 18.3.1 mantido (obsoleto no
  Next 16; migrar para o 19 mexe nos wallet adapters). `npm audit`: críticos 1 → 0. Script `lint` removido.
  O Next reescreveu `tsconfig.json` e `next-env.d.ts`.
- Build estático (comando exato):
  `NEXT_STATIC_EXPORT=1 NEXT_PUBLIC_API_URL=<API> NEXT_PUBLIC_CLUSTER=devnet NEXT_PUBLIC_PROGRAM_ID=HCYk… npm run build`.
  No PowerShell as variáveis vão em `$env:`. A saída é `frontend/out/` (ignorada pelo git).

**IAM dos agentes (`docs/iam/agent-users.yaml`, não criado):** um usuário por agente (Claude Code, Codex,
Antigravity; Kiro excluído), sem console e sem chave no template. Política comum `guardrails` com Deny
(sem IAM, sem executar changeset, sem ler SSM/relatórios do S3). **O Codex fica só com leitura da stack.**
O Claude Code ganha criar changeset de revisão em `proofsec-dev`; o Antigravity ganha `SecurityAudit`.
Ninguém tem `ExecuteChangeSet`. As ações genéricas `aws-mcp:*` foram removidas na revisão: o AWS MCP
usa as permissões dos serviços AWS chamados e não define essas ações IAM.

**Decisões em `docs/decisions.md`:**
- **ADR-024 (Aceita em 2026-10-06):** backend sai do Kiro e vai para o Claude Code; Claude Code
  gera e testa, **humano executa o changeset**, Antigravity revisa. `AGENTS.md` §1/§5, `agent/AGENTS.md`,
  `backend-serverless/AGENTS.md`, README e runbook já foram atualizados.
- **ADR-025 (Aceita):** papéis na UI.

## 4. Verificações feitas na AWS (somente leitura, via MCP)

Stack, outputs, parâmetros, resource policy do authorizer, assinatura SNS, existência dos parâmetros SSM,
configuração do bucket de relatórios e logs. O bucket `proofsec-reports-dev-<conta>-us-east-1` já está
completo: acesso público bloqueado, SSE-S3, versionamento, lifecycle, CORS só para o Amplify e notificação
para `EvidenceVerify`. O fluxo real (upload, hash, download) **não foi exercitado**: precisa de job on-chain.
Os logs das funções vão para `/proofsec/dev/app` (não para `/aws/lambda/...`); o log de acesso da API é
`/proofsec/dev/api-access` e mostra o `authorizerError`.

## 5. Armadilhas (custaram tempo; não repetir)

1. **CloudFront bloqueado:** `CREATE_FAILED` com 403 "Your account must be verified before you can add new
   CloudFront resources". A conta está no plano **Free** (US$ 140 de crédito, válido até 2027-04-06).
   Resolução pendente: upgrade para o plano Pago ou caso no Support. O Amplify foi o desvio.
2. **Amplify e zip:** o `Compress-Archive` do PowerShell gerou zip com entradas de diretório vazio e o Amplify
   publicou só o `index.html`: **todo `_next/` deu 404** (site sem CSS). Gere o zip com Python (arquivos
   apenas, caminhos com `/`, `index.html` na raiz) ou arraste a pasta `out/`. Sempre valide
   `curl -s -o /dev/null -w "%{http_code}" <site>/_next/static/css/<hash>.css` = 200. O Next 16 também gera
   arquivos `__next.*` (underscore duplo): conferir após cada upload.
3. **SIWS e a carteira:** "chain ID does not match" = a Phantom estava na Mainnet. O app é **só devnet**;
   ativar *Testnet Mode* e escolher Solana **Devnet**.
4. **Log group:** procurar logs em `/proofsec/dev/app`; `/aws/lambda/<função>` não existe nesta stack.
5. **Classificador de permissões do Claude Code:** bloqueou `sam deploy` ("Blind Apply" e "Protected-Scope IaC
   Apply"). Fluxo que funcionou: o agente gera `--no-execute-changeset` e **lê o changeset** (82 Add na criação;
   depois 1 Add + 24 Modify, 0 Replace), o usuário executa `sam deploy`. Não contornar.
6. **`sam deploy` precisa rodar em `backend-serverless/`** (lê `samconfig.toml`). Ao usar `--parameter-overrides`
   no CLI, **repita todos** os parâmetros desejados; o SAM não reaproveita os anteriores.
7. O bucket de evidências tem `DeletionPolicy: Retain` (tabelas também): apagar a stack não apaga os dados.

## 6. Para o Codex (`contracts/`)

- O Program ID e a `Config` devnet já existem. Nada nesta sessão alterou `contracts/` além de commitar a troca
  de ID/`Anchor.toml` (cluster `devnet`) que já estava no working tree.
- Se o contrato mudar (IDL, layout do `JobAccount`): é **contrato cruzado**. Atualizar
  `backend-serverless/functions/common/solana.py` (decoder), `gen_idl_preview.py`, fixtures e o frontend na
  **mesma tarefa**, e depois refazer o deploy do backend e o build do site (`NEXT_PUBLIC_PROGRAM_ID`).
- O árbitro dos jobs é congelado na criação (PS-04) e vem da `Config`; para testar disputa, a carteira que
  inicializou a `Config` é o árbitro. O prazo de disputa também vem da `Config` (padrão 24 h no `AdminSetup`),
  então testar o 50/50 por timeout ao vivo é demorado.
- PS-45 (cadeia Anchor/Solana: `toml`, `bigint-buffer`...) continua aberto e é seu acompanhar.
- O usuário IAM do Codex (se criado) só lê a AWS: não tente deploy nem leitura de segredos.

## 7. Pendências priorizadas

1. **Destravar o e2e:** a carteira A (Empresa) precisa de SOL **na devnet** e USDC da Circle (mint
   `4zMMC9sr…`); carteira B (Pesquisador) com SOL. Depois: criar job de 1 USDC → candidatura → atribuição →
   aceite → envio cifrado → aprovação; e ainda cancelamento, disputa e `claim` após a revisão.
2. ~~Aprovar ADR-024~~ (feito). Falta a ação humana: criar os usuários IAM (`docs/iam/agent-users.yaml`) e trocar o perfil do MCP.
3. CloudFront (upgrade do plano Free ou Support) ou manter o Amplify.
4. Criar os usuários IAM dos agentes e trocar o perfil do MCP da AWS do root para o usuário do agente.
5. `tests/api-security` e `tests/e2e` (a pasta só tem `key-binding`, `meta-integrity` e `role`).
6. PS-45, PS-36 (regravação do item inteiro no DynamoDB), PS-13 (troca de RPC na UI), React 19.
7. Executor do agente (CLI `npm run agent:demo` já mostra o cérebro; a Lambda precisa de keypair).
8. Atualizar `docs/ProofSec_Manual_Tecnico.pdf` e `CONTEXT_FOR_*` (desatualizados em relação a esta sessão).
9. Revisão independente (Antigravity) de: template do authorizer, `hosting.yaml`, `customHttp.yml`,
   `agent-users.yaml`, Next 16 e ADR-025.

## 8. Comandos úteis

```
npm run test:backend          # 95 testes Python
npm run test:meta             # 21 (meta, key-binding, role, CSP)
cd backend-serverless && sam validate --lint && sam build
cd backend-serverless && sam deploy --no-execute-changeset --no-confirm-changeset --profile ProofSec --region us-east-1 \
  --parameter-overrides Stage=dev AlertEmail=<email> "SiwsDomains=<host amplify>,localhost:3000" AllowedOrigin=https://<host amplify> ProgramId=HCYkSp64qdMRjiCbauEzPhx9VtNGB6fp5NvKdCRb8tjj
```
A execução do changeset (`sam deploy` sem `--no-execute-changeset`) é do usuário (§5 do `AGENTS.md`).

## 9. Revisão independente do Codex (2026-10-06)

- **AWS conferida novamente:** `proofsec-dev` segue `UPDATE_COMPLETE`; Amplify `ProofSec/staging`
  está ativo; 19 Lambdas Python 3.12, três tabelas e o indexador habilitado. Não há executor,
  CloudTrail nem WAF. Existem somente os SecureStrings `jwt-secret` e `agent-api-key`.
- **Risco prioritário:** a identidade usada pelo MCP continua sendo a conta root. Nenhuma escrita
  AWS foi feita nesta revisão. Antes de qualquer nova implantação, trocar para credenciais temporárias
  com MFA/Identity Center e retirar o uso operacional de root.
- **IAM proposto corrigido, não implantado:** removidas ações `aws-mcp:*` inexistentes; o `Deny` de
  relatórios passou a cobrir `bucket/*`; leitura de auditoria foi preservada e mutações adicionais de
  IAM/Organizations foram bloqueadas. O template passou em `CloudFormation ValidateTemplate`, mas a
  ADR-024 continua proposta e a preferência é por credenciais federadas temporárias, não access keys.
- **PS-47–PS-50:** o commit concorrente `a68a58e` foi revisado. O template CloudFront e a correção CSP
  validam localmente; `force_upload` existe no SAM CLI instalado; `Anchor.toml` voltou a `localnet`.
  A CSP live do Amplify ainda contém `https://*.amazonaws.com`, portanto o código local precisa ser
  republicado depois da troca da identidade AWS.
- **Drift:** a detecção CloudFormation encontrou só `ProofSecApiApiGatewayDefaultStage`: o template
  usava o ARN do log group com `:*`, mas o API Gateway o normaliza sem o sufixo. PS-51 corrige a
  origem e adiciona regressão; a stack só voltará a `IN_SYNC` após um changeset aprovado.
- **Validação local:** backend 95/95, executor 18/18, checkers dos templates, tipos e bundle passaram;
  o export estático do Next 16.4 passou. O preflight foi ajustado para usar esse modo real de build.

## 10. Atualização: revisão local do diff e correções PS-47 a PS-50

O scan do Security Agent da AWS (`.security-agent/`, agent space `security-scans`, role `SecurityAgentScanRole`,
bucket `security-agent-scans-<conta>-us-east-1`) foi configurado, mas **não roda**: as cotas de jobs simultâneos
do serviço `securityagent` estão em **0** (conta no plano Free). No lugar, foi feita revisão local do diff
`9ae85d5..HEAD`; os achados estão em `docs/security-review.md` (PS-47 a PS-50) e foram corrigidos na branch
`fix/review-ps47-ps50`: CSP sem `*.amazonaws.com` (`NEXT_PUBLIC_REPORTS_BUCKET`), `Anchor.toml` volta a
`localnet` (**Codex: confirme com `anchor test`**), `force_upload = true` nos `samconfig.toml`, WAF e logs
opcionais no `hosting.yaml`, e o `Deny iam:*` do template de IAM virou deny só de escrita.
**Ação pendente:** colar o novo `frontend/customHttp.yml` em *Amplify > Custom headers* (a CSP agora lista só o
bucket e a API) e testar upload/download de relatório depois.
Cuidado: dois `next build` simultâneos no mesmo `frontend/.next` se corrompem (`ENOENT ... .nft.json`); rode um por vez.
