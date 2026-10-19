# DOT-099 evidence: 5ae9394 (desktop smoke follow-ups F1, F2, F3b), Linux box

Commit under test: `5ae9394` (full SHA in each header), on top of 02ddb8b. **Linux-box** evidence (`runner: linux-box`), not Windows. `build` and `installerSha256` are `null`. Times are CDT (−05:00). Every machine artifact has the dottie-evidence-pack name and the §4 header on line 1.

| acceptance (BACKLOG c7a159a) | result | evidence |
|---|---|---|
| 1. (F1) a duplicate of the last reply up to 1 s after the final close fails | **pass** (as specified; see the limit note below the table). After the smoke body, it settles `FINAL_SETTLE_MS` = 1000 ms, then re-checks the full reply sequence (`final.replySequenceSettled`) just before `DOTTIE_SMOKE_OK`. Fault: a duplicate of 9 pushed about 700 ms after the bound window closed gives `DOTTIE_SMOKE_FAIL {"reason":"step_assertion","failedStep":"after:bound.decline"}` ("late ApprovalResolved 9x64/false from bound.decline, seen at final.replySequenceSettled … differs at #8"), exit 1, 7596 ms. | `…_DOT099-FAULT-F1-late-dup-last-700ms_*`, `patches/F1-late-dup-last-700ms.diff.txt`; unit tests "F1: …" |
| 2. (F2) a stray late reply is blamed on its own step or `after:<step>`, never the neighbouring step | **pass**. Fault: d's own reply duplicated about 800 ms after the timer window closed. It lands in `codex.decline`'s window and is blamed `"failedStep":"after:timer.decline"` ("stray ApprovalResolved dx64/false (from timer.decline) arrived during codex.decline"), exit 1, 5404 ms. Before this fix the same fault was blamed on `codex.decline` (E07 G3a). | `20261019T055641-0500_…_DOT099-FAULT-F2-stray-dup-d-800ms_*`, `patches/F2-stray-dup-d-800ms.diff.txt`; unit tests "F2: …" |
| 3. (F3b, **amended by E01 at arch 202ac23**) a forced runner timeout writes a final header `result:'fail'`, never `pass`; a killed runner leaves only a `.partial` with `result:'incomplete'` | **pass**, with no code change (the runner is as committed at 5ae9394). Both runs are from a clean clone at 5ae9394. Headers are quoted in the F3b section below. | `…_DOT099-F3B-FORCED-TIMEOUT_*`, `…_DOT099-F3B-KILLED-RUNNER_smoke-log_run001.log.partial.txt`, `…_DOT099-F3B_smoke-logs-sha256.txt` |
| 4. 5 consecutive clean `smoke:ci` runs; no skip, only or retry | **5/5 pass**, 0 timed out, clean tree, 7587 / 7597 / 7627 ms (min / median / max). That's about 1 s longer than before, which is the F1 settle. Runner exit 0, 05:55:24–05:56:02 CDT. | `…_DOT099-CLEAN_*` |

**AC 1 limit (E07 FU2):** the settled re-check runs about 1.3 s after the bound window closes (300 ms click settle plus 1000 ms `FINAL_SETTLE_MS`). E07 measured one run per point: a duplicate of 9 at about 0.7 s and about 1.2 s is caught, but at about 1.35 s and about 1.5 s it **still passes** (`DOTTIE_SMOKE_OK`, exit 0), because the app has already exited. AC 1 asks for "up to 1 s", so it is met as specified. A duplicate arriving later than about 1.2-1.35 s after the last close is outside what the smoke can see.

## Recorded mis-built fault (kept, not deleted)
`20261019T055610-0500_…_DOT099-FAULT-F2-misbuilt-dup-of-f_*` (box copy `/workspace/smoke-logs/5ae9394/fault-F2-misbuilt-dup-of-f/`, patch `patches/F2-misbuilt-dup-of-f.diff.txt`) was my first F2 attempt. It's **relabelled as a duplicate of f** (E07 FU5): it was filed as `…_DOT099-FAULT-F2-stray-dup-d-800ms_*` until the follow-up commit. Only the file names changed. The bytes are unchanged, so the hashes are the same, and the old label is still recorded inside, as the runner wrote it (E07 L4). **Where name and content differ:**
- **File names** (here and in `/workspace/smoke-logs/5ae9394/fault-F2-misbuilt-dup-of-f/`) say `DOT099-FAULT-F2-misbuilt-dup-of-f`.
- **Inside the three files** the old label `DOT099-FAULT-F2-stray-dup-d-800ms` stays:
  - line 1 `caseId` of the log, the summary and the results file;
  - the `command` in the summary and results headers (`--out …/fault-F2-stray-dup-d-800ms --case-id DOT099-FAULT-F2-stray-dup-d-800ms`);
  - the results row's `log` field (the old log file name).

