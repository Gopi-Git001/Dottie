# DOT-095 / E02 approvals bridge v2: CI-equivalent run at 9525cb0

- **Commit under test:** `9525cb0` (branch `feature/E02-approvals-bridge-v2`, based on `main` 079b635). Runner: `linux-box-e02`.
  **Linux only, never Windows evidence.** Unpackaged: `build` / `installerSha256` are `null`, `buildNote: "n/a: unpackaged"`.
- Produced by a script (`run.py`, kept off-repo at `/tmp/e02ev/run.py`). Each `*_log.txt` begins with a one-line JSON
  header (`caseId`, `commit`, `startedAt`/`finishedAt` with offset, `command`, `exitCode`, `durationMs`, `result`,
  `dirtyTree` = `git status --porcelain` outside `docs/evidence/`).
- **Withheld lines:** the pack must pass the evidence secret sweep (`scripts/secret-scan.sh`, `EVIDENCE_PAT`). Test
  *names* match that pattern, so those lines are left out of the committed logs (no values are involved). Two kinds
  match: tests that mention canaries or token keywords, and fixture file names beginning `task-` (the `ta` + `sk-` +
  16 characters matches the `sk-` rule). The second kind includes the passing 2j fixture tests `ok 51`–`ok 54`,
  `valid fixture task-cancelled-{completed-before-stop,null-observed-state-mixed,null-observed-state,stopped-no-side-effects}.json validates`. Each header gives `linesWithheld` and `rawOutputSha256` of the full output, which is kept
  off-repo. Withheld: contracts tests 54 lines, adapter tests 2 lines, all other logs 0.
- Mirrors `.github/workflows/ci.yml` jobs `contracts`, `codex-adapter`, `catalog-pin`, `docs-paths` and `secret-scan`
  (self-test, plus the tree and the PR range `079b635..9525cb0`), plus Node 20, ESLint on Node 20, the Python
  cross-checks and the live 0.163.0 signed-out smoke. Not run here: coordinator, desktop, desktop-smoke, tools,
  verifier, python-repo-lint, week1-probe. This branch does not touch them (they are byte-identical to main).

| caseId | result | detail |
|---|---|---|
| DOT095-ci-contracts-npm-ci / -check / -build | pass | `check` = tsc + codex-generated tsc + eslint |
| DOT095-ci-contracts-vectors-check / -schemas-check | pass | vectors up to date |
| DOT095-ci-contracts-test-node22 (DOTTIE_PYTHON set) | pass | 236 tests, 236 pass, 0 fail, 0 skipped |
| DOT095-contracts-test-node20 (v20.20.2) | pass | 236 / 236 |
| DOT095-contracts-lint-node20 | pass | eslint clean |
| DOT095-ci-adapter-contracts-build / -npm-ci / -check | pass | `check` = tsc + eslint |
| DOT095-ci-adapter-test-node22 | pass | 137 tests, 137 pass, 0 fail, 0 skipped |
| DOT095-adapter-test-node20 | pass | 137 / 137 |
| DOT095-adapter-lint-node20 | pass | eslint clean |
| DOT095-adapter-live-smoke-0163-signed-out | pass | 1 / 1: live 0.163.0 handshake and signed-out account/read (Linux) |
| DOT095-python-action-id-vectors | pass | ok 98 |
| DOT095-python-records-schemas | pass | ok 154 |
| DOT095-ci-catalog-pin / -docs-paths | pass | |
| DOT095-ci-secret-scan-self-test / -history | pass | 0 hits |

Supersedes nothing: the `204f911` pack (same directory parent) is the previous passing run, and it stays. This run adds
`test/ruling-2j.test.ts` (`9525cb0`), whose four tests are visible above in the contracts logs (`ok 232`–`ok 235`,
"ruling 2j: observedState null is ACCEPTED when certainty is 'possible'" / "…REJECTED when certainty is 'committed'…").

Open: **W1-4 restart-retry UNVERIFIED** (thread/resume after an App Server restart, pending E09 W1-4).
