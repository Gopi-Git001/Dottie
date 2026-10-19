# ADR-0017: Verifier recovery may reuse a desktop.control approval only through a single-use, window-bound recovery token

- Status: **Proposed (amends ADR-0009).** Date: 2026-10-19 (CDT). Id: ADR-0017 (renumbered from the draft id ADR-0009a by E01 on 2026-10-19, dottie-adr numbering). Deciders: E01 (decider of record), E08 (required approver), E11, E03. Spec: §9.7, §10, §11 ("Fallback … on uncertainty, stop or ask"), §14 release blockers.
- Resolves: BACKLOG DOT-074 (TRIAGE-2026-10-18 P12). Proposal agreed with E01 on 2026-10-19. ADR-0009's body is not changed by this file. E01 owns any wording that gets folded into ADR-0009.

## Context
- The verifier repairs failed postconditions with window actions targeted by HWND: restore (`ShowWindow(hwnd, SW_RESTORE)`, EXP-04), focus (`SetForegroundWindow(hwnd)`, EXP-07), and a recovery ladder that re-enumerates windows (`docs/verifier-design.md:19, 63-66, 136-143`).
- ADR-0009 requires approvals that are single-use, bound to the action hash, short-lived (60 s default; 120 s maximum per the E08 CRs accepted 2026-10-19), revocable and resolved only in the secure UI. So by default a recovery action is a new action and needs a new approval. Until a decision exists, the verifier default is **deny** (BACKLOG DOT-074 acceptance 3).
- DOT-074 asked whether restore, focus, move-to-monitor **and shell-navigate** can reuse an existing `desktop.control` approval for the same HWND within the same task.
- Windows reuses HWND and PID values after a window or process ends. The OS documents this; this ADR does not measure it (UNVERIFIED). The verifier itself notes that "the HWND may have been destroyed or recreated" (`docs/verifier-design.md:143`).

## Decision
1. **Scope.** A verifier recovery action may reuse an existing **executed and unexpired** `desktop.control` approval (E01 2026-10-19, DOT-092) **only** for these actions:
   - `restore` (un-minimize);
   - `focus` (bring to foreground, with no synthetic input);
   - `move_to_monitor`.
   Nothing else is covered.
