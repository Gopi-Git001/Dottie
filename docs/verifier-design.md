# Dottie verifier design: computer-use postconditions, recovery and targeting

| | |
|---|---|
| Owner | E11 Computer-Use Reliability Engineer |
| Interfaces | E04 (tool implementations), E07 (test authority), E03 (coordinator `VERIFYING` state), E08 (policy/approvals) |
| Spec refs | §3 item 6, §4 (Verifier box, `VERIFYING` state), §7 `ToolResult` / `TaskFinished`, §9 step 9, §11, §12 first demo, §14 |
| Code | `src/verifier/dottie_verifier/` (Python package), tests in `src/verifier/tests/` |
| Status | Design plus a working verifier layer, tested with fakes on Linux. **Nothing here has run on Windows yet** (see §11). |
| Date | 18 Oct 2026 |

---

## 1. Principles

1. **"Tool returned OK" is never enough.** E04's `success`/`verified` flags are stored as evidence (`tool_claim`). They never satisfy a postcondition. A tool error or exception also does not skip verification, because the action may still have happened.
2. **Observe the postcondition the user cares about.** For example: "Explorer is showing Downloads", "the file exists, was written by this action, and holds the right content", "the command produced the expected result". Proving that "a click was sent" does not count.
3. **Target by identity, not by appearance.** Windows are identified by HWND plus process image plus window class, and folders by filesystem identity. Window titles, localized display names and raw screen coordinates are never evidence and never select a target.
4. **Bounded, safe recovery.** Every retry is HWND-targeted, idempotent, capped in attempts and time, and recorded in the report.
5. **Stop or ask under uncertainty.** If several targets are plausible, or two sources of evidence disagree, Dottie asks. If the evidence shows the wrong target, Dottie stops. It never clicks at random or picks "the first match".
6. **Honest outcomes.** Each run reports one of four outcomes: `verified`, `partially_verified`, `unverified` or `failed`, with per-check evidence. Only `verified` sets `ToolResult.verified = true`, and only `verified` counts toward the 95% target.

## 2. Where the verifier sits

```text
Codex -> tool router -> [E11 verifier wrapper] -> E04 tool (Bot tools/registry.execute_tool)
                              |   snapshot pre-state (Explorer HWNDs, foreground, files...)
                              |   act: call E04 tool (result kept as evidence only)
                              |   poll postconditions until settled (settle_timeout)
                              |   decide: DONE | RETRY | ASK_USER | STOP
                              |   recover (HWND-targeted) -> re-verify   (bounded)
                              v
                     VerificationReport -> ToolResult{verified} -> coordinator VERIFYING -> SPEAKING
```

* The verifier **wraps** E04's tools and does not change them. `bot_adapter.bot_tool_runner()` returns a `runner(name, args)` with the same shape as Bot's `execute_tool`. Approvals must come from E08's policy gate. Bot's own voice approval flow fails open (audit risk 3), so it is not used.
* All Windows access goes through the `WindowsApi` protocol (`winapi.py`). `win32_backend.Win32Api` implements it with ctypes and pywin32. `tests/fakes.FakeDesktop` simulates windows, tabs, monitors, DPI, cloaking, the foreground lock and redirected Known Folders. As a result, all of the decision logic is unit-tested on Linux.
* Generic runner: `workflow.run_verified(workflow)`. A workflow supplies `snapshot / act / verify / recoverable / recover / ask_question / stop_on`.

## 3. Target identification (all workflows)

Order of preference. The verifier stops at the first rule that gives exactly one window:

1. The HWND that the tool reported, **if** it is still in the expected window set (for example, an `IShellWindows` Explorer window).
2. The **pre/post diff**: exactly one new matching window since the action started.
3. The **foreground** window's root (`GetAncestor(GA_ROOT)`), if it matches and no new window appeared.
4. *(Explorer only)* the **only** window already showing the expected folder.
5. Otherwise the target is unidentified. With two or more candidates the check is marked `ambiguous`, which leads to **ASK_USER**. The candidate list goes into the evidence and the question.

Rules 2–5 need the full window list. If either the before or the current enumeration is `complete:false` (an entry was skipped), they don't run: the target is unidentified with no candidates and the workflow stops (CONTRACTS §5, §15 "Incomplete Explorer enumeration").

Every identified window is then checked for process image (`QueryFullProcessImageName`) and class (`GetClassName`). If the process is positively wrong, the workflow **STOP**s. The title is captured only as `title_for_evidence_only`.

## 4. Postcondition catalogue

Notation: **C** marks a critical check. A failure means the goal was not met. An unknown means the run cannot be confirmed. **N** marks a non-critical check. A failure or unknown there downgrades the outcome to *partially verified*. Every check records its evidence source.

### 4.1 First demo: "Dottie, open File Explorer and go to Downloads" (implemented: `explorer.py`, `explorer_workflow.py`)

| ID | Postcondition | Evidence source | C/N | Recovery on failure | Stop/ask |
|---|---|---|---|---|---|
| EXP-01 | `FOLDERID_Downloads` `{374DE290-123F-4565-9164-39C4925E467B}` resolves via **SHGetKnownFolderPath** and the folder exists. This handles OneDrive/GPO redirection, other drives and localized names, and never guesses `%USERPROFILE%\Downloads`. | SHGetKnownFolderPath, GetFinalPathNameByHandle | C | none | **STOP** on fail or unknown |
| EXP-02 | The target Explorer window is identified by HWND (§3) and `IsWindow` is true. | IShellWindows HWND, pre/post diff, foreground | C | re-enumerate windows, then re-invoke E04 `open_downloads` (idempotent) | **ASK** if ≥2 candidates |
| EXP-03 | The window belongs to `explorer.exe` and has class `CabinetWClass` (or `ExploreWClass`). | GetWindowThreadProcessId, QueryFullProcessImageName, GetClassName | C | none | **STOP** on fail |
| EXP-04 | Not minimized. | IsIconic | C | `ShowWindow(hwnd, SW_RESTORE)` | |
| EXP-05 | Visible, **not cloaked** (another virtual desktop), non-empty frame, and it intersects a connected monitor. | IsWindowVisible, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, MonitorFromWindow | C | restore if hidden. If off-screen (monitor unplugged), move it by HWND to the primary monitor's work area. If cloaked: **no** recovery, because the user's desktop layout is not changed silently. | |
| EXP-06 | The **active tab's** current folder equals the EXP-01 path: normalized (`\\?\`, case, slashes, trailing `\`), then resolved through GetFinalPathNameByHandle (junctions, 8.3 names). It must hold on **2 consecutive samples**. Sources in order: `Document.Folder.Self.Path`, then `LocationURL` (percent-decoded, UNC-aware), then the UIA address bar value (absolute paths only; breadcrumb labels are rejected). If Self.Path and LocationURL disagree, the result is *unknown*. Virtual locations (`::{...}`) fail. Title and LocationName are never used. | IShellWindows (+ IShellBrowser tab HWND), UIA ValuePattern | C | 1st: re-invoke E04 tool. 2nd: `IWebBrowser2.Navigate2(<KF path>)` on **this HWND's active tab**. Unknown: re-observe after backoff. | **ASK** if there are several tabs with different folders and the active tab can't be determined |
| EXP-07 | Foreground: the root of `GetForegroundWindow()` equals the HWND. | GetForegroundWindow, GetAncestor | N | `SetForegroundWindow(hwnd)` only. No AttachThreadInput or synthetic-input tricks (E08 decision pending). | |
| EXP-08 | The action opened **at most one** new Explorer window (spec §11). | IShellWindows diff | N | none: Dottie never closes the user's windows | |

