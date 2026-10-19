# E04 — Windows tool adapters (`packages/tools`): assessment and test-first plan

Prepared Sun 2026-10-18 (CDT, UTC-5) by E04 (Windows Integration Specialist). **First pass only: assessment and plan. No code was changed, nothing was pushed, and nobody was messaged.**

Inputs read:
- `/workspace/dottie/spec.md` (v1.0) and `/workspace/dottie/audit.md`, in full.
- `/workspace/dottie/src/`. It contains clones of Bot, Dollie_Bot_Private, Groot_1.0, Santa_Claus, codex (8c07694) and groot-harness.
- `Gopi-Git001/Bot` at branch `fix/unexpected-session-exit` (5268c8d, 2026-10-14 19:06 CDT), read through the cursor-github connector (`get_file_contents`, read-only):
  - `tools/desktop_tools.py` (1,736 lines)
  - `tools/file_tools.py` (963 lines)
  - `tools/registry.py` and `requirements.txt`, for context.

State of things:
- **`packages/tools` does not exist anywhere yet.** There is no `dottie/` monorepo, only the source clones under `src/`. The only `packages/` directory belongs to Santa_Claus, which is a different product.
- **Bot has no tests.** Its git tree is `.gitignore, requirements.txt, tools/{__init__,browser_tools,desktop_tools,file_tools,registry,session_tools}.py, voice_assistant.py`. There is no `tests/` directory, no pytest config and no CI.
- **The branch does not change these two files.** `git diff main..fix/unexpected-session-exit -- tools/` touches only `tools/session_tools.py`, so `desktop_tools.py` and `file_tools.py` are the same on `main` (504da3e) and on the branch.
- **`requirements.txt` is unpinned.** It lists 13 bare names (PyAutoGUI, pywinauto, pywin32, mss, pycaw, …) with no versions and no lock file.

---

## (a) What the spec and audit require of E04

Ownership (spec §6): E04 builds the "UIA, File Explorer, shell, Office, browser adapters" and depends on E03 (orchestration) and E11 (verification/fallback/robustness). E08 must approve sensitive capabilities, and E07 has independent test authority.

| # | Requirement | Source |
|---|---|---|
| R1 | **Scoped adapters behind a tool router** (MCP/adapters, "explicitly scoped"). Default-deny scopes: `files.read`, `files.write`, `shell.execute`, `desktop.control`, `browser.navigate`, `network.send`, `app.install`, `credentials.access` (generally forbidden), `purchases`. Record the origin and limits of every action. | §4, §10 |
| R2 | **Windows UI Automation**: target elements by UIA first, window-bound actions next, coordinates last. | §4, §11 |
| R3 | **Window discovery/focus**: identify the target window **by handle and process**, not by title alone. | §11 |
| R4 | **Multi-monitor**: enumerate displays, DPI and window bounds, and translate between coordinate systems. | §3.7, §11 |
| R5 | **File Explorer**: use **known-folder APIs**, **navigate the existing Explorer window**, select by automation ID rather than visual position, and avoid opening extra windows. First demo: "open File Explorer and go to Downloads", verified as Explorer *displaying* Downloads. | §11, §12 |
| R6 | **Files**: work inside granted workspace paths. Deleting user data or overwriting important documents needs explicit, single-use approval tied to the exact action. Example flow: "newest PDF in Downloads → open → verify viewer and path". If two candidates tie, ask before acting. | §9, §10 |
| R7 | **Shell**: PowerShell and CMD, plus Bash/WSL **when installed**. Needs timeouts, stdout/stderr capture, meaningful exit-code checks **plus a postcondition**, safe **process-tree cancellation**, a limited working directory and command policy, and **no unsupervised elevation**. | §3.6, §9.8, §11 |
| R8 | **Browser**: Playwright contexts/profiles that respect site policies. **No credential scraping. Never finalize orders automatically.** The browser must be user-visible when login or purchases are involved. | §9.8, §11 |
| R9 | **Word/Excel/PowerPoint**: prefer file-format libraries or official automation interfaces, use the GUI only when visible interaction is needed, and verify the output artifacts. | §11 |
| R10 | **Fallback order**: UIA element → app API → controlled browser → bounded screenshot/coordinates. When uncertain, stop or ask. No random clicking. | §11 |
| R11 | **Verification**: an explicit postcondition for every supported workflow. "Tool returned OK" is not enough. Partial success is reported honestly. Retries only when safe and bounded. | §9.9, §11 |
| R12 | **Cancellation**: propagates to active tool processes. Never report "cancelled" if an external effect has already happened (release blocker). | §4, §9.11, §14 |
| R13 | **Prompt-injection posture**: web pages, documents and command output are data, not instructions. | §10 |
| R14 | **Never**: unsupervised elevation, credential/cookie scraping, auto-finalized purchases, actions on a locked desktop, incorrect-window actions (release blocker). | §1, §3, §14 |
| R15 | **Audit guidance**: reuse Bot `desktop_tools.py` + `file_tools.py` behind adapters, **adding tests before any change**. Wrap them as a scoped tool worker. Shell and Office are new builds. Browser takes groot-harness as a pattern only. **Do not carry forward Bot's approval flow.** | audit §2, §4.3, §5 |
| R16 | **Contracts first**: interface contracts before parallel implementation. Each ticket carries ID, contract, policy implications, acceptance tests, evidence path and rollback. Mock interfaces for deterministic unit tests, real Windows E2E for acceptance. | §7, §14 |

Relevant shared events (§7): adapters feed `TaskProgress{toolId}` and `ToolResult{taskId, toolId, observedState, verified, error?}`. Approvals arrive as `ApprovalRequested` / `ApprovalResolved`, which E03 and E08 own, not E04.

