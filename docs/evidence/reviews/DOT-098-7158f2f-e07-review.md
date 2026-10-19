# DOT-098 review: desktop smoke watchdog and hang fix (E06 7158f2f code, dc517c9 evidence)

- **Reviewer:** E07 QA (Codex QA Automation), required reviewer (test-significant). Date: 2026-10-19, 05:17 CDT (UTC-5).
- **Subject:** `7158f2f` (code, parent `74c73ba`) and `dc517c9` (evidence) on E06's local, unpushed branch `feature/E06-runtime-status` in `/workspace/dottie-e06`.
- **Where it ran:** Linux box only (Node 22.23.3, Electron from the lockfile, Xvfb). **This is not Windows evidence.**
- **E06's tree was not touched:** I reviewed it read-only. All runs used a `git clone` under `/tmp` checked out at `7158f2f` (`/tmp/e07-dot098`) plus a second clone for the negative checks (`/tmp/e07-dot098-neg`). After the review, `git -C /workspace/dottie-e06 status --porcelain` printed nothing and HEAD was still `dc517c9`. Nothing was pushed.
- **This is a draft.** Posting it on GitHub, or anywhere outside the box, needs Gopi's approval.

## Verdict: **APPROVE WITH CONDITIONS**

The root cause holds. I reproduced it deterministically and saw the new step bound catch it as a FAIL. The fix doesn't skip, retry or loosen anything. Every new timeout ends as `DOTTIE_SMOKE_FAIL` with exit 1. I confirmed 968 unit tests, 30/30 smoke:ci runs, and all 100 runner-100 log hashes. The conditions are about one assertion gap that existed before this change but that this ticket's purpose makes relevant, an inaccurate sentence in the evidence README, and AC 4's missing CI job.

### Conditions (before merge)
1. **(Medium) Assert exactly one reply on `bound.decline`.** `main.ts:487-491`. The reply count and value for the last closing click are never asserted. `clickThatCloses` only needs the count to grow (`> n`). `out['resolutions']` (`:460`, asserted `:511`) is sliced at `before` (`:454`), which is taken before the bound dialog. `joinMismatch.sent` is also measured before it. Negative check N5 (below) pushed a duplicate `ApprovalResolved` after `bound.decline` and the smoke still printed `DOTTIE_SMOKE_OK` with `assertionsPassed:true`. This gap predates the change (the assertions are byte-identical to `74c73ba`), but DOT-098 makes this click "wait on main," so the smoke should prove "one click, one reply" for all four closing clicks. Fix: assert `coordinator.resolutions.length === before + 2` (joinMismatch + bound) and that the last entry is `{actionId: '9'.repeat(64), approved: false}`, or assert an exact count/value inside each `clickThatCloses` call after the 300 ms settle.
2. **(Low-Medium) Correct the evidence README's b5dd124 sentence with an ADDENDUM** (don't edit the original). `README.md` says `hang-b5dd124-run01.log.txt` "ends after the `d` dialog's focus-timer refusals" and that "the passing run's next dialog … never starts." The log contradicts this. With timestamps and pids stripped, lines 1-29 of `b5dd124/run01.log` are **identical** to the passing `b5dd124/run02.log`. That includes the three later Chromium dbus line pairs (`043444.13`, `043444.85`, `043445.26`), which come with the codex, join-mismatch and bound dialogs. Only line 30 differs: SIGTERM instead of `DOTTIE_SMOKE_OK`. So that run stalled in the **last (bound) dialog**: `bound.waitLoad`, `bound.probe` or `bound.decline`. It's still consistent with the root cause (the last step is a closing click), but the README names the wrong dialog.
3. **(Low-Medium, E01 to rule) AC 4: there's no CI job yet.** No `.github/` or other CI config exists at `7158f2f` (`git ls-tree -r --name-only 7158f2f | grep -iE '^\.github|workflow|ci\.ya?ml'` found nothing). The runner does keep output on timeout (I re-ran it, see below), but the "CI smoke job … as an artifact" part isn't built yet. E01 should either accept "runner + README/E06-open-questions instruction" as meeting AC 4 for now, or file the CI wiring (E09) as a follow-up.

