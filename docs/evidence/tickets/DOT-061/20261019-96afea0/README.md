# DOT-061 / DOT-090: swap to E02 computeActionId, re-pin to E02 895676d, E02 strip set, tool keys (1x), UI methods (1y): evidence for commit 96afea0 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 69e4055 / abe7622 (224/224).

**Sources (read-only):**
- dottie-e02 `feature/E02-approvals-bridge` 895676d (CONTRACTS e41d1ca + 1v/c19b751).
- dottie-e01 474c502 (ruling 1x) and c0b36d4 (ruling 1y).

**How E02's code is consumed:** the e03-agent-arch-approval-and-codex-port-wiring skill doesn't say how. I followed the team's vendoring rule (e01/e05 skills): verbatim copies with the source SHA and SHA-256s, never edited.
- **Vendored files:** `src/vendor/e02-contracts/{canonical,display,enums}.ts` and `test/fixtures/e02/vectors.json`.
- **Integrity:** the git blob ids equal 895676d's (`36bfbaf`, `c4bb78a`, `48e25aa`, vectors `5f6a6f1`). A test checks the SHA256SUMS.
- **No runtime dependency:** `package.json` still has no `dependencies`; the files import only Node built-ins.

| file | case | result |
|---|---|---|
| `*_e02swap-red1_tap.txt` | vector + strip + 1x/1y tests on 69e4055 src (port module missing: whole file fails) | **RED: 224 pass / 1 fail (225)** |
| `*_e02swap-red2_tap.txt` | real port wired (`src/actionIdPort.ts`, helpers swapped); display.ts unchanged | **RED: 230 pass / 6 fail (236)** |
| `*_e02swap-hashes_table.txt` | every vector through `contractsActionIdPort` | **83 checks, 0 differences** (23 actionIds, 34 displays, 9 displayCuts, 17 invalid bindings rejected) |
| `*_e02swap-mutation_summary.txt` | X1–X14 | **13/14 killed**. X13 is equivalent; X9 was killed after the gate test was added |
| `*_e02swap-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 96afea0 | **GREEN: 238/238**, exit 0, 0 vulnerabilities |

**Pinned values:** all asserted byte-for-byte in `test/e02Vectors.test.ts`; no hash differed.
- **actionId:**
  - pre_dispatch absent `c950852…6a95`
  - possible repeat `2c0890f…8947`
  - clean-failure retry `60c4800…15ea`
  - navigate `086df44…bc37` (`tool_host`, `displayHash` null)
  - codex command `b07386a…1466`
  - codex file change `e481a03…72c8`
  - ui_action window.close `22e4c17…119a`
- **displayHash:** `1af4547…5a8d`, `f203b61…f8f9`, `3ecef89…e523`, `fbfb108…fc44`, `35d80a6…97a2`, `e571b33…6d5e`.
- **Un-held:** `PRE_DISPATCH_VECTOR_HASH` is now `c95085…6a95`. The coordinator, given task_1 / req_conf, binds exactly the vector object.

**Note on counts:**
- **displayCuts has 9 entries, not 34.** They are max−1/max/max+1 for summary and windowTitle, strip-before-cut, astral and bidi in a bound title. The 34 is the `displays` section. All 9 + 34 run, through E02's hash and through our builders.
- **requestSource error cases:** null, missing and out-of-enum are among the 17 invalid bindings, and all 17 are rejected.

**Test changes made while going green** (changes to the tests, not hashes; listed for review):
- **Red-stage test bugs:**
  - Vector inputs use `{"$number": …}` markers; I added the decode the vectors' `_readme` asks for.
  - The vector `pre_dispatch possible repeat` needs the event's `possibleRepeat` for our pre_dispatch consistency rule.
- **Tool fixtures moved to 1x shapes:**
  - `local_change` now carries `targets`/`itemCount`.
  - tool-kind extra fields are now rejected, not allowed.
  - delete fixtures carry `fileCount`.
- **Read/navigate behaviour change, from the contract:**
  - E02's validator, per CONTRACTS 1l coverage, gives `read` and `navigate` no display rule.
  - Codex read/navigate approvals therefore get `display_unavailable`, and a read pre-dispatch confirmation ends `declined{approval_unavailable}`.
  - Updated tests: C-25 "read-category retry", C-25 1f b (the prior task's read/navigate approvals are declined; the forced-category result is unchanged), C-25 1g (navigate opens no dialog), contracts "every event validates" (category `overwrite`), and contracts "category enum" (navigate rejected for the display rule, not the enum). **Flag for E01:** confirm this is intended.
- **New test with no red run:** the builder-gate test (ui_action processImage as a path → null) was added after the implementation to kill mutant X9.

**X13 is equivalent:** it drops the tool builder's own key check, but E02's validator gate rejects the same input.

**Settled (no provisional marks left for these):**
- Display keys (1v).
- `CodexApprovalRequest.display` names (E02 895676d).
- Tool per-category keys (**settled, E01 1x**).
- UI-action methods `ui.*`/`window.*` (**settled, E01 1y**; `app.launch` is rejected as ui_action and builds as kind `tool`).

**Not done here:** ruling 1x's "Codex `writeStdin` approvals are declined with `display_unavailable`" has no code path yet. This branch's CodexApprovalRequest has no writeStdin kind; an unknown params kind already ends in `display_unavailable`.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over this pack.
- 6 hits, all the test **name** "… no API-key fallback".
- No credential, token or key value appears.