---

## (b) Bot code: reuse vs rewrite

The verdicts below come from reading the code only. Nothing has been run on Windows yet.

### Cross-cutting problems (both files)

These have to be fixed by the wrapper or rewrite, whatever is reused.

1. **The modules won't import off Windows, and importing them has side effects.**
   - `desktop_tools.py` imports `pyautogui, pygetwindow, pythoncom, win32api, win32com, win32gui, mss, pywinauto` at module top. `file_tools.py` imports `winreg` at top.
   - `SCREENSHOT_DIR.mkdir(...)` creates `~/Pictures/VoiceAgent` at import time.
   - `pg.FAILSAFE`/`pg.PAUSE` are set globally.
   - `registry.py` instantiates the singletons `DesktopTools()` and `FileTools()` at import.
   - Result: they cannot be unit-tested on Linux CI as they stand. A platform-port seam is required.
2. **Errors are inconsistent.** Some functions raise `ToolError` and others return `{"success": False}`. `registry.execute_tool` turns every exception into `str(exc)`, which leaks paths and internals. No error codes, and no `retryable` flag.
3. **Nothing can be cancelled, and timeouts are hard-coded.** Every verify loop is `for _ in range(N): time.sleep(0.2)` (6 s for navigate, 4 s for click, 2 s for close). There is no cancel token, deadline or injectable clock.
4. **Results don't record side effects.** Results are missing `sideEffect: none|attempted|committed|unknown`. Spec §14 needs this to report cancellation honestly.
5. **Approval lives inside the tools** (`APPROVAL_REQUIRED = {"terminate_application"}`, `{"delete_file"}`). Mutating behaviour is also controlled by a **model-supplied `overwrite: bool`**, and the docstrings ask the model to "ask the user first". That is prompt-level policy, not enforcement. See "Explicitly excluded" below.
6. **No scope model.** Any absolute path or UNC path is accepted, and any window title is accepted.

### `tools/desktop_tools.py`

