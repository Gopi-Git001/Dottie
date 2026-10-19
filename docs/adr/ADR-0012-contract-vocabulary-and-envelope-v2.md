# ADR-0012: One shared contract vocabulary and one event envelope (contract v2)

- Status: **Accepted 2026-10-19 (E01, sole integrator of shared interfaces, spec §7).** Callers have not migrated yet. Migration tickets: DOT-060…DOT-065.
- Date: 2026-10-19 (CDT). Deciders: E01. Consulted: E02, E03, E06, E11 (proposals), E04 (tools plan). Spec: §4, §7, §9.9, §10, §14.

## Context
Several modules were built in parallel on 2026-10-18, before `packages/contracts` existed, and each spells the same concepts differently. All sources below were re-read on 2026-10-19:
- Envelope. CONTRACTS v1 §3 proposed `{v,type,eventId,correlationId,ts,source}` and nothing implements it. `packages/coordinator/src/contracts.ts:169-184` uses
  `{schema:'dottie.event',version:1,type,eventId,correlationId,causationId?,taskId?,timestamp,payload}`, and `validateEvent()` (`:247-272`) enforces it, rejecting unknown versions.
  `apps/desktop/src/shared/contracts.draft.ts:113-121` uses `{schemaVersion,eventId,correlationId,emittedAt,type,payload}` (marked DRAFT_PENDING_E01).
- AuthState. CONTRACTS §2 has `signedIn…`. `packages/coordinator/src/ports.ts:33` has `authenticated|signed_out|expired|unknown`. `apps/desktop/src/shared/states.ts:46` has `unknown|signed_in|signed_out|expired|unavailable`.
  `unavailable` is used when the adapter or runtime isn't present (`apps/desktop/src/main/services/stubs.ts:12-27`).
- Coordinator gate. `packages/coordinator/src/coordinator.ts:136` blocks only `signed_out|expired`, so `unknown` is **admitted**. `safeAuthState()` returns `unknown` whenever the auth read throws (`:713-719`).
  That is a fail-open deviation from ADR-0010 ("admitted only if signedIn").
- Risk. CONTRACTS has `low|sensitive|destructive|external|financial`. The coordinator (`contracts.ts:35`) and desktop (`contracts.draft.ts:62`) have `low|medium|high|critical`. The E04 plan has RiskClass `read|reversible|sensitive|forbidden` (`e04-tools-plan.md:178`).
- endReason. CONTRACTS has camelCase. The coordinator (`contracts.ts:38`) has `vad_silence|timeout|max_duration|user_stop`. Desktop has `silence|timeout|max_length|user_stop|error`.
- outcome. The coordinator has 7 values (`contracts.ts:45-53`, where `partial` = "failed after some side effects were committed"). Desktop has 3. The verifier has `verified|partially_verified|unverified|failed`
  (`packages/verifier/dottie_verifier/model.py:33-37`). E11 P1 asks for `unverified` and a precise `partial` (`docs/verifier-contract-proposal.md`).
- stopStatus. The coordinator has 5 values (`contracts.ts:59-65`). Desktop has `stopped_before_effects|stopped_after_partial_effects|stop_unconfirmed|no_task` (`services/types.ts:66`). CONTRACTS has `stoppedConfirmed…ttsOnly`.
- ToolResult. In the coordinator, `observedState` and `error` are strings (`contracts.ts:117-125`). CONTRACTS §5 makes them objects. E04 error codes `PERMISSION_REQUIRED/APPROVAL_REQUIRED` vs CONTRACTS `DENIED_BY_POLICY/NEEDS_APPROVAL`.
  SideEffect: E04 has `none|attempted|committed|unknown`, the coordinator has `none|committed|unknown`.
- workspaceScope. The coordinator has `{scopes, paths}` and desktop has `{scopes, folders}`.
- Codex distinguishes plan limits from rate limits: `UsageLimitReached|QuotaExceeded|UsageNotIncluded → UsageLimitExceeded` and `RateLimitExceeded → RateLimitExceeded`
  (V-src `codex-rs/protocol/src/error.rs:491-494`, clone main @ 8c07694). Codex's own test marks `RateLimitExceeded("retry later")` retryable (`protocol/src/error_tests.rs:45-46`).
  Meanwhile `packages/coordinator/src/retry.ts:22` retries `rate_limited` and has no plan-limit kind.

