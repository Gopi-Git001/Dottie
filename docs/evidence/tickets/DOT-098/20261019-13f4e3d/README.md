# DOT-098 evidence: 13f4e3d (E01 scope refinement), Linux box

Commit under test: `13f4e3d9b3b6dbff55c3860509a94483f1c3c82c` (branch `feature/E06-runtime-status`), clean tree. **Linux-box** headless evidence (`runner: linux-box`), not Windows. No packaged build, so `build` and `installerSha256` are `null`. All times are CDT (−05:00). Every machine artifact here follows the dottie-evidence-pack naming and has the §4 header on line 1 (written natively by `apps/desktop/scripts/smoke-run.mjs` from 13f4e3d on).

The root cause and the 100-run result at the fix commit 7158f2f are in `../20261019-7158f2f/` (with `ADDENDUM-20261019.md`, which corrects that pack's b5dd124 description and ties its 100 logs to 7158f2f by SHA).

| E01 item | result | evidence |
|---|---|---|
| (a) exactly one reply on `bound.decline`; a faked duplicate fails | **pass**. `clickThatCloses` waits for reply plus close, settles 300 ms, then requires exactly one new `ApprovalResolved` (also on `repeat.approveDoubleClick`, `timer.decline` and `codex.decline`). Unit tests: `exactlyOneReply` passes 1 and fails a faked duplicate (4→6, "got 2") and none ("got 0"). | `apps/desktop/test/smokeSteps.test.ts`; `20261019T052059-0500_dc517c9_DOT098-AC-A-FAKED-DUPLICATE_*` |
| (c) watchdog sets `failedStep`, startup not covered | **pass**. `failedStep = SmokeSteps.position()` (the running step, else `after:<last step>`, else `before:first-step`) and `timeoutMs: 60000`. App startup stays under the runner's 90 s timeout. | `apps/desktop/src/main/main.ts`, `src/main/smoke/steps.ts`, unit test `position()` |
| AC3 rerun on this commit: 100 consecutive, 0 hangs | **100/100 pass, 0 timed out, 0 hangs, no retries**. Durations 6508 / 6572 / 6677 ms (min / median / max), 05:22:19–05:33:17 CDT. | `…_DOT098-AC3_smoke-runner-summary.json`, `…_smoke-run-results.jsonl` (header plus 100 lines), `…_smoke-logs-sha256.txt` (100 logs), sample `…_smoke-log_run001.log.txt`. All 100 logs are on the box at `/workspace/smoke-logs/13f4e3d/runner-100/` |
| AC4 CI wiring | not done here: E01 owns it | — |

## Faked-duplicate proof (a)

- Header `commit: dc517c9…`, `dirtyTree: true`. The tree was dc517c9 plus the uncommitted (a) and (c) code (later committed as 13f4e3d), plus a **temporary fault injection** in `StubCoordinator.resolveApproval` (`src/main/services/stubs.ts`): for the bound-path dialog's actionId (`'9'.repeat(64)`), it emitted `ApprovalResolved` twice.
- The patch was reverted right after, and it is not in any commit (13f4e3d's `stubs.ts` is identical to dc517c9's).
- Result: `DOTTIE_SMOKE_FAIL {"reason":"step_assertion","failedStep":"bound.decline","timeoutMs":null,"error":"smoke step \"bound.decline\" failed: expected exactly one ApprovalResolved, got 2", …}`, exit 1, 6532 ms. This is a failure, not a hang and not a skip.

## Secret sweep

The dottie-evidence-pack step 5 `rg` command over `docs/evidence/tickets/DOT-098/` returned nothing.
