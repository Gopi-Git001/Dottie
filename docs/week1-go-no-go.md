# Week-1 Auth Go/No-Go: Contract, Procedure and Evidence (spec §5 "Go/no-go auth investigation", §12 P0)

Owners: E01 + E02 (execute), E08 (witness/approve), E07 (evidence audit). Decision maker: Product Owner (Gopi Thungam).
Status: **NOT RUN.** Nothing in this file has passed yet. Date drafted: 2026-10-18 (CDT).

## 0. What is already proven (Linux box only, unauthenticated) vs. what needs Windows 11

| Item | Linux box (done, evidence) | Needs Windows 11 + Gopi's ChatGPT account |
|---|---|---|
| Handshake, `Not initialized` guard, `initialize` result | ✅ `evidence/linux-smoke/appserver-0.163.0-unauth.jsonl.txt` L1-5 | Re-confirm with `codex.exe` (`platformFamily` expected `windows`, UNVERIFIED) |
| `account/read` signed-out shape | ✅ L6-8 | Signed-in shape |
| `account/login/start{chatgpt}` → authUrl (auth.openai.com, PKCE, 127.0.0.1:1455) | ✅ L9-10 | Browser completes, callback reaches app-server, firewall/AV behaviour |
| `account/login/cancel` → `login/completed{success:false}` | ✅ L11-13 | — |
| Unauthenticated turn fails (slowly) → gate needed | ✅ L16-38 | — |
| `account/logout` → `account/updated{authMode:null}` | ✅ L39-41 (no-op logout) | Logout of a real session; credential removal |
| Schema of pinned binary | ✅ `evidence/linux-smoke/schema-0.163.0/` | Same version on Windows (compare `generate-json-schema` output) |
| Probe script works end-to-end on unauth paths | ✅ `evidence/week1-probe/linux-selftest/` | Signed-in paths |
| Sign-in, authenticated task, restart/session reuse, real logout, keyring, sandbox, Electron "packaged-like" launch | ❌ cannot be done here. The agent must not sign in on Gopi's behalf | **All of W1-1 … W1-6, W1-S1, W1-S2** |

## 1. Pass/fail contract

**GO** = W1-1 through W1-5 all PASS in **Stage B** (packaged-like Electron app, §3), with complete evidence (§5), **and** the PO confirms the
use case is allowed under the App Server auth terms (conflict C1 / ADR-0002). W1-6 and the spikes must be *run*. Their failure does not block GO,
but it creates backlog items and risks.

**NO-GO** if any of these is true:
1. Any step requires reading, copying, pasting or exporting `auth.json`, keyring secrets, tokens or cookies.
2. Sign-in needs a visible terminal or console, a manual `codex login` outside the app, or an embedded webview/password form.
3. `account/read` cannot confirm `account.type == "chatgpt"` after sign-in.
4. An authenticated turn does not reach `turn/completed{status:"completed"}`, or it only succeeds with an API key present.
5. After app/process restart the user must sign in again (the session is not reused). This is also tested after Windows sign-out/sign-in.
6. After logout, `account/read` still shows an account **or** a turn can still be started successfully.
7. The PO cannot confirm that the intended distribution is permitted (single-user local vs commercial; App Server page "Auth endpoints").

If NO-GO: record the blocker, then evaluate the supported variant per spec §5. Candidates are the device-code flow, SIWC open-source token sharing (ADR-0002 §4),
or a controlled `codex login` setup helper. Re-run the affected steps.

## 2. Environment prep (W1-0)

