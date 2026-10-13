# 🛡️ ProofSec

> **Programmable Cybersecurity Escrow & Agentic Trust Layer on Solana**
> *A IA propõe, a chain impõe.*

## O problema

Em pentests, auditorias e bug bounties existe uma **assimetria de confiança dupla**:

* **O cliente teme** pagar adiantado e receber um relatório genérico, ou nada.
* **O pesquisador teme** entregar a PoC e a empresa corrigir a falha sem pagar.

Existe ainda um problema **legal**: testar um sistema sem autorização formal é crime. A autorização precisa ser clara, datada e verificável.

## A solução

| Peça | Como funciona |
|---|---|
| **Escrow em USDC** | O cliente trava USDC num vault PDA. Só o programa movimenta. |
| **Autorização de teste on-chain** | O SHA-256 do escopo + regras de engajamento (`scope_hash`) é gravado on-chain na criação do job. |
| **Prova da entrega** | O relatório é **cifrado no navegador** (só cliente, pesquisador e árbitro abrem), enviado ao S3, e o SHA-256 do arquivo cifrado vai on-chain. O S3 e uma Lambda conferem o hash. |
| **Liberação otimista** | Depois da evidência abre uma janela de revisão. O cliente aprova (paga na hora) ou contesta. **Se ficar em silêncio, o pesquisador saca sozinho.** |
| **Disputa** | Uma contestação vai para um árbitro (recomendado: multisig Squads), que decide o split em basis points. |
| **Agente de IA com teto on-chain** | Alertas do GuardDuty/Security Hub viram propostas de pentest. A LLM só redige o escopo; o orçamento sai de uma tabela determinística. A chave do agente **não tem custódia**: a conta `AgentPolicy` limita valor por job e por período, e a empresa aprova o PDA da política como *delegate* da sua conta USDC. |

## Fluxo

```
Empresa / Agente                      Solana (programa ProofSec)                 Pesquisador
      │ 0. config da política (limites + spl approve) ─►│                                │
      │ 1. alerta → proposta (LLM escreve, tabela precifica)                           │
      │ 2. initialize_job[_by_agent]: USDC → vault + scope_hash ─►│                     │
      │    (opcional) assign_researcher ─────────────────►│                               │
      │                                                  │◄──────── 3. accept_job ───────│
      │                                                  │◄─ 4. submit_evidence(sha256) ─│  (relatório cifrado no S3)
      │ 5. baixa → confere hash com a chain → decifra     │                               │
      │    ├─ approve_and_release ───────────────────────►│── USDC (− taxa) ─────────────►│
      │    ├─ silêncio até o fim da janela               │◄──── claim_after_review ──────│
      │    └─ open_dispute ─► árbitro: resolve_dispute(bps) → split cliente/pesquisador   │
      │ prazo vencido sem entrega: refund_expired · antes do aceite: cancel_job           │
```

## Arquitetura

```
 Frontend (Next.js 16.4, App Router) ── wallet-adapter (Phantom/Solflare/Backpack via Wallet Standard)
   │  lê jobs direto da chain (fonte da verdade)          │ assina transações
   │  REST + JWT (Sign-In With Solana)                    ▼
   ▼                                           Solana: programa ProofSec (Anchor 1.x)
 API Gateway HTTP + Lambda authorizer                 ▲  ▲
   ├─ jobs / sync ──── DynamoDB (espelho + metadados) ─┘  │ indexador (1/min) lê getProgramAccounts
   ├─ evidence ─────── S3 (blobs cifrados, checksum SHA-256, verificação pós-upload)
   ├─ users ────────── chave pública X25519 de cada carteira
   └─ agent (cérebro, sem chaves) ◄── EventBridge (GuardDuty / Security Hub)
                                        │ propostas AUTO_APPROVED
 agent/core.ts (mãos: CLI ou Lambda)      ┘──► initialize_job_by_agent (AgentPolicy revalida limites)
```

O frontend funciona também **sem o backend** ("modo só on-chain"): cria escrows, aceita e registra o hash. Nesse modo não há metadados, upload cifrado nem agente.

## Estrutura

```
AGENTS.md             Regras invioláveis e orquestração (lido por todos os agentes)
contracts/            Workspace Anchor (programs/proofsec, tests/, scripts/)  · AGENTS.md (Codex)
backend-serverless/   AWS SAM: template.yaml, functions/, tests/              · AGENTS.md (Claude Code)
agent/                agent.py (demo) · core.ts + executor.ts/lambda.ts       · AGENTS.md (Claude Code)
frontend/             Next.js 16.4 + Tailwind + @anchor-lang/core             · AGENTS.md (Claude Code)
tests/                e2e, segurança de API e resiliência (planejado)         · AGENTS.md (Claude Code)
docs/                 arquitetura, program design, threat model, security review,
                      resiliência, runbook, decisões (ADRs) e manual em PDF
```

