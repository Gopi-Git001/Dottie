# IMPORT-MANIFEST: Dottie monorepo skeleton (import v2)

Built 2026-10-19 (CDT, UTC-5) on the Linux box by the E01 import step. **Staging only: nothing pushed, nothing on GitHub touched.**
Target repo: `Gopi-Git001/Dottie` (PUBLIC; currently only GitHub's "Initial commit" with an 8-byte `README.md`, which this tree's `README.md` replaces).
Replaces the stale `/workspace/dottie-import` (01:06 CDT), which was copied from the shared checkout's *working tree*. This one is built only from **committed branch heads** via `git archive` / `git show`; no worktree was switched, reset, cleaned, stashed or committed.
Build script: `/workspace/dottie-import-v2-build/build.sh` (+ `rewrite.py`). Neither ships in the tree.

## Sources
| Component → staged path | Repo / branch | Commit (full SHA) | Notes |
|---|---|---|---|
| Docs: `arch/*` → `docs/` (architecture, contracts/CONTRACTS.md, risks, backlog, week1-go-no-go, adr/ADR-0001..0017, triage/, history/, security/, evidence/W1/linux-smoke + codex windows sha256, security/secret-sweep-2026-10-19.md), `audit.md` → `docs/reviews/audit-2026-10-18.md`, `skills-review/` → `docs/reviews/skills-review/`, `spec.md` (v1.0) → `docs/history/spec-v1.0-2026-10-18.md`, `provenance/` → `docs/provenance/` | `/workspace/dottie-e01` `feature/E01-start` | `93ad21b900e8f9042e9020720004ebcb4d20a0be` | `diff -rq /workspace/dottie/arch /workspace/dottie-e01/arch` is empty, so the committed copy equals the live untracked one. |
| Week-1 probe: `arch/evidence/week1-probe/` → `scripts/week1-probe/` | `dottie-e01` `feature/E01-start` | `93ad21b` | Script + Linux self-test transcripts (authUrl query already `<redacted>` at source). |
| `docs/spec.md` (brief **v2.0**) | **UNCOMMITTED**: `/workspace/dottie-import-build/brief-v2.0.md` | sha256 `8f78e7089abd265b8c8a7b733c95fccd60c4678de352714321bc22cacc28fcf0` | Not on any branch. Included because `docs/triage/BRIEF-CONFLICTS-2026-10-19.md` B13 adopts brief v2.0 as `docs/spec.md` and the arch docs cite its §27. **E01 should commit it on `feature/E01-start` before the PR**, or drop it. |
| `packages/contracts/` (everything except the catalog), `packages/codex-adapter/` | `/workspace/dottie-e02` `feature/E02-approvals-bridge` | `0146c9071c2d55b5ddd3c152812d31f05efb362b` | Branch HEAD; contains `feature/E02-codex-adapter` (5410d78). |
| `packages/contracts/tool-catalog.json` + `.sha256` | `/workspace/dottie-e04` `feature/E04-start` | `47435a7627ae672c5a15ade34d2949ef81f2e46c` | **Lives in E04's tree, not E02's.** `sha256sum -c packages/contracts/tool-catalog.json.sha256` (from repo root) → OK, `45ed08c81c16a9c81c3e73b76676dc01078eddecb01ec16e3a1bdf2fd6ba74b7`. |
| `packages/tools/`, `docs/contracts/{tools.md,tool-host-control.e04-host-positions.md,tool-host-control.e04-review-draft5.md}`, `docs/e04/e04-tools-plan.md` → `docs/plans/`, its v1 → `docs/history/` | `dottie-e04` `feature/E04-start` | `47435a7` | |
| `packages/coordinator/`, `docs/evidence/tickets/DOT-061/` | `/workspace/dottie-e03` `feature/E03-DOT-061-auth-gate` | `0ee1e0884e5b7fb16b23224014e0491b92b2165e` | Author recorded as E06 (shared-config identity issue; see `docs/provenance/`). |
| `apps/desktop/` (incl. `scripts/smoke-run.mjs`, `process-group.mjs`, `smoke-supervisor.mjs`, `packaging/installer.nsh`), `docs/evidence/tickets/{DOT-095,DOT-098,DOT-099}/`, `docs/E06-open-questions.md`, `docs/adr/ADR-desktop-001-electron-shell.md`, `docs/contracts/desktop-ipc.DRAFT.md` | `/workspace/dottie-e06` `feature/E06-runtime-status` | `74673e66a0218717cf5f04d10428e6fef33b577b` | `bfacd64` (shared checkout `feature/E06-desktop-scaffold`) **not** used. |
| `docs/evidence/README.md`, `docs/qa/*`, `docs/evidence/reviews/*` | `/workspace/dottie-e07` (clone) `feature/E07-start` | `11a2cdbadea9a197f3742bf5b295110f19c5a2f1` | Includes fca64b7; evidence README is the f59fd30 lineage. |
| `src/verifier/` → `packages/verifier/`, `docs/evidence/tickets/DOT-064/`, `docs/verifier-design.md`, `docs/verifier-contract-proposal.md` | `/workspace/dottie-e11` `feature/E11-verifier` | `79138cde45ce24385b1bd30cba5758f5a7c4bfcf` | |
| Root overlay: `README.md`, `package.json`, `.gitignore`, `ruff.toml`, `.github/{workflows/ci.yml,CODEOWNERS,pull_request_template.md}`, `scripts/secret-scan.sh`, `docs/{README,LICENSE-OPTIONS,product-decisions,requirements-matrix,weekly-status}.md`, `docs/adr/README.md`, `tests/**/README.md`, `packages/{policy,voice,observability}/README.md` | **UNCOMMITTED** E01 templates: `/workspace/dottie-import-build/templates/` | — | `README.md`, `package.json`, `docs/README.md` updated for the new packages (see below). |

