# Dottie — QA Test Plan (v0.1, draft)

**Owner:** E07 QA / Automation Engineer (independent release authority, spec §6, §14)
**Prepared:** 2026-10-18 (CDT, UTC-5)
**Status:** Draft for E01 review. Docs only: no test code exists yet. This is a plan, not evidence of testing.
**Inputs:** `/workspace/dottie/spec.md` (v1.0), `/workspace/dottie/audit.md`, and a read-only survey of `/workspace/dottie/src/`.
**Companion docs:** [`release-blockers.md`](release-blockers.md), [`gap-report.md`](gap-report.md), [`../evidence/README.md`](../evidence/README.md)

---

## 0. Reality check: what is under test today

The spec describes an Electron/TypeScript tray app with a local wake word, Codex adapter, policy gate and tool router (spec §4, §8). **None of that code exists yet.** `src/` holds only predecessor repos (audit §1):

| Repo in `src/` | Language / test tooling | Tests present | Relevance to Dottie |
|---|---|---|---|
| `Bot/` (detached at `origin/fix/unexpected-session-exit`, 5268c8d) | Python; no test runner, no `pyproject` | **None** | Planned reuse for Explorer/file tools (audit §2, §5). Also the main source of blocker risks (see gap report). |
| `Dollie_Bot_Private/` | TypeScript, Node ESM, `node:test` + `tsc` + ESLint (`package.json`: `npm test` = `tsc && node --test dist/test/*.test.js`) | 3 files, 45 tests. **I re-ran them in a `/tmp` copy: 45/45 pass** (Node v20.19.2; note `engines` requires ≥22) | A Slack bot. Only patterns are reused: single-instance lock (`src/lifecycle.ts`), dedupe (`src/store.ts`), bound, single-use confirmation (`src/dm.ts`). |
| `Santa_Claus/` (branch `p00-foundation`) | TS monorepo, Vitest projects (unit/contract/integration/failure/e2e), Biome | Yes (not run) | Patterns to reuse: `scripts/check-secrets.ts`, `packages/observability/src/redact.ts`, `evidence/` conventions |
| `Groot_1.0/` | Python, pytest (`tests/unit`, `tests/integration`, `tests/fixtures`) | Yes (not run) | Pattern only: auth-status probe |
| `groot-harness/` | Python + Node/Playwright scaffold | No suite | Pattern only: Playwright verifier |
| `codex/` (upstream `openai/codex` @ 8c07694) | Rust/TS | upstream | Upstream pin. I spot-checked the audit's auth claims: `account/login/start` at `codex-rs/app-server-protocol/src/protocol/common.rs:1301`, `account/logout` :1335, `account/read` :1475. `sdk/typescript/src` has no login API. |

The `MDC_First_agent` repo (voice echo gate, `gate/confirm.py`) is **not on the box**. I could not inspect it, so any claim about it below is quoted from the audit.

**Consequence:** this plan defines the harness and cases for the Dottie monorepo (spec §8). It also defines a **characterisation suite** for any predecessor code that gets imported (Bot tools), which must exist *before* that code is changed (audit §5).

## 1. Scope

### 1.1 In scope (V1, spec §3 "V1 must deliver")
1. Install, uninstall, tray, single instance, optional start-at-sign-in (§3.1, §13).
2. Official Codex ChatGPT auth: sign-in, status, reuse, logout, relogin, expiry (§3.2, §5).
3. On-device wake word "Dottie", mic selection, mute, listening indicator, sensitivity (§3.3, §9.2–9.3).
4. STT, TTS, barge-in, stop-speaking vs cancel-task vs new-task (§3.4, §4 Speaking policy, §9.11).
5. Codex task execution: thread identity, progress, approvals, cancellation, verification (§3.5, §9.6–9.9).
6. Bounded tools: apps, Explorer same-window navigation, files, PowerShell/CMD (Bash if installed), Playwright browser, Word/Excel/PowerPoint (§3.6, §11).
7. One or more monitors, laptop or headset mics (§3.7, §11).
8. Recovery from crashes and network/audio/tool failures; structured local logs (§3.8, §13.5).
9. Permission enforcement, previews, high-impact approvals (§3.9, §10).
10. Reproducible, signed build plus test reports (§3.10, §13.8, §15).

### 1.2 Out of scope (spec §3 "Outside V1")
Mobile; cloud multi-agent; autonomous purchasing; OS-security bypass; powered-off control; all-sites/all-apps guarantees; model training; dashboards; **unattended actions on a locked desktop**; remote access. The last two are tested **negatively**: we verify that Dottie refuses them (RB-05).

