# Dottie: Architecture Record (v0.1, DRAFT)

- Author: E01 Lead Engineer / Technical Architect. Product Owner: Gopi Thungam.
- Prepared 2026-10-18 (CDT, UTC-5). Status: **Proposed**. Nothing here says that anything works unless an evidence path is given.
- Inputs: `spec.md` (v1.0), `audit.md`, the code under `src/` (read-only, not modified),
  the official Codex docs and repo (cited inline), and a Linux protocol smoke test (`docs/evidence/W1/linux-smoke/`).
- Spec mapping: spec §7 asks for `docs/architecture.md`, `docs/contracts/`, `docs/adr/` and `docs/risks.md`. This task writes them to `arch/` for now. Move them to `docs/` when the monorepo is scaffolded (BACKLOG DOT-003).

---

## 1. Scope and source-of-truth policy

Dottie is a Windows 11 (x64 first) tray app for signed-in users. It does on-device wake-word detection for "Dottie", turns a spoken
request into text, runs it as a task in the **official OpenAI Codex App Server** (spec §2, §4), uses scoped tools on the PC,
verifies the outcome and speaks the result (spec §1, §27; §17 in spec v1.0).

Codex is integrated, not reimplemented or forked (spec §1, §2). The upstream pin is **Codex `rust-v0.163.0`**, published
2026-10-15 16:30 CDT (https://github.com/openai/codex/releases/tag/rust-v0.163.0). That was the latest GitHub release on 2026-10-18 and npm
`@openai/codex@latest` = `0.163.0`. The local source clone in `src/codex` is `main` @ `8c07694`, committed 2026-10-17 20:58 CDT (authored 20:52 CDT). That is
newer than the release, so **the release binary's generated schema is the contract of record, not `main`** (ADR-0003).

## 2. Current state: what exists in `src/` today vs. what the spec requires

Legend: ✅ exists, with evidence · ⚠️ partial or pattern only · ❌ absent · ❓ claimed by the audit but not verifiable from `src/`.

| Spec requirement | State | Evidence (file paths under `src/`) |
|---|---|---|
| Electron tray app, single instance, auto-start, onboarding (§3.1, §13) | ❌ | No Electron, tray or systray code in any repo. `rg -il "porcupine\|electron\|systray\|pystray\|openwakeword"` outside `codex/` returned nothing. This matches audit §1. |
| Single-instance lock pattern | ⚠️ pattern | `Dollie_Bot_Private/src/lifecycle.ts`: a loopback TCP port 47741 lock for a Node Slack bot, not a desktop app. Electron has its own `requestSingleInstanceLock` (to verify in DOT-010). |
| Official Codex ChatGPT sign-in, account read, logout (§5) | ❌ in Dottie code; ✅ upstream | No Dottie code calls Codex. Upstream: `codex/codex-rs/app-server-protocol/src/protocol/common.rs:1301` (`account/login/start`), `:1329` (`account/login/cancel`), `:1335` (`account/logout`), `:1475` (`account/read`), `:2071` (`account/login/completed`), `:2018` (`account/updated`). Confirmed against the 0.163.0 binary in `docs/evidence/W1/linux-smoke/`. |
| Codex runtime adapter: threads, streaming, approvals, cancel (§4, §3.5) | ❌ | Upstream methods are present (`thread/start` `common.rs:552`, `thread/resume` `:558`, `turn/start` `:1057`, `turn/interrupt` `:1075`, server requests `item/commandExecution/requestApproval` `:1797`, `item/fileChange/requestApproval` `:1804`). |
| Auth status probe and billing-env guard pattern | ⚠️ pattern | `Groot_1.0/src/career_clone/auth/claude_session.py`: exit-code-first status probe, interactive login through the official CLI, and neutralising env vars that could switch billing. It is for Claude, not Codex. Reuse the idea, not the code. |
| On-device wake word "Dottie" (§3.3, §9.2) | ❌ | Nothing exists. `Bot/voice_assistant.py:438-452` streams **every** mic frame to OpenAI Realtime (`input_audio_buffer.append`) with no wake gate. That **conflicts** with spec §9.2 ("No continuous upload in standby"). |
| Mic/speaker I/O, device selection | ⚠️ | `Bot/voice_assistant.py:172-180` (`VOICE_INPUT_DEVICE` / `VOICE_OUTPUT_DEVICE`) and `:462-488` (sounddevice 24 kHz PCM16). This is on branch `fix/unexpected-session-exit` @ 5268c8d (checked out, detached). `main` @ 504da3e does not have it. |
| VAD/STT/TTS (§3.4) | ⚠️ cloud-only pattern | `Bot/voice_assistant.py:183-229`: Realtime `server_vad`, `gpt-4o-mini-transcribe`, voice `marin`, auth via `OPENAI_API_KEY`. This is API-billed and separate from ChatGPT (spec §1, §5). |
| Barge-in / "stop speaking" vs "stop task" | ⚠️ | `Bot/voice_assistant.py:526-538` flushes playback on `speech_started`. Prompt rules 12–14 (`:46-62`) are prompt-only semantics. The audit says MDC_First_agent `voice/echo.py` and `gate/confirm.py` are better, but **that repo is not in `src/`** ❓. |
| Coordinator state machine BOOTING→…→STANDBY (§4) | ❌ | No repo has it. Patterns: `Dollie_Bot_Private/src/store.ts` `claim()` dedupe; `Santa_Claus/packages/kernel/src/workflow.ts` (branch `p00-foundation`). |
| Default-deny policy, single-use approvals (§10) | ⚠️ / ❌ | `Santa_Claus/packages/policy/src/index.ts`: interfaces plus `failClosed()` only ("policy engine and approval workflow are P06"). `Bot/tools/registry.py:86-152` has an explicit tool allowlist (good). **The Bot approval flow fails open**: `Bot/voice_assistant.py:545-547` sets `pending_approval["confirmed"]=True` on *any* `input_audio_buffer.speech_stopped`. So "no" or noise counts as approval. Only `terminate_application` (`Bot/tools/desktop_tools.py:44-46`) and `delete_file` (`Bot/tools/file_tools.py:19-21`) are gated. `write_file`/`copy_file`/`move_file` overwrite whenever the *model* passes `overwrite=True` (`file_tools.py:547-625`), with no code-level approval. `delete_file` unlinks permanently, with no Recycle Bin (`file_tools.py:627-640`). |
| Explorer / known folders / UIA / multi-monitor tools (§3.6, §11) | ✅ code exists, ❌ tests | `Bot/tools/desktop_tools.py` (1,736 lines): `ExplorerController.navigate` verifies the destination with `Shell.Application` `Document.Folder.Self.Path` + `same_folder()` (`:382-437`); `monitor_layout()` (`:68-85`); `find_window` refuses ambiguous titles (`:101-120`); UIA `inspect_window`/`click_control` (`:1604-1682`); app allowlist (`:49-54`). `Bot/tools/file_tools.py` (963 lines): known folders through the registry (`:126-152`), `is_protected`/`ensure_mutable` (`:174-211`). **The Bot repo has no tests.** Windows-only imports (`winreg`, `pywin32`, `pywinauto`) mean none of this can run on this Linux box. |
| Shell tool (PowerShell/CMD) with timeouts/cancel (§11) | ❌ | Bot only `Popen`s allowlisted apps (`desktop_tools.py:1475-1496`). Codex has its own sandboxed exec on Windows (MXC/elevated/unelevated: https://developers.openai.com/codex/windows). |
| Browser via Playwright (§11) | ❌ | `Bot/tools/browser_tools.py` is one docstring line: "not registered yet". `groot-harness/orchestrator/verifier.py` shows the "pass/fail from the raw Playwright report" verification pattern only. |
| Office (Word/Excel/PowerPoint) | ❌ | Nothing exists. |
| Verifier (postconditions) | ⚠️ | Explorer path verification as above. `drag_across_monitors` honestly returns `success:false, verified:false` (`desktop_tools.py:1221-1226`). This is a good precedent for the `ToolResult.verified` contract. |
| Structured logs / SQLite state (§4, §3.8) | ⚠️ pattern | `Santa_Claus/packages/observability/src/redact.ts` (redaction). Bot logs only `print()`. |
| Contracts / typed events (§7) | ⚠️ pattern | `Santa_Claus/packages/contracts`, `packages/events/src/envelope.ts` (zod, versioned). This is a different product. |
| CI, secret scanning | ⚠️ pattern | `Santa_Claus/scripts/check-secrets.ts`, `.github/workflows/p00.yml`. Its own report says `evidence/P00/P00-REPORT.md:3` "Final P00 gate status: INCOMPLETE". |
| Installer, signing, SBOM (§13) | ❌ | Nothing exists. |

**Summary:** none of the Dottie product exists yet. The reusable assets are (a) Bot's Windows Explorer/file tools, which are untested,
Windows-only Python and partly fail-open, (b) auth-probe and lifecycle *patterns*, and (c) the upstream Codex App Server, which has the
complete auth/thread/turn/approval surface Dottie needs.

### 2.1 Spec ↔ audit ↔ code conflicts and discrepancies (recorded, not resolved here)

| # | Conflict | Sources | Handling |
|---|---|---|---|
| C1 | **App Server auth vs commercial use.** The spec assumes that "official Codex ChatGPT authentication" through the runtime is the path (§5). OpenAI's App Server page now says: *"App-server authentication has never been permitted for commercial or hosted services... we recommend migrating to Sign in with ChatGPT"* (https://developers.openai.com/codex/app-server, section "Auth endpoints"). The audit does not mention this. | spec §5, §5 Licensing; audit §3 | ADR-0002 plus an open question for the PO. Week-1 is valid **only** for single-user/personal or open-source use until the PO decides. |
| C2 | The spec names `codex-rs/app-server/README.md` as the "App Server documentation". At `main` 8c07694 that README holds only feature notes (thread list exclusions, gateway OAuth, etc.), not the core protocol. The full protocol doc is https://developers.openai.com/codex/app-server, plus the generated schema. | spec §2; `src/codex/codex-rs/app-server/README.md` | Cite both. The generated schema of the pinned binary wins. |
| C3 | Official doc examples use `approvalPolicy:"unlessTrusted"` and `sandbox:"workspaceWrite"`. The 0.163.0 generated schema accepts `AskForApproval` = `untrusted \| on-request \| never \| {granular}` and `SandboxMode` = `read-only \| workspace-write \| danger-full-access`. `sandboxPolicy.type` (turn-level) is camelCase (`readOnly`, `workspaceWrite`, ...). | docs vs `docs/evidence/W1/linux-smoke/schema-0.163.0/ClientRequest.json` | CONTRACTS.md uses the schema values. Flagged as a doc inconsistency. |
| C4 | ~~Conflict~~ **Resolved, no conflict:** the audit says 8c076942 was "committed 2026-10-17 20:58 CDT". `git log` shows author date 01:52:25Z (20:52 CDT) and **committer date 01:58:02Z (20:58 CDT)**, so the audit quotes the committer date correctly. | audit header; `git -C src/codex log -1 --format='%aI %cI'` | None. This row is kept so the earlier draft claim can be traced. |
| C5 | The audit covers `Dottie_Bot` (private) and `MDC_First_agent` (private). **Neither is in `src/`**, so the MDC claims (echo gate, `gate/confirm.py` fail-closed table, about 90 tests) cannot be checked here. | audit §1–2 | Marked ❓. DOT-006 requires a read before any reuse. |
| C6 | Spec §2 says to "choose either the TS SDK or App Server after an early PoC". The audit already recommends App Server. | spec §2; audit §3 | ADR-0001 stays *Proposed* until the Week-1 PoC passes on Windows. |
| C7 | The audit says `docs/install.md` still says "Windows 11 via WSL2". The current official Windows page says native PowerShell with a Windows sandbox is supported and Windows 11 is "Recommended". | audit §3; https://developers.openai.com/codex/windows | Use the official page. Verify on hardware. |
| C8 | The audit ran the Dollie_Bot_Private tests on "Node 20 on Linux". Its `TEST_REPORT.md` says Windows Node v24.21.0. | audit §1; `Dollie_Bot_Private/TEST_REPORT.md` | Not material to Dottie. That repo is a Slack bot. |
| C9 | Spec §4 wants the Codex adapter to show "approvals". When signed out, App Server accepts `thread/start` and `turn/start` and fails only after about 14 s of 401 retries (Linux evidence). The spec's AUTH_REQUIRED state needs Dottie-side gating. | spec §4, §5; `docs/evidence/W1/linux-smoke/appserver-0.163.0-unauth.jsonl.txt` lines 16–38 | ADR-0010. |
| C10 | **Not in the audit:** while this record was being written (08:29–08:41 CDT 2026-10-18), other agents created `packages/verifier/` (E11, a Python verifier that wraps `src/Bot/tools`, not a git repo), `apps/desktop/`, `packages/`, `docs/` and `e10/` (including `e10/mdc_mirror`) under `/workspace/dottie`. This architecture does not review them. | `ls -la /workspace/dottie`, `packages/verifier/README.md` | E01 reviews them against CONTRACTS.md before they are merged into the monorepo (DOT-003). `e10/mdc_mirror` may resolve C5; check it in DOT-006. |

## 3. Components

| ID | Component | Process | Owner | Responsibility | Built on (or new) |
|---|---|---|---|---|---|
| K1 | **Electron main / lifecycle manager** | `Dottie.exe` (main) | E06 | Single instance, tray, auto-start at user sign-in (not a service), child-process supervision, secure IPC broker, opening the system browser for `authUrl` | New |
| K2 | **Renderer UI** (onboarding, settings, activity, approval dialogs) | Electron renderer (sandboxed, `contextIsolation`) | E06 | Display only. No shell, credential, mic engine or unrestricted fs access (spec §4) | New |
| K3 | **Task coordinator / state machine** | main process (module) | E03 | Spec §4 states, idempotency, request/task IDs, dispatch, cancel semantics, auth gating | New (patterns: `Dollie_Bot_Private/src/store.ts`) |
| K4 | **Codex runtime adapter** | main process (module) + **child `codex app-server` (stdio)** | E02 | JSONL JSON-RPC client, initialize handshake, account/thread/turn methods, approval server-request bridge, version check | New, on upstream App Server |
| K5 | **Auth & account state** | inside K4/K3 | E02 / E08 | `AuthState` from `account/read` + `account/updated`. Login/cancel/logout. Never touches tokens | New |
| K6 | **Local audio worker** | child process (language TBD, ADR-0006) | E05 / E10 | Mic capture → resample → on-device wake word → VAD → hand-off to STT. TTS playback, barge-in, echo suppression, device changes | New. Wake engine per spec: Porcupine (ADR-0007) |
| K7 | **STT/TTS provider client** | in K6 or main | E05 | Speech to text and back after wake only. Provider **not yet chosen** (Open Q). | New |
| K8 | **Policy / permission gate & action audit** | main process (module) + enforced again inside K9 | E08 | Default-deny scopes (§10), single-use approvals, audit log | New (pattern: `Santa_Claus/packages/policy` `failClosed`) |
| K9 | **Dottie tool server(s)** (Explorer/files/windows/UIA; later shell, browser, Office) | child process(es), MCP over stdio, **launched by Codex App Server** as configured MCP servers (ADR-0008) | E04 / E11 | Scoped Windows actions with postcondition verification | Port/wrap `Bot/tools/desktop_tools.py`, `file_tools.py` (ADR-0006), adding tests first |
| K10 | **Verifier** | inside K9 per tool + K3 aggregate | E11 | Observed postconditions, not "tool returned OK" | Pattern from `desktop_tools.py:382-437` |
| K11 | **Recovery & local store** | main process. SQLite under `%LOCALAPPDATA%\Dottie\` | E09 / E03 | Task history, threadId map, settings, structured redacted logs | New |
| K12 | **Observability** | all | E09 | Correlation IDs, latency metrics, redaction | Pattern: `Santa_Claus/packages/observability/src/redact.ts` |

## 4. Process model

```text
Windows user sign-in
  └─ Dottie.exe  (Electron main, single instance, per-user Run/startup entry; no console)       [K1,K3,K4-client,K5,K8,K11]
       ├─ Renderer (sandboxed BrowserWindow / tray popups)                                         [K2]
       ├─ audio-worker  (child, supervised; local mic + wake word; no network in STANDBY)         [K6]
       └─ codex-app-server (child, supervised; `codex app-server --listen stdio://`, windowsHide)  [K4-server]
             ├─ Codex sandboxed command exec (MXC / elevated / unelevated; Codex-owned)
             ├─ dottie-tools MCP server (child of app-server; stdio; Windows-session desktop access)  [K9]
             └─ ChatGPT OAuth login callback listener on 127.0.0.1:1455 (only during login; Codex-owned)
```

- **Transport to App Server:** newline-delimited JSON over the child's stdin/stdout. The `"jsonrpc":"2.0"` field is left off on the wire
  (https://developers.openai.com/codex/app-server, "Protocol"; `src/codex/codex-rs/app-server-protocol/src/rpc.rs:1-2`). stderr goes to the
  redacted diagnostic log only. WebSocket transport is "experimental and unsupported" and is **not used**.
- **Supervision (spec §13.5):** the supervisor restarts only crashed children, with exponential backoff and a cap. An app-server restart re-runs `initialize` →
  `initialized` → `account/read` → `thread/resume` for any threads Dottie needs (ADR-0005). A user Quit stops all children and does not resurrect them.
- **Lazy start:** app-server can start lazily on the first wake, or eagerly in "readiness mode" (spec §9.1). Default: **eager**, so that
  `account/read` gives a truthful tray status (Standby / Auth required / Offline) at boot. Measure the resource cost (E09).
- **Desktop session:** K9 must run in the interactive user session so it can drive UIA/Explorer. *Unverified:* whether MCP servers that App Server
  launches on Windows run inside Codex's sandbox restrictions (MXC / private desktop). The official page says "By default, both legacy sandbox modes
  also use a private desktop" for **sandboxed commands**. If that applies to MCP servers too, UIA control would fail. → Week-1 spike W1-S2.

## 5. Data flow (happy path, spec §9 example "open File Explorer and go to Downloads")

1. K6 (STANDBY, local only) detects "Dottie" → `WakeDetected` → K3 enters WAKE_DETECTED → LISTENING.
2. K6 VAD ends the utterance → audio goes to K7 (STT; the first upload of audio happens here, as disclosed) → `UtteranceReady{requestId,text}`.
3. K3 checks `AuthState` (K5). If not `signed_in` (allow-list; ADR-0012) → AUTH_REQUIRED, and nothing is sent to Codex (ADR-0010).
4. K3 → K4: `TaskRequested{taskId, requestId, text, threadId?, workspaceScope}` → `turn/start {threadId, input:[{type:"text",text}], cwd?, approvalPolicy, sandboxPolicy}`
   (with `thread/start` or `thread/resume` first if needed).
5. App Server streams `turn/started`, `item/started` / `item/completed`, `item/agentMessage/delta` → K4 maps them to `TaskProgress`.
6. Codex calls the Dottie MCP tool `explorer.open_known_folder{folder:"downloads"}` → K9 checks policy scope (K8) → acts → verifies
   `Shell.Application` path == known folder → returns `{success, verified:true, observedState}` → `ToolResult`.
7. If Codex or a tool needs approval → server request (`item/commandExecution/requestApproval` etc.) or a Dottie policy approval → `ApprovalRequested` →
   renderer secure dialog → `ApprovalResolved` → the response goes back to App Server.
8. `turn/completed{turn.status}` → K10 combines tool `verified` flags → `TaskFinished{outcome, verified, summary}` → K7 TTS → SPEAKING → STANDBY.
9. Cancel: "stop the task" → `turn/interrupt{threadId, turnId}` → the turn ends with `status:"interrupted"` → `TaskCancelled{stopStatus}`, filled in from
   observed tool state, never assumed (spec §4 speaking policy, §14 benchmarks).

## 6. Trust boundaries

| TB | Boundary | Crossing data | Controls |
|---|---|---|---|
| TB1 | Microphone → audio worker | raw PCM | Local only in STANDBY. Mute is enforced in the worker *and* by closing the device. No raw audio in general logs (spec §7 `WakeDetected`) |
| TB2 | Audio worker → STT/TTS cloud provider | post-wake utterance audio, TTS text | Only after wake + disclosure + consent (spec §9.5). Separate billing/credential from ChatGPT (spec §1). Provider TBD |
| TB3 | Renderer ↔ main | typed IPC messages | contextIsolation, a preload allowlist, schema-validated payloads, no secrets ever sent to the renderer (spec §4, §5) |
| TB4 | Main ↔ codex-app-server child | JSON-RPC over stdio | Local pipe only (no listening socket). The pinned binary is checked against its sha256 at launch. The env is scrubbed of `OPENAI_API_KEY`/`CODEX_API_KEY`/`CODEX_ACCESS_TOKEN` so billing cannot silently switch to an API key (spec §5; pattern `Groot_1.0/.../claude_session.py` `subprocess_env_overrides`) |
| TB5 | codex-app-server ↔ OpenAI (auth.openai.com, chatgpt.com, api.openai.com) | OAuth, inference | Owned by Codex. Dottie never sees tokens |
| TB6 | System browser ↔ Codex login callback 127.0.0.1:1455 | OAuth code | Owned by Codex (PKCE S256, state, seen in the Linux evidence). Dottie only opens `authUrl` after checking `https://auth.openai.com/` as prefix |
| TB7 | codex-app-server → Dottie MCP tool server | tool calls with model-chosen args | **Untrusted input.** K9 re-checks scopes, paths and allowlists in code, not in the prompt. Approvals are required for high-impact actions (spec §10). External content is treated as data (prompt-injection rule, spec §10) |
| TB8 | Tool server → Windows desktop / files | UIA, COM, fs | Protected paths (`file_tools.is_protected` pattern), no elevation, explicit postconditions |
| TB9 | Local store / logs | task history, IDs | Redaction, no tokens, no raw audio, per-user `%LOCALAPPDATA%` (spec §8) |

## 7. Auth / session model (ADR-0002, ADR-0004)

- **Mechanism:** App-Server-managed ChatGPT OAuth. `account/login/start {type:"chatgpt"}` → Dottie opens `authUrl` in the default browser
  → Codex's local callback → `account/login/completed {loginId, success}` + `account/updated {authMode:"chatgpt", planType}`.
  Fallback: `{type:"chatgptDeviceCode"}` (show `verificationUrl` + `userCode`). Never `apiKey` (unless the PO approves a separately billed mode, spec §5),
  never `chatgptAuthTokens` ("[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE": `codex-rs/app-server-protocol/src/protocol/v2/account.rs`, `LoginAccountParams::ChatgptAuthTokens`).
- **Token custody:** Codex persists and refreshes the tokens ("Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them automatically":
  official App Server page). Storage is set by `cli_auth_credentials_store` = `file` (default, `CODEX_HOME/auth.json`) | `keyring` | `auto` | `ephemeral`
  (`codex-rs/config/src/types.rs` `AuthCredentialsStoreMode`). Proposed: `keyring` (Windows Credential Manager), to be verified in Week 1. Dottie code
  **never opens** `auth.json` or the keyring entry.
- **Session status:** the source of truth is `account/read` (`{account:{type:"chatgpt",email,planType}|null, requiresOpenaiAuth}`) and the `account/updated`
  notification. Docs say notifications are "snapshots: clients reread current account and requirements state rather than treating a queued notification as
  authorization" (`src/codex/codex-rs/app-server/README.md` §"Selected workspace routing"). So Dottie re-reads after every `account/updated`.
- **Restart:** a new app-server process with the same `CODEX_HOME` → `account/read` should report the saved login with no browser (**to be proven on Windows, W1-4**).
- **Expiry:** `account/read {refreshToken:true}` triggers a proactive refresh in managed mode (schema `GetAccountParams`). A 401 during a turn shows up as
  `codexErrorInfo.httpConnectionFailed{httpStatusCode:401}` / `responseStreamDisconnected{401}` (Linux evidence). It is mapped to AUTH_REQUIRED + "Reconnect ChatGPT".
  Wake-word standby keeps working (spec §5).
- **Logout:** `account/logout` → `{}` + `account/updated{authMode:null}`. Then re-read; `account` must be `null`.
- **Plan limits:** `account/rateLimits/read` and the `account/rateLimits/updated` notification. `codexErrorInfo.usageLimitExceeded` is shown truthfully, with no fallback to an API key (spec §5).
- **Callback port:** fixed preferred port 127.0.0.1:1455 with a registered fallback port. If the port is busy, Codex tries to cancel the other login server
  (`codex-rs/login/src/server.rs:78, 637-680`). This can cancel a login the user is doing at the same time in Codex CLI or the desktop app (RISKS R7).

## 8. Key cross-cutting rules
- Spec §1 constraints are release blockers: no password collection, no cookie scraping, no imitation OAuth, no credential copying, no "always on" claims beyond
  what Windows allows.
- Every task outcome includes `verified`. "Done" without an observed postcondition is reported as unverified (spec §11).
- Stop-speaking ≠ cancel-task ≠ new-task (spec §4). Cancellation is reported only from observed state (spec §14).

## 9. ADR index
See `docs/adr/`.
- ADR-0001 integration (App Server) — Proposed
- ADR-0002 auth path — **Accepted** 2026-10-18 (personal single-user)
- ADR-0003 pin & packaging of Codex — Proposed; pin record added 2026-10-19
- ADR-0004 CODEX_HOME & credential store — Proposed
- ADR-0005 process model & supervision — Proposed; backoff moved to ADR-0013
- ADR-0006 reuse Python assets as workers — Proposed; Bot pin note
- ADR-0007 on-device wake word — Proposed
- ADR-0008 tool hosting MCP vs dynamic — Proposed, decided by W1-S2
- ADR-0009 fail-closed policy & approval bridging — Accepted 2026-10-19 (E08 signed off)
- ADR-0010 coordinator state machine & auth gating — Proposed; allow-list note
- ADR-0011 fresh monorepo — Proposed
- ADR-0012 contract vocabulary & envelope v2 — **Accepted** 2026-10-19
- ADR-0013 supervisor restart policy — **Accepted** (shape; numbers PROVISIONAL)
- ADR-0014 per-user data root `%LOCALAPPDATA%\Dottie` — **Accepted** 2026-10-19 (E08 co-sign pending verification of applied changes)
- ADR-0015 sign-in URL handling — **Accepted** 2026-10-19 (E08 co-sign pending verification of applied changes)
- ADR-0016 single shell execution path — Proposed, decided by W1-S1
- ADR-0017 verifier recovery approval reuse (amends ADR-0009; resolves DOT-074) — Proposed (E08 author)

Triage of the 2026-10-18 doc/code conflicts, plus the E02 and E11 inputs: `docs/triage/TRIAGE-2026-10-18.md`.
