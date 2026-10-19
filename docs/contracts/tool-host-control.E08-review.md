# E08 review: DOT-092 tool-host control channel, DRAFT 3 (token + pipe parts)

- Reviewer: E08 Platform/Security (required reviewer, ADR-0009 CR6). Date: 2026-10-19 (CDT). Reviewed: `docs/contracts/tool-host-control.md` DRAFT 3 (§2.2, §2.3.1, §4.0, §4.3–§4.6, §5, §6.2, §8.3) against ADR-0009 (Accepted 2026-10-19), ADR-0017, CONTRACTS §3.2/§3.3, `arch/security/recovery-gate-requirements.md` and `arch/security/redactor-design-draft.md`. Method: skills `dottie-policy-gate-review` and `e08-security-threat-model-tb1-tb9` (TB4, TB7, TB9).
- Scope calibration: personal single-user PC (Q1). A same-user process with code execution already defeats most local controls. The pipe controls below aim to stop accidental or opportunistic cross-talk, squatting and impersonation by *other* processes. They do not claim to stop malware running as Gopi.
- This file does not edit the doc or the request. Wording below is what E03/E04 should paste in. Anything that changes CONTRACTS or an ADR goes to E01.

## Overall verdict: **ACCEPT WITH CHANGES**
- **Blocks DOT-090 (A9-I2):** items 2, 4/5, 6, 10, 11 and extra findings X3, X4, X5.
- **Blocks DOT-031** (first tool `explorer.open_known_folder`, category `navigate`): items 1 (option B only), 12 and extra findings X1, X2.
- Items 3, 7, 8 and 9 are accepted. They must be implemented as written here, but they don't hold up either ticket's design.

---

## Per-decision answers

