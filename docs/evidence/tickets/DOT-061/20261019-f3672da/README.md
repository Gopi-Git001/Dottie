# DOT-061: maximum length + ellipsis on untrusted display slots: evidence for commit f3672da (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 3029c7b / 28aa152 (217/217).

**Source:** `/workspace/dottie-e01/arch/CONTRACTS.md` at HEAD e41d1ca, read-only.
- **L230 (Rendering, 1r):** "fixed maximum lengths with a visible ellipsis (the no-ellipsis exception covers **only** the command field (8 KB) and path lists (500 paths)…; every other field keeps its maximum length plus ellipsis)".
- **L222:** "Exact key names and maximum lengths: E02 in the `ApprovalDisplay` type (DOT-095)".
- **CONTRACTS gives no number** for `reason`, `summary` or `windowTitle`. The only number it states is the `external_send` body (200).
- The limits used here are E02's, from `/workspace/dottie-e02` (read-only): `DISPLAY_MAX`, U+2026, and the cut rule "the last kept position becomes …".
  - summary 500 and windowTitle 256 are committed at fee16aa.
  - reason 500 is only in E02's uncommitted working copy.
  - All three are **PROVISIONAL**.
- **Scope:** CONTRACTS applies the rule to every field except the command and path lists.
  - Applied here: `reasonUntrusted` (codex_command and codex_file_change), `summaryUntrusted` (pre_dispatch), and `app.windowTitle` (ui_action, which CONTRACTS marks "untrusted").
  - The other bound fields wait for E02's numbers.
- **displayHash:** CONTRACTS L226 hashes the canonical display object, so for these slots it covers the cut text that is shown. For the command, L231 says it covers the raw command, and the command is never cut.

| file | case | result |
|---|---|---|
| `*_maxlen-red_tap.txt` | the three new tests on unchanged src (tsc exits 2; JS still emitted) | **RED: 217 pass / 3 fail (220)** |
| `*_maxlen-mutation_summary.txt` | M1–M12 | **12/12 killed**. M11's first kill came from a tsc error; it was re-run as a type-clean mutant and killed by a test |
| `*_maxlen-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on f3672da | **GREEN: 220/220**, exit 0, 0 vulnerabilities |

**Test fix during green:** one expectation in test 2 was wrong. A window title of 256 code points plus U+202E is 257 code points, so it must be cut. The test was corrected; the implementation did not change.

**Not renamed:** the display keys `summaryUntrusted` and `targetLabel`, pending E01.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over this pack.
- 4 hits, all the test **name** "… no API-key fallback".
- No credential, token or key value appears.
