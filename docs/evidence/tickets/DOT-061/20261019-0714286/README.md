# DOT-061: E01 ruling 2g (desktop `activeTaskId`, TaskCancelled ends the active task): evidence for commit 0714286 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 21589b3 / 17e5721 (265/265; accepted with 5422112/a86d6af by E01 ruling 2d). Sources (read-only): dottie-e01 90ceed5 (`arch/CONTRACTS.md` §3 ApprovalResolved row + changelog), dottie `feature/E06-runtime-status` 7f022d2 (`apps/desktop/src/main/services/types.ts`), read with `git show`, no checkout.

## Port shape found
- **E01 90ceed5:** CONTRACTS only says the snapshot gains `activeTaskId: string | null` and the port forwards `TaskCancelled` as well as `TaskFinished`. Its own copy of `apps/desktop/src/main/services/types.ts` is stale (`getState(): {state, taskActive}`, no event members).
- **E06 7f022d2 (written before 2g, for ruling 2e):** `CoordinatorSnapshot {state: CoordinatorState; taskActive: boolean; activeTaskId: string | null}` ("non-null only while taskActive"), `getState()`, `onStateChange(listener)`, `onTaskFinished(listener)` ("TaskFinished events"), and no TaskCancelled member.

## What changed (src/coordinator.ts)
- `CoordinatorSnapshot` plus `Coordinator.getState()` / `onStateChange(listener) → unsubscribe`, with E06's names and shape. `taskActive` is `activeTaskId !== null`. The old private `onStateChange` was renamed `stateChanged`.
- **Bug fixed:** the active task was cleared **after** `TaskFinished` / `TaskCancelled` was emitted, so a listener reading the state inside the emit saw the finished task as still active. It is now cleared, and listeners are notified, before the emit. It is set when the task's flow starts, before any of its events. A queued task's terminal event never clears the running task.

| file | case | result |
|---|---|---|
| `*_2g-red_red_tap.txt` | test/ruling2g.test.ts against the interface only (old ordering) | **RED: 267 pass / 6 fail (273)**: listeners not told before the first event; stale id inside TaskFinished (declined, refused retry) and TaskCancelled (running, while confirming, shutdown) |
| `*_2g-mutation_mutation_summary.txt` | G1–G11 | **11/11 killed** |
| `*_2g-final_final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 0714286 | **GREEN: 273/273**, exit 0 |

The boot/STANDBY test and the listener/unsubscribe test passed in the red run (the interface already gave null with no task). G8, G9 and G10 show they discriminate.

## Open: needs E01/E06
**The port member that forwards TaskCancelled is not named in 90ceed5.** It could be a new `onTaskCancelled(listener)` or a widened `onTaskFinished` that delivers both, and neither the ruling nor E06's code says which. Not guessed: every TaskCancelled already reaches `EventSink` exactly once, with `activeTaskId` already null (tested). The adapter member is a one-line filter once named.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, over the pack's log files.
- 4 hits, all the test **name** "… no API-key fallback". No credential, token or key value appears.
