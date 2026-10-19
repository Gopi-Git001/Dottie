# DOT-064: verifier pytest + ruff baseline from commit 2878b58 (Linux box)

E11, 2026-10-19T01:41:52-05:00 (CDT). Linux box only, Linux fakes only; **not** Windows evidence (no Windows build; `win32_backend.py` is not executed, see DOT-031).
The code is the committed tree of `2878b581743accf77630403cf903e067a0be69ae` on the local branch `feature/E11-verifier` (not pushed): `git archive 2878b58 src/verifier` was extracted to a temporary directory and the tests and lint ran there. `srcVerifierContentSha256` = `2ebccaee1747cf3fd755820a8f4287bab5756b8279b4ee5d3ded06cc2d35d8d9` (41 files). No build and no installer, so `build` and `installerSha256` are null.

| file | case | result |
|---|---|---|
| `*_DOT-064-pytest_log.txt` | `python3 -m pytest -q -p no:cacheprovider`, fresh shell | pass: 485 passed, 0 failed |
| `*_DOT-064-pytest_junit.xml` | same run, JUnit XML (hostname attribute redacted) | pass |
| `*_DOT-064-pytest_results.json` | per-test name/status/duration, derived from the JUnit XML | 485 passed / 0 failed / 0 error / 0 skipped |
| `*_DOT-064-lint_ruff-log.txt` | `uvx ruff@0.17.1 check .` | pass |
| `*_DOT-064_environment.json` | OS, kernel, Python/pytest/uv/ruff versions, git state | n/a |
| `*_DOT-064_baseline-ratchet.json` | DOT-064 pytest floor 455 -> 485 (up only) | allowed |
| `*_DOT-064_secret-sweep.txt` | skill step 5 sweep + host/user-path/email check | clean |

Previous floor: 455, from the sealed pack `docs/evidence/tickets/DOT-064/20261019-9220bf4` (seal `5e113388b5a57055cfcb1cdb6fb200f247f61d0df40a93cc97ef54ad65a5483e`, re-verified before this run). That pack stays sealed and unchanged; this is a new run in a new pack folder, not an edit (skill step 8). The floor ratchets 455 -> 485 from this pack only once it is sealed; the ticket should cite this pack's path. `arch/BACKLOG.md` (DOT-064 acceptance 4) is E01's to raise to 485, citing this pack.
Code in this run: windowClass counted in UTF-16 code units, lone surrogates rejected, and fail-closed handling of incomplete Explorer enumerations (CONTRACTS §3.3/§5, E01 rulings of 2026-10-19).
Test names contain `<user>`/`<USER>` placeholder paths from the synthetic fixtures, not real user names. The generator script is not stored in the pack (it contains the sweep patterns); its SHA-256 is in `manifest.json` (`generator`).
Seal check: recompute `sealMethod` over `manifest.json` minus `seal`.
