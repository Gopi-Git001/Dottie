# Dottie: Public Interfaces and Shared Event Contracts (draft v1)

Owner: E01 (sole integrator of shared interfaces, spec §7). Status: **Draft / Proposed**. Date: 2026-10-18 (CDT).
Target home: `docs/contracts/` + `packages/contracts/` in the new monorepo (ADR-0011). Codex pin: `rust-v0.163.0` (ADR-0003).

Verification legend:
- **V-doc**: listed on the official page https://developers.openai.com/codex/app-server (fetched 2026-10-18).
- **V-src**: defined in `src/codex/codex-rs/app-server-protocol/src/protocol/common.rs` at the line shown (clone `main` @ 8c07694, 2026-10-17 20:58 CDT).
- **V-schema**: present in the JSON schema generated from the pinned 0.163.0 Linux binary: `arch/evidence/linux-smoke/schema-0.163.0/`.
- **V-run**: actually observed on the wire on Linux: `arch/evidence/linux-smoke/appserver-0.163.0-unauth.jsonl.txt` (line N).
- **UNVERIFIED**: not confirmed by any of the above. Must be proven in Week-1 on Windows before relying on it.

Nothing here has been demonstrated on Windows yet. Nothing here has been demonstrated with a signed-in account.

---

## 1. Codex App Server wire contract (Dottie ⇄ `codex app-server --listen stdio://`)

Transport: newline-delimited JSON over child stdio. JSON-RPC 2.0 shape **without** the `"jsonrpc"` member (V-doc "Protocol"; V-src `rpc.rs:1-2`; V-run all lines).
Requests carry `id`. Notifications have no `id`. Server→client requests (approvals) carry an `id` that Dottie must answer.

### 1.1 Lifecycle

| Method | Dir | Params (fields Dottie uses) | Result / payload | Errors / notes | Verification |
|---|---|---|---|---|---|
| `initialize` | D→S req | `clientInfo{name:"dottie",title:"Dottie",version}`, `capabilities?{experimentalApi:false, optOutNotificationMethods?}` | `{userAgent, codexHome, platformFamily, platformOs}` | Any other request before this → `-32600 "Not initialized"` (V-run L1-2). `clientInfo.name` becomes the OAuth `originator` (V-run L10) | V-doc; V-src :500; V-schema; V-run L3-4 |
| `initialized` | D→S notif | `{}` | — | Must follow `initialize` | V-doc; V-schema (ClientNotification); V-run L5 |

### 1.2 Account / auth

| Method | Dir | Params | Result / payload | Errors / notes | Verification |
|---|---|---|---|---|---|
| `account/read` | D→S | `{refreshToken?: bool}` | `{account: {type:"chatgpt",email,planType} \| {type:"apiKey"} \| {type:"amazonBedrock",...} \| null, requiresOpenaiAuth}` | The live response also carried `workspaceRouting:null` (V-run L8), which is not in the generated `GetAccountResponse` schema. Tolerate unknown fields. **Signed-in shape UNVERIFIED on the wire** | V-doc; V-src :1475; V-schema; V-run L6-8, L14-15 (signed-out only) |
| `account/login/start` | D→S | `{type:"chatgpt"}` (primary) / `{type:"chatgptDeviceCode"}` (fallback). Forbidden: `apiKey` (unless PO approves), `chatgptAuthTokens` (schema: "UNSTABLE… OPENAI INTERNAL USE ONLY - DO NOT USE") | chatgpt: `{type:"chatgpt", loginId, authUrl}`; device code: `{type, loginId, verificationUrl, userCode}` | Dottie must check that `authUrl` starts with `https://auth.openai.com/` before opening it (V-run L10 value). Callback `http://127.0.0.1:1455/auth/callback`. Device-code response shape **UNVERIFIED on wire** | V-doc; V-src :1301; V-schema; V-run L9-10 |
| `account/login/cancel` | D→S | `{loginId}` | `{status:"canceled"\|"notFound"}` | Followed by `account/login/completed{success:false}` (V-run L12-13) | V-doc; V-src :1329; V-schema; V-run L11-13 |
| `account/logout` | D→S | none | `{}` | Followed by `account/updated{authMode:null}` (V-run L40-41). Behaviour when signed in **UNVERIFIED** | V-doc; V-src :1335; V-schema; V-run L39-41 |
| `account/rateLimits/read` | D→S | none | rate-limit snapshot | Shape not exercised | V-doc; V-src :1341; V-schema |
| `account/login/completed` | S→D notif | — | `{loginId?, success, error?, onboardingEntrypoint?}` | Success path **UNVERIFIED on wire** | V-doc; V-src :2071; V-schema; V-run L13 (failure) |
| `account/updated` | S→D notif | — | `{authMode?: "chatgpt"\|"apikey"\|…\|null, planType?}` | Dottie treats it as a *hint* and always re-runs `account/read` | V-doc; V-src :2018; V-schema; V-run L41 |
| `account/rateLimits/updated` | S→D notif | — | rate-limit snapshot | Not exercised | V-doc; V-src :2020; V-schema |

