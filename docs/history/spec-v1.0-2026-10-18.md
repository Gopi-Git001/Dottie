# DOTTIE — Windows Voice-to-Action Assistant
## Lead Engineer Master Handoff: Architecture, Team Delegation, Delivery, Testing and Release

**Document version:** 1.0  
**Prepared:** 18 October 2026  
**Owner:** Product Owner / Founder  
**Accountable technical owner:** Lead Engineer  
**Platform:** Windows 11 first (x64; ARM64 only after explicit verification)  
**Scope:** Installable, local-first Windows personal assistant using official OpenAI Codex as the task engine  
**Status:** Implementation specification / not a statement of completed work

---

## 1. Executive directive

Build **Dottie**, a Windows application that starts at user sign-in, stays available in the system tray, locally listens for the wake word **“Dottie”**, accepts a spoken request, runs the request through **OpenAI Codex**, uses permitted tools to operate the user's computer, verifies results, and speaks back a concise response. No terminal should have to be opened manually in normal use.

**Primary user journey:** Install Dottie → sign in with ChatGPT through the *official supported Codex authentication flow* → grant microphone and selected computer permissions → optionally enable launch at Windows sign-in → say “Dottie” → give task → see/hear execution result → return to standby.

**Engineering mandate:** Integrate rather than reimplement Codex. Reuse existing SDKs, system capabilities, and evaluated desktop automation tools. Deliver reliable end-to-end behavior before expanding to every application. Preserve security controls and user ownership of the device.

**Important constraints:**
- Codex's open-source code does not imply that all models, APIs, hosted inference, speech services, or commercial usage are free. Review current terms, quotas and deployment rights.
- ChatGPT subscription login is **not** a universal login for unrelated APIs. Identify API-billed speech services and third-party licenses explicitly. Never claim that ChatGPT Plus alone covers them.
- Do not collect ChatGPT passwords, scrape browser cookies, extract credentials, imitate OAuth pages, or embed unofficial authentication workarounds.
- Sign-in is required for Codex execution; local wake-word detection and tray controls can work offline. When credentials expire or the network is unavailable, show a truthful status and allow reauthentication.
- “Always running” means **after the user signs in, while Windows permits the background app and microphone to operate**. Do not claim availability before login, during shutdown, or through all sleep/lock/power states.
- Wake-word detection does not authorize purchases, deleting data, executing elevated commands, or accessing protected content.

## 2. Official upstream and source-of-truth policy

**Open-source Codex repo:** https://github.com/openai/codex  
**Codex documentation:** https://developers.openai.com/codex  
**Codex TypeScript SDK source:** https://github.com/openai/codex/tree/main/sdk/typescript  
**Codex App Server documentation:** https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md  
**Codex Python SDK reference for login options:** https://github.com/openai/codex/tree/main/sdk/python  
**Porcupine wake word:** https://picovoice.ai/docs/quick-start/console-porcupine/  

The Lead Engineer must review the **current** repo README, LICENSE (Apache-2.0 as currently published), SDK APIs, app-server protocol, Windows support, authentication docs, and release notes before pinning a version. Record commit SHA or package version in `docs/dependencies.md`. Choose either the official **TypeScript SDK** or **App Server** as the production-facing Codex integration after an early proof of concept. Do not introduce an unsupported dual control path. App Server can provide more account/session/approval control but introduces protocol lifecycle responsibilities. Confirm the precise login event and endpoint for the pinned release.

Do not fork and modify Codex Core unless a documented upstream limitation requires it. Prefer a version-pinned dependency and an adapter. Keep any patches isolated and maintainable.

## 3. Product scope and exclusions

### V1 must deliver
1. Installable Windows app with clear onboarding, uninstall, system-tray controls and optional start-at-sign-in.
2. Official Codex ChatGPT authentication; reuse valid Codex session where supported, show session status, support logout/relogin.
3. On-device “Dottie” detection; microphone selection; mute; visible recording/listening indicator; configurable wake sensitivity.
4. Speech-to-text for captured commands, optional spoken response, and barge-in/stop-command handling.
5. Task execution through Codex, preserving thread identity, displaying progress and approvals, with cancellation and verification.
6. Bounded computer-control workflows: applications, File Explorer navigation in the same window, files, PowerShell/CMD (and Bash when installed), browser through Playwright, and Word/Excel/PowerPoint document workflows.
7. Working on laptops with one or multiple monitors and laptop/headset microphones.
8. Recovery from app/process crashes and temporary network, audio or tool failures; structured local logs.
9. Permission enforcement, action previews when necessary, and approval for high-impact operations.
10. Test reports and reproducible signed/releasable build artifacts with source and installer instructions.

