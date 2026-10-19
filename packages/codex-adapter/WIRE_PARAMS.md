# Wire params for E09 (Codex App Server 0.163.0, stdio)

Status: copied from the source on branch `feature/E02-approvals-bridge` (2026-10-19, E09 v0.3.0 inputs folded in). Every frame below is what the
adapter writes, byte for byte, apart from the `<placeholders>`. If the source changes, this file must change with it.

## Framing (src/jsonrpc.ts:48-58, src/connection.ts:67,99)
- One JSON object per line, terminated by `\n`. **No `"jsonrpc"` member.** `JSON.stringify` with no whitespace.
- Key order is exactly as shown: requests `{"id","method","params"}`, notifications `{"method","params"}`,
  replies `{"id","result"}` / `{"id","error":{"code","message"}}`.
- Request ids are integers from a per-connection counter that starts at `0` (a new child gets a new connection, so ids
  restart at 0).

## Command line (src/env.ts:101-110)
```
<pinned codex binary> [extraArgs…] -c forced_login_method="chatgpt" app-server --listen stdio://
```
- As an argv array: `[...extraArgs, "-c", "forced_login_method=\"chatgpt\"", "app-server", "--listen", "stdio://"]`.
  The value is the TOML string `"chatgpt"`, quotes included. Verified on 0.163.0: `config/read` reports it with origin
  `sessionFlags`.
- The forced flags come after any caller flags, so a later `-c` can't override them. A caller flag mentioning
  `forced_login_method` or `forced_chatgpt_workspace_id` is refused (`EnvError`).
- No shell. stdio only. The binary's sha256 is checked against the pin before every spawn.

## Child environment (src/env.ts:80-94; reviewable list in ENV_ALLOWLIST.md)
- Built from an **allowlist**, never by copying `process.env` and deleting keys: a parent variable is copied only if
  `isAllowedEnvName(name, platform)` is true. Windows names match case-insensitively, POSIX names exactly; proxy names
  match in any case.
- Then `CODEX_HOME` = Dottie's dedicated home, which always overrides an inherited value. Spawn is refused if it
  resolves to the user's `~/.codex`.
- Everything else never reaches the child: `OPENAI_*`, `AZURE_OPENAI_*`, `CODEX_*` other than `CODEX_HOME`, and any
  unlisted name. Values are never logged. The `env.scrub` audit lists kept names, the names of removed *sensitive*
  variables, and only a count of the other removed variables (CONTRACTS §3.2).

## Handshake (src/runtime.ts:338-347)
```json
{"id":0,"method":"initialize","params":{"clientInfo":{"name":"dottie","title":"Dottie","version":"<clientVersion>"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}
{"method":"initialized","params":{}}
```
- `initialized` is sent only after a successful `initialize` result. A `-32600` error (`Not initialized` /
  `Already initialized`) or a timeout (default 20 s) kills the child, which restarts under ADR-0013 backoff.

## Auth read (src/auth-service.ts:184), sent right after the handshake and as the gate before every task
```json
{"id":<n>,"method":"account/read","params":{"refreshToken":false}}
```

## thread/start (src/turns.ts:408,416)
```json
{"id":<n>,"method":"thread/start","params":{"cwd":"<workspace path>","approvalPolicy":"on-request","sandbox":"read-only"}}
```
- `sandbox` is `"read-only"` by default, or `"workspace-write"` only if configured. `danger-full-access` can't be expressed.
- `cwd` = `workspaceScope.paths[0]`, otherwise the configured `defaultCwd`. If neither exists, the task is refused before any thread call.
- The echo is checked: `result.approvalPolicy === "on-request"`, `result.sandbox.type === "readOnly"`
  (`"workspaceWrite"` for workspace-write) and `result.thread.id` present. Otherwise the task is refused fail-closed.

## thread/resume (src/turns.ts:408,414)
```json
{"id":<n>,"method":"thread/resume","params":{"threadId":"<codex thread id>","cwd":"<workspace path>","approvalPolicy":"on-request","sandbox":"read-only","excludeTurns":true}}
```
- Sent only when the thread isn't loaded in the current child, e.g. after an App Server restart. Same echo check as
  thread/start, plus `result.thread.id === threadId`. Extra result keys (`collaborationMode`, `initialTurnsPage`, …) are ignored.
- `excludeTurns:true` (E09 v0.3.0): without it the server hydrates the full history and sends `deprecationNotice`.
  With it `thread.turns` should come back empty (UNVERIFIED on wire until E09 re-runs; the adapter never reads it).
- Notifications the adapter ignores without any state change or warning: `deprecationNotice`, `thread/goal/cleared`
  (seen on resume, E09 v0.3.0), `thread/status/changed`, and anything else outside `turn/*`, `item/*`, `error`.

