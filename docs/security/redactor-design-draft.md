# Security audit-event redactor: design draft (E08)

- Status: **DRAFT, not implemented.** Author: E08 Platform/Security. Date: 2026-10-19 (CDT).
- Ticket: DOT-008 (security baseline: "log redactor … unit tests cover the authUrl query, JWT, email, userCode and host"). Related: DOT-079 (observability record), DOT-076 (TaskStore, "stored values redacted"), RB-01, TB9.
- Sources: CONTRACTS §1.3 (`remoteControl/status/changed` carries a host name), §2.2 last bullet, §4 IPC rules, §5 `ObservedState`; skill `e08-security-redactor-and-log-audit`; `src/Santa_Claus/packages/observability/src/redact.ts`; `scripts/week1-probe/dottie-week1-probe.mjs` `redact()` (about L30); `docs/security/secret-sweep-2026-10-19.md` findings 1–2.
- Items marked **needs E01 sign-off** change a shared contract (CONTRACTS v2 is E01-owned). Nothing here edits `packages/contracts` or CONTRACTS.md.

## 1. Goal
Every log line, audit event, evidence file, crash breadcrumb and activity-feed entry passes through **one** redactor package (`packages/observability/redact`). No package keeps its own copy of the patterns. Output has to be safe to attach to a ticket or a public repo.

## 2. What gets redacted