## Decision
1. **Casing rule.** Field names are camelCase (spec §7 field names are fixed). Event types are PascalCase. Coordinator states are UPPER_SNAKE. **Every Dottie enum value is snake_case.**
   Codex wire values (`inProgress`, `readOnly`, …) never leave the E02 adapter. This rule picks the side that already has tested code (coordinator 41 tests, desktop 186) over the unimplemented CONTRACTS v1 draft.
2. **Envelope = the coordinator's**, with version bumped to 2:
   `{schema:'dottie.event', version:2, type, eventId, correlationId, causationId?, taskId?, timestamp, payload}`.
   - `timestamp` is ISO-8601 with an offset.
   - `version: 1` events are rejected, not coerced. This makes un-migrated producers fail loudly.
   - CONTRACTS-v1 `source` is **not** adopted, because the IPC channel already identifies the producer.
   - Desktop changes `schemaVersion` to `schema`+`version` and `emittedAt` to `timestamp`, and adds `causationId?` and `taskId?`.
   - Why the coordinator's version: it is implemented, validated and tested. It separates the envelope from the payload, so `WakeDetected.timestamp` doesn't collide with envelope time. It also carries the `taskId` routing that `ApprovalResolved` needs.
3. **AuthState** = `unknown | unavailable | signed_out | signing_in | signed_in | expired | unsupported`.
   - `unavailable` is kept. It means the runtime or adapter can't be reached: app-server not started, crashed, or breaker open. This differs from `unknown`, which means not read yet or read in flight. The UI copy and the recovery action differ.
   - Network offline is **not** an AuthState. It stays in desktop `NetworkStatus`.
   - **Gate (ADR-0010):** a task is admitted only when the state is `signed_in` from a fresh `account/read`. Every other value blocks, including `unknown` and `unavailable`.
4. **Approval risk = severity + category.**
   - `ApprovalRequested.risk` (the spec field) ∈ `low | medium | high | critical`.
   - EXTENSION, required in v2: `category` ∈ `read | navigate | local_change | delete | overwrite | external_send | external_upload | purchase | install_or_elevate | security_setting | credential_access`.
   - Policy rule: spec §10's "always confirm" categories (`local_change, delete, overwrite, external_send, external_upload, purchase, install_or_elevate, security_setting`; matches ADR-0009 item 8) always need approval. `navigate` (like `read`) needs no confirm, under the binding conditions in ADR-0009 item 8, whatever the severity.
   - `credential_access` never produces an ApprovalRequested. It is `DENIED_BY_POLICY`.
   - E04 RiskClass is a tool-catalog floor: `read→low`, `reversible→medium`, `sensitive→high`, `forbidden→`no request (`DENIED_BY_POLICY`).
   - Old CONTRACTS values map as: `sensitive→high`; `destructive→high`+`delete|overwrite`; `external→high`+`external_send|external_upload`; `financial→critical`+`purchase`.
