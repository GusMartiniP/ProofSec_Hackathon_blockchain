# backend-serverless/AGENTS.md — AWS & backend rules (owner: Claude Code, ADR-024)

Supplements the root `AGENTS.md`. Applies to any agent editing this folder.
Infrastructure is part of the security boundary.

## 1. Infrastructure as Code = AWS SAM

- IaC is **AWS SAM (CloudFormation)** in `template.yaml` (ADR-002).
- Do not introduce Terraform or CDK without an approved decision.
- No manual console changes to persistent resources. If one is unavoidable, document it
  in `docs/runbook.md`.

## 2. Layout

| Path | Contents |
|---|---|
| `template.yaml` | HTTP API (throttling, access logs), authorizer, functions with explicit IAM, DynamoDB (Jobs, Users, Nonces+TTL), S3 reports, SNS alerts, SQS DLQ, alarms, budget, optional CloudTrail |
| `samconfig.toml` | stacks `proofsec-dev` / `proofsec-prod`, `confirm_changeset = true` |
| `functions/*.py` | handlers: `auth`, `jobs`, `evidence`, `users`, `agent`, `indexer` |
| `functions/common/` | shared code: http, db, solana decoder, sync, scope, policy, llm, jwt, ed25519, b58 |
| `tests/test_backend.py` | unit tests with boto3 fakes (`python -m unittest discover -s tests -v`) |

## 3. Workflow (SAM equivalent of plan / apply)

```
sam validate --lint
sam build
python -m unittest discover -s tests -v
sam deploy --no-execute-changeset --stack-name proofsec-dev   # review = "plan"
→ human approval → execute the changeset
```

- Never target a stack other than `proofsec-dev` without approval.
- `sam delete`, deleting tables or buckets, and IAM changes outside the template need approval.

## 4. Specs and deploy flow

Specs and task files link to `docs/` instead of redefining the architecture. Every task carries
security acceptance criteria and names the finding IDs it closes. Deploy flow (ADR-024): the owner
runs `sam deploy --no-execute-changeset` and reads the changeset, Antigravity reviews it, and a
**human** executes `sam deploy` after a clean `sam build` (`force_upload = true`, PS-49).

## 5. Application rules

1. **INV-1:** `common/sync.py` mirrors the chain and must never overwrite a draft whose
   client or `scope_hash` diverges (it sets `syncError`).
2. **INV-8:** handlers obtain the wallet only via `auth_wallet(event)` (authorizer context).
3. **Public endpoints return only `status == ONCHAIN` jobs.** Drafts and agent proposals
   go through authenticated routes only (`GET /jobs/mine`).
4. **INV-6:** S3 keys are `reports/<jobId>/<onchain_sha256>.bin`; never build keys from
   user input. Presigned PUT requires `x-amz-checksum-sha256` and signs the expected
   `Content-Length`; `verify_upload` deletes mismatches.
5. **Dependencies:** standard library + the runtime's boto3 only (ADR-007). Shared code
   goes in `functions/common/`.
6. **Handlers:** wrap with `@handler`; validate inputs; return generic errors.
7. **Logging:** never log secrets, JWTs, signatures or report content.
8. **DynamoDB:** no Python floats; store numbers as `int` or strings, and documents as
   canonical JSON strings.
9. **Idempotency:** creation uses `ConditionExpression`; sync is idempotent. EventBridge
   proposals use a deterministic ID per finding and conditional creation so retries cannot
   create duplicate escrows. Never auto-retry anything that triggers a transaction.
10. **Concurrent writes:** metadata-only mutations use conditional `UpdateItem`; never write
    a previously read full item over fields reconciled from Solana.

## 6. Security baseline

**IAM least privilege**
- One role per function.
- Prefer explicit statements (e.g. `s3:PutObject` only) over SAM `*CrudPolicy` when
  fewer actions suffice (PS-10).
- Never `Action: "*"` or `Resource: "*"`.

**Secrets**
- Secrets live in **SSM Parameter Store SecureString** under `/proofsec/<stage>/`
  (`jwt-secret`, `agent-api-key`, `anthropic-api-key`, `agent-keypair`), read at runtime by
  `common/secret_store.py` with a 5-minute cache. Env vars carry only parameter **names** (PS-07).
- The JWT secret is granted only to the auth and authorizer functions. Never put
  secrets in `Globals`.

**API**
- HTTP API stage throttling with lower per-route limits for `/auth/nonce`, `/auth/verify`,
  `/agent/propose`, `/jobs/{id}/sync`, `/jobs/{id}/apply` and `/evidence/upload-url` (PS-08).
  Executor endpoints protected by `x-agent-key` also have lower per-route limits.
  Limits are global per route, not per IP; per-client limits need CloudFront + WAF (backlog).
- Nonces stored per nonce item with a TTL, not per wallet (PS-09).
- `AllowedOrigin` must be set to the frontend domain on every non-local deploy.

**S3:** block public access, encryption and versioning stay on.

## 7. Observability, resilience and cost

**MVP — cheap, do it**
- One app log group (`/proofsec/<stage>/app`) set on every function via `LoggingConfig`
  (streams are per function), plus the API access log group; retention `LogRetentionDays`.
- SNS alert topic.
- Alarms: native `Errors` on authorizer, evidence verify, indexer and agent event; structured
  log metric filters cover auth-verify exceptions converted to 500 and indexer failures
  intentionally captured per item; account-wide Lambda `Throttles`; API 5xx; 401/403 burst
  (access-log metric filter); DLQ depth.
- SQS DLQ and retry policy on the GuardDuty/Security Hub targets and on the S3-triggered
  function. The minute indexer deliberately has no retry/DLQ: the next run reconciles the
  chain again, while its persistent failures are covered by the indexer alarm.
- A secondary RPC URL parameter used on timeout (PS-11, PS-13).

**Already in the template:** DynamoDB PITR (Jobs, Users), AWS Budget (with `AlertEmail`),
optional CloudTrail (`EnableCloudTrail`), `Rules` that refuse dev values in prod.

**Production tier (backlog)**
- Cost anomaly detection; separate AWS accounts per environment.
- CloudFront + WAF in front of the API for per-IP rate limits.

**Cost notes**
- The indexer runs every minute: about 43k invocations per month, inside the free tier,
  but `getProgramAccounts` loads the RPC. Prefer a Helius webhook later.
- Prefer SSM over Secrets Manager (USD 0.40 per secret per month).

**Tags:** `Project=proofsec`, `Environment=dev`, `ManagedBy=sam`, `Owner=engineering`,
`Component=<api|data|agent|indexer>`.

## 8. Open findings owned here

PS-05, PS-07–PS-11, PS-13 and PS-20–PS-31 (backend portions) are fixed in code. Still open:
per-IP rate limiting (backlog). A stack dev real está implantada; `sam validate --lint`, `sam build`
e a suíte de 95 testes passaram em 2026-10-06. PS-51 corrige localmente o único drift encontrado
no estágio do API Gateway; a reconciliação ao vivo depende do próximo changeset aprovado.

## 9. Pre-deploy checklist

- [ ] Changeset reviewed
- [ ] IAM least privilege
- [ ] No secrets in template or env
- [ ] Public exposure checked (CORS, S3)
- [ ] Throttling
- [ ] Log retention and alarms
- [ ] DLQs
- [ ] Unit tests pass
- [ ] Tags
- [ ] Cost impact noted in the handoff