The name is the correct label (a duplicate of **f**). The inner `caseId` is the original record, and I won't rewrite it, because that would change hashed bytes. Its timer pushed "the last reply" when it fired, about 800 ms later, and by then that was codex's own reply `f`, not `d`. So it injected a duplicate of codex's own reply, and that was correctly blamed on `codex.decline` ("for fx64; got 2"), exit 1. The fix behaved correctly; the fault was wrong. The corrected fault (055641) captures d's reply when the timer window closes and pushes it 500 ms after `timer.decline` returns.

## F3b (closed by E01's amendment, arch 202ac23)
*History:* at 6a5f514 this section said F3b was not done and was waiting on E07, because the evidence README allows `incomplete` only in a provisional `.partial` header. E01 then ruled that the existing behaviour closes AC 3 and amended it at arch `202ac23` ("the evidence README's provisional-only rule stands; both shown in the evidence pack"). These two runs show that behaviour.

Both runs used a fresh clone of this worktree at `5ae93948e047bca3ce4efb606acd7ccce22509c1`. `git status --porcelain` printed nothing for the whole tree before and after each run; `node_modules` and `dist/` are ignored. `apps/` is identical between 5ae9394 and 6a5f514. Runner `node scripts/smoke-run.mjs`, Linux box.

**1. Forced runner timeout** (`--runs 1 --timeout-ms 3000 --case-id DOT099-F3B-FORCED-TIMEOUT`). Runner exit **1**; console `run 1/1 TIMEOUT 3051ms`. The final log `20261019T055856-0500_5ae9394_DOT099-F3B-FORCED-TIMEOUT_smoke-log_run001.log`, line 1:
```
{"caseId":"DOT099-F3B-FORCED-TIMEOUT","commit":"5ae93948e047bca3ce4efb606acd7ccce22509c1","dirtyTree":false,"build":null,"installerSha256":null,"startedAt":"2026-10-19T05:58:56.104-05:00","finishedAt":"2026-10-19T05:58:59.156-05:00","command":"electron . --dottie-smoke-test --dottie-smoke-ui (timeout 3000 ms)","exitCode":0,"signal":null,"durationMs":3051,"result":"fail","timedOut":true,"failedStep":null,"run":1,"runner":"linux-box"}
```
The output is kept (27 lines), ending `DOTTIE_SMOKE_RUNNER_TIMEOUT run=1 after 3000 ms; output above kept` and `DOTTIE_SMOKE_RUNNER_RESULT {"run":1,"ok":false,"code":0,"signal":null,"timedOut":true,"ms":3051,"failedStep":null}`. Summary header line 1:
```
{"caseId":"DOT099-F3B-FORCED-TIMEOUT","commit":"5ae93948e047bca3ce4efb606acd7ccce22509c1","dirtyTree":false,"build":null,"installerSha256":null,"startedAt":"2026-10-19T05:58:56.104-05:00","finishedAt":"2026-10-19T05:58:59.156-05:00","command":"node scripts/smoke-run.mjs --runs 1 --timeout-ms 3000 --out /workspace/smoke-logs/5ae9394/forced-timeout --case-id DOT099-F3B-FORCED-TIMEOUT","exitCode":1,"durationMs":3052,"result":"fail","runner":"linux-box"}
```
`result` is `fail`, never `pass`. The per-run `exitCode:0` is Electron's own exit status after the runner's SIGTERM (it shuts down cleanly on SIGTERM). The run failed because `timedOut:true`, and the runner's exit code is 1.

**2. Killed runner** (`--runs 1 --timeout-ms 90000 --case-id DOT099-F3B-KILLED-RUNNER`, runner `kill -9` about 3 s in; the shell reported exit 137). The output folder `/workspace/smoke-logs/5ae9394/killed-runner/` holds **only** `20261019T055859-0500_5ae9394_DOT099-F3B-KILLED-RUNNER_smoke-log_run001.log.partial`. I checked again after waiting 12 s more: **no final `.log`**, no summary and no results file. The `.partial` (23 lines, 3939 bytes) has no `DOTTIE_SMOKE_OK/FAIL/RUNNER` line. Its line 1, the provisional header:
```
{"caseId":"DOT099-F3B-KILLED-RUNNER","commit":"5ae93948e047bca3ce4efb606acd7ccce22509c1","dirtyTree":false,"build":null,"installerSha256":null,"startedAt":"2026-10-19T05:58:59.197-05:00","finishedAt":null,"command":"electron . --dottie-smoke-test --dottie-smoke-ui (timeout 90000 ms)","exitCode":null,"signal":null,"durationMs":null,"result":"incomplete","timedOut":null,"failedStep":null,"run":1,"runner":"linux-box"}
```
Per the evidence README, this `incomplete` artifact is **not a test result**. It is cited only to show what the runner leaves behind when it is killed.