### Non-blocking findings
4. **(Low) Evidence-pack format** (dottie-evidence-pack steps 2-3). The pack files don't use the `<YYYYMMDD>T<HHMMSS><±HHMM>_<shortsha>_<caseId>_<artifact>` names. No machine artifact (`runner-100.results.txt`, `runner-100.summary.txt`, the runNNN logs) starts with the header object (`caseId, commit, build, startedAt, finishedAt, runner, command, exitCode, durationMs, result`). That means the runner-100 logs can't be tied to `7158f2f` from their contents. Only the timing fits: run001 mtime 04:54:22 and run100 mtime 05:05:15 CDT, between the code commit (04:53:23) and the evidence commit (05:06:10). Suggestion: have `smoke-run.mjs` write a header line (commit from `git rev-parse HEAD`, a dirty flag, Electron version) into every log and the summary.
5. **(Low) The watchdog report doesn't say where the stall was.** When the stall is outside a named step, `failedStep` is `null` (`main.ts:221` uses `smokeSteps.current`, which is null between steps). N3 printed `"reason":"watchdog","failedStep":null`. `completedSteps` does give the last good step, so this is just a usability point. Suggestion: add `lastCompletedStep`.
6. **(Low) The watchdog only covers `runSmokeTest`** (`main.ts:243-247`), not bootstrap. A stall during boot (for example `dialog.showErrorBox` at `main.ts:41-44`) is only caught by the runner's hard timeout (90 s by default). That's acceptable because the runner keeps the log. Just know which layer catches what.
7. **(Info, from reading the code, not observed)** On a shared box, a second Dottie instance makes `requestSingleInstanceLock()` fail (`main.ts:35-37`) and quit with code 0 and no `DOTTIE_SMOKE_OK`. The runner counts that as FAIL (it needs both the OK line and code 0), so it can't pass falsely. But concurrent smoke runs by different agents on this box will produce failures that look like flakes. Run them one at a time. I did.
8. **(Info) Checklist item 5 (no sleep waits).** Fixed `sleep(300/500/700)` calls remain (`main.ts:349,363,388,404,451,458,469,491`, among others). They were there before, and the fix kept the 300 ms settle after each closing click instead of removing it. They don't make results flaky (every pass/fail is decided by bounded waits or assertions), so this isn't blocking.
9. **(Info) RB mapping.** This is a harness-only change with no product code and no RB test IDs named. The smoke exercises approval (D14/X5) paths but this PR changes no RB behaviour. That's fine for a test-harness ticket.

## The four questions

### 1. Is the root cause backed by the kept logs? **Yes, mostly.** The logs locate both stalls right after a click that resolves the last pending approval, and my deterministic reproduction (N1) confirms the mechanism. The b5dd124 log points at the bound dialog, not the `d` dialog (condition 2).

`/workspace/smoke-logs/edeac0b/run12.log` (20 lines; passing runs have 30):
```
18 [dottie] ipc dottie:v1:approval:resolve: IpcHandlerError: Approve is not available until the warning has been shown.
19 [dottie] ipc dottie:v1:approval:resolve: IpcHandlerError: This approval is no longer valid.
20 /workspace/dottie-e06/apps/desktop/node_modules/electron/dist/electron exited with signal SIGTERM
```
Line 19 is the **second** click of `repeat.approveDoubleClick` being refused after the first click resolved the dialog. Every passing run has it, and so do my 30 runs. In passing run `edeac0b/run11.log`, the next lines are the dbus pair for the next approval window (the `d` dialog) followed by the timer refusals. In run12 nothing follows. The last output was at 04:30:05.64 and the file mtime is 04:31:04.31, so about 59 s of silence until an external SIGTERM, against a normal 6.5 s run.

`/workspace/smoke-logs/b5dd124/run01.log` (30 lines):
```
22 [dottie] ipc dottie:v1:approval:resolve: IpcHandlerError: Approve is available once this window has been on screen and focused for a moment.
23 [dottie] ipc dottie:v1:approval:resolve: IpcHandlerError: Approve is available once this window has been on screen and focused for a moment.
24 [459970:1019/043444.129513:ERROR:dbus/bus.cc:406] ...   (codex dialog window)
26 [459970:1019/043444.847012:ERROR:dbus/bus.cc:406] ...   (join-mismatch dialog window)
28 [459970:1019/043445.262406:ERROR:dbus/bus.cc:406] ...   (bound dialog window)
30 /workspace/dottie-e06/apps/desktop/node_modules/electron/dist/electron exited with signal SIGTERM
```
`diff` against passing `b5dd124/run02.log`, with pid/time prefixes normalized, shows only line 30 differs (SIGTERM vs `DOTTIE_SMOKE_OK`). The stall is in the last dialog, whose last action is `bound.decline`, a closing click on the last pending approval. About 39 s of silence passed before the SIGTERM. The pre-fix smoke logged no step names, so this log alone can't separate `bound.probe` from `bound.decline` (E06 says as much).

Supporting evidence: `dot098-diagnosis/run16.log` (pre-fix code plus bounded steps; runs 01-15 OK):
```
DOTTIE_SMOKE_FAIL {"reason":"step_timeout","failedStep":"repeat.approveDoubleClick","timeoutMs":5000, ... "completedSteps":[..., "repeat.forgedId"], ... "activity":["You approved the action.", ...]}
```
The newest activity entry is `You approved the action.`, so main recorded the decision even though the click's script promise never settled.

