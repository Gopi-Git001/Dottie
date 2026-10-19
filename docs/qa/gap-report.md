# Dottie — QA Gap Report against Release Blockers

**Owner:** E07. **Prepared:** 2026-10-18 (CDT). **Method:** read-only review of `spec.md`, `audit.md`, and the source under `src/`. I re-ran `Dollie_Bot_Private` tests in a `/tmp` copy (45/45 pass, Node v20.19.2). I tried importing the Bot modules on Linux (Python 3.13.5) and they fail (see G-13). No source was modified.
**Scope note:** No Dottie code exists yet (audit §1: "No repo contains a wake word …, Electron, a tray app, a Codex SDK or app-server integration"). The src findings below therefore apply to **predecessor code the audit recommends importing** (Bot `tools/desktop_tools.py`, `tools/file_tools.py`, audit §2/§5) and to its voice loop, which must not be carried forward. `MDC_First_agent` is not on the box, so nothing here verifies the audit's claims about it.
File references are relative to `/workspace/dottie/src/`. Bot = `Bot/` at detached `origin/fix/unexpected-session-exit` (5268c8d).

Severity: **Critical** = would directly cause a release-blocker event if imported as-is. **High** = likely RB event or makes an RB unverifiable. **Medium** = weakens detection/recovery. **Low** = hygiene.

## 1. Source-code gaps (ranked)

### G-01 · Critical · RB-02, RB-05 — Voice approval fails open
- `Bot/voice_assistant.py:539-547`: on **any** `input_audio_buffer.speech_stopped` while an approval is pending, `pending_approval["confirmed"] = True`. "No", a cough or background speech all count as approval.
- `Bot/voice_assistant.py:360-367`: the next call with the same name+args then gets `approval_callback = lambda _name, _arguments: True`.
- Gated tools are only `delete_file` (`Bot/tools/file_tools.py:19-21`) and `terminate_application` (`Bot/tools/desktop_tools.py:44-46`).
- Also confirmed in the audit (§4 risk 3). Violates spec §10 ("silence or 'no' cannot approve") and §9.7 (voice identity alone insufficient).
- **Test that exposes it:** RB02-I2. **Fix owner:** E03/E08. Do not import this approval flow.

### G-02 · Critical · RB-06, RB-07 — Always-on mic streamed to the cloud; no wake word, no mute
- `Bot/voice_assistant.py:407-418` (`input_callback`) enqueues every 100 ms block. `:438-452` (`mic_sender`) base64-sends every block as `input_audio_buffer.append` over the Realtime websocket (`:183-192`), with cloud transcription `gpt-4o-mini-transcribe` (`:207-210`).
- The only send gates are `stop`/`ending` (`:440-448`). There is no mute, pause or wake state anywhere in Bot (grep for `mute`, `lock`, `cancel`: one prompt-text hit at `:50` only).
- The only disclosure is a console print (`:490` "Listening continuously").
- Violates spec §4 ("standby (no standby audio uploaded)"), §9.2, §9.5. Matches audit §4 risk 4. **The voice loop is unusable for Dottie. Build new (audit §2).**

### G-03 · Critical · RB-01, RB-07 — Unscoped file reads and clipboard read sent to the model (credential exposure path)
- `Bot/tools/file_tools.py:275-283`: `resolve_user_path` accepts any absolute or UNC path.
- `read_file` (`:537-545`) and `get_file_info` (`:409-423`) return text previews (`text_preview`, `:338-354`, up to 4000 chars) for `TEXT_EXTENSIONS` including `.json .ini .cfg .yaml .yml .toml .log` (`:46-49`). The read path has **no deny-list**: `SKIP_DIR_NAMES` (incl. `appdata`, `:31-44`) is only applied to search pruning (`:873-886`), and `is_protected`/`ensure_mutable` (`:174-211`) guard writes only.
- ⇒ A model-issued `read_file("C:\\Users\\<u>\\.codex\\auth.json")` would return Codex session material to the Realtime model. That is my inference from the code paths. I did not execute it, because the code is Windows-only.
- `Bot/tools/desktop_tools.py:1686-1689`: `read_clipboard` is ungated and returns up to 10,000 chars. Prompt rule 9 (`voice_assistant.py`, "Do not read clipboard contents unless needed") is the only control.
- The audit did not list this. Violates spec §5 ("Never read or copy Codex credentials"), §10 (`credentials.access` generally forbidden; external upload of sensitive content needs confirmation).

