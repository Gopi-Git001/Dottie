# DOT-099 follow-ups review: process-group kill, supervisor, abort race, dirtyTree, buildNote (E06 c5a9f3d + b370fa4 code, aeb2f35 evidence)

- **Reviewer:** E07 QA, required reviewer. Date: 2026-10-19, 06:20–06:45 CDT (UTC-5).
- **Subject:** `c5a9f3db36816eeef708e49cbc38a6a369aae3f0` and `b370fa491ef67f9c29983329340a3af96f3e0711` (code), `aeb2f35` (evidence), on top of `e186015`, on E06's local, unpushed branch in `/workspace/dottie-e06`. Pack: `docs/evidence/tickets/DOT-099/20261019-b370fa4/` plus `ADDENDUM-20261019.md` and edits in `../20261019-5ae9394/`.
- **Follows:** my DOT-099 review `502ae6f` (FU1 orphan Electron, FU2 late-dup window, FU3 dirtyTree scope, FU4 buildNote, FU5 mis-built F2 label) and the rulings in `1fd4c4f` (evidence README v0.2).
- **Where it ran:** Linux box, Node 22.23.3, Xvfb, fresh clone `/tmp/e07-b370` at b370fa4. **Not Windows evidence.** Windows `taskkill /T /F` (the `isWin` branch of `process-group.mjs`) is **untested here and owned by the PC session.**
- **What I didn't touch:** `/workspace/dottie-e06` (HEAD `aeb2f35`, `git status --porcelain` empty before and after) and the shared `/workspace/dottie` checkout. Nothing pushed.
- **My artifacts:** `/workspace/smoke-logs/b370fa4-e07/` (all logs, console files, scripts `scenarios.sh`, `race.sh`/`race.mjs`, `faults.sh`, `dirty2.sh`, `ekill.sh`, `crash.cjs`, the `C-W1-delay.diff` fault, and `logs.sha256` over 138 artifacts). Every scenario was run one at a time under `xvfb-run`.

## Verdict: **APPROVE**
FU1 is fixed on Linux: in every kill path I tried (runner `kill -9`, SIGTERM, SIGINT, uncaught exception, untrappable SIGABRT, forced timeout, normal pass, fail) no Electron and no supervisor was left, and the group was gone within 16–126 ms. The supervisor only ever signals the Electron group it was given; sentinels in a separate group and in the runner's own group/session survived every path, and two runners (sequential and concurrent) never hit each other. The b370fa4 abort-owns-ending fix never turned a pass into a fail or a fail into a pass in 27 injected races; when a signal lands, the run is recorded as `incomplete` (only a `.partial`, runner exit 130/143), never as `pass`. FU3 and FU4 work as described. Unit tests 993/993, typecheck and lint clean, smoke:ci 5/5, and the reply-sequence faults behave exactly as at 5ae9394. The findings below are low and don't block.

## 1. Diff review (`git diff e186015..b370fa4`)
Changed: `apps/desktop/scripts/{process-group.mjs (new, 91), process-group.d.mts (new), smoke-supervisor.mjs (new, 48), smoke-run.mjs (+69/-14)}`, `apps/desktop/test/processGroup.test.ts` (new, 6 tests), `docs/E06-open-questions.md`, and the 5ae9394 pack (renames + hash-file/README edits). **`apps/desktop/src/**`, `package.json` and `package-lock.json` are unchanged** (`git diff --quiet e186015 b370fa4 -- …` = 0), so the smoke's assertions are byte-identical to the accepted 5ae9394.

Nothing loosened: no `.skip`/`.only`/retry added. The only skip is `describe.skipIf(win32)` on the new POSIX process tests (`test/processGroup.test.ts:52`). The runner-timeout escalation got **tighter** (child SIGKILL after 5 s → group SIGKILL after 2 s, `smoke-run.mjs:135`). The pass condition is unchanged: `ok = !timedOut && code === 0 && /^DOTTIE_SMOKE_OK /m` (`smoke-run.mjs:146`).

