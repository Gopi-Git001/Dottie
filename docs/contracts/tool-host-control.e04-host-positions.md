# E04 host-side positions for `docs/contracts/tool-host-control.md` (DOT-092): memo for E03 to merge

> **Status: memo, not a spec.** Author **E04**, Mon 2026-10-19 ~01:20 CDT (UTC-5). It answers E03's DRAFT 1 (`docs/contracts/tool-host-control.md`) and is meant to fill its **§10** ("Reconciliation with E04 material"). Section and proposal numbers refer to that draft (§2–§9, P1–P22, Q-E04-1…6). New E04 proposals are numbered **E-P1…E-P7** so they don't collide with P1–P22.
> Labels are the same as the draft: **[RULED]** (cites CONTRACTS/ADR/E01), **[DECIDED C#]** (E03/E04 decisions C1–C7, sent to E03 2026-10-19; not E01-signed), **[PROPOSAL]**, **UNVERIFIED**.
> Where this memo and CONTRACTS disagree, CONTRACTS wins. E01 signs DOT-092; E08 reviews §5 items.
> Evidence: `packages/tools/` (reference model `dottie_tools/reference/reference.py`, `approval.py`, `catalog.py`; registry `dottie_tools/targets/`). On the box, Linux, Windows mocked: **304 passed, 4 xfailed** (2026-10-19 ~01:20 CDT). This proves contract logic only, not Windows behaviour.

---

## 10.1 Decisions C1–C7: status on the E04 side

| # | Decision | E04 change | Tests |
|---|---|---|---|
| C1 | Missing host context (no active turn, stop requested, channel down) → `PRECONDITION_FAILED`, not `INTERNAL` | `reference.py` step 1; tools.md Draft 3 §2.6 row 1 | TID-01c |
| C2 | `pid` is a decimal string everywhere | `dottie_tools/targets/` wire form (`hwnd`, `pid`, `processStartTime` all `^[1-9][0-9]*$`, `"0"` invalid); tools.md §6 | WIRE-*, APH-03 (`"pid":"700"`), MUT-02 |
| C3 | `targetId` valid until `endTask(taskId)`; "superseded" kept **per window** (only the re-registered window's old id dies; corrected 2026-10-19 ~01:45 CDT, answers Q-E04-8); 300 s TTL replaced by a **30-min safety cap** (**PROPOSAL**) that reports `NOT_FOUND` | `WindowRegistry(ttl=1800)`, `end_task(taskId)`; tools.md §2.3 | REG-05/05b/06b, TID-01b, **TID-01e** (id survives t1→t2→t3 through an `AMBIGUOUS` round-trip, 6 + 10 min apart) |
| C4 | Reserved keys: reject, not strip (settled) | unchanged; plus P9 spelling variants on the host side | CTX-01/01b/01c, **CTX-01d** |
| C5 | Token bound to `taskId` + `toolId` + `actionId`, single use, short TTL; **not `turnId`** | `FakeK8.mint/consume`; TTL `min(approval, mint + 10 s)` (P18) | TOK-03/03b/03c, TOK-05/05b, **TOK-09/09b/09c** |
| C6 | `ApprovalResolution.decision` uses the CONTRACTS §3.2 enum | `ApprovalResolution`, `FakeCoordinator` | MUT-03 (8 cases) |
| C7 | A revocation caused by a cancel → `CANCELLED`, `sideEffect:'none'` | `reference.py` steps 8 and 10 | MUT-03 (`task_cancel`, `turn_ended`), **TOK-06b** |

Edits this implies in E03's draft (proposed wording for E03):
- §3 / §5.3 / §5.5: drop `turnId` from the token record, the MAC input and the binding sentence ("Binding = `taskId + toolId + actionId`", C5). Replace "revoked by end of the turn (a token minted in `t1` is dead in `t2`)" with "revoked by `endTask`, task cancel and the ADR-0009 item 7 events". `consumeToolToken` params keep `turnId` only as an informational field (or drop it).
- §4.2: replace the C3 sentence with "valid until `endTask(taskId)`; superseded **per window** (the same window re-registered under a new id in the same task kills only its old id); 30-min safety cap (PROPOSAL) → `NOT_FOUND`". (Earlier wording "a newer candidate list supersedes" was wrong; DRAFT 3 §4.2 has the right rule. Test REG-05c.)
- §4.4 mapping table: add the row `revoked` with `reason:'task_cancel'` → `CANCELLED`/`none`. **Conflict to flag:** CONTRACTS §3.2 maps task cancel to `decision:'revoked'`, `reason:'task_cancel'`, but draft §4.4 maps it to `cancelled`/`task_cancel`. The host returns `CANCELLED` for either (C7), so the host doesn't care, but the coordinator and audit must pick one. CONTRACTS §3.2 wins unless E01 changes it.
- §10 table: C1, C2, C3, C5, C6 and C7 → "applied by E04 (tools.md Draft 3, scratch)".
- §8.2: add **H-14** "a token survives a turn change in the same task (with the approved ids) and fails for another task, tool or `actionId`", and **H-15** "a `targetId` survives an `AMBIGUOUS` round-trip across turns; dead after `endTask`".

## 10.2 Transport and framing under ADR-0008 (answers Q-E04-1 / P1)

**[RULED]** background (draft §2.1): under option (B) the tool host's stdio belongs to Codex (MCP), so the control channel must be a separate local channel. Under option (A) it is the worker's stdio.

**Recommendation (PROPOSAL E-P1): a named pipe whose name is derived, not delivered.**
- Name: `\\.\pipe\dottie-toolhost-<h>`, where `h` = first 32 hex of SHA-256(`"dottie.toolhost.pipe.v1"` ‖ user SID ‖ logon session id). Both ends can compute it from their own process token, so **nothing has to cross the env allowlist or `config.toml`**. The hash keeps the SID out of the object namespace. The name is not a secret, and nothing relies on it being one.
- Why not the other carriers:
  - *Env var* (`DOTTIE_TOOLHOST_PIPE`): it needs an allowlist addition (E08 review of DOT-089 `env.ts`) and relies on Codex passing it through to the MCP child (UNVERIFIED for 0.163.0). Second best; acceptable if E08 prefers a per-launch random name.
  - *`config.toml` MCP `env`*: the file is persisted, so a per-launch name means rewriting user config on every start. Avoid.
  - *Handle inheritance*: the handle would have to survive Electron → App Server → MCP child, and Codex controls the last spawn (which handles it inherits is UNVERIFIED, and inheritance can't be limited from our side). Reject.
- **Squatting and ACLs** (the fixed name makes squatting the main risk):
  1. Electron main creates the pipe **before** spawning App Server, with `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS`, max instances 1, and an explicit DACL: the current user SID only (no Everyone, no Authenticated Users, no `NETWORK`), owner = the user, Medium integrity label. If creation fails because the name exists (`ERROR_ACCESS_DENIED` / `ERROR_PIPE_BUSY`), **someone squatted it**: don't start the tool host, set a `RuntimeStatus` warning, and write an audit record (kind TBD, Q-E08-6). Never fall back to a different name silently.
  2. Server-side peer check (draft §2.2): `GetNamedPipeClientProcessId` → the client must be a live descendant of the supervised `codex app-server` PID **and** its image must be the Dottie tool-host executable under the install dir. Compare the process start time too, so a recycled PID fails (same idea as the 4-field window identity).
  3. **Client-side check (new):** the host calls `GetNamedPipeServerProcessId` and refuses unless the server is an ancestor of the host with the Dottie main image (by path and start time). That stops a same-user process that wins a race to create the pipe while Dottie isn't running.
  4. One connection at a time (draft P1). A refused peer is disconnected and audited.
- A handshake secret (Q-E08-1): I don't recommend one, because its only carriers are the env and `config.toml`, the two things this design avoids. The two-way peer check plus first-instance creation covers the same threat (a same-user process impersonating either end). If E08 still wants a secret, the sound carrier is the env allowlist with a per-launch random value that is never logged. E08 decides.
- Framing (P2): agree with NDJSON, 64 KiB lines, strict schemas. Host specifics (PROPOSAL E-P2):
  - one reader thread; requests are matched by `id`; the MCP stdio loop never blocks on the pipe for longer than the call's own deadline;
  - host-side timeouts: `authorizeToolCall` 2 s → `PRECONDITION_FAILED`; `requestApproval` = approval `expiry` + 5 s → `APPROVAL_REQUIRED` if the turn is live, else `CANCELLED`; `consumeToolToken` 2 s → `DENIED_BY_POLICY` (never dispatch on a timeout);
  - channel loss (P3): every new call → `PRECONDITION_FAILED`; in-flight calls stop at the next cancellation point (§10.5) and report honestly.

## 10.3 How the host starts the approval round-trip (draft §4.4)

[RULED] sequence (ADR-0009 CR2/CR3/CR5/CR6); host behaviour:
1. `authorizeToolCall` → schema → scope → session gate → target lookup. Nothing has run yet.
2. Category from the catalog (§10.6). `read` in scope and `navigate` **never** call `requestApproval` and need no token. Everything else does.
3. Compute `actionId` from the **resolved** args and the 4-field window identity (wire form, decimal strings), with `purpose:"dottie.actionId.v1"`.
4. Send `requestApproval{callId, actionId, binding, preview}` and wait (in-call). `preview.summary` describes exactly the hashed fields; untrusted screen text only appears labelled as untrusted.
5. Map `ApprovalResolution.decision` (C6/C7; implemented in `reference.py`):

| decision (reason) | tool `error.code` | `sideEffect` |
|---|---|---|
| `approved` | continue to the identity re-check and `consumeToolToken` | — |
| `declined` (`user_declined`) | `USER_DECLINED` | `none` |
| `expired` (`timeout`) | `APPROVAL_REQUIRED` | `none` |
| `revoked` (`mute`, `locked`, `panic_stop`, `quit`, `app_server_restart`; turn still live) | `APPROVAL_REQUIRED` | `none` |
| `revoked` (`task_cancel`) or `cancelled` (`turn_ended`, `turn_interrupted`, `ipc_disconnect`, …) | `CANCELLED` (C7) | `none` |
| `denied_by_policy` (any reason) | `DENIED_BY_POLICY` | `none` |

6. **Fallback (PROPOSAL):** with no coordinator path (e.g. option A before the channel lands), return `APPROVAL_REQUIRED` with `observedState.actionId` and push the preview, never act.

## 10.4 K8 token on the host (draft §5; E08 review)

- **Validation.** The host can't verify the MAC (`k8Key` never leaves main, CONTRACTS §3.3 [RULED]), so it treats the token as opaque and relies on `consumeToolToken`. Its own independent checks (CR6 "re-checked by the tool server") are:
  - re-read the window identity immediately before dispatch: any change → `PRECONDITION_FAILED`, `none`, **token not spent**;
  - recompute `actionId` from what it is about to do (re-resolved args and window);
  - consume with that `actionId` + live `taskId` + `toolId`, and dispatch only on `ok`.
  I think that satisfies CR6 (Q-E08-2), because the binding check happens against what the host is about to do. E08 decides.
- **Binding (C5):** `taskId + toolId + actionId`. The resolved window identity is inside `actionId` (CR2), so a different window or args → `wrong_action`. Not `turnId`.
- **C5 vs CR2 (needs E01/E08):** CR2 hashes `turnId`, `itemId` and `requestId` into `actionId`, so a call re-issued in a later turn has a different `actionId`. For a token to survive a turn change (C5's purpose), **the coordinator must hand back the approved binding's ids with the token** and the host recomputes `actionId` with those ids plus the freshly re-resolved args and window (TOK-09 passes; TOK-09b shows that without them the match fails). PROPOSAL E-P3: the `authorizeToolCall` result may carry `approval?: {actionId, token, binding:{threadId, turnId, itemId, requestId}}` when K8 holds a live, unconsumed approval for this task and tool. A 10 s token rarely outlives a turn change, so K8 should **mint a fresh token at re-issue from the still-live approval** (≤ 60 s, 120 s max), never extend the approval. The alternative is to drop `turnId`/`itemId`/`requestId` from `actionId`, which is a CR2 change.
- **Single use / replay:** K8 burns the token on **any** consume attempt, including a mismatch (scratch `FakeK8`). A second use → `reused`. The host holds the token in memory for one call only and drops it after consume, on `cancelToolCall` and on `endTask`.
- **TTL:** `min(approval.expiresAt, mint + 10 s)` (P18 PROPOSAL); never longer than the approval (TOK-05/05b).
- **Error mapping** (E01 ruling: `APPROVAL_REQUIRED` = grantable but not yet approved; `DENIED_BY_POLICY` = never grantable or bad authorization):

| consume verdict (P19 reason) | tool code | `sideEffect` |
|---|---|---|
| `ok` | dispatch | — |
| `missing`, `unknown_token`, `reused`, `expired`, `revoked` (non-cancel), `task_mismatch`, `tool_mismatch`, `wrong_action` | `DENIED_BY_POLICY` | `none` |
| revoked **because of a task cancel** | `CANCELLED` (C7) | `none` |
| no K8 / consume timeout | `DENIED_BY_POLICY` (fail closed) | `none` |

  `APPROVAL_REQUIRED` only comes from the approval stage (§10.3), never from a token check. The host writes `policy.denied` with the reason and `actionId`, never the token. K8's own `tool_token.*` records are P19.

## 10.5 `sideEffect` reporting and cancellation (draft §4.6, §6.4; answers Q-E04-3)

**Rule (PROPOSAL E-P4): the phase flips to `after_send` immediately *before* the side-effecting call, after the token is consumed.** A cancel that races the call is therefore reported `unknown`, never `none`. `committed` is reported only when verification passed.

| Point | Result | `sideEffect` | `cancelToolCall` phase |
|---|---|---|---|
| any refusal before dispatch (codes 1–8, approval outcomes, token failures) | per table | `none` | `not_started` / `before_send` |
| cancel before dispatch | `CANCELLED` | `none` | `before_send` |
| window gone after lookup, before send | `PRECONDITION_FAILED` | `none` | `before_send` |
| sent; cancel during verify | `CANCELLED` | `unknown` | `after_send` |
| sent; window gone / unobservable | `POSTCONDITION_UNKNOWN` | `unknown` | `after_send` |
| sent; deadline without the postcondition | `POSTCONDITION_FAILED` | `unknown` | `after_send` |
| verified | `verified:true` | `committed` (or `none` if already there) | `completed` |

`retryable:true` only with `none` [RULED §5]. The coordinator never downgrades (P21, agreed).

**Where long Windows calls can be cancelled (Q-E04-3):**
- **COM navigate** (`IShellWindows` → `IWebBrowser2::Navigate2`): a synchronous cross-process call into `explorer.exe`. It **can't be safely cancelled mid-call**. Cancellation points are before the call (`none`) and after it returns (`unknown`). Run it on a dedicated STA worker with a call timeout. `CoEnableCallCancellation` + `CoCancelCall` may unblock our thread, but Explorer may still navigate, so the result is `unknown`. Never retry automatically.
- **UIA waits / verify loop:** sample every ~200 ms and check the cancel token at every sample. Bound each UIA call with `IUIAutomation2` connection/transaction timeouts (~1–2 s). After send, a cancel → `CANCELLED`/`unknown`.
- **Playwright (DOT-078, browser):** each action has an explicit timeout. Cancel = close the page/context (Playwright has no general abort for an in-flight action). An action already dispatched → `unknown`. `goto` after the request is sent → `unknown`.
- **Shell (ADR-0016 pending, skill `e04-windows-shell-runner-tree-cancel`):** the child runs in a Job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Cancel = `TerminateJobObject` (tree kill), then wait for the job to drain. Before `CreateProcess` → `none`; after → `unknown` unless the command class is read-only. Report the exit status.
- **Files:** `MoveFileEx`/`DeleteFile` are single calls (before → `none`, after → verify). `CopyFileEx` can be cancelled from its progress callback (`PROGRESS_CANCEL`). A partial copy is cleaned up, and the result stays `unknown` unless the cleanup is verified.
- **UNVERIFIED:** how `turn/interrupt` reaches an in-flight MCP call in 0.163.0 (MCP `notifications/cancelled`, or process kill). That's why `cancelToolCall` (P15) is needed. Agree with P15.
- PROPOSAL E-P5: the host also sends a `toolCallFinished{callId, toolId, phase, sideEffect}` notification at the end of every call that passed `authorizeToolCall`. An interrupted turn may drop the MCP result (UNVERIFIED), and the ledger should not depend on Codex relaying it.

## 10.6 Catalog: `mutating` flag vs "unknown ⇒ mutating" (answers Q-E04-4 / P7)

**Recommendation (PROPOSAL E-P6), implemented in `dottie_tools/reference/catalog.py` + `tests/test_catalog.py`:**
- Every tool in `hello.catalog` declares an **explicit CONTRACTS §3 category** (and scope). A tool with a missing or unknown category, or one missing from the catalog, is **treated as mutating** (approval + token). This feeds the adapter's existing "unknown ⇒ true" default rather than replacing it.
- `mutating` is **derived** from the category (`category ∉ {read, navigate}`), never declared independently, so the two can't disagree.
- **`navigate` is the only no-confirm category** beyond `read` inside granted scope (ADR-0009 item 8). Its membership is closed (E08 sign-off); today its only member is `explorer.open_known_folder`.
- No-confirm does not mean no side effect: `navigate` changes window state, so `ToolStart.mayHaveSideEffects` stays `true` for everything except `read`.

## 10.7 `itemId` from Codex (answers Q-E04-2 / P5)

- **Checked the local Codex source** `src/codex` @ `main` 8c07694 (committed 2026-10-17 20:58 CDT). Per ARCHITECTURE.md this is **not** the `rust-v0.163.0` pin, so it is UNVERIFIED for the pinned binary.
- In that source, `codex-rs/core/src/mcp_tool_call.rs` builds the MCP `tools/call` `_meta` as:
  - `callId` = the tool call's `call_id` (`build_mcp_tool_call_request_meta`, line ~1323). Codex analytics use the same value as `item_id` (line ~1151), so it is very likely the `mcpToolCall` item id;
  - `threadId`, `sessionId`;
  - `x-codex-turn-metadata` (turn metadata);
  - `itemId` and `windowId` **only** when the call has an originating call (`with_mcp_tool_call_ids_meta`, line ~1423, nested/code-mode calls).
- Position (PROPOSAL E-P7):
  - `itemId` in `actionId` = `_meta.callId` when present, else `null` (CR2 null rule). `requestId` = the JSON-RPC `id` of `tools/call`.
  - Both are informational: Codex builds `_meta`, so it is never authority. Authority (task, turn) comes only from `authorizeToolCall`.
  - Never put anything of ours in `_meta`.
- **What the W1-S2 spike must check on 0.163.0:** log the `tools/call` `_meta` keys (names, plus values for the ids only) for one call; confirm that `_meta.callId` equals the `item/started` `mcpToolCall` `id` on the App Server wire; confirm that `threadId` equals the `thread/start` id; and see whether anything changes across a retry or interrupt.

## 10.8 Reserved model arguments

[RULED]/settled 2026-10-19: **reject**, not strip (draft §4.3 step 2; CONTRACTS ruling quoted there). E04 agrees. Rejecting fails closed and gives a visible, auditable signal of an injection attempt. Stripping would silently "fix" a call that tried to choose its own authority. The host enforces the same set and the P9 spelling-variant normalisation (CTX-01d) in addition to `additionalProperties:false`. Key names are logged sorted, values never.

## 10.9 Top open questions for E03

1. **C5 vs CR2** (§10.4): do you accept E-P3, where `authorizeToolCall` returns the approved binding ids with a token freshly minted from the live approval for a re-issued call? Or should we ask E01 to drop `turnId`/`itemId`/`requestId` from `actionId`?
2. **Task-cancel decision value:** §3.2 says `revoked`/`task_cancel`; your §4.4 says `cancelled`/`task_cancel`. Which one does `ApprovalResolution` send (Q-E01-4)?
3. **Pipe naming:** do you accept the derived per-user/per-session name (E-P1) with first-instance creation and the two-way peer check, instead of an env allowlist entry? (E08 co-owns.)
4. **Host timeouts** on control requests (E-P2) and the fail-closed mapping for each.
5. **`toolCallFinished` notification** (E-P5), so the ledger doesn't depend on Codex relaying an MCP result after an interrupt.
6. **Catalog:** do you agree that `hello.catalog` feeds (not replaces) "unknown ⇒ mutating", with `mutating` derived from category (E-P6)?
7. **targetId safety cap:** is 30 min OK as the upper bound behind `endTask`, given clarification timeouts (CONTRACTS §2.1)?

## 10.10 E04 proposals index (new)
E-P1 derived pipe name + first-instance + DACL + two-way peer check · E-P2 host-side control timeouts and fail-closed mapping · E-P3 approved-binding ids + re-minted token on a re-issued call · E-P4 phase flips to `after_send` before the call · E-P5 `toolCallFinished` notification · E-P6 explicit category per tool, missing ⇒ mutating, `mutating` derived · E-P7 `itemId` = `_meta.callId` (informational).

## Update for DRAFT 5 / 5.1 (2026-10-19 ~01:55 CDT): E08 rulings adopted
Where E08's rulings differ from the positions above, the rulings below take precedence. The review is in `tool-host-control.e04-review-draft5.md`.
- **E-P1 → E08 1 / N1 (H-13).** The server checks peers by:
  - Job membership;
  - the SHA-256 of the pinned image;
  - process start time;
  - user and logon SID;
  - the pinned catalog (`catalog_mismatch`).

  The parent chain is at most an extra signal. The host opens the pipe with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`, so a squatting server can't impersonate it, and it refuses a server that is not the expected K8 image. Implemented mocked in `packages/tools/src/dottie_tools/host/pipe_peer.py`. UNVERIFIED on `<test-pc>`, including whether the host token is restricted or AppContainer.
- **E-P3 → E08 5.** `authorizeToolCall.approval` carries ids only. The host re-mints with `requestToolToken` (R4 codes).
- **C5 → E08 6.** Tokens are revoked at turn end, on every stop and on `endTask`.
- **E-P6 → X2.** The host catalog is a copy-check against the pinned E08 catalog: exact match, otherwise refuse. There is no `mutating` field.
- **Host audit → X1.** The host writes no audit. Its diagnostic log holds reason codes only. For refusals only the host can detect, E04 proposes **E-P8**: an optional `toolCallFinished.reason`.
- **Navigate.** K8 runs `checkPolicy` right before Explorer. With no K8, the result is a denial. The host also re-checks the lock itself.
