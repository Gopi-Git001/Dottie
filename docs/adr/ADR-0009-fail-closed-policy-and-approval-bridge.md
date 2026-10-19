# ADR-0009: Fail-closed, code-enforced policy; one approval UI for Codex and Dottie approvals

- Status: **Accepted 2026-10-19. E08 signed off CRs 1-6 and items 7-12 after re-reading the full ADR.** Date: 2026-10-18 (amended 2026-10-19). Deciders: E01, E08 (required approver), E03. Spec: §9.7, §10, §14 release blockers.

## Context
- Bot's flow fails open: any `speech_stopped` after an approval request approves (`src/Bot/voice_assistant.py:545-547`). Ungated mutating tools
  include `close_window`, `type_text`, `hotkey`, clipboard, `move_file` and overwrite paths (`registry.py`, `file_tools.py:547-625`).
- App Server sends server requests that need a client decision: `item/commandExecution/requestApproval` (decisions `accept | acceptForSession |
  acceptWithExecpolicyAmendment | applyNetworkPolicyAmendment | decline | cancel`), `item/fileChange/requestApproval` (`accept | acceptForSession | decline | cancel`),
  `item/permissions/requestApproval`, `mcpServer/elicitation/request`, `item/tool/requestUserInput` (schema 0.163.0 `ServerRequest.json`).

## Decision
- Default-deny scopes per spec §10 (`files.read`, `files.navigate` (added E01 2026-10-19 for category `navigate`), `files.write`, `shell.execute`, `desktop.control`, `browser.navigate`, `network.send`, `app.install`,
  `credentials.access`, `purchases`). Enforced in code at K8 and inside each tool server.
- Approvals are single-use, bound to the exact action hash (`actionId`, below), short-lived, revocable, and resolved **only in the secure
  renderer dialog** (voice and the tray never approve; they may only deny or cancel, spec §9.7, CR3). Silence, "no", noise and timeout all mean **deny**.
- An unknown server request method gets a JSON-RPC error and is logged. Nothing is approved implicitly.

### E08 co-sign changes (2026-10-19). CRs 1-6 block the build
1. **CR1, fail closed on every bridge failure.** Each of these resolves a pending approval as **decline** (Codex server requests: `decline`, or `cancel`
   when the turn itself is gone) and dismisses the dialog: silence, "no", noise, timeout, the dialog fails to render, renderer crash or reload,
   IPC disconnect, app-server restart, turn ended or interrupted (`serverRequest/resolved`, `turn/completed`), any exception, schema-validation failure
   or unexpected state in the bridge, K8 or the hash computation, app Quit, and the session locking while a dialog is pending. Anything not listed also
   resolves as decline.