| Area / functions | Verdict | Notes and risks |
|---|---|---|
| `same_folder`, `file_url_to_path`, `virtual_location_error`, `THIS_PC_MARKERS`, `SHELL_LOCATIONS`, `VIRTUAL_EXPLORER_LOCATIONS` | **Reuse (pure)** | Pure functions, easy to test first. `same_folder` uses the host's `normcase`, so Linux tests need `ntpath` injected to get Windows semantics. |
| `DesktopSessionState` (`remember`, `clear_window`, `recent_folders`, `previous_folder`) | **Reuse (pure)** | Small state holder. Must become per-task/thread state, not a process singleton, so separate Codex threads don't share an hwnd. |
| `ExplorerController._windows`, `_target`, `_shell_path`, `_location_snapshot`, `_com_text` | **Reuse with changes** | Shell.Application COM is the right primitive for "navigate the existing window", and `Document.Folder.Self.Path` is a good observation. Risks: **`_target()` silently adopts the foreground or the only Explorer window**, which can be the user's own window. The spec wants reuse, but this needs an explicit "adopt window" rule from E01/E11. It raises an uncaught `RuntimeError` on multiple windows (see `navigate`). It filters by the `explorer.exe` basename only and never checks PID or session. |
| `ExplorerController.navigate` | **Reuse core, rewrite flow** | Good: resolves the target, refuses virtual locations, calls `window.Navigate`, then polls the shell path → `verified: True`. Bugs: (1) `_target()`'s `RuntimeError` is **not caught** inside `navigate` (no try around the `com_apartment` block), unlike `navigate_shell`. (2) It calls `resolve_user_path`, which can do a **fuzzy directory search** (`find_named_directory`) and so silently picks a "Projects" folder. (3) `_open_initial` spawns `explorer.exe` and identifies "the" new window by an hwnd diff, which **races** with any window the user opens at the same time. (4) The 6 s sleep loop cannot be cancelled. |
| `navigate_shell`, `_shell_location_matches`, `open_downloads/documents/desktop/this_pc` | **Reuse with changes; this is the first-demo path** | Main verification is the right kind (`same_folder(actual, known_folders()[key])`). **Risk:** the fallback `friendly in observed` is a **substring match** on `LocationName + LocationURL + path`. "downloads" matches `C:\x\downloads-old` or any folder whose name contains "Downloads", so this is a **false-positive "verified"**. Remove it, or demote it to `verified: false, reason: "name-only match"`. The `shell:` paths are fine for navigation, but the expected path must come from `SHGetKnownFolderPath`. |
| `_navigation_items`, `list_navigation_items`, `click_navigation_item`, `open_explorer_sidebar_item`, `_activate_sidebar_item`, `_expected_navigation_target`, `_destination_matches`, `_onedrive_root_items`, `_normalize_sidebar_name`, `_navigation_base_name`, `open_explorer_home` | **Reuse ideas, rewrite** | Good: the UIA TreeItem enumeration in the navigation pane, and computing the *expected destination before clicking*. That second point is exactly what spec §11 asks for. Risks: (1) **Elements are matched by `window_text()` and then de-duplicated by name**, so two distinct elements with the same label merge into one "unique" match and the first is clicked. This **hides ambiguity**. (2) `click_navigation_item` uses `click_input()`, a **real mouse move/click at element coordinates** that needs a visible, unoccluded window and moves the user's cursor. It should try UIA `SelectionItem`/`Invoke`/`ExpandCollapse` patterns first. (3) `open_explorer_sidebar_item` tries `select → invoke → click_input` **one after another on the same element**, which can stack several actions. (4) The `"named"` destination kind verifies by *folder basename* only, so it is weak. (5) OneDrive matching uses bidirectional substring containment (`name in folded or folded in name`). Labels depend on locale (English "Navigation Pane", "Home", "Gallery"), so on non-en-US Windows this breaks without automation IDs. |
| `onedrive_accounts` | **Reuse with changes** | Reads `HKCU\Software\Microsoft\OneDrive\Accounts` plus env vars plus a `~/OneDrive*` glob. It is read-only and fine, but needs a registry port so it can be tested. |
| `get_current_folder`, `list_current_folder`, `open_child_folder`, `find_folder`, `go_parent_folder`, `go_back` | **Reuse** | Bounded (200 items, depth ≤ 5, 2,000 dirs, 20 matches), skips reparse points, refuses ambiguity. Route every path through the new scope check. `go_back` relies on the literal `previous == "This PC"`, but `remember()` stores `LocationName`, which is localized. Fix that. |
| `close_explorer`, `DesktopTools.close_window` | **Reuse mechanics, gate it** | `WM_CLOSE` plus an `IsWindow` poll is a real postcondition. `close_window` matches on **partial title** and is **ungated**. If the app shows a "Save changes?" prompt, the window stays open and the tool returns "did not close", which is correct. It still needs a policy class (`desktop.control`, `risk: medium`). |
| `monitor_layout`, `point_on_any_monitor`, `validate_point`, `list_monitors`, `move_window_to_monitor` | **Reuse with changes** | `EnumDisplayMonitors` and the verified window-centre placement are good. Risks: (1) **No DPI awareness.** The process DPI-awareness mode is never set, so on mixed-DPI or high-DPI setups win32 coordinates, pyautogui coordinates and UIA rectangles can disagree. (2) `get_screen_info`/`capture_screen` use **mss indices** (0 = all monitors), while `monitor_layout` uses **EnumDisplayMonitors order starting at 1**. The same `id` can mean different monitors. (3) `find_window` matches by title substring, not hwnd+pid (spec R3). |
| `find_window`, `list_windows`, `focus_window`, `minimize_window`, `maximize_window` (pygetwindow) | **Rewrite** | Identification is by title substring only. **`focus_window` returns success without checking `GetForegroundWindow() == hwnd`**, although `SetForegroundWindow` is often refused by Windows' foreground-lock rules. Minimize and maximize are not verified either. Rebuild on `EnumWindows` + `GetWindowThreadProcessId` + `psutil` → `WindowRef{hwnd, pid, exe, title, class, monitor, rect, dpi}` with verified postconditions. |
| `move_mouse`, `click_mouse`, `drag_mouse`, `scroll_mouse`, `drag_across_monitors` | **Rewrite as the bounded last-resort fallback** | They return `success: True` with **no target window and no verification**. They are not bound to a window and work only on virtual-screen coordinates. Under spec R10 they must require a target `WindowRef`, a point inside that window's rect, a foreground check just before input, DPI translation, and a post-observation. `drag_across_monitors` is the honest one: it returns `success: False, input_completed: True, verified: False`. Keep that pattern. |
| `type_text`, `press_key`, `hotkey` | **Rewrite; high risk** | (1) `type_text` **pastes through the clipboard**. It reads the user's previous clipboard, which may hold a password copied from a password manager, overwrites it, and restores only text, so images and files on the clipboard are lost. It also types into **whatever window has focus** (incorrect-window action is a release blocker). (2) `hotkey` and `press_key` accept any `pg.KEYBOARD_KEYS` combination, including `win+r` and `win+x`, so they are **effectively arbitrary command execution that bypasses the shell policy**. Prefer UIA `ValuePattern.SetValue` on a resolved element. Keyboard fallback needs a key allowlist, a foreground check, `desktop.control`, and no OS-level chords without approval. |
| `launch_application` (`ALLOWED_APPS`), `capture_new_window` | **Reuse the allowlist idea, rewrite verification** | The allowlist and `shell=False` are good. Risks: the returned `pid` is the **launcher's**. `calc.exe` is a stub that hands off to a UWP app and exits. `explorer.exe` hands off to the existing shell process. So PID-based tracking is wrong. Verify through a new top-level window (hwnd diff with a process/AppUserModelID filter), not through `Popen.pid`. |
| `terminate_application` | **Rewrite** | Gated only by Bot's (fail-open) approval. The denylist is tiny (5 names). It has a **PID-reuse race** between lookup and `terminate`, does not check that the process belongs to the current user or session, and does not handle the process tree. Rebuild it on the shared process-supervision module (Job Objects). |
| `inspect_window`, `click_control` | **Reuse as the UIA seed, rewrite** | This is the right primary path (R2). Risks: window found by title substring; `descendants()[:150]` truncates silently; `click_control` by `auto_id` uses `click_input()` (the mouse), not `Invoke`; the **same name-dedup bug that hides ambiguity**; **no postcondition**; UIA names are localized. |
| `capture_screen`, `get_screen_info`, `get_mouse_position` | **Rewrite** | Writes full-monitor PNGs to `~/Pictures/VoiceAgent` without limit, retention or redaction. It may capture other apps' secrets. Screenshots need to be scoped to a window rect, stored in Dottie's AppData with TTL, and gated by `desktop.control`. `from mss import MSS` depends on the version. Requirements are unpinned, so verify this when pinning. |
| `read_clipboard`, `write_clipboard` | **Gate heavily or drop for v1** | `read_clipboard` hands up to 10 KB of clipboard text to the model with **no gate**. That is a credential-exposure path (spec `credentials.access` is generally forbidden). |
| `get_system_info`, `get_volume`, `set_volume`, `list_applications`, `list_drives` | **Reuse (low risk)** | Read-only or trivially reversible. `set_volume` should verify by reading the level back. |

### `tools/file_tools.py`

