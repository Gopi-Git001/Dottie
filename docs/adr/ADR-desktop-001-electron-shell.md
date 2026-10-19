# ADR-desktop-001: Electron tray shell, packaging and start-at-sign-in

- **Status:** Proposed (E06), pending E01 approval and E08 security review
- **Date:** 2026-10-18
- **Context:** spec §4 (process separation), §8 (layout and AppData), §13 (installer, start at sign-in, lifecycle)

## Decision

1. **Shell:** Electron 44 with TypeScript in strict mode. Main, preload and renderer are bundled by esbuild, and the renderer is plain TS with no UI framework. All versions are pinned exactly, with a lockfile.
2. **Renderer isolation:**
   - The renderer runs with contextIsolation, sandbox and `app.enableSandbox()`, and is served from a privileged `app://dottie` scheme with a strict CSP.
   - All IPC is validated with zod in main (sender origin and frame, strict input, stripped output).
   - The renderer has no Node, shell, filesystem, credential or microphone access. The mic belongs to the voice worker (E05).
3. **Packaging:** electron-builder 26 with two targets:
   - **MSIX (`appx`)** is primary. It gives a clean, OS-managed install and uninstall, a per-user package identity, Store/Intune readiness and declared capabilities (`microphone`).
   - **NSIS, per-user** (`perMachine: false`, `allowElevation: false`, one-click into `%LOCALAPPDATA%\Programs`) is the fallback. It is used for sideloading without a trusted MSIX certificate, for dev/test, and for anything MSIX can't do yet (start at sign-in, see below).
   - Both apply Electron fuses: no `runAsNode`, no `NODE_OPTIONS`, no inspect flags, ASAR integrity, load only from asar, and cookie encryption.
   - Build resources live in `apps/desktop/packaging/` (`directories.buildResources`), not the conventional `build/`. `build/installer.nsh` was deleted twice from the shared checkout on 2026-10-19, and none of our scripts or electron-builder caused it. `scripts/build.mjs` only removes `dist/`, and electron-builder writes to `release/`. `scripts/check-packaging.mjs` runs in every build/package script and in vitest. It fails if `packaging/installer.nsh` is missing, has lost its uninstall macro, or is no longer wired into `electron-builder.yml`, or if any script would delete the dir.
4. **Start at sign-in:**
   - It is per-user and **never** a Windows service.
   - NSIS builds use `app.setLoginItemSettings` (HKCU Run + StartupApproved), launched with `--dottie-autostart` so the app starts hidden in the tray.
   - The default is **off** until the user opts in, either in onboarding or in Settings.
   - On startup, a disable made in Windows Settings or Task Manager is respected and copied into our settings. We never silently re-enable it.
5. **Lifecycle:**
   - Single-instance lock: a second launch focuses the existing window.
   - Closing the window hides it.
   - Quit stops every registered worker, cancels pending restarts and exits.
   - The main process is never supervised or relaunched.
   - Child workers (later) go through `WorkerSupervisor`: exponential backoff (1 s → 60 s), a crash-loop cap (5 in 10 min), `windowsHide: true` and `shell: false`. Electron is a GUI-subsystem exe, so no console window appears.
6. **Settings:** JSON in `app.getPath('userData')` (`%APPDATA%\Dottie`), never in the install folder.
   - The schema is versioned and validated by zod, with a migration chain.
   - Writes are atomic (temp file + fsync + rename, retried on Windows EPERM/EBUSY).
   - A corrupt file is backed up and reset; a file from a newer version is never overwritten.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| **Tauri / WebView2 + Rust** | Smaller footprint, but the team's reusable code is TS and Python, the Codex TS SDK and app-server client are Node, and the spec names Electron. We can revisit once the footprint (~376 MB unpacked) is measured against E09 budgets. |
| **WinUI 3 / .NET native tray** | Best Windows integration (StartupTask, toast, MSIX), but it would split the stack and duplicate the IPC contract in C#. |
| **electron-forge (+ MSIX maker)** | Viable. electron-builder was picked for mature NSIS per-user hooks (custom uninstall prompt), built-in `electronFuses`, and signing via env/Azure Trusted Signing in one config. |
| **Squirrel.Windows** | Installs per-user, but uninstall/AppData handling and MSIX parity are weaker, and its auto-update model conflicts with spec §13.6 (no silent permission-changing updates). |
| **Per-machine MSI** | Needs elevation and violates "user-level install". |
| **Windows service for "always on"** | Explicitly forbidden (spec §13.3: no Session 0 service). |
| **React + Vite renderer** | Not needed for three simple views. Plain TS keeps the attack surface and dependency count small. Easy to switch later behind the same `window.dottie` API. |

## Tradeoffs and known gaps

- **MSIX start-at-sign-in is not implemented.** `app.setLoginItemSettings` writes a Run key that packaged (AppX/MSIX) apps can't use (electron/electron#38967, #42016). The supported route is the `windows.startupTask` manifest extension (`appx.addAutoLaunchExtension: true`) plus the WinRT `StartupTask` API (for example `electron-winstore-auto-launch`, a native dependency). A task the user disabled cannot be re-enabled programmatically. Until this is done, the MSIX build reports `mechanism: msix-startup-task, supported: false` and the UI says so. **Decision needed (E01):** ship MSIX without start-at-sign-in in P1, ship NSIS-only for P1, or add the native StartupTask dependency now.
- **MSIX AppData is virtualised** and deleted by Windows on uninstall, so "keep my settings" cannot be offered there. NSIS asks, defaulting to Keep. Silent uninstall keeps data unless `--delete-app-data` is passed.
- **MSIX build host:** creating an appx needs the Windows SDK (`makeappx`), and NSIS needs Windows or wine. On the Linux box I verified `--win --dir` (fuses and asar contents) and smoke-ran the packaged Linux dir build. Neither installer has been produced or run yet.
- **Auto-update** is out of scope until release signing and a rollback plan exist (spec §13.6). `publish: null`.
- **Size:** Electron adds about 376 MB unpacked (x64). Expect the compressed installer to be roughly 90–110 MB; this is not measured yet.
- **Security debt for E08:**
  - `electron-builder`'s transitive dev-only `sprintf-js` advisory (8 moderate findings via `@electron/get` → `global-agent`). It is build-time only and not shipped in the asar.
  - The protocol handler and the renderer-content CSP need review.
- **Icons** are generated placeholders: distinct shapes and colours per state, ICO with 16–48 px images. Replace them with designed assets, and check contrast in high-contrast mode.

## Consequences

- Other teams integrate through `src/main/services/types.ts` (ports) and the IPC contract, not by touching Electron code.
- Moving `shared/*` into `packages/contracts` after E01 sign-off is a mechanical import change.
- Release CI needs a Windows runner with the SDK and signing secrets (`WIN_CSC_*` or Azure Trusted Signing env).