### Outside V1 unless approved in change control
Mobile apps; cloud-multiagent orchestration; autonomous purchasing without explicit per-transaction confirmation; bypassing OS security; control while powered off; all-sites/all-apps reliability guarantees; custom foundation-model training; an elaborate dashboard; support for unattended actions on a locked desktop; remote access to the entire PC.

## 4. Target architecture

```text
Windows sign-in
    |
    v
Dottie tray / Electron app (single instance, startup, preferences, permission UI)
    |
    +-- Local audio worker ------------------------------------+
    |     mic -> resample -> wake-word "Dottie"                 |
    |     standby (no standby audio uploaded)                   |
    |     wake -> VAD -> STT -> command text                     |
    |     TTS -> speakers; interrupt/echo suppression           |
    |                                                          v
    +-- Task coordinator / state machine  <--- events ---> UI / voice
               |
               +-- Auth & account state (official Codex flow)
               +-- Codex runtime adapter (SDK OR app-server)
               |       task stream, thread IDs, approvals, cancel
               +-- Permission/policy gate and action audit
               +-- Tool router (MCP/adapters; explicitly scoped)
               |       +-- Windows UIA, window discovery/focus
               |       +-- Desktop mouse/keyboard/screenshots
               |       +-- Files and Office document operations
               |       +-- Shell (PowerShell / CMD / optional WSL)
               |       +-- Playwright/browser research
               +-- Verifier (observe postcondition, not just API success)
               +-- Recovery & SQLite state/logs
```

**Process separation:** Renderer has no direct shell, credential, microphone engine, or unrestricted filesystem access. Electron main process owns secure IPC and lifecycle. Isolate audio processing and risky tool executors where practical; enforce single-instance startup and child-process supervision. Keep microphone capture out of cloud processing until activation and explicit user consent. Use Windows accessibility/UIA element targeting first, window-bound actions next, and coordinate/screenshot fallback only when needed and verified.

**State machine:** `BOOTING -> STANDBY -> WAKE_DETECTED -> LISTENING -> TRANSCRIBING -> CONFIRMING?(optional) -> EXECUTING -> VERIFYING -> SPEAKING -> STANDBY`. Additional events: `MUTED`, `AUTH_REQUIRED`, `PERMISSION_REQUIRED`, `CANCELLING`, `RECOVERING`, `ERROR`, `SHUTDOWN`. Define valid transitions and idempotency rules; prevent duplicate command submissions.

**Speaking policy:** In conversational mode, Dottie can respond naturally; for computer actions use short progress and outcome confirmations. Allow instant interruption, with separate semantics for *stop speaking*, *cancel current task*, and *begin a new task*. Cancellation must propagate to active tool processes when safe; a stopped voice response alone must never be reported as stopping the underlying task.

## 5. Authentication, licensing and subscriptions

### Required user experience
- First launch has a real **Sign in with ChatGPT** control **only if the pinned Codex runtime supports the official app login flow**. Start the official flow and open the system browser (or supported device-code flow), display status and completion, and verify the authenticated account via official account-state methods.
- Reuse existing Codex authentication when allowed by SDK/runtime. Never read or copy Codex credentials into the renderer or own token store unnecessarily.
- If only the CLI authentication flow is supported for the selected integration, present an accurate browser/device sign-in flow or controlled setup helper. Do not simulate a native OAuth flow.
- On restart, probe session validity. On expired login, keep Dottie wake-word standby working and offer **Reconnect ChatGPT** before executing Codex tasks.
- Surface plan limits/errors without silently falling back to a billable API key.
- Provide explicit optional API-key mode only if Product Owner approves it; describe billing separately.

### Go/no-go auth investigation (Week 1)
Lead + Senior AI engineer must demonstrate an official ChatGPT sign-in initiated from the packaged-like app, account-state read, authenticated Codex request, restart/session reuse, and logout. If one part is unsupported by the chosen integration, document the blocker and select a supported SDK/app-server variant. Do **not** assume every Codex SDK has identical login APIs.

