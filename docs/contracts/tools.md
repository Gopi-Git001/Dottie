# `dottie-tools` tool schemas (DRAFT for PR)

- Status: **Draft 5 by E04, 2026-10-19 ~01:55 CDT. E01 approves by PR** (CONTRACTS v2 §5). Reviewers: E11 (verification), E08 (policy: the `navigate` conditions, untrusted header, token handling), E03 (control channel).
- Normative parents:
  - CONTRACTS v2: §3 (`ApprovalRequested` categories incl. `navigate`, `CapabilityScope` incl. `files.navigate`), §3.2 (audit), §3.3 (`WindowIdentity`, canonicaliser, `purpose`), §5 (tool result, "E04 review" rulings), §2.5 (control channel: `docs/contracts/tool-host-control.md`, DOT-092 DRAFT 5 by E03 with E08's review; E04 positions in `tool-host-control.e04-host-positions.md`, E04 review in `tool-host-control.e04-review-draft5.md`);
  - ADR-0008 (host); ADR-0009 CR2/CR3/CR5/CR6, item 7, and item 8 with its **`navigate` exception, conditions 1–7**; ADR-0017 (recovery reuse, Proposed); TRIAGE P8/P9.
- **Where this file and CONTRACTS/ADR-0009 disagree, they win and this file is wrong.**
- Reference behaviour and tests: `packages/tools/` (`dottie_tools/reference/reference.py`, `dottie_tools/targets/`, `tests/`). Linux with Windows mocked, so they prove contract logic only.

## 1. Conventions (all tools)
- Tool id: `area.verb_object` (§5). `additionalProperties:false` everywhere.
- The public MCP `inputSchema` holds **only model-choosable arguments**. The host gets context and authorization over the coordinator control channel (§2.5/§5), never from model arguments.
- **Reserved model-argument names (decided E03 + E04, 2026-10-19):** a call with a top-level `taskId`, `turnId`, `threadId`, `hwnd` or `pid` is **rejected**, not stripped:
  - `INVALID_ARGUMENT`, `sideEffect:'none'`;
  - the reserved **key names** are logged (sorted), and **values never are**.
  The coordinator's `authorizeToolCall` and the tool host both enforce this, **before** the "no active turn" check (order of commit 16b3880): a reserved key with no active turn is `INVALID_ARGUMENT`. Any other unknown key is also `INVALID_ARGUMENT`.
- Result = MCP `structuredContent` `{verified, observedState, sideEffect, error?, evidenceRef?}`; `isError = !verified`; no `success` (§5).
- **Authorization codes (E01 ruling, 2026-10-19):**
  - `APPROVAL_REQUIRED` = grantable, but not yet approved;
  - `DENIED_BY_POLICY` = never grantable, **or** the required authorization (token/approval) is missing, invalid, expired, used or foreign.

## 2. `explorer.open_known_folder`
Show a Windows known folder in the user's File Explorer window, and verify that window shows it.

### 2.1 Input schema (JSON Schema 2020-12)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "dottie-tools/explorer.open_known_folder/input/1",
  "type": "object",
  "additionalProperties": false,
  "required": ["folder"],
  "properties": {
    "folder": {
      "type": "string",
      "enum": ["downloads", "documents", "desktop", "pictures", "music", "videos"],
      "description": "Known-folder id, resolved server-side with SHGetKnownFolderPath (FOLDERID_Downloads, _Documents, _Desktop, _Pictures, _Music, _Videos)."
    },
    "targetId": {
      "type": ["string", "null"],
      "pattern": "^c_[0-9a-f]{12}$",
      "description": "Optional opaque candidate id from observedState.candidates of an earlier AMBIGUOUS result in the same task. null = absent."
    }
  }
}
```
- The enum is exact and lower-case. **No path, subpath, `/select`, `shell:` URI, environment variable or verb** can be expressed (ADR-0009 navigate condition 2). Anything else → `INVALID_ARGUMENT`.
- A malformed `targetId` → `INVALID_ARGUMENT`. A well-formed one that doesn't resolve → `NOT_FOUND`.

### 2.2 Classification (ADR-0009 item 8, `navigate` exception; E08 co-signed, E01 2026-10-19)
| Field | Value |
|---|---|
| category | **`navigate`** (no-confirm). It is the only member today; membership is closed and needs E08 sign-off (condition 1) |
| scope | **`files.navigate`**, else `PERMISSION_REQUIRED` (condition 4) |
| severity | `low` |
| approval / K8 token | **none.** No dialog, no `ApprovalRequested`, no token is minted or consumed. But K8 is always involved (E08 12): P24 at `authorizeToolCall` **and** `checkPolicy{v, callId, toolId, category:'navigate'}` immediately before the Explorer call; Explorer runs only on the exact `{ok:true, data:{allowed:true}}` reply. A timeout (2 s), an error, any other shape, or no K8 wired → `DENIED_BY_POLICY`; `PERMISSION_REQUIRED` passes through. The host also re-checks the session lock itself (WTS) right before send |
| session gate | **denied when the desktop is locked, after panic-stop, or after mute** → `DENIED_BY_POLICY`, audit reasons `locked`, `panic_stop`, `mute` (condition 4). **Checked in `authorizeToolCall` with no token** (DOT-092 P24/P24a, agreed E03/E04; E08 pending Q-E08-8) and **fails closed**: gate state unreadable, malformed, stale (> 1000 ms, PROVISIONAL) or no K8 wired → `DENIED_BY_POLICY`, reason `gate_state_unavailable` (**proposal**, new §3.2 value). The host re-checks the gate it holds (unreadable → same denial) |
| folder gate | resolved server-side via `SHGetKnownFolderPath`, then followed through reparse points (`GetFinalPathNameByHandle`). **UNC/network** (including a mapped remote drive), a **reparse point outside the user profile**, or a **missing/unresolvable folder** → `DENIED_BY_POLICY`, audit reason `known_folder_redirected`, **never a confirm fallback**. OneDrive-backed local folders inside the profile are allowed (condition 3) |
| launch | Explorer gets a **fixed argv** `[%SystemRoot%\explorer.exe, <resolved folder>]` through CreateProcess. **Never a shell string**, never `/select`, `/e`, `/root` or verbs (condition 2) |
| chaining | **grants nothing**: a later action in the same window is classified on its own merits and needs its own approval/token if mutating. Not eligible for ADR-0017 reuse beyond its own window (condition 5) |
| audit | written **only by K8** (E08 X1): `category`, `folder` (the enum id) and `decision`. **No resolved path**, title or window identity (condition 6). The host writes no audit; its redacted diagnostic log holds reason codes and key names only. A host-detected refusal (e.g. `known_folder_redirected`) is reported to K8 via `toolCallFinished.reason` (**proposal E-P8**) |
| idempotent | yes |

**Pending E01/E08 detail:** §3.2 `AuditRecord` has no `folder` field yet, and no `kind`/`decision` value for an *allowed* no-confirm navigate (K8's records).

### 2.3 Target selection
1. **`targetId` present:** resolve it in the shared registry for the host-supplied `taskId`, then re-read the identity now. Unknown, cross-task, ended task, superseded, past the safety cap, closed, identity changed, or any field unreadable → `NOT_FOUND`. **Never a fallback** to another window or a new one.
   - **Lifetime (decision C3, E03/E04 2026-10-19):** valid across every turn of the same task (a clarification answer or a retry is a new turn of the same `taskId`) **until `endTask(taskId)`**. **Superseded is per window** (settled E03/E04, DOT-092 DRAFT 3 §4.2): when the **same window** (same 4-field identity) is re-registered under a new id in the same task, its old id → `NOT_FOUND`; other windows' ids are unaffected. The old 300 s TTL is replaced by a **30-min safety cap** (**proposal**, not ruled; guards a host that never receives `endTask`), which also reports `NOT_FOUND`.
2. **No `targetId`** (TRIAGE P9, DOT-031 AC):
   - foreground Explorer → that window;
   - else the single Explorer window → that window;
   - else none → launch exactly one (fixed argv; before/after diff);
   - else, with ≥2 and none in front: exactly one already showing the folder → `verified:true`, `sideEffect:'none'`, no action. Otherwise `AMBIGUOUS` + `question` + `candidates`, with no action.
   - A chosen window with no readable identity → `NOT_FOUND`. Unidentifiable windows are never offered.
3. Never by title. Only the **active tab** is navigated and observed.

### 2.4 Verification semantics
- **Expected:** `SHGetKnownFolderPath(FOLDERID_*)`, compared by final path (case, `\\?\`, 8.3, junctions, trailing `\`).
- **Observed:** the IShellWindows entry for the **target window's active tab**: `Document.Folder.Self.Path`. The UIA address bar is a fallback only; the title never counts (P8).
- **Verified** only when they're equal on **2 consecutive samples** (~200 ms apart) before the deadline (default 6 s), with the target's identity unchanged at every sample.
- **Pinned:** another window, or a background tab, showing the folder never counts, with or without `targetId`.
- **Checks:** `EXP-01` known folder resolved and allowed; `EXP-02` target identified/alive; `EXP-06` active tab equals expected; `EXP-08` exactly one new window.

### 2.5 Result examples
Verified:
```json
{"verified": true, "sideEffect": "committed",
 "observedState": {"outcome": "verified", "decision": "done",
                   "checks": {"EXP-01": "pass", "EXP-02": "pass", "EXP-06": "pass"}, "sideEffect": "committed"}}
