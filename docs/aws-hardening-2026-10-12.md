# ProofSec — revisão AWS e handoff, 12/10/2026

Referências: `docs/architecture.md`, `docs/program-design.md`, `docs/threat-model.md`,
`docs/decisions.md` (ADR-024 e proposta ADR-029), `docs/runbook.md` e `docs/security-review.md`.
Escopo autorizado: MVP de hackathon, somente dev/devnet, conta terminada em 8938,
selected Region `us-east-1`, referência mensal máxima de US$140.

## Estado observado

- `proofsec-dev`: UPDATE_COMPLETE; última detecção de drift IN_SYNC. HTTP API com 16 rotas,
  authorizer e throttling; 19 Lambdas Python 3.12; indexador a cada minuto sem retries automáticos.
- Jobs/Users com PITR; Nonces com TTL. Relatórios privados, cifrados, versionados, com lifecycle.
  SSM SecureString e IAM separados por função. Dois grupos de logs com retenção de 14 dias,
  nove alarmes OK e assinatura SNS confirmada. Inventário sem leitura de segredos ou relatórios.
- Amplify staging publicado. O smoke ao vivo anterior encontrou CSP com wildcard AWS; PS-47
  permanece aberto na implantação, embora `frontend/customHttp.yml` já esteja corrigido.
- Nenhuma trilha CloudTrail configurada. Stack antiga `proofsec-dev-web` em ROLLBACK_COMPLETE;
  não foi apagada. Executor Lambda não está implantado.
- Plano Free Tier observado: PAID/ACTIVE, créditos disponíveis zero. O termo Free Tier não
  significa teto automático. Budget existente US$20. Alertas de budget também não bloqueiam gastos.

## Entrega local

1. `backend-serverless/template.yaml`: mantém o alerta inicial de US$20 e acrescenta budget mensal
   de referência até US$140 (parâmetro limitado a 140), avisos reais em 50/75/90/100% e previsão em 90%.
   Créditos/refundos não reduzem o valor usado pelo novo budget. Não cria BudgetActions.
2. CloudTrail opcional agora é single-region, seguindo a regra do projeto. Mantém management events,
   eventos dos objetos do bucket de relatórios, validação de integridade, bucket privado e retenção.
   Ainda exige `EnableCloudTrail=true` no próximo changeset. Eventos de dados e storage podem gerar custo
   variável; revisar volume e fatura após ativar.
3. `scripts/prepare-agent-access.py` gera o template SSO da proposta ADR-029 a partir das políticas
   ADR-024. Removido `account:Cancel*`, que o Access Analyzer identificou como INVALID_ACTION:
   essa ação inexistente impedia validar a policy; nenhuma permissão efetiva foi concedida.
4. `tests/api-security/smoke.py`: sondagens anônimas/credencial sintética inválida e headers,
   sem carteiras, criação de nonce, fundos, download de evidência ou acesso autenticado.
   Destinos fixos revisados, devnet/stack/bucket obrigatórios e redirects proibidos.
   Respostas públicas malformadas falham. Listagem vazia não prova confidencialidade de fixtures.

## Autenticação local

O usuário concluiu `aws configure sso --profile ProofSecCodex`. Identidade verificada:
`assumed-role/AWSReservedSSO_AdministratorAccess_e6612d533e18d742/claudeagent` na conta correta.
A configuração do proxy no Codex foi alterada de `AWS_MCP_PROXY_PROFILES=ProofSec` para
`ProofSecCodex`. Apenas esse campo foi alterado; nenhum token/chave foi lido ou copiado.
A conexão já aberta ainda retorna root. Reiniciar o Codex para recarregá-la e então verificar
GetCallerIdentity pelo AWS MCP antes de qualquer escrita AWS. Não houve escrita AWS nesta tarefa.

## Plano de implantação e verificação

1. Reiniciar o Codex, abrir esta conversa e conferir identidade MCP SSO, conta e Region.
2. Revisar e aprovar a proposta ADR-029. Template SSO: `docs/iam/agent-permission-sets.json`;
   stack sugerida `proofsec-agent-sso`, capability NAMED_IAM, Stage dev, AppRegion us-east-1,
   InstanceArn da instância existente. Associar `claudeagent` somente a ClaudePrincipalId;
   manter CodexPrincipalId/ReviewPrincipalId vazios até existirem usuários próprios.
   Preparar changeset, revisar e deixar a execução para humano. Verificar os acessos restritos
   antes de retirar qualquer atribuição AdministratorAccess; não criar access keys.