| Area / functions | Verdict | Notes and risks |
|---|---|---|
| `known_folders`, `SHELL_FOLDERS` | **Rewrite** | It reads `HKCU\…\Explorer\User Shell Folders` and `expandvars`, which is the registry, not the **known-folder API** (spec R5). That breaks with folder redirection, OneDrive Known Folder Move edge cases and policy-redirected paths. Replace it with `SHGetKnownFolderPath(FOLDERID_*)` (ctypes or `win32com.shell`) behind a `KnownFolders` port. Keep the alias table. |
| `clean_label`, `FOLDER_ALIASES`, `human_size`, `display_time`, `entry_for`, `place_inside`, `_ordinal`, `_extension_from_phrase`, `_name_fragment`, `_looks_like_reference` | **Reuse (pure)** | Pure helpers, the first unit tests. `display_time` returns naive local time; emit ISO with offset. |
| `resolve_user_path`, `existing_path`, `find_named_directory`, `_scan_for_directory`, `default_parent_for` | **Rewrite as `ScopedPathResolver`** | (1) **No workspace scope**: any absolute path is accepted. (2) **UNC paths (`\\server\…`) are accepted**, which reaches the network and can leak NTLM hashes. (3) Relative paths join to home **without rejecting `..`** (`Downloads\..\..\Windows`). Resolution happens later, but the scope check must happen *after* `resolve()` on the final path, including symlink and junction targets. (4) `find_named_directory` is a fuzzy guess that searches 4 roots × depth 2. It should return candidates for clarification, never auto-pick. |
| `is_protected`, `is_sensitive_root`, `ensure_mutable`, `is_reparse`, `SKIP_DIR_NAMES` | **Reuse as a deny layer under the scope allowlist** | Good: refuses drive roots, `SystemRoot`/`ProgramFiles`/`ProgramData`, home and the known-folder roots themselves, and skips reparse points. **Gap:** it does **not** protect `%APPDATA%`/`%LOCALAPPDATA%` (browser profiles, cookies), `~/.ssh`, `~/.codex` (Codex auth), Dottie's own AppData, or the Credential Manager vault. **Reads are not guarded at all.** For example, `read_file("<codex-credential-file>")` returns a 4,000-character preview, because `.json` is in `TEXT_EXTENSIONS`. **That is credential scraping by the model.** |
| `list_directory`, `get_file_info`, `read_file`, `text_preview`, `search_files`, `_iter_search`, `_prune`, `_search_roots`, `get_disk_usage`, `_measure`, `list_drives` | **Reuse with changes** | Budgets are bounded (80 listed, 30 results, 4,000 dirs, 5,000 files measured, 64 KB sample, NUL-byte binary check). Changes needed: scope checks; mark returned file text as **untrusted data** (R13); a cancel token in the walkers. `search_files("computer")` walks **every fixed drive**, so it should require explicit scope. Add the "newest PDF" sort (the spec example) as a first-class query, not a model-side guess. |
| `open_file` (`os.startfile`) | **Rewrite; high risk** | `os.startfile` on **any** existing file launches `.exe/.bat/.cmd/.ps1/.lnk/.url/.msi/.js/.vbs/.hta` and so is **arbitrary code execution, with no gate**. It reports success without verifying that a viewer opened. Needs a document-type allowlist, refusal or approval for executables, and verification through a new window for the file (E11). |
| `open_folder`, `_reveal_search` | **Rewrite** | Both `Popen(["explorer.exe", …])` **open new windows**, which conflicts with R5. `_reveal_search` builds a `search-ms:` URI from **unescaped model input**. Route both through `ExplorerController.navigate` (and its `search-ms` variant with proper encoding). |
| `create_folder`, `create_file`, `write_file`, `rename_file`, `copy_file`, `move_file` | **Reuse mechanics, rewrite the policy surface** | Good: refuses existing targets by default, a 100 KB write cap, single-name rename validation. Risks: (1) **`overwrite` is a model-supplied boolean** standing in for user approval. It must become an approval token bound to an exact action hash (E08/E03). (2) **TOCTOU**: `exists()` is checked before `write_text`/`rename`/`copy2`. Use `O_EXCL`-style creation and an atomic replace. (3) **`move_file` with overwrite calls `dest.unlink()` *before* `shutil.move`**. If the move then fails, for example across volumes or on a locked file, **the destination is already gone**. (4) Writes are UTF-8 only. (5) A bare name defaults to the **Desktop**, which is a product decision. (6) No postcondition such as a re-stat or hash of the written content. |
| `delete_file` | **Rewrite** | Calls `Path.unlink()`/`rmdir()`, a **permanent delete, not the Recycle Bin**. Its only protection is Bot's fail-open approval. Use `IFileOperation` with `FOFX_RECYCLEONDELETE` (undo-able), require an approval token, and verify absence plus presence in the Recycle Bin. |
| `FileTools.resolve_reference`, `_coerce_existing`, `_coerce_any`, `_new_path`, `_one_recent_file`, `_opened_match`, `_filtered`, `recent_entries`, `opened_entries` | **Do not port for v1 (decide with E03)** | This is conversational coreference ("that file", "the second PDF"). Codex already holds the thread context. Keeping a second resolver inside the tools means **"it" can silently resolve to a stale `last_file` and then be mutated**. If kept, it must be per-thread, read-only, and return candidates instead of a chosen target for any mutating call. |

### Explicitly excluded: Bot's approval flow

None of these will be ported, wrapped or kept as a fallback:
- `registry.execute_tool(approval_callback=…)`
- both `APPROVAL_REQUIRED` sets
- the `pending_approval["confirmed"] = True` logic in `voice_assistant.py`, which audit §4.3 shows **fails open** on any `speech_stopped` event
- any docstring of the "ask the user, then call again with overwrite true" kind