### G-04 · High · RB-05 — `open_file` executes arbitrary files without approval
- `Bot/tools/file_tools.py:485-494`: `os.startfile(target)` on any existing path. There is no extension allowlist, so `.exe/.bat/.cmd/.ps1/.vbs/.msi/.lnk` would launch.
- Not in `APPROVAL_REQUIRED` (`:19-21`). This bypasses the `ALLOWED_APPS` allowlist in `launch_application` (`Bot/tools/desktop_tools.py:49-54`, `:1475-1483`).
- Violates spec §10 (`shell.execute`, `app.install` scopes) and §11 ("never use unsupervised elevation"; an `.msi`/elevating `.exe` would raise UAC with the user possibly absent).

### G-05 · High · RB-02 — Destructive file operations outside the approval gate
- `move_file` with `overwrite=true` deletes the destination (`dest.unlink()`) and then moves (`Bot/tools/file_tools.py:602-625`, esp. `:617-619`).
- `write_file overwrite=true` replaces content (`:547-564`). `copy_file overwrite=true` replaces (`:584-600`). `rename_file` (`:566-582`) is ungated.
- The `overwrite` flag is chosen by the model. "Only after the user agrees" exists only as prompt text (`voice_assistant.py:69-72`).
- `close_window` (`Bot/tools/desktop_tools.py:1416-1459`) and keyboard input (`hotkey`/`press_key`, `:1363-1382`, e.g. `delete`, `ctrl+s`, `alt+f4`) can destroy unsaved work or delete via Explorer without any gate.
- Spec §10 lists "overwriting important documents" and "deleting user data" as always-confirm.

### G-06 · High · RB-03 — Input is not bound to a target window; fuzzy window matching; no DPI awareness
- `type_text` (`Bot/tools/desktop_tools.py:1341-1361`, pastes via Ctrl+V), `press_key`/`hotkey` (`:1363-1382`) and `click_mouse`/`drag_mouse` (`:1294-1328`) act on **whatever has focus or is at the coordinates**. There is no hwnd parameter and no foreground re-check.
- `focus_window` (`:1393-1400`) returns success without confirming the window became foreground, so a separate later `type_text` call races any focus change.
- `find_window` (`:101-120`) and `close_window` (`:1434-1445`) accept a unique **substring** title match. `inspect_window`/`click_control` also use substring (`:1607-1615`, `:1643-1648`).
- `ExplorerController._target` falls back to the current foreground Explorer, or to the only Explorer window (`:300-324`).
- No DPI-awareness call exists anywhere in Bot (grep for `dpi`/`SetProcessDpi`: no hits). Monitors are numbered two different ways: `monitor_layout` uses ids from 1 via `EnumDisplayMonitors` (`:68-85`), while `get_screen_info`/`capture_screen` use the `mss` index, where 0 is the virtual "all monitors" (`:1233-1278`). That invites wrong-monitor targeting.
- Positive pattern to keep: `close_window` refuses exact-title duplicates (`:1424-1430`), and Explorer navigation verifies by hwnd (`:416-437`).

### G-07 · High · RB-04 — No task cancellation exists; tools run synchronously in the event loop
- Tool calls run inline in the websocket receive loop (`Bot/voice_assistant.py:501-567`, dispatch at `:563-567` → `execute_tool`). While a tool runs (e.g. Explorer polling up to 6 s, `desktop_tools.py:416-418`), no "stop the task" event can even be read.
- Barge-in only flushes local playback (`:526-538`). The server-side `interrupt_response: True` (`:220`) cancels speech, not executed tools.
- "Stop the task" exists only as prompt text (`:50`). There is no cancel token, no `TaskCancelled`, and no process-tree cancellation (spec §9.11, §11 "safe process tree cancellation").
- **RB-04 cannot be tested against this code at all.**

