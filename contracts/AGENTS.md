# contracts/AGENTS.md — Solana program rules (owner: Codex)

Supplements the root `AGENTS.md`. Applies to **any** agent editing `contracts/`.
The program is the final security boundary: frontend, backend and agent checks are
convenience only. Every value- or authorization-sensitive rule must hold on-chain.

## 1. Stack

- Anchor **1.2.x** (Solana 3.x toolchain). `anchor test` uses Surfpool; time-dependent tests use
  `surfnet_timeTravel` and are skipped when the validator lacks it. `[test] upgradeable = true`
  is required by the PS-03 check (`ProgramData` upgrade authority).
- `anchor-spl` with the classic SPL Token program and `transfer_checked`.
- Tests in TypeScript with `@anchor-lang/core` (`tests/proofsec.ts`).
- No new crates without an approved `docs/decisions.md` entry.

Anchor 1.x specifics: `CpiContext::new(program_id: Pubkey, accounts)`; duplicate
mutable accounts fail unless marked `dup`; the `idl-build` feature is required;
only one `#[error_code]` block per program.

## 2. Program map

| File | Contents |
|---|---|
| `programs/proofsec/src/lib.rs` | 14 instructions, `#[derive(Accounts)]` structs, helpers (`settle`, `vault_transfer`, `close_vault`, `refund`) |
| `programs/proofsec/src/state.rs` | `Config`, `JobAccount`, `AgentPolicy`, `JobStatus` |
| `programs/proofsec/src/{errors,events,constants}.rs` | error codes, events, seeds and limits |
| `scripts/sync-idl.mjs` | `post_build` hook: copies the real IDL to `frontend/` and `agent/` |
| `scripts/gen_idl_preview.py` | provisional IDL used only before the first `anchor build` |

## 3. Accounts and PDAs

| Account | Seeds | Notes |
|---|---|---|
| `Config` | `["config"]` | admin, arbiter, treasury, fee_bps ≤ 1000, allowed_mint |
| `JobAccount` | `["job", client, job_id]` | client in seeds prevents job_id squatting |
| Vault (token account) | `["vault", client, job_id]` | **authority = job PDA**; sign with `["job", client, job_id, bump]` |
| `AgentPolicy` | `["policy", owner]` | the PDA is approved as SPL delegate on the owner's USDC ATA |

**JobAccount layout is consumed off-chain at fixed offsets:**
client 8 · researcher 40 · mint 72 · vault 104 · amount 136 · deadline 144 ·
review_period 152 · review_deadline 160 · scope_hash 168 · evidence 200 ·
status 232 · by_agent 233 · bump 234 · vault_bump 235 · arbiter 236 · rent_payer 268 ·
fee_bps 300 · dispute_period 302 · dispute_deadline 310 · treasury 318 · job_id 350 (u32 length + bytes, max 32).
`Config`: admin 8 · arbiter 40 · treasury 72 · fee_bps 104 · allowed_mint 106 · dispute_period 138 · bump 146.

- Never reorder existing fields. New **fixed-size** fields go immediately **before** `job_id`
  (the only variable-length field), so every existing offset stays stable (ADR-018).
  Never append after `job_id`: offsets would depend on its length.
- Any layout change must, in the same task: update `backend-serverless/functions/common/solana.py`
  and its tests, update `docs/program-design.md`, and include a migration plan for existing
  devnet accounts (Anchor 1.x `Migration<From, To>`).

## 4. Rules

1. **Validate every account.** Use `Signer`, `Account<T>` (owner and discriminator),
   `has_one` for client / vault / mint / researcher / arbiter / agent / owner, and
   `associated_token::*` for every payout account. Client-supplied accounts are untrusted.
2. **Status check first.** Each handler starts with the `require!` that enforces its
   allowed source state (see the state machine in `docs/program-design.md`).
3. **Distribute the real balance.** Settle using `vault.amount`, then close the vault.
   Third-party "donations" must never block closing (INV-4).
4. **Arithmetic.** Checked operations; fees and bps computed in `u128`; rounding is floor
   and documented (fee floors in favor of the researcher; the dispute remainder goes to the client).
