# tests/AGENTS.md — Cross-component, API security and resilience tests

Builder: Claude Code. Reviewer: Antigravity (independent).
Supplements the root `AGENTS.md`.

## 1. Scope

| Location | What lives there |
|---|---|
| `tests/` (this folder) | end-to-end (frontend ↔ API ↔ chain ↔ S3), API security, resilience |
| `contracts/tests/` | program adversarial tests (see its AGENTS.md) |
| `backend-serverless/tests/` | Lambda unit tests |

Planned layout: `tests/e2e/`, `tests/api-security/`, `tests/resilience/`, `reports/` (still empty;
unit tests live in `backend-serverless/tests`, `contracts/tests` and `agent/core.test.ts`)
(evidence, without secrets).

## 2. Philosophy

Build → test → attack → observe the failure → fix → regression test (kept forever).
Every test asserts that the attack fails **and** that the system state stays safe.

## 3. API security catalogue (ProofSec)

**Authentication**
- Missing, invalid or expired JWT.
- Wallet in the body is ignored (INV-8).
- Nonce replay.
- Nonce griefing (PS-09).
- Wrong signer.

**Authorization / IDOR**
- `/evidence/download-url` by a non-participant.
- `/evidence/upload-url` by anyone other than the on-chain researcher.
- Drafts and proposals never returned by public routes.

**Integrity**
- `/jobs/{id}/sync` with a foreign PDA or divergent client → `syncError`, no overwrite.
- S3 upload with a mismatched checksum is rejected or deleted.

**Input handling**
- Malformed JSON, oversized body, wrong types, unknown fields.
- Missing or wrong `x-agent-key`.

**Abuse**
- Rate limits on nonce, propose and sync (PS-08).

## 4. Resilience catalogue

| Failure | Expected behavior |
|---|---|
| RPC down or slow | clear error, no duplicated transaction; fallback RPC once implemented |
| API down | frontend still settles in "modo só on-chain" (INV-4) |
| Stale DynamoDB | the next sync or the indexer converges to the chain |
| LLM down or invalid output | template fallback |
| S3 verify Lambda fails | message goes to the DLQ and is retried (PS-11) |
| Blockhash expired | user re-signs; no blind retry |

## 5. Rules

- Deterministic tests; no arbitrary sleeps.
- Synthetic data only.
- Explicit environment: abort if the stack name or cluster looks like production or mainnet.
- AI-generated tests must state the property under test and the attack simulated, and
  show they fail against a vulnerable implementation.
- Coverage percentage is not a security metric.