### Licensing
Inventory Codex licenses/notices, Electron, wake-word provider, STT/TTS, Playwright/browser downloads, Office dependencies and installer/update libraries. Confirm whether the intended deployment is **single user** or **commercial distribution**; a personal ChatGPT subscription must not be represented as an application-wide license or shared credential. Budget separately for speech services and other usage-based APIs.

## 6. Eleven-person team — direct responsibilities

| ID | Role | Accountable output | Depends on / interfaces |
|---|---|---|---|
| E01 | Lead Engineer / Technical Architect | Architecture record, public interfaces, backlog, release gate, code reviews | All; reports to Product Owner |
| E02 | Senior AI / Codex Engineer | Codex runtime adapter, official login, threads/streaming, usage/error handling | E01, E03, E08 |
| E03 | Agent Architecture Engineer | Command state machine, dispatch, cancellation, approvals, retries, recovery | E02, E04, E08 |
| E04 | Windows Integration Specialist | UIA, File Explorer, shell, Office, browser adapters | E03, E11 |
| E05 | Voice AI Engineer | Wake-word pipeline, STT/TTS, VAD, audio session, device selection | E06, E10 |
| E06 | Desktop Application Engineer | Electron main/UI/tray, auto-start, settings, onboarding, installer UX | E02, E05, E08 |
| E07 | QA / Automation Engineer | Automated test harness, integration tests, bug triage and acceptance evidence | All; independently blocks release |
| E08 | Platform / Security Engineer | Permission boundaries, auth isolation, logs, install/update/recovery controls | E01, E02, E06 |
| E09 | Performance & Reliability Engineer | Latency/resource instrumentation, soak testing, profiling, process supervision | E05, E06, E03 |
| E10 | Audio DSP / Speech Systems Engineer | Wake tuning, echo suppression, noise robustness, barge-in, false-trigger metrics | E05 |
| E11 | Computer-Use Reliability Engineer | UI recovery strategies, observation/postconditions, multi-monitor targeting | E04, E07 |

**Role boundary:** E05 owns end-to-end voice pipeline; E10 owns the signal-processing quality within it. E04 owns computer-control implementations; E11 owns verification/fallback and robustness. E02 owns Codex SDK/auth; E03 owns orchestration; E01 owns architectural decisions. E07 has independent test authority. E08 owns security policy and is required to approve sensitive capabilities.

## 7. Delegation, reporting and development operations

**Product Owner → E01 Lead → workstream leads → engineers.** The Lead Engineer is the sole integrator of architectural decisions; no engineer privately changes shared interfaces.

Workstreams:
- **AI & task lifecycle:** E02 + E03.
- **Voice & desktop UX:** E05 + E10 + E06.
- **Computer use:** E04 + E11.
- **Safety/platform/quality:** E08 + E09 + E07, coordinated by E01.

At kickoff, E01 creates `docs/architecture.md`, `docs/contracts/`, `docs/adr/`, `docs/risks.md`, `docs/requirements-matrix.md`, and `docs/weekly-status.md`. Write interface contracts *before* parallel implementation.

**Each engineer's ticket must contain:** ID, owner, purpose, boundaries, input/output contract, dependencies, policy/permission implications, acceptance tests, evidence path, and failure/rollback behavior. No “done” without automated checks, code review and evidence.

**Daily operating rhythm:** 15-minute dependency unblock meeting; asynchronous written status (`done / next / blockers / evidence`); continuous integration to a protected `main`; daily integrated Windows build; twice-weekly end-to-end demo; weekly founder acceptance demo. E01 reviews critical path daily.

**Repository discipline:** Trunk-based with short `feature/<ticket>` branches, reviewed pull requests, typed API schema, pinned dependency lockfile, changelog, reproducible CI, code signing secrets only in secure CI. Protect `main`; require E07 on test-significant changes and E08 on permission/auth changes. Feature flags for incomplete integrations. Never hand off unreviewed code by copy/pasting between teammates.

**Shared event contract (v1):**
- `WakeDetected {timestamp, deviceId, confidence}` (no raw audio in general logs)
- `UtteranceReady {requestId, text, locale, endReason}`
- `TaskRequested {taskId, requestId, text, threadId?, workspaceScope}`
- `TaskProgress {taskId, state, message, toolId?, redactedMetadata}`
- `ApprovalRequested {taskId, actionId, summary, risk, expiry}`
- `ApprovalResolved {actionId, approved, timestamp}`
- `ToolResult {taskId, toolId, observedState, verified, error?}`
- `TaskFinished {taskId, outcome, verified, summary}`
- `TaskCancelled {taskId, stopStatus}`