### 1.3 Threads and turns

| Method | Dir | Params (Dottie subset) | Result / payload | Notes | Verification |
|---|---|---|---|---|---|
| `thread/start` | D→S | `{cwd, approvalPolicy:"on-request", sandbox:"read-only"\|"workspace-write", ephemeral?, developerInstructions?}` | `{thread{id,...}, approvalPolicy, sandbox{type}, model, ...}` | **Accepted while signed out** (V-run L16-17), so Dottie must gate (ADR-0010). Enum spelling: the schema uses kebab-case `on-request`/`read-only` for thread-level fields, while the docs examples show `unlessTrusted`/`workspaceWrite` (conflict C3). **Use the schema values.** | V-doc; V-src :552; V-schema; V-run L16-17 |
| `thread/resume` | D→S | `{threadId}` | `{thread,...}` | Reuse across an app-server restart **UNVERIFIED** (W1-4) | V-doc; V-src :558; V-schema |
| `thread/read`, `thread/list` | D→S | `{threadId}` / filters | thread / page | History UI only | V-doc; V-src :858, :772; V-schema |
| `turn/start` | D→S | `{threadId, input:[{type:"text",text}], clientUserMessageId?: taskId}` | `{turn{id,status:"inProgress",...}}` | Server-side dedupe semantics of `clientUserMessageId` **UNVERIFIED** | V-doc; V-src :1057; V-schema; V-run L18,21 |
| `turn/steer` | D→S | `{threadId, expectedTurnId, input}` | — | Not used in v1 (follow-ups queue instead) | V-doc; V-src :1069; V-schema |
| `turn/interrupt` | D→S | `{threadId, turnId}` | `{}`; then `turn/completed{status:"interrupted"}` | Wire behaviour **UNVERIFIED** (doc only) | V-doc; V-src :1075; V-schema |
| `thread/started` | S→D | — | `{thread}` | | V-src :1951; V-run L19 |
| `thread/status/changed` | S→D | — | `{threadId, status{type: notLoaded\|idle\|systemError\|active}}` | `systemError` was seen after the auth failure (L36) | V-src :1952; V-schema; V-run L22,36 |
| `turn/started` | S→D | — | `{threadId, turn}` | | V-src :1980; V-run L23 |
| `item/started` / `item/completed` | S→D | — | `{item{type,id,...}, threadId, turnId}` | Item types: userMessage, agentMessage, commandExecution, fileChange, mcpToolCall, … (V-doc "Items") | V-src :1986/:1991; V-run L24-25 |
| `item/agentMessage/delta` | S→D | — | `{threadId, turnId, itemId, delta}` | Streaming text **UNVERIFIED on wire** | V-doc; V-src :1996; V-schema |
| `turn/completed` | S→D | — | `{threadId, turn{id, status: completed\|interrupted\|failed\|inProgress, error?: TurnError}}` | The only authoritative end-of-turn signal | V-src :1982; V-schema (TurnStatus); V-run L38 |
| `error` | S→D | — | `{error: TurnError{message, codexErrorInfo?, additionalDetails?}, willRetry, threadId, turnId}` | `willRetry:true` = transient; show "reconnecting" only | V-src :1950; V-schema; V-run L26-37 |
| `warning` | S→D | — | `{threadId?, message}` | Log only (e.g. code-mode host missing, L20) | V-src :2038; V-run L20,30 |
| `serverRequest/resolved` | S→D | — | resolved server request id | Dismiss any stale approval dialog | V-doc; V-src :2012; V-schema |
| `remoteControl/status/changed` | S→D | — | `{status, serverName, installationId,...}` | Unsolicited (L7). Log at debug level and ignore. Contains host name, so redact it | V-src :2022; V-run L7 |

### 1.4 Server → Dottie requests (must be answered; default answer is deny)

