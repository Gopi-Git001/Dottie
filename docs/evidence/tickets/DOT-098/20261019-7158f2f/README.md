# DOT-098: Desktop smoke watchdog and hang fix, evidence for 7158f2f (Linux box)

E06 owns this ticket and E07 reviews it. Dated 2026-10-19 (CDT). Linux box only: Node 22.23.3, Electron 44.9.0, headless smoke. This is **not** Windows evidence. Code commit: `7158f2f` (parent `74c73ba`). This pack is committed separately on top of it.

## Acceptance (E01)

| # | criterion | result |
|---|---|---|
| 1 | Root cause named from the kept logs | **Harness, not app.** A click that resolves the last pending approval makes main destroy the approval window inside that IPC handler. When the window is destroyed before the reply to the page script that clicked is delivered, `webContents.executeJavaScript()` never settles. The smoke awaited that promise with no bound. Details below. |
| 2 | Every approval-dialog wait has its own bounded timeout that fails with the step name and captured output | `src/main/smoke/steps.ts` (`SmokeSteps.run`/`waitFor`, `SmokeStepTimeout`; unit tests in `test/smokeSteps.test.ts`). Every `waitLoad`, every page script and every click in the smoke is a named step with a 5 s bound, and a 60 s watchdog covers anything else. On a stall it prints `DOTTIE_SMOKE_FAIL {"reason":"step_timeout","failedStep":…,"timeoutMs":…,"completedSteps":[…],"partial":{…},"activity":[…]}` and exits 1. |
| 3 | 100 consecutive smoke runs, 0 hangs, logs kept | **100/100 `DOTTIE_SMOKE_OK`** (all `assertionsPassed:true`): 0 failed, 0 timed out, min 6519 ms, median 6591 ms, max 6726 ms. Summary: `runner-100.summary.txt`. Per-run results: `runner-100.results.txt`. Log hashes: `runner-100.logs.sha256`. The logs themselves are on the box at `/workspace/smoke-logs/7158f2f/runner-100/run001.log` through `run100.log` (`*.log` is git-ignored). |
| 4 | CI/smoke runner keeps output on timeout | `scripts/smoke-run.mjs` / `npm run smoke:ci` (`--runs N --out DIR --timeout-ms MS`). Each run's full stdout/stderr always goes to `DIR/runNNN.log` and ends with a `DOTTIE_SMOKE_RUNNER_RESULT` line; a timeout also adds a `DOTTIE_SMOKE_RUNNER_TIMEOUT` footer. Forced-timeout proof: `runner-timeout-keeps-output.log.txt` (`--timeout-ms 2000`; the log was kept and the runner exited 1). |
| 5 | No skips or retries that hide a hang | The runner never retries; every run counts, and it exits 1 unless every run printed `DOTTIE_SMOKE_OK` and exited 0. Inside the smoke nothing is skipped: a closing click is not awaited for its own script result, but the smoke then waits (bounded, named) for the effect main **must** produce, the `ApprovalResolved` sent and the window gone. If that effect is missing, the step fails. All existing smoke assertions are unchanged. |

## Root cause

- **Kept hang logs** (copied here):
  - `hang-edeac0b-run12.log.txt` ends right after the first dialog's double-click Approve: `Approve is not available until the warning has been shown.` then `This approval is no longer valid.`
  - `hang-b5dd124-run01.log.txt` ends after the `d` dialog's focus-timer refusals. The remaining steps of that dialog are a re-show, two probes and the Decline click that resolves the last pending approval, so this log alone doesn't pin the step; the pattern matches.

  In both, the passing run's next dialog (a new approval `BrowserWindow` for the next request, visible as fresh Chromium dbus lines) never starts. Both stalls follow a click that resolves the **last** pending approval.
- **Diagnosis run, pre-fix code plus bounded steps only** (`diagnosis-pre-fix-run16.fail.log.txt`; 15 OK, then run 16 failed): `DOTTIE_SMOKE_FAIL {"reason":"step_timeout","failedStep":"repeat.approveDoubleClick","timeoutMs":5000,…}`. The captured activity starts with `You approved the action.`. So main **did** record and send the approval and close the window; only the page-script promise that performed the click never settled.
- **Mechanism:** `ApprovalService.resolve` → `remove` → nothing pending → `closeApproval()` → `ApprovalWindow.close()` → `win.destroy()`, all synchronously inside the `resolveApproval` IPC handler. The page script's own reply (`executeJavaScript`) travels separately. If main destroys the webContents before that reply is delivered, Electron never settles the promise. This is a race, about 1 in 16 to 1 in 26 runs on this box, which is why it looked like a one-off at 46a5544.
- **Why it isn't app code:** the user-visible behaviour is correct every time. The decision is recorded once, one `ApprovalResolved` is sent, and the window closes. The renderer's own pending `resolveApproval` reply dies with its page, which is harmless. No production code awaits `executeJavaScript`. So no app change was made. Deferring the window close in the app would only make the race less likely, and it would open a new one: a deferred close could destroy a window reused by the next approval.
- **Fix (harness, `src/main/main.ts`):** `clickThatCloses(step, wc, code, done)` dispatches the click without awaiting its script result, then `waitFor`s the effect: the `ApprovalResolved` count grew **and** `approvalWindow.webContents === null`. It's used for `repeat.approveDoubleClick`, `timer.decline`, `codex.decline` and `bound.decline`.

## Check results at 7158f2f

typecheck pass · lint pass · tests **968 passed in 17 files** (964 before plus 4 new `smokeSteps` tests) · build pass · check-packaging pass · `npm run smoke` `DOTTIE_SMOKE_OK` with `assertionsPassed:true` (log `/workspace/smoke-logs/7158f2f/npm-smoke.log`) · runner 100/100.

The secret sweep (dottie-evidence-pack step 5) was run over this directory and found nothing. The logs contain only Chromium dbus noise, local paths and fixed UI strings.
