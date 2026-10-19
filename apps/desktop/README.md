# Dottie desktop shell (`apps/desktop`)

Owner: **E06 Desktop Application Engineer**. Status: **scaffold / preview**. Voice (E05), Codex login (E02) and the coordinator (E03) are **stubs behind feature flags**.

This is the Electron tray app from spec §4 and §13. It provides a single-instance tray, a typed and validated IPC bridge, per-user start-at-sign-in, versioned settings and the first-run wizard. It contains **no** voice engine, Codex runtime or tool executors.

## Requirements

- Node **22.12+** (`.nvmrc` pins 22.23.3). Electron 44's installer and vitest 5 both require Node 22 or newer.
- Windows 11 x64 to run and package for real. Linux/macOS are fine for unit tests, typecheck, lint and the headless smoke test.

## Commands

```bash
npm ci                 # exact versions from package-lock.json
npm test               # vitest unit tests (pure; never loads the Electron binary)
npm run typecheck      # tsc --noEmit, strict
npm run lint           # eslint (typescript-eslint strictTypeChecked + process-boundary rules)
npm run check          # typecheck + lint + test
npm run build          # typecheck + esbuild bundles -> dist/{main,preload,renderer}
npm start              # build:fast + launch Electron (dev)
npm run smoke          # unpackaged only: boots the app, opens onboarding, probes renderer isolation, prints DOTTIE_SMOKE_OK {...}, quits
                       #   writes dottie-smoke-<pid>.png under the app temp dir (not an env path)
npm run smoke:ci       # DOT-098: runner with a hard timeout per run, keeps every run's log (also on timeout), no retries
                       #   node scripts/smoke-run.mjs --runs 100 --out /path/to/logs --timeout-ms 90000 --case-id DOT098-AC3
                       #   files: <YYYYMMDD>T<HHMMSS>-0500_<sha>_<caseId>_<artifact>[_runNNN].<ext>, header JSON on line 1
npm run icons          # regenerate placeholder tray/app icons in assets/icons
```

Useful dev environment variables. Main reads them once at startup; the renderer cannot change them:

| Variable | Values | Purpose |
|---|---|---|
| `DOTTIE_FEATURE_VOICE` | `stub` (default) / `real` | E05 voice worker. `real` falls back to `stub` until a worker is registered, and the UI says so. |
| `DOTTIE_FEATURE_AUTH` | `stub` (default) / `real` | E02 Codex login adapter. Same fallback. |
| `DOTTIE_STUB_AUTH_STATUS` | an `AuthState` (CONTRACTS §2.1): `unavailable` / `signed_out` / `signing_in` / `expired` / `unsupported` / `signed_in` | Exercises Auth required / Reconnect, and `unsupported` the Sign out / Switch account items, with the stub. |
| `DOTTIE_STUB_RUNTIME_STATUS` | a `RuntimeStatus` value, e.g. `waiting_for_env` | Exercises the runtime-status tray mapping and push channel with the stub supervisor feed (CONTRACTS §2.4 enum in `src/shared/runtime.ts`; e.g. `breaker_open` shows Error + Retry). |
| `DOTTIE_ALLOW_DEV_AUTOSTART` | `1` | Lets an unpackaged dev build register itself at sign-in. Off by default. |

## Packaging (Windows)

The config is in `electron-builder.yml`, with NSIS hooks in `packaging/installer.nsh` (moved from `build/`, which was deleted twice by out-of-repo cleanups; `scripts/check-packaging.mjs` fails `npm run build`, every `package:*` script and the test suite if it is missing or unwired). The reasons for these choices are in `docs/adr/ADR-desktop-001-electron-shell.md`.

Run these on a **Windows** build agent with the Windows 10/11 SDK. MSIX needs `makeappx`/`signtool`, and NSIS needs wine on Linux:

```powershell
npm ci
$env:DOTTIE_APPX_IDENTITY_NAME = "<Partner Center identity or Company.Dottie>"
$env:DOTTIE_APPX_PUBLISHER     = "CN=<exact subject of the signing cert>"
npm run package:win:msix   # release\Dottie-<ver>-x64.appx   (primary)
npm run package:win:nsis   # release\Dottie-<ver>-x64.exe    (per-user fallback, no UAC)
npm run package:win        # both
npm run package:dir        # unpacked app only (fast check of asar contents + fuses)
```

### Signing (env-only; never commit secrets)