### 1. Pipe peer authentication without a handshake secret (§2.2, Q-E08-1): **CHANGE** (no secret needed, subject to these changes)
Reason: the draft already has `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS`, max one instance, squat → don't start + audit, and a two-way check including start time. That is the right shape.
- I accept E04's argument that a random name or secret has no clean carrier: the env needs a Codex pass-through (UNVERIFIED), `config.toml` and argv are persisted, and Codex controls the final spawn, so handle inheritance can't be relied on. **No handshake secret.**
- Three weaknesses remain:
  - **DACL scope.** A DACL on the user SID admits every logon session of that user.
  - **Ancestry is spoofable.** Parent PIDs can be spoofed (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`), and PIDs get reused.
  - **The client can be impersonated** by a squatting server.

Replace the §2.2 option (B) DACL cell and the peer-check list with:
> DACL: one ACE granting `GENERIC_READ|GENERIC_WRITE` to the **logon SID** of Electron main's token (no Everyone, Authenticated Users, `NETWORK`, Users, or bare user-SID grant); owner = the user; mandatory label Medium (no-write-up). `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS`, `nMaxInstances = 1`.
> Server-side peer check (main), all must pass:
> 1. `GetNamedPipeClientProcessId` → PID, plus `GetProcessTimes` start time.
> 2. The client is a member of the Job object Electron main created for the `codex app-server` child (`IsProcessInJob(client, dottieJob)`; the job is created before the spawn, and descendants inherit it). This replaces the parent-chain walk, which may remain as an extra check.
> 3. The image path is the installed tool-host executable, and its SHA-256 (or Authenticode signer once signing exists) matches the value pinned at build time (same rule as the app-server binary, TB4).
> 4. The client token's user SID and logon SID equal main's.
> Client-side check (host): `GetNamedPipeServerProcessId` → the server image is the Dottie main executable with a matching start time, and the host opens the pipe with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`, so a squatting server can't impersonate it.
> A refused peer is disconnected and audited (`toolhost.peer_rejected`). A refused peer never counts as "the one live connection".

- UNVERIFIED (W1-S2/DOT-005): whether Codex runs the MCP child under a restricted or AppContainer token or a Low integrity level. If it does, the logon-SID ACE and the Medium label must be re-checked on Gopi's PC before H-13 can pass.

### 2. CR6 "the tool server verifies it" via a `consumeToolToken` round-trip (§4.5, Q-E08-2): **ACCEPT WITH CHANGES**
Reason: with `k8Key` kept in main, the host's independent check has to be recomputing `actionId` from what it is about to execute, and the draft does exactly that (§4.5 order: identity re-read → recompute → consume → send).
- That satisfies CR6 as long as K8 compares that value with **the binding K8 itself stored at mint**, never with anything Codex or the model supplied.
- The draft doesn't yet say what happens to a malformed or late reply, or that state is checked at consume time.

Add to §4.5:
> K8 accepts the consume only if all of these hold:
> - the `actionId` the host recomputed equals the `actionId` in K8's own token record (which K8 recomputed from `binding` at approval time, §4.4);
> - `taskId` and `toolId` match;
> - the token is unexpired and unrevoked;
> - **at consume time** the task is live, no stop has been requested, the session is unlocked, Dottie is not muted, and there was no panic-stop.
>
> Compare-and-burn is atomic: the record is marked used synchronously, before any `await`, also on mismatch.
> The host dispatches **only** on an exact `{ok:true, data:{consumed:true}}` response to its own request `id`. Any other shape, an unknown key, an error, a closed channel or a late reply means deny (`DENIED_BY_POLICY`, `sideEffect:'none'`).
> No `actionId`, token or approval id is ever taken from MCP args, `_meta` or Codex.

### 3. Minter (§5.2, Q-E08-3): **ACCEPT, K8 in main mints directly; no broker**
Reason: a broker would add one more trusted component and one more key holder for no gain. The coordinator only relays.
Replace "minted by the coordinator **or** an E08-owned broker is open" with:
> Minted only by the K8 module in Electron main (E08-owned), which is the only holder of `k8Key`. The coordinator relays the opaque token and never logs, stores, or forwards it to the renderer.

### 4. Binding `taskId + toolId + actionId` (§5.3, Q-E08-5): **ACCEPT** the token binding. Purpose `dottie.approvalToken.v1`, wire form `k8t1.<tokenId>.<mac>`, no `turnId` in the **token** record.
Reason: `turnId` stays in the `actionId` preimage (CR2), so the token is still bound to the turn through `actionId`. Repeating `toolId` gives K8 a cheap early reject. Constant-time MAC check, as already written.

### 5. C5 vs CR2 (§5.3, Q-E08-7): **Option 1 ACCEPTED WITH CHANGES; Option 2 REJECTED**
Reason for rejecting Option 2:
- Dropping `turnId` (and `itemId`/`requestId`) from CR2 widens cross-turn replay and weakens per-call uniqueness.
- The draft names no hard technical reason that Option 1 can't solve. Option 1 keeps CR2 intact.

Option 1 is acceptable only if the approval stays single-use and nothing speculative is minted. Replace the Option 1 bullet with:
> **Option 1 (chosen).** When the coordinator's K8 approval record for this `taskId` + `toolId` is live (within its 60 s/120 s limit), **not yet executed**, and the task has no stop requested, `authorizeToolCall` may return `approval: {actionId, binding:{threadId, turnId, itemId, requestId}}`. The response carries the approved ids **only, with no token**.
> - The host recomputes `actionId` from those ids plus its freshly resolved args and window identity, then calls a new `requestToolToken{callId, actionId}`.
> - K8 mints a fresh token only if that `actionId` equals the live approval's `actionId`.
> - If more than one live approval exists for the same `taskId` + `toolId`, `authorizeToolCall` returns no `approval` (fail closed to a fresh approval).
> - The approval becomes **executed** on the first successful consume and can never mint again. ADR-0017 recovery reuse keys off that executed approval until its expiry.
> - Each re-mint writes `tool_token.minted` with `reason:'remint'`.
> - The ids come only from K8's record, never from the host cache, `setActiveTurn`, or the MCP request.

D6 changes accordingly: `approval?: {actionId, binding}` (no token), plus a new `requestToolToken` method (§4.7).

### 6. TTL, single use and revocation (§5.4–§5.5, Q-E08-4): **ACCEPT** TTL and burn-on-any-attempt; **CHANGE** the revocation list
- **Correcting our starting position:** ADR-0009 item 7 doesn't list turn end, and CR1's turn-end rule covers **pending** approvals, which §4.4 already handles (`cancelled`/`turn_ended`). So "REJECT because item 7 requires it" was too strong. The real reason to revoke a minted **token** at turn end is different. Option 1 (item 5) now provides the legitimate cross-turn path through a re-mint. A token that survives a turn boundary therefore adds exposure and buys nothing. Interrupts are cancels anyway.

Replace the §5.5 revocation bullet with:
> A minted, unconsumed token is revoked by:
> - `setActiveTurn(null)`, i.e. turn end or interrupt, and every stop request;
> - `endTask(taskId)`;
> - task cancel, panic-stop, mute, Quit, a locked session and app-server restart (ADR-0009 item 7);
> - IPC disconnect (CR1);
> - main-process restart (`k8Key` regenerated).
>
> Cross-turn continuity exists **only** through an Option 1 re-mint from the live, unexecuted approval.
> `expiresAt = min(approval.expiresAt, mintTime + 10 s)`. A token never extends the approval. Burned on any consume attempt, including a mismatch. At most one live token per approval.

The tests must change to match:
- **K-03:** replace "A token is not revoked by the end of a turn and is accepted in a later turn …" with "a token is revoked at turn end; a later turn of the same task obtains a fresh token only through the Option 1 re-mint, and only while the approval is live and unexecuted."
- **H-14:** reword to "the call succeeds in a later turn via re-mint with the approved ids; the old token is rejected (`revoked`)."

### 7. Key rotation (§5.8, P20): **ACCEPT WITH CHANGES**
Replace §5.8 with:
> `k8Key` is 256 bits from the OS CSPRNG (`crypto.randomBytes(32)`). It is generated once per main-process launch, held only in K8's module scope, never persisted, logged, sent over any IPC or included in crash dumps, and regenerated on every restart, which invalidates all approval and recovery tokens. One key serves both token types, separated by `purpose` (`dottie.approvalToken.v1` / `dottie.recoveryToken.v1`). No in-process rotation in V1.

### 8. Storage (§5.6, Q-E08-5): **ACCEPT WITH CHANGES**
Append to §5.6:
> - The token never crosses the renderer IPC (CONTRACTS §4) and is never in model-visible args, results, `_meta`, `structuredContent` or events.
> - K8 keeps `k8Key` and the MACs as `Buffer`s and `fill(0)` them after use where the runtime allows. This is best effort: JS strings can't be wiped, so the token string is dropped immediately after consume.
> - The host drops its reference right after `consumeToolToken`, on `cancelToolCall`, and on `endTask`.
> - Main and host crash dumps exclude the heap (minidump without full memory) and pass through the redactor (DOT-091 item 5).

### 9. Audit (§5.7, Q-E08-6): **ACCEPT WITH CHANGES**
- Kinds are dotted identifiers. `decision`/`reason`/`outcome` values are lowercase snake_case (E01 casing ruling). ToolError codes stay UPPER_SNAKE.

Replace P19 with:
> New `kind`s:
> - `tool_token.minted` (outcome `minted` | `refused`);
> - `tool_token.consumed` (outcome `consumed`);
> - `tool_token.rejected` (outcome `denied`);
> - `toolhost.peer_rejected` (outcome `denied`);
> - `toolhost.pipe_squatted` (outcome `refused_start`).
>
> Fields: `{actionId, taskId, toolId, decision, reason?, targetHash?}`. **Never** the token string, `tokenId`, `mac`, `nonce` or args.
> Reasons:
> - token rejects: `reused | expired | revoked | wrong_action | task_mismatch | tool_mismatch | unknown_token | missing | malformed | locked | mute | panic_stop | task_cancel`;
> - mint: `remint`;
> - pipe: `not_in_job | image_mismatch | start_time_mismatch | sid_mismatch | second_connection | name_exists`.
>
> Records are written **only by K8 in main** through the shared redactor (see X1).
> Redactor additions:
> - sensitive keys `token`, `toolToken`, `approvalToken`, `tokenId`, `mac`, `nonce`;
> - value pattern `\bk8[tr]1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b` → `[REDACTED]`;
> - tests: a canary token in every sink gives 0 hits (C-16), and a near-miss such as `k8t1` alone is kept.

### 10. Fail-closed timeouts (§2.3.1): **ACCEPT WITH CHANGES**
Add to the `consumeToolToken` row:
> On timeout the host never retries with the same token and never dispatches. If K8's reply arrives late, the host ignores it, and K8 records `tool_token.consumed` with `outcome:'consumed_not_dispatched'`. The host still sends `toolCallFinished{phase:'before_send', sideEffect:'none'}`.

### 11. Cancel-caused revocation → `CANCELLED` (§4.4–§4.5, C7): **ACCEPT**
Reason: truthful cancel reporting (spec §14).
- The audit `decision` stays `revoked`, with `reason` `task_cancel` / `panic_stop` / `quit`.
- The tool must not execute, and `sideEffect` is `'none'` before send.
- Add to §4.5: "`CANCELLED` from K8 is final for that call: the host doesn't retry and doesn't request a new approval."

### 12. `navigate` (§4.0, Q-E08-8): **CHANGE**
- **Does `navigate` need a CR6 token?** No approval token, because nothing is approved (ADR-0009 item 8 exception). But "no approval" must not mean "no K8 involvement".
- **Who enforces the conditions?** K8, centrally, at authorize **and** again right before send, with the host checking the session lock and the enum itself as defence in depth. Authorize-time alone (P24) leaves a gap: mute or lock can happen between authorize and send.
- **Meaning of the conditions:** "after mute" = **while muted**, until the user unmutes. "After panic-stop" = for the **rest of that task**; the task is cancelled anyway, and a new task after the user resumes is unaffected.

Replace the §4.0 "Open" paragraph with:
> `navigate` calls carry no approval token. Each call needs two K8 policy checks:
> 1. P24 at `authorizeToolCall`: tool in the E08-signed `navigate` membership list (X2), scope `files.navigate` granted, session unlocked, not muted, no panic-stop in this task;
> 2. `checkPolicy{v, callId, toolId, category:'navigate'}` immediately before the Explorer call (2 s timeout → `DENIED_BY_POLICY`).
>
> Failures → `DENIED_BY_POLICY` (audit `policy.denied`, reason `locked` | `mute` | `panic_stop` | `known_folder_redirected` | `not_navigate_member`), or `PERMISSION_REQUIRED` when the scope is missing.
> Independently, the host refuses when `WTSQuerySessionInformation` reports the session locked, and it validates the `folder` enum and the `SHGetKnownFolderPath` result itself (ADR-0009 item 8 conditions 2–3).
> "Muted" means while muted. "Panic-stop" means for the rest of that task.

Add tests:
- **C-18b:** mute arrives between authorize and send → `DENIED_BY_POLICY`, Explorer not called.
- **H-19:** host lock check refuses even when the fake K8 says yes.

---

## Extra findings (things that weaken ADR-0009/0017 if left as is)
- **X1 (blocks DOT-031; corrected 2026-10-19, see Re-check (e): this line previously said DOT-031/090, which contradicted the verdict list above). The host must not write audit.** §4.5 says "the host writes `policy.denied` …". The host is a separate process, and CONTRACTS §3.2 allows audit only through the shared redactor in main. Change to: "K8 writes the audit record for every verdict it gives. The host writes no audit. Its diagnostics go to the redacted diagnostic log and contain no args, tokens or paths."
- **X2 (blocks DOT-031). Categories must not come from the host.** `hello.catalog` lets the host declare each tool's `category`. A buggy or compromised host could declare a mutating tool `read` or `navigate` and skip approval. That breaks the ADR-0009 item 8 rule that `navigate` membership is closed, with E08 sign-off. Change §4.0 to: "The authoritative catalog (`toolId → category, scope`) is pinned in `packages/contracts` and reviewed by E08. `hello.catalog` must equal it exactly. Any difference refuses the host (`PRECONDITION_FAILED` for every call, plus an audit record). A tool missing from the pinned catalog is needs-confirm and mutating." Also fix H-12, which still mentions a `mutating` field that E-P6 removed.
- **X3 (blocks DOT-090). Idempotent `authorizeToolCall` cache.** §6.2 says the cached answer is "the same answer as the first (cached for the turn)". A cached `ok:true` must never be replayed after a stop request, `setActiveTurn(null)`, lock or mute. Change to: "The cache is cleared on every `setActiveTurn` and on any stop. A repeat after that is re-evaluated (normally `PRECONDITION_FAILED`)."
- **X4 (blocks DOT-090). Approval vs recovery-token interplay.** Define the approval states in §5.2: `pending → approved → executed` (on the first successful consume), or `expired` / `revoked`.
  - An approval token can be minted only in `approved`.
  - An ADR-0017 recovery token can be minted only from `executed` (or `approved`) and before expiry, and only for restore, focus or move-to-monitor.
  - `consumeToolToken` must reject a recovery token, and the recovery gate must reject an approval token, both by purpose and by prefix (`k8r1.` vs `k8t1.`). Add test K-05 for both directions.
  - `navigate` calls never create an approval, so they never parent a recovery token beyond their own window (item 8 condition 5).
- **X5 (blocks DOT-090). The dialog text must come from the binding.** `preview.summary` is host-written free text, but CR2 requires the dialog to show exactly the hashed fields. Change §4.4: "The secure UI renders the action from `binding` (method, resolved args, target) using templates in main. `preview.summary` is advisory and shown only under the untrusted label together with `preview.untrusted`. K8 rejects a `requestApproval` whose `category` or `risk` differs from the pinned catalog (X2)."
- **X6. Don't log `modelArgs`.** §4.3 sends `modelArgs` to the coordinator. State explicitly: "`modelArgs` and resolved args are never logged or persisted; only key names and `argsHash`."
- **X7. Fallback path.** The §4.4 fallback returns `observedState.actionId` plus the preview. The preview must follow CONTRACTS §5: no full user paths and no window titles in `observedState`.

## Test changes summary
Update K-03, H-12 and H-14 as above. Add C-18b, H-19, K-05, and three K8 tests:
- **K-06:** consume-time state check (locked, mute, panic-stop, stop requested → deny);
- **K-07:** malformed or late consume reply never dispatches;
- **K-08:** pipe peer refused when the client is not in the job, has a different image hash, has a different logon SID, or opens a second connection. This is Windows-only and runs on Gopi's PC, extending H-13.

---

## Re-check of DRAFT 4 (E08, 2026-10-19 ~01:55 CDT)
Checked: `tool-host-control.md` DRAFT 4 (729 lines), every `[E08 n]` / `[E08 Xn]` label, the §10.2 mapping table and §8 tests, against this review, ADR-0009 and CONTRACTS §3.2 (`AuditRecord`, outcome table). The draft was read only, not edited.

### DOT-090 blockers
| Item | Landed in | Result | Notes |
|---|---|---|---|
| 2 CR6 round-trip | §4.5 (E08 wording verbatim), verdict table, D7, D11; H-07, K-06, K-07 | **PASS** | Compare-and-burn is synchronous; exact-reply rule; consume-time state check; no ids from MCP/Codex. `gate_state_unavailable` is missing from the verdict table → fix R3. |
| 4 Binding | §5.3 | **PASS** | K-02 also rejects a record containing `turnId`. |
| 5 Option 1 | §4.3 `approval?` (ids only), §4.5b, §5.3 (verbatim), D6, D9; C-21, H-14 | **PASS** | Needs the re-mint codes (Q-E08-9 (d2)), plus one clarification: a re-mint supersedes, and revokes, any earlier unconsumed token of the same approval, so that "one live token" can't deadlock. |
| 6 Revocation | §4.1, §4.2, §5.5 (verbatim, including our correction), §2.4, D12; K-03, H-14, C-22 | **PASS** | |
| 10 Timeouts | §2.3.1 consume row, §4.6b, §5.7, D5; H-20, K-07 | **PASS, wording superseded** | The text is ours, but it lets K8 infer "not dispatched" and doesn't cover a host crash. Replace it with the Q-E08-9 (c) wording (fix R2). |
| 11 Cancel → CANCELLED | §4.5 (verbatim), verdict table, D3; H-07, H-08b | **PASS** | |
| X3 Authorize cache | §4.3, §4.1, §6.2 (verbatim), D12; C-20 | **PASS** | Non-blocking note N2: §6.2 also claims "never replayed after … lock or mute", but nothing pushes lock or mute to the host. Lock and mute are actually enforced at consume (K-06) and in `checkPolicy`. Either reword the sentence to say so, or keep no coordinator-side `ok:true` cache. |
| X4 Approval states | §5.2 (verbatim), §4.0, §4.4, D3; K-05 | **PASS** | `executed` as a K8-internal state, not a §3.2 decision: E08 agrees. |
| X5 Dialog from binding | §4.4 (verbatim), `preview.summary` comment, D2; C-23 | **PASS** | The rejection reason changes to `catalog_mismatch` (Q-E08-9 (d4)). |

### DOT-031 blockers
| Item | Landed in | Result | Notes |
|---|---|---|---|
| 1 Pipe | §2.2 (verbatim), squat audit, reasons, UNVERIFIED note; H-13, K-08 | **PASS (design)** | Non-blocking N1: H-13 still says "non-descendant" and "Dottie-main ancestor". Reword it to Job membership and the pinned image hash, to match K-08. |
| 12 `navigate` | §4.0 (verbatim), §4.3 check 3, §4.5c, §2.3.1 row, D8, D10; C-18a–i incl. C-18b, H-18, H-19 | **FAIL, one loophole** | §4.5c re-runs only the P24 conditions (membership, scope, lock, mute, panic-stop). It never checks that a turn is live, that no stop was requested, or that this `callId` was authorized. A plain task cancel (not a panic-stop) between authorize and send would still get `allowed:true`. Fix R1. |
| X1 Host writes no audit | §4.5 (verbatim), §2.2, §4.5c; H-21 | **PASS** | |
| X2 Pinned catalog | §4.0 (verbatim), type comments, D13; H-12 (fixed), C-18i, C-19 | **PASS** | The audit kind for a mismatch is settled in Q-E08-9 (d1). |

### Accepted items
| Item | Landed in | Result |
|---|---|---|
| 3 Minter | §5.2 (verbatim) | **PASS** |
| 7 Key | §5.8 (verbatim); K-09 | **PASS** |
| 8 Storage | §5.6 (verbatim); H-11, C-16 | **PASS** |
| 9 Audit | §5.7 (verbatim), §2.2; K-04, C-16 | **PASS**, with field fixes in Q-E08-9 (d3). |

### Tests
- K-03 has been rewritten, with our wording quoted. ✔
- H-14 has been reworded. ✔
- K-05, K-06, K-07, K-08, C-18b and H-19 all exist. ✔
- Also new and consistent: C-19 to C-23, H-20, H-21 and K-09.
- K-04 ("one record per … consume") and K-07 / H-20 ("late accept is recorded `consumed_not_dispatched`") must change with fix R2.

### Q-E08-9 answers
**(a) P24a gate state: ACCEPT WITH CHANGES.** Our starting position holds. The draft already has the 1000 ms limit, missing or future `observedAt`, no K8 → deny, and tests C-18e/f/g. It lacks three things: the monotonic clock, "no cached allow", and the reason in the token and policy lists. Append to §4.0 (P24a bullet) and D8:
> `observedAt` and `now` are both read from the same monotonic clock in main (`performance.now()` / `process.hrtime.bigint()`), never from wall-clock time, so a clock change, DST shift or NTP step can neither freshen nor stale a snapshot. There is no fallback to a last-known-good or cached allow: every check reads `gateState()` anew. The rule applies at all three reads (P24 at authorize, `checkPolicy`, consume-time / re-mint). The result is `DENIED_BY_POLICY`, reason `gate_state_unavailable`, on `policy.denied` for `navigate` and on `tool_token.rejected` / `tool_token.minted{outcome:'refused'}` for tokens.

Add `gate_state_unavailable` to the §4.5 verdict-table `DENIED_BY_POLICY` row and to the §5.7 token-reject reasons. Extend C-18f: "a wall-clock jump of ±1 h with a fresh monotonic `observedAt` does not deny, and a stale monotonic `observedAt` denies even if the wall clock moved back." Add K-06b: "consume and re-mint with the gate state unreadable, stale or unwired → deny, `gate_state_unavailable`, token burned."

**(b) `consumed_not_dispatched`: ACCEPT.** `tool_token.consumed` outcomes are `consumed | consumed_not_dispatched | postcondition_unknown`; see (c) for the third. All lowercase. To E01 via Q-E01-13. There is precedent: `recovery_token.used` already has `postcondition_unknown`.

**(c) How K8 learns a consume wasn't dispatched: CHANGE.** K8 can't observe dispatch. Inferring "late" or "not dispatched" fails if the host crashes or disconnects after an accepted consume. So K8 must be fail-safe, and only an explicit host report may lower the audit outcome. No new message is needed: `toolCallFinished` is the explicit report, which keeps the surface smaller than a dedicated `notDispatched`. Replace the §2.3.1 consume-row sentence "If K8's reply arrives late, … `consumed_not_dispatched`" and the §4.6b sentence "K8 uses a `before_send` report …" with:
> Once K8 accepts a consume (answers `consumed:true`), the approval is `executed` and can never mint or re-mint again, whatever happens next: a host timeout, a late reply, a crash, a disconnect or a lying report. At acceptance K8 writes `tool_token.consumed` with `outcome:'postcondition_unknown'`. It writes a second `tool_token.consumed` record for the same `actionId` only on an explicit `toolCallFinished` for that `callId`:
> - `phase` ∈ {`not_started`, `before_send`} with `sideEffect:'none'` → `outcome:'consumed_not_dispatched'`;
> - `phase` ∈ {`after_send`, `completed`} → `outcome:'consumed'`.
>
> No report before IPC disconnect, `endTask` or main shutdown → the outcome stays `postcondition_unknown` (on disconnect K8 adds `reason:'ipc_disconnect'`), and the call counts as `possible` in the ledger (P21, §2.4). It is never recorded as not dispatched. An outcome never moves down after `consumed`: P21 never-downgrade applies to these records too. The host's report changes only the audit and ledger wording, never K8's authority state.

Tests:
- **K-07** becomes: "an accepted consume followed by (i) `toolCallFinished{before_send,none}` → second record `consumed_not_dispatched`; (ii) `{after_send}` → `consumed`; (iii) disconnect with no report → only `postcondition_unknown` + `ipc_disconnect`. In all three the approval is `executed` and `requestToolToken` is refused."
- **K-04:** "one or two records per accepted consume, as above."
- **H-20:** delete "the late reply ignored" as an audit claim. Keep: no retry, no dispatch, `toolCallFinished{before_send, none}` sent.
- D5 changes accordingly.

**(d) Gap-fill proposals**
1. **Catalog-mismatch audit kind: ACCEPT `toolhost.peer_rejected`** (outcome `denied`) with **reason `catalog_mismatch`**. A host whose catalog differs is a peer that is refused, so no new kind is needed. Add `catalog_mismatch` to the §5.7 pipe reason list. The record carries no catalog contents. The differing `toolId`s may go to the redacted diagnostic log only.
2. **`requestToolToken` failure codes: CHANGE (specify them).** Add to §4.5b:
   > K8's `ok:false` codes:
   > - `APPROVAL_REQUIRED` when there is no reusable approval but the action is still grantable (`wrong_action`, `task_mismatch`, `tool_mismatch`, `expired`, `reused` = already executed, `revoked` by `mute` / `locked` / `app_server_restart`). The host then makes a fresh `requestApproval`.
   > - `CANCELLED`, final, for `task_cancel`, `panic_stop`, `quit` or a stop requested.
   > - `DENIED_BY_POLICY` when no `approval` was offered to this `callId` by `authorizeToolCall` in the current live turn (`missing`), on a malformed request, with no K8 wired, or on `gate_state_unavailable`.
   >
   > Each refusal writes `tool_token.minted{outcome:'refused', reason}`. A successful re-mint revokes any earlier unconsumed token of the same approval (`tool_token.rejected` is not written; the revoked token's later use gives `revoked`).

   The 2 s timeout row in §2.3.1 is accepted as written. The fallback to a fresh approval is safe because nothing is dispatched.
3. **Null ids on `toolhost.*` kinds: CHANGE.** CONTRACTS §3.2 types `actionId?`, `taskId?` as **optional** strings (omitted when not applicable, like `env.scrub`). CR2's "null, never omitted" rule covers the hash preimage, not audit records. Replace §5.7's last bullet with: "The `toolhost.*` kinds **omit** `actionId`, `taskId` and `toolId`; they are never `null`." Also, §3.2 `AuditRecord` has **no `toolId` field** today. E01 must add `toolId?: string` (Q-E01-13) or the `tool_token.*` field list can't be written.
4. **X5 rejection reason: CHANGE `wrong_action` → `catalog_mismatch`.** `wrong_action` already means "recomputed `actionId` ≠ binding" (CR5 row), and reusing it would hide which check fired. `decision:'denied_by_policy'`, `reason:'catalog_mismatch'`, the ToolError stays `DENIED_BY_POLICY`. Add `catalog_mismatch` to the §3.2 CR5/policy reason row (E01, Q-E01-13), and update C-23 to assert the reason.

**(e) X1 scope: confirmed, DOT-031 only.** Our verdict list already said so. The X1 line in the extra findings said "DOT-031/090", which was inconsistent; it is now corrected in this file and marked. §10.2 in the draft already shows DOT-031 and can drop its parenthetical "(E08 text says DOT-031/090)".

### Remaining fixes (paste verbatim; E08 spot-checks, no new review round)
- **R1 (DOT-031), `checkPolicy` liveness.** Append to §4.5c:
  > K8 answers `allowed:true` only if the `callId` passed `authorizeToolCall` as a `navigate` call **in the current live turn**, the `toolId` matches that authorization, and no stop has been requested since. Otherwise:
  > - a stop requested or a cancelled task → `CANCELLED`, final;
  > - no live turn / an unknown or foreign `callId` → `PRECONDITION_FAILED`;
  > - `sideEffect:'none'` in both cases, and Explorer is not called.

  Add test **C-18j:** a task cancel (not a panic-stop) between authorize and `checkPolicy` → `CANCELLED`, and an unknown `callId` → `PRECONDITION_FAILED`; Explorer is not called in either case.
- **R2 (DOT-090):** the Q-E08-9 (c) wording in §2.3.1, §4.6b, §5.7, D5, K-04, K-07 and H-20.
- **R3 (DOT-031 + DOT-090):** the Q-E08-9 (a) wording in §4.0, D8, the §4.5 table and the §5.7 reasons, plus C-18f and K-06b.
- **R4 (DOT-031 + DOT-090):** the Q-E08-9 (d) changes: `catalog_mismatch` for X2 and X5, the re-mint codes, omitted (not null) ids, and the `toolId?` field to E01.
- **Non-blocking:** N1 (H-13 wording), N2 (§6.2 lock/mute sentence).

### Open PC-run items (don't block design sign-off; they gate H-13 and DOT-031 completion)
- **K-08 and H-13** run on Gopi's PC.
- Is the MCP child run with a restricted or AppContainer token or Low integrity (W1-S2/DOT-005)? If so, the logon-SID ACE and the Medium label must be re-checked first.

### Final verdict on DRAFT 4
- **DOT-090: SIGNED OFF (design), conditional on R2, R3 and R4 landing verbatim.** Everything else E08 required for DOT-090 landed faithfully.
- **DOT-031: SIGNED OFF (design), conditional on R1, R3 and R4 landing verbatim.** R1 closes the one new loophole found (`checkPolicy` not tied to a live, authorized call). Completion is also gated on the open PC-run items above.
- CONTRACTS changes stay with E01 (Q-E01-13). On top of the draft's list, E01 needs `toolId?` on `AuditRecord`, the reasons `catalog_mismatch` and `gate_state_unavailable`, and the `tool_token.consumed` outcomes `consumed | consumed_not_dispatched | postcondition_unknown`.