## thread/resume and `excludeTurns`: 0.163.0 schema citation (W1-4, ruling 1s)
Source: `packages/contracts/codex-generated/json-schema/v2/ThreadResumeParams.json` (sha256 `8dceca41…5e491496`) and
`ts/v2/ThreadResumeParams.ts`, generated from `openai/codex` `rust-v0.163.0` (commit `83086188ae06`, `codex-pin.json`).
- `required: ["threadId"]`, `threadId: string`. All other params are optional and nullable. The adapter sends
  `threadId`, `cwd`, `approvalPolicy`, `sandbox` and `excludeTurns` only. It never sends `history` or `path` (doc comment:
  for a non-running thread "history > non-empty path > thread_id"; for a running thread the server "rejoins that thread").
- `excludeTurns: boolean` (optional), schema text: "When true, return only thread metadata and live-resume state without
  populating `thread.turns`. This is useful when the client plans to call `thread/turns/list` immediately after resuming.
  Full-history hydration is deprecated for paginated threads; use this with `thread/turns/list` and `thread/items/list`
  instead." The adapter always sends `excludeTurns: true`.
- `ThreadResumeResponse.required`: `approvalPolicy, approvalsReviewer, cwd, model, modelProvider, sandbox, thread`.
  The adapter checks `approvalPolicy`, `sandbox.type` and `thread.id`, and ignores everything else.
- Ruling 1s (src/turns.ts:410-440): a request that carries a `threadId` the current child has not loaded is resumed
  with `excludeTurns:true` whatever its `resume` flag says. A thread already loaded in this child is not resumed again.
  The loaded set belongs to one App Server process and is cleared on every restart. If `result.thread.id !== threadId`,
  the echo check fails: audit `codex.thread_echo_mismatch`, outcome `blocked_unavailable` (transient,
  `codex_unavailable`), no `turn/start`, and no thread is assigned. Tests: test/turns.test.ts "1s: …" (4).
- **UNVERIFIED** (W1-4): restart-retry, i.e. after an App Server restart, a resume of the same `threadId` in the new
  child with `excludeTurns:true` returning the same `thread.id` and an empty `thread.turns`. Covered only by the scripted
  transcript test. It has not been observed on the wire against a real 0.163.0 child until E09 re-runs W1-4.

## thread/turns/list: restart reconcile (src/turns.ts:639)
```json
{"id":<n>,"method":"thread/turns/list","params":{"threadId":"<codex thread id>"}}
{"id":<n>,"method":"thread/turns/list","params":{"threadId":"<codex thread id>","cursor":"<nextCursor>"}}
```
- In the 0.163.0 non-experimental schema. Sent at the start of the first run() on each new child, once per thread that
  has `unknown` records (a crash or restart left the outcome open), before that run's `account/read`. Up to 4 pages,
  newest first (the server default).
- Matches the turn whose `userMessage` item has `clientId` = the coordinator turnId. The store comes first: the record
  stays `unknown`, is never resent, and only gets `serverCheck` = `match` / `absent` / `mismatch` (another Codex turn id,
  or the clientId on several turns, audited as `codex.turn_reconcile_mismatch`) / `unavailable` (error, or more than 4
  pages; re-checked once on the next child).

## turn/start (src/turns.ts:344-345)
```json
{"id":<n>,"method":"turn/start","params":{"threadId":"<codex thread id>","input":[{"type":"text","text":"<request text>","text_elements":[]}],"clientUserMessageId":"<coordinator turnId>"}}
```
- `clientUserMessageId` is the **coordinator's turnId** from the request (`CodexTaskRequest.clientUserMessageId`,
  always equal to `turnId`, e.g. `<taskId>.t<n>`). It is new for every retry and every clarification turn. A request
  where the two differ, or either is empty, is refused before anything is written. It is NOT the taskId.
- The server does not dedupe it (E09). So the adapter never writes a second `turn/start` for:
  1. a turnId already dispatched for that task (persisted in the turn store),
  2. a thread that already has a task (reserved synchronously before any wire write, including `account/read`),
  3. a taskId or idempotencyKey that already has a run in flight.
- Sent only if the auth gate says `signed_in`, checked both at run() entry and against the latest status right before
  the write. The adapter never retries a turn itself; the coordinator retries `origin:'turn_failed'` only.

## turn/interrupt (src/turns.ts:465)
```json
{"id":<n>,"method":"turn/interrupt","params":{"threadId":"<codex thread id>","turnId":"<codex turn id>"}}
```
- `turnId` here is **Codex's** turn id (from the turn/start result), not the coordinator's.
- Cancel reports `stopped:true` only after it observes `turn/completed{status:"interrupted"}`, which arrived after
  `{}` and `thread/status/changed{idle}` on 0.163.0 (E09). Default wait is 10 s; after that the ack is `stop_unconfirmed`.

## Heartbeat while ready (src/runtime.ts:384)
```json
{"id":<n>,"method":"thread/loaded/list","params":{"limit":1}}
```

