"""File Explorer observation and the first-demo postconditions.

Demo: "Dottie, open File Explorer and go to Downloads".
The current folder is read from IShellWindows (Document.Folder.Self.Path, then LocationURL),
with the UIA address bar as a fallback. The window title is never used.
"""

from __future__ import annotations

import ntpath
from dataclasses import dataclass, field

from dottie_verifier.known_folders import ResolvedFolder, resolve_known_folder
from dottie_verifier.model import Check, CheckStatus
from dottie_verifier.paths import file_url_to_path, normalize, same_path
from dottie_verifier.winapi import (
    ShellWindowEntry,
    WindowsApi,
    WindowState,
    enumeration_complete,
)
from dottie_verifier.window_checks import (
    check_exists,
    check_foreground,
    check_not_minimized,
    check_process,
    check_visible_on_monitor,
)

EXPLORER_IMAGE = "explorer.exe"
EXPLORER_CLASSES = {"CabinetWClass", "ExploreWClass"}


def explorer_enumeration(api: WindowsApi) -> tuple[list[ShellWindowEntry], bool]:
    """Explorer entries plus whether the enumeration was complete (CONTRACTS §5: an enumeration
    that skipped an unreadable entry is ``complete:false``)."""
    raw = api.shell_windows()
    entries = [e for e in raw if ntpath.basename(e.full_name).casefold() == EXPLORER_IMAGE]
    return entries, enumeration_complete(raw)


def explorer_entries(api: WindowsApi) -> list[ShellWindowEntry]:
    return explorer_enumeration(api)[0]


def explorer_hwnds(api: WindowsApi) -> set[int]:
    return {e.hwnd for e in explorer_entries(api)}


def explorer_snapshot(api: WindowsApi) -> tuple[set[int], bool]:
    entries, complete = explorer_enumeration(api)
    return {e.hwnd for e in entries}, complete


@dataclass
class FolderObservation:
    path: str = ""
    source: str = ""
    status: str = "missing"        # ok | missing | virtual | ambiguous | conflict | incomplete
    reason: str = ""
    candidates: list[dict] = field(default_factory=list)

    def evidence(self) -> dict:
        return {"observed_path": self.path, "observed_source": self.source,
                "observation_status": self.status, "reason": self.reason,
                "candidates": self.candidates}


def _entry_dict(e: ShellWindowEntry) -> dict:
    return {"hwnd": e.hwnd, "tab_hwnd": e.tab_hwnd, "folder_path": e.folder_path,
            "location_url": e.location_url, "location_name": e.location_name}


def _entry_path(e: ShellWindowEntry) -> tuple[str, str]:
    if normalize(e.folder_path):
        return e.folder_path, "IShellWindows.Document.Folder.Self.Path"
    url_path = file_url_to_path(e.location_url)
    if normalize(url_path):
        return url_path, "IShellWindows.LocationURL"
    return "", ""


