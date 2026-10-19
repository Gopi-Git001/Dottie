# ADR-0010: Coordinator state machine owns auth gating, idempotency and cancel semantics

- Status: **Proposed**. Date: 2026-10-18. Deciders: E01, E03, E02. Spec: §4 state machine, §5, §9.11–12.

## Context
Linux evidence (`docs/evidence/W1/linux-smoke/appserver-0.163.0-unauth.jsonl.txt` lines 16–38): when signed out, `thread/start` succeeds and `turn/start`
returns `inProgress`. Only after about 14 s of 401 retries does the turn complete with `status:"failed"` and `codexErrorInfo.httpConnectionFailed{401}`.
`turn/interrupt` ends a turn with `status:"interrupted"` (official page).

## Decision
- States per spec §4: `BOOTING → STANDBY → WAKE_DETECTED → LISTENING → TRANSCRIBING → CONFIRMING? → EXECUTING → VERIFYING → SPEAKING → STANDBY`, with
  overlays `MUTED, AUTH_REQUIRED, PERMISSION_REQUIRED, CANCELLING, RECOVERING, ERROR, SHUTDOWN`. The transition table lives in `packages/coordinator`
  and is exhaustively unit-tested.
- **Auth gate:** `TaskRequested` is admitted only if `AuthState.status == "signedIn"` from a fresh `account/read` (or one confirmed by `account/updated`
  plus a re-read). Otherwise → AUTH_REQUIRED, and nothing is sent to Codex.
  - **Exception (E01 2026-10-19): auth unavailable or unknown.** If `authState()` returns `unavailable` or `unknown`, throws, or times out, the task
    finishes blocked (`TaskFinished{outcome:'blocked_unavailable', reason:'codex_unavailable'}`), with **no** AUTH_REQUIRED and no new coordinator state.
    The supervisor separately publishes runtime status `waiting_for_env` (ADR-0013; CONTRACTS §2.4), which the tray shows as Standby or Offline with
    Reconnect and no sign-in prompt.
- **Idempotency:** single active task (E01 2026-10-19, DOT-092): at most one task is active at a time across Dottie (matching CONTRACTS §5 and the tool-host control channel, `docs/contracts/tool-host-control.md` DRAFT 8; was "one active task per thread"). `requestId` is deduplicated (pattern `Dollie_Bot_Private/src/store.ts` `claim`). `clientUserMessageId` on
  `turn/start` is set to the coordinator-minted `turnId` (`<taskId>.tN`, a new one per retry and clarification turn), and `idempotencyKey` = `taskId` (E01 2026-10-19, DOT-092 ruling 7); consistent with CONTRACTS §1.3. The server does **not** dedupe it (E09 run 2026-10-19); the adapter refuses duplicates.
- **Cancel:** "stop speaking" → stop TTS only. "Stop the task" → `turn/interrupt` + tool-process cancellation → `TaskCancelled.stopStatus` from the observed
  `turn/completed.status` and tool `observedState`. "New task while busy" → queue (default). Cancel-then-start needs a PO decision (Open Q8).

- 2026-10-19 (ADR-0012): canonical spelling is `signed_in`. The gate is an **allow-list**: only `signed_in` is admitted. `packages/coordinator/src/coordinator.ts:136` currently blocks only `signed_out|expired` and so admits `unknown`.
  That deviation is fixed in DOT-061. `CodexErrorKind` gains `plan_limit` (never retried).

## Consequences
The coordinator has to model App Server's asynchronous truth. Late events after cancel are recorded, not hidden (spec §14 "commands running after cancellation without reporting").

## Changelog
- 2026-10-19: E01: unavailable/unknown/throw/timeout → blocked with reason `codex_unavailable`, no AUTH_REQUIRED (runtime status lives in the supervisor, ADR-0013).
- 2026-10-19 (E01, E03 questions): codex_unavailable gets its own outcome, blocked_unavailable. signing_in gets reason sign_in_in_progress and unsupported gets reason account_unsupported, both AUTH_REQUIRED with distinct copy. A capture abort while awaiting a clarification ends with reason clarification_cancelled, not clarification_timeout. clientUserMessageId = turnId (CONTRACTS §1).
- 2026-10-19 (E01, E09 wire run): the server does not dedupe clientUserMessageId; the adapter holds one in-flight turn per thread and refuses duplicates. RPC errors carry no codexErrorInfo; retries key on a failed turn with an empty ledger (CONTRACTS §1.5).
- 2026-10-19 (E01 2026-10-19, DOT-092): "one active task per thread" → "single active task", matching CONTRACTS §5 (DOT-092 approvals item 27). Status stays Proposed.
- 2026-10-19 (E01 2026-10-19, DOT-092 ruling 7): Decision text fixed: `clientUserMessageId` = `turnId` (`<taskId>.tN`), `idempotencyKey` = `taskId` (was `taskId`, stale since the E01 ruling above).