3. Backend: build limpo e empacotamento SAM pelo responsável, changeset sem execução.
   Preservar **todos** os parâmetros atuais, sobretudo AllowedOrigin, SiwsDomains, ProgramId,
   RPC, AlertEmail, AgentBudgetScale e MaxAgentSpendingLimitUsdc. Alterar só
   EnableCloudTrail=true e MonthlyCeilingUsd=140; manter MonthlyBudgetUsd=20.
   O checkout contém alterações concorrentes (ADR-026/027/028); não publicá-las inadvertidamente.
   Revisar diffs e pacote exatos antes de preparar o changeset. Humano executa (§5 do AGENTS.md).
4. Amplify: aplicar integralmente `frontend/customHttp.yml` em Custom headers do app ProofSec,
   incluindo API e os dois endpoints específicos do bucket. Documentar a configuração persistente
   manual no runbook; publicar novamente se o host exigir. Não alterar RPC/origem isoladamente.
5. Confirmar: trail com IsLogging e última entrega sem erro; acesso privado ao bucket de auditoria;
   ambos os budgets e seus destinatários; stack sem drift; alarmes; smoke com CSP específico:

   ```text
   python tests/api-security/smoke.py --api-url https://mgzbzfov0g.execute-api.us-east-1.amazonaws.com --frontend-url https://staging.dhkblca1hli2z.amplifyapp.com --reports-bucket proofsec-reports-dev-189393508938-us-east-1 --stack-name proofsec-dev --cluster devnet
   ```

## Teste completo da demo (humano, duas carteiras devnet)

Seguir `docs/runbook.md` §2.1. Cliente e pesquisador distintos entre si e do árbitro (ADR-028);
sign in e Activate encryption na origem Amplify, usando SOL/USDC exclusivamente devnet.
Cliente cria escrow e seleciona pesquisador; pesquisador aceita, cifra relatório sintético no
navegador, envia e registra hash. Cliente compara hash, decifra e aprova; confirmar pagamento
somente às ATAs registradas, fechamento do vault e posterior espelhamento pelo indexador.
Repetir leitura de evidência com terceiro sem vínculo: negar. Verificar claim após janela numa
fixture separada, sem repetições automáticas de transações. Registrar assinaturas públicas e
resultados; nunca registrar keypairs, JWTs ou conteúdo privado. Esse fluxo não foi executado aqui.

## WAF e custo

O HTTP API atual não aceita associação direta de WAF: AWS lista API Gateway **REST API**,
CloudFront e Amplify entre os recursos suportados. WAF só no frontend não filtra a API direta.
Manter throttling atual no MVP; proteção por IP exige proposta de arquitetura separada,
com proteção contra bypass do endpoint de origem em **todas** as rotas, inclusive públicas,
cache desabilitado e encaminhamento correto de autenticação/CORS. Não implantar CloudFront/WAF
antes dessa revisão e da estimativa de custo dentro dos US$140.
Fonte: https://docs.aws.amazon.com/waf/latest/developerguide/waf-chapter.html

## Verificação e revisão independente

- Backend: 104 testes passaram, incluindo três novas propriedades de budget/auditoria.
- Smoke: seis regressões offline passaram; tentativas de desviar destinos/redirects e respostas
  públicas malformadas falham. Casos vulneráveis reproduzidos na revisão, corrigidos e reavaliados.
- Meta/keybinding/versões/roles/CSP: 25 testes passaram na etapa anterior.
- Checker estrutural SAM: 52 recursos e 16 rotas, OK. ValidateTemplate AWS: ambos os templates OK.
- Access Analyzer: três policies sem ERROR/SECURITY_WARNING/WARNING após resolver Ref/Sub;
  três sugestões de redundância de ARN preservam o escopo existente bucket/objeto/log-stream.
- IAM SimulateCustomPolicy: ações sensíveis explicitamente negadas; Claude pode preparar dev,
  não prod; Codex não prepara changeset. Não substitui teste real após provisionamento.
- cfn-guard, SAM CLI e cfn-lint indisponíveis neste ambiente; sua validação completa continua
  necessária no ambiente de deploy. O checker genérico de policies do SAM não trata as exceções
  de leitura List/GetMetadata do template SSO; não foi alterado para ocultar esses resultados.
- Revisor independente aprovou correções IR-1/IR-2 e os recursos/policies; rodou seis regressões
  smoke e nove testes de template. Não revisou alterações concorrentes de outras tarefas.

Riscos abertos: sessão MCP ainda antiga até reiniciar; AdministratorAccess transitório; proposta
SSO e implantação pendentes; CSP atual permissivo; CloudTrail ainda desativado; budget não limita
fatura; proteção por IP e teste completo da demo pendentes. Sem alterações em contratos, IDL,
custódia, regras financeiras ou invariantes nesta entrega. Branch: codex/aws-hardening-2026-10-12.
