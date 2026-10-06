# Program design — ProofSec (Solana / Anchor 1.x)

Fonte: `contracts/programs/proofsec/src/`. Este documento é a referência dos invariantes
on-chain; toda mudança no programa atualiza esta página.

## 1. Contas e PDAs

| Conta | Seeds | Dono | Autoridade | Ciclo de vida |
|---|---|---|---|---|
| `Config` | `["config"]` | programa | `admin` (update) | criada uma vez (PS-03); nunca fechada |
| `JobAccount` | `["job", client, job_id]` | programa | cliente / pesquisador / árbitro, conforme a instrução | criada em `initialize_job*`; permanece como registro |
| Vault | `["vault", client, job_id]` | Token Program | PDA do job | criado com o job; fechado em todo estado final |
| `AgentPolicy` | `["policy", owner]` | programa | `owner` (config); PDA é o delegate SPL | `init_if_needed`; desativável |

## 2. Layout do `JobAccount` (consumido fora da chain)

| Offset | Campo | Tipo |
|---|---|---|
| 0 | discriminator | 8 bytes |
| 8 | client | Pubkey (32 bytes) |
| 40 | researcher | Pubkey (32 bytes, default = aberto) |
| 72 | mint | Pubkey (32 bytes) |
| 104 | vault | Pubkey (32 bytes) |
| 136 | amount | u64 (8 bytes) |
| 144 | deadline | i64 (8 bytes) |
| 152 | review_period | i64 (8 bytes) |
| 160 | review_deadline | i64 (8 bytes) |
| 168 | scope_hash | [u8; 32] |
| 200 | evidence_sha256 | [u8; 32] |
| 232 | status | u8 (enum) |
| 233 | created_by_agent | bool (1 byte) |
| 234 | bump | u8 (1 byte) |
| 235 | vault_bump | u8 (1 byte) |
| 236 | arbiter | Pubkey (32 bytes, congelado na criação; PS-04) |
| 268 | rent_payer | Pubkey (32 bytes, recebe rent de volta; PS-14) |
| 300 | fee_bps | u16 (2 bytes, taxa congelada; PS-04) |
| 302 | dispute_period | i64 (8 bytes, congelado na criação; PS-04) |
| 310 | dispute_deadline | i64 (8 bytes, 0 até abrir disputa; PS-02) |
| 318 | treasury | Pubkey (32 bytes, congelada na criação; PS-37) |
| 350 | job_id | String (u32 len + ≤ 32 bytes) |

Quem decodifica este layout: `backend-serverless/functions/common/solana.py`
(`decode_job`) e o frontend via IDL. Conforme ADR-018 e ADR-021, todos os campos de tamanho
fixo vêm antes de `job_id`, garantindo offsets estáveis para filtros `memcmp`.

## 3. Máquina de estados

```
            assign_researcher (loop)
                 ┌──┐
 init ──► Open ──┴──┴──accept_job──► InProgress ──submit_evidence──► EvidenceSubmitted
           │                            │                              │      │
      cancel_job                  refund_expired          approve / claim│      │open_dispute
           ▼                            ▼                              ▼      ▼
       Cancelled      Open ──refund_expired──► Refunded            Completed  Disputed
                                                                              │
                                      resolve_dispute (árbitro) /             │
                                      resolve_dispute_timeout (50/50 auto)    ▼
                                                                           Resolved
```

Estados finais: Completed, Resolved, Refunded, Cancelled. Em todos, o vault é zerado e fechado.

## 4. Invariantes on-chain

| ID | Invariante | Onde é garantido | Teste / Verificação |
|---|---|---|---|
| P-1 | Só o cliente aprova, contesta, atribui, cancela e pede reembolso | `has_one = client` + `Signer` | C2, PS-01 |
| P-2 | O pagamento só vai para a ATA do pesquisador registrado | `has_one = researcher` + `associated_token` | C1 |
| P-3 | Reembolso só para a ATA do cliente | `associated_token::authority = client` | C2 |
| P-4 | Taxa ≤ 10%, congelada por job e só para a ATA da tesouraria **congelada no job** | `MAX_FEE_BPS`, `job_account.fee_bps`, `job_account.treasury` (PS-04, PS-37) | PS-04, PS-37 |
| P-5 | O vault usado é o do job | `has_one = vault` com seeds PDA | ADR-002 |
| P-6 | Só o mint registrado (e permitido) | `allowed_mint`, `has_one = mint` | PS-04 |
| P-7 | Sempre há uma saída para os fundos (INV-4) | janela + claim + disputa + `resolve_dispute_timeout` 50/50 (PS-02) + `recover_stuck_funds` de último recurso (PS-37) | PS-02 e PS-37 (time travel) |
| P-8 | O agente não excede `max_per_job` nem `max_per_period` | `initialize_job_by_agent` + `AgentPolicy` | `core.test.ts` |
| P-9 | Evidência só do pesquisador vinculado, antes do prazo, hash ≠ 0 | `submit_evidence` | verificado |
| P-10 | Fechar o vault não é bloqueável por doação de tokens | distribui `vault.amount` | verificado |
| P-11 | `Config` não pode ser reinicializada nem sofrer front-run | `initialize_config` exige sign da upgrade authority via `ProgramData` (PS-03) | PS-03 |
| P-12 | A recuperação de último recurso só devolve ao cliente, só em `EvidenceSubmitted`/`Disputed` e só depois de `RECOVERY_GRACE_PERIOD` (30 dias) | `recover_stuck_funds`: `has_one = client`, ATA do cliente, estado e carência (PS-37, ADR-021) | PS-37 |

## 5. Modelo econômico

- **Depósito:** o cliente, ou o agente via delegate dentro da política.
- **Saque:**
  - pesquisador: aprovação, fim da janela ou divisão do árbitro;
  - cliente: reembolso, cancelamento ou o restante da divisão.
- **Taxa:** `floor(researcher_gross × fee_bps / 10000)`, debitada da parte do pesquisador
  e enviada à tesouraria. Congelada por job na criação (`job_account.fee_bps`, PS-04).
- **Rent:** pago por quem cria (`rent_payer`). No fechamento do vault vai de volta para quem pagou (agente ou cliente, PS-14).
- **Disputa:** o árbitro define o split. Caso fique inativo após `dispute_deadline`, qualquer parte pode acionar `resolve_dispute_timeout` para liquidação automática 50/50 (PS-02, ADR-014).
- **Último recurso (PS-37):** se uma conta de token da liquidação ficar inutilizável (ex.: ATA congelada pelo emissor do mint) e ninguém liquidar, depois de `RECOVERY_GRACE_PERIOD` (30 dias) após `review_deadline` (evidência submetida) ou `dispute_deadline` (disputa) qualquer pessoa chama `recover_stuck_funds` e o saldo inteiro volta à ATA do cliente (`Refunded`, evento `JobRecovered`). A parte do pesquisador não é paga nesse caso: ele já teve a janela de revisão e a carência para sacar.
- **Arredondamento:** sempre floor; o resto da divisão fica com o cliente.

## 6. Autoridades e upgrade

- **Dev:** a upgrade authority é a carteira de deploy de devnet. O admin da `Config` é
  quem inicializou.
- **Produção:**
  - upgrade authority, admin e árbitro em multisig Squads;
  - processo de upgrade com aprovação humana;
  - plano de congelar upgrades depois da auditoria.

Chaves de autoridade nunca entram no git.
