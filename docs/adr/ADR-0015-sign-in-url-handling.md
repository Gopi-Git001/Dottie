# ADR-0015: Only the Codex adapter opens sign-in URLs, and only if the URL is exactly under https://auth.openai.com/

- Status: **Accepted (E08 co-sign pending verification of applied changes).** E08 review 2026-10-19: ACCEPT WITH CHANGES; changes 5–10 below applied by E01. Builds on ADR-0002 (Accepted), whose body is not changed.
- Date: 2026-10-19 (CDT). Deciders: E01, E08, E02, E06. Spec: §1, §5.

## Context
- Browser-flow `authUrl` is `https://auth.openai.com/oauth/authorize?…` (V-run `evidence/linux-smoke/appserver-0.163.0-unauth.jsonl.txt` L10).
- The device-code `verificationUrl` is `{issuer}/codex/device`, where `DEFAULT_ISSUER = "https://auth.openai.com"` (V-src `codex-rs/login/src/device_code_auth.rs:166,175`, `login/src/server.rs:77`, main @ 8c07694). It has not been seen on the wire (UNVERIFIED).
- Desktop: `controller.ts:164-180` receives `authUrl` from the AuthAdapter and opens it through `isAllowedExternalUrl`. The allowlist (`ipc/trust.ts:43-55`) accepts
  `chatgpt.com, auth.openai.com, openai.com, developers.openai.com` **and every subdomain**. `electron/harden.ts:22` uses the same list for renderer `window.open`.

## Decision
1. **Auth-URL check, done in the E02 adapter (main process):**
   - `new URL(u)` must give `protocol === 'https:'` and `host === 'auth.openai.com'` (exact; no subdomains; port empty; no userinfo).
   - The serialized URL must start with `https://auth.openai.com/`.
   - If the check fails, the adapter calls `account/login/cancel`, reports `signing_in → signed_out`, and logs a security event.
2. **Only the adapter opens the URL.** It calls an injected `openExternal` hook. The `AuthPort.beginLogin()` result (CONTRACTS §2.2) carries **no** `authUrl`, so the controller and renderer never see it.
   Device-code mode returns `verificationUrl` and `userCode` for display only. The adapter also opens `verificationUrl` under the same check.
3. The general external-link allowlist (help and docs links) is separate. It may **never** open an auth URL. E08 narrows it to exact hosts, with no subdomain wildcard (DOT-063).
4. Never: embedded webviews, password fields, or opening auth URLs from the renderer.

### E08 co-sign changes (2026-10-19)
5. **Child env allowlist (CONTRACTS §1.1).** The adapter builds the Codex child's env from an **allowlist**: OS essentials, proxy variables and the
   `CODEX_HOME` Dottie sets. It never copies `process.env` and deletes from it. It passes `forced_login_method=chatgpt` (config key; enum
   `"chatgpt" | "api"` in the 0.163.0 schema `ForcedLoginMethod`). A canary test sets `OPENAI_API_KEY` in the parent env (it is a User env var on
   Gopi's PC, RISKS R16) and asserts it never reaches the child (DOT-089).
6. **Security event (CONTRACTS §2.2).** The URL-check event logs **no part of the URL**: only a reason code and `loginId`
   (`auth.url_check{outcome, reason, loginId}`; reasons in CONTRACTS §3.2). Replaces "strip the query".
7. **Parsing.** The adapter opens `u.href` (the serialized `URL`), never the raw string. It rejects control characters, whitespace, backslashes, and IDN
   or any other non-ASCII host, and requires the `redirect_uri` query parameter to be exactly `http://127.0.0.1:<port>/auth/callback`, where `<port>` is constrained to 1455 or Codex's registered fallback port, which E02 records from 0.163.0 at Week 1 (E01 decision 2026-10-19; no other port is accepted, and the fallback value is UNVERIFIED until recorded).
8. **Device code.** `verificationUrl` is **display-only** (the adapter does not open it) until Week-1 confirms its path (W1-1, W1-6c). Supersedes the
   "adapter also opens `verificationUrl`" clause in item 2.
9. **User-initiated only.** A URL is opened only after a user click on **Sign in**, one login at a time. On timeout, crash or disconnect the adapter calls
   `account/login/cancel`; it never reopens a URL automatically. **The login timeout is 10 minutes** (E01 decision 2026-10-19): at timeout the login is cancelled and never reopened automatically.
10. **General allowlist.** The OpenAI auth host is excluded from the general external-link allowlist, and that allowlist (exact hosts) also governs
    renderer `window.open` (`electron/harden.ts:22`, DOT-088).

## Alternatives
Keep the controller-side broad allowlist. Rejected: it allows any `*.openai.com` or `*.chatgpt.com` host, and it puts the URL (which carries PKCE state) on more code paths.

## Consequences
DOT-063 (E02 + E06, E08 review), DOT-088 (`window.open` allowlist), DOT-089 (env allowlist + canary). WEEK1 W1-1 and W1-6c record the actual `verificationUrl` host and confirm the rule.

## Changelog
- 2026-10-19: Proposed (E01).
- 2026-10-19: E08 co-sign changes applied by E01 (items 5–10). Status: Accepted (E08 co-sign pending verification of applied changes).
- 2026-10-19: E01 notes after E08 re-verification (pass): redirect port constrained to 1455 or Codex's registered fallback (recorded at Week 1); login timeout 10 minutes.
