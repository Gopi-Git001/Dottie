# ADR-0003: Pin Codex to a released version, verify by hash, and treat the generated schema as the contract

- Status: **Proposed**. Date: 2026-10-18. Deciders: E01, E02, E08. Spec: §2 (pin and record in `docs/dependencies.md`), §13.8.

## Context
- The latest release is `rust-v0.163.0` (published 2026-10-15 16:30 CDT). npm `@openai/codex@latest` = `0.163.0`. `sdk/typescript/package.json` is `0.0.0-dev`.
- Release assets include `codex-x86_64-pc-windows-msvc.exe.zip` (sha256 `dabdb4d1…b704c3`), `codex-app-server-x86_64-pc-windows-msvc.exe.zip`
  (sha256 `c12aef26…22c`), and `codex-app-server-package-x86_64-pc-windows-msvc.tar.gz` (sha256 `abee5d71…781c`) (GitHub API, 2026-10-18).
- The bare Linux `codex` binary warned: "Code Mode is unavailable because failed to spawn code-mode host … `codex-code-mode-host`" (Linux evidence line 20).
- `codex app-server generate-json-schema` / `generate-ts` produce schemas that exactly match the binary (official page "Message schema").

## Pin record (verified 2026-10-19 00:05 CDT against the GitHub API)
- Tag `rust-v0.163.0` → annotated tag object `129b8ec7ee6f4511557a4856279f529025c25af4` → commit **`83086188ae0614bd882818ff1aa23f3194962012`**
  (committer date 2026-10-15 13:57 CDT; tagger 2026-10-15 13:57 CDT; release published 2026-10-15 16:30 CDT).
  Sources: `https://api.github.com/repos/openai/codex/git/ref/tags/rust-v0.163.0` and `/git/tags/129b8ec7…`, with `/commits/rust-v0.163.0` giving the same sha.
- **The pin is the GitHub release asset plus its sha256** (the API `digest` field; stored in `docs/evidence/W1/codex-0.163.0-windows-assets.sha256`), **not npm `@openai/codex`**.
  The npm 0.163.0 manifest has no `gitHead` (registry metadata, checked 2026-10-19), so it can't be tied to the commit. Its platform binaries are separate npm aliases (`@openai/codex@0.163.0-win32-x64`).
- Note: `src/codex` is a clone of `main` @ 8c07694, **not** the pinned commit. V-src line references in CONTRACTS point at main. The generated 0.163.0 schema is still the contract of record.
  `main` already has variants the pin lacks (e.g. `BioPolicy`, `InvalidPrompt` in `protocol/src/protocol.rs:1968-1990`). These are additive for a future bump, run through the dottie-appserver-contract-diff skill.

## Decision
Pin **0.163.0** for Week 1. Store the binary sha256 in `docs/dependencies.md` and check it at launch. Generate TS types from the pinned binary into
`packages/contracts/codex-generated/`. CI fails if the regenerated schema differs. Which Windows artifact to ship (`codex.exe app-server` vs the standalone
`codex-app-server.exe` vs the `codex-app-server-package`) is **open**. Week-1 spike W1-S1 checks whether the package is needed (code-mode host, sandbox helpers).

## Alternatives
Track `main` (rejected, unstable). Rely on whatever `codex` is on the user's PATH (rejected: version skew, and the user's own config and auth would be shared, see ADR-0004).

## Consequences
Upgrades are deliberate PRs, with schema diff review by E02 and E01. Bundling a binary of about 84–167 MB raises installer size and Apache-2.0 NOTICE obligations
(`src/codex/LICENSE`, `NOTICE`).