## Desenvolvimento com agentes de IA

| Agente | Papel |
|---|---|
| **Antigravity** | orquestra, distribui tarefas e faz a revisão de segurança independente; dono de `docs/` |
| **Codex** | programa Solana (`contracts/`) |
| **Claude Code** | frontend, agente, testes ponta a ponta e infraestrutura AWS/Lambdas (`backend-serverless/`, ADR-024) |

Todas as ferramentas leem os `AGENTS.md` nativamente, por pasta. Não crie `CLAUDE.md`:
ele faz o Claude Code parar de ler os `AGENTS.md`. Achados e backlog por agente ficam em
`docs/security-review.md`.

## Como rodar

### 1. Programa (WSL2/Linux ou macOS)
```bash
# Toolchain: Rust + AVM (Anchor 1.x não depende mais da Solana CLI)
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install latest && avm use latest

cd contracts
npm install
anchor keys sync              # só após escolher/proteger a keypair oficial devnet (PS-46)
anchor build                  # o hook post_build copia o IDL real para frontend/ e agent/
anchor test                   # 34 testes, incluindo ataques e cenários dependentes do relógio
anchor deploy --provider.cluster devnet
```
> Você ainda precisa de uma keypair em `~/.config/solana/id.json` com SOL de devnet. A Solana CLI (`solana-keygen new`, `solana airdrop 2 --url devnet`) é o caminho mais simples.
> Sem toolchain local? O [Solana Playground](https://beta.solpg.io) compila e faz deploy pelo navegador.
> O primeiro build local passou. `npm run idl:preview` permanece apenas como fallback sem toolchain;
> o IDL distribuído deve sempre vir de `anchor build`.

Depois do deploy, inicialize a configuração da plataforma pelo próprio frontend (card "Configuração inicial"), **com a mesma carteira que fez o deploy** — só a upgrade authority consegue (PS-03). A Config da demonstração devnet já foi inicializada em `2qX6gWqAiTjLcQCg53UiCpfTnnNgs89GkwbSWfVNRyXQ`.

### 2. Backend AWS
```bash
cd backend-serverless
python -m unittest discover -s tests -v      # testes locais (pip install cryptography)
# segredos no SSM (uma vez): /proofsec/dev/jwt-secret e /proofsec/dev/agent-api-key — ver docs/runbook.md
sam validate --lint
sam build                               # usa samconfig.toml (stack proofsec-dev)
sam deploy --no-execute-changeset       # revise o changeset; depois `sam deploy`
```
Executar o changeset requer aprovação humana, conforme `AGENTS.md` §5.

### 3. Frontend
```bash
cd frontend
cp .env.example .env.local    # preencha NEXT_PUBLIC_API_URL com o ApiEndpoint do SAM
npm install
npm run dev
```
USDC de devnet: [faucet.circle.com](https://faucet.circle.com).

### 4. Agente
```bash
python agent/agent.py --severity 5      # demo offline do cérebro (mesmo código da Lambda)
cd agent && npm install
npm test                                # testes do executor (sem rede)
npm run keygen                          # cole a pubkey no painel "Política do agente" e envie ~0,1 SOL devnet
API_URL=... AGENT_API_KEY=... npm run executor
# ou como Lambda agendada (stack opcional): sam build && sam deploy  (ver agent/samconfig.toml)
```

## Sponsors

| Sponsor | Papel no ProofSec |
|---|---|
| **Phantom** | Carteira principal (Wallet Standard) e Sign-In With Solana. Para login social/embedded: Phantom Connect (`@phantom/react-sdk`). |
| **Altitude (Squads)** | A `AgentPolicy` reproduz on-chain o modelo de *spending limits* do Altitude. Produção: tesouraria da empresa num multisig Squads, com o agente como membro com spending limit, e árbitro também multisig. |
| **Reflect** | V2: o vault guarda USDC+ em vez de USDC, e o rendimento durante o pentest vira bônus para o pesquisador. |

## Pitch (3 min)

1. **Problema**: assimetria de confiança e de autorização legal.
2. **Demo**: alerta → agente propõe → política on-chain libera 350 USDC sem humano (750 exige Phantom) → pesquisador entrega relatório cifrado → cliente baixa, re-hasheia no navegador e confere com a chain → aprova, ou o pagamento sai sozinho na janela. Tudo com links do Explorer.
3. **Diferencial**: limites de gasto do agente impostos on-chain, autorização de escopo datada on-chain, pagamento garantido por liberação otimista.
