# E04: Windows tool adapters (`packages/tools`): assessment and test-first plan, v2.2

- Owner: E04 (Windows Integration Specialist). v2 prepared Mon 2026-10-19 00:36–01:30 CDT (UTC-5). v1 (Sun 2026-10-18) is kept verbatim at `docs/history/e04-tools-plan.v1-2026-10-18.md`. ADR-0008 and ADR-0012 cite v1 line numbers, so those citations point at that file.
- **v2 approved by E01 (2026-10-19)** on the basis of the CONTRACTS §5 "E04 review" rulings. v2.1 (Mon 2026-10-19 ~00:46–01:05 CDT) applies those rulings, the processStartTime and §3.3 wire-encoding amendments, and ADR-0009 CR2/3/6. **v2.2 (Mon 2026-10-19 ~01:15 CDT)** applies: E08's `navigate` category (co-signed), `pid` as a decimal string, and decisions **C1–C7** agreed with E03 on the control channel (E03's DOT-092 DRAFT 1 `tool-host-control.md`, §10; not yet on `main`). Draft tool schema: `docs/contracts/tools.md` (Draft 3). Host-positions memo for E03: `docs/contracts/tool-host-control.e04-host-positions.md`.
- Status: **plan only.** No Bot code has been copied or imported (that waits for Gopi's OK and the repo, Q7/DOT-003). Nothing has been pushed and nobody has been messaged.
- Contract-level scaffolding with Windows mocked lives in `packages/tools/` (see (d)); moved from the shared `/workspace/dottie/e04-scratch` into this worktree (`feature/E04-start`) on 2026-10-19. The shared scratch copy is left in place and is no longer updated. **Linux results never prove Windows behaviour.**
- Aligned to:
  - `docs/architecture.md` v0.1 and `docs/contracts/CONTRACTS.md` **v2** (ADR-0012, Accepted 2026-10-19);
  - ADR-0001…0016, `docs/backlog.md`, `docs/week1-go-no-go.md`, `docs/triage/TRIAGE-2026-10-18.md`, `docs/risks.md`;
  - E11's `docs/verifier-design.md` and `src/verifier/` (183 tests pass on the box, run 2026-10-19 ~01:00 CDT).
- Skills followed: `e04-windows-bot-characterization-tests` (DOT-030 method), `e04-windows-mcp-tool-server-desktop-spike` (W1-S2/DOT-031), `e04-windows-scoped-path-resolver` (file tools, DOT-069), `e04-windows-shell-runner-tree-cancel` (its "decide first" gate applies, because ADR-0016 is undecided), plus the shared `dottie-uia-tool-verifier-recipe`. Skill text that conflicts with CONTRACTS v2 is listed in (e) §E.

## What changed from v1

1. **Vocabulary moved to CONTRACTS v2 (DOT-065):**
   - `success` is removed; the result is `{verified, observedState, sideEffect, error?, evidenceRef?}`;
   - error codes come from the §5 list;
   - `SideEffect` is `none | committed | unknown`;
   - RiskClass maps to severity plus category (table in (c));
   - "needs_clarification" is replaced by `AMBIGUOUS` + `observedState.question` + `candidates`.
2. **Hosting:** the v1 preference for dynamic tools is withdrawn. ADR-0008 applies (MCP stdio, decided by W1-S2), because `dynamicTools` exists only in the `--experimental` 0.163.0 schema.
3. **Shell:** ADR-0016 applies. Codex exec is the default single path, and DOT-033/tests 31–36 are **blocked** until W1-S1.
4. **Language:** ADR-0006 applies (Python MCP worker, embedded runtime).
5. **New requirement (E11 via E01):** `explorer.open_known_folder` honours `targetId`. The design and 18 failing-first tests are in (d). They run in the scratch dir: **25 passed, 4 strict-xfailed** against a clean-room reference and a Bot *behaviour model*.
6. **DOT-030/031 acceptance criteria** are summarised, and the plan is folded into them ((d) §1).
7. **Bot pin** is `main` 504da3e (DOT-030; identical tool files to 5268c8d). Added E11's tab finding: Bot navigates and verifies the first IShellWindows entry per HWND, which may be a background tab.
8. **Deny list** now cites ADR-0014/DOT-069 (`%LOCALAPPDATA%\Dottie\**` incl. `codex\`, legacy `%APPDATA%\Dottie\**`, `%USERPROFILE%\.codex\*`, with 8.3, `\\?\`, junction and case variants).
9. A list of **shared-interface / contract changes that need E01 sign-off** is in (e) §D.

### v2.1 (E01 rulings 1–9 + amendments, 2026-10-19)
10. The rulings are marked **decided** ((e) §B), and the resolved questions are removed from (e) §A.
11. Window identity is four-field (`processStartTime`) with the §3.3 wire encoding. A shared registry API sketch is in `packages/tools/src/dottie_tools/targets/`.
12. Window-gone codes are now `NOT_FOUND` / `PRECONDITION_FAILED` / `POSTCONDITION_UNKNOWN`. Malformed → `INVALID_ARGUMENT`.
13. Approval binding and the tool-server token (ADR-0009 CR2/3/6). Navigation is classified as mutating (open, (e) §A1).
14. ADR-0017 is noted (recovery reuse: restore/focus/move-to-monitor only); not built.
15. Scratch suite: **192 passed, 4 xfailed**.
16. Secret sweep: the PC hostname is replaced by `<test-pc>`, and the Codex credential file path by `<codex-credential-file>`.

## Status of my v1 open questions

| v1 question | Status | Where it is answered | What is still open (owner) |
|---|---|---|---|
| Shell ownership (our runner vs Codex exec) | **Default decided, evidence pending** | ADR-0016 (Proposed): Codex sandboxed exec is the only V1 shell path. The E04 runner is built only if W1-S1 shows Codex exec can't meet spec §11, and then Codex shell is disabled. Both together is forbidden. DOT-033 blocked | The W1-S1 result on <test-pc> (E02 + E04; E01 decides). Which 0.163.0 config switch disables Codex exec is UNVERIFIED (E02) |
| Python vs TS | **Answered (Proposed)** | ADR-0006: wrap Bot tool *functions* as a Python MCP stdio server with an embedded, signed Python. No TS port in weeks 1–5 | Bundle size (PO, Q11). Licence inventory for pywin32/pywinauto/pyautogui/mss/pycaw (E01, DOT-009) |
| Client tool calls (`item/tool/call`) vs MCP | **Rule decided, outcome pending** | ADR-0008 (Proposed): MCP stdio `dottie-tools` in Dottie's CODEX_HOME. Dynamic tools need `experimentalApi:true` (stable schema lacks `dynamicTools`). W1-S2 runs both hosts, and MCP wins if both pass | W1-S2 desktop-reach evidence (E02 + E04 + E11, DOT-005). How MCP tool approvals surface for a local stdio server (E02) |
| Approval token shape | **Decided** | ADR-0009 CR2 (`actionId` composition incl. the four-field window identity), CR3 (`secure_ui` click only), CR5, CR6 (single-use K8 token re-checked by the tool server → `DENIED_BY_POLICY`); E01 ruling 8 | Token format and control-channel messages (E08 + E03, with ADR-0008); canonical-JSON test vector (E08) |
| Cancellation contract | **Partly answered** | CONTRACTS §2.1: `CodexPort.cancel` → `turn/interrupt` + tool-process cancel, `stopped:true` only when observed. §3 single `stopStatus` enum. §5: cancel = `decision:'stop'` + `CANCELLED`; `retryable` only when `sideEffect:'none'`. DOT-041 | How cancel reaches an *in-flight MCP tool call* (MCP `notifications/cancelled`? process kill?). UNVERIFIED in 0.163.0 (E02). The tool-host cancel token API (E04 + E03) |
| Window adoption | **Answered** | TRIAGE P9 (accepted): foreground Explorer, or the single Explorer; >1 → `AMBIGUOUS`; never by title. DOT-031 AC: two candidates → `AMBIGUOUS` + question, no action. Plus `targetId` (CONTRACTS §5) | Active tab vs new tab (verifier-design §13.3 assumes active tab; E11/PO). Is foreground part of "displays Downloads" (§13.1; PO) |
| Verifier ownership | **Decided** | CONTRACTS §2.3/§5 as before; E01 ruling 3: one shared registry in `packages/tools` (E04 owner, E11 reviewer). The internal pinned API takes a §3.3 wire identity | Same-process re-creation gap (E04 + E11) |
| No-read list | **Partly answered** | ADR-0014 + DOT-069 (E08 accountable): `%LOCALAPPDATA%\Dottie\**` (incl. `codex\`), legacy `%APPDATA%\Dottie\**`, `%USERPROFILE%\.codex\*`, through 8.3 names, `\\?\`, junctions and case variants → `DENIED_BY_POLICY` | My wider list (all of `%APPDATA%`/`%LOCALAPPDATA%`, `~\.ssh`, browser profiles, Credential Manager vault), clipboard read in V1, and `open_file` on executables (DENIED_BY_POLICY vs approval). All E08 |
| Clarification loop | **Decided** | §5 ask path + `targetId`; E01 ruling 2: same `taskId`, new turn | — |
| Concurrency | **Answered** | DOT-013 AC: desktop-interaction lock, so two GUI-acting tasks never run at once | — |
| Fallback escalation / screenshots | **Assigned** | DOT-077 (E11 accountable, E04): strategy order shell COM → UIA → screenshot; a screenshot never declares `verified` | ADR not written yet (E11) |
| Browser profile | **Assigned to me** | DOT-078 (E04 accountable, E08 review) | My ADR (week 3) |
| Coreference (`resolve_reference`) not ported | Not addressed | — | E03 to confirm |
| Office COM vs file libraries | Not addressed | DOT-035 says "file-format libraries first" | E01 |
| Bot import mechanics | **Conflicting texts** | ADR-0011 and DOT-030: "imported with history". The skill says "default to copy with header" | E01 + Gopi (waiting on Gopi's OK and Q7) |
| Bare-name create → Desktop | Not addressed | — | PO/E08 |

---

## (a) What the spec, audit and arch docs require of E04

The v1 list R1–R16 still holds. The arch docs pin these down:

| # | Requirement | Source |
|---|---|---|
| R1 | Default-deny scopes. The policy is enforced in code at K8 **and again inside each tool server**; the tool server treats every Codex-chosen argument as untrusted (TB7) | spec §10; ADR-0009; ARCH §6 TB7 |
| R2–R4 | UIA first, windows by **HWND + process + class**, PMv2 DPI, multi-monitor | spec §11; verifier-design §3; W1-S2 checks 1–5 |
| R5 | Explorer: verified only when the **IShellWindows active-tab `Folder.Self.Path` (final-path compare) == `SHGetKnownFolderPath(FOLDERID_*)`**. The UIA address bar is a fallback only, and the title is never used | DOT-031 AC; TRIAGE P8 |
| R5b | **`targetId` (new):** a tool that returned `candidates` accepts an optional opaque `targetId` issued earlier in the same task. Unknown or stale → `NOT_FOUND`, never guessed; verification is pinned to that window | CONTRACTS §5 "Candidate selection"; E11 via E01 |
| R6 | Files: as v1, plus the DOT-069 deny list and DOT-032 (model-supplied `overwrite` is not consent; Recycle Bin or approval; gate `close_window`/`type_text`/`hotkey`/clipboard/`move_file`) | DOT-032, DOT-069 |
| R7 | Shell: **one path** (ADR-0016). The E04 runner exists only if W1-S1 fails Codex exec | ADR-0016; DOT-033 |
| R8 | Browser: isolated profile decision in my DOT-078 ADR; DOT-034 "navigation visible, no credential autofill" | DOT-034, DOT-078 |
| R9 | Office: file-format libraries first; the output artifact is verified | DOT-035 |
| R11 | Result contract v2: one truth field `verified`; MCP `isError = !verified`; `error` ⇔ `verified:false`; `retryable` only when `sideEffect:'none'`; `observedState` holds no titles, file contents or full user paths | CONTRACTS §5; ADR-0012 §8 |
| R12 | Honest cancellation: `sideEffect` is `unknown` whenever something may have happened; a cancel is `stop` + `CANCELLED` | CONTRACTS §3, §5 |
| R14 | Release blockers include incorrect-window action (RB-03) and credential reads (RB-01) | spec §14; RISKS R4 |
| R16 | Tool ids are namespaced `area.verb_object`; the first is `explorer.open_known_folder{folder}` | CONTRACTS §5; TRIAGE P10 |

## (b) Bot code: reuse vs rewrite (unchanged from v1 except where marked; Bot pin is now `main` 504da3e per DOT-030)

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
4. **Results don't record side effects.** Results are missing `sideEffect` (v2: `none | committed | unknown`, CONTRACTS §5). Spec §14 needs this to report cancellation honestly.
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

### v2 additions to (b)

- **`open_downloads` / `navigate_shell` ignore any target window** (E11 via E01).
  - `DesktopTools.open_downloads()` takes no parameters. Through `registry.execute_tool`, an extra `targetId`/`hwnd` makes `signature.bind` raise, and the call fails with a stringified `TypeError`. A host that strips unknown args silently navigates the tracked/foreground/single window instead.
  - Neither result is acceptable under CONTRACTS §5. This is pinned as strict xfail in the scratch characterization (`test_bot_honours_pinned_window`).
- **Tabs** (verifier-design §12.2). `_windows()` yields one entry per tab with the same HWND. Both `navigate_shell` and its verify loop accept the first matching entry for the HWND, so Bot can navigate a background tab, and it can "verify" because *any* tab of that HWND shows the folder. The rewrite must address the **active tab** only (`IShellBrowser` / `ShellTabWindowClass` match, as E11 implements).
- **Bot's `hwnd` in results** is the only identity it reports. E11's verifier accepts a tool-reported HWND as an identification source (`identify_target` → `tool_reported_hwnd`). That is fine **inside** the tool host, but it must never appear in MCP `observedState` (CONTRACTS §5) and must never be accepted from the model.

---

## (c) `packages/tools` layout and adapter interface (aligned to ADRs and CONTRACTS v2)

### Hosting and language (now from the ADRs, not my preference)
- ADR-0006: a Python worker, `dottie_tools`, with an embedded and signed Python. ADR-0008: MCP stdio server `dottie-tools`, registered in Dottie's `%LOCALAPPDATA%\Dottie\codex\config.toml` (ADR-0014). It is a child of app-server (ARCH §4).
- Plan B, if W1-S2 shows the MCP child can't reach the desktop: dynamic tools executed by Electron main, with an ADR-0001 amendment for `experimentalApi:true`.
- The adapter code is host-agnostic either way. Only `server.py` differs.
- **E11's verifier runs in the same process** (ARCH K10; verifier-design §2). The adapter returns an *internal* result, the verifier observes, and `server.py` turns the `VerificationResult` into MCP `structuredContent`.

### Layout (unchanged from v1 except as noted)
- `dottie_tools/{contracts.py, adapter.py, router.py, server.py}`
- `runtime/{cancel,wait,clock,redact}.py`
- `platform/{ports.py, win32/, fakes/}` is the only place Windows APIs are imported.
- `scope/{paths,denylist}.py`
- `adapters/{windows,explorer,files,apps,shell*,browser,office,input}/`. `shell` stays empty until ADR-0016 decides.
- **New: `targets/registry.py`**: the one shared window registry (E01 ruling 3; owner E04, reviewer E11). It replaces E11's interim `CandidateRegistry`/`LocalWindowRegistry`, and both the adapters and the verifier use the same instance. API sketch: `packages/tools/src/dottie_tools/targets/`, and tools.md §7.
- `tests/{unit,contract,fakes,windows}`.

### Vocabulary mapping (DOT-065; E08 to review the RiskClass row)

| E04 catalog field (v1) | CONTRACTS v2 |
|---|---|
| RiskClass `read` | severity floor `low`, category `read` |
| RiskClass `reversible` | `medium`, category `local_change` |
| RiskClass `sensitive` | `high`, category set per tool: `delete` (delete_file), `overwrite` (write/copy/move with overwrite), `install_or_elevate`, `security_setting`, `external_send`/`external_upload`, `purchase` (→ `critical`). Every spec §10 "always confirm" category needs approval regardless of severity |
| RiskClass `forbidden` | no ApprovalRequested; `DENIED_BY_POLICY` (e.g. `credential_access`, deny-listed reads) |
| v1 error `NEEDS_APPROVAL` | `APPROVAL_REQUIRED` |
| v1 side effect `ATTEMPTED` | `unknown` (the enum value is removed) |
| v1 `needs_clarification` | `error.code:'AMBIGUOUS'` + `observedState.question` + `candidates[{id,label}]` |
| v1 `ok` / `success` | removed; `verified` is the only truth field; MCP `isError = !verified` |
| v1 `untrusted_content` | **dropped (E01 ruling 9).** Untrusted text goes only in MCP `content` blocks under E08's fixed header, never in `structuredContent` 

### Adapter interface (revised draft; E01 to freeze in `docs/contracts/tools.md`)

```python
SideEffect = Literal["none", "committed", "unknown"]
ErrorCode = Literal["DENIED_BY_POLICY", "PERMISSION_REQUIRED", "APPROVAL_REQUIRED", "AMBIGUOUS", "NOT_FOUND",
                    "TIMEOUT", "PRECONDITION_FAILED", "POSTCONDITION_FAILED", "POSTCONDITION_UNKNOWN",
                    "CANCELLED", "USER_DECLINED", "INVALID_ARGUMENT", "INTERNAL"]

@dataclass(frozen=True)
class ToolSpec:            # catalog entry
    tool_id: str           # "explorer.open_known_folder"
    input_schema: dict     # JSON Schema; public args only (never raw HWNDs)
    scopes: frozenset[str] # {"desktop.control"}
    severity_floor: Literal["low", "medium", "high", "critical"]
    category: str          # CONTRACTS §3 category; required per tool, missing = treated as mutating (memo Q4)
    mutating: bool; idempotent: bool; default_timeout_s: float

@dataclass(frozen=True)
class ToolContext:
    host: HostContext                                    # task/thread/turn/item/request ids from the control channel (ruling 1)
    granted_scopes: frozenset[str]; workspace_paths: tuple[str, ...]
    cancel: CancelToken; deadline: float; clock: Clock; audit: AuditSink
    targets: WindowRegistry                              # shared four-field registry (ruling 3)
    approval_token: str | None                           # from the control channel; consumed with K8 right before dispatch (CR6)

class Adapter(Protocol):
    def specs(self) -> list[ToolSpec]: ...
    def preview(self, tool_id, args, ctx) -> ActionPreview: ...   # resolves targets (incl. targetId) with no side effect;
                                                                  # action_hash = hash(tool, resolved args, target identity) = ApprovalRequested.actionId
    def execute(self, preview, ctx) -> InternalResult: ...         # acts on preview.target only; internal result may carry hwnd/tab
    def observe(self, preview, ctx) -> dict: ...                   # pinned observation for E11's verifier
# server.py: VerificationResult (E11) -> MCP structuredContent {verified, observedState, sideEffect, error?, evidenceRef?}
```

Router rules (v2 codes):
1. Unknown tool → `INTERNAL`. Schema-invalid or malformed args (including extra keys such as a model-supplied `taskId`) → `INVALID_ARGUMENT` (ruling 5). Both report `sideEffect:none`, with no adapter call.
2. Missing scope → `PERMISSION_REQUIRED`.
3. A category that needs approval with no valid approval for this `action_hash` → `APPROVAL_REQUIRED`.
4. A declined approval → `USER_DECLINED`, never re-invoked.
5. Forbidden → `DENIED_BY_POLICY`.
6. One audit record per call. Adapters never prompt.

---

## (d) DOT-030 / DOT-031 plan with the `targetId` requirement

### 1. Backlog acceptance criteria (verbatim intent from `docs/backlog.md`)

**DOT-030** (E04 + E07): characterization tests for the Bot tools. Depends on DOT-003 (monorepo).
- Pin Bot `main` 504da3e. The two files are identical to 5268c8d.
- The code is **imported with history** and the source repo is left unmodified.
- Tests cover the navigate/open/list/move/delete paths, **including `is_protected`** (`file_tools.py:174-211`).
- `git -C src/Bot diff --quiet 504da3e 5268c8d -- tools/desktop_tools.py tools/file_tools.py` **exits 0 at import time**.

**DOT-031 ★** (E04 + E11): the `dottie-tools` server (host per ADR-0008) exposes the allowlisted tools with the v2 result. The first tool is `explorer.open_known_folder{folder}`. Depends on DOT-005 (W1-S2), DOT-030, DOT-014 (policy gate), DOT-007 (contracts package).
- A Codex turn → tool call → **verified only when the IShellWindows active-tab `Folder.Self.Path` (final-path compare) equals `SHGetKnownFolderPath(FOLDERID_Downloads)`**.
- The UIA address bar is a fallback only. Never verified by window title.
- **Two candidate windows → `AMBIGUOUS` + `observedState.question`, no action.**
- `verified:false` is surfaced as not-success.
- **Runs on <test-pc>.**

Related ACs that bind these tickets:
- DOT-032: every mutating tool without a valid approval → `APPROVAL_REQUIRED` (AC corrected by E01, ruling 6). Per ADR-0009 CR6, a mutating call whose K8 token is missing, reused or bound to another `actionId` → `DENIED_BY_POLICY` at the tool server.
- DOT-069: the deny-list tests.
- DOT-064: E11 emits v2.

Blocked status today:
- **DOT-030** is blocked on DOT-003 (repo, Q7) and Gopi's OK to import.
- **DOT-031** is blocked on DOT-030, DOT-005 (W1-S2 on the PC, after Windows Update to ≥ 26200.9278 for the MXC cells), DOT-014 and DOT-007.
- The scratch work below is contract-level only and does not move either ticket's AC.

### 2. Plan folded into DOT-030 → DOT-031
1. **DOT-030 (on import approval):**
   - Lift `desktop_tools.py`/`file_tools.py` @ 504da3e with history (or with an attribution header if E01 rules otherwise, (e) §E).
   - Add the platform-port seam with zero behaviour change.
   - Land tests 1–30 (below) with strict xfails for the known-bad behaviour.
   - **Add the Bot targeting characterization** (scratch `test_bot_model_characterization.py`, now re-pointed at the real lifted code): rejects or ignores `targetId`, navigates a background tab, substring false-verify, two unfocused → error text instead of `AMBIGUOUS`.
   - Add the CI check for the `git diff --quiet` AC.
2. **DOT-031 (after W1-S2 picks the host):**
   - Implement `explorer.open_known_folder{folder, targetId?}` per the design below.
   - Port the scratch TID/CTX/NOID/PIN/APH/APR/TOK tests and the registry tests (already in `packages/tools/tests/`) verbatim against the real adapter with fakes.
   - Flip the four Bot xfails to pass.
   - Run W1 (20× same-window navigation) plus the new **W12** below on <test-pc>.
   - Evidence goes to `docs/evidence/tickets/DOT-031/<YYYYMMDD>-<shortsha>/`.

### 3. `targetId` design for `explorer.open_known_folder` (decided; E01 rulings 2026-10-19)

The normative text is the draft **`docs/contracts/tools.md`**, ready for a PR to `docs/contracts/tools.md` once the repo exists. Summary:

- **Public schema:** `{folder: downloads|documents|desktop|pictures|music|videos, targetId?: "^c_[0-9a-f]{12}$" | null}`, `additionalProperties:false`.
  - Context (`taskId`, `turnId`, `threadId`), window handles, identity and tokens are **never** public arguments.
  - Sending any of them is schema-invalid → `INVALID_ARGUMENT` (ruling 1, ruling 5).
- **Host context:** `HostContext{taskId, threadId, turnId, itemId?, requestId?}` comes from the coordinator control channel (`authorizeToolCall`, single active task). If it's missing (no active turn, stop requested, channel down) → **`PRECONDITION_FAILED`** (decision C1; was `INTERNAL`), and nothing runs.
- **Clarification answer:** the same `taskId` and a new turn (ruling 2), so ids issued in turn N resolve in turn N+1.
- **`targetId` lifetime (decision C3):** valid until `endTask(taskId)` across every turn of the task; superseded per window (the same window re-registered under a new id kills only its old id; REG-05c); the 300 s TTL is replaced by a **30-min safety cap** (proposal) that reports `NOT_FOUND`.
- **Shared registry** (ruling 3 + amendment), owned by E04 with E11 as reviewer, sketched in `packages/tools/src/dottie_tools/targets/`:
  - entries are `WindowIdentity{hwnd, pid, windowClass, processStartTime}`;
  - a mismatch on any field = closed;
  - any field unreadable = no identity, which can't be offered, targeted or acted on (`NOT_FOUND` at lookup).
- **Wire encoding** (CONTRACTS §3.3 + E01 steering):
  - `hwnd`, `pid` (≤ 2^32−1) and `processStartTime` (FILETIME, 100-ns ticks since 1601 UTC) are canonical unsigned decimal **strings** (`^[1-9][0-9]*$`), `"0"` invalid (CONTRACTS §3.3; decision C2);
  - ints internally;
  - a parse failure where an identity is input → `INVALID_ARGUMENT`.
- **Window-gone codes** (ruling 4; §5 also says "closed targetId → NOT_FOUND"):

  | When the window is closed / changed / unidentifiable | Code | `sideEffect` |
  |---|---|---|
  | at lookup (`targetId` resolution, or the adopted window) | `NOT_FOUND` | `none` |
  | after lookup, before the action is sent (re-checked right before dispatch, R23) | `PRECONDITION_FAILED` | `none` |
  | after the action is sent | `POSTCONDITION_UNKNOWN` | `unknown` |

  None of these is retryable, and none falls back to another window or relaunches.
- **Malformed vs unknown:** a malformed `targetId` → `INVALID_ARGUMENT`. A well-formed but unknown, cross-task, ended-task, superseded, past-the-cap or closed one → `NOT_FOUND` (ruling 5, C3).
- **Verification is pinned:** only the target window's active tab, 2 consecutive samples, identity unchanged at every sample. Another window or a background tab never counts. This holds with or without `targetId`. Deadline → `POSTCONDITION_FAILED`, `unknown`.
- **No `targetId`:** the TRIAGE P9 rule is unchanged (foreground → single → launch one → one already at the folder → else `AMBIGUOUS` with registry-issued candidates). Unidentifiable windows are never candidates.
- **Internal pinned API:** E11's verifier calls the adapter with a §3.3 wire identity (`pinned=`), never a bare HWND. Malformed → `INVALID_ARGUMENT`; closed/changed → `NOT_FOUND`; combining it with `targetId` → `INVALID_ARGUMENT`.
- **Classification (decided; E08 co-signed, CONTRACTS §3, ADR-0009 item 8 `navigate` exception):** category **`navigate`** (no confirm), scope `files.navigate`, severity `low`. No dialog and no K8 token. Conditions, all in tools.md §2.2 and tested in `test_navigate_policy.py`: enum-only `folder` resolved server-side; no path/subpath/`/select`/verbs; fixed Explorer argv; UNC/network, reparse point outside the profile or missing folder → `DENIED_BY_POLICY` `known_folder_redirected` with no confirm fallback (OneDrive-local allowed); denied when locked, after panic-stop or mute; grants nothing for later actions; audit holds category, folder and decision only.
- **Approval binding** (ruling 8, ADR-0009 CR2): `actionId = SHA-256(canonical {method, resolved args, targets.window = wire identity | null, taskId, threadId, turnId, itemId, requestId})`. Any identity field change, including `processStartTime` alone, gives a new `actionId`.
- **Mutating desktop tools: tool-server token** (ADR-0009 CR6, DOT-031/032; tool-host-control §4.4–4.5), in this order: preview → `actionId` → in-call `requestApproval` → K8 `ApprovalRequested` → `secure_ui` click → K8 mints a token bound to **`taskId` + `toolId` + `actionId`** (decision C5, **not** `turnId`), single use, TTL `min(approval, mint + 10 s)` (P18 proposal) → immediately before the Win32 call the server re-checks identity, recomputes `actionId` and consumes the token.
  - Missing, reused, unknown, expired, revoked, or for another task/tool/`actionId` (other window or args) → `DENIED_BY_POLICY`, and nothing is sent. A token revoked **by a task cancel** → `CANCELLED`, `none` (C7).
  - `ApprovalResolution.decision` uses the CONTRACTS §3.2 enum (C6): `declined` → `USER_DECLINED`; `expired`, `revoked` (task live) → `APPROVAL_REQUIRED`; `cancelled` or `revoked/task_cancel` → `CANCELLED`; `denied_by_policy` → `DENIED_BY_POLICY` (DOT-032 AC corrected, ruling 6).
  - A call re-issued in a later turn of the same task carries the approved binding's ids with the token, so the recomputed `actionId` still matches (TOK-09).
- **Untrusted content** (ruling 9): never in `structuredContent`. It goes only in MCP content blocks under E08's fixed header (a placeholder until E08 defines it). This tool emits none.
- **ADR-0017 (Proposed, E08):** verifier recovery may reuse a `desktop.control` approval **only** for restore, focus and move-to-monitor, through a single-use, window-bound K8 recovery token. Shell-navigate is explicitly excluded, so a re-navigation by the verifier needs a new approval. **Noted only, not built** in the scratch.

### 4. Failing-first tests (scratch; Windows mocked)

**Run on the box (2026-10-19 ~01:15 CDT):** `cd packages/tools && python3 -m pytest` → **304 passed, 4 xfailed** (308 collected).

| File | Result |
|---|---|
| `packages/tools/tests/targets/test_window_registry.py` | 135 passed |
| `tests/test_open_known_folder_target_id.py` | 74 passed |
| `tests/test_navigate_policy.py` | 45 passed |
| `tests/test_approval_binding.py` | 41 passed |
| `tests/test_catalog.py` | 8 passed (Q-E04-4 proposal: explicit category, missing → mutating) |
| `tests/test_bot_model_characterization.py` | 1 passed + 4 strict xfail (Bot behaviour model, not Bot code) |

| ID | Case | Expected |
|---|---|---|
| TID-01 | well-formed unknown `targetId` | `NOT_FOUND`, `none`, untouched |
| TID-01m | malformed `targetId` (`""`, wrong prefix/case/length, int, list, dict, bool) | `INVALID_ARGUMENT`, untouched |
| TID-01b | cross-task, superseded, past the 30-min cap, after `endTask` | `NOT_FOUND` |
| TID-01e | id survives turns t1→t2→t3 through an `AMBIGUOUS` round-trip, 6 + 10 min apart (C3) | resolves each turn |
| TID-01c | missing host context (none / empty task / empty turn) | `PRECONDITION_FAILED`, untouched (C1) |
| TID-01d | unknown or path-like `folder`, missing args, non-object args | `INVALID_ARGUMENT` |
| CTX-01 | model-supplied `taskId`/`turnId`/`threadId`/`hwnd`/`pid` arg (incl. trying to use another task's id) | `INVALID_ARGUMENT`, untouched |
| CTX-01d | spelling variants (`task_id`, `TaskID`, `turn-id`, …; P9 proposal) | `INVALID_ARGUMENT`, names only logged |
| CTX-02 | answer in the next turn of the same task | resolves, navigates only the chosen window |
| CTX-03 | same thread, different task | `NOT_FOUND` |
| TID-02/02b/02c | known id → only that window, despite another foreground window, active tab only | verified, committed |
| TID-03/03b/03c | decoy window or background tab reaches Downloads | not verified (`POSTCONDITION_FAILED`, `unknown`) |
| TID-04 | target closed before the call | `NOT_FOUND` |
| TID-04a | target closed after lookup, before send (pinned and adopted) | `PRECONDITION_FAILED`, `none`, token not spent |
| TID-04b | closed after send | `POSTCONDITION_UNKNOWN`, `unknown`, no relaunch |
| TID-04c | HWND reused with a new pid | `NOT_FOUND` |
| TID-04d | **same hwnd/pid/class, different processStartTime** | `NOT_FOUND` (counts as closed) |
| TID-04e/04f | processStartTime swap before / after send | `PRECONDITION_FAILED` / `POSTCONDITION_UNKNOWN` |
| NOID-01…05 | any identity field unreadable: foreground target / never a candidate / earlier id / before send / after send | `NOT_FOUND` / excluded / `NOT_FOUND` / `PRECONDITION_FAILED` / `POSTCONDITION_UNKNOWN` |
| PIN-01…04 | internal pinned identity: valid / non-canonical wire (number, padded, ISO, empty) / other start time / with `targetId` | only that window / `INVALID_ARGUMENT` / `NOT_FOUND` / `INVALID_ARGUMENT` |
| TID-05a…g | no `targetId`: foreground, single, none → one launch, two unfocused → `AMBIGUOUS` (no approval asked), one already there, pinned verification, null | as before |
| TID-06 | ask → answer round trip across turns | only the chosen window |
| APH-01/01b | `actionId` changes with each identity field; **with processStartTime alone** | different hashes |
| APH-02 | stable under key order; changes with args, window-null, task/turn/item | |
| APH-03 | the tool asks approval for the window it actually resolved | different `actionId` per window |
| APH-04 | hash input carries decimal strings; 2^60 vs 2^60+1 hash differently | |
| NAV-02…06 | `navigate`: non-enum/injected folder (path, subpath, `/select`, verb) / UNC-redirected Downloads, reparse outside profile, missing folder / OneDrive-local allowed / locked, panic-stop, mute / audit has no path | `INVALID_ARGUMENT` / `DENIED_BY_POLICY` `known_folder_redirected` / verified / `DENIED_BY_POLICY` / category+folder+decision only |
| NAV-01, TOK-10 | navigate runs with no token and no gate; grants nothing to a follow-up mutating call in the same window | verified / `APPROVAL_REQUIRED` then `DENIED_BY_POLICY` |
| MUT-01/02 | mutating, no coordinator / `secure_ui` click | `APPROVAL_REQUIRED` + `actionId` / verified, token accepted once |
| MUT-03 | §3.2 decisions: declined, expired, revoked(mute), revoked(task_cancel), cancelled(turn_ended), tray/voice, denied_by_policy | `USER_DECLINED` / `APPROVAL_REQUIRED` ×2 / `CANCELLED` ×2 / `DENIED_BY_POLICY` ×3; nothing runs, no token |
| TOK-01/02 | missing; reused token | `DENIED_BY_POLICY` (`missing`, `reused`) |
| TOK-03/03b/03c | token for another `actionId` / task / tool | `DENIED_BY_POLICY` (`wrong_action`, `task_mismatch`, `tool_mismatch`) |
| TOK-04/04b | token for a different resolved window; same hwnd with a new processStartTime | `DENIED_BY_POLICY` (`wrong_action`), both windows untouched |
| TOK-05/05b | 10 s cap; never outlives the approval | `DENIED_BY_POLICY` (`expired`) |
| TOK-06/06b | revoked by mute; revoked by task cancel | `DENIED_BY_POLICY` (`revoked`); `CANCELLED`/`none` (C7) |
| TOK-07/08 | unknown token, no K8 wired; launch path | `DENIED_BY_POLICY` (fail closed) |
| TOK-09/09b/09c | turn change in the same task with the approved ids; without them; from another task | verified (C5) / `wrong_action` / `task_mismatch` |
| WIRE-01…08 | §3.3 encoding: shape; values > 2^53 round-trip exactly; canonical form; hwnd, pid and processStartTime each reject numbers, ISO, zero-padded, `"0"`, signs, whitespace, hex, exponent, empty, non-ASCII digits, out of range; exact keys; no partial identity | |
| ID-01…05, REG-01…11 | identify/liveness/is_alive never raise; any unreadable field = no identity; image name for live identity only; registry issue/resolve/`end_task`, valid across turns, 30-min cap, thread-safety smoke | |

**Mutation checks** (each reverted afterwards; the suite is back to green):

| Mutation | Failing tests |
|---|---|
| liveness ignores processStartTime | 7 |
| hwnd emitted as a JSON number | 7 |
| lenient decimal parser | 15 |
| hash drops processStartTime | 3 |
| hash drops the window | 9 |
| server skips the token check | 10 |
| malformed id → `NOT_FOUND` | 9 |
| extra args accepted | 5 |
| closed-after-send → `POSTCONDITION_FAILED` | 2 |
| no pre-dispatch re-check | 3 |

The first three were run against the four-field/string code. Spot mutations for v2.2 (ignore the approved ids on a turn change; drop C7 at consume / at approval; revert C1; 300 s TTL) fail 1 / 1 / 2 / 1 / 3 tests. The rest were run on an earlier iteration (before the wire-encoding, `navigate` and C1–C7 changes) and have not been re-run.

**Windows case W12** (on `<test-pc>`, interactive session; add to the run sheet):
- Two Explorer windows, neither in front → `AMBIGUOUS` → answer with candidate 2 → only window 2's active tab shows Downloads. Meanwhile the operator moves window 1 to Downloads by hand, and it must not count.
- Close window 2 and reuse its id → `NOT_FOUND`.
- Restart `explorer.exe` and reuse an id → `NOT_FOUND` (real HWND/PID reuse).
- `GetProcessTimes` on an elevated Explorer → no identity → `NOT_FOUND`.
- 20 runs, with IShellWindows snapshots (no titles).

### 5. Remaining test list from v1 (vocabulary updated; full text in the v1 file)

| Tests | Area | Change in v2 |
|---|---|---|
| 1–5 | pure helpers | none |
| 6–12 | Explorer controller | superseded in part by TID/NOID/PIN. Test 11 (cancel during wait) → `CANCELLED`, `stop`, `unknown` |
| 13–15 | UIA ambiguity | `AMBIGUOUS` + candidates through the same registry |
| 16–21 | windows/input | four-field `WindowIdentity`; window tools re-check identity and the token before the Win32 call |
| 22–30 | path scope / files | test 23 + DOT-069 roots and variants. Mutating without approval → `APPROVAL_REQUIRED`; bad token → `DENIED_BY_POLICY`; decline → `USER_DECLINED` (DOT-032) |
| 31–36 | shell runner | **blocked on ADR-0016** |
| 37–41 | router / contracts | router rule 1 is now `INVALID_ARGUMENT` for schema-invalid calls |
| 42–45 | Office, browser | browser waits for my DOT-078 ADR |
| W1–W11 | Windows runner | unchanged; **W12 added** |

---

## (e) Open questions, contract status and conflicts

### A. Still-open questions (owner)
2. **The W1-S2 outcome** picks the tool host (MCP vs dynamic). E02 + E04 + E11 run it; E01 decides.
3. **The W1-S1 outcome** picks the shell path. E02 + E04 run it; E01 decides (ADR-0016).
4. **Control channel** (E03's DOT-092 draft `tool-host-control.md`, not yet on `main`; E04 positions are in `docs/contracts/tool-host-control.e04-host-positions.md`): E04 positions in the host-positions memo (P1 pipe naming/ACL, `itemId`, cancellation points, catalog category). E03 merges; E08 reviews §5; E01 signs.
5. **How cancel reaches an in-flight MCP call** in 0.163.0. E02.
6. **E08's untrusted-content header** text. E08.
7. **Canonical JSON and the test vector** for `actionId` (`packages/policy`), and the MAC byte encoding of `windowIdentity` (§3.3 says it's open). E08.
8. **Deny list beyond DOT-069**, clipboard, and executables. E08.
9. **Active tab vs new tab; must the window be in front?** E11 → PO.
10. **Same-process window re-creation gap** (verifier-design §15 item 7): a destroyed and re-created window in the same process, with the same class and a recycled HWND, has an identical four-field identity. The verifier re-observes after acting. A fix needs a per-window stamp that Windows doesn't provide cheaply. E04 + E11; E01 if the identity changes.
11. **Import mechanics and timing:** waiting on Gopi's OK and the repo (Q7). The method is settled: with history, pinned at 504da3e.
12. Coreference not ported (E03). Office COM (E01). Bare-name create → Desktop (PO/E08).

Resolved and removed from this list: navigation classification (`navigate`, E08 co-signed); missing-context code, `pid` encoding, `targetId` lifetime, token binding, decision names, cancel-revocation code (C1–C7 with E03); task identity in the tool host; same-task clarification; registry identity and ownership; closed-before/after codes; the schema-error code; DOT-032 code; the tools.md owner and schema; approval hash including the window; `untrusted_content`; the Bot pin and import method; skill conflicts (the skills are stale, and v2/DOT-030 win).

### B. E01 rulings applied (decided 2026-10-19)
| # | Ruling | Applied in |
|---|---|---|
| 1 | `taskId`/`turnId` from the control channel, never model args | `HostContext`; CTX-01; tools.md §1 |
| 2 | clarification = same `taskId`, new turn | CTX-02, TID-06 |
| 3 (+ amendments) | `{hwnd, pid, windowClass, processStartTime}`; any-field mismatch = closed; unreadable field = no identity; one shared module in `packages/tools` (E04 owner, E11 reviewer); §3.3 wire encoding | `dottie_tools/targets/`; TID-04c/d/e/f, NOID, WIRE; tools.md §6–7 |
| 4 | gone before send → `PRECONDITION_FAILED`/`none`; after → `POSTCONDITION_UNKNOWN`/`unknown` | reference steps 7/9; TID-04a/b |
| 5 | `INVALID_ARGUMENT` for schema-invalid or malformed args (incl. `targetId`); well-formed unknown → `NOT_FOUND` | TID-01/01m/01d |
| 6 | DOT-032 AC → `APPROVAL_REQUIRED` | APR-01; plan (d) §1 |
| 7 | tools.md drafted by E04, approved by E01 PR | `docs/contracts/tools.md` |
| 8 | approval hash includes the resolved window identity | APH-01…04, TOK-04/04b |
| 9 | no `untrusted_content`; MCP content blocks under E08's header | tools.md §3 |
| ADR-0009 CR2/3/6 | `actionId` composition; `secure_ui` click only; tool-server single-use token → `DENIED_BY_POLICY` | MUT/TOK; tools.md §4–5 |
| `navigate` (E08 co-sign) | no-confirm category, scope `files.navigate`, conditions 1–7 | reference steps 3–5; NAV-*; tools.md §2.2 |
| C1 | missing host context → `PRECONDITION_FAILED` | reference step 1; TID-01c; tools.md §2.6 row 1 |
| C2 | `pid` decimal string everywhere | `dottie_tools/targets/` wire form; WIRE-*; tools.md §6 |
| C3 | `targetId` valid until `endTask`; superseded per window; 30-min safety cap (proposal) → `NOT_FOUND` | `WindowRegistry.end_task`, `DEFAULT_TTL_S=1800`; REG-05/05b/06b, TID-01b/01e |
| C5 | token bound to `taskId`+`toolId`+`actionId`, single use, short TTL, not `turnId` | `FakeK8`; TOK-03c, TOK-05, TOK-09/09b/09c |
| C6 | CONTRACTS §3.2 `decision` values | `ApprovalResolution`; MUT-03 |
| C7 | cancel-caused revocation → `CANCELLED`/`none` | reference steps 8 and 10; MUT-03, TOK-06b |

### C. Conflicts still in CONTRACTS / docs (for E01)
1. **Task-cancel decision value.** CONTRACTS §3.2 maps task cancel to `decision:'revoked'`, `reason:'task_cancel'`; tool-host-control §4.4 maps it to `cancelled`/`task_cancel`. The scratch accepts both and returns `CANCELLED` either way (C7). One of the two texts should change.
2. **C5 vs CR2.** CR2 hashes `turnId`, `itemId` and `requestId` into `actionId`, so "the token survives a turn change" only works if the coordinator returns the approved binding's ids with the token and the host recomputes with them (TOK-09/09b). The alternative is to drop those ids from `actionId`, which is a CR2 change. E01/E08 decide.
3. **§3.2 has no `folder` field and no `kind`/`decision` for an allowed navigate** (scratch: `tool.navigate`/`allowed`, proposal), and no `tool_token.*` kinds (P19).
4. **§5 bullet "closed `targetId` → `NOT_FOUND`" vs "gone before send → `PRECONDITION_FAILED`"**: applied as lookup → `NOT_FOUND`, after lookup and before send → `PRECONDITION_FAILED`. E01 should state the split in §5.
5. **§5's last bullet still says `explorer.open_known_folder{folder}`**, without `targetId`.
6. **The control channel is not in §5/§3 yet** (DOT-092 DRAFT 1). It needs E01 sign-off.

### D. Shared-interface changes still needing E01 sign-off
- C2–C6 above, and the control-channel interface (DOT-092).
- The tools.md PR itself (ruling 7).
- Anything else in this plan stays inside `packages/tools`.

### E. Skills
E01 ruled the conflicting skill texts stale; CONTRACTS v2 and DOT-030 (504da3e, with history) win. These still need a `dottie-skill-maintenance` pass:
- MCP spike (`success` + title);
- uia recipe (`{success,…}`);
- characterization skill (5268c8d, copy-with-header).

## Next steps (all reversible, none started)
1. When Gopi OKs the import and DOT-003 lands: DOT-030 per (d) §2, then get E11's review of `packages/tools/src/dottie_tools/targets/` (moved into this worktree 2026-10-19), and point E11's `LocalWindowRegistry` adapter at it.
2. Open the tools.md PR once the repo exists (E01 approves).
3. Help E02 prepare the W1-S2 probe and W12 for `<test-pc>`.
4. Draft the DOT-078 browser-profile ADR (week 3).

## v2.3 (2026-10-19 ~01:55 CDT): DOT-092 DRAFT 5
- The host side of E08's DRAFT 4/5 review and the 5.1 reasons are implemented and tested (Linux, Windows mocked).
- Still open, needing Gopi's PC (`<test-pc>`):
  - H-13/K-08 real pipe peer checks;
  - SQOS;
  - the restricted-token question;
  - the K-06 lock-state source.
- Still waiting on E03/E08:
  - the review issues in `docs/contracts/tool-host-control.e04-review-draft5.md`;
  - ~~the pinned catalog's file name (D13)~~: resolved by E01 1z, `packages/contracts/tool-catalog.json`.