### G-08 · High · RB-09 — Many tools report `success: true` with no postcondition
- No verification: `type_text` (`desktop_tools.py:1361`), `press_key` (`:1370`), `hotkey` (`:1382`), `click_mouse` (`:1311`), `drag_mouse` (`:1327`), `focus_window`/`minimize_window`/`maximize_window` (`:1400-1414`), `click_control` (`:1656-1657`, `:1677-1682`), `launch_application` (returns success right after `Popen`, `:1489-1490`; only Explorer tries to capture a window, without failing if none, `:1491-1495`), `write_clipboard` (`:1696-1697`), `set_volume` (no read-back, `:1726-1736`), `open_file`/`open_folder` (`file_tools.py:490-494`, `:500-502`).
- Results are not consistently labelled with `verified` (present on Explorer/close/drag/move-to-monitor only).
- The spoken claim is governed only by prompt rule 3 (`voice_assistant.py:36`). Rule 5 of the tab rules (`:117-119`) itself admits a hotkey "only means that the keystroke was sent".
- Good patterns to keep: `drag_across_monitors` returns `success: False, input_completed: True, verified: False` (`:1221-1226`). `move_window_to_monitor` computes `placed` (`:1174-1187`). `close_explorer`/`close_window` poll `IsWindow` (`:1112-1128`, `:1450-1459`).

### G-09 · Medium · RB-08 — No supervision; fail-hard startup paths; import-time side effects
- `Bot/voice_assistant.py:644-661`: any exception → `SystemExit(1)`. Any Realtime `error` other than "active response" raises and ends the session (`:627-636`). Missing `OPENAI_API_KEY` raises (`:184-186`). No retry or backoff.
- Import-time side effects: `SCREENSHOT_DIR.mkdir` at import (`desktop_tools.py:56-57`). `registry.py:20-21` instantiates `DesktopTools()`/`FileTools()` at import. A failure there kills the process before any error UI.
- `Dollie_Bot_Private/src/lifecycle.ts:2-5`: the single-instance lock binds the fixed port 127.0.0.1:47741. If another app owns that port, startup fails every time (`src/index.ts:28-30`, exit code 1). Under a naive auto-restart that is a crash loop. Prefer a named mutex / Electron `requestSingleInstanceLock` when porting this pattern.
- Spec §13.5 requires backoff and respect for Quit. Nothing in src implements that.

### G-10 · Medium · RB-01, RB-07 — Unstructured logs, unredacted errors, persistent screenshots, billable API key
- All logging is `print` to stdout (20 `print(` calls in `voice_assistant.py`). Tool errors print `str(exc)` (`:390-394`), which can include full user paths and file names. The assistant transcript is printed (`:560-562`). There is no redaction layer, no log file and no correlation IDs (spec §7, §3.8).
- `capture_screen` writes PNGs to `~/Pictures/VoiceAgent` with no retention or cleanup (`desktop_tools.py:56-57`, `:1261-1278`). Screens can contain secrets.
- Auth model is `OPENAI_API_KEY` from `.env` with `load_dotenv(override=True)` (`voice_assistant.py:25`, `:183-189`). That is a billable API key, which spec §5 forbids as a silent fallback. `Dollie_Bot_Private/src/config.ts:27` likewise requires `OPENAI_API_KEY`. Dollie does have redaction-oriented tests (`test/dottie.test.ts:29` T14, `:31` T16; `test/dm.test.ts:76`), which is a reusable pattern.

### G-11 · Medium · RB-05 — No lock/session awareness
- No `WTS*`/session-lock handling anywhere in Bot (grep: no hits). Desktop/input tools would attempt actions on a locked desktop.
- Spec §3 excludes "unattended actions on a locked desktop", and §13.7 requires lock transitions to be validated.