2. **Explicitly not covered** (each needs its own approval under ADR-0009, or is denied). **Shell-navigate is on an explicit gate deny list** for recovery reuse (E01 2026-10-19): the gate rejects it by name: the tool error code is `DENIED_BY_POLICY` and the audit reason is `recovery_action_forbidden` (the deny list is checked before the allowlist, per E08's `docs/security/recovery-gate-requirements.md`), not merely because it is absent from the Decision 1 allowlist, and it has its own gate test (test 9). Not covered: typing, key presses, hotkeys, close, clipboard read or write, **shell-navigate**, any file change, launch or terminate, and UIA click or invoke.
   - **Why shell-navigate is excluded:** it changes the window's location or state. The window then shows a different folder, so later actions target different data. The original approval did not consent to that change.
3. **Recovery token.** A reuse is authorized only by a **single-use recovery token** minted by K8 (the policy gate):
   - `recoveryToken = HMAC-SHA-256(k8Key, parentActionId ‖ recoveryAction ‖ taskId ‖ windowIdentity ‖ nonce)`;
   - `k8Key` is a per-process random key held only by K8. It is never logged and never leaves the main process;
   - `nonce` is 128-bit random (base64url), and one token is minted per recovery attempt.
   - The MAC input encoding is fixed by CONTRACTS §3.3 and E08's `docs/security/recovery-gate-requirements.md` (sorted-key canonical UTF-8 JSON; `hwnd`, `pid`, `processStartTime` as unsigned decimal strings). It is the same canonicaliser as ADR-0009 CR2 `actionId`, with one test-vector suite. **Domain separation (E01 2026-10-19):** the MAC input carries `"purpose":"dottie.recoveryToken.v1"` (`actionId` uses `"dottie.actionId.v1"`), so a value computed for one purpose never verifies as the other. A missing or wrong `purpose` is rejected.
   - The token's `actionId` is a new id. Its `parentActionId` is the original approval's `actionId`.
   - **Mint source (E01 2026-10-19, DOT-092):** K8 mints a recovery token **only from an executed and unexpired approval** (doc `docs/contracts/tool-host-control.md` DRAFT 8 §5.2, approvals item 35 as amended by E01). Reason, reworded (E01 2026-10-19, DOT-092 ruling 5): recovery is allowed once K8 has recorded an **accepted consume** for an unexpired approval (state `executed`, including a consume that ended `consumed_not_dispatched` or `postcondition_unknown`). The approval was spent, so the window restore is legitimate even if dispatch did not complete. Never from a `pending`, approved-but-unconsumed, `expired` or `revoked` approval. It stays bound by the Decision 4 WindowIdentity check.
   - **Token type separation (E01 2026-10-19, DOT-092):** the recovery token's wire prefix is `k8r1.`; the CR6 approval token is `k8t1.` (purpose `dottie.approvalToken.v1`). The recovery gate rejects an approval token and `consumeToolToken` rejects a recovery token, both by purpose and by prefix (CONTRACTS §3.3, test K-05).
   - **Scope of the no-re-mint rule (E01 2026-10-19, DOT-092):** E08 R2's "an executed approval can never mint or re-mint again" applies to approval tokens (`dottie.approvalToken.v1`) only. Recovery tokens (`dottie.recoveryToken.v1`) follow this ADR.
4. **Binding.** The gate accepts a token only if **all** of these hold:
   - same `taskId` as the parent approval;
   - same resolved window identity `{hwnd, pid, windowClass, processStartTime}` as the parent action's target (re-resolved at use time, immediately before the action, not taken from the model); a mismatch on any field is a denied recovery (`identity_changed` / `window_mismatch`); if any identity field can't be read, the window has no identity and **no recovery runs**. `processStartTime` is the Windows FILETIME (100-ns ticks since 1601-01-01 UTC), serialized as a decimal string (CONTRACTS §3.3);
   - `recoveryAction` is on the Decision 1 list;
   - the token hasn't been used before (it is consumed before the action runs);
   - the time is **before the parent approval's expiry**. Default 60 s, hard maximum 120 s. A recovery token never extends the parent's expiry.
5. **Revocation.** All outstanding recovery tokens, and their parent approvals, are revoked immediately by:
   - panic-stop;
   - mute;
   - Quit;
   - cancelling the task;
   - the desktop being locked (no recovery runs while it is locked).
   A revoked or failed check means **deny**. The verifier then reports the postcondition as failed or unverified and never retries blindly (CONTRACTS §5 `retryable` rule).
6. **Enforcement in code, twice.** K8 mints and checks the token. The tool or verifier backend re-checks it before calling the Win32 API (ADR-0009 CR 6, TB7). A check that exists only in the prompt or model instructions counts as missing.
7. **Audit** (E01 2026-10-19, DOT-092 ruling 8). Each mint and each use attempt writes a `dottie.audit` record (CONTRACTS §3.2) through the shared redactor (`docs/security/redactor-design-draft.md`), kind `recovery_token.minted` (outcome `minted` | `refused`), `recovery_token.used` (`executed` | `postcondition_failed` | `postcondition_unknown`) or `recovery_token.rejected` (`denied`):
   - fields: `{actionId, parentActionId, recoveryAction, taskId, decision, reason?, targetHash, timestamp}`; `decision` per the CONTRACTS §3.2 rows: `approved` when allowed, `denied_by_policy` (or `expired` / `revoked`) when denied; never `mac` or `nonce`;
   - deny reasons: `window_mismatch | task_mismatch | expired | reused | not_covered | revoked | locked | identity_changed | recovery_action_forbidden`. `recovery_action_forbidden` is used when the explicit deny list fires; `not_covered` for any other action off the allowlist. The tool error code is always `DENIED_BY_POLICY` (rule: tool error codes UPPER_SNAKE; audit reasons and enum values lowercase snake_case);
   - no window titles, paths, hwnd/pid values or token values are logged; a hash of the window identity is logged instead.
8. **Window identity includes process start time (E01 signed off 2026-10-19).** HWND and PID values get reused, so the identity is `{hwnd, pid, windowClass, processStartTime}` (`processStartTime` from `GetProcessTimes` creation time). This is now the window identity everywhere (CONTRACTS §5, ADR-0009 CR2). Any change in any field between approval and recovery is a mismatch and is **denied**; for ordinary tool calls it counts as a closed window.

**Binding implementation input:** `docs/security/recovery-gate-requirements.md` (E08) for `packages/policy` (DOT-008): allowlist + explicit deny list order, HMAC input encoding, and required gate tests (`recovery_shell_navigate_denied_explicitly`, `recovery_hmac_filetime_encoding`, `recovery_identity_start_time_mismatch_denied`).

## Alternatives
- **Recovery always needs a fresh approval.** Rejected as the default for low-risk window actions: it would put up a dialog for every un-minimize or focus mid-task, and users would learn to click through dialogs. It stays the rule for everything outside Decision 1.
- **Reuse the parent approval directly, without a token.** Rejected: it isn't single-use, it can't be audited per use, and replay can't be detected.
- **Bind to HWND only (the DOT-074 wording).** Rejected because HWNDs get reused. The binding is extended to `{hwnd, pid, windowClass, processStartTime}` (Decision 8).
- **Include shell-navigate.** Rejected; see the reason in Decision 2.

## Consequences
- **Gate tests** (DOT-074 acceptance 2, extended; all must exist and pass before merge; box unit tests with a fake window provider, plus a Windows e2e run on Gopi's PC):
  1. a different window (other hwnd, or same hwnd with another pid or class) → denied;
  2. a different task → denied;
  3. the parent approval has expired (both the 60 s default and the 120 s cap) → denied;
  4. the token is reused (second use) → denied;
  5. an action that isn't covered (`type_text`, `press_key`/`hotkey`, `close_window`, clipboard, shell-navigate, any file change) → denied;
  6. PID reused with a new process creation time → denied;
  7. revocation: panic-stop, and likewise mute, Quit, task cancel and a locked desktop, all revoke a minted but unused token → denied;
  8. audit: each case writes one redacted record with the right `decision` and `reason`, and no raw identifiers.
  9. **shell-navigate (dedicated test):** a recovery request for shell-navigate, with an otherwise valid token (same task, same window identity, before expiry, unused) → denied (`DENIED_BY_POLICY`) by the explicit deny-list entry with audit reason `recovery_action_forbidden` (not `not_covered`), and stays denied when `shell_navigate` is temporarily added to the allowlist in the test (E08 test `recovery_shell_navigate_denied_explicitly`).
  10. an identity field that can't be read (e.g. `processStartTime` unavailable) → no recovery runs (denied, `identity_changed`).
- **Risk:** a stale-window race between the identity check and the Win32 call (time-of-check to time-of-use). Mitigation: re-verify the postcondition after acting (the verifier rule), and the actions are non-destructive. Also: identity re-check immediately before the action, the token consumed before the action runs, and `POSTCONDITION_UNKNOWN` when the result can't be observed. Recorded in RISKS.md R23 (owner E11).
- **Follow-ups:**
  - DOT-074 moves from "Blocked on E08 decision" to "ADR proposed".
  - Implementation goes in `packages/verifier` gate config plus the K8 token API (E11 + E08; depends on DOT-014).
  - Done by E01 2026-10-19: listed in the ARCHITECTURE.md §9 index; linked from ADR-0009's DOT-074 amendment section.
  - Done by E01 2026-10-19: CONTRACTS §3.2 `dottie.audit` gains `parentActionId?`, and §3.3 defines `RecoveryToken`.

## Changelog
- 2026-10-19: drafted by E08 as ADR-0009a.
- 2026-10-19: renumbered ADR-0017 by E01; window identity gains `processStartTime` (Decision 8 signed off); TOCTOU risk recorded as RISKS R23. Status stays Proposed.
- 2026-10-19: E01 follow-up: shell-navigate is an explicit gate deny-list entry with dedicated test 9; unreadable identity → no recovery (test 10); `processStartTime` encoding (FILETIME decimal string). References RISKS R23 and CONTRACTS §3.3 verified to exist.
- 2026-10-19: E01: linked E08's recovery-gate-requirements.md as binding input; shell-navigate deny reason is `RECOVERY_ACTION_FORBIDDEN` (superseded the same day by audit reason `recovery_action_forbidden`); MAC input encoding closed.
- 2026-10-19: E01: audit reason renamed `recovery_action_forbidden` (lowercase; tool code stays `DENIED_BY_POLICY`; `not_covered` for other off-allowlist actions); `purpose` key `dottie.recoveryToken.v1` added to the MAC input.
- 2026-10-19 (E01 2026-10-19, DOT-092): recovery token minted only from an "executed and unexpired approval" (replaces "still-valid"/live approval wording); allowed after `postcondition_unknown` or `consumed_not_dispatched`, bound by WindowIdentity; R2 no-re-mint applies to approval tokens only; `k8r1.`/`k8t1.` cross-rejection. Status stays Proposed.
- 2026-10-19 (E01 2026-10-19, DOT-092 ruling 5, 8): mint-source reason reworded (accepted consume on an unexpired approval; never from pending, approved-unconsumed, expired or revoked); Decision 7 audit uses the CONTRACTS §3.2 `recovery_token.*` kinds and decisions instead of `security.audit` `allowed|denied`.
