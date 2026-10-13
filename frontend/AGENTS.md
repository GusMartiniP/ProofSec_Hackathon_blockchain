# frontend/AGENTS.md — Web app rules (builder: Claude Code)

Supplements the root `AGENTS.md`.

**Stack:** Next.js 16.4 (App Router, client-only page, static export via `build:static`),
wallet-adapter (Wallet Standard), `@anchor-lang/core`, `tweetnacl`.

## 1. Rules

1. **The UI is not a security boundary.** Every check in the UI must also exist on-chain
   or in the backend.
2. **`NEXT_PUBLIC_*` is public.** Only program id, RPC URLs, API URL, cluster and USDC mint
   go there. Never secrets.
3. **On-chain calls go through `src/lib/program.ts`.** Pass all accounts explicitly;
   payout accounts are always derived ATAs (INV-5).
4. **INV-7:** consume `src/idl/proofsec.json` only; never edit it by hand.
5. **Verify before approving.** Keep the download → re-hash → compare flow, and always
   compare against the **on-chain** `evidence_sha256`, never a backend value.
6. **Encryption (`src/lib/evidence.ts`)**
   - Changing the key-derivation message changes every user's key and makes old reports
     unreadable. Only do it with a versioned migration.
   - Key v2 (ADR-017, PS-06): SIWS-formatted message bound to the page origin; keys are per
     origin. v1 is used only to open old envelopes (`keyVersion` absent).
7. **XSS and session**
   - The session token lives in `sessionStorage`, so XSS means session theft.
   - No `dangerouslySetInnerHTML`; render all user and LLM text as text.
   - CSP and security headers come from `next.config.mjs` (`securityHeaders()`); with static
     export, replicate them in CloudFront/Amplify (PS-12).
8. **Transactions**
   - Always show the explorer link.
   - Never auto-retry a signed transaction; on blockhash expiry ask the user to sign again.
9. **RPC:** use a dedicated `NEXT_PUBLIC_RPC_URL`. `NEXT_PUBLIC_RPC_URL_FALLBACK` is read by
   config and allowed by the CSP, but automatic switching in the UI is still pending (PS-13).
10. **No server-only features** (API routes, SSR secrets) without an ADR. The app must
    keep working in "modo só on-chain" when `NEXT_PUBLIC_API_URL` is empty.

## 2. Commands

`npm run dev` · `npm run build:static` · `npm run typecheck`
