# DOT-099 follow-up evidence: b370fa4 (E07 review 502ae6f FU1/FU3/FU4), Linux box

Commits: `c5a9f3db36816eeef708e49cbc38a6a369aae3f0` (follow-ups) and `b370fa491ef67f9c29983329340a3af96f3e0711` (abort race fix found by the c5a9f3d proof), on top of `e186015`. This is **Linux-box** evidence (`runner: linux-box`), not Windows; the process-group code is POSIX, and Windows uses `taskkill /T /F`, which isn't exercised here. Times are CDT (−05:00); the supervisor's `at` is UTC (`Z`). Every run was made in the committed worktree with `dirtyTree:false` (whole repo, excluding `docs/evidence/`), **except** the deliberately dirty FU3 check `DOT099-FU3-DIRTY-rootfile`. That one ran with an untracked file at the repo root on purpose and records `dirtyTree:true` (see FU3 below; E07 L4). It was never pushed. Index: see `ADDENDUM-20261019.md` in `../20261019-5ae9394/`.

## FU1: no orphan Electron
`…_DOT099-FU1-ORPHAN-PROOF_proof-script.sh.txt` produced `…_process-count-trace.txt`. It counts processes running this app's Electron binary and `smoke-supervisor.mjs` processes:

| case | runner exit | processes before | gone after | at +5 s | left behind in the out folder |
|---|---|---|---|---|---|
| forced timeout (`--timeout-ms 3000`) | 1 | — | — (none at +0 s) | 0 / 0 | final `.log`, summary, results (`result:"fail"`, `timedOut:true`) |
| runner `kill -9` about 3 s into a run | 137 | 8 Electron, 1 supervisor | **185 ms** | 0 / 0 | **only** the `.partial`, ending `DOTTIE_SMOKE_SUPERVISOR {"why":"runner stdin closed","pgid":584219,"wasAlive":true,"escalated":false,"gone":true,"ms":100,…}` |
| runner SIGTERM | 143 | 8 / 1 | 107 ms | 0 / 0 | only the `.partial`, ending `DOTTIE_SMOKE_RUNNER_ABORTED {"why":"SIGTERM","pgid":584454,"wasAlive":true,"escalated":false,"gone":true,"ms":51}` |
| runner SIGINT | 130 | 8 / 1 | 152 ms | 0 / 0 | only the `.partial`, ending `DOTTIE_SMOKE_RUNNER_ABORTED {"why":"SIGINT",…,"ms":105}` |

- None of the three `.partial` files has a `DOTTIE_SMOKE_OK/FAIL` line, so they are runner-behaviour evidence, not test results (E07 ruling 1).
- In these runs Electron always exited on the group SIGTERM (`escalated:false`). The SIGKILL fallback after 2 s is proven by unit test (`test/processGroup.test.ts`: a TERM-ignoring child is SIGKILLed after the grace period).
- The same file also proves: whole-group kill including a grandchild; supervisor kills on parent `kill -9` within 5 s and logs it; `release()` exits without killing; the supervisor exits by itself when the group ends. Those are 6 tests with real processes, skipped on win32.

Forced-timeout final header (line 1):
```
{"caseId":"DOT099-FU1-FORCED-TIMEOUT","commit":"b370fa491ef67f9c29983329340a3af96f3e0711","dirtyTree":false,"dirtyTreeScope":"repo, excluding docs/evidence/","build":null,"installerSha256":null,"buildNote":"n/a: unpackaged","startedAt":"2026-10-19T06:17:08.151-05:00","finishedAt":"2026-10-19T06:17:11.210-05:00","command":"electron . --dottie-smoke-test --dottie-smoke-ui (timeout 3000 ms)","exitCode":null,"signal":"SIGTRAP","durationMs":3059,"result":"fail","timedOut":true,"failedStep":null,"run":1,"runner":"linux-box"}
```
Electron's main process now ends with `SIGTRAP` (at 5ae9394 it was exit 0). Its helper processes get the group SIGTERM at the same moment, and the main process aborts on that. The run fails either way (`timedOut:true`).

`kill -9` provisional header (line 1 of the `.partial`):
```
{"caseId":"DOT099-FU1-RUNNER-SIGKILL","commit":"b370fa491ef67f9c29983329340a3af96f3e0711","dirtyTree":false,"dirtyTreeScope":"repo, excluding docs/evidence/","build":null,"installerSha256":null,"buildNote":"n/a: unpackaged","startedAt":"2026-10-19T06:17:16.340-05:00","finishedAt":null,"command":"electron . --dottie-smoke-test --dottie-smoke-ui (timeout 90000 ms)","exitCode":null,"signal":null,"durationMs":null,"result":"incomplete","timedOut":null,"failedStep":null,"run":1,"runner":"linux-box"}
```

### Recorded failures before b370fa4 (kept)
- `…_c5a9f3d_DOT099-FU1-ORPHAN-PROOF-V1-EXITCODE-BUG_process-count-trace.txt` and the `061425`/`061433`… c5a9f3d logs: my first proof script printed every runner exit as 0, because `$(ts)` inside the `echo` reset `$?`. That was a bug in the script, not the runner, and it was fixed in the second script. The process counts in that trace are valid (none left).
- `…_c5a9f3d_DOT099-FU1-ORPHAN-PROOF_process-count-trace.txt` and the c5a9f3d `RUNNER-SIGTERM` files (`061525`, and in the v1 attempt `061441`), plus the v1 `RUNNER-SIGINT` files (`061450`; the v2 SIGINT at `061533` happened to win the race): this is a **real runner bug**. On SIGTERM, the abort handler killed the group, and the run's normal close path won the race: it wrote a final `fail` log, removed the `.partial` and exited 1, not 143. There was still no orphan. **Fixed in b370fa4:** an abort owns the ending, and the close path and the timeout timer do nothing while it runs. The b370fa4 rerun above shows exit 143 and only the `.partial`.

## FU3: whole-repo dirtyTree, and FU4: buildNote
- Each check was a short 1 s-timeout run (`dirty-check/…`), reading line 1:
  - clean: `"dirtyTree":false`
  - an untracked file at the **repo root**: `"dirtyTree":true` (before the fix, the `apps/desktop`-only check would have missed it)
  - an untracked file under `docs/evidence/`: `"dirtyTree":false`
- Every header carries `"dirtyTreeScope":"repo, excluding docs/evidence/"` and `"buildNote":"n/a: unpackaged"`.

## Clean runs
5 × `npm run smoke:ci -- --runs 5 --case-id DOT099-FU-CLEAN` at b370fa4: **5/5 pass**, 0 timed out, 7594 / 7616 / 7701 ms (min / median / max), runner exit 0. Every `groupLeftover` was `null` (nothing of a run was left once it closed), and there were 0 Electron processes afterwards.

## Files and hashes
`…_DOT099-FU_smoke-artifacts-sha256.txt` lists each hash twice: with the box original (relative to `/workspace/smoke-logs/`) and with the committed copy here (`.log`/`.partial` → `+ .txt`, byte-identical; E07 ruling 4). It covers 40 artifacts, and `sha256sum -c --ignore-missing` passes from either directory. Box folders: `/workspace/smoke-logs/b370fa4/` and `/workspace/smoke-logs/c5a9f3d/`. Secret sweep (skill step 5) over this folder and both box folders: no matches.