**Side effect seen (not part of AC 3; fixed in the follow-up, see `ADDENDUM-20261019.md`):** at 5ae9394, SIGKILL on the runner orphans its Electron child. It was reparented and still running 33 s later (a normal run takes about 7.6 s), and exited on SIGTERM. A CI job that kills the runner should kill the whole process group.

## Evidence README rules: where they live now
The evidence conventions are now at **E07's `f59fd30` in `/workspace/dottie-e07`** (`docs/evidence/README.md`), not `bfacd64` (the shared checkout copy that the earlier text in this README and `docs/E06-open-questions.md` cited). The two files are byte-identical (`diff` printed nothing). Checked against what this pack does:
- **Matches:**
  - §3 naming `<YYYYMMDD>T<HHMMSS><±HHMM>_<shortsha>_<caseId>_<artifact>[_<runN>].<ext>`, with explicit offsets and no user names or hostnames.
  - §4 header with every listed field on line 1.
  - `incomplete` only in a provisional `.partial` header written before the run finishes.
  - §1.4: failing and mis-built runs are kept.
  - §5: the secret sweep found nothing.
- **Mismatches / for E07:**
  1. §4 says `incomplete` "must never be cited as evidence". AC 3 (202ac23) asks the pack to *show* the killed-runner `.partial`. I cite it only as proof of runner behaviour, not as a test result. E07 should confirm that reading, or adjust the wording.
  2. §1.3 defines a clean tree as "`git status --porcelain` empty outside `docs/evidence/`". The runner's `dirtyTree` checks only `apps/desktop` (`git status --porcelain -- .`). Here the whole tree was clean too, but the field is narrower than §1.3.
  3. §1.2 says every artifact records the build number and installer SHA-256. These headers carry `build:null` and `installerSha256:null` (Linux box, no packaged build). That's fine for ticket evidence, but not release-grade.
  4. Committed copies use `.log.txt` / `.log.partial.txt` because the root `.gitignore` has `*.log`. The original extensions are on the box and their SHA-256s are listed.
  5. Some header fields (`dirtyTree`, `signal`, `timedOut`, `failedStep`, `run`) go beyond §4's list. They're additive, and §4 doesn't forbid extras.
  6. The caseIds (`DOT099-…`) are ticket-local, not test-plan IDs. §3 asks caseIds to match test-plan or RB IDs "exactly", and none exists for these harness cases.

## Notes
- Each fault was a temporary edit to `apps/desktop/src/main/main.ts`, reverted with `git checkout -- src/main/main.ts` after the run, and `dist/` was rebuilt clean. **None was committed**, and the headers say `dirtyTree:true`.
- Unit tests: 9 new in `apps/desktop/test/smokeSteps.test.ts` (987 total, 17 files).
- **Committed copies and hashes (E07 ruling 4):** the root `.gitignore` ignores `*.log`, so every log is committed byte-for-byte as `<original name>.txt` (`.log` → `.log.txt`, `.log.partial` → `.log.partial.txt`). The rename is recorded in the `*_smoke-logs-sha256.txt` files, not in the headers. Each hash appears twice, on adjacent lines: once with the box original (`clean-5/….log`, relative to `/workspace/smoke-logs/5ae9394/`) and once with the committed copy (`….log.txt`, relative to this folder). Both are the same bytes, so `sha256sum -c --ignore-missing <file>` passes from either directory: 10/10 committed copies and 10/10 box originals.
- Box logs: `/workspace/smoke-logs/5ae9394/` (`clean-5/`, `fault-*/`, `forced-timeout/`, `killed-runner/`, `patches/`, `logs.sha256`; the F3b hashes are also in `…_DOT099-F3B_smoke-logs-sha256.txt`; the SHA-256s are also in `…_DOT099-CLEAN_smoke-logs-sha256.txt` here).
- Secret sweep (skill step 5) over this pack and `/workspace/smoke-logs/5ae9394`: no matches.