5. **endReason** = `vad_silence | timeout | max_duration | user_stop` (the coordinator's values).
   - `timeout` means the listen window closed after some speech was captured. With no speech there is no UtteranceReady.
   - Desktop `silence` becomes `vad_silence` and `max_length` becomes `max_duration`.
   - Desktop `error` is removed: a capture or STT error is not an utterance. It is reported by the proposed voice state event (DOT-070).
6. **TaskFinished.outcome** = `succeeded | answered | partial | unverified | failed | failed_after_side_effects | declined | blocked_auth | blocked_unavailable`. This is E03's set, with E11's P1 split applied.
   - `succeeded`: goal postconditions were verified (`verified:true`). This is the only value with `verified:true`.
   - `answered`: conversational, with no tool action.
   - `partial`: the main goal was observed but at least one non-critical postcondition failed or is unknown (verifier `partially_verified`).
   - `unverified`: Codex reported done but the postcondition could not be observed.
   - `failed`: failed, and the ledger shows no committed or possible side effects.
   - `failed_after_side_effects`: failed after a committed or possible side effect. This is E03's old meaning of `partial`, renamed.
   - `declined`, `blocked_auth`: as in the coordinator today.
   - `blocked_unavailable` (E01 2026-10-19): Codex/auth unreadable (reason `codex_unavailable`); never a sign-in prompt, and verified is false.
   - There is no `cancelled` value. A task ends with exactly one `TaskFinished` **or** one `TaskCancelled`.
   - Mapping from the verifier: `verified→succeeded`, `partially_verified→partial`, `unverified→unverified`, `failed→failed` or `failed_after_side_effects` (decided by the ledger). Desktop's 3-value set becomes a subset.
7. **TaskCancelled.stopStatus** = `stopped_before_dispatch | stopped_no_side_effects | stopped_after_side_effects | stop_unconfirmed | completed_before_stop` (the coordinator's values).
   - This is the single cancel/stop enum for every package.
   - "Stop speaking" emits no TaskCancelled, so `ttsOnly` is gone.
   - Desktop `no_task` is not a stopStatus. The port result is `{stopStatus} | {noActiveTask:true}`.
   - Desktop `stopped_before_effects` becomes `stopped_before_dispatch` or `stopped_no_side_effects`, and `stopped_after_partial_effects` becomes `stopped_after_side_effects`.
8. **ToolResult v2** = `{taskId, toolId, observedState: ObservedState, verified, error?: ToolError, sideEffect, evidenceRef?}`.
   - `ObservedState` is a redacted object, with minimum keys `outcome, decision, checks{id: pass|fail|unknown}, sideEffect` and optional `question, candidates`. It never contains window titles, file contents or full user paths (E11 P3).
   - `ToolError = {code, message, retryable}` (E11 P4).
   - `sideEffect ∈ none | committed | unknown`. E04's `attempted` maps to `unknown`, and the ledger treats `unknown` as `possible` (E11 P5).
   - Invariant: `error` is present ⇔ `verified:false`.
   - Error codes: `DENIED_BY_POLICY` (never grantable), `PERMISSION_REQUIRED` (missing scope, grantable), `APPROVAL_REQUIRED` (replaces `NEEDS_APPROVAL`), `AMBIGUOUS`, `NOT_FOUND`, `TIMEOUT`,
     `PRECONDITION_FAILED`, `POSTCONDITION_FAILED`, `POSTCONDITION_UNKNOWN`, `CANCELLED`, `INTERNAL`.
9. **workspaceScope** = `{scopes: CapabilityScope[], paths: string[]}`. Desktop renames `folders` to `paths`.
10. **Verifier port** (coordinator `VerifierPort`): `VerificationResult = {outcome: verified|partially_verified|unverified|failed, verified, observedState: ObservedState, error?: ToolError, evidenceRef?}`,
    where `verified ≡ outcome==='verified'`. This replaces the boolean-only result.
11. **Codex error kinds** (coordinator `CodexErrorKind`) = `transient | rate_limited | plan_limit | auth | fatal`.
    - `plan_limit` (from `usageLimitExceeded`, `sessionBudgetExceeded`) and `auth` are **never retried**, and there is never an API-key fallback (spec §5).
    - `rate_limited` (from `rateLimitExceeded`, or HTTP 429) and `transient` keep the existing bounded retry rule: retry only when the ledger is empty and fewer than `maxAttempts`.
    - Full mapping: CONTRACTS §1.5.

## Alternatives
- **The CONTRACTS v1 camelCase spellings.** Rejected: nothing implements them,, and adopting them would mean rewriting enums that the coordinator and desktop already test. Their content was merged where it carried more truth (category).
- **Severity only, or category only.** Rejected: the UI needs severity, and the spec §10 "always confirm" rule is defined by category.
- **Keep `partial` with two meanings.** Rejected: it hides a failure behind a near-success word (RB-09).
- **Keep version 1 during migration.** Rejected: an old producer would pass validation with values that changed meaning.

## Consequences
- Every producer and consumer migrates (DOT-060 E03, DOT-062 E06, DOT-064 E11, DOT-065 E04). `packages/contracts` (DOT-007) implements v2 once, and the local drafts are deleted.
- The new risk is drift while migration is in progress (RISKS R17). It is mitigated by the version-2 reject rule and the `rg` checks for old literals in each ticket.
- The coordinator gate fix (DOT-061) is release-relevant because of spec §5 and RB-01.

## Changelog
- 2026-10-19: Accepted (E01).
- 2026-10-19: §4 always-confirm list gains `local_change` to match ADR-0009 item 8 (E01).
- 2026-10-19: §4 category enum gains `navigate` (no-confirm; conditions in ADR-0009 item 8) (E01).
- 2026-10-19 (E01): item 11 retry trigger is a failed turn (`turn/completed{failed}`) with an empty ledger, not a rejected `turn/start` (RPC errors carry no codexErrorInfo; CONTRACTS §1.5).