```
Ask:
```json
{"verified": false, "sideEffect": "none",
 "observedState": {"outcome": "unverified", "decision": "ask_user", "checks": {"EXP-01": "pass", "EXP-02": "unknown"},
                   "sideEffect": "none", "question": "I see 2 File Explorer windows. Which one should I use?",
                   "candidates": [{"id": "c_3f9a1c0b7e21", "label": "File Explorer window 1"},
                                  {"id": "c_8d02e4aa5f10", "label": "File Explorer window 2"}]},
 "error": {"code": "AMBIGUOUS", "message": "several Explorer windows; none is in front", "retryable": false}}
```
`observedState` never holds titles, paths, hwnd/pid or identity. Full evidence goes in a local artifact (`evidenceRef`).

### 2.6 Error codes, in check order
| # | Code | When | `sideEffect` | `decision` |
|---|---|---|---|---|
| 1 | `INVALID_ARGUMENT` | a **reserved model arg** (checked first, even with no active turn; names logged, values never) | `none` | stop |
| 1b | `PRECONDITION_FAILED` | no host context: no active turn, stop requested, control channel down, or `authorizeToolCall` unanswered within 2 s (decision C1; tool-host-control §4.3/§2.4/§2.3.1) | `none` | stop |
| 1c | `DENIED_BY_POLICY` | `authorizeToolCall` P24 gate: locked / panic-stopped / muted, or gate state unavailable (`gate_state_unavailable`) | `none` | stop |
| 2 | `INVALID_ARGUMENT` | non-object args; a **reserved model arg** (`taskId`, `turnId`, `threadId`, `hwnd`, `pid`; names logged, values never); any other extra key (`select`, `verb`, `path`, …); non-enum or injected `folder`; malformed `targetId`; a non-canonical pinned identity on the internal API (§6) | `none` | stop |
| 3 | `PERMISSION_REQUIRED` | `files.navigate` not granted | `none` | stop |
| 4 | `DENIED_BY_POLICY` | host re-check: desktop locked / after panic-stop / after mute, or the host's copy of the gate state unreadable | `none` | stop |
| 5 | `DENIED_BY_POLICY` | folder is UNC/network, a reparse point outside the profile, or missing/unresolvable (`known_folder_redirected`) | `none` | stop |
| 6 | `NOT_FOUND` | lookup fails: well-formed `targetId` unknown/cross-task/ended task/superseded/past the 30-min cap/closed/identity changed/unreadable; chosen window has no identity | `none` | stop |
| 6b | `PRECONDITION_FAILED` | the chosen window is **not actionable** (CONTRACTS §5 fail-closed observations, E01): cloaked (`DWMWA_CLOAKED`), or the cloaked check failed. Re-checked right before dispatch (token not spent). With ≥2 windows, non-actionable ones are never offered; if none is left → this code | `none` | stop |
| 7 | `AMBIGUOUS` | ≥2 actionable windows, none in front, not exactly one already there | `none` | ask_user |
| 8 | `PRECONDITION_FAILED` | after lookup, **before send**: window gone, changed or unidentifiable (re-checked immediately before dispatch, RISKS R23) | `none` | stop |
| 9 | `POSTCONDITION_UNKNOWN` | **after send**: window gone, changed or unobservable; launched window not identifiable | `unknown` | stop |
| 10 | `POSTCONDITION_FAILED` | sent, but the active tab didn't show the folder by the deadline | `unknown` | stop |
| 11 | `CANCELLED` | task cancelled (`cancelToolCall`, or an approval/token revoked **because of** a task cancel, panic-stop or quit, C7). Cancellation points: before lookup, before consume, right before dispatch → `none` (phase `before_send`); at every verify sample → `unknown` (phase `after_send`) (DOT-092 §6.5) | `none` / `unknown` | stop |

- All of the above are `retryable:false`. Codes 1–8 change nothing.
- **DPI:** this tool uses no coordinates, so it never reads DPI. Any coordinate tool must: unreadable DPI **never falls back to 96** → `PRECONDITION_FAILED`, `sideEffect:'none'` (CONTRACTS §5; registry `to_physical`, §7).
- **`toolCallFinished`** (DOT-092 §4.6b, E-P5 proposal): sent once for every call that passed `authorizeToolCall`, with the furthest phase (`not_started` / `before_send` / `after_send` / `completed`) and the host's `sideEffect`. The phase flips to `after_send` immediately before the Win32/COM call, so a cancel racing the call reports `unknown`, never `none`.
- Row 1 replaces Draft 2's `INTERNAL` (decision C1).
- This tool never returns `APPROVAL_REQUIRED` or `USER_DECLINED`. Those apply to mutating tools (§4).
- Note for E11: verifier-design §15 lists "Known Folder resolves but doesn't exist → `NOT_FOUND`". For `navigate`, ADR-0009 condition 3 makes a missing folder `DENIED_BY_POLICY` (`known_folder_redirected`).

## 3. Untrusted content
Untrusted text (screen, web, file contents, command output, UIA names) **never** goes in `structuredContent`. It goes only in MCP `content` text blocks under the fixed header E08 defines (`<E08-UNTRUSTED-HEADER>`, a placeholder). It is data, never instructions, and never grants scope. There is no `untrusted_content` field (§5). This tool emits none.

## 4. Mutating desktop tools: approval round-trip and K8 token (ADR-0009 CR2/CR3/CR5/CR6, item 7; tool-host-control §4.4–§4.5)
Applies to every desktop tool whose category is not `read`/`navigate` (later tools: window, input, file mutations). The scratch exercises it with the same targeting code and `category="local_change"`.
1. **Preview** (no side effect): resolve args and target, then compute
   `actionId` = lowercase-hex SHA-256 of the §3.3 canonical JSON
   `{purpose:"dottie.actionId.v1", method, args (resolved), targets:{window: <§6 wire identity> | null}, taskId, threadId, turnId, itemId, requestId}`.
2. **In-call `requestApproval`** on the control channel with `{callId, actionId, binding, preview}`; the call waits for `ApprovalResolution`. With no control channel or coordinator → `APPROVAL_REQUIRED` with `observedState.actionId` (**proposal**), nothing sent.
3. The coordinator raises `ApprovalRequested`. **Only a `secure_ui` click** approves (CR3/CR5; voice/tray never do). K8 mints a token bound to **`taskId` + `toolId` + `actionId`** (decision C5; **not** `turnId`, since a retry gets a new turnId; the resolved window identity is inside `actionId`), **single use**, short TTL `min(approval expiry, mint + 10 s)` (P18, **proposal**).
4. `ApprovalResolution.decision` uses the CONTRACTS §3.2 enum (decision C6):

   | decision (reason) | tool code | sideEffect |
   |---|---|---|
   | `approved` | continue | — |
   | `declined` (`user_declined`) | `USER_DECLINED` | `none` |
   | `expired` (`timeout`) | `APPROVAL_REQUIRED` | `none` |
   | `revoked` (`mute`, `locked`, `app_server_restart`; task still live) | `APPROVAL_REQUIRED` | `none` |
   | `revoked` (`task_cancel`, `panic_stop`, `quit`: these cancel the task) or `cancelled` (`turn_ended`, `turn_interrupted`, `ipc_disconnect`, …) | **`CANCELLED`** (C7) | `none` |
   | `denied_by_policy` (`channel_not_allowed`, `wrong_action`, `task_mismatch`, `reused`, …) | `DENIED_BY_POLICY` | `none` |
   | any value outside the §3.2 enum, or `approved` without a token | `DENIED_BY_POLICY` (fail closed; audit `unknown_decision` / `missing`) | `none` |
   | no answer within approval expiry + 5 s (DOT-092 §2.3.1) | `APPROVAL_REQUIRED` if the turn is live, else `CANCELLED` | `none` |
5. Immediately before the Win32/COM call, the tool server:
   - re-reads the identity (changed → `PRECONDITION_FAILED`, token **not** spent);
   - recomputes `actionId` from what it is about to do;
   - consumes the token with K8 (`consumeToolToken`).

   The token is K8's `dottie.approvalToken.v1` (DOT-092 §5.3), wire form `k8t1.<tokenId>.<mac>` (P17 proposal). `endTask(taskId)` revokes the task's unconsumed tokens (not the end of a turn).
   Missing, unknown, used, revoked (incl. by `endTask`), expired, consume unanswered within 2 s, or foreign (task, tool or `actionId`, which covers a different window or args) → **`DENIED_BY_POLICY`**, audit `policy.denied` with reasons `missing`, `unknown_token`, `reused`, `expired`, `revoked`, `task_mismatch`, `tool_mismatch`, `wrong_action`. A token revoked **by a task cancel, panic-stop or quit** → `CANCELLED`, `sideEffect:'none'` (C7). Nothing is sent, and token values are never logged. K8 burns the token on any consume attempt.
6. **Turn change (E08 5/6, DOT-092 DRAFT 5 §4.5b/§5.5; replaces Draft 4's C5 text).** A token is revoked at turn end (`setActiveTurn(null)`), on every stop and on `endTask`. In a later turn, `authorizeToolCall` may return `approval: {actionId, binding ids}` (**no token**). The host recomputes `actionId` from those ids plus args and window re-resolved now, and calls `requestToolToken{v, callId, actionId}`. On `APPROVAL_REQUIRED` it makes a fresh approval; on `CANCELLED` the call ends there; on `DENIED_BY_POLICY` there is no fallback. A re-mint revokes the earlier unused token (audit reason `superseded`). Audit reasons for revoked tokens are the cause as-is: `superseded`, `turn_end`, `end_task`, `mute`, `locked`, … (E08, DRAFT 5.1). The model sees only the ToolError code. Tests TOK-09/09a–e, K-07b.
   Superseded Draft 4 text: **Turn change (C5).** If the coordinator re-issues an approved call in a later turn of the same task, it attaches the token **and the approved binding's ids** (`turnId`, `itemId`, `requestId`, `threadId`). The host re-resolves args and window now and recomputes `actionId` with those ids, so the token still matches. Without the approved ids the recomputed `actionId` differs (CR2 hashes `turnId`/`itemId`/`requestId`) → `DENIED_BY_POLICY`. A different task → `DENIED_BY_POLICY` (`task_mismatch`). Scratch tests TOK-09/09b/09c.

## 5. Approval binding for this tool
`navigate` has no approval, so it has no `actionId` dialog. The host still computes the same `actionId` for audit correlation (proposal).

## 6. `WindowIdentity` wire encoding (CONTRACTS §3.3)
| Field | Internal | Wire | Rules |
|---|---|---|---|
| `hwnd` | int | string | canonical unsigned decimal `^[1-9][0-9]*$`, ASCII, ≤ 2^64−1; `"0"` invalid; top-level (`GA_ROOT`) |
| `pid` | int | string | same form, ≤ 2^32−1; `"0"` invalid |
| `windowClass` | str | string | plain class name, exact case (`GetClassNameW`), **1–256 UTF-16 code units (E01 ruled, CONTRACTS §3.3; an emoji counts 2)**; empty, longer, or with lone surrogates → no identity |
| `processStartTime` | int | string | FILETIME of process creation (`GetProcessTimes`, `PROCESS_QUERY_LIMITED_INFORMATION`), 100-ns ticks since 1601-01-01 UTC; same decimal form, ≤ 2^64−1; `"0"` invalid; never a JSON number, never ISO-8601 |

- **Rejected for the three numeric fields:** JSON numbers, ISO strings, zero-padded values, `"0"`, signs, whitespace, hex, exponent or decimal point, empty strings, non-ASCII digits, out of range.
- **Exact shape:** the four keys and no others. Where an identity is *input* (the internal pinned API, control-channel messages), a parse failure → `INVALID_ARGUMENT`.
- **No partial identity:** if any field is unreadable, the window has no identity. It can't be offered, targeted (`NOT_FOUND`) or acted on.
- **Fields outside the identity also fail closed** (CONTRACTS §5, E01): a cloaked window or a failed cloaked check → not actionable → `PRECONDITION_FAILED`, `sideEffect:'none'`; unreadable DPI never falls back to 96 → `PRECONDITION_FAILED`, `sideEffect:'none'` for any action that needs coordinates.
- **Any-field mismatch** = closed.
- **Canonicaliser** (§3.3): keys sorted, UTF-8, no whitespace, every value a string (`null` for fields that don't apply, per CR2), non-string values and duplicate keys rejected, `purpose` key required. Values above 2^53 hash exactly.
- Identity never appears in `observedState`, messages or logs. Audit records use `targetHash`.

## 7. Shared registry interface (`packages/tools`, owner E04, reviewer E11)
Sketch in `packages/tools/src/dottie_tools/targets/window_registry.py`:
- **Identity type:**
  - `WindowIdentity(hwnd, pid, window_class, process_start_time)`;
  - `.to_wire()`/`.to_contract()`;
  - `WindowIdentity.from_wire()` raises `IdentityFormatError` (`INVALID_ARGUMENT`).
- **Reads (plain Win32, no COM, never raise):** `identify(reader, hwnd)`, `live_identities(reader)`, `liveness(reader, identity)` → `live | window_gone | identity_mismatch | no_identity`.
- **E11 protocol:** `WindowIdentityService(reader)` with `identify`, `is_alive`, `process_image_name`.
- **Actionability (CONTRACTS §5):** `actionability(reader, identity, needs_coordinates=False)` → `ACTIONABLE | CLOAKED | CLOAK_UNREADABLE | DPI_UNREADABLE` (never raises); `window_dpi(reader, identity)` → int in 24–2880 or `None` (never 96 as a fallback); `to_physical(reader, identity, x, y)` raises `NotActionable` (`PRECONDITION_FAILED`, `none`). Reader methods `is_cloaked(hwnd)`, `window_dpi(hwnd)`.
- **Candidate registry:** `WindowRegistry(ttl=1800)` (30-min safety cap, proposal), thread-safe, per-window supersede (§2.3), with `issue(ctx, [(identity, label)])`, `resolve(ctx, targetId, live=|reader=)` → `Resolution{identity, reason, error_code}`, and `end_task(taskId)` (control-channel `endTask`; alias `forget_task`).
- **Canonical JSON:** `canonical_json`, `parse_canonical`.
- **Context:** `HostContext(task_id, thread_id, turn_id, item_id?, request_id?)`, from the control channel only.

## 8. Change log
- Draft 1 (2026-10-19 ~00:55 CDT): first tool, error table, untrusted rule, approval/token binding, identity encoding.
- Draft 2 (2026-10-19 ~01:20 CDT):
  - category `navigate` (E08 co-signed) with conditions 1–7;
  - pid as a decimal string and zero invalid;
  - authorization-code definitions;
  - reserved model args rejected with names-only logging;
  - token binding to window + expiry;
  - canonicaliser `purpose`.
- Draft 3 (2026-10-19 ~01:15 CDT), decisions C1–C7 with E03 (tool-host-control.md §10):
  - C1 missing host context → `PRECONDITION_FAILED` (was `INTERNAL`);
  - C2 `pid` decimal string (already in Draft 2 §6; restated);
  - C3 `targetId` valid until `endTask`, superseded kept, 300 s TTL → 30-min safety cap (proposal);
  - C5 token bound to `taskId` + `toolId` + `actionId`, not `turnId`; 10 s TTL cap (proposal); in-call `requestApproval`;
  - C6 CONTRACTS §3.2 `decision` values; audit reasons renamed to §3.2/P19 spellings;
  - C7 cancel-caused revocation → `CANCELLED`, `sideEffect:'none'`.
- Draft 4 (2026-10-19 ~01:40 CDT), E01 rulings + DOT-092 DRAFT 3:
  - windowClass 1–256 chars ruled (E01); cloaked / unreadable cloaked check / unreadable DPI fail closed → `PRECONDITION_FAILED`, `none` (row 6b, §6, §7);
  - superseded is per window (§2.3);
  - P24 navigate gate in `authorizeToolCall` with no token, fail closed (`gate_state_unavailable`, proposal) (§2.2, rows 1c/4);
  - reserved keys checked before "no active turn" (row 1);
  - §2.3.1 timeouts; `panic_stop`/`quit` revocations → `CANCELLED`; non-§3.2 decision → `DENIED_BY_POLICY`; `endTask` revokes tokens; token purpose `dottie.approvalToken.v1` (§4);
  - `toolCallFinished` and §6.5 cancellation points (row 11).
- Draft 5 (2026-10-19 ~01:55 CDT), DOT-092 DRAFT 5 + E08 review:
  - token revoked at turn end; Option 1 re-mint via `requestToolToken` with R4 codes; `superseded`, `turn_end` and `end_task` reasons (§4);
  - `navigate`: second K8 `checkPolicy`; no K8 → denied; host lock re-check (§2.2);
  - the host writes no audit (X1) (§2.2);
  - windowClass length counted in UTF-16 code units (§6).
- 2026-10-19 ~03:30 CDT, E01 ruling 1y (CONTRACTS, dottie-e01 c0b36d4):
  - UI-action methods are exactly `ui.*` and `window.*`. Every `desktop.control` tool uses one of these prefixes, and no other tool may. `app.*` is display kind `tool`.
  - `catalog.prefix_rule_violations` enforces the rule both ways; the tests are in `test_catalog_prefix_rule.py`.
  - `catalog.display_shape` gives the display kind and keys K8 must build. Keys follow E02 895676d: no `detail`; `bodyUntrusted`; `paths` + `fileCount` for delete/overwrite.
  - E04 builds no display; K8 does (X5).
  - No catalog entry needed renaming.
- 2026-10-19 ~03:35 CDT, E01 ruling 1z (dottie-e01 492c01c):
  - The UI-action method must match exactly `^(ui|window)\.[a-z][a-z0-9_]*$`.
  - The pinned catalog is `packages/contracts/tool-catalog.json`.
  - The host takes a tool's scope from its pinned entry only, never from the category. A stated category that disagrees, or a missing/unreadable entry → `DENIED_BY_POLICY` with the existing CR5 reason `catalog_mismatch` (ruling 1z.1, dottie-e01 6800ad7; no new reasons, DOT-092 §5.7 unchanged), sideEffect `none`, before any approval or K8 call.
  - delete/overwrite displays always carry `paths[]` + `fileCount`.
  - **Runtime enforcement of the prefix rule is K8's (E08):** K8 refuses to register a breaking host tool, with a `policy.denied` audit. E04 keeps only the catalog-side test (`test_catalog_prefix_rule.py`).
- 2026-10-19 ~03:35 CDT, E01 ruling 1z.1: E04 creates `packages/contracts/tool-catalog.json`.
  - **E08 is the required reviewer; E01 approves the contract.**
  - It holds real entries only (today: `explorer.open_known_folder` / `navigate` / `files.navigate`); the host loads it as `CATALOG`.
  - Test-only catalogs live in `packages/tools/tests/fixtures/tool-catalog.test-only.json` (marked `_fixture`). A test checks that the pinned file holds no fixture entries or markers and passes the 1y/1z checks.
- 2026-10-19 ~03:35 CDT, E01 ruling 2a (dottie-e01 972d5f4; DOT-090 item 10, doc test K-12):
  - `packages/contracts/tool-catalog.json` is hash-pinned by `packages/contracts/tool-catalog.json.sha256`, in exact `sha256sum` format over the raw bytes.
  - It is checked by `packages/tools/tests/test_catalog_hash_pin.py` and by `sha256sum -c packages/contracts/tool-catalog.json.sha256` from the repo root.
  - CODEOWNERS for both files will be E08 + E01.
  - The test-only scope `app.control` (E01-proposed, pending E08 co-sign) appears only in test fixtures; no `app.*` tool is pinned.
- 2026-10-19 ~04:15 CDT, E01 ruling 2f (dottie-e01 9a49722):
  - `toolCallFinished.reason` is a closed enum: `known_folder_redirected | locked | schema_invalid | catalog_mismatch | precondition_failed`. The host never emits any other value; `reference.finished_reason` enforces it.
  - K8-originated reasons such as `display_unavailable`, `reused` and `schema_invalid` from a desktop answer are never forwarded; K8 is their source.
  - A late approve on an already-answered `actionId` → `reused`.
  - A malformed desktop `ApprovalResolved` → `DENIED_BY_POLICY{schema_invalid}`, with no token minted and nothing dispatched.