## 2. E01 (A): can the supervisor outlive a run?
How it ends (`smoke-supervisor.mjs`): it exits on `done` from `release()` (line 37–42), or kills the group and exits on stdin EOF/error (43–44) or a ppid change (46), and every 250 ms exits by itself once the group is gone (47). The runner calls `release()` on every normal close (`smoke-run.mjs:143`) and in `abort()` (97).

Measured (`scenarios.sh`, `faults.sh`; after each run, `ps` by Electron pgid, by supervisor pid/ppid, and a grep for any `smoke-supervisor`/this clone's Electron/`smoke-run.mjs` process):

| case | runner exit | artifacts | Electron group members after | supervisor alive after | any left |
|---|---|---|---|---|---|
| normal pass (A1) | 0 | final log `pass`, summary, results | 0 | no | 0 |
| fail (H1–H5, see §7) | 1 (H2b/H2c 0, known FU2) | final log `fail` | 0 (each of 7) | no (each) | 0 |
| forced timeout 3000 ms (A3) | 1 | final log `fail`, `timedOut:true`, `signal:"SIGTRAP"` | 0 | no | 0 |
| runner crash: uncaughtException (A4a, `crash.cjs` throw at 3 s) | 1 | only `.partial`, `DOTTIE_SMOKE_RUNNER_ABORTED {"why":"uncaughtException: E07 injected runner crash",…,"gone":true,"ms":101}` | 0 (gone 19 ms after runner exit) | no | 0 |
| runner crash: `process.abort()` (A4b, SIGABRT, not trappable) | 134 | only `.partial`, `DOTTIE_SMOKE_SUPERVISOR {"why":"runner stdin closed",…,"gone":true,"ms":100}` | 0 (gone 72 ms after runner exit) | no | 0 |

**Answer (A): no.** In all five kinds of ending, nothing of the run was left 0.5 s later. `crash.cjs` was injected with `NODE_OPTIONS=--require` and acts only when `argv[1]` ends in `smoke-run.mjs`, so it crashed the runner only.

## 3. E01 (B): can it kill anything outside its group?
**Code read.** Every signal goes through `signalGroup(pgid)` = `process.kill(-pgid, sig)` (`process-group.mjs:47`); there is no kill by bare pid on POSIX. The pgid is always `child.pid` of the Electron spawned with `detached:true` (`smoke-run.mjs:120–122`), i.e. a new group led by Electron, which can never be the runner's or the shell's group. The supervisor is detached into its own group (`process-group.mjs:81`) and rejects `pgid <= 1` or non-integers (`smoke-supervisor.mjs:16`). No pid file is used anywhere, so there's no stale-pid-file path. Pid reuse needs the group to have fully died and a new group leader to get the same pid inside the 250 ms poll or the 2 s grace; with `pid_max` = 4194304 that's theoretical (note, not a finding).

**Tests.** Sentinel S1 = `setsid sleep 900` (own session and group); S2 = `sleep 900 &` from the launching shell, i.e. **same pgid and session as the runner** (shell pgid 590356 = runner pgid 590356 = S2 pgid; Electron pgids were their own pids, supervisors their own pids). Both were alive after every path in §2 and §4, after the two-runner runs below, and after starting the supervisor with `0`, `1`, `-5`, `abc` (each exits 2 immediately). I killed them myself at the end.

Two runners:
- **Sequential:** R1 `kill -9` at 3 s (its group gone in 43 ms), then R2 normal: R2 exit 0, `run 1/1 OK`; R1's supervisor gone; nothing left.
- **Concurrent** (separate `XDG_CONFIG_HOME`, so Electron's single-instance lock doesn't interfere): R2 `kill -9` at 3 s → R2's group gone in 71 ms, R1's group still alive right after, R1 then `OK` exit 0. **Reverse:** R1 `kill -9` → gone in 68 ms, R2 still alive, R2 `OK` exit 0. Nothing left either time.

**Answer (B): no**, with one defence-in-depth gap (L1): the helpers in `process-group.mjs` don't validate the pgid themselves. `groupAlive(null)` returns `true` (I checked: `-null` is `-0`, so `kill(0)` probes the caller's own group), so `killGroup(null)` would SIGTERM the runner's own group, and `killGroup(1)` would be `kill(-1)`. Neither is reachable today (`child.pid` is a positive integer or `undefined`, and `undefined`/`NaN` make `process.kill` throw, so `groupAlive` returns false), but the same `pgid > 1` guard as the supervisor should live in `process-group.mjs`.