Machine: Windows 11 x64 (record `winver` build; 24H2 26100.9278+ or 25H2 26200.9278+ for MXC per https://developers.openai.com/codex/windows).
Target PC: <pc-host> (Windows 11 Home, build 26200.8875 on 2026-10-18). **Run Windows Update to 26200.9278+ first.** Docker Desktop and WSL2 are installed.
**API-key hazard:** this PC has `OPENAI_API_KEY` set as a User environment variable (for gstack design). The probe must **assert** that the Codex child's env keys are a subset of the allowlist (CONTRACTS §1.1: OS essentials, proxy variables, `CODEX_HOME`) and that an `OPENAI_API_KEY` canary (`CANARY-<uuid>`) is absent from the child env and from all logs; it no longer just deletes the variable. The probe code change is DOT-089 (E02). The CODEX_HOME must be fresh. W1-2 and W1-3 count as PASS only if `account/read` reports ChatGPT auth (not an API key) in the same session. Any API-key auth is an automatic NO-GO for that step, never a GO.
Account: Gopi's ChatGPT account, signed in only by Gopi in the system browser. Standard (non-admin) user session.

```powershell
# W1-0 (PowerShell, normal user). Evidence: copy the whole console output to evidence\W1-0-env.txt
$PSVersionTable.PSVersion; (Get-ComputerInfo).OsName; [Environment]::OSVersion.Version; whoami; node --version   # Node >= 20
$W1 = "$env:USERPROFILE\dottie-w1"; New-Item -ItemType Directory -Force $W1 | Out-Null; Set-Location $W1
# Download pinned Codex (ADR-0003) and verify hash against evidence\codex-0.163.0-windows-assets.sha256
Invoke-WebRequest https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-pc-windows-msvc.exe.zip -OutFile codex.zip
(Get-FileHash codex.zip -Algorithm SHA256).Hash   # MUST equal DABDB4D16AAF10FEA40B74811C96EFDDCD9138F122163B69ED604FCB3EB704C3
Expand-Archive codex.zip -DestinationPath bin -Force; Get-ChildItem bin
$env:CODEX_BIN = (Get-ChildItem bin -Filter codex*.exe | Select-Object -First 1).FullName
& $env:CODEX_BIN --version                       # expect: codex-cli 0.163.0
# Dedicated, empty CODEX_HOME (ADR-0004). Never point this at %USERPROFILE%\.codex.
$env:CODEX_HOME = "$env:LOCALAPPDATA\DottieW1\codex"; New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
$env:PROBE_OUT = "$W1\evidence"
$env:PROBE_CODEX_ARGS = '-c cli_auth_credentials_store="keyring" -c forced_login_method="chatgpt"'   # see W1-5 / ADR-0004 (if keyring fails, re-run all with "file" and record it); forced_login_method per CONTRACTS §1.1
# Env check (CONTRACTS §1.1, DOT-089): the probe asserts that the Codex child's env keys are a subset of the allowlist and that the
# OPENAI_API_KEY and CODEX_ACCESS_TOKEN canaries (CANARY-<uuid>) are absent from the child env and from all logs. Set the canaries for this run:
$env:OPENAI_API_KEY = "CANARY-$([guid]::NewGuid())"; $env:CODEX_ACCESS_TOKEN = "CANARY-$([guid]::NewGuid())"
# Copy dottie-week1-probe.mjs here and verify its sha256 against dottie-week1-probe.mjs.sha256
(Get-FileHash .\dottie-week1-probe.mjs -Algorithm SHA256).Hash
& $env:CODEX_BIN app-server generate-json-schema --out "$W1\schema-win"   # diff against schema-0.163.0 later (E02)
```
PASS: hash matches, version 0.163.0, CODEX_HOME is empty, the probe's env assertion passes (child env keys ⊆ allowlist; both canaries absent from the child env and logs), and with `-c forced_login_method="chatgpt"` 0.163.0 honours the override: after sign-in `account/read` reports ChatGPT auth even though `OPENAI_API_KEY` is set (E02 records this; UNVERIFIED until run). Until DOT-089 lands, the probe still has the old delete-list scrub (L41-43) and **cannot** make this assertion, so W1-0 is not PASS on the old probe.

## 3. Stages
- **Stage A (CLI probe):** `node dottie-week1-probe.mjs <step>` from PowerShell. This proves protocol + account behaviour on Windows.
- **Stage B (packaged-like app, required for GO):** a minimal Electron app (BACKLOG DOT-004) whose main process runs the same adapter code. It spawns `codex.exe`
  with `windowsHide:true` from the app's resources folder, offers one **Sign in with ChatGPT** button, opens the system browser, and shows the account/plan, a
  "Run test task" button and a "Sign out" button. It is launched from a shortcut, **not** from a terminal. The Stage B transcript is written by the app with the same redaction rules.

## 4. Test steps and expected App Server messages

Message shapes come from the 0.163.0 schema and the Linux transcript (L#). "UNVERIFIED" means it has never been observed on the wire.

### W1-1 Official ChatGPT sign-in
Stage A: `node dottie-week1-probe.mjs signin` (fallback `--device`). Stage B: click **Sign in with ChatGPT**.
Expected:
1. `>> initialize` → `<< {result:{userAgent, codexHome:"…\DottieW1\codex", platformFamily:"windows"(UNVERIFIED), platformOs}}`. `>> initialized`.
2. `>> account/read` → `<< {account:null, requiresOpenaiAuth:true}` (L8).
3. `>> account/login/start {type:"chatgpt"}` → `<< {type:"chatgpt", loginId, authUrl:"https://auth.openai.com/oauth/authorize?…redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback…"}` (L10).
4. The system default browser opens auth.openai.com. Gopi signs in. The browser shows the Codex success page.
5. `<< account/login/completed {loginId, success:true, error:null}` (UNVERIFIED) and `<< account/updated {authMode:"chatgpt", planType:"<plan>"}` (UNVERIFIED).
PASS: (5) received, with no console window and no token on screen or in logs. Evidence: screenshots of browser consent + success page + app status; transcript.
Also record: any Windows Defender Firewall prompt for `codex.exe` (loopback should not prompt; note if it does).

### W1-2 Account read
`node dottie-week1-probe.mjs status`.
Expected: `<< {account:{type:"chatgpt", email:<redacted>, planType:"plus"|"pro"|…}, requiresOpenaiAuth:true}`. Also `refreshToken:true` succeeds.
PASS: `type=="chatgpt"` and planType matches what Gopi sees in ChatGPT settings (Gopi confirms verbally; the email is redacted in logs).

### W1-3 Authenticated Codex task
`node dottie-week1-probe.mjs task "Reply with the word OK."` (run from an empty test folder).
Expected: `thread/start` result `sandbox{type:"readOnly"}`, `approvalPolicy:"on-request"` (L17) → `turn/start` → `turn/started` → `item/started{userMessage}` →
`item/agentMessage/delta`* → `item/completed{agentMessage}` → `turn/completed{status:"completed", error:null}`. No `error` with 401.
PASS: status `completed`, assistant text contains "OK". Record `THREAD_ID`. Note the latency from turn/start to the first delta and to completed (baseline for E09).

### W1-4 Restart + session reuse
1. `status` again in a **new** PowerShell window (new app-server process) → PASS if signed_in without a new login.
2. `node dottie-week1-probe.mjs resume <THREAD_ID>` → `thread/resume` result includes the thread, and the turn completes. The answer references the previous message.
3. Sign out of Windows and back in (or reboot), then run `status` → PASS if still signed_in. Stage B: launch the app via its shortcut → shows signed-in state.
4. Record whether `account/read{refreshToken:true}` works after 24 h, as a follow-up observation (non-blocking).
PASS: 1–3 succeed with no browser interaction.

### W1-5 Logout
`node dottie-week1-probe.mjs logout`.
Expected: `>> account/logout` → `<< {}` → `<< account/updated{authMode:null, planType:null}` (L40-41) → `account/read` → `account:null`.
Then: `status` in a new process → signed_out. `task` → probe refuses (gate). Also run `task --ungated` once and expect a `401` failure path like L26-38.
Credential removal check **without reading contents**:
```powershell
Test-Path "$env:CODEX_HOME\auth.json"                    # file mode: expect False after logout (record before/after)
cmdkey /list | Select-String -Pattern 'codex|openai' -SimpleMatch   # keyring mode: record target NAMES only, before and after
```
PASS: signed_out in a fresh process, and the credential artifact (file or Credential Manager entry) is gone. Gopi's personal `%USERPROFILE%\.codex` is untouched
(`Get-Item "$env:USERPROFILE\.codex" -ErrorAction SilentlyContinue | Select LastWriteTime`, recorded before and after).

### W1-6 Negative and robustness cases (must run, non-blocking)
a. Cancel: `signin --cancel-after 5` → `{status:"canceled"}` + `login/completed{success:false}` (L11-13).
b. Port conflict: start `codex login` (CLI, same dedicated CODEX_HOME) in another window, then start probe `signin`. Record which login gets cancelled
   (code: `codex-rs/login/src/server.rs:637-680`). This input feeds RISKS R7.
c. Device-code flow: `signin --device` → record the `{verificationUrl,userCode}` shape (UNVERIFIED).
d. Browser closed without completing → wait for timeout behaviour and record it.
e. Network off during `task` → expect `error{willRetry:true}` then a failure with `codexErrorInfo` (record the variant).

### Spikes (run in Week 1, results feed ADR-0003 / ADR-0008 / ADR-0016)
- **W1-S1 Sandbox/packaging:** with `-c features.prefer_mxc=true` and default settings, run a task that needs a shell read (`dir`) and record the sandbox mode used,
  any admin prompt, and whether `codex-code-mode-host` warnings appear with the bare exe vs `codex-app-server-package-x86_64-pc-windows-msvc.tar.gz`.
- **W1-S2 Tool host on the interactive desktop (extended 2026-10-19; E11 P11; ADR-0008 decision rule).** Run one probe tool from two hosts:
  **(B)** a stdio MCP server registered in the test CODEX_HOME `config.toml` (a grandchild of the launcher through app-server), and
  **(A)** a worker spawned directly by the Node/Electron probe (the dynamic-tool host; `item/tool/call` needs `experimentalApi:true` in 0.163.0).
  From each host, record pass/fail and a redacted value for every check below:
  1. `GetForegroundWindow`: the foreground process name only, never the title.
  2. `IShellWindows` enumeration: count, plus the active tab's `Document.Folder.Self.Path` compared (final-path) with
  3. `SHGetKnownFolderPath(FOLDERID_Downloads)`. Record only whether they match, not the path.
  4. `SetForegroundWindow` on an Explorer window under the foreground lock: return value plus the observed foreground.
  5. Per-Monitor-v2 DPI awareness of the host process (`GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())`).
  Never use window titles as evidence. Report the sandbox mode in effect (MXC needs build ≥ 26200.9278; R16).
- **W1-S1 addendum (ADR-0016 shell path):** run `ping -t 127.0.0.1` through Codex exec in a turn, send `turn/interrupt` after 5 s, and record whether the process tree is gone
  within 2 s (`Get-Process ping`), the reported exit code, and the approval request seen.

## 5. Evidence package (E07 audits; stored under `docs/evidence/W1/` in the new repo)
For each step: (1) the redacted transcript `evidence\<ts>-<step>.jsonl` + `.stderr.txt`, (2) PowerShell console copy, (3) screenshots (Win+Shift+S) of the browser
consent, success page and app state, with email/plan cropped only if Gopi wants, (4) `W1-0-env.txt` with hashes and the Windows build, (5) a filled table:

| Step | Stage A | Stage B | Evidence files | Witness (E08) | Notes |
|---|---|---|---|---|---|
| W1-1 | | | | | |
| W1-2 | | | | | |
| W1-3 | | | | | |
| W1-4 | | | | | |
| W1-5 | | | | | |
| W1-6 a-e | | n/a | | | |
| W1-S1/S2 | | n/a | | | |

Before sharing evidence, check the transcript for secrets: `Select-String -Path evidence\*.jsonl -Pattern 'eyJ|refresh_token|access_token|code_challenge'` must return nothing.