| Class | Rule | Output |
|---|---|---|
| **Auth URLs** (`authUrl`, `verificationUrl`, any `https://auth.openai.com/...` or `http://127.0.0.1:<port>/auth/callback...` in free text, stderr or error messages) | Drop the **whole** URL, path and host included. That is stricter than CONTRACTS §2.2 ("strip the query") and stricter than the probe, which keeps origin+path. | `"<redacted-auth-url>"`. The audit event records only the outcome: `{event:"auth.url_check", outcome:"opened"\|"rejected", reason:"scheme"\|"host"\|"userinfo"\|"port"\|"prefix"\|"parse_error"\|"redirect_uri", loginId}`. No host, path or query. |
| OAuth parameters in any string | `code=`, `state=`, `code_challenge=`, `code_verifier=`, `id_token=`, `access_token=`, `refresh_token=` values | `param=[REDACTED]` |
| Tokens and keys | Ported from Santa_Claus: bearer, JWT, private-key block, `sk-…` (incl. `sk-proj-`), GitHub, Slack, AWS, URL userinfo, `key=value` pairs whose key is a secret name. **Plus** env-shaped lines `OPENAI_API_KEY=…`, `CODEX_API_KEY=…`, `CODEX_ACCESS_TOKEN=…`, `AZURE_OPENAI_*=…` | `[REDACTED]` (no partial prefix kept for `sk-`) |
| Sensitive keys (whole value, any depth) | `authUrl, verificationUrl, userCode, accessToken, refreshToken, idToken, access_token, refresh_token, id_token, apiKey, api_key, authorization, cookie, set-cookie, password, secret, credential` | `[REDACTED]` |
| Email | Key `email` and email-shaped values | `email:sha256(salt‖lowercase)[:12]`. The per-install salt is stored under `%LOCALAPPDATA%\Dottie\state\` and is never logged, so correlation still works on one PC and the hash isn't portable. |
| Host and machine names | Keys `serverName`, `installationId`, `hostname`, `computerName`, `COMPUTERNAME`, `USERDOMAIN`; values that match the live `os.hostname()` / `%COMPUTERNAME%` (case-insensitive, compared at runtime, never stored in code); `DESKTOP-[A-Z0-9]{4,}`, `LAPTOP-[A-Z0-9]{4,}`; UNC hosts `\\host\share` | `<pc-host>`. UNC becomes `\\<host>\<share>` |
| User paths | `C:\Users\<name>\…`, `/home/<name>/…`, `%USERPROFILE%` expansions, and the live `os.userInfo().username` as a path segment | `C:\Users\<user>\…`. When a tool is involved, prefer the known-folder id (`{downloads}\…`) or a hash, matching CONTRACTS §5 `ObservedState` |
| Raw audio | Fields named `audio\|pcm\|frame\|delta` on audio events, or long base64 that looks high-entropy | `[REDACTED-AUDIO len=N]` |
| File and clipboard contents, window titles | Not allowed in audit events (CONTRACTS §5) | Dropped. Logs keep `argsHash` and `evidenceRef` only |
| Canary values | `CANARY-<uuid>` | Never redacted, so a leak test can find them |

Order: (1) drop any key on the deny list, (2) match auth URLs and redact the whole URL, (3) run the value patterns, (4) apply the host, user and path rules. Deep traversal handles cycles, `Error.cause`, `AggregateError.errors`, Map and Set, and Buffer (Buffer → `[binary len=N]`). Output size is capped (16 KB per event; anything longer is truncated with a marker).

## 3. Audit-event shape (the redactor's main consumer)
`security.audit` record = `{schema:'dottie.audit', version:1, eventId, correlationId, causationId?, taskId?, timestamp, kind, actionId?, argsHash?, category?, risk?, decision?, channel?, reason?, outcome?}`
- `kind` values: `approval.requested | approval.resolved | approval.expired | approval.revoked | policy.denied | auth.url_check | auth.login_started | auth.login_completed | auth.logout | env.scrub | server_request.unknown | tool.denied_path | redactor.fallback`.
- `argsHash` = SHA-256 of the canonical action (the same hash used for `actionId`; see the ADR-0009 review). The raw args are never logged.
- `env.scrub` logs only the **names** that were removed and the count, never values (for example `{removed:["OPENAI_API_KEY"], kept:17}`).
- Written to `%LOCALAPPDATA%\Dottie\logs\audit-YYYYMMDD.jsonl` (ADR-0014). Default retention 30 days (PROVISIONAL, decided in DOT-079).

## 4. Failure behaviour (fail closed)
- If the redactor throws, nothing raw is written. The record becomes `{kind:"redactor.fallback", eventId, error:"<class name only>"}`.
- Loggers accept only already-redacted output: a branded type `Redacted<T>` returned by `redact()`. A lint rule plus the skill's step-3 grep (`console.*`, `appendFile`, `writeFile`, Python `print`/`logging`) blocks bypasses.
- App Server **stderr** and unparsed stdout lines go through `redactString` before the diagnostic log (ARCHITECTURE §4).

## 5. Tests (DOT-008 acceptance + RB01-U1)
- One positive and one near-miss per rule. For example, `https://auth.openai.com/` in docs text with no query is **still** redacted under the whole-URL rule. Decide whether help links get an exemption list (open question below).
- Nested object, Error with `cause`, and an array of URLs.
- The real-shape (synthetic) authUrl from the 0.163.0 smoke test produces 0 hits for `auth.openai.com`, `code_challenge`, `state=` and the client id.
- Host test: set `COMPUTERNAME=CANARYHOST01` in the test process and assert it never appears.
- Env-scrub audit event has names only (a canary `OPENAI_API_KEY=CANARY-…` in the test env produces 0 hits).
- No real token appears in any fixture (the skill's FAIL rule).

## 6. Contract changes this needs (**needs E01 sign-off**)
1. **CONTRACTS §2.2 last bullet:** change "strips the authUrl query" to "removes auth URLs entirely; only a reason-coded outcome is logged". **Needs E01 sign-off.**
2. **CONTRACTS §4 IPC rules / §3:** add the `dottie.audit` v1 record (§3 above) as a new schema, separate from the `dottie.event` envelope, or as an event type in v3. **Needs E01 sign-off.**
3. **CONTRACTS §1.1 env scrub:** change "remove OPENAI_*/AZURE_OPENAI_*/CODEX_* … proxy and OS variables are kept" (a deny list) to an **allowlist** built at spawn, plus a `env.scrub` audit event (names only). `OPENAI_API_KEY` is a User env var on Gopi's PC, so anything not on the allowlist is dropped. **Needs E01 sign-off.**
4. **CONTRACTS §3 `TaskProgress.redactedMetadata`:** state that it is the output type of `redact()` (branded), not free-form. **Needs E01 sign-off.**
5. **DOT-079 observability record:** reuse this redactor and its `argsHash`. No contract change if DOT-079 adopts it.

## 7. Open questions
- Q-R1: should a fixed allowlist of help/docs URLs (for example `https://developers.openai.com/codex`) survive the whole-URL rule in activity logs? Proposal: yes, by exact-string allowlist only, and never any `auth.openai.com` URL.
- Q-R2: email hash or full drop? CONTRACTS says hash; E08 accepts the hash with a per-install salt.
- Q-R3: is retention of audit logs (30 days) a PO decision? Raise it via DOT-079.

---

## E08 proposals for CONTRACTS §3.2/§3.3 OPEN items (2026-10-19, for E01 decision)
These are proposals. E01 owns CONTRACTS.md and ADR-0009/0017; nothing here is in force until E01 copies it there.

### P-a. One `decision` enum: `approved | declined | cancelled | denied_by_policy | expired | revoked`
- Support E01's single enum and add **`revoked`**. Why it's needed: panic-stop, mute, Quit, task cancel and lock (ADR-0009 item 7, ADR-0017 Decision 5) are none of the other values.
  - It isn't the user declining, so it isn't `declined`.
  - It isn't the time limit, so it isn't `expired`.
  - It isn't a policy rule, so it isn't `denied_by_policy`.
  - RB-02/RB-05 evidence has to show that revocation fired, and "revoked after execution, reported as executed" needs its own value to be testable.
- `decision` is the outcome class. The **cause** always goes in `reason`. The wire reply to Codex is derived from the cause and logged separately, as described below.
- **Naming convention (E01 final ruling 2026-10-19):** **ToolError codes** are UPPER_SNAKE (`DENIED_BY_POLICY`, `PERMISSION_REQUIRED`, …; CONTRACTS §5). **Audit reason codes and all enum values** (`decision`, `reason`, `outcome`, `canary`) are lowercase snake_case (`approved`, `denied_by_policy`, `recovery_action_forbidden`, `not_covered`). Audit `kind` names (`approval.requested`, `recovery_token.minted` …), field names (`requestedAt`, `targetHash`, `wireReply` …) and the Codex wire literals in `wireReply` (`accept`, `decline`, `cancel`, plus the descriptive `error_32601` and `none`) are unchanged; they are identifiers or protocol literals, not reason codes.

| Source | Situation | `decision` | `reason` (examples) | Wire reply to Codex |
|---|---|---|---|---|
| ADR-0009 approval | secure_ui Approve click, live id, in time | `approved` | — | `accept` |
| ADR-0009 approval | user clicks Deny; tray/voice says no | `declined` | `user_declined` | `decline` |
| ADR-0009 approval | turn ended or interrupted, `serverRequest/resolved` | `cancelled` | `turn_ended`, `turn_interrupted`, `resolved_by_server` | `cancel` (or none, if already resolved) |
| ADR-0009 CR1 bridge failure | render failure, renderer crash/reload, IPC disconnect, app-server restart, internal exception | `cancelled` | `render_failed`, `renderer_lost`, `ipc_disconnect`, `app_server_restart`, `internal_error` | `decline` (`cancel` if the turn is gone) |
| ADR-0009 CR5 / policy | unknown/reused id, yes-before-request, other action, free text, tray/voice approve on non-read, `credential_access`, grantRoot, amendment proposal | `denied_by_policy` | `unknown_action`, `reused`, `premature`, `wrong_action`, `channel_not_allowed`, `credential_access`, `grant_root`, `standing_grant` | `decline` |
| ADR-0009 item 7 | time limit reached | `expired` | `timeout` | `decline` |
| ADR-0009 item 7 / ADR-0017 D5 | panic-stop, mute, Quit, task cancel, lock | `revoked` | `panic_stop`, `mute`, `quit`, `task_cancel`, `locked` | `cancel` |
| ADR-0017 | recovery allowed | `approved` | — | n/a |
| ADR-0017 | recovery denied | `denied_by_policy` (or `expired` / `revoked`) | ADR-0017 D7 reasons, plus `recovery_action_forbidden` (see the note) | n/a |

- Add `wireReply?: 'accept' | 'decline' | 'cancel' | 'error_32601' | 'none'` so E02 can test the Codex-facing answer separately from `decision`. These values describe the protocol reply; they are not reason codes (see the naming convention above).
- Silence, "no" and noise in voice produce **no approval record** of their own. They end up as `expired` or `declined`. The test asserts that no `approved` record exists.
- **Note (resolved by the E01 casing ruling 2026-10-19):** `recovery-gate-requirements.md`, ADR-0017 test 9 and CONTRACTS §3.2 must use the same codes:
  - tool error code `DENIED_BY_POLICY`;
  - audit reason `recovery_action_forbidden` when the explicit deny list fires (so test 9 can prove the deny entry, not the allowlist, rejected it);
  - `not_covered` for any other action that isn't on the allowlist.

### P-b. `outcome` per `kind`
| kind | outcome values |
|---|---|
| `approval.requested` | `displayed` \| `not_displayed` (reason: `locked`, `render_failed`, `credential_access`) |
| `approval.resolved` / `approval.expired` / `approval.revoked` | `reply_sent` \| `reply_failed` \| `already_executed` (revoked after the side effect ran) |
| `policy.denied` | `denied` |
| `auth.url_check` | `opened` \| `rejected` (as in §2.2). `redirect_uri` is rejected unless its port is 1455 or the Codex-registered fallback (E01 2026-10-19; E02 records the fallback from 0.163.0 at W1) |
| `auth.login_started` | `started` \| `unavailable` \| `already_in_progress` |
| `auth.login_completed` | `success` \| `failure` \| `cancelled` \| `timeout` (`timeout` = the 10-min login limit from ADR-0015, E01 2026-10-19: the adapter cancels and never reopens automatically) |
| `auth.logout` | `signed_out` \| `failed` |
| `env.scrub` | `ok` \| `canary_detected` (the spawn is refused: fail closed) |
| `server_request.unknown` | `rejected` (wireReply `error_32601`) |
| `tool.denied_path` | `denied` |
| `redactor.fallback` | `written` |
| `recovery_token.minted` | `minted` \| `refused` |
| `recovery_token.used` | `executed` \| `postcondition_failed` \| `postcondition_unknown` |
| `recovery_token.rejected` | `denied` |
- "timestamps" in ADR-0009 item 11 means `requestedAt`, `expiresAt` and `resolvedAt?` (ISO-8601 with offset) on approval records, in addition to the record's `timestamp`.

### P-c. Recovery-token kinds
Add `recovery_token.minted`, `recovery_token.used` and `recovery_token.rejected` to `kind`. All three carry:
- `actionId`, `parentActionId`, `recoveryAction` (any action name on `rejected`, including forbidden ones, so `recoveryAction` widens to `string` on that kind only), `taskId`, `decision`, `reason?`;
- `targetHash` (new optional field): SHA-256 of the canonical `WindowIdentity`, so that hwnd/pid are never logged (§3.2 already forbids them, but has no field for the hash).
The `mac` and `nonce` are never logged.

### P-d. `env.scrub` payload
`env: { keptNames: string[], removedSensitiveNames: string[], removedOtherCount: number, keptCount: number, removedCount: number, canary: 'absent' | 'present' | 'not_run' }`
- `keptNames`: sorted. Always a subset of the `env.ts` allowlist, so it's harmless to log.
- `removedSensitiveNames`: sorted names that match `OPENAI_*`, `AZURE_OPENAI_*`, `CODEX_*`, `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`. Any other removed variable is **only counted** (`removedOtherCount`), because arbitrary user variable names can themselves be personal.
- Values are never logged, proxy values included: `https_proxy` may carry `user:pass@`.
- `canary: 'present'` means the child env or a log contained the canary. The spawn is refused and the record has `outcome:'canary_detected'`.

### P-e. `Redacted<T>`
```ts
declare const redactedBrand: unique symbol;            // not exported; only redact.ts can name it
export type Redacted<T> = T & { readonly [redactedBrand]: true };
export type RedactedJson = string | number | boolean | null | readonly RedactedJson[] | { readonly [k: string]: RedactedJson };
export type RedactedMetadata = Redacted<Readonly<Record<string, string | number | boolean | null>>>; // flat scalars, ≤ 32 keys, ≤ 2 KB
export function redact<T>(v: T): Redacted<RedactedJson>;           // the only constructor
export function isRedacted(v: unknown): v is Redacted<RedactedJson>; // runtime check: WeakSet of objects redact() produced, frozen
```
- Loggers, audit writers and the `TaskProgress` builder accept only `Redacted<…>` and call `isRedacted()` at runtime too, because types are erased and Python or JS callers exist.
- Flat scalars for `TaskProgress` keep the UI-facing metadata simple. Nested data belongs in `evidenceRef`.
- Python workers: a `Redacted` class whose constructor is private to `dottie_redact`. The logging handler rejects anything else.

### P-f. HMAC input layout: keep **sorted-key canonical UTF-8 JSON** with a `purpose` key (as in `recovery-gate-requirements.md`)
**Choice:** canonical JSON, not a length-prefixed binary layout.
- **One canonicaliser for both hashes.** `actionId` (ADR-0009 CR2) already uses canonical JSON, so both share one implementation and one test-vector suite in `packages/policy`, which removes a whole class of TS↔Python encoder mismatches.
- **No ambiguity.** Every value is a JSON **string** (hwnd, pid and processStartTime as decimal strings), so the number canonicalisation problem doesn't arise and field boundaries are unambiguous. Unambiguous boundaries are the main reason one would pick length-prefixing.
- **Auditable.** The input can be pretty-printed in a failing test without hex tools.

**Rules for the canonicaliser:**
- Keys are sorted (all keys are ASCII, so JS and Python sort them the same way).
- No whitespace; UTF-8 output; minimal escaping as in `JSON.stringify` (Python: `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)`).
- Any non-string value, duplicate key or missing key is **rejected**, never coerced.
- **Domain separation (accepted by E01 2026-10-19):** every canonical object carries a `purpose` key: `"purpose":"dottie.actionId.v1"` for the `actionId` hash (ADR-0009 CR2) and `"purpose":"dottie.recoveryToken.v1"` for the recovery-token HMAC (ADR-0017). A hash or MAC computed for one purpose can never verify as the other, even if K8 reuses one key. Any other or missing `purpose` value is rejected.
- **WindowIdentity encoding:** `hwnd`, `pid` and `processStartTime` are decimal **strings** in the CONTRACTS §3.3 type itself, not only inside the MAC input. CONTRACTS currently types `hwnd: unknown` and `pid: number`, which E01 must align.
