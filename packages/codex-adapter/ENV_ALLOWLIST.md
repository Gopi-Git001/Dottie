# Codex App Server child environment allowlist (DOT-089)

Status: E01 ruling 2026-10-19 applied; **for E08 review**. Source of truth: `src/env.ts`. A unit test
(`ENV_ALLOWLIST.md ... lists exactly the variables in env.ts`) fails if this table and the code drift apart.

## How the child env is built

- `buildChildEnv()` (`src/env.ts`) creates a **new, empty object** and copies in only the parent variables whose
  names are on the lists below. `process.env` is never copied and then pruned. Anything not listed is dropped by
  construction: `OPENAI_*`, `AZURE_OPENAI_*`, every `CODEX_*` other than the `CODEX_HOME` Dottie sets, and any unknown
  variable.
- Matching: Windows names are case-insensitive, like Windows itself (`Path` matches `PATH`). POSIX names match
  exactly, so `ssl_cert_file` is dropped on Linux and macOS. Proxy names match in any case on every platform.
- Platform lists don't mix: Windows essentials are never taken on POSIX and the other way round (`HOME` is dropped
  on Windows, `SystemRoot` on Linux).
- `CODEX_HOME` is always overwritten with Dottie's dedicated directory (ADR-0004). A parent `CODEX_HOME` counts as
  removed, and the user's own `~/.codex` is refused.
- Logging: the `env.scrub` audit record (CONTRACTS §3.2) has only the **names** of dropped variables plus a count
  of kept ones. Values are never logged, and that includes proxy values, which can hold credentials. Child stderr is
  not logged at all (length and level only).
- The launch also forces `-c forced_login_method="chatgpt"` (separate from env; see `buildArgs()`).

## Allowed variables

### Windows (`WINDOWS_ENV_ALLOWLIST`)

| Name | Reason |
|---|---|
| `SystemRoot` | Windows system directory. Many Win32 APIs, DLL loading and Winsock fail without it. |
| `SystemDrive` | System drive letter. Used by OS components and installers to resolve paths. |
| `windir` | Legacy alias of SystemRoot that some tools and scripts still read. |
| `ComSpec` | Path to cmd.exe. Codex runs shell commands through it. |
| `PATHEXT` | Executable extensions. Without it, commands like `git` aren't resolved to `git.exe`. |
| `PATH` | Executable search path for Codex's own helpers and for the commands it runs. |
| `TEMP` | Per-user temp directory (GetTempPath). |
| `TMP` | Per-user temp directory (checked first by GetTempPath). |
| `USERPROFILE` | User profile root. Rust `home_dir` and many tools use it to resolve the home directory. |
| `APPDATA` | Roaming app data. Git and other CLI tools find their config through it. |
| `LOCALAPPDATA` | Local app data. Dottie's own data lives here (ADR-0014), and tools use it for caches. |
| `HOMEDRIVE` | Fallback home resolution (with HOMEPATH) for tools that don't read USERPROFILE. |
| `HOMEPATH` | Fallback home resolution (with HOMEDRIVE). |
| `ProgramData` | Machine-wide app data, such as system Git config and CA stores used by some tools. |
| `ProgramFiles` | Install location that tools use to find each other (for example Git for Windows). |
| `ProgramFiles(x86)` | 32-bit install location, same reason. |
| `PSModulePath` | Lets PowerShell run by Codex load its built-in modules. Without it, many cmdlets fail. |

### POSIX: Linux and macOS (`POSIX_ENV_ALLOWLIST`, prefix `LC_`)

| Name | Reason |
|---|---|
| `PATH` | Executable search path. |
| `HOME` | Home directory. Codex and the tools it runs resolve config from it. Codex state stays in CODEX_HOME. |
| `TMPDIR` | Temp directory (macOS always sets a per-user one). |
| `LANG` | Locale, for correct UTF-8 handling of command output. |
| `LC_*` | Locale categories (LC_ALL, LC_CTYPE, ...), same reason. |
| `LANGUAGE` | Message-language preference for GNU tools. |
| `TZ` | Time zone, so timestamps in command output match the user's. |
| `USER` | Login name. Some tools (ssh, git) need it when there's no passwd lookup. |
| `LOGNAME` | POSIX login name, same reason. |

### TLS, every platform (`TLS_ENV_ALLOWLIST`)

| Name | Reason |
|---|---|
| `SSL_CERT_FILE` | Corporate CA bundle. Without it, TLS to auth.openai.com and the API fails behind TLS-inspecting proxies. |
| `SSL_CERT_DIR` | Corporate CA directory, same reason. |

### Proxy, every platform, any case (`PROXY_ENV_ALLOWLIST`)

| Name | Reason |
|---|---|
| `HTTP_PROXY` | Outbound HTTP proxy. Values may contain credentials and are never logged. |
| `HTTPS_PROXY` | Outbound HTTPS proxy (API and sign-in traffic). Never logged. |
| `NO_PROXY` | Proxy bypass list. Needed so the loopback sign-in callback (127.0.0.1:1455) skips the proxy. Never logged. |
| `ALL_PROXY` | Catch-all proxy (including SOCKS), treated like the other proxy variables (E01 2026-10-19). Never logged. |

### Set by Dottie

| Name | Reason |
|---|---|
| `CODEX_HOME` | Dottie's dedicated Codex state directory (ADR-0004). Always overwritten; never taken from the parent. |

## Explicitly excluded (E01 2026-10-19; tests prove they never reach the child)

`COMPUTERNAME`, `USERDOMAIN`, `USERNAME`, `PUBLIC` (identity and host names), `DISPLAY`, `XDG_*`, `SHELL`, `TERM`
(desktop session and terminal). Also dropped by construction, and covered by tests: `OPENAI_*`, `AZURE_OPENAI_*`,
`CODEX_*` (other than Dottie's CODEX_HOME), `NODE_OPTIONS`, `LD_PRELOAD`, and any unknown variable such as `FOO`.

## Removed pending Week-1 evidence (TODO)

- [ ] `NUMBER_OF_PROCESSORS`: add back only if the Windows W1 run proves Codex needs it.
- [ ] `PROCESSOR_ARCHITECTURE`: add back only if the Windows W1 run proves Codex needs it.
- Not on E01's list and removed: `CommonProgramFiles`, `CommonProgramFiles(x86)`, `CommonProgramW6432`,
  `ProgramW6432`, `OS`.
