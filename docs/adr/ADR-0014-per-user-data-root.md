# ADR-0014: All Dottie per-user state lives under %LOCALAPPDATA%\Dottie (no roaming AppData)

- Status: **Accepted (E08 co-sign pending verification of applied changes).** E08 review 2026-10-19: ACCEPT WITH CHANGES; changes 5–9 below applied by E01. E06 review via DOT-068.
- Date: 2026-10-19 (CDT). Deciders: E01, E08, E06. Spec: §8 ("appropriate per-user Windows AppData directory … uninstall must clearly distinguish"), §13 (sessions in official Codex-managed storage).

## Context
- Desktop settings use Electron `app.getPath('userData')`, which is `%APPDATA%\Dottie` (Roaming) (`apps/desktop/src/main/main.ts:70`, `settings/store.ts:2-3`).
- ADR-0004 puts CODEX_HOME at `%LOCALAPPDATA%\Dottie\codex`. The voice cost meter is at `%LOCALAPPDATA%\Dottie\usage\speech.jsonl` (e05 bakeoff skill).
- Settings hold machine-specific data: microphone `deviceId`, absolute folder grants, the startup preference (`shared/settings.ts`). Electron `userData` also holds Chromium caches.
- Roaming profiles sync `%APPDATA%` between machines. `%LOCALAPPDATA%` is not synced. (Microsoft guidance on known folders; UNVERIFIED for this exact build, but the behaviour is long-standing.)

## Decision
1. Dottie uses a single root, `%LOCALAPPDATA%\Dottie\`, with subfolders `settings\`, `state\` (SQLite and the store), `logs\`, `usage\`, `codex\` (CODEX_HOME), and `electron\` (userData, set with `app.setPath('userData', …)` before `ready`).
2. Nothing Dottie writes goes to `%APPDATA%\Dottie` (Roaming), for two reasons:
   - folder grants and device IDs are wrong on another machine;
   - credential-adjacent state (CODEX_HOME, keyring fallback file) must never roam.
3. Migration: on the first run of the new build, move `%APPDATA%\Dottie\settings*` with a versioned settings migration, then remove the empty legacy folder. Uninstall and "reset" cover both roots until the migration has shipped.
4. Tool path policies deny reading Dottie's own state root (DOT-069 / RB01-U2).

### E08 co-sign changes (2026-10-19)
5. **Deny list.** Tools, sandbox writable roots and the Codex `cwd` deny **reads and writes** of all of `%LOCALAPPDATA%\Dottie\`, the legacy
   `%APPDATA%\Dottie` and `~\.codex`, so the model can never grant itself scope by editing `settings\` (extends item 4; DOT-069).
6. **ACL and reparse points.** The root gets an ACL granting only the current user and SYSTEM (inheritance from the parent removed). Junctions,
   symlinks and other reparse points are refused at the root and at `codex\`; Dottie refuses to start Codex if either check fails. Verified on Gopi's PC
   (`icacls` output + a planted-junction test), not only in unit tests (DOT-091).
7. **Migration (refines item 3).** Migration moves **settings only** (no state, logs or Codex files). The migrated file is schema-validated; if migration
   or validation fails, Dottie starts with defaults and **no folder grants**, and logs a redacted reason.
8. **Crash dumps** live inside the root (`logs\crash\`) and go through the redactor together with logs; both have a retention limit
   (default PROVISIONAL, decided with DOT-079).
9. **Uninstall** runs `account/logout` (through the adapter) **before** removing `codex\`, and covers both `%LOCALAPPDATA%\Dottie` and the legacy
   `%APPDATA%\Dottie` (DOT-050, DOT-091).

## Alternatives
- **Settings roam in `%APPDATA%` while Codex and logs stay local.** Rejected: there are two roots to uninstall and deny-list, and the grants don't transfer between machines anyway.
- **Electron default with no override.** Rejected for the same reasons.

## Consequences
DOT-068 (E06), DOT-069 (E07/E08) and DOT-091 (ACL, reparse points, uninstall; E06 + E08). Single-user personal use (Q1) means roaming has no product value.

## Changelog
- 2026-10-19: Proposed (E01).
- 2026-10-19: E08 co-sign changes applied by E01 (items 5–9). Status: Accepted (E08 co-sign pending verification of applied changes).