### Not imported (and why)
| Item | Status | Reason |
|---|---|---|
| E05 voice `packages/voice` (`dottie-e05` `feature/E05-start` `d3f60889bbb9baeba40e1ceb895613f9bfd4eb11`, 12 files) | committed, **not** imported | The old import did not include it (template README only). Info: `pytest` on its archive = **38 passed** (Linux). Needs an E01 decision to add. |
| E08 security | — | `feature/E08-start` has no commits beyond 6c05524. E08 design docs come in via E01's `arch/security/` → `docs/security/`. |
| E09 `wire-probe` (`/workspace/dottie-e09`) | not a git repo | Not committed; old import didn't have it. |
| E10 `e10/baseline.md`, `e10/sim/` | untracked in shared checkout | `feature/E10-start` has no commits beyond 6c05524 (old import copied them from the working tree). |
| `perf-reliability-plan.md`, `voice-plan.md` | untracked in shared checkout | Never committed. |
| `docs/contracts/tool-host-control{,.E01-approvals,.E01-verdict,.E08-review-request,.E08-review}.md`, shared `docs/evidence/reviews/` | untracked in shared checkout | Never committed on an owner branch. |
| `bfacd64` | shared checkout | Wrong author; superseded by E07's f59fd30. |

### Import transformations
- `rewrite.py`: mechanical `arch/…` → `docs/…` path rewrite in 15 E01-owned files only (67 substitutions; list in `/workspace/dottie-import-v2-build/rewrite-changes.json`). Evidence packs, `docs/history/`, `docs/reviews/`, `docs/qa/` and other owners' files are untouched (sealed packs stay byte-identical).
- No host-name or authUrl redaction was needed (0 host names; both recorded sign-in URLs are already redacted at their source commits).
- Excluded from the tree entirely: `node_modules/`, `dist/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, build outputs (git archive of committed trees contains none).
- `.gitignore` check: `git init && git add -A` in a copy drops **0** files.

## Tests (Linux box, clean install in a scratch copy `/tmp/dv2-test`; Node 22.23.3 / npm 10.9.9; Python 3.12.15 venv with pytest 9.1.1, ruff 0.17.1, jsonschema). **Linux only; none of this is Windows evidence.**
| Package | Commands | Result |
|---|---|---|
| packages/contracts | `npm ci && npm run check && npm test` | **200 pass, 0 fail, 2 skipped** of 202 (skips: codex:check needs `CODEX_BIN`; python jsonschema cross-check needs `DOTTIE_PYTHON`). Rerun with `DOTTIE_PYTHON=<venv>`: **201 pass, 0 fail, 1 skipped**. `vectors:check` OK, `schemas:check` OK. `codex:check` **not run** (needs the pinned codex binary). |
| packages/codex-adapter | `npm ci && npm run check && npm test` | **124 pass, 0 fail, 1 skipped** of 125 (skip: live 0.163.0 smoke, `DOTTIE_CODEX_BIN` not set) |
| packages/coordinator | `npm ci && npm run check && npm test` | **278 pass, 0 fail, 0 skipped** |
| apps/desktop | `npm ci && npm run typecheck && npm run lint && npm test && npm run check:packaging`; `xvfb-run -a npm run smoke:ci` ×3 | typecheck OK, lint OK, **997 passed in 18 files**, packaging check OK; smoke:ci **3/3 OK** (7.78–7.90 s, dirtyTree:false against a scratch git commit of the staged tree, no Electron left afterwards) |
| packages/tools | `python -m pytest` | **748 passed, 4 xfailed** (xfail_strict) |
| packages/verifier | `python -m pytest -q`; `ruff check .` | **485 passed**; ruff clean |
| repo python lint | `ruff check scripts docs tests` | clean |

Not run: Windows anything, `codex:check`, live Codex smoke, `npm run package:*`, E05 voice in-tree (not imported).
Info: `ruff check` inside `packages/tools` with the root `ruff.toml` reports 668 findings; E04 has no lint gate and CI doesn't lint it yet.

## Secret sweep
Scope: the whole staged tree, including hidden files, evidence packs, `.log.txt` / `.log.partial.txt` copies, fixtures and transcripts.
1. **dottie-evidence-pack step 5** (`rg -n --hidden -e 'eyJ[A-Za-z0-9_-]{10,}' -e 'refresh_token' -e 'access_token' -e 'code_challenge' -e 'sk-[A-Za-z0-9_-]{16,}' -e 'Bearer ' -e 'CANARY-'`) over the whole tree: hits only in code, docs and tests that **name** the patterns or use synthetic test values. Inside `docs/evidence/` there are 2 hits, both quoting the sweep's own patterns: `docs/evidence/reviews/DOT-098-7158f2f-e07-review.md:115` and `docs/evidence/tickets/DOT-061/20261019-c7bfdc5/README.md:32`. Both are false positives, and both files were left unchanged (sealed / owner files).
2. `scripts/secret-scan.sh .` → **FAIL with 3 hits, all false positives**: the 2 above plus `packages/codex-adapter/test/units.test.ts:356` (`jwt` rule). That one is the public jwt.io example `{"alg":"HS256"}.{"sub":"1234567890"}.sig`, used in a redaction test. CI's secret-scan job will be red until E08/E07 add an allowlist (or narrow the evidence rule).
3. Extra greps: forbidden files (`auth.json`, `.env*`, `*.pem/key/pfx/p12/cer/keystore`, cookies, sqlite/db, audio, `*.log`): **0** (the only binaries are 23 icon files: 15 PNG and 8 ICO). `sk-` values: all synthetic test strings (`sk-live-1`, `sk-must-not-reach-child`, `sk-A-4112-should-never-be-logged`, `sk-fake…`) or words ending in "-sk" (`task-scoped` …). `OPENAI_API_KEY=` with a value: only canaries / synthetic test values. Bearer values, token-JSON values, private keys, cookies, GitHub/Slack/AWS/Google key shapes: **0**. `auth.openai.com`/`chatgpt.com` URLs with code/state/challenge params: **0 real**. All are synthetic fixtures (`state=x`, `abc`, `<redacted>`) or `<redacted>` at source. Emails: only `@example.com` test addresses, `user:pw@auth.openai.com` URL-userinfo test cases and `i@izs.me` (npm package author in `package-lock.json`). Host names `DESKTOP-…`/`LAPTOP-…`: **0**. `userCode` values: only the synthetic `ABCD-1234`.
4. Informational (not secrets): synthetic Windows profile paths `C:\Users\gopi.thungam\…` in the action-id vectors (`packages/contracts/scripts/action-id-vectors.mjs:246`, `fixtures/action-id/vectors.json`, coordinator fixture copy); `loginId` UUIDs of cancelled/unauthenticated Linux logins; box paths `/home/box`, `/workspace/…`; references to private source repos (`Santa_Claus`, `Dollie_Bot_Private`, `Bot`) by name in arch docs.

**Result: no secret found. The tree is clean to publish from a secrets standpoint; 3 known false positives make `secret-scan.sh` fail.**

## Sizes
Files: 1979, 17.5 MB uncompressed. No file over 5 MB (largest 0.89 MB). See the final report for the tarball size and hash; the tarball is not inside the tree.

## Known issues for the PR (not fixed here)
- `secret-scan.sh` false positives (above). The CI `docs-paths` job will also fail on stale `arch/` paths in other owners' files and sealed packs: `docs/contracts/desktop-ipc.DRAFT.md`, `docs/plans/e04-tools-plan.md`, `docs/verifier-contract-proposal.md`, `docs/evidence/reviews/DOT-099-5ae9394-e07-review.md`, DOT-061 and DOT-064 pack READMEs. Exclude `docs/evidence/` from that rule and have the owners re-point the rest.
- `ci.yml` (template) has no jobs for contracts, codex-adapter or tools yet, and no `.partial` upload or process-group backup kill (the CI PR).
- `CODEOWNERS` still has placeholder `@dottie/eNN` handles and points at `/apps/desktop/build/`, while E06 now uses `apps/desktop/packaging/`.
- `docs/evidence/W1/linux-smoke/README.md:33` still says transcript line 10 holds an unredacted authUrl. The committed file is already redacted (`<redacted-auth-url>`), so the sentence is stale (E01 to fix).
- `packages/contracts` and `packages/codex-adapter` have no README.