### G-12 · Medium · RB-02, RB-05 — Sensitive confirmations are voice-only; no secure UI
- The only confirmation channels in Bot are voice (`voice_assistant.py:374-389`, `:515-522` for exit). Spec §9.7 requires a secure UI confirmation for sensitive actions.
- Positive reusable pattern: `Dollie_Bot_Private/src/dm.ts:43-55` ties confirmation to requester, channel, thread and a 5-min TTL (`:15`), consumes it before I/O, and makes replay impossible. Tests are in `test/dm.test.ts:43-51`. The concept maps directly onto the `ApprovalRequested/Resolved` binding.

### G-13 · Medium · testability — Bot code cannot be imported on Linux CI and has no tests
- `Bot/tools/__init__.py:3` imports `registry`, which imports `pyautogui` (`registry.py:6`). `file_tools.py:13` imports `winreg`. `desktop_tools.py:20-31` imports `pyautogui`, `pygetwindow`, `pythoncom`, `win32*`, `pywinauto` at module level.
- Observed on the box: `ModuleNotFoundError: No module named 'pyautogui'` for all three modules, and `'winreg'` when loading `file_tools.py` directly.
- Zero tests (audit §1, §4 risk 7). The newest code is on an unmerged branch (`git diff --stat main HEAD`: 2 files, +217/-21).
- Implication: characterisation tests need stub modules (Linux) or a Windows runner, and must be written **before** the import (audit §5).

### G-14 · Low · RB-02 — No browser or Office tool, so the payment surface is not testable yet
- `Bot/tools/browser_tools.py:1` is a docstring only ("not registered yet"). No Office automation in any repo (audit §1).

### G-15 · Low · hygiene
- `Dollie_Bot_Private` is **public** despite its name (audit §4 risk 1). Its `dist/` build output is in the working tree (gitignored, `.gitignore:5`).
- `Dollie_Bot_Private/package.json` declares `engines.node >=22`, but the audit's and my test runs used Node 20. Results are still 45/45, but CI should pin ≥22.
- `TEST_REPORT.md:24` records a live outbound DM batch as operator-reported, not agent-verified. That is a good honesty pattern for our evidence.

## 2. Spec gaps (block test authoring or pass/fail decisions)
| ID | Sev | Gap | Spec ref | Needed decision |
|---|---|---|---|---|
| S-01 | High | **Mute semantics undefined**: close the capture device vs drop frames; persistence across restart/crash; hotkey; does Pause differ from Mute? | §3.3, §9.2, §13.4 | E05/E08: mute = device closed; persisted; default-muted on corrupt settings |
| S-02 | High | No machine-readable **risk taxonomy**. §9.7 and §10 lists differ (e.g. "changing security settings" only in §10). `ApprovalRequested` has no args hash/binding | §7, §9.7, §10 | E08: risk enum + `argsHash` + `channel` fields |
| S-03 | High | `TaskCancelled.stopStatus` values undefined; no way to express "already executed / outcome unknown" | §7, §9.11, §14 | E03: enum incl. `completed-before-cancel`, `terminated`, `outcome-unknown` |
| S-04 | High | Event contract has **no mic-state or upload events**, so RB-06/RB-07 can't be proven from traces | §7 | Add `MicStateChanged`, `AudioUploadStarted/Stopped{requestId, provider}` |
| S-05 | High | STT/TTS provider unselected; disclosure text, placement and consent record not specified | §5, §9.5 | PO/E05/E08 |
| S-06 | Medium | Windows 11 builds and "named test hardware" not named; MXC sandbox needs specific builds (audit §3) | header, §14 | E01/E09 name the builds and devices |
| S-07 | Medium | "Auth session leakage" boundary undefined (renderer, IPC, logs, dumps, screenshots, clipboard, model context) | §5, §14 | Adopt the RB-01 definition in `release-blockers.md` |
| S-08 | Medium | SDK vs App Server unresolved. The audit shows only App Server has login (verified: `codex/codex-rs/app-server-protocol/src/protocol/common.rs:1301,1335,1475`) | §2, §5 | E01/E02 ADR |
| S-09 | Medium | Benchmarks are "proposed". No sample sizes/confidence for the 100% claim (M8) or false-wake rate | §14 | E09 methodology |
| S-10 | Medium | Log format, location, retention and redaction unspecified beyond "structured local logs" + SQLite | §3.8, §4 | E08 |
| S-11 | Medium | Lock-screen policy: does wake listening continue while locked? What happens to queued tasks/approvals at lock? | §1, §3, §13.7 | E03/E08 |
| S-12 | Medium | Crash-loop thresholds (backoff base, cap, window) unspecified | §13.5 | E09 |
| S-13 | Low | Task-switch rule "queued or cancel-then-start" is left open | §9.11 | E03 picks one |

