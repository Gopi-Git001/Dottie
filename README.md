# Dottie

Dottie is a Windows 11 voice-to-action assistant for one user (personal, single-user use; ADR-0002). You say "Dottie" and give a command. Dottie runs it through the
official **Codex App Server** (pinned to `rust-v0.163.0`, ADR-0003) with scoped, verified desktop tools, speaks the result, and goes back to standby.

> **Status (2026-10-19): pre-alpha, Week 1 (P0 discovery and contracts).** Nothing here is a working product yet. The Week-1 auth go/no-go
> (`docs/week1-go-no-go.md`) has **not** been run on Windows. Every test below runs on fakes.

## Layout (spec §8; kickoff 2026-10-19)
| Path | What | Owner | Language | State |
|---|---|---|---|---|
| `apps/desktop/` | Electron tray shell, typed IPC, onboarding, settings | E06 | TypeScript | scaffold + unit tests (vitest) |
| `packages/contracts/` | Shared event/IPC schemas (CONTRACTS v2), action-id vectors, codex-generated schema, tool catalog (hash-pinned) | E01 + E02 + E03 (catalog: E04) | TypeScript | unit tests (node:test) |
| `packages/codex-adapter/` | App Server client, auth, server-request/approvals bridge, env allowlist | E02 | TypeScript | unit tests (node:test, fakes; live smoke opt-in) |
| `packages/coordinator/` | Task state machine, auth gate, approvals, cancel | E03 | TypeScript | unit tests (node:test) |
| `packages/policy/` | Default-deny scopes, single-use approvals | E08 | TypeScript | empty (DOT-014) |
| `packages/tools/` | Scoped Windows tool adapters (contract layer; Windows mocked on Linux) | E04 | Python | unit tests (pytest, Linux fakes) |
| `packages/verifier/` | Observed-postcondition verification | E11 | Python | unit tests (pytest, Linux fakes) |
| `packages/voice/` | Wake, VAD, STT/TTS, devices | E05 + E10 | Python (E05 branch) | not imported yet (see IMPORT-MANIFEST) |
| `packages/observability/` | Traces, metrics, redaction | E09 | TypeScript | empty (DOT-079) |
| `scripts/week1-probe/` | Week-1 auth probe against the pinned App Server | E02 | Node (no deps) | ready; not run on Windows yet |
| `tests/` | integration, e2e-windows, fixtures | E07 | — | empty |
| `docs/` | spec v2.0, architecture, contracts, ADRs, risks, backlog, QA, evidence | E01 | Markdown | see `docs/README.md` |

## Quick start (developers)
Requires Node 22 (`apps/desktop/.nvmrc`), Python ≥ 3.11 and ripgrep.
```bash
npm run bootstrap     # npm ci in contracts, codex-adapter, coordinator, apps/desktop; pip install verifier/tools dev deps
npm run typecheck
npm run lint          # eslint (desktop) + ruff 0.17.1 (python)
npm run unit-test     # contracts, codex-adapter, coordinator, desktop, tools, verifier
npm run secret-scan
```
`integration-test`, `windows-e2e`, `package` and `verify-signature` exist as names (brief §23). Each one fails with "not implemented" until its ticket lands.

## Rules
- **Never commit** `auth.json`, `.env*`, tokens, unredacted sign-in URLs, host names, raw audio or screenshots (RB-01; `docs/evidence/README.md`). CI runs `scripts/secret-scan.sh`.
- Every change arrives as a PR from `feature/<DOT-ID>-…`. Nothing merges to `main` without review. E07 reviews test-significant changes and E08 reviews auth/permission changes (spec §7). See `.github/CODEOWNERS`. Every role reviews through @Gopi-Git001.
- Shared interfaces change only through E01 (`docs/contracts/CONTRACTS.md`, ADR-0012). A schema change needs a version bump, fixtures and consumer tests.
- Codex stays pinned at 0.163.0 unless an ADR changes the pin.

## License
Copyright (c) 2026 Gopi Thungam. All rights reserved. This repository is public for visibility only; no license is granted to use, copy, modify, or distribute it.