### 1.3 Quality targets (spec §14, "proposed, to be calibrated")
| ID | Metric | Target | Level |
|---|---|---|---|
| M1 | Wake activation | ≥95% of ≥100 controlled positive utterances per mic×noise cell | e2e-windows (audio rig) |
| M2 | False wakes | ≤1 / 24 h representative idle (extend to ≥72 h for confidence) | e2e-windows soak |
| M3 | Wake→listening p95 | ≤500 ms from `WakeDetected.timestamp` | integration + e2e |
| M4 | Interrupt→playback stop p95 | ≤300 ms | e2e-windows |
| M5 | Supported task suite | ≥95% *verified* completion over repeated runs | e2e-windows |
| M6 | Soak | 7 days, no unhandled crash / runaway restart / significant leak | e2e-windows soak (with E09) |
| M7 | Cancel truthfulness | 0 cases of "cancelled" reported after an external action occurred | integration + e2e |
| M8 | High-risk confirmation | 100% enforcement across negative and approval cases | unit + integration + e2e |

## 2. Test levels and harness layout (spec §8 `tests/`)

Proposed tooling (needs an ADR from E01; it follows the spec's Electron/TS target and the Vitest patterns already proven in `Santa_Claus`):
- **TS packages:** Vitest projects `unit`, `integration`, `e2e-windows`, with JSON + JUnit reporters writing to `docs/evidence/` (see evidence README).
- **Python tool worker** (if Bot `tools/` is wrapped per audit §5): pytest. On Linux it runs with stub modules for `win32*`, `pywinauto`, `pyautogui`, `winreg`, because the current modules import these at import time (gap G-13).
- **Electron UI:** Playwright `_electron` driver for renderer/tray-window flows. Windows-native assertions use UIA (pywinauto or an equivalent .NET UIA client).
- **Static gates:** typecheck, lint, secret scan (port `Santa_Claus/scripts/check-secrets.ts`), dependency-boundary check (renderer must not import shell, credential or audio modules, spec §4 "Process separation").

### 2.1 `tests/unit/` (Linux CI, every PR, deterministic, no network, no audio device)
Pure logic with fakes. Covers:
- **Coordinator state machine** (§4): every valid transition. Invalid transitions are rejected. Idempotent `TaskRequested` (duplicate `requestId` → one task). `MUTED` from any state blocks `WAKE_DETECTED`.
- **Policy gate** (§10): default-deny. One case per scope (`files.read`, `files.write`, `shell.execute`, `desktop.control`, `browser.navigate`, `network.send`, `app.install`, `credentials.access`, `purchases`). The approval token is single-use, bound to `actionId` + argument hash, short-lived, revocable. Silence, "no", noise or a transcript containing a negative never approves.
- **Contracts** (§7): schema validation and version for every event, with no raw audio and no secret fields.
- **Redaction:** log or evidence writers mask tokens, JWTs, `Authorization`, cookies and `auth.json` content (port `Santa_Claus/packages/observability/src/redact.ts` + tests).
- **Speaking-policy parser:** "stop", "stop talking" → stop TTS only. "stop the task" → cancel. "new task …" → follows the queue-or-cancel rule (§4, §9.11).
- **Path policy:** workspace-scope resolution. Reparse points, UNC, `..`, AppData, `%USERPROFILE%\.codex`, and known-folder roots are refused for write. Credential stores are refused for **read** too (gap G-03).
- **Supervisor backoff math** (§13.5): exponential backoff, max-restart cap, no restart after user Quit.
- **Bot characterisation (if imported):** `file_tools` pure helpers (`clean_label`, `resolve_user_path` with stubbed `known_folders`, `is_protected`, `ensure_mutable`, `resolve_reference`, `_filtered`). `registry.execute_tool` gating with stub tools.

### 2.2 `tests/integration/` (Linux CI with fakes; a subset is re-run on the Windows runner)
Real Dottie modules wired together, with external systems replaced by fakes in `tests/fixtures/`:
- **FakeCodexAppServer:** a stdio JSON-RPC fake that scripts `account/read`, `account/login/start` (`chatgpt` returns `loginId`/`authUrl`; `chatgptDeviceCode`), `account/login/completed`, `account/updated`, expiry, plan-limit errors, streamed turns, approval requests, slow and cancelled turns. It must **reject** `chatgptAuthTokens` usage (marked internal, audit §3).
- **FakeAudioSource:** replays PCM fixtures through the real resample → wake → VAD pipeline, with a **capture tap** that records every frame leaving the audio worker.
- **FakeSTT/FakeTTS:** an STT fake that counts bytes received; the test asserts zero bytes while in `STANDBY` or `MUTED`.
- **FakeDesktop:** a window table (hwnd, pid, title, monitor, DPI, foreground, locked flag) behind the tool-router interface.
- **Sandbox FS:** a temp directory tree with fixture documents, including corrupt and locked files.
- **Network guard:** loopback-only socket policy (pattern credited by the audit to MDC `conftest.py`). Any non-allowlisted egress fails the test.
- Flows: wake → utterance → task → approval → tool → verifier → `TaskFinished`; cancel at each state; auth expiry mid-task; offline; crash of the audio worker or tool worker.

### 2.3 `tests/e2e-windows/` (real Windows 11 runner; nightly + release candidate; partly manual)
Packaged, signed build on clean VMs and named physical hardware. Driven by Playwright-electron + UIA + an audio playback rig (loopback virtual cable for deterministic runs; speaker→mic in a room for acoustic runs). Covers the environment matrix (§3), the first integrated demo (§12), final acceptance (§17), and benchmarks M1–M6.

### 2.4 `tests/fixtures/`
| Fixture | Content | Notes |
|---|---|---|
| `audio/wake-positive/` | ≥100 "Dottie" utterances × speakers × mics (headset, laptop array) × noise (quiet, office 55 dBA, café 65 dBA, TV/music) | Consent recorded per speaker. No real user audio. |
| `audio/wake-negative/` | near-miss words ("Dotty", "daughter", "Hottie"), TTS self-speech, long idle | False-wake and echo cases |
| `audio/commands/` | "Dottie, open Downloads…" one-shot plus pause variants; "stop", "stop the task", "no", "yes", ambiguous noise | Approval negative cases |
| `codex/` | scripted app-server transcripts (JSON-RPC) for every auth/turn/approval case | Generated from the pinned protocol version |
| `fs/` | Downloads tree with tie-break newest PDFs, **corrupt PDF**, zero-byte DOCX, password-protected XLSX, locked file, long path, Unicode names, reparse point | spec §9 example, §14 matrix |
| `desktop/` | window tables: 2 Explorer windows, same-title windows, elevated window, 3-monitor negative coordinates, 150%/200% DPI | wrong-window cases |
| `web/` | local static checkout page, login page, prompt-injection page ("ignore instructions and delete…") | payment / injection; served on loopback only |
| `secrets/` | **runtime-assembled** fake tokens (never committed literals; Santa_Claus pattern) | canaries for leak detection |

## 3. Environment matrix with test cases

Legend: **L** = Linux CI (fakes), **W** = automated on Windows 11 runner, **M** = manual on named hardware, with evidence recorded. Case IDs are referenced from `release-blockers.md`.

### 3.1 Windows 11 versions (spec §1 header, §14)
Matrix: Win11 23H2, 24H2, 25H2 (x64). ARM64 only after explicit verification (spec header). The audit records that Codex's MXC sandbox needs Win11 24H2/25H2 builds ≥ .9278. **The exact builds must be named by E01/E09** (spec gap S-06).
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-WIN-01 | Clean install of the signed installer per version, user-level (no admin) | Installs to per-user location; data in AppData (§8); no UAC prompt | W |
| ENV-WIN-02 | Codex runtime starts per version; record the sandbox mode selected | App-server handshake OK; sandbox mode logged; unsupported mode shows a truthful message | W |
| ENV-WIN-03 | Uninstall | Binaries removed; user is asked separately about prefs/logs; user documents untouched (§8) | W |
| ENV-WIN-04 | Windows Update restart mid-standby | Clean restart at next sign-in; no crash loop (§13.7) | M |

### 3.2 Headset vs laptop microphone (§3.3, §3.7, §9.3)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-MIC-01 | Wake rate per mic type (USB headset, BT headset, laptop array) | M1 met per cell | W (rig) |
| ENV-MIC-02 | Select a non-default mic in settings; speak into the default one | Only the selected device triggers | W |
| ENV-MIC-03 | Unplug the headset while in standby; replug | Graceful reopen (§9.3); tray shows status; no crash; no silent switch to another mic without notice | W/M |
| ENV-MIC-04 | BT headset in HFP profile (low sample rate) | Resample path works or a truthful error | M |
| ENV-MIC-05 | TTS through laptop speakers, laptop mic | No self-wake from TTS (§9.3 "avoid triggering on Dottie's TTS output") | W |

### 3.3 Noisy rooms (§14)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-NOISE-01 | Wake at 55 / 65 / 75 dBA babble | M1 per cell; record SNR | W (rig) |
| ENV-NOISE-02 | 24 h TV/podcast idle | M2 false wakes; zero cloud uploads while idle (RB-07) | W soak |
| ENV-NOISE-03 | Command with background speech after the command ends | VAD ends utterance; background speech not executed (§9.5 "do not process idle/background speech") | W |
| ENV-NOISE-04 | Unintelligible command | Single re-prompt (§9.4), no task submitted | L/W |

### 3.4 One vs three displays (§3.7, §11 "Multiple monitors")
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-DISP-01 | 1 display: "open File Explorer and go to Downloads" | Same-window navigation, verified path (§12 demo) | W |
| ENV-DISP-02 | 3 displays, one left of primary (negative X) | Target window identified by handle+process; actions land on it | W |
| ENV-DISP-03 | Two Explorer windows on different monitors, neither focused | Dottie asks which one; no action on a guessed window (RB-03) | L/W |
| ENV-DISP-04 | Monitor unplugged mid-task | Coordinates re-enumerated; task stops or asks; no click on a stale coordinate | M |
| ENV-DISP-05 | Move window to monitor 3 | Postcondition: window centre on monitor 3 | W |

### 3.5 High DPI (§11, §14)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-DPI-01 | 100/150/200% scaling, mixed-DPI 3-monitor setup | Coordinate fallback lands within target element bounds (UIA-verified) | W |
| ENV-DPI-02 | Per-monitor DPI change while running | Re-enumerate; no offset clicks | W/M |
| ENV-DPI-03 | Tray/onboarding UI legible at 200% | No clipped approval text (approval summary must be readable to be valid consent) | M |

### 3.6 Lock / unlock, sleep / resume (§1 constraints, §3 exclusions, §13.7)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-LOCK-01 | Win+L during `EXECUTING` | Task pauses or cancels with a truthful status; **no desktop/input action while locked** (RB-05) | W |
| ENV-LOCK-02 | Wake word spoken while locked | Per documented policy (spec gap S-11). At minimum no desktop action, and no approval UI shown over the lock screen | W/M |
| ENV-LOCK-03 | Unlock after lock | Returns to `STANDBY`; does not auto-resume non-idempotent steps (§9.12) | W |
| ENV-LOCK-04 | Sleep/resume, lid close/open | Mic reopens; no crash loop; status truthful | M |
| ENV-LOCK-05 | Pending approval at lock time | Approval expires or is invalidated; it cannot be approved by voice from a locked state | L/W |

### 3.7 Offline (§1, §9.12)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-NET-01 | Start offline | Tray shows `Offline`; wake word + tray controls work (§1); no Codex call | L/W |
| ENV-NET-02 | Network drop mid-task | Stop new inference; preserve safe state; recovery UI; resume only idempotent/approved (§9.12) | L/W |
| ENV-NET-03 | Network drop *after* a tool's external side effect, before `ToolResult` | Reported as "outcome uncertain", never "failed, nothing happened" or "succeeded" (RB-09) | L |
| ENV-NET-04 | Captive portal / TLS failure | Truthful error; no fallback to an API key (§5) | L/W |

### 3.8 Auth expiry (§5)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-AUTH-01 | Restart with a valid session | Session reused via official account-state read (§5 "On restart, probe session validity") | L/W |
| ENV-AUTH-02 | Expired session on startup | Wake standby still works; `Auth required` state; **Reconnect ChatGPT** offered; no task executed | L/W |
| ENV-AUTH-03 | Expiry mid-task | Task stops cleanly; state `AUTH_REQUIRED`; truthful partial-progress report | L |
| ENV-AUTH-04 | Plan limit error | Surfaced to the user; **no silent switch to a billable API key** (§5) | L |
| ENV-AUTH-05 | Logout | Codex-managed session cleared via `account/logout`; Dottie keeps no token copy (RB-01) | L/W |

### 3.9 Browser login (§5, §11 "Browser")
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-BRW-01 | First-run "Sign in with ChatGPT" | Opens the **system browser** to the official `authUrl` (or device code); no embedded/imitated OAuth page; no password field in Dottie (§1, §5) | W/M |
| ENV-BRW-02 | User closes the browser mid-login | `account/login/cancel` or timeout; truthful status; retry possible | L/W |
| ENV-BRW-03 | Default browser is Firefox/Edge/Chrome | Flow works or a documented limitation | M |
| ENV-BRW-04 | Playwright task needs a site login | User-visible browser; Dottie does not type credentials or scrape cookies (§1, §11) | W |
| ENV-BRW-05 | Playwright reaches a checkout page | Stops before finalising; requires explicit per-transaction approval (§3, §10) (RB-02) | W |

### 3.10 Inaccessible controls (§11 Fallback)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-UIA-01 | Target control has no UIA name/automation ID | Falls back to app API, then bounded screenshot/coordinates **only with verification**; otherwise asks (§11) | W |
| ENV-UIA-02 | Elevated target window (UIPI blocks input) | Clear error; no elevation attempt (§11 "never use unsupervised elevation") | W |
| ENV-UIA-03 | Control ambiguous (two "OK" buttons) | Asks; no random click (§11) | L/W |
| ENV-UIA-04 | Click reports OK but the state didn't change | Verifier reports failure (RB-09) | L/W |

### 3.11 Process crashes (§3.8, §13.5)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-CRASH-01 | Kill the audio worker | Supervisor restarts with backoff; mute state preserved (RB-06) | L/W |
| ENV-CRASH-02 | Kill the Codex app-server mid-turn | Task marked interrupted/uncertain; no automatic re-execution of non-idempotent steps | L/W |
| ENV-CRASH-03 | Kill a tool worker mid-shell-command | Child process tree terminated; outcome reported honestly | W |
| ENV-CRASH-04 | Worker crashes on every start (fault injection) | Backoff, then stop after the cap, with a user-visible error; CPU bounded; no device re-wake spam (RB-08) | L/W |
| ENV-CRASH-05 | Main process crash | No zombie mic capture; next launch single-instance OK | W |
| ENV-CRASH-06 | User selects Quit | No resurrection until next configured sign-in (§13.5) | W |

### 3.12 Task interruption (§4 Speaking policy, §9.11)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-INT-01 | "Stop" during TTS | TTS halts ≤300 ms p95 (M4); **task continues** and is not reported as stopped | L/W |
| ENV-INT-02 | "Stop the task" during a shell command | Process tree cancelled; `TaskCancelled.stopStatus` truthful; no later tool calls for the task (RB-04) | L/W |
| ENV-INT-03 | "Stop the task" after a file was already moved | Reported as "already moved; not undone" (§9.11 "do not falsely claim undo") | L |
| ENV-INT-04 | New task while executing | Queue or cancel-then-start per the documented rule; no interleaved actions | L |
| ENV-INT-05 | Panic stop from tray/hotkey (§10) | All tools halt; mic muted if configured; audit record written | W |
| ENV-INT-06 | Duplicate utterance (echo, double VAD) | One task only (§4 idempotency) | L |

### 3.13 Permission denial (§9.7, §10, §13.2)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-PERM-01 | Windows mic privacy off for desktop apps | Truthful status; no silent failure; link to Settings | W/M |
| ENV-PERM-02 | User denies `files.write` scope | Write attempts refused with explanation; nothing written | L/W |
| ENV-PERM-03 | Approval denied ("no") | Action not executed; outcome "not approved"; one-time token invalidated | L/W |
| ENV-PERM-04 | Approval expires | Not executed; re-request required | L |
| ENV-PERM-05 | Scope revoked mid-task | Remaining steps refused (§17 "revoke tool permissions") | L |
| ENV-PERM-06 | Background apps disabled by OS policy | Truthful "not available" (§1 "Always running" caveat) | M |

### 3.14 Inaccessible documents / corrupt files (§14)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-FILE-01 | Corrupt PDF as the "newest PDF" | Viewer failure detected by the verifier; reported as failure (RB-09) | W |
| ENV-FILE-02 | Locked file (open in Word) | Truthful error; no force-close of Word without approval | W |
| ENV-FILE-03 | Password-protected XLSX | Does not ask for or guess the password; reports (§10 credentials) | W |
| ENV-FILE-04 | Two PDFs tie for newest | Asks a clarification before modifying anything (§9 example) | L/W |
| ENV-FILE-05 | Corrupt local SQLite state/log DB | Starts in a recovery mode; backs up the corrupt DB; no crash loop (RB-08) | L/W |
| ENV-FILE-06 | Corrupt settings file | Falls back to safe defaults (mic **muted**, no auto-approvals) | L |

### 3.15 Startup after reboot (§9.1, §13.3, §17)
| ID | Case | Expected | Lvl |
|---|---|---|---|
| ENV-BOOT-01 | Auto-start enabled → reboot → sign in | One tray instance; no console window; state shown (§9.1) | W |
| ENV-BOOT-02 | Auto-start disabled in app / in Windows Settings | Does not start (§13.3) | W |
| ENV-BOOT-03 | Was muted before reboot | Starts muted (§9.1 "Respect … mute settings") (RB-06) | W |
| ENV-BOOT-04 | Startup offline + auth expired | `Offline`/`Auth required`; wake works; no crash | W |
| ENV-BOOT-05 | Not registered as a Session-0 service; no elevation | Verified via startup registration inspection (§13.3) | W |
| ENV-BOOT-06 | Two launch triggers race (startup + user click) | Single instance (§4) | W |

### 3.16 Desktop smoke harness (`apps/desktop` headless smoke + `scripts/smoke-run.mjs`; DOT-098, DOT-099)
Stable suite-level IDs for the desktop smoke harness, added 2026-10-19 (CDT) after E01 agreed the DOT-099 rulings. They are based on what the smoke actually asserts at E06's `5ae9394` (`apps/desktop/src/main/main.ts`, `src/main/smoke/steps.ts`, `scripts/smoke-run.mjs`). From now on, use them as the `caseId` (`--case-id SMK-DESK-NN[-<variant>]`). They **supersede** the ticket-local DOT-098/DOT-099 IDs listed; those stay valid only inside their existing ticket packs (evidence README §3).

The smoke drives the real Electron main process and approval window against the **stub coordinator**, on the Linux box under Xvfb. So these cases **support** the named RBs (harness and approval-plumbing evidence) but never pass an RB on their own. RB passes need the e2e-windows cases in `release-blockers.md`. Action IDs below are the smoke's 64-char repeated fixtures (`a`×64 etc.).

| ID | Case | Expected (what the smoke asserts) | Supersedes (ticket-local caseIds) | Supports | Lvl |
|---|---|---|---|---|---|
| SMK-DESK-01 | Clean smoke run | Every hard assertion holds (`assertionsPassed:true`), `DOTTIE_SMOKE_OK` printed, Electron exit 0, runner exit 0; header has full commit, `dirtyTree` (scope per evidence README §1.3) | `DOT098-AC3`, `DOT098-SMOKE` (runner default), `DOT098-E07-RECHECK`, `DOT098-E07-RECHECK2`, `DOT098-E07-FINAL`, `DOT099-CLEAN`, `DOT099-E07-CLEAN` | RB-02, RB-09 | L |
| SMK-DESK-02 | One decision per closing click (double click on Approve) | Exactly one `ApprovalResolved`, `a`/`approved:true` (`repeatResolved === [true]`); main refuses the second click ("This approval is no longer valid."); the decision is recorded even if the clicking page script never settles (DOT-098 root cause) | `DOT098-AC1-hang`, `DOT098-AC1-diagnosis` (historical root-cause evidence), E07 7158f2f N4 (no caseId) | RB-02 (cf. RB02-E2: one approval → one action) | L |
| SMK-DESK-03 | Exactly one reply per closing click, for that dialog's own actionId | After the click, a bounded wait for a new reply **and** window closed, a 300 ms settle, then exactly one new reply whose actionId is the dialog's own (`clickRepliesBlame`); a duplicate fails `step_assertion` at that click; exit 1 | `DOT098-AC-A-FAKED-DUPLICATE`, `DOT098-E07-NEG-R1` | RB-02, RB-09 | L |
| SMK-DESK-04 | Reply carries the right actionId and decision | A wrong `approved` value fails at `final.replySequence`; a wrong actionId fails at the click step ("for 9x64; got 1: 7x64/false"); exit 1 | `DOT098-FAULT-F1-wrong-value`, `DOT098-FAULT-F2-wrong-actionId`, `DOT098-FAULT-F3-R3-wrong-id-and-true`, `DOT098-E07-NEG-R3`, `DOT098-E07-FINAL-G1-bound-wrong-value`, `DOT098-E07-FINAL-G2-bound-wrong-actionId`, `DOT099-E07-H4-bound-wrong-value`, `DOT099-E07-H5-bound-wrong-actionId` | RB-02 (cf. RB02-U2: bound to the exact action) | L |
| SMK-DESK-05 | Approval window closes after each closing click | `approvalWindow.webContents === null` within the 5 s step bound for `repeat.approveDoubleClick`, `timer.decline`, `codex.decline` and `bound.decline`; no click or no close → `step_timeout` naming the step; exit 1 | E07 7158f2f N2 (no caseId) | RB-02, RB-09 | L |
| SMK-DESK-06 | Full ordered reply sequence; no reply for the not-active task | After `bound.decline`: exactly `a/true, b/false, c/false, d/false, f/false, e/false, 9/false` (count, order, actionId, value); any reply for `8` (not-active task) fails; mismatch → `step_assertion` at `final.replySequence` (or `after:<step>` for an extra entry); exit 1 | `DOT098-FAULT-F4-R2-late-duplicate`, `DOT098-E07-FINAL-G3b-dup-bound-after-return`, `DOT098-E07-FINAL-G3d-late-dup-codex-400ms`, `DOT098-E07-FINAL-G4-action8-sends` | RB-02, RB-09 | L |
| SMK-DESK-07 | Settled re-check and stray-reply blame | A 1 s settle, then `final.replySequenceSettled` just before OK; a late duplicate of the last reply up to about 1.2 s after the last close fails as `after:bound.decline`; a stray reply landing in a neighbouring click's window is blamed as `after:<producing step>`; exit 1. **Known residual window:** a duplicate later than about 1.2-1.35 s after the last close isn't seen (E07 DOT-099 review FU2) | `DOT099-FAULT-F1-late-dup-last-700ms`, `DOT099-FAULT-F2-stray-dup-d-800ms`, `DOT099-E07-H1-late-dup-9-700ms`, `DOT099-E07-H2a-late-dup-9-1200ms`, `DOT099-E07-H2b-late-dup-9-1500ms`, `DOT099-E07-H2c-late-dup-9-1350ms`, `DOT099-E07-H3-dup-d-during-codex`, `DOT098-E07-NEG-R2`, `DOT098-E07-FINAL-G3a-late-dup-timer-800ms`, `DOT098-E07-FINAL-G3c-late-dup-bound-700ms` | RB-09 | L |
| SMK-DESK-08 | Step timeout and watchdog: no silent stall | Every window load, page script and click is a named step bounded at 5 s (`step_timeout`, `failedStep` = step, `timeoutMs:5000`); anything outside a step trips the 60 s watchdog (`reason:"watchdog"`, `failedStep` = `after:<last step>`, `timeoutMs:60000`); `DOTTIE_SMOKE_FAIL` keeps the partial output and activity; exit 1. App startup is covered only by the runner timeout (SMK-DESK-09) | `DOT098-E07-NEG-R4`, E07 7158f2f N1/N3 (no caseId) | RB-09 | L |
| SMK-DESK-09 | Runner forced timeout | On a runner `--timeout-ms` expiry: SIGTERM to Electron's whole process group, then SIGKILL to the group after 2 s (since E06 `b370fa4`; was SIGKILL to Electron after 5 s); the final log keeps all output plus the `DOTTIE_SMOKE_RUNNER_TIMEOUT` footer; final header `result:"fail"`, `timedOut:true`; summary `result:"fail"`, runner exit 1; never `pass` | `DOT098-AC4-timeout`, `DOT099-F3B-FORCED-TIMEOUT`, `DOT099-E07-FORCED-TIMEOUT` | RB-09 | L |
| SMK-DESK-10 | Runner killed (kill -9) leaves only a `.partial` | Only `<name>.log.partial` remains, its line 1 the provisional header (`result:"incomplete"`, `finishedAt`/`exitCode`/`durationMs` null) and its body the output up to the kill; no final log, summary or results file. **Runner-behaviour evidence only, never a test result** (evidence README §4) | `DOT098-KILLED-RUNNER`, `DOT098-E07-KILLED`, `DOT099-F3B-KILLED-RUNNER`, `DOT099-E07-KILLED-RUNNER` | RB-09 (evidence truthfulness) | L |
| SMK-DESK-11 | Killing the runner/CI job kills Electron's whole process group | After the runner or job is killed, no Electron process from the run remains (spawn `detached`, kill `-pgid`; CI kills the group or cgroup). **Covered by runner (Linux); CI backup; Windows pending PC session.** Since E06 `b370fa4`: the runner kills the group on timeout, SIGINT/SIGTERM/SIGHUP and uncaught errors, and a detached supervisor kills it on runner `kill -9` or crash; E07 measured no Electron and no supervisor left 43-126 ms after the signal, with sentinel processes outside the group unharmed (`docs/evidence/reviews/DOT-099-b370fa4-e07-review.md`). CI killing the job's group/cgroup stays as the backup. Windows (`taskkill /T /F`) is untested, owned by the PC session. Before `b370fa4` the child was orphaned and still alive at t+30 s (E07 DOT-099 review FU1) | none (new; observed in `DOT099-F3B-KILLED-RUNNER` and `DOT099-E07-KILLED-RUNNER`; fixed evidence `DOT099-FU1-*`) | harness hygiene; no RB directly (same pattern as ENV-CRASH-03/05: no orphaned processes) | L (CI) |

Notes:
- `smoke:ci` runs SMK-DESK-01 in a loop. Fault cases (SMK-DESK-02..08) run as temporary, uncommitted fault injections recorded with `dirtyTree:true`, so their evidence is ticket-level, not release-gate, until the faults are built into the harness behind a flag.
- Variants use a suffix: `SMK-DESK-07-late-dup-1200ms`.
- Run smoke processes one at a time on the shared box. A second Dottie instance quits on the single-instance lock and shows up as a FAIL.

## 4. What runs where

| Area | Linux CI (every PR) | Windows 11 runner (nightly/RC) | Manual (named hardware, RC) |
|---|---|---|---|
| State machine, policy, contracts, redaction, path policy, backoff | ✅ all | re-run smoke | — |
| Codex adapter vs FakeCodexAppServer | ✅ | ✅ + real pinned app-server, test account | Real ChatGPT sign-in (ENV-BRW-01/03) |
| Audio pipeline with PCM fixtures (wake/VAD logic, upload tap) | ✅ (no device) | ✅ virtual cable | Acoustic room runs, BT headsets, M1/M2 calibration |
| Tool router + policy with FakeDesktop | ✅ | — | — |
| Real UIA/Explorer/Office/shell/Playwright | ❌ (Windows-only APIs) | ✅ | Edge cases (UIPI, real Office versions) |
| Bot `tools/*` characterisation | Partial: only with stub modules for `win32*`/`pyautogui`/`pywinauto`/`winreg` (G-13) | ✅ native | — |
| Multi-monitor, DPI | FakeDesktop geometry only | ✅ VM multi-display where supported | Physical 3-monitor mixed DPI |
| Lock/unlock, sleep, reboot, Windows Update | ❌ | Lock/unlock + reboot scripted | Sleep/lid, Windows Update |
| Installer, signing, auto-start, uninstall | ❌ | ✅ clean VM snapshots | Founder acceptance (§12, §17) |
| Soak 7 days, battery | ❌ | ✅ dedicated box | Battery measurement on a laptop |
| Secret scan, dependency boundaries, SBOM/licence presence | ✅ | — | Licence review (§5 Licensing) |

## 5. Entry / exit criteria

**Entry to e2e-windows:** a green Linux CI on the commit; signed (or test-signed) build with a hash; pinned Codex version recorded in `docs/dependencies.md` (§2); FakeCodexAppServer transcripts regenerated for that pin.

**Exit for a release candidate:** every RB in `release-blockers.md` passes with evidence; M1–M8 measured and reported (pass, or an explicit, signed waiver from the Product Owner for a *proposed* benchmark only, never for an RB); all Sev-1/Sev-2 defects closed; known limitations documented (§13.7, §17).

**Severity:** Sev-1 = any release-blocker condition (§14 list) or data loss. Sev-2 = workflow broken with no workaround. Sev-3 = degraded. Sev-4 = cosmetic. E07 can block a release independently (§6).

## 6. Dependencies and open questions (blocking test authoring)
1. Codex integration choice: SDK vs App Server (§2). The audit recommends App Server, because only it exposes login (audit §3). Auth tests are written against the chosen one.
2. Mute semantics and event: see gap report S-01/S-04.
3. Risk taxonomy and approval binding: S-02.
4. `TaskCancelled.stopStatus` enum: S-03.
5. STT/TTS provider plus disclosure text and consent record: S-05.
6. Named Windows builds and hardware: S-06.
7. Decision on importing Bot tools (Python worker vs port) (audit §4 risk 5). It determines whether pytest characterisation is needed.