Approval belongs to E08 (policy) and E03 (coordinator), per spec §10. The audit suggests modelling it on MDC `gate/confirm.py`. Adapters only:
1. declare a risk class and the scopes needed for each call,
2. produce an exact, side-effect-free **ActionPreview**, and
3. refuse to run a gated action unless they are handed a valid approval token bound to that preview's hash.

The `EXPOSED_TOOLS` explicit-allowlist idea from `registry.py` (never auto-expose every method) **is** kept. Its `build_schema` reflection is replaced by declared schemas.

### Reuse summary

- **Reuse roughly as is (≈25%):** Explorer COM navigation and verification core, the pure helpers, bounded walkers, OneDrive discovery, monitor enumeration, window-close postconditions.
- **Rewrite:** window identity/focus, all raw input, screenshots, clipboard, known folders, path scoping, open/delete/overwrite semantics, approvals.
- **New:** shell, browser, Office, process supervision, cancellation.

---

## (c) Proposed `packages/tools` layout and adapter interface

### Language and hosting (proposal; needs a decision from E01, see (e))

Proposal: a **Python 3.12 tool worker**, supervised as a child process by the Electron main process. Reasons: it is the fastest path to reuse Bot's pywin32/pywinauto code, and python-docx, openpyxl, python-pptx and Playwright-for-Python all exist. It would expose tools through one of two routes:
- **(A) Codex App Server client-side dynamic tools** (`item/tool/call`). Electron main receives each call, runs it through policy/approval, then forwards it to the worker over a local RPC.
- **(B) An MCP stdio server** registered in Codex config.

Codex @ 8c07694 has both (`DynamicToolCall => "item/tool/call"` and `McpServerElicitationRequest`). (A) keeps the policy gate in our own process, so it is preferred. Their stability flags are not yet checked.

```text
packages/tools/
  pyproject.toml            # pinned deps + lockfile (uv/pip-tools); win-only extras
  README.md                 # tool catalogue, scopes, risk classes, supported Windows builds
  dottie_tools/
    contracts.py            # ToolSpec, ToolCall, ToolContext, ActionPreview, ToolResult, ErrorCode (mirrors packages/contracts JSON Schema)
    adapter.py              # Adapter protocol + base helpers
    router.py               # explicit allowlist registry; schema validation; scope check; approval-token check; audit emit
    server.py               # transport (App Server dynamic-tool bridge RPC, or MCP stdio) — thin
    runtime/
      cancel.py             # CancelToken (check/wait/settle; MDC router/cancel.py pattern)
      wait.py               # wait_until(predicate, timeout, token, clock) — replaces sleep loops
      clock.py              # injectable monotonic clock
      redact.py             # path/user redaction for logs
    platform/               # **only place that imports win32/pywinauto/ctypes**
      ports.py              # Protocols: ShellWindows, Uia, Win32Windows, Monitors, KnownFolders, Registry, Processes, Clipboard, Input, FileOps, Recycle
      win32/                # real implementations (Windows only)
      fakes/                # in-memory fakes for Linux CI
    scope/
      paths.py              # ScopedPathResolver (allowlist roots + deny list + UNC/.. /reparse rules, ntpath semantics)
      denylist.py           # AppData, .ssh, .codex, browser profiles, Dottie data, system roots
    adapters/
      windows/              # discovery.py (WindowRef by hwnd/pid/exe), focus.py, monitors.py (DPI), uia.py (find/invoke/value/select)
      explorer/             # known_folders.py (SHGetKnownFolderPath), controller.py (from Bot ExplorerController), verify.py
      files/                # read.py, write.py (atomic, excl-create), delete.py (recycle), search.py (incl. newest-by-type)
      apps/                 # launch.py (allowlist, window-diff verification), terminate.py
      shell/                # runner.py (pwsh/powershell/cmd/wsl detection), jobobject.py (process-tree kill), policy hooks (allowed cwd, command class)
      browser/              # playwright_adapter.py (dedicated profile, visible mode, no order finalization guard)
      office/               # docx.py, xlsx.py, pptx.py (file-format libs); com_automation.py (feature-flagged, visible-interaction only)
      input/                # fallback.py — bounded, window-bound coordinates/keys; last in fallback order
  tests/
    unit/  contract/  fakes/
    windows/                # pytest -m windows — run on real Windows runner only
```

### Adapter interface (draft for `docs/contracts/tools.md`; E01 freezes it)

```python
class RiskClass(Enum): READ = "read"; REVERSIBLE = "reversible"; SENSITIVE = "sensitive"; FORBIDDEN = "forbidden"
class SideEffect(Enum): NONE = "none"; ATTEMPTED = "attempted"; COMMITTED = "committed"; UNKNOWN = "unknown"

@dataclass(frozen=True)
class ToolSpec:
    tool_id: str                 # "explorer.navigate_known_folder"
    input_schema: dict           # JSON Schema (generated from packages/contracts)
    scopes: frozenset[str]       # {"desktop.control"} / {"files.write"} ...
    risk: RiskClass              # static floor; preview may raise it
    default_timeout_s: float
    cancellable: bool

@dataclass(frozen=True)
class ToolContext:
    task_id: str; action_id: str; thread_id: str | None
    granted_scopes: frozenset[str]; workspace_roots: tuple[str, ...]
    cancel: CancelToken; deadline: float; clock: Clock; audit: AuditSink

@dataclass(frozen=True)
class ActionPreview:            # side-effect free; resolved, exact targets
    tool_id: str; resolved_args: dict; targets: list[dict]   # e.g. {"hwnd":..,"pid":..,"path":..}
    risk: RiskClass; summary: str; action_hash: str          # hash(tool_id, resolved_args, targets)
    needs_clarification: list[dict] | None                    # ambiguity -> ask, never guess

@dataclass(frozen=True)
class ToolResult:               # maps to §7 ToolResult{taskId, toolId, observedState, verified, error?}
    tool_id: str; ok: bool; verified: bool; verification: str | None   # e.g. "shell_path_equals_known_folder"
    observed_state: dict; side_effect: SideEffect
    error: ToolError | None      # {code, message, retryable}
    untrusted_content: list[dict] # file text / page text / stdout, tagged as data (R13)

class Adapter(Protocol):
    def specs(self) -> list[ToolSpec]: ...
    def preview(self, tool_id: str, args: dict, ctx: ToolContext) -> ActionPreview: ...
    def execute(self, preview: ActionPreview, ctx: ToolContext, approval: ApprovalToken | None) -> ToolResult: ...
    def observe(self, tool_id: str, preview: ActionPreview, ctx: ToolContext) -> dict: ...   # for E11 verifier/recovery
```

