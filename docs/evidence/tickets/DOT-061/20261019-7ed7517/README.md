# DOT-061: E01 ruling 2g.1 (separate `onTaskCancelled`, no union on `onTaskFinished`): evidence for commit 7ed7517 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 0714286 / 78b0bf9 (273/273; accepted by E01). Source (read-only, `git show`): dottie-e01 499e61c (`arch/CONTRACTS.md` §3 ApprovalResolved row + changelog).

## What changed (src/coordinator.ts)
- `onTaskFinished(listener)` and `onTaskCancelled(listener)`, each returning an unsubscribe (E06 7f022d2 style, same as `onStateChange`). Neither existed before.
- Each has its own listener set, with no union: TaskCancelled → `onTaskCancelled` only; TaskFinished → `onTaskFinished` only.
- Each listener gets the envelope the `EventSink` got, exactly once.
- Order: clear the active task → `onStateChange` listeners → `EventSink.emit` → terminal listeners.
- A throwing listener is logged (`coordinator.task_listener.failed`; type and eventId only) and isolated.

| file | case | result |
|---|---|---|
| `*_2g1-red_red_tap.txt` | test/ruling2g1.test.ts with the members registering but nothing delivered | **RED: 273 pass / 5 fail (278)** |
| `*_2g1-mutation_mutation_summary.txt` | H1–H13 | **13/13 killed** |
| `*_2g1-final_final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 7ed7517 | **GREEN: 278/278**, exit 0 |

The mutants killed include the three you required:
- TaskCancelled routed into `onTaskFinished` (H1), plus the union (H2);
- double delivery (H3 cancel, H4 finish);
- emitting before the clear (H6 cancel, H7 finish).

The others: TaskFinished routed into `onTaskCancelled`, `onStateChange` not notified, listeners called before the EventSink, no isolation, no-op unsubscribes, and no delivery at all.

## 499e61c wording vs our order
CONTRACTS: "the coordinator clears its active task before it notifies listeners or emits the terminal event". Changelog: "clears its active task before notifying and before the terminal emit". Both only require the clear to come first, and ours does. **No conflict.**

One nuance: the CONTRACTS text does not order "notify" against "emit". Ours runs `onStateChange` before the emit, but `onTaskFinished` / `onTaskCancelled` after the EventSink emit, since they deliver that same event. A literal "notify all listeners, then emit" (as paraphrased in the request) would differ for the terminal listeners only. E01 can tighten the wording if they mean that.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, over the pack's log files.
- 4 hits, all the test **name** "… no API-key fallback". No credential, token or key value appears.
