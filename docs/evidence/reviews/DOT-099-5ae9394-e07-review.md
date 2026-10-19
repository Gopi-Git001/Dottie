# DOT-099 review: desktop smoke follow-ups F1, F2, F3b (E06 5ae9394 code, 6a5f514 + e186015 evidence)

- **Reviewer:** E07 QA (Codex QA Automation), required reviewer. Date: 2026-10-19, 06:10 CDT (UTC-5).
- **Subject:** `5ae93948e047bca3ce4efb606acd7ccce22509c1` (code, parent `02ddb8b`), `6a5f514` and `e186015` (evidence) on E06's local, unpushed `feature/E06-runtime-status` in `/workspace/dottie-e06`. Pack: `docs/evidence/tickets/DOT-099/20261019-5ae9394/`. `apps/` is identical between 5ae9394 and e186015 (`git diff --quiet 5ae9394 e186015 -- apps/`).
- **Acceptance:** DOT-099 in `arch/BACKLOG.md` (AC 3 as amended at `202ac23`; see finding P1 on who authored that commit).
- **Rules applied:** evidence README `docs/evidence/README.md` at E07 `f59fd30`; the E07 test-significant review checklist.
- **Where it ran:** Linux box, Node 22.23.3, Xvfb, in a fresh clone at 5ae9394 (`/tmp/e07-dot099`). **Not Windows evidence.**
- **What I didn't touch:** `/workspace/dottie-e06` (status clean, HEAD `e186015` before and after) and the shared `/workspace/dottie` checkout. Nothing was pushed. Posting this anywhere outside the box needs Gopi's approval.

## Verdict: **APPROVE WITH CONDITIONS**
All four acceptance criteria are met and I reproduced each one independently. Nothing was loosened. The one condition is about process, not code: E01 must confirm that the AC 3 amendment at `202ac23` is E01's ruling, because the commit carries E06's identity (P1). The follow-ups below don't block.

### Conditions
- **P1 (Medium, governance): confirm who authored the AC 3 amendment.** `202ac23 arch: DOT-099 AC3 amended (F3b)` is on `feature/E01-start`, but both author and committer are `Dottie E06 Desktop <e06-desktop@dottie.local>`. The root cause: `user.name` is set in the shared `/workspace/dottie/.git/config` (`git config --show-origin user.name` in `/workspace/dottie-e01` → `file:/workspace/dottie/.git/config  Dottie E06 Desktop`), and there's no per-worktree identity (`extensions.worktreeConfig` is unset). So **every** E01 ruling commit on `feature/E01-start` (972d5f4 … c7a159a, 202ac23) is recorded as E06. Nothing suggests wrongdoing, but the commit record can't show that the owner of DOT-099 didn't amend their own AC. **To clear:** E01 confirms 202ac23 in their channel or on the ticket. **Fix:** a per-worktree identity (`git config extensions.worktreeConfig true`, then `git config --worktree user.name/email` in each worktree), or separate clones as E07 has. If E01 doesn't confirm, AC 3 falls back to the original wording (a forced or killed runner writes `result:'incomplete'`). That would contradict README §4, so E01 would have to rule either way.