Router rules:
1. Unknown tool → error. Schema-invalid input → error.
2. Missing scope → `PERMISSION_REQUIRED` with no side effect.
3. `risk == SENSITIVE` and no valid token for `action_hash` → `APPROVAL_REQUIRED` with no side effect.
4. `FORBIDDEN` → always refused.
5. Every call emits an audit record. Adapters **never** prompt the user themselves.

Fallback order (R10) is a router/E11 policy over adapter capabilities, not something each adapter decides alone.

---

## (d) First tests to write (characterization of Bot's behaviour first, then the new contract)

Conventions:
- `pytest`. Windows APIs are reached only through `platform/ports.py` and swapped for `fakes/` on Linux.
- Paths use `ntpath`/`PureWindowsPath` semantics in tests.
- `@pytest.mark.windows` marks tests that run only on a real Windows 11 runner, later a self-hosted interactive-desktop runner, because UIA needs a desktop session.
- Step 0: lift Bot's two files into `packages/tools` **with attribution and history**, add the port seam with no behaviour change, then write the characterization tests below **before** any fix. Tests that pin a known-bad behaviour are marked `xfail(strict=True)` with the fix ticket.

### Linux CI (mocked), first batch

**Pure helpers (Bot as is)**
1. `same_folder` treats Windows case and slashes as equal and different folders as unequal. Empty or `None` → False.
2. `file_url_to_path("file:///C:/Users/a%20b/Downloads")` → `C:\Users\a b\Downloads`. Non-file URL → `""`.
3. `virtual_location_error`: "This PC", "my computer", "the OneDrive folder", "Home" and the `::{20d04fe0…}` CLSID map to the right guidance. "Downloads" → None.
4. `clean_label`, `FOLDER_ALIASES` (docs, photos, profile …), `human_size` boundaries, `_ordinal`, `_extension_from_phrase`, `_name_fragment`, `_looks_like_reference`.
5. `DesktopSessionState.remember`: tracks `previous_folder`, de-duplicates `recent_folders`, caps at 10.

**Explorer controller (FakeShellWindows + FakeKnownFolders)**

6. `navigate_known_folder("downloads")` with one existing Explorer window → calls `Navigate` on **that** hwnd. No new process. `verified=True` only after the fake reports the expected path. `reused_window=True`.
7. The fake never reaches the expected path → `verified=False` within the deadline (fake clock), with the observed location reported.
8. **Characterization `xfail`:** the observed folder `C:\x\Downloads-old` currently "verifies" through the `friendly in observed` substring fallback → must become `verified=False`.
9. Two Explorer windows, neither in the foreground → returns a structured "ambiguous window" error. **Characterization:** today `navigate()` lets the `RuntimeError` escape.
10. No Explorer window → exactly one launch. A second window opening at the same time (fake) → ambiguity error, not a wrong-window adoption.
11. Cancel token fired during the verify wait → returns within ≤ 1 fake tick with `side_effect=ATTEMPTED` and `verified=False`.
12. Expected paths come from `KnownFolders` (the SHGetKnownFolderPath port), and a redirected Downloads (`D:\Dl`) is honoured.

**UIA element targeting (FakeUia tree)**

13. Two distinct TreeItems both named "Downloads" → returns **ambiguity with both elements**. **Characterization `xfail`:** the current name-dedup picks the first.
14. Activation order is `Invoke`/`SelectionItem` pattern first and `click_input` only through the fallback adapter. Never more than one activation per call unless the previous one is verified as a no-op.
15. Sidebar destination computed before the click. An unknown item → the "named" kind is reported as `verified=False, verification="name_only"`, not success.

**Window discovery and focus (FakeWin32Windows)**

16. A target is resolved to a `WindowRef{hwnd,pid,exe}`. A title-only match that hits two processes → ambiguity.
17. `focus_window` reports `verified=True` only if foreground == hwnd after the call. A fake foreground-lock refusal → `verified=False`. **Characterization:** today it returns success without checking.
18. `move_window_to_monitor` verifies the window centre on the target monitor. Monitor IDs are consistent between list and capture (**characterization:** mss vs EnumDisplayMonitors index mismatch).
19. Coordinate/DPI translation: a 150% secondary monitor at negative virtual coordinates → the right physical point. A point outside the target window rect → refused.

**Input fallback**

20. `type_text`/`hotkey` refused without a target `WindowRef` and a foreground check. `win+r`, `win+x`, `ctrl+alt+del`, `alt+f4` (not on the allowlist) → refused.
21. Text entry prefers UIA `ValuePattern`. The clipboard path (if kept) restores non-text clipboard formats and never returns the previous clipboard to the caller.

**Path scope (ScopedPathResolver)**