Agree on transport (typed Electron IPC / local worker RPC), version schemas and examples; log event IDs and correlation IDs without secrets.

## 8. Proposed repository layout

```text
dottie/
  apps/desktop/          # Electron main/renderer/tray/onboarding
  packages/contracts/    # Typed events/IPC schemas
  packages/codex-adapter/# SDK or app-server integration
  packages/voice/        # Wake, VAD, STT/TTS, device handling
  packages/coordinator/  # Task lifecycle, consent, cancellation
  packages/policy/       # Permissions/approvals/audit rules
  packages/tools/        # Scoped desktop/browser/office/shell adapters
  packages/observability/# Traces, metrics, diagnostics
  tests/unit/
  tests/integration/
  tests/e2e-windows/
  tests/fixtures/
  docs/adr/
  docs/contracts/
  docs/evidence/
  docs/security/
  scripts/
  .github/workflows/
```

Local app data belongs in an appropriate per-user Windows AppData directory; never in a writable installation folder. App uninstall must clearly distinguish application binaries, preferences, diagnostic logs, and user documents.

## 9. End-to-end operating workflow

1. **Windows sign-in:** Per-user auto-start launches one tray instance. An app lifecycle manager brings up UI, local audio worker and Codex runtime lazily or in readiness mode. No console is shown. Respect disabled startup and mute settings.
2. **Standby:** Microphone audio is evaluated **locally** for “Dottie”. No continuous upload in standby. Show microphone status and allow immediate pause. Keep CPU/battery impact bounded.
3. **Wake:** Play optional short confirmation tone. Wake-word debounce; avoid triggering on Dottie's TTS output. If audio device changes, reopen gracefully.
4. **Listen:** Capture the command with voice activity detection and timeout. Support “Dottie, [command]” in one utterance, and a wake-then-command pause. Prompt only if speech is unintelligible.
5. **Transcribe:** Use approved STT provider or on-device model. Tell users whether activated speech goes to a cloud service. Do not process idle/background speech as commands.
6. **Interpret & dispatch:** Coordinator assigns request ID, Codex thread and scope; passes command to Codex. Show streaming updates. No second planning LLM is required.
7. **Permission check:** The scoped tool adapter validates path/app/network/action boundaries. Read-only or non-sensitive tasks may proceed within explicitly granted scope. Destructive/elevated/payment/external-send operations require specific user approval. Voice identity alone is not sufficient for sensitive confirmation; provide a secure UI confirmation when needed.
8. **Execute:** Prefer structured operation via native APIs/UIA/Office libraries over brittle mouse coordinates. Shell tools use limited working directory and command policy. Browser actions are user-visible when authentication/purchases are involved.
9. **Verify:** Inspect resulting window state, saved file, command exit code **plus meaningful postcondition**, downloaded artifact, etc. Surface partial success honestly. Retry only when safe and bounded.
10. **Respond:** Speak a brief grounded result or error. Maintain task history. Return to local wake-word standby, or permit an explicit short follow-up window.
11. **Interrupt:** Barge-in halts TTS quickly. “Stop the task” triggers executor cancellation and confirmation of state; do not falsely claim undo. Commands switching tasks are queued or cancel-then-start according to an explicit rule.
12. **Reconnect:** On network loss or expired authentication, stop new Codex inference, preserve safe task state, display recovery UI and resume only where idempotent/approved.

**Example acceptance flow:** “Dottie, open Downloads, find the newest PDF, and show it.” Dottie activates → transcribes → Codex identifies task → local file/desktop adapter searches Downloads → opens matched PDF in preferred viewer → verifier checks viewer and correct path → Dottie confirms. If two candidates tie, ask a short clarification before modifying anything.

## 10. Scope and tool permissions

Use a default-deny, least-privilege policy with explicitly consented capability scopes and workspace paths. Separate scopes for `files.read`, `files.write`, `shell.execute`, `desktop.control`, `browser.navigate`, `network.send`, `app.install`, `credentials.access` (generally forbidden), and `purchases`. Record origin and limits for each action.

