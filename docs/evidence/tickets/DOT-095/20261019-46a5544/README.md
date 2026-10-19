# DOT-095 (desktop, E06): ruling 2c at 46a5544, smoke-hang note for E07

E06, 2026-10-19 (CDT). Linux box only (Node 22.23.3, Electron 44.9.0, headless smoke). This is **not** Windows evidence. Requested by E01 in ruling 2e (dottie-e01 23553dc) so E07 can track the hang if it happens again.

Commit: `46a554419566a1fbdd05d7ef3e8a9f919930b14b` (ruling 2c, E01 a147dbe: decline any unshowable `ApprovalRequested` with `display_unavailable`, every source). E01 accepted it in ruling 2e.

## Results at 46a5544

| check | result |
|---|---|
| typecheck, lint | pass |
| tests (`vitest run`) | 829 passed (pass count reported when the commit was made) |
| build, check-packaging | pass |
| smoke (`npm run smoke`) | **one run hung** (no `DOTTIE_SMOKE_OK`/`DOTTIE_SMOKE_FAIL` line; the process didn't exit until it was killed). **Reruns passed** (`DOTTIE_SMOKE_OK`, `assertionsPassed: true`). Recorded as a one-off and not investigated then. No log of the hung run was kept. |

## Seen again later (same symptom)

While verifying the ruling 2e change (the commit that adds this note, parent d7cfe4e), 26 headless smoke runs on the same box gave **25 × `DOTTIE_SMOKE_OK` in about 6.5 s** and **1 hang** (killed by a 120 s `timeout`, with no result line). The hung run's output went to a pipe, so no log was kept. So it's intermittent, about 1 in 25 here, and it predates 2e: the first sighting was at 46a5544.

## What E07 should watch for

- Symptom: `npm run smoke` (or `electron . --dottie-smoke-test --dottie-smoke-ui`) prints neither `DOTTIE_SMOKE_OK` nor `DOTTIE_SMOKE_FAIL` and doesn't exit. A normal run finishes in about 6.5 s on this box.
- In CI, wrap smoke in a timeout (for example 60 s) and keep the full stdout/stderr of any run that times out. That log is the missing evidence.
- Suspects, not verified: the approval-window steps in `smokeApproval` (`waitLoad` polling and the fixed `setTimeout` waits around show/hide/focus) or quit not finishing after the result line. The smoke has no overall watchdog.
- If it happens more than once: open a DOT ticket (owner E06, reviewer E07) to add a smoke watchdog that prints `DOTTIE_SMOKE_FAIL {"stage":...}` on timeout, then fix the root cause.

The secret sweep isn't applicable: this note has no transcripts and no credentials.

## Third sighting, with a log (edeac0b, ruling 2g)

Runs at edeac0b with every run's output saved: 1 `npm run smoke` + 19 direct runs (`timeout 60 electron . --dottie-smoke-test --dottie-smoke-ui`; the batch was interrupted after run 19). **19 OK, 1 hang: run 12** (killed by the timeout, SIGTERM, no result line).

- Hung log: `smoke-hang-edeac0b-run12.log` (here). A passing run for comparison: `smoke-ok-edeac0b-run11.log`. The originals are on the box under `/workspace/smoke-logs/edeac0b/`.
- **Where it stops:** both logs match up to the first (possible-repeat) dialog's double-click Approve (`Approve is not available until the warning has been shown.` then `This approval is no longer valid.`). In the passing run, the next lines are the `d` (no-repeat) dialog's attention-timer refusals (`Approve is available once this window has been on screen and focused…`). The hung run has nothing after the double click. So the hang is between `repeatResolved` and the `noRepeat` probe: the approval window closes (no pending), then reopens for the `d` request, and a `waitLoad`/`executeJavaScript` on that window's webContents never settles. This is still a hypothesis, but it's narrower than before.
- Both logs contain only Chromium dbus noise, local paths and fixed UI strings. A secret-pattern grep found nothing.
