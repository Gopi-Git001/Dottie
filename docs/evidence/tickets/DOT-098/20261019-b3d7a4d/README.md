# DOT-098 evidence: b3d7a4d (E07 recheck of 13f4e3d/80742c2), Linux box

Commit under test: `b3d7a4d01d955da38f213ba93c633d9076cc10fe`. This is **Linux-box** evidence (`runner: linux-box`), not Windows. `build` and `installerSha256` are `null` (no packaged build). Times are CDT (−05:00). Every machine artifact has the dottie-evidence-pack name and the §4 header on line 1.

## Fix for E07's blocker (a)
At the end of the smoke, after `bound.decline` and its 300 ms settle, there is ONE assertion on the full ordered `ApprovalResolved` sequence of (actionId, approved). The expected sequence is:

`ax64/true, bx64/false, cx64/false, dx64/false, fx64/false (codex), ex64/false (join mismatch), 9x64/false (bound)`

- I took this from a real run (`"replySequence"` in every DOTTIE_SMOKE_OK line). Action `8` (the not-active-task request) sends nothing.
- A mismatch throws `SmokeStepAssertion('final.replySequence', …)`, which prints `DOTTIE_SMOKE_FAIL {"reason":"step_assertion","failedStep":"final.replySequence",…}` and exits 1. The error names the first differing position, the expected and actual counts, and the actual list.
- The per-click `exactlyOneReply` checks are kept.
- Unit tests: `replySequenceMismatch` in `apps/desktop/test/smokeSteps.test.ts` (7 new tests, 978 tests total).

## Results
| case | tree | result | exit |
|---|---|---|---|
| `DOT098-E07-RECHECK2`, 5 × `npm run smoke:ci` | clean (`dirtyTree:false`) | **5/5 pass**, 0 timed out, 6531 / 6580 / 6595 ms (min / median / max) | 0 |
| `FAULT-F1-wrong-value`: bound reply `approved:true`, correct actionId | dirty: temporary fault | **FAIL** `final.replySequence`: "differs at #7: expected 9x64/false, got 9x64/true" | 1 |
| `FAULT-F2-wrong-actionId`: bound reply actionId `7x64`, `approved:false` | dirty: temporary fault | **FAIL** `final.replySequence`: "differs at #7: expected 9x64/false, got 7x64/false" | 1 |
| `FAULT-F3-R3-wrong-id-and-true`: E07 R3 (`7x64`, `approved:true`) | dirty: temporary fault | **FAIL** `final.replySequence`: "differs at #7: expected 9x64/false, got 7x64/true" | 1 |
| `FAULT-F4-R2-late-duplicate`: E07 R2 (duplicate pushed after `bound.decline` returned) | dirty: temporary fault | **FAIL** `final.replySequence`: "differs at #8: expected (none), got 9x64/false" (7 expected, 8 got) | 1 |
| `KILLED-RUNNER`: runner SIGKILLed about 3 s into a run | dirty: the runner change before b3d7a4d was committed, so the header says commit 80742c2 | the `.partial` kept its provisional header (`result:"incomplete"`, `finishedAt`/`exitCode`/`durationMs` null) and the output up to the kill | n/a (runner exit 137) |

- The fault diffs are in `patches/` (applied to `src/main/main.ts` one at a time, then `git checkout -- src/main/main.ts`). **None was committed**; `git status` was clean under `apps/desktop` afterwards, and `dist/` was rebuilt clean.
- Box logs: `/workspace/smoke-logs/b3d7a4d/` (`clean-5/`, `fault-F1…F4/`, `patches/`, `logs.sha256`). The SHA-256s are also in `…_smoke-logs-sha256.txt` here.
- Secret sweep (skill step 5) over `docs/evidence/tickets/DOT-098/` and `/workspace/smoke-logs/b3d7a4d`: no matches.