**Always explicitly confirm:** purchases/checkouts, sending messages/emails, deleting user data, overwriting important documents, installing or elevating software, changing security settings, accessing private credentials, external upload of sensitive content. Make confirmations single-use, tied to exact action, short-lived and revocable; silence or “no” cannot approve. Keep a panic-stop and mute control accessible from tray/hotkey.

Any auto-approval policies must be specific, bounded and opted into, never globally bypassed to make demos faster. Document prompt-injection defenses for webpages, documents and command output; external content is evidence/data, not permission to change instructions.

## 11. Computer-use engineering rules

- **File Explorer:** Prefer direct known-folder APIs and navigation of existing explorer windows; select by accessibility automation IDs, not visual position; avoid opening multiple windows for navigation.
- **Multiple monitors:** Enumerate displays/DPI/window bounds and translate coordinate systems; identify target window by handle and process.
- **Shell:** Execute commands with timeouts, stdout/stderr capture, meaningful exit checking, safe process tree cancellation; never use unsupervised elevation.
- **Word/Excel/PowerPoint:** For creating/editing file content prefer file-format libraries or official automation interfaces. GUI only when a task requires visible application interaction; verify output artifacts.
- **Browser:** Use Playwright browser contexts/profiles respecting site policies; avoid credential scraping and do not finalize orders automatically.
- **Fallback:** UIA element → application API → controlled browser interface → bounded screenshot/coordinates. On uncertainty, stop or ask; avoid random clicking.
- **Verification:** Explicit postconditions for every supported workflow. “Tool returned OK” is not enough.

## 12. Delivery plan and dependencies

**Target: 8 weeks to a scoped internal MVP; 10–14+ weeks for a more stable beta.** This depends heavily on hiring, SDK/login compatibility, existing tool quality, and supported apps; do not promise calendar delivery before discovery.

| Phase | Timing | Primary owners | Exit evidence |
|---|---|---|---|
| P0 — Discovery/contracts | Week 1 | E01/E02/E08 with all | Upstream pins, login proof, architecture, risk register, interface schemas |
| P1 — Tray + wake prototype | Weeks 1–2 | E06/E05/E10 | Auto-start, true local Dottie detection, selectable mic, mute |
| P2 — Codex task slice | Weeks 2–3 | E02/E03/E06 | Official ChatGPT login, restart/reuse, streamed task, cancel |
| P3 — Computer tools | Weeks 2–5 | E04/E11/E08 | Known-folder navigation, app launch, shell, browser, document smoke tests |
| P4 — Voice-to-action integration | Weeks 4–6 | E01/E03/E05/E07 | Wake → command → Codex → tool → verified feedback |
| P5 — Hardening & release | Weeks 6–8 | E07/E09/E08/E06 | Installer, soak tests, QA evidence, reproducible release candidate |

**Critical path:** auth viability + runtime contract → audio-to-command contract → verified action tool → integrated task lifecycle → Windows packaged startup. Integration occurs from Week 2, not at the end.

**Definition of first integrated demo (no later than P4 target):** Fresh sign-in → “Dottie, open File Explorer and go to Downloads” → permitted task runs through Codex adapter and desktop tool → system verifies Explorer displays Downloads → short spoken response → return to standby. This is a target, not a completion claim.

## 13. Windows installer, start-at-login and lifecycle

1. Choose packaging technology (electron-builder/electron-forge or equivalent) after evaluating current Windows support. Build an MSIX or installer appropriate to user-level install; document tradeoffs. Code-sign production builds.
2. First-run wizard: privacy disclosure → microphone permission/device test → official Codex ChatGPT sign-in → user-selected folders/capabilities → wake-word test → optional auto-start toggle.
3. Configure startup **at user sign-in**, not a privileged always-running Windows service in Session 0. Registered startup entry or Windows-supported auto-launch is acceptable; user can disable from app and Windows settings.
4. Keep one tray instance; display `Standby`, `Listening`, `Executing`, `Auth required`, `Muted`, `Offline` states. Menu: Wake test, Mute/Unmute, Pause, Settings, Show activity, Reconnect, Stop task, Quit.
5. Supervisor restarts only crashed child workers with exponential backoff; don't spin or repeatedly wake devices. Respect user Quit (no automatic resurrection until next configured sign-in).
6. Integrate update checker only with release signing and rollback plan; do not install silent updates that change permissions or policy.
7. Validate locked-screen transitions, sleep/resume, laptop lid state, microphone disconnect, Windows update restart, multiple monitors, and offline starts; state actual limitations.
8. Deliver reproducible installer, package checksum, SBOM/license notices, user guide, uninstaller and crash recovery instructions.