## Replies the adapter sends to server requests (src/connection.ts:152-176, src/server-requests.ts, src/approvals/bridge.ts)
Exactly one reply per server request id, except when the server resolved the request itself (no reply at all).
```json
{"id":<server id>,"result":{"decision":"decline"}}
{"id":<server id>,"result":{"decision":"cancel"}}
{"id":<server id>,"result":{"decision":"accept"}}
```
- `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (approvals bridge, ADR-0009):
  - `"accept"` only for an exact `{approved:true, reason:"approved"}` from the coordinator's hook while the request is
    live, plus a K8 token bound to that actionId and taskId (CR6). Until DOT-092 the token port issues none, so the
    adapter **never sends accept** today. Never `acceptForSession`, `acceptWithExecpolicyAmendment` or
    `applyNetworkPolicyAmendment`, whatever amendments Codex proposes.
  - `"cancel"`: the turn ended or was interrupted (`turn/completed`), or a revoke (panic-stop, mute, Quit, task cancel,
    lock). On task cancel the cancel reply follows the `turn/interrupt` request by a few microtasks.
  - **no reply**: `serverRequest/resolved` for that id on that thread, or the App Server went away (nothing to write to).
  - `"decline"`: everything else (user declined, time limit 60 s default / 120 s max, locked desktop with no dialog,
    `grantRoot` set, credential_access, unknown turn or item, unexpected keys or duplicate JSON keys, actionId not
    computable, any exception, no or bad token).
  - Without the bridge configured: always `"decline"`.
- `item/permissions/requestApproval` → `{"permissions":{},"scope":"turn"}` (empty grant).
- `mcpServer/elicitation/request` → `{"action":"decline","content":null,"_meta":null}`; a `mode:"url"` request opens nothing.
- `applyPatchApproval` / `execCommandApproval` → `{"decision":{"denied":{"rejection":"Dottie does not use the legacy approval APIs"}}}`.
- `item/tool/requestUserInput`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate` and any
  unknown method → `{"id":<server id>,"error":{"code":-32601,"message":"Method not found"}}`.

## Approval display binding (DOT-095, src/approvals/bridge.ts; contracts src/display.ts)
- For every command or file-change approval that opens a dialog, the bridge builds the bound `ApprovalDisplay` from
  the 0.163.0 params with `codexDisplay` (key names per ruling 1v). `commandLine` = `command`, `workingDirectory` =
  canonical `cwd`, `networkAccess` = `requested|not_requested` from `networkApprovalContext`, and `escalation` lists
  every network context and every proposed execpolicy or network-policy amendment (shown, never granted). File
  changes give `paths` (a move lists both) and `fileCount`. Codex `reason` is untrusted: stripped and cut into
  `reasonUntrusted`, and never put in a bound field.
- `displayHash` = sha256(canonicalJson(display)) and `requestSource: "codex"` go into the actionId binding. The
  normalised display params travel on `CodexApprovalRequest.display`, so the coordinator rebuilds the same bytes.
- Fail closed: if the display cannot be built (over a never-cut limit: commandLine > 8192 bytes, > 500 paths, a path
  or workingDirectory > 4096 bytes, > 32 escalations), the reply is `"decline"` with audit `display_unavailable`. No
  dialog opens and the coordinator gets no request.
- `writeStdin` command approvals (E01 ruling 1x, dottie-e01 `474c502`) have no display kind. They are always
  `"decline"` with `display_unavailable`, with exactly one reply per request id, no dialog and no coordinator request.
- A coordinator answer of `expired`, `{approved:false, reason:"display_unavailable"}` or
  `{approved:false, reason:"duplicate_request"}` is always `"decline"` and never accepts. No token is requested.

## Unknown wire fields (E01 ruling 2i; test/wire-tolerance.test.ts)

The App Server wire is tolerant. Unknown fields, ordinary names and `__proto__` / `constructor` arriving as own JSON
keys, are dropped. Every object the adapter hands on (hooks, `CodexRunResult`, `CodexApprovalRequest` and its display,
the turn store, audit/log fields, `AuthStatusInfo`) is built field by field from known members. No wire object is
spread or forwarded. Wire members are read by own key only (`Object.hasOwn`), never `in`. Fixed 2i leak: `item/started`
with `item.type` named after an `Object.prototype` member (`constructor`, `toString`…) passed the `in TOOL_PROGRESS`
check. It fired `toolStarted`, marked the ledger touched and handed the inherited function to `progress`. It's now an
unknown item. Nested unknown fields in approval members (`networkApprovalContext`, amendments, file-change entries)
don't change the display or the bound actionId. The one deliberate exception is an unknown TOP-LEVEL key on an
approval request. It's tolerated fail-closed: exactly one `decline` (`schema_invalid`), no dialog, never approved unseen.
