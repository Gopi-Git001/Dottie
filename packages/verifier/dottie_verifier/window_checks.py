"""Reusable window postconditions, addressed by HWND and process (never by title)."""

from __future__ import annotations

import ntpath

from dottie_verifier.model import Check, CheckStatus
from dottie_verifier.winapi import WindowsApi, WindowState


def state_evidence(state: WindowState) -> dict:
    return {
        "hwnd": state.hwnd,
        "exists": state.exists,
        "visible": state.visible,
        "minimized": state.minimized,
        "cloaked": state.cloaked,
        "class_name": state.class_name,
        "pid": state.pid,
        "process_image": state.process_image,
        "rect": state.rect.to_list() if state.rect else None,
        "monitor": state.monitor,
        "dpi": state.dpi,
        "title_for_evidence_only": state.title,
    }


def check_exists(check_id: str, state: WindowState | None, how: str) -> Check:
    desc = "Target window identified by HWND and still exists"
    if state is None:
        return Check(check_id, desc, CheckStatus.UNKNOWN, evidence={"identified_by": how})
    if not state.exists:
        # Gone after the action was sent: the outcome is unknown, not failed (CONTRACTS v2 §5,
        # E04 review rule -> POSTCONDITION_UNKNOWN, sideEffect unknown).
        return Check(check_id, desc, CheckStatus.UNKNOWN,
                     evidence={"identified_by": how, "hwnd": state.hwnd, "target_gone": True},
                     source="IsWindow")
    return Check(check_id, desc, CheckStatus.PASS, evidence={"identified_by": how,
                                                             "hwnd": state.hwnd},
                 source="IsWindow")


def check_process(check_id: str, state: WindowState | None, images: set[str],
                  classes: set[str] | None = None) -> Check:
    desc = f"Window belongs to process {sorted(images)}" + (
        f" with class {sorted(classes)}" if classes else "")
    if state is None or not state.exists:
        return Check(check_id, desc, CheckStatus.UNKNOWN)
    image = ntpath.basename(state.process_image).casefold()
    image_ok = image in {i.casefold() for i in images}
    class_ok = classes is None or state.class_name in classes
    if not state.process_image:
        status = CheckStatus.UNKNOWN
    else:
        status = CheckStatus.PASS if image_ok and class_ok else CheckStatus.FAIL
    return Check(check_id, desc, status,
                 evidence={"pid": state.pid, "process_image": state.process_image,
                           "class_name": state.class_name},
                 source="GetWindowThreadProcessId+QueryFullProcessImageName+GetClassName")


def check_not_minimized(check_id: str, state: WindowState | None) -> Check:
    desc = "Window is not minimized"
    if state is None or not state.exists:
        return Check(check_id, desc, CheckStatus.UNKNOWN)
    return Check(check_id, desc, CheckStatus.FAIL if state.minimized else CheckStatus.PASS,
                 evidence={"minimized": state.minimized}, source="IsIconic")


def check_visible_on_monitor(check_id: str, state: WindowState | None, api: WindowsApi) -> Check:
    desc = "Window is visible, not cloaked, and intersects a connected monitor"
    if state is None or not state.exists:
        return Check(check_id, desc, CheckStatus.UNKNOWN)
    monitors = api.monitors()
    area = 0
    if state.rect is not None:
        area = max((state.rect.intersection_area(m.rect) for m in monitors), default=0)
    ok = (state.visible and state.cloaked is False and state.rect is not None
          and not state.rect.empty and state.monitor is not None and area > 0)
    reason = []
    if state.cloaked is None or state.rect is None:
        # A failed read is not an observation (CONTRACTS §5 "Fail-closed observations").
        unreadable = [n for n, v in (("cloaked_unreadable", state.cloaked),
                                     ("rect_unreadable", state.rect)) if v is None]
        return Check(check_id, desc, CheckStatus.UNKNOWN,
                     evidence={"visible": state.visible, "cloaked": state.cloaked,
                               "rect": state.rect.to_list() if state.rect else None,
                               "monitor": state.monitor, "reasons": unreadable,
                               "not_actionable": True},
                     source="IsWindowVisible+DWMWA_CLOAKED+MonitorFromWindow")
    if not state.visible:
        reason.append("not_visible")
    if state.cloaked:
        reason.append("cloaked")
    if state.rect.empty:
        reason.append("empty_rect")
    if state.monitor is None or area == 0:
        reason.append("off_screen")
    return Check(check_id, desc, CheckStatus.PASS if ok else CheckStatus.FAIL,
                 evidence={"visible": state.visible, "cloaked": state.cloaked,
                           "rect": state.rect.to_list() if state.rect else None,
                           "monitor": state.monitor, "visible_area_px": area,
                           "reasons": reason},
                 source="IsWindowVisible+DWMWA_CLOAKED+MonitorFromWindow")


def check_foreground(check_id: str, state: WindowState | None, api: WindowsApi,
                     critical: bool = False) -> Check:
    desc = "Window is the foreground window"
    if state is None or not state.exists:
        return Check(check_id, desc, CheckStatus.UNKNOWN, critical=critical)
    fg = api.foreground_window()
    fg_root = api.root_window(fg) if fg else 0
    ok = fg_root == state.hwnd
    return Check(check_id, desc, CheckStatus.PASS if ok else CheckStatus.FAIL, critical=critical,
                 evidence={"foreground_hwnd": fg, "foreground_root": fg_root},
                 source="GetForegroundWindow+GetAncestor(GA_ROOT)")