def observe_folder(api: WindowsApi, hwnd: int) -> FolderObservation:
    """Read the folder shown by the active tab of Explorer window ``hwnd``."""
    all_entries, complete = explorer_enumeration(api)
    entries = [e for e in all_entries if e.hwnd == hwnd]
    obs = FolderObservation(candidates=[_entry_dict(e) for e in entries])
    if entries and not complete:
        # A skipped entry may be another tab of this window, so "the only tab" can't be
        # trusted. Only an entry that matches the active tab handle is usable.
        active = api.active_tab(hwnd)
        by_tab = [e for e in entries if active is not None and e.tab_hwnd == active]
        if len(by_tab) != 1:
            obs.status = "incomplete"
            obs.reason = "enumeration incomplete and the active tab can't be confirmed"
            return obs
        entries = by_tab
        obs.reason = "enumeration incomplete; active tab confirmed by tab HWND"

    if len(entries) > 1:
        active = api.active_tab(hwnd)
        by_tab = [e for e in entries if active is not None and e.tab_hwnd == active]
        if len(by_tab) == 1:
            entries = by_tab
            obs.reason = "active tab selected by IShellBrowser tab HWND"
        else:
            paths = {normalize(_entry_path(e)[0]) for e in entries}
            if len(paths) == 1 and "" not in paths:
                entries = entries[:1]
                obs.reason = "multiple tabs, all show the same folder"
            else:
                obs.status = "ambiguous"
                obs.reason = "multiple tabs show different folders and the active tab is unknown"
                return obs

    if entries:
        e = entries[0]
        primary = e.folder_path if normalize(e.folder_path) else ""
        url_path = file_url_to_path(e.location_url)
        if primary and normalize(url_path) and not same_path(primary, url_path, api.final_path):
            obs.status = "conflict"
            obs.reason = "Folder.Self.Path and LocationURL disagree"
            return obs
        path, source = _entry_path(e)
        if path:
            obs.path, obs.source, obs.status = path, source, "ok"
            return obs
        if e.folder_path.startswith("::{") or e.location_url.startswith("::{"):
            obs.status, obs.reason = "virtual", "Explorer shows a virtual shell location"
            return obs

    # Fallback: UIA address bar. Accept only an absolute filesystem path, never a breadcrumb label.
    try:
        value = api.uia_address_value(hwnd)
    except Exception as exc:  # noqa: BLE001
        value = None
        obs.reason = f"UIA address bar unavailable: {exc}"
    if value and normalize(value):
        obs.path, obs.source, obs.status = value, "UIA address bar ValuePattern", "ok"
        return obs
    if obs.status == "missing" and not obs.reason:
        obs.reason = "no IShellWindows entry or UIA path for this HWND"
    return obs


@dataclass
class TargetSelection:
    hwnd: int | None
    how: str
    candidates: list[int] = field(default_factory=list)
    ambiguous: bool = False
    enumeration_incomplete: bool = False


def identify_target(api: WindowsApi, tool_result: dict | None, before: set[int],
                    expected: ResolvedFolder | None = None,
                    pinned: int | None = None, pinned_gone: bool = False,
                    before_complete: bool = False) -> TargetSelection:
    """Pick the Explorer window to verify. Never by title; never a guess among several.

    ``pinned`` is the window the user chose via ``targetId``. It is the only acceptable
    target: if it is gone, the result is "unidentified" with no candidates (never a fallback
    to another window).

    Rules that need the full window list (new-window diff, "no other new window", "only window
    already at the target", ambiguity candidates) run only when both the before and the
    current enumerations are complete (CONTRACTS §5). Positive evidence (the pinned window, the
    hwnd the tool reported, present in the list) doesn't need the full list."""
    now, now_complete = explorer_snapshot(api)
    full = now_complete and before_complete
    if pinned is not None:
        if not pinned_gone and pinned in now:
            return TargetSelection(pinned, "user_selected_target")
        return TargetSelection(None, "user_selected_target_gone")
    reported = (tool_result or {}).get("hwnd")
    if isinstance(reported, int) and reported in now:
        return TargetSelection(reported, "tool_reported_hwnd")
    if not full:
        return TargetSelection(None, "enumeration_incomplete", enumeration_incomplete=True)
    fresh = sorted(now - before)
    if len(fresh) == 1:
        return TargetSelection(fresh[0], "new_window_since_action")
    fg = api.foreground_window()
    fg_root = api.root_window(fg) if fg else 0
    if fg_root in now and not fresh:
        return TargetSelection(fg_root, "foreground_explorer_window")
    if expected is not None and expected.path:
        at_target = [h for h in sorted(now)
                     if same_path(observe_folder(api, h).path, expected.path, api.final_path)]
        if len(at_target) == 1:
            return TargetSelection(at_target[0], "only_explorer_window_showing_target")
    candidates = fresh if fresh else sorted(now)
    return TargetSelection(None, "unidentified", candidates, ambiguous=len(candidates) > 1)


