# DOT-064: verifier pytest + ruff baseline (Linux box)

E11, 2026-10-19T01:04:29-05:00 (CDT). Linux box only, Linux fakes only; **not** Windows evidence (no Windows build; `win32_backend.py` is not executed, see DOT-031).
`src/` is git-ignored, so commit 6c05524 does not contain the verifier; the tree is dirty. The code is bound by `srcVerifierContentSha256` = `3a8181bc425948b00c7db7199c409699bc49c34f12609be80da5d0b33e477abb` (39 files). No build and no installer, so `build` and `installerSha256` are null.

| file | case | result |
|---|---|---|
| `*_DOT-064-pytest_log.txt` | `python3 -m pytest -q -p no:cacheprovider`, fresh shell | pass: 400 passed, 0 failed |
| `*_DOT-064-pytest_junit.xml` | same run, JUnit XML (hostname attribute redacted) | pass |
| `*_DOT-064-pytest_results.json` | per-test name/status/duration, derived from the JUnit XML | 400 passed / 0 failed / 0 error / 0 skipped |
| `*_DOT-064-lint_ruff-log.txt` | `uvx ruff@0.17.1 check .` | pass |
| `*_DOT-064_environment.json` | OS, kernel, Python/pytest/uv/ruff versions, git tree state | n/a |
| `*_DOT-064_baseline-ratchet.json` | DOT-064 pytest floor 230 -> 400 (up only) | allowed |
| `*_DOT-064_secret-sweep.txt` | skill step 5 sweep + host/user-path/email check | clean |

The baseline floor in `arch/BACKLOG.md` (DOT-064 acceptance 4) still reads >= 230; arch/ is not edited by E11, so E01 needs to raise it to 400 citing this pack. Test names contain `<user>`/`<USER>` placeholder paths from the synthetic fixtures, not real user names.
History: three earlier generations of this pack (01:03-01:04 CDT, same code, same 400 passed / ruff clean) were discarded unedited per README §5 after the sweep hit them, and the pack was regenerated each time: (1) the user-path pattern matched the `<USER>` placeholder in two `test_paths` test ids (fixture paths, not a real user; the pattern now requires a real name after the profile folder); (2) the redactor rewrote those placeholder test ids, the sweep file repeated the sweep patterns literally, and the pack embedded the generator script; (3) the sweep file's description named two set-2 tokens literally. No secret or personal value was ever found. All of this pack's files come from one fresh run.
The generator script is not stored in the pack (it necessarily contains the sweep patterns and box paths, which would trip a later sweep); its SHA-256 is in `manifest.json` (`generator`).
Seal check: `python3 -c` over `manifest.json` (see `sealMethod`).