## 3. Audit gaps
- **A-01** The audit names `file_tools.is_protected/ensure_mutable` as reusable guards (§2 policy row) but does not note that they protect **writes only**. Reads, `open_file` execution, the clipboard read, and overwrite-via-move are unguarded (G-03, G-04, G-05).
- **A-02** Test claims are unverified for MDC (~90 modules, "did not run"), Groot and Santa_Claus ("not run"). MDC is not on this box, so its "best voice asset" and the `gate/confirm.py` fail-closed model are **unverified by QA**.
- **A-03** The audit's "45/45 pass" was on Node 20 against `engines >=22`. I reproduced it on the same Node 20 only.
- **A-04** The audit does not cover lock/DPI/cancel/logging gaps in Bot (G-06, G-07, G-10, G-11).
- I verified these audit claims: the Codex app-server login methods; the TS SDK has no login API (`codex/sdk/typescript/src/codexOptions.ts` exposes `codexPathOverride`, `apiKey`, …; no `login` in `sdk/typescript/src`); `chatgptAuthTokens` is marked experimental (`codex/codex-rs/app-server-protocol/src/protocol/v2/account.rs:88`); Bot's fail-open approval.

## 4. Untestable as currently designed
| RB / area | Why | Unblocked by |
|---|---|---|
| RB-04 post-cancel | No cancellation mechanism, and tools block the event loop (G-07). No `stopStatus` enum (S-03) | Coordinator with cancel tokens + contract |
| RB-06 mute | No mute in any repo (G-02); no mic-state event (S-04) | Audio worker with counters + S-01 decision |
| RB-07 disclosure | No wake word or onboarding; provider unselected (S-05) | Voice pipeline + disclosure spec |
| RB-02 payment | No browser tool (G-14) | Playwright adapter + loopback checkout fixture |
| RB-01 auth | No Codex integration; SDK vs App Server undecided (S-08) | Week-1 login proof (§5) on the pinned app-server |
| RB-08 crash loop / reboot | No tray, installer, auto-start or supervisor | Electron app + supervisor (§13) |
| RB-05 lock | No session awareness (G-11); policy undecided (S-11) | Lock-state provider in the tool router |
| RB-09 truthfulness of speech | The spoken outcome is free-form model text, not derived from `TaskFinished` (Bot `voice_assistant.py:36`, prompt only) | Templated outcome phrases or a structured outcome → TTS mapping |
| Bot tools on Linux CI | Windows-only imports at module load (G-13) | Import seams or stub modules; Windows runner |
| Wake benchmarks M1–M4 | No wake engine (audit §1) | Porcupine (or chosen) integration + audio rig |

## 5. Recommended next QA actions (no code written yet)
1. E01 ADR inputs: S-01…S-05 and S-08 are prerequisites for writing RB tests.
2. Stand up Linux CI skeleton tests: secret scan, boundary check, and contract schema tests, as soon as `packages/contracts` exists.
3. Write Bot characterisation tests (stubbed on Linux, native on a Win11 runner) **before** importing `tools/` (audit §5). Encode G-01…G-08 as failing "known-gap" tests, so fixes are provable.
4. Provision one Win11 24H2 runner with a virtual audio cable and a 3-monitor mixed-DPI configuration, plus one physical laptop for acoustic and lock/sleep runs.
