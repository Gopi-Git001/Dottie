# DOT-061: E01 rulings on 886b251 (pre-dispatch turnId binding, `approval_unavailable`, `navigate` category), evidence for commit 61447a6 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null. This pack supersedes the final log in `../20261019-886b251/`.

Sources:
- `arch/CONTRACTS.md` at E01 6dc905f: the §2.1 "Pre-dispatch confirmation preimage" and the §3 TaskFinished `approval_unavailable` entry;
- the §3 ApprovalRequested category list, which has 11 values.

| file | case | result |
|---|---|---|
| `*_DOT-061-rulings-red_tap.txt` | new and updated tests on unchanged source (src = 886b251). tsc reports the expected `approval_unavailable` type error; JS is still emitted | **RED: 118 pass / 6 fail (124)** |
| `*_DOT-061-rulings-mutation_summary.txt` | M9–M16: binding turnId null, dispatched turn off by one, constant taskId in the binding, no reason on "not approvable", `declined` accepting any reason, `approval_unavailable` missing from the set, `navigate` missing, `navigate` out of order | **8/8 killed** |
| `*_DOT-061-predispatch_vector.json.txt` | the new pre-dispatch vector for E02's fixtures. The hash comes from E02's **uncommitted** `computeActionId` (a /tmp copy; E02's worktree was read only). `FakeActionIdPort` reproduces it in the test suite | `3c60c777…230c` |
| `*_DOT-061-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on the committed tree 61447a6 | **GREEN: 124/124**, exit 0, 0 vulnerabilities |

Notes:
- **Test bug found in the first red run.** The cross-task test reused requestId `req_a`, so request dedupe rightly dropped the second utterance. It was fixed to `req_b` before implementing; the red file is the second red run. In that run, the cross-task test **passes on unchanged source**, because taskId was already in the binding, so there is no red phase for that one test. M11 shows the binding test catches a constant taskId.
- **Vector timing:** exact time not recorded. It was computed shortly before the red run, which is why the filename uses the red-run start; the header times are null.
- **CONTRACTS L135 / §7 change log (L415-417):** both are fixed in current CONTRACTS. The stale text ("`threadId`/`turnId` are Codex details the coordinator should not handle"; "→ `blocked_auth` with `codex_unavailable`") exists only in `/workspace/dottie-import/docs/contracts/CONTRACTS.md` (01:06) and in E01's first snapshot f719696. These are no longer flagged.

## Secret sweep
The pattern was `api[_-]?key|secret|token|password|bearer|authorization:|sk-…|ghp_…|PRIVATE KEY` (case-insensitive) over every file in this pack. There were 4 hits, all the test **name** "plan_limit is never retried … no API-key fallback" (2 in the red log, 2 in the final log). No credential, token or key value appears.