**My reproduction (N1):** I put back the pre-fix pattern (await the closing click's own `executeJavaScript` result) and deferred that script's reply by 300 ms so main destroys the window first. 3/3 runs printed `DOTTIE_SMOKE_FAIL {"reason":"step_timeout","failedStep":"repeat.approveDoubleClick","timeoutMs":5000,"error":null,...}`, with the same activity `You approved the action.`. So `executeJavaScript` neither resolves nor rejects when its window is destroyed before the reply arrives. That's exactly E06's mechanism, and the 5 s bound turns it into a named FAIL.

### 2. Is anything skipped, retried, loosened, or turned into a pass on timeout? **No.**
- `git show 7158f2f` / `dc517c9`: no `.skip`, `.only`, `.todo` or retry added (`git show 7158f2f | grep -nE '^\+.*(\.skip|\.only|retry|retries|catch)'` matches only comments, the runner's JSON-parse `catch`, the test helpers' `.catch(e=>e)`, the smoke's top-level `catch (e)` and `clickThatCloses`'s `.catch(() => undefined)`). `rg '\.(skip|only|todo)\('` over `apps/desktop/test` finds nothing.
- The hard assertion block (`main.ts:495-547`) is unchanged from `74c73ba`. The diff only turns `return out` into an out-parameter.
- No limits got longer. Before, unbounded waits (`did-finish-load`, every `executeJavaScript`) had no limit at all. Now each is 5 s (`STEP_MS`, `:195`), and there's a 60 s watchdog (`:197`). `waitLoad` went from a 50×100 ms loop that **returned `null`** on timeout (silently skipping the following probes through `wc ? … : null`) to `waitFor`, which **throws `SmokeStepTimeout`**. That's stricter.
- How a timeout ends: a step timeout reaches `catch (e)` (`:250`), which prints `DOTTIE_SMOKE_FAIL` and sets `process.exitCode = 1`. `:181-184` then calls `app.exit(1)`. The watchdog prints `DOTTIE_SMOKE_FAIL` and calls `app.exit(1)` (`:245-246`). The runner sets `ok` only if `!timedOut && code === 0 && /^DOTTIE_SMOKE_OK /m`, and exits 1 if any run fails. Observed: N1/N2/N3/N4 each logged `"code":1` and `RUNNER_EXIT=1`. A forced runner timeout logged `TIMEOUT` with `RUNNER_EXIT=1`.
- The one caught error is `clickThatCloses`'s `.catch(() => undefined)` (`:213`), which drops the page script's own result or error. It's backed up by a bounded `waitFor` on the effect (count grew **and** `approvalWindow.webContents === null`). N2 (no click) failed as `timer.decline` step_timeout, so a click that doesn't happen can't pass.

### 3. Does waiting on main weaken what smoke proves? **No, it's slightly stronger, with one assertion gap from before (condition 1).**
- **Window closed:** this is now asserted for every closing click (`closed()` in the `waitFor` predicate, `:347-348,386,449,489`). Before, nothing asserted it. If the window stayed open, the next `waitLoad` would quietly reuse it.
- **Exactly one decision/reply:** the double click is asserted by `JSON.stringify(out['repeatResolved']) === '[true]'` (`:500`). N4, a duplicate pushed after the double click, flipped it to `"repeatResolved":[true,true]`, giving `DOTTIE_SMOKE_FAIL` with exit 1. For `timer.decline` and `codex.decline`, `out['resolutions'] === '[true,false,false,false,false]'` (`:511`) fixes the exact count and values. **`bound.decline` isn't covered** (N5: a duplicate still passed). See condition 1.
- **Double click:** the second click is refused by main (`This approval is no longer valid.`, logged in every run) and `[true]` is asserted.
- **No click:** N2 printed `DOTTIE_SMOKE_FAIL {"reason":"step_timeout","failedStep":"timer.decline","timeoutMs":5000,...}`, exit 1.
- "Decision recorded" is shown by the coordinator's `resolutions` (the reply) and `controller.approvals.size === 0`. There's no assertion on the audit/activity entry count, but there wasn't one before either. Optional: assert one `You approved/declined…` activity entry per closing click.

### 4. Re-run: **968 confirmed; 30/30 smoke:ci; all 100 runner-100 hashes match; the negative checks fail fast as expected.** Details below.

## Commands and output (all on the box, Linux)
```
git clone -q /workspace/dottie-e06 /tmp/e07-dot098 && git -C /tmp/e07-dot098 checkout -q 7158f2f
cp -a /workspace/dottie-e06/apps/desktop/node_modules /tmp/e07-dot098/apps/desktop/   # package-lock.json sha256 identical to 7158f2f's
export PATH=/home/box/.local/node-v22.23.3-linux-x64/bin:$PATH   # engines >=22.12; /usr/bin/node is 20.19.2

npm run typecheck   -> exit 0
npm run lint        -> exit 0
npm test            -> Test Files 17 passed (17) / Tests 968 passed (968)
(parent 74c73ba, separate clone: npx vitest run -> 16 files, 964 passed; +4 = the new smokeSteps.test.ts)

xvfb-run -a -s "-screen 0 1280x1024x24" npm run smoke:ci -- --runs 30 --out /tmp/e07-dot098-logs/fix-30 --timeout-ms 90000
  -> DOTTIE_SMOKE_RUNNER {"runs":30,"ok":30,"failed":0,"timedOut":0,"failedSteps":[],"msMin":6468,"msMedian":6536,"msMax":6627}
     exit 0; 30/30 logs contain "assertionsPassed":true; each has exactly one "This approval is no longer valid." (double-click refusal)

cd /workspace/smoke-logs/7158f2f/runner-100 && sha256sum run*.log | diff <(sort -k2 <pack>/runner-100.logs.sha256) <(sort -k2 -)
  -> 100 files, ALL 100 HASHES MATCH
  all 100 logs: exactly one DOTTIE_SMOKE_OK and "assertionsPassed":true; 0 contain DOTTIE_SMOKE_FAIL or RUNNER_TIMEOUT
  RUNNER_RESULT lines == <pack>/runner-100.results.txt (identical after sort; the pack file is in lexical order)
  ../runner-100.summary.txt == <pack>/runner-100.summary.txt
  recomputed timings: n=100 min=6519 median=6591 max=6726 (matches the README)
  pack copies of the hang logs/diagnosis log: cmp-identical to /workspace/smoke-logs originals

Forced runner timeout at 7158f2f: node scripts/smoke-run.mjs --runs 1 --timeout-ms 2000
  -> run 1/1 TIMEOUT 2045ms; DOTTIE_SMOKE_RUNNER {...,"failed":1,"timedOut":1}; RUNNER_EXIT=1
     log kept (23 lines) ending with DOTTIE_SMOKE_RUNNER_TIMEOUT footer + RUNNER_RESULT {"ok":false,"timedOut":true}
```

### Negative checks (patched copy in `/tmp/e07-dot098-neg`; patches in `/workspace/smoke-logs/7158f2f-e07/patches/N*.diff`)
| id | change | expected | observed |
|---|---|---|---|
| N1 | the pre-fix pattern: `clickThatCloses` awaits the click script's own result, reply deferred 300 ms | named step FAIL, not a hang | 3/3 `FAIL step=repeat.approveDoubleClick`, `step_timeout`, `timeoutMs:5000`, about 6.75 s per run, `"code":1` |
| N2 | no click (`void 0`) at `timer.decline` | FAIL | `FAIL step=timer.decline`, `step_timeout`, 9164 ms, `"code":1`, runner exit 1 |
| N3 | `await new Promise(() => {})` outside any step (after `renderer.probe`) | watchdog FAIL | `DOTTIE_SMOKE_FAIL {"reason":"watchdog","failedStep":null,...,"completedSteps":["renderer.didFinishLoad","renderer.probe"]}` at 60281 ms, `"code":1` |
| N4 | duplicate `ApprovalResolved` after the double click | assertion FAIL | `DOTTIE_SMOKE_FAIL {... "repeatResolved":[true,true] ...}`, `"code":1`, `RUNNER_EXIT=1` |
| N5 | duplicate `ApprovalResolved` after `bound.decline` | should FAIL | **`DOTTIE_SMOKE_OK`, `assertionsPassed:true`, RUNNER_EXIT=0**, the gap in condition 1 |

Note: on the N1, N3 and N4 runs inside `npm run smoke:ci`, the outer `xvfb-run` returned 5 (`xvfb-run: error: problem while cleaning up temporary directory`), which hides the runner's code. So I re-ran N4 and N5 as `xvfb-run sh -c "node scripts/smoke-run.mjs …; echo RUNNER_EXIT=$?"` to see the runner's own exit code (N4 → 1, N5 → 0). On every run, the per-run `"code"` in `DOTTIE_SMOKE_RUNNER_RESULT` is Electron's exit code.

I didn't run the exact unbounded pre-fix code in a loop. E06's kept logs (edeac0b and b5dd124) and diagnosis run 16 cover the natural race, and N1 makes it deterministic.

### Secret sweep (dottie-evidence-pack step 5)
`rg -n --hidden -e 'eyJ[A-Za-z0-9_-]{10,}' -e 'refresh_token' -e 'access_token' -e 'code_challenge' -e 'sk-[A-Za-z0-9_-]{16,}' -e 'Bearer ' -e 'CANARY-'` over `docs/evidence/tickets/DOT-098/` and `/workspace/smoke-logs/7158f2f/` found no matches (exit 1). `git show 7158f2f dc517c9 | rg "sk-|eyJ|Bearer |CANARY-"` found no matches. `rg -i "DESKTOP-|@gmail|userCode|authUrl"` over the pack found no matches.

### E07 logs kept
`/workspace/smoke-logs/7158f2f-e07/` holds fix-30 (30 logs), the neg-N1..N5 logs, runner-timeout-2000, the console captures and the patches. `logs.sha256` there covers all 39 logs. For example:
```
db80c7a539ff93930e72edd9b564d3204ef0c9a9c5404c79f5e0d03be086163f  fix-30/run001.log
6fdcf35d4234b23d985871118e6c39bd3062d99f32f24baeadf6c27a26e23927  fix-30/run030.log
fb196c23356f3a650002202a4b49cb71e5afff9ffe77a43f25101df3b801528b  neg-N1/run001.log
f0bd4076e6661eaeb02d0e3604c0c23f94607ebd3ee49cdee713284b0c75170c  neg-N2/run001.log
410eb9ff0e0fe7cf30b4c9053731dc3a716a4ca4539f656184adaa21b1849811  neg-N3/run001.log
b8d6db59b21686dfb20c53768a2fbe80fd406c28c158cf9e304c4a1f23b98f56  neg-N4/run001.log
4cdbaa8a6b64dd55d002276951237e5586c721b00e59c25bb4a58676efadfebd  neg-N5-b/run001.log
476b148b17afa4b65457d102ce02dc5e7b49639eae0a3263c69ae33639389855  runner-timeout-2000/run001.log
```

## Acceptance check (BACKLOG DOT-098)
| AC | result |
|---|---|
| 1 Root cause named from the kept logs | Met. The README sentence about b5dd124 needs an addendum (condition 2). |
| 2 Every dialog wait bounded, failing with the step name and output | Met (N1/N2 named steps with `completedSteps`/`partial`/`activity`; N3 watchdog) |
| 3 100 consecutive runs, 0 hangs, counts and timings recorded | Met: hashes, results and summary all match the kept logs. Plus my 30/30. Linux only. |
| 4 CI smoke job keeps stdout/stderr as an artifact on timeout | Partly met: the runner keeps the log on timeout (verified), but there's no CI job yet (condition 3) |
| 5 No skip or retry hiding the hang | Met |

## Checklist (e07-qa-test-significant-pr-review)
1 run it yourself: done (968 = 964 + 4) · 2 behaviour not implementation: yes (asserts on coordinator sends and window state; N1/N2 confirm the timeout path fails) · 3 RB mapping: N/A, harness only · 4 fakes honest: no fake changed · 5 time flakiness: bounded waits decide results; fixed sleeps from before remain (note 8) · 6 level: Linux, labelled Linux · 7 secrets: clean · 8 truthfulness: no user-facing text changed · 9 evidence: path correct; naming/header gaps (note 4)

---

## Recheck 13f4e3d/80742c2 (E07, 2026-10-19, 05:40 CDT, UTC-5)

Scope set by E01: conditions (a) and (b) only, no 100-run. Subject: `13f4e3d` (code) and `80742c2` (evidence), still local and unpushed in `/workspace/dottie-e06`. I left E06's tree alone: `git status --porcelain` printed nothing and HEAD was still `80742c2` before and after. All runs used a fresh clone at `13f4e3d` (`/tmp/e07-dot098-r2`). Linux box only, never Windows.

### Recheck verdict: **STILL BLOCKED (narrowly), on one part of (a).** (b) passes.
The duplicate-reply part of (a) is fixed and proven. But the actionId and approved value of `bound.decline`'s single reply are still never asserted: a reply with the wrong actionId and `approved:true` passes (R3). E01's (a) requires the actionId and approved value where applicable, and for a Decline click they apply. A one-line fix in the assertion block clears this (see the fix below). Nothing else is blocking.

### (a) Exactly one reply per closing click
**What changed (`git diff 7158f2f..13f4e3d -- apps/desktop`):**
- `main.ts:214-222` `clickThatCloses(name, wc, code, replies, closed)` now takes `before = replies()`, sends the click, waits up to 5 s for `replies() > before && closed()`, sleeps `CLICK_SETTLE_MS` (300 ms, `:199`), then throws `SmokeStepAssertion(name, exactlyOneReply(before, replies()))` unless exactly one reply came. All four closing clicks use it: `:355` `repeat.approveDoubleClick`, `:390` `timer.decline`, `:449` `codex.decline`, `:485` `bound.decline`.
- `steps.ts`: `SmokeStepAssertion` and `exactlyOneReply` (`"expected exactly one ApprovalResolved, got N"`). There's also `position()`, which gives the running step, else `after:<last>`, else `before:first-step`.
- `smokeFailure` (`main.ts:228`): `failedStep` comes from the assertion or timeout step, else `position()`. A watchdog failure now reports `timeoutMs: 60000`. The new reason is `step_assertion`.

**Was anything loosened? No.**
- `STEP_MS` is still 5000 and `SMOKE_WATCHDOG_MS` still 60000.
- The hard-assertion block is byte-identical to 7158f2f (`diff` of `main.ts` from `Hard assertions (exit 1` to EOF printed `ASSERTIONS-IDENTICAL`).
- The runner's `ok` rule (`!timedOut && code === 0 && DOTTIE_SMOKE_OK`) and its exit code are unchanged. The runner only gained naming and the header, and output now streams to `<name>.partial` until the run finishes.
- No skip, only or retry was added. `package-lock.json` is unchanged.
- The old separate `await sleep(300)` after each click moved inside `clickThatCloses`, so timing is unchanged.

**actionId / approved value per click (what is actually asserted):**
| click | count | approved value | actionId |
|---|---|---|---|
| repeat.approveDoubleClick | exactly 1 (new) | `repeatResolved === [true]` (`:500`, unchanged) | not asserted (only one dialog is pending, so this is acceptable) |
| timer.decline | exactly 1 (new) | `resolutions === [true,false,false,false,false]` (`:511`) | not asserted |
| codex.decline | exactly 1 (new) | same list (`:511`) | not asserted |
| **bound.decline** | exactly 1 (new) | **not asserted** | **not asserted** |

**Commands and output (clone at 13f4e3d):**
```
git clone -q /workspace/dottie-e06 /tmp/e07-dot098-r2 && git -C /tmp/e07-dot098-r2 checkout -q 13f4e3d
cp -a /workspace/dottie-e06/apps/desktop/node_modules apps/desktop/      # lockfile unchanged 7158f2f..13f4e3d
npm run typecheck -> 0 ; npm run lint -> 0
npx vitest run   -> Test Files 17 passed (17) / Tests 971 passed (971)    # 968 + 3 new (exactlyOneReply, SmokeStepAssertion, position)

xvfb-run ... npm run smoke:ci -- --runs 5 --out /tmp/e07-r2-logs/clean-5 --timeout-ms 90000 --case-id DOT098-E07-RECHECK
  run 1/5 OK 6605ms ... run 5/5 OK 6596ms
  DOTTIE_SMOKE_RUNNER {"runs":5,"ok":5,"failed":0,"timedOut":0,"failedSteps":[],"msMin":6511,"msMedian":6596,"msMax":6668,"commit":"13f4e3d","dirtyTree":false}
  RUNNER_EXIT=0; files named per §3, line-1 header has the full SHA 13f4e3d9b3b6dbff55c3860509a94483f1c3c82c
```

**Negative checks** (patches in `/workspace/smoke-logs/13f4e3d-e07/patches/R*.diff`; each run was `xvfb-run sh -c "node scripts/smoke-run.mjs --runs 1 …; echo RUNNER_EXIT=$?"`; the tree was dirty, so headers say `dirtyTree:true`):
| id | fault | expected | observed |
|---|---|---|---|
| R1 | a faked duplicate on `bound.decline` (that one reply is recorded twice, inside the settle window) | FAIL bound.decline, "got 2", exit 1, no hang | **PASS**: `DOTTIE_SMOKE_FAIL {"reason":"step_assertion","failedStep":"bound.decline","timeoutMs":null,"error":"smoke step \"bound.decline\" failed: expected exactly one ApprovalResolved, got 2",…}`, header `exitCode:1`, `RUNNER_EXIT=1`, 6560 ms |
| R2 | a late duplicate pushed *after* `clickThatCloses` returned (my earlier N5 patch) | (informational) | `DOTTIE_SMOKE_OK`, RUNNER_EXIT=0. A duplicate arriving more than 300 ms after close isn't counted, because nothing checks the total at the end. Low. |
| R3 | `bound.decline`'s single reply recorded as `approved:true` with actionId `'7'×64` | should FAIL per E01 (a) | **`DOTTIE_SMOKE_OK`, `assertionsPassed:true`, RUNNER_EXIT=0.** Blocking for (a). |
| R4 | a stall outside any step (after `renderer.probe`) | watchdog FAIL with `failedStep` set | **PASS**: `DOTTIE_SMOKE_FAIL {"reason":"watchdog","failedStep":"after:renderer.probe","timeoutMs":60000,…}`, RUNNER_EXIT=1, 60278 ms |

**Fix to clear (a)** (also covers R2): in the hard-assertion block, after `bound.decline`, assert the full reply list, e.g. `coordinator.resolutions.length === before + 2` and the last entry `{actionId: '9'.repeat(64), approved: false}`. Better still, assert `coordinator.resolutions.map(r => [r.resolved.actionId, r.resolved.approved])` against the full expected sequence (`a/true, b/false, c/false, d/false, codex/false, e/false, 9/false`). That pins actionId, value and total count for every click in one line.

### (b) Addendum and named logs: **PASS**
- `git diff --quiet dc517c9 80742c2 -- docs/evidence/tickets/DOT-098/20261019-7158f2f/README.md` printed `README-unchanged`. `git diff --diff-filter=MD --name-only dc517c9 80742c2 -- docs/evidence/` printed nothing, so nothing was modified or deleted; 8 files were only added to the 7158f2f pack.
- `ADDENDUM-20261019.md` §1 says the README's b5dd124 description is wrong. It says the hung run shows the three later window creations (04:34:44.13, 04:34:44.85, 04:34:45.26 CDT, lines 24-29: codex, join-mismatch, bound) and **stalled in the last, bound-path dialog** (`bound.waitLoad`/`bound.probe`/`bound.decline`, likely `bound.decline`), and that pre-fix logs don't name steps. This matches my analysis.
- `/workspace/smoke-logs/7158f2f/runner-100-named/`: **100 files**, every name matches `^20261019T\d{6}-0500_7158f2f_DOT098-AC3_smoke-log_run\d{3}\.log$`, runs 1-100. A Python check of all 100 files found **0 mismatches** on each of these:
  - line 1 is JSON with every README §4 field (`caseId, commit, build, installerSha256, startedAt, finishedAt, runner, command, exitCode, durationMs, result`)
  - `commit` is the full `7158f2f2c5eea283bd608d171fe2f467a39efcb8`
  - `startedAt`/`finishedAt` are ISO with `-05:00`, and the name stamp equals `startedAt`
  - `finishedAt` equals the original file's mtime
  - `durationMs`, `exitCode` and `result` equal that log's `DOTTIE_SMOKE_RUNNER_RESULT` line
  - **everything after line 1 is byte-identical to `runner-100/runNNN.log`**, and its sha256 equals the hash committed in `runner-100.logs.sha256`
  - `originalFile`/`originalSha256` are correct
- In the committed `…_7158f2f_DOT098-AC3_smoke-run-results.jsonl` (header + 100 rows), every row's `logSha256` matches the named copy on disk (0 mismatches), and all 100 rows say `pass`. The four retrofitted pack logs (two hang logs, the diagnosis log, the forced-timeout log) are byte-identical to their originals below the header.
- Secret sweep (the step 5 `rg`) over `runner-100-named/` and `docs/evidence/tickets/DOT-098/` found no matches.

### New low findings (not blocking)
- L1: the retrofitted headers hard-code `dirtyTree:false` for the 100 7158f2f logs and the edeac0b/b5dd124 hang logs (`retrofit-evidence-format.mjs:53,62,68-69`). That's E06's recollection, not a measurement after the fact. `headerSource` does mark the headers as retrofitted. Suggest adding "dirtyTree asserted, not measured" to `headerSource`. From 13f4e3d on, the runner measures it.
- L2: the forced-timeout artifact's header has `result:"pass"` with `exitCode:1`, explained in a `note`. That's defensible as "AC4 behaviour passed," but per README §4 `result` describes the run. Consider `caseId`-level wording or `result:"fail"` plus `expected:"fail"`.
- L3: if the runner itself is killed, the run's output is left in `<name>.partial` with no header (`smoke-run.mjs` docstring). That's acceptable; CI should upload `*.partial` too.
- L4: R2 above (a duplicate more than 300 ms late isn't counted). The suggested full-sequence assertion fixes it.

### E07 recheck logs
`/workspace/smoke-logs/13f4e3d-e07/` holds clean-5, neg-R1..R4, the patches and `logs.sha256`:
```
7c82c73c1e02ef9e1d37e40d579f5ce438be1d0180702e845bab82bbba30e4aa  clean-5/…_run001.log
5838a23a86fb99327ad48890130028463435e634836081e91863134e3f3fec70  clean-5/…_run005.log
b063e4858246458eb45586aeed7b86bc15247394f2790a06dd1e9c0f4a078969  neg-R1/…_DOT098-E07-NEG-R1_smoke-log_run001.log
1ef6a35e9b2ab6fcb0219d3c7f2e6afbc0789f4063597a93cf532a5d197524cc  neg-R3/…_DOT098-E07-NEG-R3_smoke-log_run001.log
962e92e54a67d107800fe76de43ed77cb22817f5e8a10b5d085826acb547a06d  neg-R4/…_DOT098-E07-NEG-R4_smoke-log_run001.log
```

**Final:** still blocked until `bound.decline`'s reply actionId and `approved:false` are asserted (ideally the full reply sequence). Once that lands, with the 971+ tests still passing, an R3-style fault failing, and 5 clean smoke runs, E07 approves without another 100-run. Condition 3 (CI wiring, AC 4) stays with E01 as before.

---

## Final recheck b3d7a4d/02ddb8b (E07, 2026-10-19, 05:50 CDT, UTC-5)

Subject: `b3d7a4d` (code) and `02ddb8b` (evidence pack `docs/evidence/tickets/DOT-098/20261019-b3d7a4d/`), local and unpushed in `/workspace/dottie-e06`. E06's tree was untouched: `git status --porcelain` empty, HEAD `02ddb8b`. All runs were in a fresh clone at `b3d7a4d` (`/tmp/e07-dot098-r3`), one at a time, under Xvfb. Linux box only.

### Verdict: **APPROVE**
The blocker from the last recheck is fixed. Every fault I injected into the reply sequence fails with exit 1 and no hang. The one exception is a duplicate of the *last* reply arriving after the final check, which is a limit of the check window and not loosening (follow-up F1). Condition 3 (CI wiring for AC 4) stays with E01 as before.

### Code diff 13f4e3d..b3d7a4d: nothing loosened
- `main.ts:200-214` `EXPECTED_REPLY_SEQUENCE` = `a/true, b/false, c/false, d/false, f/false, e/false, 9/false`. Against the actual requests in `main.ts`:
  - a is the repeat dialog (`:346`).
  - b and c are the pre-dispatch reads declined `display_unavailable` (`:373`, `:377`).
  - d is the timer dialog (`:382`).
  - **f is the codex dialog's real id** (`actionId: 'f'.repeat(64)`, `requestSource: 'codex'`, `:415-417`).
  - e is the join mismatch (`:468/470`).
  - 9 is the bound dialog (`:480`).
  - 8 is the not-active-task request (`:343`) and is not in the list.

  The list is a hand-kept constant, not computed. It matches the requests exactly, and if it ever drifts from them the smoke fails, so a drift can't produce a false pass.
- `main.ts:501-506`: after `bound.decline` returns (its 300 ms settle included), `replySequenceMismatch(EXPECTED, coordinator.resolutions…)` throws `SmokeStepAssertion('final.replySequence', …)`. Because the whole sequence must be equal (count, order, actionId, approved), **8 is asserted absent**: any reply for 8 breaks equality (G4 below). `notActiveTask.sent === 0` (`:561`) still holds as well.
- `steps.ts`: `ReplyEntry`, `shortActionId`, `replySequenceMismatch` (it reports the first differing position, both counts and the actual list).
- The per-click `exactlyOneReply` checks are kept. `STEP_MS` is still 5000, `SMOKE_WATCHDOG_MS` 60000 and `CLICK_SETTLE_MS` 300. The hard-assertion block is byte-identical to `13f4e3d` (`ASSERTIONS-IDENTICAL`). `package.json` and the lockfile are unchanged. No skip, only or retry was added.
- `smoke-run.mjs`: a provisional header is written to `.partial` before Electron starts, and the final log replaces it with the full header (the body is everything after the first line). The `ok` and exit rules are unchanged.

### Commands and output
```
git clone -q /workspace/dottie-e06 /tmp/e07-dot098-r3 && git -C /tmp/e07-dot098-r3 checkout -q b3d7a4d
npm run typecheck -> 0 ; npm run lint -> 0
npx vitest run -> Test Files 17 passed (17) / Tests 978 passed (978)      # 971 + 7 new replySequenceMismatch tests

xvfb-run ... npm run smoke:ci -- --runs 5 --out /tmp/e07-r3-logs/clean-5 --timeout-ms 90000 --case-id DOT098-E07-FINAL
  run 1/5 OK 6529ms · 2/5 OK 6485ms · 3/5 OK 6500ms · 4/5 OK 6453ms · 5/5 OK 6501ms
  DOTTIE_SMOKE_RUNNER {"runs":5,"ok":5,"failed":0,"timedOut":0,"msMin":6453,"msMedian":6500,"msMax":6529,"commit":"b3d7a4d","dirtyTree":false}
  RUNNER_EXIT=0; 5/5 "assertionsPassed":true; header commit b3d7a4d01d955da38f213ba93c633d9076cc10fe, dirtyTree:false
  "replySequence":["ax64/true","bx64/false","cx64/false","dx64/false","fx64/false","ex64/false","9x64/false"]
```

### My fault injections (my own patches, not E06's; `/workspace/smoke-logs/b3d7a4d-e07/patches/G*.diff`; each run as `xvfb-run sh -c "node scripts/smoke-run.mjs --runs 1 …; echo RUNNER_EXIT=$?"`)
| id | fault | result |
|---|---|---|
| G1 | bound reply recorded `approved:true` (actionId 9) | FAIL `final.replySequence`: "differs at #7: expected 9x64/false, got 9x64/true", RUNNER_EXIT=1, 6462 ms |
| G2 | bound reply actionId `7x64`, `approved:false` | FAIL `final.replySequence`: "differs at #7: expected 9x64/false, got 7x64/false", RUNNER_EXIT=1, 6493 ms |
| G3b | duplicate of 9 pushed after `bound.decline`'s 300 ms settle | FAIL `final.replySequence`: "differs at #8: expected (none) …", RUNNER_EXIT=1, 6467 ms |
| G3d | duplicate of f, about 400 ms after the codex window closed (outside its settle) | FAIL `final.replySequence`: "differs at #6: expected ex64/false, got fx64/false (expected 7 replies, got 8: …, fx64/false, fx64/false, …)", RUNNER_EXIT=1, 6573 ms |
| G3a | duplicate of d, about 800 ms after the timer window closed | FAIL, exit 1, 5270 ms, but caught **earlier**, as `codex.decline` "expected exactly one ApprovalResolved, got 2", because it landed inside codex.decline's count window. Correctly a failure; the step name blames the wrong click (follow-up F2). |
| G3c | duplicate of 9, about 700 ms after the bound window closed (after the final check) | **`DOTTIE_SMOKE_OK`, RUNNER_EXIT=0.** Not observed: the final check runs about 300 ms after the last close (follow-up F1). |
| G4 | the not-active-task request (8) sends a reply | FAIL `final.replySequence`: "differs at #1: expected ax64/true, got 8x64/false", RUNNER_EXIT=1, 6535 ms |

No run hung: every fault run finished in 5.3-6.6 s.

### .partial header and ADDENDUM §4
- Killed runner (SIGKILL at about 3 s) at b3d7a4d, clean tree: it left `…_b3d7a4d_DOT098-E07-KILLED_smoke-log_run001.log.partial` (23 lines). Line 1 is the provisional header: full commit `b3d7a4d01d…`, `dirtyTree:false`, `startedAt`, `finishedAt:null`, `exitCode:null`, `durationMs:null`, `result:"incomplete"`. The output up to the kill follows it. **Claim confirmed** (E06's own proof was at dirty 80742c2; mine is at b3d7a4d).
- ADDENDUM §4 (append only; `git diff 80742c2 02ddb8b` shows only `+` lines in that file) says `dirtyTree:false` on the backfilled headers was inferred from the commit, not measured, and that the runner measures it from 13f4e3d on. That correctly closes my L1. The 7158f2f pack's README and other files are unchanged.
- Secret sweep (step 5 `rg`) over `/workspace/smoke-logs/b3d7a4d-e07` and the b3d7a4d pack found no matches (exit 1).

### Non-blocking follow-ups
- F1 (Low): a duplicate of the **last** reply (9) arriving more than about 300 ms after the bound window closes isn't seen (G3c). A late duplicate of any earlier click is caught (G3a, G3d). Options: extend the final settle (for example 1 s) before `final.replySequence`, or re-check the sequence just before printing `DOTTIE_SMOKE_OK`.
- F2 (Low): `exactlyOneReply` counts every new reply, not the clicked dialog's own actionId. So a stray late reply is blamed on whichever click's window it lands in (G3a). It still fails correctly. Optionally check that the new entry's actionId matches the dialog.
- F3 (Low, carried over): the retrofitted forced-timeout header shows `result:"pass"` with `exitCode:1` (explained in a note). Prefer `result:"fail"` plus `expected:"fail"`, or keep that wording at case level. Likewise, `result:"incomplete"` in the `.partial` header isn't in README §4's list (`pass/fail/skip/error/flaky`). Either add it to the README or map it to `error`.
- F4 (Low, carried over): CI should upload `*.partial` along with the logs. Part of the open CI wiring for AC 4 (E01).

### E07 final recheck logs
`/workspace/smoke-logs/b3d7a4d-e07/` holds clean-5, neg-G1/G2/G3a/G3b/G3c/G3d/G4, killed-runner, the patches and `logs.sha256` (13 files).