## 4. E01 (C): can abort-owns-ending flip a result?
**Race logic (b370fa4).** `abort()` sets `aborting = true` first (`smoke-run.mjs:85–86`), takes `current`, kills the group, flushes the `.partial`, appends `DOTTIE_SMOKE_RUNNER_ABORTED`, releases the supervisor and exits 130/143/129/1. The close path returns early while `aborting` (142), and the timeout timer does nothing while `aborting` (132). `ok` is computed only from the real Electron exit code, the OK line and `timedOut`; nothing in the abort path can set it. A signal that lands **after** the close path has set `current = null` makes `abort()` exit straight away with 130/143.

**Injected races** (`race.mjs` polls the run's log every 2 ms, then signals the runner `<offset>` ms after the line appears; "left" = processes left):

| ending | signal, offsets | outcome |
|---|---|---|
| real OK (clean build) | SIGTERM at 0, 2, 5, 10, 20, 40, 55 ms (7 runs) | runner 143, only `.partial` (`result:"incomplete"`), OK line present, ABORTED line present, no summary, left 0 |
| real OK | SIGTERM at 45, 50, 60–80 ms (7 runs); the runner had already finished | runner 0, final `pass`, Electron exit 0, OK line, summary `pass`, left 0 |
| real OK | SIGINT at 0, 5, 20 ms | runner 130, only `.partial` `incomplete`, ABORTED line, left 0 |
| real FAIL (H4 build, `final.replySequence`) | SIGTERM at 0, 5, 10, 20, 40 ms | runner 143, only `.partial` `incomplete`, FAIL line present, ABORTED line, left 0 |
| real FAIL | SIGTERM at 60, 100 ms (already finished) | runner 1, final `fail`, exit 1, FAIL line, summary `fail` |
| real FAIL | SIGINT at 0, 20 ms | runner 130, only `.partial` `incomplete` |
| OK, signal **after** `current = null` (fault `C-W1-delay.diff`: a 1500 ms delay right after `current = null`, SIGTERM at OK+400 ms) | — | runner 143, only `.partial` `incomplete`, OK line present, **no** ABORTED line (L2), no summary, left 0 |
| Electron itself SIGTERM/SIGINT at 4 s (assertions not complete) | — | Electron exit 0, no OK/FAIL line; runner exit 1, final `fail` (L3) |

**Answer (C): no flip seen.** In all 27 races, final header result, runner exit code and the OK/FAIL line agreed: either a final log matching what Electron really did (pass + OK + 0, or fail + FAIL + 1), or only an `incomplete` `.partial` with a non-zero runner exit and no summary. A pass was never reported when assertions hadn't completed: the Electron-killed runs exit 0 without an OK line and are still reported `fail`. The c5a9f3d race that E06 found and kept (a SIGTERM producing a final `fail` log and exit 1) did not recur at b370fa4.

## 5. FU1 orphan timings (repeat of my 5ae9394 test)
At 5ae9394 Electron was orphaned and still alive at t+30 s. At b370fa4 (signal to the runner ~3 s into a run; then `pgrep -g <electron pgid>` every 10 ms):

| signal | runner exit | time until no Electron, from the signal | who killed it |
|---|---|---|---|
| `kill -9` | 137 | **73 ms** | supervisor (`runner stdin closed`, `escalated:false`) |
| SIGTERM | 143 | **126 ms** (runner waits for the group, so 16 ms after the runner's exit) | runner `abort()` |
| SIGINT | 130 | **74 ms** | runner `abort()` |
| (two-runner runs) `kill -9` | 137 | 43 / 71 / 68 ms | supervisor |

All within E06's "185 ms". The SIGKILL escalation was never needed (`escalated:false` every time); it's covered by E06's unit test with a TERM-ignoring child, which passes.

## 6. Unit tests, typecheck, lint, clean runs
- `npx vitest run`: **18 files, 993 passed (993)** (987 at 5ae9394 + 6 in `processGroup.test.ts`). The unit run left no processes behind.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0.
- `npm run smoke:ci -- --runs 5 --timeout-ms 90000 --case-id SMK-DESK-01`: **5/5 OK**, 7486 / 7500 / 7560 ms (min / median / max), runner exit 0, `groupLeftover:null` ×5, `assertionsPassed:true` ×5, nothing left afterwards. Header: `"dirtyTree":false,"dirtyTreeScope":"repo, excluding docs/evidence/","build":null,"installerSha256":null,"buildNote":"n/a: unpackaged"`.

## 7. Reply-sequence fault injections (no regression)
Same `*-main.ts` patches as my 5ae9394 review (`/workspace/smoke-logs/5ae9394-e07/patches/`; `orig-main.ts` is byte-identical to b370fa4's `main.ts`), each built and run once:

| id | result at b370fa4 | same as 5ae9394? |
|---|---|---|
| H1 dup of 9 ~700 ms | FAIL `after:bound.decline`, exit 1 | yes |
| H2a dup of 9 ~1200 ms | FAIL `after:bound.decline`, exit 1 | yes |
| H2c dup of 9 ~1350 ms | OK, exit 0 (not seen; FU2 window, documented) | yes |
| H2b dup of 9 ~1500 ms | OK, exit 0 (not seen; FU2 window, documented) | yes |
| H3 dup of d during codex | FAIL `after:timer.decline`, exit 1 | yes |
| H4 bound wrong value | FAIL `final.replySequence`, exit 1 | yes |
| H5 bound wrong actionId | FAIL `bound.decline`, exit 1 | yes |

Every one: group members 0 and supervisor gone afterwards. The clone was restored and rebuilt (`git status --porcelain` empty).

## 8. FU3 dirtyTree and FU4 buildNote
`dirty2.sh`, short 3 s-timeout runs, reading line 1 of the log and of the summary:

| tree state | porcelain | header / summary `dirtyTree` |
|---|---|---|
| clean | (empty) | false / false |
| untracked file at repo root | `?? e07-untracked.txt` | **true / true** |
| modified `docs/E06-open-questions.md` (outside apps/desktop and docs/evidence) | ` M docs/…` | **true / true** |
| modified tracked file **and** untracked dir under `docs/evidence/` only | ` M docs/evidence/…`, `?? docs/evidence/e07tmp/` | **false / false** |
| modified `apps/desktop/README.md` | ` M apps/desktop/README.md` | true / true |
| clean again | (empty) | false / false |

Code: `git -C <repo root> status --porcelain -- . ':(exclude)docs/evidence'` (`smoke-run.mjs:64`), matching evidence README §1.3 v0.2. `buildNote:"n/a: unpackaged"` and `dirtyTreeScope` are in every header I produced and in every smoke-log header in E06's pack (the 5ae9394-era files are, as disclosed, not rewritten). Matches README §4.

## 9. Evidence pack (aeb2f35, and c5a9f3d's edits to the 5ae9394 pack)
- `…_DOT099-FU_smoke-artifacts-sha256.txt`: 80 lines = 40 artifacts × (box original, committed `.txt` copy). `sha256sum -c --ignore-missing` gives **40 OK** in the pack and **40 OK** from `/workspace/smoke-logs/`, 0 failures. The 5ae9394 hash files now have pairs too: 8+8 and 2+2 OK. This is ruling 4 as written.
- Every machine artifact has a header line; secret sweep: the only hits are `"apiKeys":20` (a count in the smoke output) and the README's own words. No secrets.
- E06 kept the failing c5a9f3d proof (the runner abort race and his proof-script `$?` bug) and labelled both. Good practice.
- FU5: the mis-built run was renamed in the pack and on the box, bytes and hashes unchanged, and the README says the inner `caseId` still reads `…stray-dup-d-800ms` (L4).
- The README says "Every run was made … with `dirtyTree:false`", but the intentional `DOT099-FU3-DIRTY-rootfile` check run is `dirtyTree:true` by design (L4, wording only).

## 10. Findings
None block.

| sev | id | finding | where | suggested fix |
|---|---|---|---|---|
| Low | L1 | `process-group.mjs` helpers don't validate pgid: `groupAlive(null)` is true (probes own group), `killGroup(null|0)` would signal the runner's own group, `killGroup(1)` = `kill(-1)`. Not reachable today. | `process-group.mjs:28–73` | `if (!Number.isInteger(pgid) || pgid <= 1) throw` in `groupAlive`/`signalGroup`, plus a unit test |
| Low | L2 | A signal after the close path set `current = null` exits 130/143 with no `DOTTIE_SMOKE_RUNNER_ABORTED` line in the `.partial` (reproduced with a widened window). Result is still truthful (`incomplete`, no summary), just less diagnosable. | `smoke-run.mjs:88, 99–100, 143–144` | keep a reference to the in-flight `.partial` until the final log is written, and append the ABORTED line whenever one exists |
| Low (pre-existing) | L3 | Electron killed mid-smoke (SIGTERM/SIGINT) exits **0** with no FAIL line, so `failedStep` is null. The runner still fails it (no OK line). | `src/main/main.ts` quit path | set `process.exitCode = 1` and print `DOTTIE_SMOKE_FAIL {"reason":"signal"}` if the app quits before OK |
| Low | L4 | Pack wording: the relabelled mis-built file's name caseId differs from its header caseId (disclosed); "every run `dirtyTree:false`" ignores the intentional dirty-check run. | `20261019-5ae9394/README.md`, `20261019-b370fa4/README.md` | one sentence each, next time the packs are touched |
| Info | I1 | On forced timeout Electron's main now ends with `SIGTRAP` (E06 disclosed it). The run fails either way. | — | none |
| Info | I2 | The SIGKILL fallback after 2 s wasn't needed in any of my runs; it's proven only by the unit test. | `test/processGroup.test.ts` | none |
| Info | I3 | Windows `taskkill /T /F` is untested on the box: owned by the PC session. CI should still upload `*.partial` (carried from DOT-098). | `process-group.mjs:38–44` | PC session |

## 11. SMK-DESK-11
It can move from PENDING to **"covered by runner (Linux); CI backup; Windows pending PC session"**: the runner's process-group kill plus the supervisor covered every runner kill path on Linux (§2, §5), and CI killing the job's group/cgroup stays as the backup. With this APPROVE, I made that edit in `docs/qa/test-plan.md` §3.16 as a separate commit. In the same row edit I corrected SMK-DESK-09's escalation from "SIGKILL after 5 s to Electron" to "group SIGTERM, then group SIGKILL after 2 s", which b370fa4 changed.

## 12. Commands (abridged; full scripts in `/workspace/smoke-logs/b370fa4-e07/`)
```
git clone -q /workspace/dottie-e06 /tmp/e07-b370 && git -C /tmp/e07-b370 checkout -q b370fa4   # HEAD b370fa491ef6…
npm run typecheck; npm run lint; npx vitest run                     # 0; 0; 993 passed (993)
xvfb-run -a sh -c "npm run smoke:ci -- --runs 5 --timeout-ms 90000 --case-id SMK-DESK-01"   # 5/5 OK, exit 0
xvfb-run -a scenarios.sh      # A1/A3/A4a/A4b, SIGKILL/SIGTERM/SIGINT timings, sentinels, 2 runners, supervisor 0/1/-5/abc
xvfb-run -a faults.sh         # H1–H5 (§7)
xvfb-run -a race.sh PASS '^DOTTIE_SMOKE_OK ' TERM 0 2 5 10 20 40 80; … INT 0 5 20; PASSW … TERM 45…75
xvfb-run -a race.sh FAIL '^DOTTIE_SMOKE_FAIL ' TERM 0 5 10 20 40 60 100; … INT 0 20   # with the H4 build
E07_D1=1500 xvfb-run -a race.sh W1 '^DOTTIE_SMOKE_OK ' TERM 400                       # with C-W1-delay.diff
xvfb-run -a ekill.sh; xvfb-run -a dirty2.sh
ps -eo args | grep -E "smoke-supervisor|dottie-smoke-test|smoke-run|sleep 900"        # nothing left at the end
```

## Addendum 74673e6 (L1, L4), 2026-10-19 06:41–06:50 CDT
**Subject:** E06 `74673e66a0218717cf5f04d10428e6fef33b577b` on top of `aeb2f35`. Ran in a fresh clone `/tmp/e07-7467`; E06's tree untouched (HEAD `74673e6`, status clean). **Verdict: APPROVE.** L1 and L4 are closed, with no new findings.

- **Diff `aeb2f35..74673e6`:** only `scripts/process-group.mjs` (+`.d.mts` types), `scripts/smoke-supervisor.mjs`, `test/processGroup.test.ts` and the two pack READMEs. `src/**`, `package*.json` and `scripts/smoke-run.mjs` are unchanged (`git diff --quiet` = 0).
- **L1 guard:** `validPgid(p) = Number.isInteger(p) && p > 1` (`process-group.mjs:32`). `groupAlive` returns false before any `process.kill`. `signalGroup` returns before any signal or `taskkill`. `killGroup` returns `{…, refused:true}` before anything else. `killGroupNow` checks it, and `startSupervisor` spawns nothing for an invalid pgid. That covers null, undefined, 0, −0, 1, negatives, NaN, Infinity, floats, strings and objects (`Number.isInteger` is false for all non-numbers). The supervisor now uses the same `validPgid` (`smoke-supervisor.mjs:16`).
- **Tests:** 4 new tests over 13 invalid values. `vi.spyOn(process, 'kill')` with `expect(kill).not.toHaveBeenCalled()` for `groupAlive`, and for `killGroup` plus `killGroupNow`. `startSupervisor` returns `pid: undefined`. **Mutation check:** with only `groupAlive`'s guard line deleted (safe: signal 0 only), the groupAlive test fails at `expect(kill).not.toHaveBeenCalled()` (1 failed, 9 passed). Restored afterwards; clone status clean. I didn't mutate `killGroup`'s guard, because an unguarded `killGroup(0|-1)` would really signal.
- **Counts:** `npx vitest run` **997 passed (997)**, 18 files (993 + 4). Typecheck exit 0, lint exit 0.
- **Smoke:** `npm run smoke:ci -- --runs 2 --case-id SMK-DESK-01`: **2/2 OK** (7578 / 7531 ms), runner exit 0. Header: full commit, `dirtyTree:false`, `buildNote:"n/a: unpackaged"`.
- **Orphan check:** runner `kill -9` about 3 s in: runner exit 137, **no Electron after 70 ms**, supervisor gone, only `…_SMK-DESK-10_smoke-log_run001.log.partial` left, ending `DOTTIE_SMOKE_SUPERVISOR {"why":"runner stdin closed",…,"escalated":false,"gone":true}`.
- **L4:** the 5ae9394 README now lists exactly where name and content differ. I checked the files: the old `caseId` is in line 1 of all three, the old `--case-id` is in the summary and results `command`, and the old log name is in the results row's `log` field. The b370fa4 README now names the deliberately dirty `DOT099-FU3-DIRTY-rootfile` run, which I confirmed records `dirtyTree:true`. Both are accurate.
- **Cleanup:** everything ran under one `xvfb-run -a` (pid 618354, Xvfb 618365 on :99, script 618368, runner 618893, Electron 618908, supervisor 618909). All of them had exited when I checked each recorded pid. Afterwards `ps` showed no Xvfb, `xvfb-run`, smoke, Electron, supervisor or vitest process, and no process with a `/tmp/e07-*` cwd. Logs: `/tmp/e07-7467-logs/`.