def check_folder(check_id: str, api: WindowsApi, hwnd: int | None, expected: ResolvedFolder,
                 samples: list[FolderObservation]) -> Check:
    desc = f"Current folder (active tab) resolves to Known Folder '{expected.name}'"
    ev = {**expected.evidence(), "samples": [s.evidence() for s in samples]}
    if hwnd is None or not expected.path or not samples:
        return Check(check_id, desc, CheckStatus.UNKNOWN, evidence=ev)
    statuses = {s.status for s in samples}
    if statuses & {"ambiguous", "conflict", "missing", "incomplete"}:
        if "ambiguous" in statuses:
            ev["ambiguous"] = True
        return Check(check_id, desc, CheckStatus.UNKNOWN, evidence=ev,
                     source=samples[-1].source)
    if "virtual" in statuses:
        return Check(check_id, desc, CheckStatus.FAIL, evidence=ev, source="IShellWindows")
    matches = [same_path(s.path, expected.path, api.final_path) for s in samples]
    ev["matches_per_sample"] = matches
    if all(matches):
        return Check(check_id, desc, CheckStatus.PASS, evidence=ev, source=samples[-1].source)
    if not any(matches):
        return Check(check_id, desc, CheckStatus.FAIL, evidence=ev, source=samples[-1].source)
    ev["reason"] = "observation not stable across samples"
    return Check(check_id, desc, CheckStatus.UNKNOWN, evidence=ev, source=samples[-1].source)


def check_window_hygiene(check_id: str, api: WindowsApi, before: set[int],
                         before_complete: bool = False) -> Check:
    desc = "Action opened at most one new Explorer window (spec section 11)"
    now, now_complete = explorer_snapshot(api)
    if not (now_complete and before_complete):
        # A diff of incomplete lists can't count new windows (CONTRACTS §5).
        return Check(check_id, desc, CheckStatus.UNKNOWN, critical=False,
                     evidence={"enumeration_incomplete": True,
                               "before_complete": before_complete,
                               "now_complete": now_complete},
                     source="IShellWindows diff")
    created = sorted(now - before)
    ok = len(created) <= 1
    return Check(check_id, desc, CheckStatus.PASS if ok else CheckStatus.FAIL, critical=False,
                 evidence={"new_explorer_hwnds": created, "before": sorted(before)},
                 source="IShellWindows diff")


def verify_explorer_at_known_folder(
    api: WindowsApi,
    folder: str,
    tool_result: dict | None,
    before: set[int],
    sample_count: int = 2,
    sleep=None,
    sample_interval: float = 0.25,
    pinned: int | None = None,
    pinned_gone: bool = False,
    before_complete: bool = False,
) -> tuple[list[Check], TargetSelection, WindowState | None]:
    """Postconditions EXP-01..EXP-08. Returns (checks, target, window_state)."""
    expected = resolve_known_folder(api, folder)
    checks: list[Check] = []
    checks.append(Check(
        "EXP-01", f"Known Folder '{folder}' resolved via SHGetKnownFolderPath and exists",
        CheckStatus.PASS if expected.path and expected.exists else
        (CheckStatus.FAIL if expected.path else CheckStatus.UNKNOWN),
        evidence=expected.evidence(), source="SHGetKnownFolderPath"))

    target = identify_target(api, tool_result, before, expected, pinned, pinned_gone,
                             before_complete)
    state = api.window_state(target.hwnd) if target.hwnd is not None else None
    exists = check_exists("EXP-02", state, target.how)
    if target.hwnd is None:
        exists.evidence.update({"candidates": target.candidates, "ambiguous": target.ambiguous})
    if target.enumeration_incomplete:
        exists.evidence["enumeration_incomplete"] = True
    if target.how == "user_selected_target_gone":
        exists.evidence["target_gone"] = True   # closed or handle reused after dispatch
    checks.append(exists)
    checks.append(check_process("EXP-03", state, {EXPLORER_IMAGE}, EXPLORER_CLASSES))
    checks.append(check_not_minimized("EXP-04", state))
    checks.append(check_visible_on_monitor("EXP-05", state, api))

    samples: list[FolderObservation] = []
    if target.hwnd is not None and state is not None and state.exists:
        for i in range(max(1, sample_count)):
            if i and sleep is not None:
                sleep(sample_interval)
            samples.append(observe_folder(api, target.hwnd))
    checks.append(check_folder("EXP-06", api, target.hwnd, expected, samples))
    checks.append(check_foreground("EXP-07", state, api, critical=False))
    checks.append(check_window_hygiene("EXP-08", api, before, before_complete))
    return checks, target, state