5. **Time.** Use `Clock`; validate deadlines against `MIN_*` / `MAX_*` in `constants.rs`.
6. **CPI.** Only the Token program, plus System and ATA through Anchor `init`.
   Programs typed as `Program<'info, T>`; never accept user-supplied program IDs.
7. **Events.** Every state transition emits an event (planned indexer webhook relies on them).
8. **Errors.** Specific `ProofSecError` variants; no secrets in messages.
9. **Authorities** (upgrade authority, Config admin/arbiter/treasury) are critical assets.
   Changing them needs human approval. Never commit their keys.

## 5. Instruction security matrix

| Instruction | Signer | Key constraints | From state |
|---|---|---|---|
| `initialize_config` | upgrade authority | `init`; `ProgramData.upgrade_authority == admin` (PS-03) | — |
| `update_config` | admin | `has_one = admin`, fee ≤ 10%; affects **new** jobs only (PS-04) | — |
| `set_agent_policy` | owner | PDA from owner; existing owner must match | — |
| `initialize_job` | client | owner/mint of source ATA; deadline/review/hash/mint checks; researcher ≠ client; snapshots arbiter/fee/dispute_period | — |
| `initialize_job_by_agent` | agent | `has_one = agent, owner`; active; per-job and per-period limits; no researcher; review ≥ 72 h; rent_payer = agent (PS-05, PS-14) | — |
| `assign_researcher` | client | `has_one = client`; researcher ≠ client (default = unassign) | Open |
| `accept_job` | researcher | must be the **assigned** researcher (PS-01); before deadline | Open |
| `submit_evidence` | researcher | stored researcher; before deadline; hash ≠ 0 | InProgress |
| `approve_and_release` | client | `has_one` client/vault/mint/researcher; payout ATAs | EvidenceSubmitted |
| `claim_after_review` | researcher | same; `now > review_deadline` | EvidenceSubmitted |
| `open_dispute` | client | `now ≤ review_deadline`; sets `dispute_deadline` | EvidenceSubmitted |
| `resolve_dispute(bps)` | arbiter | job `has_one = arbiter` (snapshot); bps ≤ 10000 | Disputed |
| `resolve_dispute_timeout` | anyone | `now > dispute_deadline`; fixed 50/50 split (PS-02) | Disputed |
| `refund_expired` | client | `has_one` client/vault/mint/rent_payer; `now > deadline` | Open, InProgress |
| `cancel_job` | client | same | Open |

## 6. Open findings owned here

See `docs/security-review.md`:

- PS-01, PS-02, PS-03, PS-04, PS-05 (contract part), PS-14 and PS-16 are **fixed in code**
  with regression tests named by ID in `tests/proofsec.ts` (2026-10-02).
- **PS-17 (closed locally):** `anchor build` passed and `anchor test` completed 34/34 on
  2026-10-06. **PS-46 remains open:** choose/protect the official devnet program keypair and
  synchronize the Program ID across every consumer before deploy.

Any new finding: regression test named with its ID, in the same task as the fix.

## 7. Workflow

Read the docs → list the affected invariants → minimal change → tests → `anchor build`
(syncs the IDL) → `anchor test` → handoff note to Antigravity for independent review.

- Deploying to devnet with the dev wallet is allowed.
- Mainnet deploys and authority changes need approval.
- `anchor build` and `anchor test` passing does **not** mean done: adversarial review and
  regression tests are part of done.

## 8. Pre-handoff checklist

- [ ] Signer, authority, PDA and ownership checks
- [ ] `has_one` relationships and payout ATAs
- [ ] (Re)initialization
- [ ] State transitions
- [ ] Arithmetic and rounding
- [ ] Account closing and rent destination
- [ ] Repeated execution
- [ ] CPI surface
- [ ] Compute usage
- [ ] Events
- [ ] Off-chain layout consumers updated
- [ ] IDL synced
- [ ] Tests for every new path (see `tests/AGENTS.md` in this folder)

- **Cluster padrão = `localnet` (PS-48).** `anchor test` só sobe o validador local nesse caso; nunca deixe
  `[provider] cluster = "devnet"` em `Anchor.toml`. Deploy na devnet só com `--provider.cluster devnet` explícito.