| Method | Params (subset) | Allowed responses | Dottie default on timeout/unknown | Verification |
|---|---|---|---|---|
| `item/commandExecution/requestApproval` | `threadId, turnId, itemId, command, cwd, reason, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments?` | `{decision: "accept"\|"acceptForSession"\|{acceptWithExecpolicyAmendment}\|{applyNetworkPolicyAmendment}\|"decline"\|"cancel"}` | `decline` (ADR-0009) | V-doc; V-src :1797; V-schema |
| `item/fileChange/requestApproval` | `threadId, turnId, itemId, reason?, grantRoot?` | `{decision: "accept"\|"acceptForSession"\|"decline"\|"cancel"}` | `decline` | V-doc; V-src :1804; V-schema |
| `item/permissions/requestApproval` | requested FS/network permissions | grant subset | grant nothing | V-src :1822; V-schema |
| `mcpServer/elicitation/request` | server, form/url | `{action:"accept"\|"decline"\|"cancel", content?}` | `decline` | V-doc; V-src :1816; V-schema |
| `item/tool/requestUserInput` | questions | `{answers}` (EXPERIMENTAL) | JSON-RPC error (not supported in v1) | V-src :1810; V-schema |
| `item/tool/call` | dynamic tool call (experimental) | tool output | JSON-RPC error unless ADR-0008 plan B is adopted | V-doc; V-src :1828; V-schema |
| *any other method* | — | — | JSON-RPC error `-32601`, logged | — |

### 1.5 `CodexErrorInfo` → Dottie handling (V-schema `CodexErrorInfo`)

| codexErrorInfo | Dottie AuthState / task outcome | User-facing |
|---|---|---|
| `unauthorized`, `httpConnectionFailed{401}`, `responseStreamDisconnected{401}` with `willRetry:false` | AuthState → `expired`. Task `failed:auth`. Re-read account | "Reconnect ChatGPT" (spec §5) |
| `usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded` | Task `failed:plan_limit`. **No API-key fallback** | Show limit text plus `account/rateLimits/read` data |
| `httpConnectionFailed{other}`, `serverOverloaded`, `internalServerError`, `responseStreamDisconnected` | `failed:network` once `willRetry:false` | "Codex is unreachable" |
| `sandboxError` | `failed:sandbox` | Show reason. Do not retry with an escalated sandbox automatically |
| `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials` | `failed:policy` | Show message verbatim |
| `contextWindowExceeded` | `failed:context` → start a new thread on the next request | |
| anything else / null | `failed:unknown` | |

Retry storm observed while signed out: 10 retry `error`s over about 14 s before the final failure (V-run L26-38). This is why the auth gate runs before `turn/start`.

---

## 2. Internal interface: `CodexRuntime` adapter (`packages/codex-adapter`, owner E02)

```ts
interface CodexRuntime {
  start(): Promise<RuntimeInfo>;                 // spawn + initialize + initialized; verifies sha256 (ADR-0003)
  stop(reason: "quit" | "restart"): Promise<void>;
  readAuth(opts?: { refresh?: boolean }): Promise<AuthState>;      // account/read
  beginLogin(mode: "browser" | "deviceCode"): Promise<LoginHandle>; // account/login/start; adapter opens authUrl itself after prefix check
  cancelLogin(loginId: string): Promise<"canceled" | "notFound">;
  logout(): Promise<void>;                        // account/logout, then readAuth()
  ensureThread(scope: WorkspaceScope, threadId?: string): Promise<string>; // thread/resume ?? thread/start
  runTurn(req: { taskId: string; threadId: string; text: string }): AsyncIterable<RuntimeEvent>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  onServerRequest(handler: (r: ServerRequest) => Promise<ServerResponse>): void; // approvals → policy (ADR-0009)
  onAuthChanged(cb: (s: AuthState) => void): void;
}
type AuthState =
  | { status: "unknown" }                          // before first account/read
  | { status: "signedOut"; requiresOpenaiAuth: boolean }
  | { status: "signingIn"; loginId: string; mode: "browser" | "deviceCode"; verificationUrl?: string; userCode?: string }
  | { status: "signedIn"; authMode: "chatgpt"; email: string | null; planType: string }
  | { status: "expired"; lastError: string }
  | { status: "unsupported"; authMode: string };   // e.g. apiKey present while API-key mode is not approved → refuse tasks
```
Rules: the adapter never returns, logs or persists tokens. Payload logging goes through the redactor (strip `authUrl` query, `userCode`,
`email` → hash, host names). Only the main process holds a `CodexRuntime`, and the renderer only sees `AuthState`.

---

## 3. Shared event contract v1 (spec §7, lines 148-157). Transport: typed Electron IPC / worker RPC

