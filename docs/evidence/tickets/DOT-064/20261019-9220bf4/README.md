# DOT-064: verifier pytest + ruff baseline from commit 9220bf4 (Linux box)

E11, 2026-10-19T01:33:49-05:00 (CDT). Linux box only, Linux fakes only; **not** Windows evidence (no Windows build; `win32_backend.py` is not executed, see DOT-031).
The code is the committed tree of `9220bf42305f94b739929eb9f48e321fee4777bf` on the local branch `feature/E11-verifier` (not pushed): `git archive 9220bf4 src/verifier` was extracted to a temporary directory and the tests and lint ran there. `srcVerifierContentSha256` = `e68e4f3e8bc10d13f046c35a29b58fa1ab71eed6453e9a58601ad7499866ab1b` (40 files). No build and no installer, so `build` and `installerSha256` are null.

| file | case | result |
|---|---|---|
| `*_DOT-064-pytest_log.txt` | `python3 -m pytest -q -p no:cacheprovider`, fresh shell | pass: 455 passed, 0 failed |
| `*_DOT-064-pytest_junit.xml` | same run, JUnit XML (hostname attribute redacted) | pass |
| `*_DOT-064-pytest_results.json` | per-test name/status/duration, derived from the JUnit XML | 455 passed / 0 failed / 0 error / 0 skipped |
| `*_DOT-064-lint_ruff-log.txt` | `uvx ruff@0.17.1 check .` | pass |
| `*_DOT-064_environment.json` | OS, kernel, Python/pytest/uv/ruff versions, git state | n/a |
| `*_DOT-064_baseline-ratchet.json` | DOT-064 pytest floor 400 -> 455 (up only) | allowed |
| `*_DOT-064_secret-sweep.txt` | skill step 5 sweep + host/user-path/email check | clean |

Previous floor: 400, from `docs/evidence/tickets/DOT-064/20261019-6c05524`. That pack stays sealed and unchanged; this is a new pack, not an edit. The interim 426-passed run at `410b59e` was reported but not packed. `arch/BACKLOG.md` (DOT-064 acceptance 4) is E01's to raise to 455, citing this pack.
Test names contain `<user>`/`<USER>` placeholder paths from the synthetic fixtures, not real user names. The generator script is not stored in the pack (it contains the sweep patterns); its SHA-256 is in `manifest.json` (`generator`).
Seal check: recompute `sealMethod` over `manifest.json` minus `seal`.
