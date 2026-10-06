# Threat model — ProofSec

Metodologia: ativos → atores → fronteiras de confiança → superfície → ameaças (STRIDE)
→ controles → recuperação. Os achados detalhados ficam em `docs/security-review.md`.

## 1. Ativos

| Ativo | Por que importa |
|---|---|
| USDC nos vaults | dinheiro de clientes e pesquisadores |
| Relatórios de pentest | revelam vulnerabilidades abertas do cliente |
| Propostas do agente / alertas | revelam o que está vulnerável |
| Autoridades: upgrade, admin, árbitro, tesouraria | controlam regras e taxas |
| Chave do executor do agente | move fundos da empresa (limitado pela política) |
| Segredo do JWT e chave do agente na API | forjar sessões e propostas |
| Allowance (delegate) da empresa | teto do que o agente pode mover |

## 2. Atores

Cliente (empresa) · pesquisador · árbitro · admin da plataforma · agente (cérebro e mãos) ·
atacante externo · pesquisador malicioso · cliente malicioso · insider ou backend
comprometido · site de phishing.

## 3. Fronteiras de confiança

```
[Navegador/carteira] ──tx──► [Programa Solana]  ◄── fronteira principal (tudo é validado on-chain)
       │                          ▲
     HTTPS+JWT                 RPC (leitura)
       ▼                          │
[API Gateway → Lambdas] ──► [DynamoDB, S3]       ◄── não é confiável para fundos (INV-1)
       ▲
 [EventBridge ← GuardDuty]   [Executor do agente] ──tx──► programa (limitado pela AgentPolicy)
       ▲
   [LLM externa]   ◄── entrada e saída não confiáveis (INV-3)
```

## 4. Ameaças, controles e estado

| # | Ameaça | STRIDE | Controle | Estado |
|---|---|---|---|---|
| T1 | Cliente desvia o pagamento | Tampering | ATA derivada + `has_one = researcher` (P-2) | ✅ |
| T2 | Terceiro saca o reembolso | Elevation | `has_one = client` + ATA do cliente (P-1, P-3) | ✅ |
| T3 | Cliente nunca aprova | DoS | Liberação otimista pós-revisão (`claim_after_review`, ADR-003) | ✅ |
| T4 | Pesquisador ocupa jobs abertos | DoS | Candidaturas via API e atribuição obrigatória on-chain pelo cliente (`assign_researcher`, PS-01, ADR-013) | ✅ |
| T5 | Árbitro inativo trava a disputa | DoS | `dispute_deadline` + `resolve_dispute_timeout` com split 50/50 (PS-02, ADR-014) | ✅ |
| T6 | Front-run da inicialização da config | Spoofing | `initialize_config` restrita à upgrade authority via `ProgramData` (PS-03) | ✅ |
| T7 | Admin muda taxa ou árbitro no meio do job | Tampering | Termos congelados na criação do `JobAccount` (`fee_bps`, `arbiter`, `dispute_period`, PS-04) | ✅ |
| T8 | Prompt injection no alerta muda o orçamento | Tampering | Policy Engine determinístico com tabela fixa e schema estrito (INV-3) | ✅ |
| T9 | Backend comprometido gera propostas e drena até o teto | Elevation | Limites on-chain (`AgentPolicy`), jobs sem pesquisador pré-atribuído, revisão ≥ 72h e alertas SNS (PS-05) | ✅ |
| T10 | Chave do executor vaza | Spoofing | Limites da `AgentPolicy` on-chain + kill switch e revogação de delegate (runbook) | ✅ |
| T11 | Phishing da assinatura de derivação da chave | Info disclosure | Chave v2 vinculada à mensagem SIWS e à origem/domínio web (PS-06, ADR-017) | ✅ |
| T12 | Segredo do JWT vaza via qualquer Lambda | Spoofing | Segredos em SSM SecureString com IAM estrito por função (PS-07, PS-10) | ✅ |
| T13 | Spam de nonce, sync ou propose (custo/DoS) | DoS | Tabela de nonces com TTL atômico (PS-09) + throttling no HTTP API e quota horária (PS-08) | ✅ |
| T14 | Usuário acessa relatório de outro (IDOR) | Info disclosure | Participantes validados on-chain + chave S3 derivada do hash | ✅ |
| T15 | Upload com hash diferente do on-chain | Tampering | Checksum SHA-256 forçado na URL pré-assinada + `verify_upload` no S3 | ✅ |
| T16 | Leitura do bucket por terceiros | Info disclosure | Bloqueio público total no S3 + cifragem no navegador com TweetNaCl (INV-6) | ✅ |
| T17 | XSS rouba a sessão | Info disclosure | React escapa dados + CSP e headers de segurança em `next.config.mjs` (PS-12) | ✅ (host pendente se estático) |
| T18 | RPC fora do ar na demo | DoS | Fallback automático de RPC no backend e executor (PS-13) + modo só on-chain | ✅ (chaveamento na UI pendente) |
| T19 | Replay de login | Spoofing | Nonce de uso único com expiração e deleção atômica no DynamoDB | ✅ |
| T20 | Token falso exibido como USDC | Spoofing | `allowed_mint` registrado na `Config` e validado on-chain | ✅ |
| T21 | Upgrade malicioso do programa | Elevation | Upgrade authority protegida (multisig Squads em produção) | Produção |

## 5. Recuperação

Ver `docs/runbook.md`:
- chave do agente vazada → desativar a política e revogar o delegate;
- segredo do JWT vazado → rotacionar no SSM;
- backend comprometido → desativar a política, revisar propostas e contestar jobs suspeitos;
- bug no programa → upgrade com aprovação.