### Non-blocking follow-ups
- **FU1 (Medium, owner E06/E09): a killed runner orphans Electron.** I confirmed E06's claim, and found it's worse. After `kill -9` on the runner, its Electron child (pid 574968) was reparented to pid 52 (`sand-exit-watch`) and was **still alive at t+1 s, t+12 s and t+30 s**. A normal run takes 7.6 s, so the orphan doesn't even finish its smoke. It also **didn't exit within 3 s of SIGTERM**; I had to SIGKILL it. (E06 saw it exit on SIGTERM, so the shutdown behaviour isn't reliable either way.) Fix: spawn the child `detached: true` and kill the process group (`process.kill(-child.pid, …)`), and make CI jobs kill the whole group or cgroup. Could Electron also watch for its stdout pipe closing and exit? Worth checking. I cleaned up everything I started: no process from `/tmp/e07-dot099` is left (`pgrep -af /tmp/e07-dot099` finds nothing).
- **FU2 (Low): residual late-duplicate window, reported plainly.** The settled re-check runs about 1.3 s after the bound window closes (300 ms click settle + 1000 ms `FINAL_SETTLE_MS`). I measured, one run per point: a duplicate of 9 at about 0.7 s and about 1.2 s is **caught**; at about 1.35 s and about 1.5 s it is **not caught** (`DOTTIE_SMOKE_OK`, exit 0). AC 1 asks for "up to 1 s", so it's met. Anything arriving later than about 1.2-1.35 s after the last close is outside what the smoke can see.
- **FU3 (Low): `dirtyTree` checks only `apps/desktop`** (`smoke-run.mjs:51` `git status --porcelain -- .`). See ruling (2).
- **FU4 (Low): `build`/`installerSha256` are bare `null`s with no marker.** See ruling (3).
- **FU5 (Low): the mis-built F2 run is mislabelled.** E06's first F2 attempt (`20261019T055610…_DOT099-FAULT-F2-stray-dup-d-800ms_*`) actually injected a duplicate of **f**, not d, but its caseId still says `stray-dup-d`. It's kept (good, §1.4) and explained in the pack README, but the caseId in its header and filename is misleading. Next time give the corrected run a new caseId, or mark the failed attempt `…-misbuilt`.
- **FU6 (Info): blame is a heuristic.** `clickRepliesBlame` (`steps.ts:160`) blames any reply for another known action as `after:<owner>`. If the app itself sent d's reply in response to the codex click, the smoke would blame `timer.decline` and not the codex click. It still fails (exit 1), so this only affects diagnosis.
- **Carried from DOT-098:** the retrofitted 7158f2f forced-timeout header still shows `result:"pass"`. At 5ae9394 a forced timeout writes `result:"fail"` natively (verified below), so only that old retrofitted file is affected. CI still needs to upload `*.partial`.

## 1. Diff b3d7a4d..5ae9394 (code): nothing loosened
- `main.ts:206-216` `EXPECTED_REPLY_SEQUENCE` keeps the same seven (actionId, approved) pairs and adds a `step` label to each. `main.ts:218` `FINAL_SETTLE_MS = 1000`.
- `main.ts:234-243` `clickThatCloses(name, ownActionId, …)`: same 5 s bounded wait for a new reply plus window closed, same 300 ms settle. Then `clickRepliesBlame` (`steps.ts:160-171`) throws unless exactly **one** new reply arrived **and** it's for this dialog's own actionId. Before, it only counted replies. A reply for another expected action throws as `after:<owner>`. Net effect: **stricter**.
- `main.ts:246-249` `assertReplySequence` → `replySequenceBlame` (`steps.ts:179-190`) still calls `replySequenceMismatch` unchanged, so the same mismatch always fails. It only changes the blamed step name for an extra entry.
- `main.ts:284-289`: after `smokeBody`, `sleep(FINAL_SETTLE_MS)` then `assertReplySequence('final.replySequenceSettled')`, inside the same try. The watchdog is still armed, and a failure still goes through `smokeFailure` to `process.exitCode = 1` and `app.exit(1)`. `main.ts:522`: the in-body `final.replySequence` check is kept.
- Unchanged: `STEP_MS` 5000 (`:195`), `SMOKE_WATCHDOG_MS` 60000 (`:197`), `CLICK_SETTLE_MS` 300 (`:199`). The hard-assertion block is byte-identical to b3d7a4d (`ASSERTIONS-IDENTICAL`). `package.json`, `package-lock.json` and `scripts/` are unchanged. No skip, only or retry was added. The 9 new tests are all in `test/smokeSteps.test.ts`.

## 2. Unit tests, typecheck, lint
```
git clone -q /workspace/dottie-e06 /tmp/e07-dot099 && git -C /tmp/e07-dot099 checkout -q 5ae9394   # HEAD 5ae93948e047bca3ce4efb606acd7ccce22509c1
cp -a /workspace/dottie-e06/apps/desktop/node_modules apps/desktop/                                  # lockfile unchanged since b3d7a4d
npm run typecheck -> 0 ; npm run lint -> 0
npx vitest run -> Test Files 17 passed (17) / Tests 987 passed (987)        # 978 + 9
git -C /tmp/e07-dot099 status --porcelain | wc -l -> 0                       # whole tree, before and after every run
```

## 3. Five clean smoke runs (one at a time, AC 4)
```
xvfb-run ... npm run smoke:ci -- --runs 5 --out /tmp/e07-099-logs/clean-5 --timeout-ms 90000 --case-id DOT099-E07-CLEAN
  run 1/5 OK 7678ms · 2/5 OK 7606ms · 3/5 OK 7556ms · 4/5 OK 7546ms · 5/5 OK 7530ms
  DOTTIE_SMOKE_RUNNER {"runs":5,"ok":5,"failed":0,"timedOut":0,"msMin":7530,"msMedian":7556,"msMax":7678,"commit":"5ae9394","dirtyTree":false}
  RUNNER_EXIT=0; 5/5 "assertionsPassed":true; header commit 5ae93948e047…, dirtyTree:false
```
Runs are about 1 s longer than at b3d7a4d (6.5 s). That's the new final settle.

## 4. Fault injections (my own patches: `/workspace/smoke-logs/5ae9394-e07/patches/H*.diff`)
Each run was `xvfb-run sh -c "node scripts/smoke-run.mjs --runs 1 …; echo RUNNER_EXIT=$?"`. The patched tree's headers say `dirtyTree:true`, and the clone was restored and rebuilt afterwards (status 0).

| id | fault | result |
|---|---|---|
| H1 (AC 1) | duplicate of 9, ~700 ms after the bound window closed | FAIL `after:bound.decline`: "late ApprovalResolved 9x64/false from bound.decline, seen at final.replySequenceSettled: … differs at #8", RUNNER_EXIT=1, 7538 ms |
| H2a | duplicate of 9, ~1200 ms after close (patch log: "pushed 1201 ms after close") | FAIL `after:bound.decline` (same message), RUNNER_EXIT=1, 7523 ms |
| H2c | duplicate of 9, ~1350 ms after close | **`DOTTIE_SMOKE_OK`, RUNNER_EXIT=0**: the app exited before the push, so it wasn't seen |
| H2b | duplicate of 9, ~1500 ms after close | **`DOTTIE_SMOKE_OK`, RUNNER_EXIT=0**: not seen (FU2) |
| H3 (AC 2) | d's own reply duplicated ~800 ms after the timer window closed (lands during `codex.decline`) | FAIL `after:timer.decline`: "stray ApprovalResolved dx64/false (from timer.decline) arrived during codex.decline", RUNNER_EXIT=1, 5333 ms. At b3d7a4d the same fault was blamed on `codex.decline` (G3a). |
| H4 | bound reply recorded as `approved:true` | FAIL `final.replySequence`: "differs at #7: expected 9x64/false, got 9x64/true", RUNNER_EXIT=1, 6619 ms |
| H5 | bound reply recorded with actionId `7x64` | FAIL `bound.decline`: "expected exactly one ApprovalResolved, for 9x64; got 1: 7x64/false", RUNNER_EXIT=1, 6582 ms. This is caught earlier than at b3d7a4d because of the new own-actionId check. |

No fault run hung; all finished in 5.3-7.6 s.

## 5. AC 3 (F3b): forced timeout and kill -9
**Forced timeout** (`node scripts/smoke-run.mjs --runs 1 --timeout-ms 3000 --case-id DOT099-E07-FORCED-TIMEOUT`, clean tree): `run 1/1 TIMEOUT 3039ms`, RUNNER_EXIT=1. The final log's line 1:
```
{"caseId":"DOT099-E07-FORCED-TIMEOUT","commit":"5ae93948e047bca3ce4efb606acd7ccce22509c1","dirtyTree":false,"build":null,"installerSha256":null,"startedAt":"2026-10-19T06:05:01.827-05:00","finishedAt":"2026-10-19T06:05:04.867-05:00","command":"electron . --dottie-smoke-test --dottie-smoke-ui (timeout 3000 ms)","exitCode":0,"signal":null,"durationMs":3039,"result":"fail","timedOut":true,"failedStep":null,"run":1,"runner":"linux-box"}
```
The log ends with the `DOTTIE_SMOKE_RUNNER_TIMEOUT … output above kept` footer. The summary header has `"exitCode":1,"result":"fail"`. Per-run `exitCode:0` is Electron's own status after the runner's SIGTERM. **Matches E06's claim.**

**kill -9** (in one Xvfb session: `/workspace/smoke-logs/5ae9394-e07/kill-check.sh`). The runner (pid 574958) was SIGKILLed about 3 s into the run. The out folder holds **only** `20261019T060515-0500_5ae9394_DOT099-E07-KILLED-RUNNER_smoke-log_run001.log.partial` (23 lines, no `DOTTIE_SMOKE_OK/FAIL/RUNNER` line). I checked again at t+30 s: no final `.log`, no summary, no results file. Line 1:
```
{"caseId":"DOT099-E07-KILLED-RUNNER","commit":"5ae93948e047bca3ce4efb606acd7ccce22509c1","dirtyTree":false,"build":null,"installerSha256":null,"startedAt":"2026-10-19T06:05:15.015-05:00","finishedAt":null,"command":"electron . --dottie-smoke-test --dottie-smoke-ui (timeout 90000 ms)","exitCode":null,"signal":null,"durationMs":null,"result":"incomplete","timedOut":null,"failedStep":null,"run":1,"runner":"linux-box"}
```
**Matches E06's claim.** The orphan finding is FU1.

## 6. E06's evidence pack
- **Hashes:** all 10 committed `*.log.txt` / `*.log.partial.txt` copies are **byte-identical** to the box originals in `/workspace/smoke-logs/5ae9394/`, and `sha256sum -c logs.sha256` there gives 10/10 OK. So the hashes cover the exact bytes committed.
- **Statements match the files:** the pack README's statements about the F1, F2, F3b and clean runs agree with the files.
- **Secret sweep:** the step 5 `rg` over the pack, `/workspace/smoke-logs/5ae9394` and my logs found no matches (exit 1).
- **No old pack edited:** `6a5f514`/`e186015` touch only the DOT-099 pack and `docs/E06-open-questions.md`.

## 7. E07 rulings on E06's six evidence-README questions (README at f59fd30)
1. **The killed `.partial` cited only as runner-behaviour proof.** **OK, confirmed.** §4 says `incomplete` "must never be cited as evidence". The purpose of that rule is to stop an unfinished run being counted as a result. AC 3 is *about* what the runner leaves when killed, so the `.partial` is the very thing under test, not a smoke result. It must be labelled as runner-behaviour evidence and must never be counted toward a pass or fail tally. E06's pack does this. Proposed §4 wording, replacing "and it must never be cited as evidence": *"and it must never be cited as a test result. It may be cited, labelled 'runner-behaviour evidence', only to show what a killed or interrupted runner leaves behind."*
2. **`dirtyTree` covers only `apps/desktop`.** **Not OK long term, confirmed; non-blocking here.**
   - Gap: §1.3 defines clean as `git status --porcelain` empty outside `docs/evidence/` for the whole repo. A change outside `apps/desktop` (root config, `docs/contracts`, another package the build reads) would be missed.
   - Clean-tree evidence for 5ae9394: in my fresh clone, `git -C /tmp/e07-dot099 status --porcelain` (whole tree) was empty before and after every clean run. E06's whole-tree claim for its own F3b clone and clean-5 worktree runs is E06's account; their headers only measured `apps/desktop`.
   - Follow-up FU3: the runner records `dirtyTree` from the repo root, excluding `docs/evidence/` (`git -C <repoRoot> status --porcelain -- . ':!docs/evidence'`). Optionally also keep `dirtyTreeScope`.

   Proposed §1.3 addition: *"Ticket evidence follows the same rule: `dirtyTree` in a header means the whole repository's `git status --porcelain`, excluding `docs/evidence/`. A narrower check must be named in a `dirtyTreeScope` field."*
3. **`build` and `installerSha256` are null.** **OK for Linux unpackaged smoke, confirmed, with a marker; required on packaged and Windows runs.** §1.2 binds release evidence to build and installer and says evidence without them "does not count for a release". Ticket evidence on an unpackaged Linux run has neither. The headers carry bare `null` with no marker, so add one. Proposed §4 note: *"For unpackaged runs (ticket evidence on the box), `build` and `installerSha256` are `null` and the header carries `buildNote: "n/a: unpackaged"`. Any packaged, Windows or release-gate artifact must carry real values; `null` there makes the artifact invalid."* (FU4)
4. **Committed copies use `.log.txt`.** **OK, confirmed.** I verified the committed bytes are identical to the originals and the hashes match (§6 above). The header can't record the rename without changing the hashed bytes, so record it next to the hashes instead. Proposed §3 addition: *"If the repo ignores the native extension (e.g. `*.log`), commit the artifact byte-for-byte as `<name>.<ext>.txt`. The pack README or the `*-sha256.txt` file records the original name, and every hash is over the exact committed bytes."*
5. **Extra header fields.** **OK, confirmed.** §4 lists what the header "must contain". That's a minimum, not a closed schema. I checked all 11 required fields (`caseId, commit, build, installerSha256, startedAt, finishedAt, runner, command, exitCode, durationMs, result`) in my clean, forced-timeout and killed `.partial` headers. Extras (`dirtyTree, signal, timedOut, failedStep, run`) are additive and don't redefine required fields. Proposed §4 addition: *"Additional fields are allowed if they are additive and do not redefine a required field."*
6. **`DOT099-*` caseIds are ticket-local.** **OK for now, confirmed.** §3 says caseIds match test-plan or RB IDs "exactly", but the test plan (`docs/qa/test-plan.md`) has no ID for desktop-smoke harness cases; its only mention of smoke is "re-run smoke", `:244`. Ticket-local IDs are acceptable under `docs/evidence/tickets/` (§2), but before any release-gate evidence the desktop smoke needs stable suite-level IDs (E07 action: add, for example, `SMK-DESK-01..` to the test plan). Proposed §3 addition: *"Under `docs/evidence/tickets/` only, a ticket-local caseId `DOT<NNN>-<case>` is allowed when no test-plan ID exists. Release-gate evidence must use test-plan or RB IDs."*

None of these rulings edits the README. The proposed wording is for a separate E07 README change once Gopi or E01 agree.

## 8. Checklist (e07-qa-test-significant-pr-review)
1. Ran it myself: 987 (978 + 9), 5/5 smoke.
2. Behaviour, not implementation: assertions are on coordinator sends and window state, and the fault runs fail as expected.
3. RB mapping: N/A (harness only).
4. Fakes: no fake changed.
5. Time flakiness: results are decided by bounded waits; the settle windows are fixed sleeps, with the residual window reported in FU2.
6. Level: Linux, labelled Linux.
7. Secrets: clean.
8. Truthfulness: no user-facing text changed.
9. Evidence: path correct, naming and header per §3/§4 with rulings (1)-(6).

## E07 logs
`/workspace/smoke-logs/5ae9394-e07/` holds clean-5, neg-H1/H2a/H2b/H2c/H3/H4/H5, forced-timeout, killed-runner, the console files, `kill-check.sh`, the patches and `logs.sha256` (14 logs). Hash prefixes:
```
a248f295540c848e clean-5/…run001.log        210ff5a24a14ed05 clean-5/…run005.log
451b5e2d89df4949 neg-H1 (caught)            f7e3777655cb80e8 neg-H2a (caught)
cb0d2d76ef0d5ad9 neg-H2c (not caught)       36b66c8c13096761 neg-H2b (not caught)
a245750ec62b37f1 neg-H3                     26870945d4401121 neg-H4      dcd281d5faa48d1c neg-H5
8b6a76d0d15320b3 forced-timeout             4fcb58bd4eb9739f killed-runner .partial
```
