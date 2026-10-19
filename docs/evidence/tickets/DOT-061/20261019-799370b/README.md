# DOT-061: E01 ruling 2j (TaskCancelled.committedActions[].observedState: ObservedState | null, no sentinel): evidence for commit 799370b (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 3f73ae7 / a0e04f7 (291/291). Followed skill `e03-agent-arch-cancel-truth-table`.

## What changed

**`validateEvent` (src/contracts.ts), TaskCancelled**
- (a) An entry with `observedState: null` must have `certainty: 'possible'`; null + `committed` is rejected. Entries carry only `certainty`, no outcome or verified flag; a null entry has no outcome, so it can never be verified. "unknown or possible sideEffect" maps to certainty `possible`, which is what the ledger already gives `sideEffect: unknown`.
- (b) If any entry is null, `stopStatus` cannot be `stopped_no_side_effects` or `completed_before_stop`, and `sideEffects` must be `possible` or `committed`.
- (d) A missing `observedState` key (or `undefined`) is still rejected as "is required" by the closed-object check (3f73ae7). Null must be explicit. A guard test was added; it already passed on 3f73ae7.

**Copy (src/cancellation.ts)**
- (c) A tool that was still running is now reported as "`<tool>` (still running when the stop was requested; its result is unknown)". The rest is unchanged: "I can't confirm whether these took effect … I have not undone anything, so please check."
- The event's `report` is the same text as the spoken copy and the tray copy. Tests check that it contains "unknown" and none of done / finished / completed / succeeded / cleanly / "before it changed anything" / "didn't start".

**Truth table (src/cancellation.ts, src/coordinator.ts)**
- `StopInputs.toolsInFlight` was added.
- If the run had completed but a side-effecting tool never reported, the result is now `stop_unconfirmed`, not `completed_before_stop`.
- Both callers pass `task.ledger.toolsInFlight`.

## Coordinator path that violated 2j (fixed)
- **Setup:** a cancel during VERIFYING (the run had completed, the verifier was pending) while a side-effecting tool had started and never reported.
- **Before:** the coordinator emitted `completed_before_stop` with a null entry and the report "The task had already finished before I could stop it." That broke (b) and (c).
- **Now:** it emits `stop_unconfirmed` with the "unknown" wording.
- **Other cases were already correct:** a stop while a tool runs with ack at 0 ms or 2999 ms gives `stopped_after_side_effects`; `stopped:false` or no ack ever gives `stop_unconfirmed`; a pending Codex approval gives `stopped_after_side_effects` with the approval answered not-approved. All of these use certainty `possible` and sideEffects `possible`. Only their wording changed.
- Ack timing in the tests uses the fake clock (`FakeCodex.cancelAckDelayMs`); there are no sleeps.

| file | case | result |
|---|---|---|
| `*_2j-red_red_tap.txt` | final tests on 3f73ae7 behaviour (only the new field, the ledger getter and the caller args added) | **RED: 293 pass / 7 fail (300)** |
| `*_2j-mutation_mutation_summary.txt` | J1–J12 + R9 | **13/13 killed** |
| `*_2j-final_final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 799370b | **GREEN: 300/300**, exit 0, emit sweep clean |

- Red failures are tests 256, 257, 259, 260, 261, 262 and 263. The guard tests 258 ((d)) and 264 (ledger snapshot copies) pass on 3f73ae7 by design.
- **J12 (the ledger snapshot aliases its entries) survived the first run.** I added test 264, then re-ran J12 and the full set; it is killed.
- **One equivalent mutant was not run.** `toolsInFlight` at the cancelCheckpoint caller is unreachable there, because `completedBeforeStop` is always false.

## Notes
- **New truth-table row, for the skill owner:** dispatched + completedBeforeStop + a tool still in flight → `stop_unconfirmed`. I did not edit the skill file.
- **Field-by-field copying is unchanged.** These are `copyObserved`, `copyError` and `copyScope`, plus the ledger's `{...a}` snapshot. R9 (observedState pass-through) and J12 are killed.
- **Cross-team mismatch, still open:** E02's validateEvent requires a non-null `committedActions[].observedState`, so it should be aligned to 2j.
- There is still one TaskCancelled emit site (`emitCancelled`).

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, over the pack's log files.
- 4 hits, all the test **name** "… no API-key fallback". No credential, token or key value appears.
- The red tap contains box paths under `/tmp/d19/redpkg` (a scratch copy) and nothing else.
