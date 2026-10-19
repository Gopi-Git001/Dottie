# DOT-061: E01 ruling 1z (UI-method regex; delete/overwrite paths + fileCount) and ruling 2a (coverage rule scoped to kind `tool`), in our layer UNTIL E02 RE-VENDOR: evidence for commit c92c38a (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 96afea0 / 9f04827 (238/238).

**Sources (read-only):** dottie-e01 492c01c (ruling 1z), 972d5f4 (ruling 2a). The vendored E02 files stay at **895676d**, unchanged (blobs and SHA256SUMS verified; `git diff 96afea0 -- src/vendor test/fixtures` is empty). 455ce18 was **not** vendored, as instructed. The re-vendor waits for E02's 2a-fixed commit.

| file | case | result |
|---|---|---|
| `*_z1z2a-red1_tap.txt` | 96afea0 src + new 1z/2a tests + restored C-25/contracts tests (before the vector-supersede edit) | **RED: 233 pass / 8 fail (241)** |
| `*_z1z2a-red2_tap.txt` | 96afea0 src (stashed) + the final c92c38a tests | **RED: 232 pass / 9 fail (241)** |
| `*_z1z2a-mutation_summary.txt` | Z1–Z19 + Z5b | **16/19 killed** first pass; Z5 was killed only by a tsc error, so it was re-run as Z5b (compiles): KILLED. Survivors Z6, Z17, Z18 are equivalent (below) |
| `*_z1z2a-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on c92c38a | **GREEN: 241/241**, exit 0, 0 vulnerabilities |

**What changed (all marked "UNTIL E02 RE-VENDOR" in code):**
- `validateDisplayUntilRevendor` (src/display.ts) runs the vendored `validateApprovalDisplay` and, in front of it:
  - 2a: drops its `display.category has no display rule` issue for kinds `pre_dispatch` / `codex_command` / `codex_file_change` with category `read` or `navigate`; every other field is still checked by the vendored code;
  - 1z: adds the `^(ui|window)\.[a-z][a-z0-9_]*$` check for kind `ui_action`.
- It gates every builder and `validateEvent`. `contractsActionIdPort.computeDisplayHash` = that check + `sha256Hex(canonicalJson(d))` from the vendored canonical.ts (the same rule as E02's `computeDisplayHash`, which would throw on read/navigate).
- Kind `tool` still rejects every `ui.`/`window.` prefix (1y prefix rule, `hasUiActionPrefix`).

**Ruling cases tested:**
- **1z method:** `ui.`, `window.`, `ui.Click`, `ui.1x`, `uix.click`, `ui.click.extra`, `UI.click`, `ui._x`, `ui.cl-ick`, a trailing space, `app.launch` and `ui` are rejected by both the builder and validateEvent. `ui.click`, `window.close`, `ui.key_press`, `window.minimize` and `ui.x1` are accepted.
- **1z delete/overwrite:** a single item gets `fileCount: '1'` (a **string**, matching E02 455ce18). Missing `paths`, missing `fileCount`, numeric `1`, `'2'` for one path and a non-list `paths` are each rejected; two items with `'2'` are valid. **This test passed already in red:** the vendored 895676d key sets and `count` check enforce it, so no extra check of ours was needed; the test pins it in our layer.
- **2a:** pre_dispatch/codex_command/codex_file_change in read and navigate validate and hash to `sha256Hex(canonicalJson(d))`. ui_action read/navigate are rejected. Tool read/navigate are rejected, and hashing them throws. credential_access is refused for codex and pre_dispatch. Other limits (summary 500, fileCount) are still enforced on read/navigate displays.

**Test changes (for review):**
- **Restored to pre-96afea0 (69e4055) expectations, per 2a:**
  - C-25 "read-category retry" (it goes through approval, no possibleRepeat);
  - C-25 1f b and C-25 1g;
  - contracts "every event validates" and "category enum: navigate accepted".
- **1v CUT test:** a ui_action method at 65 code points was cut to `ui.…`. Under 1z the cut value isn't a method name, so the builder now returns null (`display_unavailable`); 63 and 64 are unchanged.
- **E02 vector superseded by 2a:** the 895676d displaysInvalid vector "read has no display rule" is kind `pre_dispatch`. It is now asserted **valid**; the other 46 are still rejected. The two other coverage vectors are kind `tool` (navigate, credential_access) and stay rejected. This edit came after red1, so red2 re-runs the final tests against the old src.

**Equivalent mutants (until the re-vendor):**
- **Z6:** drops the ui_action builder's input-method check. The post-cut gate check rejects every input it would reject.
- **Z17/Z18:** the tool prefix check uses the strict regex. The vendored 895676d tool check already rejects every `ui.`/`window.` prefix. After the re-vendor, if E02's tool check uses the strict regex, our prefix check becomes the only guard; this needs another look then.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over this pack.
- 6 hits, all the test **name** "… no API-key fallback".
- No credential, token or key value appears.