Common envelope (proposed, **not in spec text**): `{v:1, type, eventId (uuid), correlationId (= requestId|taskId), ts (ISO-8601 with offset), source}`.

| Event | Fields (spec) | Producer → Consumer | Validation / error cases |
|---|---|---|---|
| `WakeDetected` | `timestamp, deviceId, confidence` | audio-worker → coordinator, UI | Ignored while MUTED or SPEAKING-echo window. No raw audio, ever |
| `UtteranceReady` | `requestId, text, locale, endReason` | audio-worker → coordinator | `endReason ∈ {vadSilence, timeout, userStop, maxLength}` *(proposed enum)*. Empty or low-confidence text → re-prompt, no task |
| `TaskRequested` | `taskId, requestId, text, threadId?, workspaceScope` | coordinator → codex-adapter | Duplicate `requestId` → dropped (idempotent). AuthState ≠ signedIn → rejected with `AUTH_REQUIRED` and never sent to Codex |
| `TaskProgress` | `taskId, state, message, toolId?, redactedMetadata` | coordinator → UI/voice | `state` = a coordinator state (spec §4). `message` is user-safe text |
| `ApprovalRequested` | `taskId, actionId, summary, risk, expiry` | policy → secure UI | `actionId` = hash(tool, args, target) *(proposed)*. `risk ∈ {low, sensitive, destructive, external, financial}` *(proposed)* |
| `ApprovalResolved` | `actionId, approved, timestamp` | secure UI → policy | Expired, unknown or reused `actionId` → treated as **denied** |
| `ToolResult` | `taskId, toolId, observedState, verified, error?` | tool server → coordinator (via Codex `mcpToolCall` item) | `verified:false` must never be reported as success |
| `TaskFinished` | `taskId, outcome, verified, summary` | coordinator → UI/voice/store | `outcome ∈ {succeeded, partial, failed, cancelled}` *(proposed)*. Derived from `turn/completed.status` + ToolResults |
| `TaskCancelled` | `taskId, stopStatus` | coordinator → UI/voice/store | `stopStatus ∈ {stoppedConfirmed, stoppedUnconfirmed, ttsOnly, alreadyFinished}` *(proposed)* |

Proposed additions (**not in spec v1. They need E01 approval and a version bump**): `AuthStateChanged {state: AuthState}`, `RuntimeHealth {status, restarts}`,
`MicStateChanged {muted, deviceId}`.

### 3.1 App Server → Dottie event mapping
`turn/started` → `TaskProgress{state:EXECUTING}`. `item/agentMessage/delta` → `TaskProgress{message}` (throttled). `item/*/requestApproval` → `ApprovalRequested`.
`item/completed{mcpToolCall}` → `ToolResult`. `error{willRetry:true}` → `TaskProgress{state:RECOVERING}`. `turn/completed` → `TaskFinished` or `TaskCancelled`.
`account/updated` → re-read → `AuthStateChanged`.

## 4. IPC rules
Every message is schema-validated on receipt and rejected on unknown `v` or type. Renderer ↔ main uses preload-exposed functions only (no `ipcRenderer` passthrough).
No secrets, tokens, raw audio or full file contents cross IPC. Correlation IDs are logged, payloads are logged only after redaction.

## 5. MCP tool result contract (`dottie-tools` server, ADR-0008; owner E04/E11)
Each tool returns MCP `structuredContent`:
`{success: boolean, verified: boolean, observedState: object, error?: {code, message, retryable}}`.
Error codes *(proposed)*: `DENIED_BY_POLICY, NEEDS_APPROVAL, NOT_FOUND, AMBIGUOUS, TIMEOUT, PRECONDITION_FAILED, POSTCONDITION_FAILED, INTERNAL`.
Existing Bot tools already return `verified`/`observed` in places (e.g. `src/Bot/tools/desktop_tools.py:382-437` navigate verification; drag returns
`verified:false` at :1221-1226), but there is no common schema, so an adapter normalizes them.

## 6. Unverified items (must be closed in Week 1)
1. Signed-in shapes of `account/read`, `account/login/completed{success:true}`, `account/updated{authMode:"chatgpt"}`. 2. The device-code response.
3. `thread/resume` after a process restart. 4. `turn/interrupt` wire behaviour. 5. `item/agentMessage/delta` streaming. 6. Credential store `keyring` on Windows.
7. MCP stdio server reaching the interactive desktop under the Windows sandbox. 8. `clientUserMessageId` dedupe. 9. Windows-specific `initialize`
values (`platformFamily:"windows"` expected).
