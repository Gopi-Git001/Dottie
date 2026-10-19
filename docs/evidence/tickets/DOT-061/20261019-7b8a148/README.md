# DOT-061 / DOT-090: re-vendor E02 contracts at 2581593 (E01 1z, 2a, 2b, never-cut method), wrapper dropped, E01 2b folded in: evidence for commit 7b8a148 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: c92c38a / b15a50c (241/241).

**Sources (read-only):**
- dottie-e02 `feature/E02-approvals-bridge` **2581593** (pins E01 97e7bc0).
- dottie-e01 492c01c (1z), 972d5f4 (2a), 97e7bc0 (2b).

The vendor target was first cc22afb and was retargeted to 2581593 mid-task. **The vendored files are identical at cc22afb and 2581593:** `git diff cc22afb 2581593` over canonical.ts, display.ts, enums.ts and vectors.json is empty. That confirms E02's "no vector or hash changed".

**Vendored (verbatim, blob = E02's):**

| file | blob |
|---|---|
| canonical.ts | `36bfbaf` |
| display.ts | `999fe80` (the only file changed vs 895676d) |
| enums.ts | `48e25aa` |
| vectors.json | `3a16a78` (sections displays 41, displayCuts 9, actionId 23, actionIdInvalid 17, displaysInvalid 57) |

The five 2b negative event fixtures are vendored too: `a710e49` (tool), `9bbe6b2` (pre_dispatch), `56d5ccc` (ui_action), `afd9ca6` (codex_command), `6e38428` (codex_file_change). NOTICE, the three SHA256SUMS files and the blob-id test were updated.

| file | case | result |
|---|---|---|
| `*_revendor-red1_tap.txt` | vendored 2581593 + new 1z/2a/never-cut tests on c92c38a src | **RED: 240 pass / 3 fail (243)** (the method was still being cut) |
| `*_2b-red-R10_tap.txt` | final tests, 2b category check removed | **RED: 245 / 8 fail (253)** |
| `*_2b-red-R12_tap.txt` | final tests, Codex read/navigate raised to local_change | **RED: 248 / 5 fail (253)** |
| `*_revendor-hashes_table.txt` | 895676d entries recomputed on the 2581593 code (port + vendored `computeDisplayHash`); new displays | **70/70 earlier hashes, 0 differences**; **7/7 new, 0 differences** |
| `*_revendor-mutation_summary.txt` | R1–R13 | **12/13 killed**; R5 equivalent |
| `*_revendor-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 7b8a148 | **GREEN: 253/253**, exit 0, 0 vulnerabilities |

**The 70 earlier hashes:** 23 actionId, 34 displays, 9 displayCuts and 4 pathBindings.

**The 7 new displayHashes** match the given prefixes:
- `8c5fb1b8…` pre_dispatch read
- `956eb33b…` pre_dispatch navigate
- `c1067656…` codex_command read
- `ba82e371…` codex_file_change navigate
- `52bc8f64…` flipped pre_dispatch read
- `9d8dc7c2…` ui_action method 64
- `0f0e17c3…` tool method 64

Every section runs through the vendored code, the port, our builders and validateEvent (test/e02Vectors.test.ts). All 57 invalid displays are rejected by the vendored validator, the port hash and validateEvent, and the 16 that are 1z / 2a / never-cut are also refused by our builders. The superseded-vector exemption is gone.

**Removed (now covered by the vendored validator):** `validateDisplayUntilRevendor` and its uses (builders' gate, validateEvent, port hash), covering:
- 1z regex;
- 2a kind-scoped coverage;
- credential_access rejected for every kind;
- the never-cut method.

`isUiActionMethod` and `UI_ACTION_METHOD_RE` now re-export E02's. The port's `computeDisplayHash` is E02's again.

**Changed in our builders:** `method` is never cut. Over 64 code points gives null (`display_unavailable`) for tool and ui_action (`DISPLAY_HARD_LIMITS.methodCodePoints`); it was removed from `DISPLAY_MAX_LENGTH`.

**Still ours (the vendored code doesn't cover these):**
- **1y prefix guard:** kind `tool` rejects every `ui.`/`window.` method (`hasUiActionPrefix`, builder and validateEvent). E02's tool check now uses the strict 1z regex, so it accepts e.g. a tool `ui.Click` or `window.`. Z17/Z18 (here R1/R2/R3) are therefore **reachable and killed** by the new test "1y prefix rule (OUR guard…)", which shows the vendored validator accepting those methods.
- **Event-level checks** the display validator can't see:
  - display.category = event category (all kinds);
  - the kind/source guard;
  - pre_dispatch risk / possibleRepeat / retryOfTaskId vs the event.
- Our older own checks: the ui_action method check and the maxLen checks in `displayProblems`. These are now redundant with the vendored rules and were left in place.

**E01 2b:**
- **(b) category rule, already implemented:** validateEvent already required display.category = event category for every kind. The rule wasn't new to our code, so red-first is shown by removing it (R10, 8 fail) and by limiting it to tool/pre_dispatch (R11, killed).
- **E02's fixtures:** all five per-kind negative fixtures are rejected at `payload.display.category`, and each one with matching categories is accepted.
- **Our own per-kind tests:** cases for all five kinds, in both directions, including read/navigate for pre_dispatch and the Codex kinds.
- **(a) Codex category pass-through:** our coordinator had no raise. New tests show a Codex read / navigate / local_change / delete approval opens exactly one dialog, keeps its category on the event and in the display, and hashes differently from the local_change version; each is approved. Red-first is shown by reintroducing a raise (R12, 5 fail) or a skip (R13, killed).

**credential_access:** rejected for every kind (builders, validateEvent, vendored validator, port hash; test "2b: credential_access…").

**C-25:** the read retry still goes through approval (test 145 green; R12 and R13 break it).

**R5 is equivalent:** it cuts the ui_action method again, but the cut value `ui.mmm…` fails the vendored 1z regex, so the builder still returns null.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over the pack's log files.
- 8 hits, all the test **name** "… no API-key fallback".
- No credential, token or key value appears.
