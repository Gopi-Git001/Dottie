# Secret sweep before the first push to Gopi-Git001/Dottie (E01, 2026-10-19 00:15–00:35 CDT)

- Skill: `dottie-evidence-pack` step 5 (box command), plus the kickoff's extra checks (auth.json, `.env*`, tokens, recorded auth URLs, node_modules, caches, large binaries, PII such as résumés).
- Runner: the box (Linux). **No secret values are reproduced here**: only paths, line numbers and rule names. Where a match was inspected, only its shape (length, prefix class, fake/test marker) was printed.
- Scope A = **source** on the box (everything that could be imported): `apps/desktop`, `packages/coordinator`, `packages/verifier`, `arch/`, `docs/`, `skills-review/`, `e10/`, and root `spec.md`, `audit.md`, `e04-tools-plan.md`, `perf-reliability-plan.md`, `voice-plan.md`.
- Scope B = the **staged import tree** `/workspace/dottie-import/`, scanned by its own `scripts/secret-scan.sh`.
- Note: the box restarted at about 00:23 CDT (uptime reset; `/tmp`, every `node_modules` and `apps/desktop/build/` were lost). Scope A was swept before the restart. Scope B was rebuilt and re-swept after it.

## Result: staged tree **PASS** (0 hits) after 2 redactions. The source tree has findings, listed below; none is a live credential.

### A. Source findings (box)
| # | Path | Rule | What it is | Action |
|---|---|---|---|---|
| 1 | `docs/evidence/W1/linux-smoke/appserver-0.163.0-unauth.jsonl.txt:10` | skill pattern (`code_challenge`) + OAuth query | **Recorded sign-in URL** with its full query (PKCE challenge, state, client id) from a login that was **cancelled** at once on the Linux smoke test (no account, no token issued). Not usable as a credential, but the rule is "never commit recorded auth URLs" | **Redacted in staging** (query → `<redacted>`; note added to the staged linux-smoke README). The box original is left unchanged because other docs cite it by line. **Recommend E08/E07 redact it at the source too** (skill step 6), with DOT-008's redactor rule |
| 2 | `arch/{RISKS.md (4), BACKLOG.md (4), WEEK1_GO_NO_GO.md, TRIAGE-2026-10-18.md, adr/ADR-0008, adr/ADR-0016}` | host name `DESKTOP-…` | The test PC's Windows host name (Gopi's Q2 answer) | **Replaced by `GOPI-TEST-PC` in staging** (6 files). The skill forbids host names in evidence, and repo visibility is still open (Q7) |
| 3 | `e10/mdc_mirror/voice-agent/tests/*.py` (9 files) | skill pattern (`sk-…`) | `FAKE_KEY = "sk-proj-…"` test constants, 32–41 chars, each containing a fake/test marker | Not a secret, but **excluded**: the whole MDC mirror stays out (no LICENSE, Q16) |
| 4 | `e10/mdc_mirror/voice-agent/.env.example` | `.env*` | 4 `*_API_KEY=` lines (OpenAI, OpenRouter, TypeSafe, Tavily) holding short word-shaped placeholders (10–16 chars), plus 1 empty | **Excluded** (mirror). Placeholders, not keys |
| 5 | `e10/mdc_mirror/.../voice/realtime.py:241`, `logging_setup.py:75` | `Bearer ` | Code that builds or redacts an Authorization header from a variable | Excluded (mirror). No value |
| 6 | `docs/week1-go-no-go.md:156`, `docs/qa/release-blockers.md:10`, `scripts/week1-probe/dottie-week1-probe.mjs:34` | skill pattern keywords | Docs naming the sweep patterns; the probe's own redaction key list | Kept. Keywords only, no values. Outside the evidence dirs |
| 7 | `apps/desktop/test/{controller,security}.test.ts`, `src/shared/ipc.ts`, `main/controller.ts`, `main/services/types.ts`, `renderer/onboarding.ts`, the schema JSONs | `auth.openai.com…?`/`state=` text | Test fixtures with short fake query values; schema descriptions | Kept. None matches the value rule (≥16-char `state`/`code_challenge`/`code`) |
| 8 | `apps/desktop/node_modules` (524 MB), `packages/coordinator/node_modules` (27 MB), `e10/.venv` (194 MB) | node_modules / venv | Installed dependencies | Excluded (`.gitignore`). Gone after the box restart |
| 9 | `apps/desktop/dist/` (4.5 MB; 4 files > 500 KB incl. 1.5 MB source maps), `packages/coordinator/dist/` | build output | Generated | Excluded |
| 10 | `__pycache__/`, `.pytest_cache/`, `.ruff_cache/` (verifier, mdc_mirror) | caches | Generated | Excluded |
| 11 | `e10/pytest_voice.log` | `*.log` | Test output of the mirror | Excluded |
| 12 | `docs/evidence/W1/linux-smoke/schema-0.163.0*/*.json` (4 files, 0.63–0.89 MB) | large file | Generated App Server schema for the pinned binary | **Kept** (< 2 MB; needed for the DOT-007 schema diff). Reconsider Git LFS if the schema grows |
| — | anywhere in scope A | `auth.json`, `.env`, `*.pem/*.key/*.pfx/*.p12`, JWT (`eyJ….eyJ…`), real `sk-` keys, `Bearer <value>`, token JSON values, `CANARY-<uuid>` | — | **0 hits** |
| — | anywhere in scope A | PII | Emails: only `bob@example.com`, `attacker@example.com`, URL-userinfo test strings, and an npm author address in `package-lock.json`. **No résumés**; the Groot_1.0 résumé PII (audit risk 2) is in `src/Groot_1.0`, which is not imported. No raw audio. No screenshots (only app/tray icons) | Kept |

### B. Staged tree `/workspace/dottie-import/`
- `scripts/secret-scan.sh .` → **`secret-scan: PASS (0 hits)`**. Rules: the exact skill-pattern sweep over `docs/evidence/` and `scripts/week1-probe/linux-selftest/`; repo-wide value rules (JWT, `sk-` ≥32, Bearer value, OAuth query values, token JSON, CANARY uuid, private key, `DESKTOP-` host); forbidden files; files > 2 MB.
- Probe self-test transcripts produced from the staged tree (Linux, unauthenticated: `status`/`task`/`logout`) → sweep **PASS**. They were written to a temp dir and not kept.
- Excluded from the import on purpose: `e10/mdc_mirror/`, `e10/.venv/`, `e10/place.py`, `e10/want.txt`, `e10/pytest_voice.log`, all `node_modules/`, `dist/`, caches, and `src/{Bot,Dollie_Bot_Private,Groot_1.0,Santa_Claus,groot-harness,codex}` (audit clones; Bot comes later via DOT-030).

## Still to do before the first push (not done here; prep only)
1. Run the same scan in CI (`.github/workflows/ci.yml` job `secret-scan`) on the first PR, not on a push to `main`.
2. E08 co-signs this sweep (the skill makes E08 co-owner) and decides on finding 1 at the source.
3. If anything is captured on Gopi's PC before import, run the PowerShell sweep there before `CopyToBox`.