Notes:
* **Windows 11 tabs.** All tabs share one top-level `CabinetWClass` HWND, and `IShellWindows` returns one entry per tab. The verifier picks the entry whose `IShellBrowser::GetWindow()` (via `IServiceProvider::QueryService(SID_STopLevelBrowser)`) equals the active `ShellTabWindowClass` child. If all tabs show the same folder, that folder is accepted. If not, the verifier asks. This catches a real E04 gap (§12, item 2), which is covered by the test `test_e04_navigating_background_tab_is_caught_and_repaired`.
* **Stability.** Two samples 250 ms apart. A flapping observation is *unknown*, not pass.
* Spoken output: "File Explorer is showing Downloads." For a partial result: "...but I couldn't bring it to the front." For an unverified result: "I asked File Explorer to open Downloads, but I couldn't confirm it." When the verifier needs to ask: "I see 2 File Explorer windows (Documents, Pictures). Which one should I switch to Downloads, or should I open a new window?"

### 4.2 Other supported workflows (spec §3 item 6, §9, §11)

| Workflow (E04 tool) | Critical postconditions | Non-critical | Recovery | Stop / ask |
|---|---|---|---|---|
| **Explorer: navigate to a path / child / parent / back** (`navigate_to_folder`, `open_child_folder`, `go_parent_folder`, `go_back`) | EXP-02..06, with the expected path resolved *before* acting (child: exactly one case-insensitive directory match; parent: `ntpath.dirname` of the observed folder; back: the previous **verified** folder) | EXP-07, EXP-08 (same window: zero new windows expected) | as 4.1 | ask if the child name is ambiguous; stop if the expected path doesn't exist |
| **Explorer: other known folders / This PC** (`open_documents`, `open_desktop`, `navigate_shell`) | as 4.1 with that FOLDERID. This PC: the active tab's Self.Path/LocationURL equals `::{20D04FE0-3AEA-1069-A2D8-08002B30309D}` (the CLSID, never the localized "This PC" label) | | as 4.1 | |
| **Explorer: close window** (`close_explorer`) | the HWND that was verified before acting no longer `IsWindow` (or its PID/class changed). No *other* Explorer HWNDs disappeared. | | none (no repeated WM_CLOSE storms) | ask if the target is unidentified |
| **Launch application** (`launch_application`) (implemented: `app_checks.py`) | APP-01: exactly one **new** top-level window whose process image is in the expected set. Packaged apps need the real image or the `ApplicationFrameHost.exe` host (Win11 Calculator, Notepad and Paint are packaged, and the `Popen` PID of `calc.exe`/`notepad.exe` exits immediately). APP-02 not minimized. APP-03 visible on a monitor. | APP-04 foreground | restore / focus by HWND; re-launch only if no window appeared and the launch is idempotent | ask if ≥2 new windows; stop if the image is not allowlisted |
| **Window management** (`focus_window`, `minimize_window`, `maximize_window`, `move_window_to_monitor`, `close_window`) | the target is selected by HWND (E04 currently selects by title substring, see §12). Focus: foreground root == HWND. Minimize: `IsIconic`. Maximize: `IsZoomed` and the frame covers the work area of `MonitorFromWindow`. Move: the window centre lies in the target monitor and the frame is inside its work area at that monitor's DPI. Close: HWND gone. | | single restore/focus retry | ask on multiple matches |
| **Create / write file** (`create_file`, `write_file`) (implemented: `artifacts.check_file_saved`) | FILE-01 exists and is a regular file at the **resolved** path. FILE-02 size ≥ 1 (or equals the expected size). FILE-03 `mtime ≥ action_start − 2 s`. FILE-05 content: text read back equals the requested content (sha256 of the encoded bytes). | FILE-04 readable, no `~$` Office owner file | none automatic for writes (not idempotent once overwrite is involved) | overwriting requires E08 approval *before* acting |
| **Create folder** | folder exists; `created` matches the pre-state (it didn't exist before, or "already existed" is reported truthfully) | | | |
| **Rename / move / copy** | destination exists with the same size (copy: same sha256 as the source). Move/rename: the source path **no longer exists**. The destination mtime is preserved (copy2/move), so freshness is not checked here. Instead: the destination did not exist before, or overwrite was approved. | | none | ask if the destination exists |
| **Delete** (approval-gated) | the path no longer exists **and** the approval record matches this exact path. Prefer the Recycle Bin (`IFileOperation` + `FOFX_RECYCLEONDELETE`) and verify the item is there. | | none | stop without a single-use approval |
| **Open file in its default app** (spec §9 example: "newest PDF in Downloads") | selection: newest by mtime among `*.pdf` in the KF Downloads folder. A tie at the top means **ask** before opening. After opening: a new top-level window whose process is the registered handler (`AssocQueryString(ASSOCSTR_EXECUTABLE, ".pdf")`) **and** the document is the one we opened. Check the latter via (a) the handler's open-file handles (`NtQuerySystemInformation`/Restart Manager `RmGetList` on the file), or (b) UIA document name equal to the file name with the full path confirmed by (a). | title contains the file name (evidence only) | focus/restore by HWND | ask on a tie; *unverified* if only the title matches |
| **Shell: PowerShell / CMD / Bash** (implemented: `artifacts.check_process_result`) | PROC-01 finished (no timeout/cancel; the process tree reaped by a Job Object). PROC-02 exit code in the expected set. PROC-03 **meaningful result predicate** supplied by the task (for example "output lists `notes.txt`" or "file X now exists"). Without a predicate the result is *unverified*. Artifacts are checked with FILE-*. | PROC-04 stderr empty (PowerShell non-terminating errors exit with 0; run with `-NoProfile -NonInteractive` and `$ErrorActionPreference='Stop'`) | re-run only if the command is declared idempotent | stop on elevation prompts |
| **Browser via Playwright: navigate / extract** | `page.url` matches the expected origin+path after redirects; `response.status` < 400; a task-specific DOM assertion (selector text) is met. External text is data, not instructions (§10). | screenshot saved as evidence | `goto` retry with backoff on network errors only | stop at login/payment pages (user-visible, needs approval) |
| **Browser download** (implemented: `artifacts.check_download_complete`) | DL-01 final file exists. DL-02 no `.crdownload/.part/.partial/.download/.tmp` sibling. DL-03 size > 0 and stable across 2 samples. DL-05 fresh mtime. DL-06 `download.failure()` is null. DL-04 integrity: sha256, `Content-Length`, or file signature (magic bytes). Without a reference, DL-04 is a non-critical *unknown*, which means at most partial. | | re-download once on failure (GET is idempotent) | |
| **Word / Excel / PowerPoint** | FILE-01..03 + FILE-05 with a **format check**: a valid OPC zip containing `word/document.xml` / `xl/workbook.xml` / `ppt/presentation.xml`, plus a content assertion (expected paragraph text, cell value, slide count). Read it back with python-docx/openpyxl/python-pptx, or the COM object model, *after* the app has closed or saved. | FILE-04: no `~$` owner file left (the app released the doc) | none automatic | ask before overwriting |
| **UIA click** (`click_control`) | the postcondition is the **effect** (for example, a dialog closed or a value changed via ValuePattern/TogglePattern state), never "click sent". The control is resolved by AutomationId + ControlType inside a window identified by HWND. | | re-resolve the element (stale element) once | ask if 0 or ≥2 matches |
| **Clipboard / volume** | read back (`read_clipboard` equals the written text; `GetMasterVolumeLevelScalar` within ±1 of the target) | | | |
| **Stop / cancel** (spec §14) | the process tree under the task's Job Object is empty; no tool call is in flight. Any external action that already happened is listed (never reported as "cancelled"). | | | |

## 5. Outcome classification and report format

`model.classify(checks)`:

| Outcome | Rule | `ToolResult.verified` | Counts toward 95% |
|---|---|---|---|
| `verified` | every check passes | true | yes |
| `partially_verified` | every **critical** check passes; some non-critical check fails or is unknown | false | no |
| `unverified` | no critical check fails, but at least one critical check is unknown | false | no |
| `failed` | at least one critical check has positive evidence of failure | false | no |

`VerificationReport.to_dict()` (stored under `docs/evidence/` per run; E07 consumes it):

```json
{
  "workflow": "explorer.open_known_folder:downloads",
  "outcome": "partially_verified",
  "verified": false,
  "tool_claimed_success": true,
  "false_success": true,
  "decision": "done",
  "decision_reason": "retry budget exhausted after 3 attempts",
  "question": "",
  "checks": [
    {"id": "EXP-06", "status": "pass", "critical": true,
     "source": "IShellWindows.Document.Folder.Self.Path",
     "evidence": {"expected_path": "C:\\Users\\<user>\\OneDrive\\Downloads",
                  "samples": [{"observed_path": "...", "observation_status": "ok"}]}},
    {"id": "EXP-07", "status": "fail", "critical": false,
     "evidence": {"foreground_hwnd": 3344, "foreground_root": 3344}}
  ],
  "attempts": [{"number": 1, "action": "open_downloads", "outcome": "partially_verified",
                "recovery": ["set_foreground(hwnd=4128) -> False"], "tool_result": {"success": true}}]
}
```

* `false_success` means the tool claimed success and the verifier did not confirm it. It is tracked separately because it is the release-blocker class "silent errors misrepresented as success" (§14).
* `contract.to_verification_result(report)` returns the CONTRACTS v2 §2.3 `VerificationResult`, and `contract.to_mcp_tool_result(report, summary)` returns the §5 MCP result. The verifier never builds the `ToolResult` event; the coordinator's tool router does. See §15.
* Spoken templates (per workflow): *verified* gives a short confirmation. *partial* gives the confirmation plus the named caveat. *unverified* says "I asked …, but I couldn't confirm it". *failed* says "I couldn't …" and names the failed check. *ask* gives the question. Dottie never says "done" unless the outcome is verified.

## 6. Recovery strategies

`RetryPolicy` defaults: `max_attempts=3` verification rounds, backoff `0.25 s → 0.5 s → 1.0 s` (cap 2 s, ±20% jitter), `settle_timeout=3 s` of polling every 0.2 s per round (Explorer navigation is asynchronous), and a `total_deadline=15 s` hard ceiling. Polling stops early on verified, ambiguous or stop conditions.

The recovery ladder is the spec §11 fallback order applied to *repair*. Each rung is HWND-targeted:

1. **Wait and re-observe.** COM or UIA may not have settled yet (unknown → re-poll after backoff).
2. **Re-enumerate windows.** The HWND may have been destroyed or recreated (Explorer restarts or recycles windows). Rule §3 is re-run on every verification, so the target is re-acquired instead of reusing a stale handle.
3. **Re-focus by handle.** `ShowWindow(SW_RESTORE)`, then `SetForegroundWindow(hwnd)`. Rungs 3, 5 and the off-screen move call Windows directly, outside E04's allowlisted tools. Each one therefore goes through a `recovery_gate(primitive, {hwnd})` callback. The default is **deny** (ADR-0009, fail-closed). Production wiring must use E08's policy gate. If the foreground lock refuses, the result is reported as partial. It is not forced.
4. **Re-invoke the E04 tool**, once and only if the operation is idempotent (navigation, launch-if-absent, GET download), through the same policy-gated runner. Never after a policy refusal or a missing approval/permission (`APPROVAL_REQUIRED`/`PERMISSION_REQUIRED`/`DENIED_BY_POLICY`), because approvals are single-use (ADR-0009).
5. **Direct API on the identified object**, for example `Navigate2` on the active tab of the verified HWND.
6. **UIA fallback for observation**: address bar ValuePattern, accepted only if it parses as an absolute path.
7. **Coordinates: last resort, guarded** (`targeting.resolve_window_point`). The point is derived from the HWND's frame and DPI, must lie inside the frame and on a monitor, must hit-test back to the same root HWND (not occluded), and the process must be Per-Monitor-v2 aware. If any of these fails, there is no input and the result is stop/ask.

Never: click by guessed coordinates, pick the "first" of several matches, close or move the user's other windows to "clean up", re-run non-idempotent actions (writes, sends, deletes, moves), or use foreground-lock bypasses without E08 approval.

## 7. Stop-or-ask policy (`policy.decide`)

Evaluated after each settled verification round, in this order:

| # | Condition | Decision |
|---|---|---|
| 1 | outcome `verified` | DONE |
| 2 | a check in the workflow's `stop_on` map has a stopping status (for example, EXP-01 fail/unknown, or EXP-03 fail = wrong process) | **STOP**: acting further is unsafe |
| 3 | any non-passing check carries `ambiguous` (≥2 candidate windows, unresolvable tabs, tied files) | **ASK_USER** with a specific question that lists the candidates by folder or name |
| 4 | attempt budget or deadline exhausted | DONE, with the honest non-verified outcome |
| 5 | some failing check has a safe recovery | RETRY (backoff → recover → re-verify) |
| 6 | otherwise | DONE (report the outcome, no further action) |

STOP comes before ASK so that positive evidence of a wrong target is never "clarified away". Unknown process/window state alone (no window yet) is not a stop. It can be recovered.

## 8. Multi-monitor and per-monitor DPI targeting

* **Prerequisite (E06):** the Electron main process and the Python tool worker must run **Per-Monitor-v2 DPI aware** (manifest `<dpiAwareness>PerMonitorV2</dpiAwareness>` or `SetProcessDpiAwarenessContext(-4)`). Otherwise `GetWindowRect`/`SetCursorPos` are virtualized on scaled monitors. The verifier checks `GetThreadDpiAwarenessContext` and refuses coordinate fallback if it is not PMv2.
* All geometry is in **physical virtual-screen pixels**. Monitors to the left of or above the primary have **negative** coordinates (tested). Window frames come from `DWMWA_EXTENDED_FRAME_BOUNDS` (excluding the invisible resize borders). Monitor membership uses `MonitorFromWindow(MONITOR_DEFAULTTONULL)` and the largest-intersection rule.
* Window-relative logical points are converted to physical with the **window's own** `GetDpiForWindow` scale, never the primary monitor's scale. Points in gaps between monitors are rejected (tested).
* Off-screen windows (a monitor was unplugged) are detected by zero intersection and moved by HWND to the primary work area. Cloaked windows (another virtual desktop) are reported, not moved.
* Screenshot evidence, when captured, is per-monitor and annotated with monitor handle and DPI.
* **Fail-closed observations (CONTRACTS §5, E01 2026-10-19):** an unreadable window DPI (`GetDpiForWindow` = 0), cloaked state (`DwmGetWindowAttribute` failed) or frame never falls back to a default (96 DPI, "not cloaked", a zero rect). Coordinates are sent only through `targeting.coordinate_action`, which resolves and hit-tests immediately before calling the tool. A refused point is `PRECONDITION_FAILED` with `sideEffect:none`, the tool is not called, and a code is attached (`dpi_unreadable`, `cloaked_unreadable`, `not_pmv2`, `off_monitor`, `occluded`, …). A pinned window whose cloaked state is unreadable gives `PRECONDITION_FAILED` before dispatch, and no recovery primitive runs on it. EXP-05 reports such a window as `unknown` (not `fail`) and never moves or restores it. An unreadable monitor DPI is `None` and is never used for targeting.

### 8.1 Multi-monitor / per-monitor-DPI matrix (skill `e11-cur-multimonitor-dpi-matrix`)

Status: ✅ = covered by fakes on the box (test name); 🪟 = needs real Windows on <TEST-PC>, with evidence in `docs/evidence/verifier-win/<date>/dpi/` (skill PC steps 1–5). A layout the test PC doesn't have is reported as "not available", never simulated as passed. Nothing in the 🪟 column has run yet.

| ID | Case | Box (fakes) | Real Windows |
|---|---|---|---|
| DPI-B1 | Secondary 150% **left** of primary (negative x) | ✅ `test_dip_scaling_on_150_percent_monitor_left_of_primary`, `test_point_resolved_and_hit_tested_on_secondary_monitor`, `test_window_on_secondary_high_dpi_monitor_left_of_primary` | 🪟 if a 2nd monitor exists |
| DPI-B8 | Secondary **above** primary (negative y) | ✅ `test_dpi_b8_monitor_above_primary_negative_y` | 🪟 if available |
| DPI-B2 | Logical → physical with the **window's** DPI, not the primary's | ✅ `test_dpi_b9_mixed_dpi_uses_window_dpi_not_monitor_or_primary` | 🪟 mixed 100%/150% |
| DPI-B9 | **Mixed per-monitor DPI**, monitor DPI unreadable → window DPI only | ✅ same test | 🪟 |
| DPI-B3 | Point in the **gap** between monitors of different heights → refused | ✅ `test_refuses_point_in_gap_between_monitors` | 🪟 if available |
| DPI-B4 | Point **occluded** by another window → no input | ✅ `test_refuses_occluded_point` | 🪟 guarded fallback on Notepad |
| DPI-B5 | Process not PMv2 → coordinates refused | ✅ `test_refuses_when_not_per_monitor_v2` | 🪟 PMv2 check of Electron main (E06) and tool worker (E04) |
| DPI-B6 | **Monitor unplugged** → off-screen window moved by HWND; cloaked → reported, not moved | ✅ `test_offscreen_window_is_moved_to_primary_monitor`, `test_cloaked_window_on_other_virtual_desktop_fails_without_moving_it` | 🪟 unplug / virtual desktop 2 |
| DPI-B11 | **Monitor unplugged mid-task** between resolve and send → refused (`off_monitor`), nothing sent | ✅ `test_dpi_b11_monitor_unplugged_mid_task_refuses_then_moves_by_hwnd` | 🪟 unplug during a run |
| DPI-B7 | Window **spanning** two monitors → membership by largest intersection | ✅ `test_monitor_for_rect_picks_largest_overlap` | 🪟 |
| DPI-B10 | Spanning window, point on the **other** monitor → window DPI, hit-tested | ✅ `test_dpi_b10_window_spanning_monitors_point_on_other_monitor` | 🪟 (Windows switches a spanning window's DPI by majority area, so validate `GetDpiForWindow` there) |
| DPI-B12 | **DPI changes** between resolve and send (scaling changed, window dragged) → re-resolved at send | ✅ `test_dpi_b12_dpi_change_between_resolve_and_send_is_rechecked` | 🪟 change scaling during a run (ask first, restore afterwards) |
| DPI-B13 | **Unreadable window DPI** (None or 0) → `PRECONDITION_FAILED`, `sideEffect:none`, tool not called, no 96 fallback | ✅ `test_coordinate_action_refused_on_unreadable_observation`, `test_dpi_is_never_defaulted_to_96` | 🪟 can't be induced on demand; fakes only, plus a log check that it never occurs |
| DPI-B14 | **Cloaked state unreadable** → not actionable (coordinates, pinned dispatch, recovery primitives) | ✅ `test_coordinate_action_refused_on_unreadable_observation[cloaked…]`, `test_pinned_window_with_unreadable_cloaked_state_is_precondition_failed`, `test_recovery_primitive_not_run_when_cloaked_state_unreadable`, `test_visibility_check_is_unknown_not_fail_and_nothing_is_moved` | 🪟 can't be induced; fakes only |
| DPI-B15 | Frame unreadable (DWM and `GetWindowRect` both fail) → `unknown`, nothing moved | ✅ `test_visibility_check_is_unknown_not_fail_and_nothing_is_moved[rect…]` | 🪟 can't be induced; fakes only |
| DPI-W1 | Single monitor at 100% / 150% / 175%, ≥20 runs each (open Downloads, move window, one guarded fallback) | — | 🪟 |
| DPI-W2 | Mixed 100%/150% with the secondary left of the primary, ≥20 runs | — | 🪟 if a 2nd monitor exists, else "not available" |
| DPI-W3 | RDP / remote session DPI (session DPI differs from console DPI) | — | 🪟 if available |

## 9. Measuring the ≥95% verified-completion target (spec §14)

* **Task suite** (owned by E07, postconditions owned by E11): a named list of workflows with fixed inputs and fixtures. Examples: `open_downloads` (new window / reuse / 3 tabs / minimized / OneDrive-redirected), `navigate_child`, `launch_notepad`, `launch_calculator`, `create_text_file`, `copy_file`, `ps_list_dir`, `browser_download_pdf`, `word_create_doc`, `newest_pdf_open`.
* **Runs:** ≥20 runs per task per environment cell (the `min_runs_per_task` flag in the summary). The matrix comes from §14: Windows 11 23H2/24H2/25H2, 1 and 3 monitors, 100%/150%/175% DPI with mixed-DPI layouts, OneDrive redirection on/off, a non-English display language (for example de-DE or fr-FR), and Explorer pre-state (none / one / several windows, tabs).
* **Counting:** completion means `outcome == "verified"`. Partial, unverified, failed, asked and stopped runs all count as **not completed**. An ASK in a scenario designed to be ambiguous is scored by a separate "correct-ask" metric. Those runs are excluded from the 95% denominator only if the scenario is pre-declared as an ask scenario.
* **Statistic:** `metrics.summarize()` reports the point estimate, the Wilson 95% interval, per-task rates, the weakest task, tasks below target, and `false_success_rate`. Release gate proposal: point estimate ≥ 95% on every task, **and** pooled Wilson lower bound ≥ 90% (95/100 gives [0.888, 0.978]. Showing a Wilson lower bound ≥95% takes about 175 runs at a 98% observed rate, or about 415 runs at 97%). `false_success_rate` must be **0**, because each such run is a release blocker until triaged.
* **Evidence:** one JSONL row per run (`{task_id, run, environment, duration_s, report}`), loaded with `metrics.load_jsonl`. Raw reports are kept under `docs/evidence/<build>/`.
* **Independence:** the verifier's verdict is the scored result. E07 spot-audits by screenshot/video on a sample of `verified` runs to measure verifier false-pass. Any confirmed false pass is a P0 verifier bug.

## 10. Implementation status (this change)

| Module | Purpose | Tested on Linux |
|---|---|---|
| `model.py` | Check/Outcome/Report, classification, `ToolResult` mapping | yes |
| `paths.py` | ntpath normalization, `\\?\`, UNC, file URLs, final-path aliasing | yes |
| `winapi.py` | `WindowsApi` protocol + Rect/Monitor/WindowState/ShellWindowEntry | via fakes |
| `known_folders.py` | FOLDERIDs + SHGetKnownFolderPath resolution | via fakes |
| `window_checks.py` | exists / process+class / minimized / visible-on-monitor / foreground | yes |
| `explorer.py` | IShellWindows observation (tabs, sources, conflicts), target identification, EXP-01..08 | yes |
| `explorer_workflow.py` | first-demo workflow wrapping E04 `open_downloads`, recovery, spoken summary | yes |
| `workflow.py`, `policy.py`, `recovery.py` | generic runner, stop-or-ask, backoff | yes |
| `artifacts.py` | FILE-*, DL-*, PROC-* | yes (real tmp files) |
| `app_checks.py` | APP-01..04 (incl. UWP host) | yes |
| `targeting.py` | DPI/monitor math + hit-test guard for coordinate fallback | yes |
| `metrics.py` | suite summary, Wilson CI, false-success rate, JSONL loader | yes |
| `contract.py` | serializes a report to the CONTRACTS.md §5 `structuredContent` draft shape (error codes, `retryable`, `sideEffect`) without changing it | yes |
| `win32_backend.py` | real ctypes/pywin32 implementation | **no: Windows only** (contract test checks it implements the protocol) |
| `bot_adapter.py` | wraps E04 `tools.registry.execute_tool`; manual smoke entry point | **no** |

Run: `cd src/verifier && python3 -m pytest -q`. Result on the Linux box (Python 3.13.5, pytest 9.1.1): **485 passed, 0 failed** (2026-10-19, CONTRACTS v2 plus E01's rulings of 2026-10-19 including the E04-review items, the 4-field window identity and its wire encoding, windowClass in UTF-16 code units and fail-closed incomplete enumerations, §15; TOCTOU plan §16). Lint: `uvx ruff@0.17.1 check .` with the pinned config in `src/verifier/pyproject.toml` (0.17.1 defaults plus E501 at 100 columns) passes. The earlier "ruff clean" claim was wrong: it came from a narrower CLI `--select E,F,B,I`, not from ruff 0.17.1's default rule set, which reports 20 findings (DOT-064, RISKS R21).

## 11. Needs validation on a real Windows 11 machine

1. `SHGetKnownFolderPath` + `GetFinalPathNameByHandle` with OneDrive Known Folder Move, a GPO-redirected UNC Downloads folder, and Files-On-Demand placeholders (opening the folder handle must not hydrate files or fail).
2. `IShellWindows` on 23H2/24H2/25H2: `Document.Folder.Self.Path` vs `LocationURL` for redirected and localized folders, and timing after `Navigate2`. Also confirm `shell:Downloads` lands on the real path (not a virtual item).
3. **Tabs:** that `IServiceProvider::QueryService(SID_STopLevelBrowser, IID_IShellBrowser)` → `GetWindow()` returns the per-tab `ShellTabWindowClass` HWND, and that the first `FindWindowEx(..., "ShellTabWindowClass")` child is the active tab on each build. If either is false, the fallback is "ask".
4. UIA address bar on the Win11 XAML title bar: the AutomationId/ControlType of the editable address box, and whether its value is available without focusing it. `uia_address_value` is marked experimental.
5. **Foreground lock:** whether a tray/background Dottie process can bring Explorer to the front after a *voice* trigger (no user input). Expect `SetForegroundWindow` to be refused often. If so, EXP-07 will make the demo *partial*. Decision needed (§13, item 1).
6. DWM cloaking on virtual desktops, and `MonitorFromWindow` after a monitor is unplugged or on a docked/undocked laptop. Mixed-DPI (100% + 150%) frame bounds under PMv2.
7. Packaged apps: process images for Notepad/Calculator/Paint on Win11 and the `ApplicationFrameHost` mapping.
8. COM apartment and threading: `win32_backend` initializes COM per call. Measure the latency of `shell_windows()` with many windows/tabs, since it is polled every 200 ms during settle.
9. End-to-end: E04 tool + verifier + Codex adapter on the demo, through the E07 harness, across the §9 matrix.

## 12. Findings in E04's current tools (Bot `fix/unexpected-session-exit` @ 5268c8d), read-only review

These are reported for coordination only. I didn't change them.

1. `_shell_location_matches` falls back to `"downloads" in <location text>`, so a folder named `Old Downloads` passes, and a localized name such as "Téléchargements" fails. Its `verified: True` is therefore not trustworthy (test `test_substring_downloads_folder_is_not_accepted`).
2. **Tabs:** `_windows()` returns one entry per tab with the same HWND. `_target()` and `navigate_shell()` take the first entry for the HWND, which may be a background tab. Navigation and verification can both hit a hidden tab.
3. `known_folders()` reads `HKCU\...\User Shell Folders` instead of `SHGetKnownFolderPath`. This usually works, but it misses policy/redirection edge cases and depends on manual `%VAR%` expansion.
4. `launch_application("explorer")` and `open_folder()` report `success: True` without verification. `open_folder()` always spawns a new window (against §11), and the returned `pid` is that of a transient `explorer.exe` launcher that exits immediately. The same applies to the packaged Notepad/Calculator/Paint launchers.
5. `find_window`, `focus_window`, `minimize_window`, `maximize_window`, `move_window_to_monitor`, `inspect_window` and `click_control` select windows by **title substring**. This should move to HWND+process (the verifier can supply HWNDs).
6. `click_mouse`/`drag_mouse` take raw screen coordinates with only an "on some monitor" check. They should go through `targeting.resolve_window_point` (window-relative, hit-tested) or be removed from the model-facing tool list.
7. Importing `desktop_tools` creates `~/Pictures/VoiceAgent` and needs pywin32/pyautogui, so the module can't be imported in Linux CI. E07 needs an injectable seam (this verifier uses the `WindowsApi` protocol as that seam).
8. `navigate_shell`'s 6 s fixed poll and `_open_initial`'s "exactly one new window" heuristic fail if another app opens an Explorer window at the same moment. The verifier's identification rules (§3) cover this case.

## 13. Spec ambiguities / decisions needed

1. **Is foreground part of "Explorer displays Downloads" (§12)?** I classified it as non-critical (partial) because Windows may legitimately refuse focus. If the Product Owner requires it, EXP-07 becomes critical and E06/E08 must approve a sanctioned foreground mechanism (for example, have the tray UI take foreground first on wake).
2. **Reuse vs new window** when several Explorer windows exist and none is focused. The spec says "avoid opening multiple windows" but doesn't say whether to ask or open a new one. I implemented **ask**, unless exactly one window already shows Downloads.
3. **Tabs:** should Dottie navigate the active tab, or open a new tab? I assumed the active tab.
4. **Ask scenarios in the 95% metric:** this needs an explicit rule (§9). I proposed pre-declared ask scenarios that are scored separately.
5. **Language/stack:** the reusable tools are Python (Bot), while the target app is Electron/TS (audit risk 5). The verifier is Python so it can wrap E04 in-process in the tool worker. If E01 chooses a TS port, the logic ports 1:1 (pure functions plus a protocol).
6. **Repo location:** the spec §8 layout (`packages/tools`, `tests/unit`) doesn't exist yet. The code lives in `src/verifier/` until E01 scaffolds the monorepo.

## 14. Coordination asks (not sent; for E01 to route)

* **E04:** emit the HWND **and tab HWND** in every Explorer result; expose a `target_hwnd` argument on navigation tools; move window tools to HWND targeting; fix findings 1–4.
* **E07:** adopt `FakeDesktop`/`FakeE04Tools` as the unit seam; build the Windows e2e harness that records `VerificationReport` JSONL; own the task-suite list and matrix in §9.
* **E06:** PMv2 DPI manifest; decide the foreground strategy.
* **E08:** approve or deny the foreground-lock approach and the "move off-screen window to primary" recovery; confirm approval records for delete/overwrite are passed into FILE checks.
* **E03:** map `Decision.ASK_USER` to a clarification turn and `STOP` to `ERROR`/`RECOVERING`. Pass `VerificationReport` into `TaskFinished{verified}`.

## 15. Alignment with CONTRACTS v2 (ADR-0012, accepted by E01 2026-10-19; E01 rulings of 2026-10-19; DOT-064)

Shared docs and packages were not changed. **The verifier returns data and never emits events.** Its outputs come from `dottie_verifier/contract.py`:

| Contract | Function | Shape |
|---|---|---|
| §2.3 `VerifierPort` | `to_verification_result(report, evidence_ref?)` | `{outcome: verified\|partially_verified\|unverified\|failed, verified, observedState, error?, evidenceRef?}`. The 4-value verifier enum is kept as implemented (E01). |
| §5 MCP result (tool host) | `to_structured_content(report, evidence_ref?)`, `to_mcp_tool_result(report, summary)` | `structuredContent = {verified, observedState, sideEffect, error?, evidenceRef?}`; `isError = !verified`; **no `success`** |
| §3 `ToolResult` event | **not in the verifier.** The coordinator's tool router builds it from the MCP result. `tests/router_fixture.py` is a test-only stand-in. | envelope `{schema:"dottie.event", version:2, type, eventId, correlationId, causationId?, taskId?, timestamp, payload}` |

**`correlationId` / `causationId` (as E01 defined them, CONTRACTS v2 §3):**
* `correlationId` ties every event in one task chain together.
* `causationId` is the `eventId` of the single event that directly caused this one. For example, the `ApprovalResolved` that unblocked a tool call. For a `ToolResult` it is the requesting tool-call event, which the router sets. It is omitted only for root events such as `WakeDetected`.

The verifier sets neither. It has no event ids.

**Outcome mapping is the coordinator's.** `task_outcome()` and `ledger_value()` are **reference helpers only**: production code doesn't call them, and they exist so tests pin the documented §3.1 rule. The rule: verified→succeeded, partially_verified→partial, unverified→unverified, failed→failed (ledger `none`) or failed_after_side_effects (ledger `committed`/`possible`). A ToolResult `unknown` counts as `possible`.

**ObservedState:**
* `outcome`, `decision` ∈ `done | retry | ask_user | stop`, `checks{id: pass|fail|unknown}`, `sideEffect`.
* `question` and `candidates` only when asking.
* Never window titles, file contents or full user paths. Ask labels are a known-folder name ("File Explorer window showing Documents") or an ordinal ("File Explorer window 2").
* Messages and questions also pass through a path redactor as a backstop.
* Full evidence stays in `VerificationReport.to_dict()`, a local artifact referenced by `evidenceRef`.

**Error codes** (§5 only):

| Code | When | Retryable |
|---|---|---|
| `AMBIGUOUS` | ≥2 candidate windows; `question` + `candidates` attached | no |
| `INVALID_ARGUMENT` | schema-invalid or malformed arguments, including a `targetId` that doesn't match `c_` + 12 lowercase hex. Tool not called, `sideEffect:none` | no |
| `NOT_FOUND` | the Known Folder resolves but doesn't exist; **or** a well-formed `targetId` that is unknown, cross-task, superseded, expired, or whose window is already closed / handle reused (any identity field changed) at resolution. Tool not called, `sideEffect:none` | no |
| `PRECONDITION_FAILED` | wrong process/class, or the Known Folder is unresolvable; **or** the target window disappeared after resolution but **before the action was sent** (`sideEffect:none`) | no |
| `POSTCONDITION_FAILED` / `POSTCONDITION_UNKNOWN` | a check failed / nothing failed but something couldn't be observed. A target window that disappears **after the action was sent** is always `POSTCONDITION_UNKNOWN` with `sideEffect:unknown` | only if `sideEffect:none` |
| `TIMEOUT` | the total deadline was hit | only if `sideEffect:none` |
| `CANCELLED` | the task was cancelled (decision `stop`) | no |
| `USER_DECLINED` | the user said no to an approval (Bot: "Action not approved.") | no, and the tool is never re-invoked |
| `APPROVAL_REQUIRED` / `PERMISSION_REQUIRED` / `DENIED_BY_POLICY` | refused before acting. `DENIED_BY_POLICY` is only for actions that can never be granted. The v1 `NEEDS_APPROVAL` maps to `APPROVAL_REQUIRED` | no, and the tool is never re-invoked |

**Side effects and retry (§5, E01 2026-10-19):**
* Mutating tools report `committed` or `unknown` once dispatched, so their errors are never retryable. Recovery always **re-observes first**: every recovery step is immediately preceded by a fresh `verify`, re-invocation happens only as a recovery step, and the reported state is a fresh read. A test pins this ordering.
* `none` is reported for cancel-before-dispatch, an unusable `targetId`, a refusal before acting, and pure observation calls.
* `observe_explorer_folder()` / `ObserveExplorerKnownFolder` is a pure observation ("is File Explorer showing Downloads?"). It makes no tool call and runs no recovery primitive (only re-observes). It reports `sideEffect:none`, and its POSTCONDITION_* errors are `retryable:true`.

**`targetId` follow-up (§5 candidate selection, E01 2026-10-19):**
* Candidate ids come from a task-scoped `CandidateRegistry` (`candidates.py`). They are random (`c_` + 12 hex digits) and carry no HWND, title or path.
* `verify_open_downloads(..., task_id, candidates=registry, target_id=...)` resolves the id. Unknown, cross-task, superseded (a newer question was asked in the same task), expired (TTL 300 s) or window-closed → `NOT_FOUND`, `decision:stop`, tool not called, `sideEffect:none`.
* A valid id pins the target: the E04 tool gets `{"hwnd": <chosen>}`, and identification accepts only that window. If it disappears, there is no fallback to another window and no re-invoke that would open a new one.
* `targetId` handling, in order:
  1. Malformed → `INVALID_ARGUMENT`.
  2. Well-formed but not resolvable (unknown, cross-task, superseded, expired), or the window is already closed or its handle reused (pid, class or process start time changed) → `NOT_FOUND`.
  3. Resolved, but gone at the final liveness check right before dispatch (`precheck`) → `PRECONDITION_FAILED`, `sideEffect:none`.
  4. Gone or reused after dispatch → `POSTCONDITION_UNKNOWN`, `sideEffect:unknown`, with no re-invoke and no fallback window.
  The same "gone after dispatch → unknown, not failed" rule applies to unpinned targets (`check_exists`).
* Bot's current `open_downloads` ignores `hwnd`, so on Bot today a follow-up is caught by verification rather than trusted. The dottie-tools `explorer.open_known_folder` must honour it (E04, DOT-031).

**Cancel:** there is no `cancelled` outcome or decision. Cancel → `decision:stop` + `error.code:CANCELLED`, `retryable:false`. Before dispatch, the tool is not called and `sideEffect` is `none`. If the goal was already verified, it stays verified/done (the coordinator's `completed_before_stop`).

**Recovery** stays deny-by-default: P12 is deferred to E08 (DOT-074). The gate's target now carries the resolved window identity `{hwnd, pid, windowClass, processStartTime}`, so an approval can't be replayed against a reused handle (CONTRACTS v2 §5, E04 review).

**`taskId`** comes from the coordinator's control channel to the tool host, never from model arguments. The verifier takes it as a parameter from the tool host and never reads it from tool args.

**Window identity: the interface for E04's shared registry (`packages/tools`, owner E04, reviewer E11).** The verifier does not build that registry. Its own identity code sits behind `dottie_verifier/window_identity.py`:
* `WindowIdentity(hwnd, pid, window_class, process_start_time)`; `to_contract()` → `{hwnd, pid, windowClass, processStartTime}` (ADR-0017 Decision 8, ADR-0009 CR2, CONTRACTS §3.3, E01 2026-10-19).
* A mismatch on **any** field counts as closed. A window where **any** field can't be read (process start time, class) or is out of range has **no** identity (fail-closed, confirmed by E01): it isn't offered as a candidate, can't be targeted (`NOT_FOUND` at lookup), and recovery primitives aren't run on it.
* **Wire encoding (CONTRACTS §3.3, final 2026-10-19)** (`window_identity.py`, tests in `tests/test_identity_encoding.py`):
  * In memory, `hwnd`, `pid` and `processStartTime` are Python `int`s.
  * On the wire and in every serialized shape, all three are **canonical positive decimal strings**: digits with no leading zero; `"0"` is invalid (CONTRACTS §3.3, E04 review 2026-10-19). They are never JSON numbers, because FILETIMEs (~1.3×10^17) and 64-bit HWNDs exceed 2^53. This covers `to_contract()`, the policy-gate payload (`target.hwnd` and `target.window`), and the local evidence file. In the evidence file, `Check.to_dict`, `Attempt.to_dict` and the report's candidates go through `model.wire_safe`, which writes ints under `hwnd`/`pid`/`*_hwnd(s)`/`processStartTime`/`foreground` keys, and any int beyond 2^53, as decimal strings.
  * `parse_uint`/`WindowIdentity.from_contract` accept only such a string of ASCII digits within range: 1 ≤ HWND, FILETIME ≤ 2^64−1 and 1 ≤ PID ≤ 2^32−1. They reject non-strings (ints, floats, bools, null), `"0"`, signs, leading zeros, whitespace, points, exponents, separators and non-ASCII digits with `InvalidArgumentError`, which callers report as `INVALID_ARGUMENT` (`sideEffect:none`).
  * The identity never appears in `observedState`/`structuredContent` (redaction), so nothing changes there.
* **No fail-open defaults (E04 review 2026-10-19).** `WindowState.pid`, `class_name` and `process_start_time` default to `None` (= couldn't read), never to `0` or `""`. The Win32 backend maps a failed `GetClassNameW` (returns 0), a failed `GetWindowThreadProcessId` (thread id 0) or a reported pid of 0, and a zero FILETIME to `None`. `LocalWindowRegistry.identify` returns no identity for hwnd 0, any `None` field, an empty class, or any zero / out-of-range value, so the window can't be targeted (`NOT_FOUND`) and no recovery runs.
* **windowClass length (CONTRACTS §3.3 and §5, E01 ruling of 2026-10-19 01:36 CDT):** 1–256 **UTF-16 code units**, counted as `len(s.encode('utf-16-le')) // 2` (`window_identity.utf16_units`), the way Windows counts class names. This replaces the earlier `len()` (code point) rule everywhere: `WindowIdentity.__post_init__`, `from_contract`, and `LocalWindowRegistry.identify` all go through `_check_class`. Empty, longer or not a string means no identity (`NOT_FOUND` at lookup) or `INVALID_ARGUMENT` when it arrives as an argument. Vectors: 128 emoji = 256 units (accepted), 129 emoji = 258 units (rejected), 254 ASCII + 1 emoji = 256 units (accepted), 255 ASCII + 1 emoji = 257 units (rejected) (`tests/test_enumeration_and_class_units.py`).
  * **Lone surrogates (flagged to E01):** the contract says nothing about them. A string with an unpaired surrogate has no UTF-16 encoding (`UnicodeEncodeError`), so the verifier **rejects** it (`INVALID_ARGUMENT` / no identity). E04's parser rejects it too (its UTF-8 check).
* **Cross-check with E04's scratch registry parser** (`e04-scratch/registry/window_registry.py`, file time 2026-10-19 01:22 CDT, read-only). First run: the same 172 inputs went through both parsers and they agreed on 170. The differences were:
  * `windowClass` longer than 256 characters: E04 rejected it and the verifier accepted it. E01 ruled 1–256 (§3.3) and the verifier now matches.
  * A decimal string longer than 4300 digits: E04 raised a plain `ValueError`. That no longer happens with E04's parser of 01:30 CDT.
  * **Re-run (01:33 CDT, E04 parser file time 01:30:11):** the same 172 inputs plus 4 new class vectors (255 characters, and 129, 256 and 257 astral characters), 176 in total. They agree on all 176, and every rejection is the expected error type.
  * **Re-run after the UTF-16 ruling (01:40 CDT, same E04 file, 01:30:11):** 185 inputs (the 176 plus 9 class vectors: 128 emoji; 254/255 ASCII + 1 emoji; 2/3 ASCII + 127 emoji; 4 lone-surrogate strings). 181 agree, **4 disagree**, all because E04 still counts `len()` code points: 129 emoji (258 units), 256 emoji (512 units), 255 ASCII + 1 emoji (257 units) and 3 ASCII + 127 emoji (257 units). The verifier rejects all four with `INVALID_ARGUMENT`; E04 accepts them. Both reject lone surrogates. For E01 to pass to E04.
* **Incomplete Explorer enumeration (CONTRACTS §5, E01 ruling of 2026-10-19 01:36 CDT).** `shell_windows()` returns a `ShellWindowList` with `complete` and `skipped`. The Win32 backend sets `complete=False` when it skips an entry whose HWND/FullName can't be read, and returns an empty incomplete list when the enumeration itself fails. A plain `list` from any implementation counts as incomplete. The snapshot records `explorer_complete`. Decisions that need the full list run only when both the before and the current enumerations are complete; otherwise they fail closed:
  * target choice: the new-window diff, "foreground root and no other new window", "only window already at Downloads" and the ambiguity candidate list are skipped (`TargetSelection.how = "enumeration_incomplete"`, no candidates, no question). Positive evidence still counts: the pinned target or the hwnd the tool reported, if present in the list;
  * folder observation: a window whose entries came from an incomplete list is used only if the active tab handle matches one entry; otherwise status `incomplete` and EXP-06 is UNKNOWN;
  * EXP-08 new-window count: UNKNOWN (non-critical);
  * `resolve_target` (`targetId`): a target missing from an incomplete list is `NOT_FOUND` with reason `enumeration_incomplete`;
  * no recovery: nothing is recoverable once the target selection is incomplete, so the tool is never re-invoked.
  * **Error code (flagged to E01):** §5 names no code or decision for `complete:false`. E11's choice: a critical check left unresolved by an incomplete enumeration triggers **stop** (`policy.triggers_stop`). After dispatch the code is `POSTCONDITION_UNKNOWN` (sideEffect not none, `retryable:false`); before dispatch `PRECONDITION_FAILED`.
  * **No foreground window** reads as not-foreground only in non-critical checks (EXP-07, `critical=False`). It never selects a target: the foreground rule needs a real root window. A test runs the same workflow with and without a foreground window and asserts every critical check has the same status and every check sourced from `GetForegroundWindow` is non-critical.
* `WindowRegistry` protocol: `identify(hwnd) -> WindowIdentity | None` and `is_alive(identity) -> bool`.
* `LocalWindowRegistry(api)` is the interim adapter. It is injected everywhere as `window_registry=`, so swapping in E04's module is one adapter.

What the verifier needs from E04's module:
1. **Entry fields:** `hwnd` (top-level, `GA_ROOT`), `pid` (GetWindowThreadProcessId), `windowClass` (GetClassNameW, exact case) and `processStartTime` (`GetProcessTimes` creation time as a FILETIME integer of 100 ns ticks since 1601, read with `PROCESS_QUERY_LIMITED_INFORMATION`, value `(dwHighDateTime << 32) | dwLowDateTime`). In memory these are integers. In anything serialized, `hwnd`, `pid` and `processStartTime` must be canonical positive decimal strings with no leading zeros (`"0"` is invalid), never JSON numbers (CONTRACTS §3.3). When parsing, reject non-strings, zero, signs, leading zeros, whitespace and non-digits with `INVALID_ARGUMENT`. A field that can't be read must surface as "unreadable" (no identity), never as a default such as `0` or `""`. K8's MAC input uses the same canonical strings (§3.3, sorted-key canonical JSON). The verifier compares fields by equality after parsing.
2. **`identify(hwnd)`:** returns the *current* identity of a live top-level window, or none. It is cheap enough to call on every poll (≈ every 200 ms during verification). It must not use the window title.
3. **`is_alive(identity)`:** true only if the same HWND exists **and** pid, class and process start time all still match. Any mismatch counts as closed. It must never raise for a dead handle. If the start time can't be read (access denied, process gone), it returns not alive / no identity, never a partial identity.
4. **Process image path** (QueryFullProcessImageName) for a given identity, or a way to get it. EXP-03 needs `explorer.exe`, and it would be cleaner to have it in the entry than to look it up separately.
5. **Thread-safety** for calls from the verifier's poll loop while the tool runs, and **no COM requirement** on the caller for identify/is_alive (plain Win32).
6. **Stable, JSON-serializable identity** for the approval hash and for the task-scoped candidate registry (`candidates.py` stores identities, not bare HWNDs).
7. **Accepted V1 residual risk (E01 2026-10-19):** the 4-field identity can't tell apart a window that the **same process** destroys and re-creates with the same class while Windows recycles the same HWND value. Nothing is required from E04 for V1. A per-window creation stamp (for example a registry sequence number assigned at first sight) could close it later. The verifier limits the impact by re-observing the postcondition after every action (§16 M3).
8. **Re-resolution at use time**, so callers can do the TOCTOU re-check immediately before acting (§16).

Explorer-specific lookups (IShellWindows entries, active tab, folder path) stay in the verifier's `WindowsApi`. They aren't part of the registry contract.

**Lint:** ruff is pinned to 0.17.1 (`required-version`). The select list is ruff 0.17.1's 407 default rules, written out, plus E501 at line-length 100.

## 16. TOCTOU test plan (RISKS R23, owner E11; ADR-0017 Decision 8 and Consequences)

**Risk.** The target changes between verification or approval and the action, so the action lands on a different window than the one that was checked or approved. Windows reuses HWND and PID values, so a matching handle alone proves nothing.

**Mitigations:**
* **M1. Identity re-check immediately before acting.** The identity is `{hwnd, pid, windowClass, processStartTime}`. It is re-resolved:
  * at `targetId` resolution;
  * at `precheck` immediately before the first dispatch;
  * before every re-invoke of the E04 tool for a pinned target;
  * before asking the gate for a recovery primitive (compared with the identity the last observation saw);
  * once more after the gate answers and right before the Win32 call.

  Any mismatch, or an identity that can't be read, means nothing is sent.
* **M2. Single-use tokens consumed before execution.** The verifier asks the gate for every primitive call and never caches an approval, and it passes the resolved identity so the token/approval hash binds to it. Minting, consuming, expiring and revoking tokens is K8's job (E08, ADR-0017 §3–5).
* **M3. `POSTCONDITION_UNKNOWN` when the result can't be observed after the action** (`sideEffect:unknown`, not retryable, never re-invoked against a changed or vanished target).

Tests (✅ implemented with fakes in `tests/test_toctou.py` and `tests/test_window_gone_and_args.py`; 📋 planned, with the owner it depends on):

| ID | Scenario | M1: before acting | M2: token | M3: after acting |
|---|---|---|---|---|
| T1 | HWND reused by a **new process** (pid + start time change) | ✅ at resolution → `NOT_FOUND`; before dispatch → `PRECONDITION_FAILED`/`none`; before recovery primitive → not called, gate not asked | 📋 E08: K8 denies a token whose identity differs (`window_mismatch`) | ✅ pinned identity changes after dispatch → `POSTCONDITION_UNKNOWN`/`unknown` |
| T2 | **Same pid, new process start time** (PID recycled) | ✅ same three checkpoints as T1 | 📋 E08: ADR-0017 gate test 6 | ✅ as T1 |
| T3 | **Window class change** on the same hwnd/pid | ✅ same three checkpoints as T1 | 📋 E08: gate test 1 | ✅ as T1 |
| T4 | Window **closes (or changes) between approval and action** | ✅ gate approves, then the window closes or changes → primitive not called (`identity_changed_after_approval`); `targetId` window closes after resolution → `PRECONDITION_FAILED`; pinned window changes before re-invoke → no second dispatch | 📋 E08: approval expiry (60 s / 120 s) and revocation on cancel, panic-stop, mute, Quit, lock (ADR-0017 §5); 📋 coordinator (E03): approval hash recomputed with the identity at dispatch | ✅ closes after dispatch → `POSTCONDITION_UNKNOWN` |
| T5 | **Token replay** | ✅ the verifier asks the gate on every attempt (no cached approval). With a single-use test gate, the second identical primitive is denied and executed only once | 📋 E08: real K8 HMAC token (`parentActionId`, nonce, consumed before use), audit records; 📋 E04: tool server re-checks the token before the Win32 call (ADR-0009 CR6) and returns `DENIED_BY_POLICY` on replay | n/a |
| T6 | **Result becomes unobservable** after the action | n/a | n/a | ✅ IShellWindows stops answering after dispatch → `POSTCONDITION_UNKNOWN`/`unknown`, not retryable; ✅ an unpinned target that no longer exists → unknown, not failed (`check_exists`); 📋 Windows: COM/UIA failure modes on real Explorer (DOT-031, W1-S2) |
| T7 | **Start time unreadable** (access denied, process exiting) | ✅ fail-closed: window not offered as a candidate; an id issued earlier → `NOT_FOUND`; before dispatch → `PRECONDITION_FAILED` | 📋 E08: K8 refuses to mint without a full identity | ✅ unreadable after dispatch → `POSTCONDITION_UNKNOWN` |

Planned work that needs others:
* **E04:** shared registry with `processStartTime` (§15 list). The tool server checks identity and token itself, immediately before its Win32 call (ADR-0009 CR6). The same-process re-creation gap (§15 item 7).
* **E08:** K8 token mint/consume/expiry/revocation and the ADR-0017 gate tests 1–10. The production `recovery_gate`. **An explicit shell-navigate deny-list entry (ADR-0017 test 9, E01 2026-10-19):** the verifier still routes its `shell_navigate` rung through `recovery_gate`, so its denial in production depends on E08. Locally it is denied only by the deny-by-default gate. K8's MAC input must use the canonical decimal-string identity encoding (§15). Today it is still deny-by-default, because ADR-0017 is only Proposed.
* **Coordinator (E03):** recompute the approval `actionId` hash with the identity at dispatch, and revoke on cancel.
* **Windows (<TEST-PC>):** real HWND/PID reuse (close and reopen Explorer; restart `explorer.exe`), `GetProcessTimes` on elevated or protected processes, and an e2e run of T1–T7.

**Accepted V1 residual risks (E01 2026-10-19):**
* **Same-process re-creation:** a window destroyed and re-created by the same process with the same class, on a recycled HWND value, has an identical 4-field identity and passes every M1 check. This is not tested as a TOCTOU case. M3 (re-observing the postcondition) is the only mitigation.
* **Residual window.** A gap of microseconds remains between the last identity read and the Win32 call itself. It is accepted (ADR-0017 Consequences) because the window actions are non-destructive and the postcondition is always re-observed afterwards (M3).