22. Allowed: paths under the granted roots. Rejected:
    - `..` escapes (`Downloads\..\..\Windows`)
    - UNC `\\server\share`, `\\?\` and `\\.\` device paths
    - drive roots
    - a junction or symlink inside scope that points outside it (fake reparse)
23. Deny list applies to **reads** as well as writes: `%APPDATA%`, `%LOCALAPPDATA%`, `~\.ssh`, `~\.codex`, browser profile dirs, Dottie data dir. **Characterization:** today `read_file("<codex-credential-file>")` returns a preview.
24. `find_named_directory` with two matches → candidates for clarification. It never auto-picks.

**File operations (tmp dir with `PureWindowsPath` mapping, or a fake FS)**

25. `create_file` with exclusive create when the target already exists → refused, with no partial write. `write_file` overwrite without an approval token → `APPROVAL_REQUIRED`, `side_effect=NONE`.
26. **Characterization `xfail`:** `move_file(overwrite=True)` with a failing move deletes the destination first. After the fix, the destination stays intact on failure.
27. `delete_file` → goes through the Recycle port, needs a token, verifies absence. No token → refused, file intact.
28. `open_file` on `.exe/.bat/.cmd/.ps1/.lnk/.url/.msi/.js/.vbs/.hta` → refused (or SENSITIVE). On `.pdf` → opens through the port, with `verified` deferred to the viewer-window observation.
29. "Newest PDF in Downloads": a deterministic mtime order. A tie → `needs_clarification`. Matches the spec §9 example.
30. File text is returned in `untrusted_content` and never as instructions. Size and preview caps are kept.

**Shell runner** (real subprocesses on Linux with `sh` stand-ins; the policy layer is OS-neutral)

31. A timeout kills the **whole tree**: a parent that spawns a sleeping child leaves no survivors. The result is `timed_out=True` with exit code and partial stdout/stderr captured.
32. Cancel token → tree killed, `side_effect=UNKNOWN` (not "cancelled cleanly") if the command had already started.
33. A non-zero exit → `ok=False` even when stdout looks fine. Exit 0 with a failed postcondition hook → `verified=False`.
34. Output caps, decoding (UTF-8/OEM code page fallback), and secret redaction in the audit log.
35. Policy refusals: `cwd` outside scope; elevation verbs (`Start-Process -Verb RunAs`, `runas`, `sudo`, `gsudo`) → FORBIDDEN without the supervised approval path.
36. Interpreter discovery: `pwsh` → `powershell.exe` → `cmd.exe`. WSL is offered only when `wsl.exe --status` succeeds (fake).

**Router and contracts**

37. Unknown tool or schema-invalid args → error, no adapter call.
38. Missing scope → `PERMISSION_REQUIRED`.
39. SENSITIVE with no token, or a token for a different `action_hash`, or an expired or reused token → refused, `side_effect=NONE`. This is the 100% negative-case enforcement test (spec §14).
40. Every call emits exactly one audit record with task/action IDs and no secrets.
41. `ToolResult` serializes to the §7 `ToolResult` JSON Schema (contract test against `packages/contracts`).

**Office (file-format libraries, OS-neutral)**

42. Create, edit and save `.docx`/`.xlsx`/`.pptx` with python-docx, openpyxl and python-pptx. Verify by reopening and asserting the content (artifact postcondition). A corrupt input file → a structured error.

**Browser (Playwright headless on Linux against local fixture pages)**

43. Navigation inside an allowlisted origin. A page with prompt-injection text → content returned as untrusted data, no tool call triggered.
44. A "Place order"/"Buy now"/checkout submit is **blocked** by a finalize-guard (role/name heuristics plus a URL pattern) → `APPROVAL_REQUIRED`.
45. No access to the user's real browser profile or cookies, ever. A dedicated context directory is asserted.

### Real Windows runner (`-m windows`; interactive desktop session, Win11 x64)

- W1. Real Explorer: open → navigate to Downloads in the **same** window, verified by `Document.Folder.Self.Path == SHGetKnownFolderPath(FOLDERID_Downloads)`. Repeat 20×, no extra windows. This is the first integrated demo (spec §12).
- W2. Known folders under redirection (Downloads moved to another drive, OneDrive KFM if available).
- W3. Navigation-pane UIA: Home/This PC/Downloads activated through patterns, including a non-en-US display language run to find localized-name breakage.
- W4. Foreground-lock behaviour for `focus_window`. Minimized, cloaked or virtual-desktop windows.
- W5. Multi-monitor and mixed DPI (100%/150%, a negative-coordinate monitor): window placement plus a fallback click landing on the intended element.
- W6. Job Object tree kill for `powershell.exe` → `cmd.exe` → `ping -t`, plus a detached grandchild. No orphans (process snapshot).
- W7. PowerShell/CMD encoding (OEM code page, UTF-8), exit codes, `$LASTEXITCODE`, execution-policy behaviour. WSL present and absent.
- W8. Recycle Bin delete plus restore verification.
- W9. App launch verification for UWP-handoff apps (Calculator, Notepad on Win11): a window appears even though `Popen.pid` exits.
- W10. Office COM automation (only if E01 approves it): Word/Excel/PowerPoint installed and absent. Visible-interaction cases.
- W11. Locked workstation or UAC secure desktop → tools refuse with a truthful status (no actions on a locked desktop).

---

## (e) Open questions, interfaces needed, and blocked decisions

### From E03 (Agent architecture: coordinator, approvals, cancellation)

1. **Cancellation contract.** I propose a CancelToken with `check / wait / settle` semantics passed through `ToolContext`, plus a deadline. Questions:
   - What does E03 want back on cancel: `side_effect` + `observed_state` + `stopStatus`?
   - Is "stop task" a hard tree kill for shell commands, or graceful-then-hard with a grace period?
2. **Approval token shape.** Bound to `action_hash` from `ActionPreview`, single-use, with expiry. Questions:
   - Who mints and verifies it (E03 or E08)?
   - Is it passed to the worker, or does the router check it in Electron main before forwarding?
3. **Clarification loop.** How should `needs_clarification` (two candidate files, two windows) go back to Codex and the user: as a tool result Codex re-asks about, or as a coordinator-level prompt?
4. **Session state.** Is per-thread state (tracked Explorer hwnd, recent listings) owned by the worker keyed by `thread_id`, or persisted by the coordinator (SQLite) for crash recovery?
5. **Coreference.** Confirm that Bot's `resolve_reference` ("that file", "the second PDF") is **not** ported, and that Codex's thread context is the only resolver.
6. **Concurrency.** One task at a time, or parallel tools? Desktop input and Explorer need a global input lock. Files and shell could run in parallel.

### From E11 (Computer-use reliability: verification, fallback, multi-monitor)

7. **Verifier split.** Do adapters return a self-verification (`verified`, `verification` method) *and* an `observe()` hook that E11's verifier calls independently, or only observations? I propose both, with E11's verdict authoritative.
8. **Fallback escalation policy** (UIA → app API → browser → coordinates). Questions:
   - Is the router (E11 policy) or Codex responsible for choosing the next tier?
   - Does stepping down to coordinates need user consent?
9. **Window-adoption rule.** May Dottie navigate the user's foreground or only Explorer window (Bot's `_target()`), or only a window Dottie opened, or ask? This affects the first demo.
10. **Postcondition catalogue.** Questions:
    - Who owns the per-workflow postcondition definitions?
    - What does "PDF opened in preferred viewer" mean exactly (window title contains the filename, a process holding a file handle, or UIA document name)?
11. **Locale and DPI test matrix.** Which display languages and DPI combinations are in scope for v1?
12. **Screenshots.** Are they allowed as an observation source for the verifier? If so: retention, redaction, and do they go to the model?

### Decisions blocked on E01 (Lead Engineer), with E08 where noted

13. **Language/runtime ADR**: a Python tool worker (reuse Bot) or a TS port (one runtime, but pywinauto has no TS equivalent, so UIA would need an addon or a sidecar). Python packaging also needs a decision: embedded CPython or PyInstaller, code signing, and supervision.
14. **Tool hosting**: App Server client-side dynamic tools (`item/tool/call`) or an MCP stdio server registered with Codex. Also, what is the stability status of each in the pinned release?
15. **Shell: our adapter or Codex's built-in exec.** Codex already runs commands with its own Windows sandbox and `item/commandExecution/requestApproval`. Running both is the "unsupported dual control path" spec §2 warns against. The audit says "build new (or rely on Codex's own sandboxed exec)", while spec §3.6/§11 assign the shell to E04. **This conflict needs a decision.** Options: disable Codex's exec and route through ours, or keep Codex exec and have E04 only supply policy, process-tree supervision and postconditions.
16. **Scope defaults** (E08): which workspace roots are granted at onboarding, the final read deny list (AppData, `.codex`, `.ssh`, browser profiles), whether the clipboard read is allowed in v1, and whether `open_file` on executables is FORBIDDEN or SENSITIVE.
17. **Office path**: file-format libraries only for v1, or also COM automation (needs Office installed, licensing/visible-UI behaviour)?
18. **Browser profile policy** (E08): a dedicated Dottie Playwright profile only (my proposal), or user-profile reuse for logged-in sites? That second option touches the "no credential scraping" rule. Also, where do browser binaries come from (licensing per spec §5)?
19. **Import mechanics for Bot code**: import with history (`git subtree`/filter-repo) into the new monorepo, or copy with an attribution header? Also, which ticket IDs and evidence paths should E04 use? (`docs/contracts/tools.md` does not exist yet.)
20. **Defaults**: a bare-name `create_file`/`create_folder` going to the **Desktop** (Bot's behaviour) is a product decision.

### Spec/audit conflicts and gaps found

- **Shell ownership** (spec §3.6/§11 vs audit "or rely on Codex's own exec"). See item 15.
- **"Known-folder APIs"** (spec §11) vs the audit crediting Bot with "known folders". Bot reads the `User Shell Folders` registry key, not `SHGetKnownFolderPath`. It is a rewrite, not a reuse.
- **Protected-path guards**: the audit lists Bot's `is_protected/ensure_mutable` as policy reuse. They cover only system dirs and known-folder roots, not credential stores, and reads are unguarded.
- **"Same Explorer window"** (spec §11): Bot's `open_folder`, `_reveal_search` and `_open_initial` all spawn new Explorer windows.
- **Fallback order** (spec §11): Bot exposes coordinate, keyboard and clipboard tools as equal first-class tools next to UIA, with no ordering.
- **Branch note**: the audit points at `fix/unexpected-session-exit` for the newest tool work, but that branch changes only `session_tools.py`. `desktop_tools.py` and `file_tools.py` are the same as on `main`.

---

## Next steps (once E01 decides items 13–15; all reversible)

1. Draft `docs/contracts/tools.md` (the interface above) for E01, E03, E08 and E11 to review.
2. Scaffold `packages/tools` with the port seam, the lifted Bot code (with attribution) and fakes. No behaviour change.
3. Land characterization tests 1–30 (with `xfail` where Bot is wrong), then fix in this order: scope/deny list → Explorer verification → UIA ambiguity → file mutation semantics → shell runner.
4. Ask E07 for a Windows 11 interactive runner for W1–W11. W1 is the first-demo gate.