- PFX: `WIN_CSC_LINK` (path or base64) and `WIN_CSC_KEY_PASSWORD`. `CSC_LINK` and `CSC_KEY_PASSWORD` also work.
- Azure Trusted Signing: CI sets the `AZURE_*` env vars and passes `-c.win.azureSignOptions.*` on the command line.
- Release CI must fail unsigned builds: `electron-builder --win -c.forceCodeSigning=true`.
- The MSIX `publisher` must equal the certificate subject. Store submissions are re-signed by Microsoft.

### What the installers do

| | MSIX (appx) | NSIS (per-user) |
|---|---|---|
| Install scope | Per-user package | `%LOCALAPPDATA%\Programs\Dottie`, `perMachine: false`, no elevation |
| Start at sign-in | **Not yet**: needs the StartupTask extension (open item) | `app.setLoginItemSettings` → HKCU Run + StartupApproved |
| User data | `%APPDATA%\Dottie`, virtualised into the package and removed by Windows on uninstall | `%APPDATA%\Dottie`, kept by default; uninstall asks Keep/Delete (default Keep) |
| Silent uninstall | n/a | `/S` keeps data; add `--delete-app-data` to remove it |
| Binaries | Removed by Windows | Removed; the Run entry is also deleted |

Both installers apply hardening fuses: `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, ASAR integrity on, load only from asar, and cookie encryption on.

### Verified on Linux (this repo's CI box)

- `electron-builder --win --dir` produces `release/win-unpacked/Dottie.exe`, with fuses applied and an asar of 32 entries (`dist/**`, `assets/**`, `package.json`, with no `node_modules` and no sourcemaps).
- A packaged build does not enter smoke mode. The production bundle strips it, and passing the smoke flag to a packaged app logs a redacted warning and continues as a normal launch. Unpackaged `npm run smoke` / `smoke:ci` still run it.
- **Not verified:** NSIS `.exe` and MSIX `.appx` creation (both need Windows/wine), and every Windows runtime behaviour (tray, Run key, uninstaller prompt). These need the Windows build agent.

## Layout

```
src/shared/      contracts used by main + preload + renderer
  channels.ts      IPC channel names (dependency-free, used by preload)
  ipc.ts           zod schemas for every channel + DottieApi type
  contracts.draft.ts  event contract v2 mirror (CONTRACTS §3 / ADR-0012); replaced by packages/contracts
  states.ts        coordinator states (spec §4), 6 tray states (spec §13.4)
  settings.ts      settings schema v1, grantable scopes (spec §10)
  onboarding.ts    pure wizard model (spec §13.2)
src/main/        Electron main process
  main.ts          thin wiring: single-instance, protocol, IPC, tray, window, quit
  controller.ts    Electron-free core: every IPC handler + tray action
  state/           trayModel (pure precedence), menuModel (enablement), hub
  ipc/             router (sender check -> zod in -> handler -> zod out), trust (origin, URL allowlist)
  settings/        store (atomic JSON in userData), migrate, atomicWrite
  lifecycle/       autostart (login item), supervisor (child backoff), quit
  services/        ports for E02/E03/E05 + stubs
  electron/        tray, window, protocol (app://dottie), harden (permissions/navigation)
  security.ts      CSP, webPreferences, app:// asset resolver
src/preload/     contextBridge → window.dottie (fixed channels only)
src/renderer/    plain TS UI (onboarding, settings, activity). No Node, no Electron
test/            vitest
packaging/       NSIS include (electron-builder buildResources; never cleaned)
assets/icons/    generated placeholder icons (replace before release)
```

## Security model (summary)

- `contextIsolation`, `sandbox` (plus `app.enableSandbox()`), `nodeIntegration: false`, `webviewTag: false`, and all web permissions denied (including mic and camera: the renderer never opens the mic).
- The renderer loads from the privileged `app://dottie` scheme with a strict CSP: no inline code, no eval, and no network (`connect-src 'none'`).
- For every IPC call, main checks that the sender is the top-level frame on `app://dottie`. The input must pass a strict zod schema. The output is validated and stripped, and errors come back as codes only.
- Navigation, `window.open`, `<webview>` and downloads are blocked. External URLs open only in the system browser, only if they are https and on the allowlist (`chatgpt.com`, `auth.openai.com`, `openai.com`, `developers.openai.com`).
- Folder grants accept only paths main received from the native picker during this session. Whole drives are refused, and `credentials.access` and `purchases` cannot be granted at all.
- Sign-in sends no payload. Main asks the auth adapter, which will start the **official** Codex flow, and opens the returned URL in the system browser. The app never shows a password field and never uses an embedded login webview.
- Quit stops every registered worker, cancels pending restarts and exits. Nothing relaunches Dottie until the next sign-in, and only if the user enabled that.

See `docs/contracts/desktop-ipc.DRAFT.md` and `docs/E06-open-questions.md`.
