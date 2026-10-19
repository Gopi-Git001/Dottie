# ADR-0004: CODEX_HOME location and credential storage

- Status: **Proposed. Open question for the PO (Q3).** Date: 2026-10-18. Deciders: E01, E02, E08. Spec: §5 ("reuse existing Codex authentication when
  allowed"; "never read or copy Codex credentials"), §8 (AppData), §13 ("Sessions should stay within official Codex-managed storage").

## Context
- App Server reports `codexHome` in the `initialize` result (Linux evidence line 4). `CODEX_HOME` sets where auth, threads and SQLite state live.
- Credential store modes: `file` (default, `CODEX_HOME/auth.json`), `keyring` (fail if unavailable), `auto`, `ephemeral`
  (`src/codex/codex-rs/config/src/types.rs` `AuthCredentialsStoreMode`).
- Sharing the user's default `~/.codex` would reuse an existing Codex CLI or desktop login (spec §5 "reuse"). But it would also share config, MCP servers, threads and
  **logout**: a Dottie logout would also sign the user out of Codex CLI/app (`account/logout` → `authMode:null`).

## Decision (proposed)
- Dottie uses a **dedicated** `CODEX_HOME = %LOCALAPPDATA%\Dottie\codex`. That keeps config, MCP servers and threads isolated and makes logout predictable.
- `cli_auth_credentials_store = "keyring"` (Windows Credential Manager) is passed as a `-c` override. If W1 shows keyring fails on Windows 11, fall back to
  `file` under the per-user AppData ACLs, and record that in RISKS.
- "Reuse existing Codex authentication" (spec §5) is offered **only** through a future, explicit opt-in "Use my existing Codex sign-in" that points
  at the default `~/.codex`. It needs a separate ADR and a PO decision. Dottie never copies credentials between homes.

- 2026-10-19 note: the data root for everything else Dottie stores is settled in ADR-0014 (`%LOCALAPPDATA%\Dottie\`, no roaming).

## Alternatives
Shared `~/.codex` by default. Ephemeral store (fails "restart + session reuse").

## Consequences
The user signs in once for Dottie even if Codex CLI is already signed in. Uninstall must offer to remove `%LOCALAPPDATA%\Dottie\codex`, including
calling `account/logout` first so the keyring entry is cleared by Codex itself.
