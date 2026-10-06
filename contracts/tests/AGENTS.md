# contracts/tests/AGENTS.md — On-chain adversarial tests

Supplements the root and `contracts/` AGENTS.md files.
Builder: Codex. Reviewer: Antigravity, which also adds missing attack tests.

Tests are the security evidence of this project. Their purpose is to find where the
program is wrong before an attacker does, not to confirm what the developer expected.

## 1. Minimum matrix per instruction

- valid input → success
- wrong signer → fails
- wrong / substituted account → fails
- wrong state → fails
- boundaries: 0, 1, minimum, maximum, maximum + 1, repeated call

## 2. Assertions

Every attack test asserts **both** the expected `ProofSecError` (or constraint error)
**and** that the state is unchanged: balances, status, vault existence.

## 3. A test must be able to fail

When adding an exploit test, temporarily remove or weaken the protecting constraint and
confirm the test fails, then restore it. Mention this mutation check in the handoff note.
A test that always passes is not evidence.

## 4. ProofSec attack catalogue

Status: ✅ covered in `proofsec.ts` · ⬜ missing

**Payout and refund**
- ✅ C1 client diverts payout to its own account
- ✅ C2 third party drains via cancel/refund
- ⬜ vault from another job (vault substitution)
- ⬜ wrong mint

**Config and initialization**
- ⬜ `initialize_config` called twice
- ⬜ `update_config` by non-admin
- ⬜ fee > 10%

**Lifecycle**
- ⬜ double `approve_and_release`
- ✅ claim before the review window ends
- ⬜ claim by a non-researcher
- ⬜ dispute after the window
- ⬜ resolve by a non-arbiter
- ⬜ `bps > 10000`
- ✅ refund before the deadline
- ⬜ cancel after accept
- ⬜ accept by the client
- ✅ accept of an assigned job by someone else
- ⬜ submit after the deadline
- ⬜ zero hash
- ✅ deadline too short
- ⬜ deadline too long
- ⬜ review period bounds

**Agent policy**
- ✅ per-job and per-period limits
- ⬜ inactive policy
- ⬜ wrong agent
- ⬜ policy of another owner
- ⬜ period rollover
- ⬜ missing delegate approval

**Griefing**
- ⬜ token donation to the vault, then settle and close still succeed
- ⬜ PS-01 accept squatting (add when fixed)

## 5. Time

No `sleep`. Use LiteSVM / Surfpool clock control to cross `review_deadline` and
`deadline` deterministically (PS-16: migrate the current 70 s test).

## 6. Data and environment

- Synthetic keypairs only.
- Abort if the provider cluster is mainnet.
- Never use wallets that hold value.

## 7. Regression

Name regression tests with the finding ID (e.g. `"PS-02 regression: ..."`) and never
delete them.