2. **CR2, `actionId`.** `actionId = SHA-256(canonical JSON {method, args, targets, taskId, threadId, turnId, itemId, requestId})`, where
   `method` is the tool id or the server-request method, `args` are the **resolved absolute** arguments (paths resolved before hashing), and `targets`
   include the resolved window identity `{hwnd, pid, windowClass, processStartTime}` for desktop tools (E01 ruling for E04, CONTRACTS §5; `processStartTime` added 2026-10-19). A mismatch on any field means the window counts as closed. Fields that do not apply are
   `null`, never omitted. The dialog shows exactly the hashed fields, no more and no fewer. Any change to the args is a new action and needs a new approval (RB02-U2).
   Canonical JSON: keys sorted, UTF-8, no whitespace, every value a string; hwnd, pid and processStartTime are unsigned decimal strings; null for fields
   that don't apply; non-string or duplicate keys are rejected; actionId is lowercase hex. This is the same canonicaliser as the ADR-0017 token
   (docs/security/recovery-gate-requirements.md), with one test-vector suite.
   **Clarification (E01 2026-10-19):** "every value a string" applies to scalar leaves: every scalar leaf is a string or JSON `null` (only for fields that don't apply). Numbers and booleans in tool args are converted to their canonical string form before hashing (`true`/`false`, decimal with no leading zeros or exponent). Nested objects and arrays are allowed: object keys are sorted recursively and array order is preserved.
   **Domain separation (E01 2026-10-19):** the canonical object carries a `purpose` key: `"dottie.actionId.v1"` for `actionId` and
   `"dottie.recoveryToken.v1"` for the ADR-0017 token, so a hash or MAC computed for one purpose can never be valid for the other. A missing or wrong `purpose` is rejected.
3. **CR3, channel.** Every non-`read` category in CONTRACTS §3 is approved **only by a click in `secure_ui`**. Voice and tray can never approve one
   (they may only deny or cancel). Today `packages/coordinator/src/ports.ts:126` types `ApprovalChannel` as `secure_ui | tray | voice`; DOT-087 removes that.
   Dottie's own windows (approval dialog, tray, settings) are never a target of desktop.control, UIA or synthetic input; the tool server refuses them by
   process identity. Approve accepts only trusted user input (isTrusted; injected input ignored), only after the dialog has been visible and focused for
   >= 500 ms, and Approve is never the default button (Enter does not approve).
4. **CR4, no standing grants in V1.** Dottie never offers or sends `acceptForSession`, `acceptWithExecpolicyAmendment` or `applyNetworkPolicyAmendment`,
   even when the request carries `proposedExecpolicyAmendment` / `proposedNetworkPolicyAmendments`. A `fileChange` request with `grantRoot` is declined.
   Any auto-approval or standing grant needs its own ADR (spec §10).
   item/permissions/requestApproval grants nothing in V1 (empty grant); a future grant needs its own ADR.
5. **CR5, what approves.** Only `ApprovalResolved{approved:true}` from `secure_ui`, for the **live** `actionId`, within its time limit, approves.
   Everything else denies: unknown, reused or expired ids; a yes before the request exists; a yes for another action; any free text; model-set flags
   such as `overwrite=true`; and the Codex `reason` text.
6. **CR6, tool-server re-check.** A mutating tool call must carry a single-use token issued by K8 and bound to the `actionId`; the tool server
   verifies it and otherwise returns `DENIED_BY_POLICY` (TB7). Depends on ADR-0008 (tool host). Token minimum: HMAC from a K8-only key, bound to
   actionId and taskId, expires no later than the approval, consumed before the side effect, revoked by item 7, never logged, and never carried in
   model-visible tool arguments (the tool server gets it over a K8 channel; Codex can't see or forge it).
7. **Time limits and revocation.** Default time limit 60 s, hard maximum 120 s. Panic-stop, mute, Quit, task cancel, a locked session and an app-server
   restart revoke every pending approval. Revoking after execution is reported as **executed** (audit outcome `already_executed`), not undone.
8. **Always-confirm categories** (CONTRACTS §3 `category`): `local_change`, `delete`, `overwrite`, `external_send`, `external_upload`, `purchase`,
   `install_or_elevate`, `security_setting`. **Overwrite counts as destructive** (same handling as `delete`). `credential_access` is `DENIED_BY_POLICY` with
   no dialog. Only `read` inside granted scope, and the `navigate` exception below, run without a dialog.
   **Exception: category `navigate` (no-confirm, E08 co-signed, E01 2026-10-19). Binding conditions:
   1. Closed membership: a tool joins only with E08 sign-off, and only if it has enum-only args, writes nothing, launches nothing but the fixed shell
      viewer, and sends nothing. The only member today is `explorer.open_known_folder`.
   2. The arg is `folder` (the frozen name; E08's review called it `folderId`): an enum of the 6 known-folder ids, resolved server-side via
      `SHGetKnownFolderPath`. No path, subpath, `/select` or shell verbs. Explorer gets a fixed argv, never a shell string.
   3. A UNC or network path, a reparse point outside the profile, or a missing folder → `DENIED_BY_POLICY` with audit reason `known_folder_redirected`,
      and never falls back to a confirm. OneDrive-backed local folders are OK.
   4. It requires scope `files.navigate`, and is denied when the desktop is locked or after panic-stop or mute.
   5. It grants nothing for chaining; later actions are classified on their own merits; it is not eligible for ADR-0017 reuse beyond its own window.
   6. The audit record holds `category`, `folder` and `decision`, with no resolved path.
   7. Tests (DOT-031): non-enum folder rejected; path or `/select` injection rejected; UNC-redirected Downloads denied; locked desktop denied; no path in audit.
9. **External content is data.** Webpages, documents, command output, MCP elicitation text and the Codex `reason` field are shown in the dialog
   labelled **untrusted** and never grant or widen scope. Elicitation URL mode never opens a URL.
10. **Codex settings floor.** `approvalPolicy` is never `never`; `sandbox` is never `danger-full-access`.
11. **Audit.** Every request, resolution, expiry and revocation writes `{actionId, argsHash, category, risk, decision, channel, requestedAt, expiresAt, resolvedAt}`
    through the redactor (CONTRACTS §3.2 `dottie.audit` v1), with no arguments or contents. `decision` = `approved | declined | cancelled |
    denied_by_policy | expired | revoked`; the cause goes in `reason` and the Codex-facing answer in `wireReply` (CONTRACTS §3.2).
12. **Locked desktop.** While the Windows session is locked, deny everything and show no dialog (RB05-I1).

## Alternatives
- **Voice "yes" approves low-risk non-read actions.** Rejected: spec §9.7 says voice identity is not enough; a TV, a recording or a misheard word could approve (Bot's fail-open bug, `voice_assistant.py:545-547`).
- **Session grants (`acceptForSession`, policy amendments) on explicit user choice.** Rejected for V1 (CR4): they are standing grants, and the ADR's own rule is that auto-approval needs its own ADR.
- **Approval bound to the tool name only, or to the summary text.** Rejected: allows replay against other args or another window (CR2).
- **Trust the policy gate only, no tool-server re-check.** Rejected: a bug or a bypass in K8 would reach the OS directly (CR6, TB7).

## Tests (gate for DOT-014 / DOT-090)
- **RB02-U1:** every failure in CR1 (silence, no, noise, timeout, render failure, renderer crash/reload, IPC disconnect, app-server restart, turn end/interrupt) → decline/cancel and the dialog is dismissed.
- **RB02-U2:** changing any hashed field (one arg, a resolved path, the window identity, taskId/turnId/itemId/requestId) changes `actionId`; the old approval does not apply.
- **RB02-U3:** write/copy/move/rename onto an existing path is classed overwrite, so approval is required.
- **A9-U3:** an unknown, reused or expired id, a yes before the request, a yes for another action, free text, `overwrite=true` from the model, and the Codex `reason` text each → deny; `tray`/`voice` approval of a non-read category → deny.
- **A9-I1:** amendment proposals are answered only accept|decline|cancel, acceptForSession is never sent, fileChange grantRoot gets decline, and a permissions request gets an empty grant.
- **A9-I2:** a mutating call with a missing, foreign-actionId, other-task, expired or used K8 token gets DENIED_BY_POLICY, and the token never appears in tool args or logs.
- **A9-I3:** panic-stop, mute, Quit, task cancel, lock and app-server restart each revoke all pending approvals (decision:revoked), and a revoke after execution reports already_executed.
- **A9-I4:** a locked desktop denies with no dialog, credential_access gets DENIED_BY_POLICY with no dialog, and audit records hold no args or contents.
- **A9-I5:** a bridge or K8 exception gets decline, an unknown server method gets -32601, elicitation URL mode opens nothing, approvalPolicy:never and danger-full-access are refused, and a synthetic click or Enter on Approve, or an Approve from a Dottie desktop tool, gives no approval.
- **Release blockers:** `docs/qa/release-blockers.md` RB02-I1, RB02-I2, RB02-I3 and RB02-I4 are also required, verbatim as written there (delete "no" keeps the file; duplicate delete after one ambiguous utterance not executed; prompt-injection document causes no deletion; model `overwrite=true` without approval refused).

## Consequences
The approval UI must handle `serverRequest/resolved` (the request was cleared by turn end or interrupt) to dismiss stale dialogs.
Bridge failures (CR1) are dismiss-and-deny paths too. DOT-087 (channel type), DOT-090 (fail-closed + actionId tests, A9-I1..I5) and DOT-014 implement this ADR.

## Clarification: possible-repeat retries (D14) (E01 2026-10-19, D14 rulings); E08 co-signed 2026-10-19
Status stays **Accepted**; E08 confirmed 2026-10-19. This clarifies CR2/CR3 for user retries after a possible side effect; it adds no new approval channel.
- A user retry (voice or tray, `UtteranceReady.retryOfTaskId`) of a task whose ledger was `committed`, `possible` or `unknown` (or that the coordinator has no record of → `unknown`) is a new task that **forces a pre-dispatch approval**, even if policy would otherwise need none. It is approvable only via `secure_ui`; its category is never `read` or `navigate` (E01 2026-10-19, ruling 1j) (the prior task's last approval-creating category, skipping `navigate` and `read` (E01 2026-10-19, ruling 1f), else `local_change` with risk `high`). Only prior side effects in categories other than `read` and `navigate` count toward the repeat trigger: a prior task whose effects were only `read` or `navigate` gets no `possibleRepeat` and no forced approval (E01 2026-10-19, ruling 1f).
- **Preimage (CR2):** the pre-dispatch `actionId` args are `{summary, risk, category, possibleRepeat, retryOfTaskId}`. `possibleRepeat` is the `priorSideEffect` value (`committed` | `possible` | `unknown`) or `null`; `retryOfTaskId` is the prior `taskId` or `null`. Both come only from the coordinator's or K8's own state, never from host, model or Codex input. `summary` stays labelled untrusted (X5).
- The dialog renders the warning only from the approval record: "This action already happened; approving will do it again." (`committed`) or "This action may already have happened." (`possible`/`unknown`), before Approve is enabled.
- **Required tests:** changing `possibleRepeat` or `retryOfTaskId` between display and approval invalidates the approval. A `possibleRepeat` or `retryOfTaskId` value supplied in model, Codex or tool-host input is ignored: stripped, audited, and never used to set, change or suppress the warning or the approval. A repeat the coordinator derives from its own ledger (DOT-094), including one the model started, still forces the `secure_ui` approval with the warning. (E01 2026-10-19, ruling 1g; E08 wording) Required tests: (1) an injected `possibleRepeat` or `retryOfTaskId` has no effect on the dialog and writes the strip audit; (2) a model-started action that matches a `committed` or `possible` ledger entry still gets the forced approval and warning. The strip audit record (kind `input.field_stripped`, CONTRACTS §3.2 (E01 2026-10-19, ruling 1h)) carries only the field name, the source channel (`sourceChannel`) (E01 2026-10-19, ruling 1i) and the reason, never the injected value. The `retryOfTaskId` = `priorTaskId` coordinator invariant is enforced before `ApprovalRequested` is emitted (E01 2026-10-19, ruling 1f).
- Normative detail: CONTRACTS §2.1 (pre-dispatch preimage), §3 (`UtteranceReady`, `ApprovalRequested.possibleRepeat`), §5 (D14).

## Amendment: bound approval display (X5) (E01 2026-10-19, ruling 1k; E08 co-signed)
Status stays **Accepted**. CR2 is extended: the approval dialog shows only a display object (`ApprovalDisplay`) built by K8 (tool-host approvals) or the coordinator (pre-dispatch confirmations) from validated args or coordinator state, never from model text. Its SHA-256 (`displayHash`) joins both `actionId` preimages, so every displayed field is bound to the approval. Rendering is plain text with control and bidi-override characters stripped, fixed maximum lengths and an untrusted-content label on model or web free text. The redactor runs on every field; the audit stores `displayHash` only. A category whose display can't be computed is `denied_by_policy{display_unavailable}`, with no generic fallback. Duplicate requests for the same `actionId` join one dialog; one answer mints at most one token. Normative detail: CONTRACTS §3 (`ApprovalRequested`, bound display), §2.1, §3.2. Ticket: DOT-095.
- Clarification (E01 2026-10-19, ruling 1t; E08 co-signed 2026-10-19): the stripping above now applies only to untrusted free text; bound fields render control, bidi and invisible characters as visible highlighted escapes with a hidden-characters badge (CONTRACTS L230-231).
- **E08 co-sign conditions** (E01 2026-10-19, ruling 1l; E08 confirmed 2026-10-19):
  1. One approval allows one execution. Later consumes on the same `actionId` get `tool_token.rejected{duplicate_request}` and never run.
  2. A join never extends `expiresAt` or the Approve-enable timer. A join after resolution or expiry never reopens the dialog and gets no token.
  3. `displayHash` guard: it is `null` only for calls with no dialog; a mismatch either way (dialog category with `null`, no-dialog call with a value) gives `denied_by_policy{display_unavailable}`.
  4. Approve is enabled only after 500 ms of continuous visibility and focus; losing focus resets the timer.
- **CR2 clarification** (E01 2026-10-19, ruling 1q; adds an equality check only, E08 re-sign not needed): CR2's top-level `displayHash` is authoritative for every call: the hash when a dialog is shown, `null` when there's no dialog. Pre-dispatch calls also keep `displayHash` inside `args` (the six-key binding is unchanged), and the two values must be byte-equal; `computeActionId` refuses (fails closed) on a mismatch. Generic gated calls never put `displayHash` in `args`. Required vectors (E02, DOT-090 item 12): pre-dispatch with matching values; pre-dispatch with mismatched values refused; generic with top level only.
- **Codex-sourced approvals** (E01 2026-10-19, ruling 1o; E08 co-signed 2026-10-19): only the dialog's first request (its own JSON-RPC `requestId`) can ever receive `approved`; every joined Codex request gets `declined` whenever it joins and whatever the answer, with a warning log without field values and an audit record with `joinedTo`; it never replays and the copy never says the user declined; each `requestId` is answered exactly once. Tool-host calls keep `tool_token.rejected{duplicate_request}`. Codex approvals always carry a coordinator-built display from validated adapter params (command line shown in full, cwd, network flag, escalation highlighted; full paths and count), never shortened with an ellipsis (8 KB / 500-path hard limit → `display_unavailable`); Codex `reason` text only in the untrusted slot. Required tests: two joined Codex requests + Approve → one approved, one declined, one execution.
- **Clarifications** (E01 2026-10-19, ruling 1l; E08 confirmed 2026-10-19): free text appears only in an untrusted-labelled slot, never as the title or a structured bound field; every dialog category has a display rule (`credential_access` has none and is always denied); the pre-dispatch confirmation has its own coordinator-built display (`category`, `risk`, `possibleRepeat`, `retryOfTaskId`, labelled `summary`); `security_setting` redacts only secret-shaped values.

## Amendment: DOT-074 recovery reuse
See **[ADR-0017](ADR-0017-recovery-approval-reuse.md)** (Proposed; E08 author). In short: the default stays deny; only restore, focus and move-to-monitor, same task and same window identity, before expiry, with a single-use K8 recovery token derived from the original `actionId`. ADR-0017 is the normative text.

## Changelog
- 2026-10-18: Proposed (E01).
- 2026-10-19: E08 co-sign changes applied by E01 (CRs 1-6, items 7-13; DOT-074 amendment points to ADR-0017; window identity includes `processStartTime`). Status stays Proposed until E08 re-reviews.
- 2026-10-19: E08 re-verification fixes 1-8 applied by E01 (CR1 catch-all, CR2 canonical JSON + `purpose` domain separation, Dottie-window and trusted-input rules under CR3, empty permissions grant, CR6 token minimum, item 7 revocation list, item 11 fields and decision enum, tests RB02-U1..U3 / A9-U3 / A9-I1..I5 + RB02-I1..I4). Status stays Proposed.
- 2026-10-19: E01: no-confirm category `navigate` (E08 co-signed) added as an explicit exception to item 8, with binding conditions 1-7; scope `files.navigate` added.
- 2026-10-19: **Accepted.** E08 signed off on CRs 1-6 and items 7-12. L16 reworded per E08 follow-up 1. Follow-ups 2, 3 and 5 are in DOT-090; follow-up 4 is in DOT-092.
- 2026-10-19 (E01 2026-10-19, D14 rulings): clarification for D14 possible-repeat retries (forced `secure_ui` pre-dispatch approval, never `read`; preimage args gain `possibleRepeat` and `retryOfTaskId` from coordinator/K8 state only; warning rendered from the approval record). Status stays Accepted. E08 confirmed and co-signed 2026-10-19.
- 2026-10-19 (E01 2026-10-19, ruling 1f): D14 clarification aligned with ruling 1f (category skips `navigate`/`read`; trigger ignores `read`/`navigate`-only prior effects; never set from Codex/model input; DOT-094 may flag model-originated dispatches; coordinator invariant). Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1g): required-test wording replaced with E08's text (injected values ignored, stripped, audited; ledger-derived repeats incl. model-started force `secure_ui` + warning; strip audit carries field name, source channel, reason only). Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1h): strip audit record named `input.field_stripped` (CONTRACTS §3.2). Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1i): strip audit names the source channel as `sourceChannel` (CONTRACTS §3.2), not `channel`. Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1j): D14 clarification: repeat category never `read` or `navigate` (wording aligned). Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1k; E08 co-signed): amendment for the bound approval display (X5) and approval join; `displayHash` added to the CR2 preimage. Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1l; E08 confirmed 2026-10-19): X5/join amendment co-signed by E08 2026-10-19 (conditions 1–4 included). Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1o; E08 co-signed 2026-10-19): 1o co-signed by E08 2026-10-19 (Codex join first-request-only; full-text display). Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1q; adds an equality check only, E08 re-sign not needed): CR2 clarification: top-level `displayHash` authoritative; pre-dispatch `args.displayHash` must be byte-equal (`computeActionId` refuses on mismatch); generic calls never put it in `args`. Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1r; E08 co-signed 2026-10-19): 1r co-signed by E08 2026-10-19 (incl. kind/source guard). `ApprovalDisplay` is a discriminated union on `kind`; `requestSource` (coordinator-set) joins the CR2 preimage next to `displayHash` (CONTRACTS §3). Status stays Accepted.
- 2026-10-19 (E01 2026-10-19, ruling 1t; E08 co-signed 2026-10-19): 1t co-signed by E08 2026-10-19 (visible escapes, display-only CRLF normalisation). Status stays Accepted.