**Never embed a ChatGPT account login/password in the installer.** Every user authenticates their own account through official flows. Sessions should stay within official Codex-managed storage where possible.

## 14. Quality, measurements and release gates

E07 owns test plans and release evidence; E09 owns measurement methodology; E01 signs technical release; Product Owner accepts experience.

**Proposed initial benchmarks, to be calibrated on named test hardware:**
- Wake activation: >=95% of 100+ controlled positive utterances across selected microphones/noise conditions.
- False wakes: <=1 per 24 hours in a representative idle test (longer evaluations required for confidence).
- Wake-to-listening p95: <=500 ms, measured from detected wake event (not from first acoustic phoneme).
- Speech interruption-to-playback-stop p95: <=300 ms.
- Supported task suite: >=95% *verified* completion across repeated, specified Windows workflows; no blanket claim across arbitrary sites/apps.
- Background operation: 7-day soak without unhandled crash, runaway restart or significant resource leak; report RAM/CPU/battery measurements.
- Stop/cancel: verified task-state cleanup without falsely reporting “cancelled” when an external action already occurred.
- High-risk action confirmation: 100% enforcement in negative/approval test cases.

Test matrix: Windows 11 versions, headset/laptop mics, noisy rooms, one/three displays, high-DPI scaling, lock/unlock, no internet, auth expiry, browser login, inaccessible control, process crash, task interruption, permission denial, inaccessible documents, corrupt PDFs, app startup after reboot. Use mock interfaces for deterministic unit tests and real Windows end-to-end tests for acceptance.

**Release blocker examples:** auth session leakage, unintended payment or deletion, incorrect-window action, commands running after cancellation without reporting, unattended privileged actions, wake listening despite mute, background recordings uploaded without disclosure, startup crash loop, silent errors misrepresented as success.

## 15. Project reporting and artifacts

Every Friday E01 submits:
- Feature/milestone status: green / yellow / red with proof.
- Merged PRs and active blockers.
- Latest installer hash and build number.
- Verified end-to-end scenarios and failed scenarios.
- Wake latency, false triggers, task success, crash and resource metrics.
- Security changes and unresolved risks.
- Next week's critical path and staffing needs.

Required final handoff: complete source code, build instructions, environment/dependency lock, architecture/ADR records, official upstream pin, license review, task/tool contracts, test scripts, evidence reports, troubleshooting guide, installer/uninstaller, rollback plan, known limitations, and a live demonstration recorded with user consent.

## 16. Lead Engineer's first 10 actions

1. Audit existing Dottie/Groot/desktop-tool code and assets before creating new modules; preserve working code and records.
2. Verify latest supported official Codex runtime/SDK or App Server and commit to one integration strategy.
3. Produce the authenticated *ChatGPT login → Codex task → restart/resume* proof on Windows; block unsupported assumptions.
4. Review source licenses, voice-service costs and distribution terms; inventory credentials without copying secrets.
5. Assign E01–E11 owners and define ticket-level acceptance contracts.
6. Freeze shared event schemas, approval boundary, storage model and cancellation semantics.
7. Scaffold protected mono-repo, CI, signed build strategy and app-level diagnostics.
8. Build a real tray + local “Dottie” wake detector and a separately working Codex text-task adapter.
9. Connect one safe, verifiable Windows action and demonstrate the full vertical slice.
10. Gate expansion on end-to-end evidence, then progressively add Office, browser, shell and robust fallback behavior.

## 17. Final acceptance definition

A Windows 11 user can install Dottie, authenticate using supported Codex ChatGPT sign-in, enable start-at-sign-in, reboot/sign in, and use **“Dottie”** to start voice interaction without opening a terminal. An authorized request flows through Codex to a supported tool, the action is verified, the response is spoken, and Dottie returns to standby. The user can stop/mute/quit, revoke tool permissions, recover from ordinary failures, and see truthful task history. Destructive or external commitments require explicit confirmation. The implementation is reproducible, tested and documented.

**Product principle:** Fast, trustworthy, local-first and measurable. Do not advertise universal or 100% success; explicitly name what is supported and what remains experimental.
