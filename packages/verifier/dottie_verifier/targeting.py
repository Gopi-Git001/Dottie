"""Multi-monitor, per-monitor-DPI targeting by window handle.

Coordinates are a last-resort fallback (spec section 11: UIA -> app API -> browser -> coords).
When they are used, the point is derived from the target HWND's own frame and DPI, and
hit-tested back to that HWND before any input is sent. Raw screen coordinates are never accepted.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from dottie_verifier.model import VerificationReport
from dottie_verifier.winapi import MonitorInfo, Rect, WindowsApi
from dottie_verifier.workflow import precondition_failed_report

PER_MONITOR_V2 = "per_monitor_v2"


def monitor_for_rect(monitors: list[MonitorInfo], rect: Rect) -> MonitorInfo | None:
    """The monitor with the largest intersection (MonitorFromRect MONITOR_DEFAULTTONULL
    semantics)."""
    best, area = None, 0
    for m in monitors:
        a = rect.intersection_area(m.rect)
        if a > area:
            best, area = m, a
    return best


def dip_to_physical(window_rect: Rect, dpi: int, x_dip: float, y_dip: float) -> tuple[int, int]:
    """Window-relative DIPs (96-DPI units) to physical virtual-screen pixels for that window's
    DPI."""
    scale = dpi / 96.0
    return window_rect.left + round(x_dip * scale), window_rect.top + round(y_dip * scale)


def virtual_screen(monitors: list[MonitorInfo]) -> Rect:
    return Rect(min(m.rect.left for m in monitors), min(m.rect.top for m in monitors),
                max(m.rect.right for m in monitors), max(m.rect.bottom for m in monitors))


@dataclass(frozen=True)
class TargetPoint:
    ok: bool
    x: int = 0
    y: int = 0
    monitor: int | None = None
    dpi: int | None = None
    reason: str = ""
    # Machine-readable refusal code (e.g. ``dpi_unreadable``); empty when ok.
    code: str = ""

    def to_dict(self) -> dict:
        return {"ok": self.ok, "x": self.x, "y": self.y, "monitor": self.monitor,
                "dpi": self.dpi, "reason": self.reason, "code": self.code}


def resolve_window_point(api: WindowsApi, hwnd: int, x_dip: float, y_dip: float) -> TargetPoint:
    """Translate a window-relative point and prove it lands on ``hwnd``. Refuse otherwise.

    Fail-closed (CONTRACTS §5): unreadable DPI, cloaked state or frame never fall back to a
    default; the point is refused and the caller reports PRECONDITION_FAILED."""
    awareness = api.process_dpi_awareness()
    if awareness != PER_MONITOR_V2:
        return TargetPoint(False, reason=f"process DPI awareness is {awareness!r}; "
                                         "coordinates would be virtualized", code="not_pmv2")
    st = api.window_state(hwnd)
    if not st.exists:
        return TargetPoint(False, reason="window no longer exists", code="window_gone")
    if st.cloaked is None:
        return TargetPoint(False, reason="cloaked state could not be read; window not actionable",
                           code="cloaked_unreadable")
    if st.minimized or not st.visible or st.cloaked:
        return TargetPoint(False, reason="window is minimized, hidden or cloaked",
                           code="not_visible")
    if st.dpi is None or st.dpi <= 0:
        return TargetPoint(False, reason="window DPI could not be read; no 96-DPI fallback",
                           code="dpi_unreadable")
    if st.rect is None or st.rect.empty:
        return TargetPoint(False, reason="window has no frame bounds", code="no_frame")
    x, y = dip_to_physical(st.rect, st.dpi, x_dip, y_dip)
    if not st.rect.contains(x, y):
        return TargetPoint(False, x, y, reason="point falls outside the window frame",
                           code="outside_frame")
    monitor = next((m for m in api.monitors() if m.rect.contains(x, y)), None)
    if monitor is None:
        return TargetPoint(False, x, y, reason="point is not on any connected monitor",
                           code="off_monitor")
    hit = api.window_from_point(x, y)
    if api.root_window(hit) != hwnd:
        return TargetPoint(False, x, y, monitor.handle, st.dpi,
                           reason=f"point is occluded by hwnd {hit}", code="occluded")
    return TargetPoint(True, x, y, monitor.handle, st.dpi, "hit-test confirmed target window")


def coordinate_action(api: WindowsApi, hwnd: int, x_dip: float, y_dip: float,
                      send: Callable[[int, int], dict[str, Any]],
                      workflow: str = "coordinate_fallback") -> tuple[VerificationReport | None,
                                                                      dict[str, Any] | None]:
    """The only way to send a coordinate input: resolve and hit-test first; ``send`` (the tool
    call) runs only for a confirmed point. A refused point returns a PRECONDITION_FAILED report
    with ``sideEffect: none`` and ``send`` is never called. Returns ``(refusal, tool_result)``;
    exactly one is not None. The caller verifies the tool result's postconditions."""
    point = resolve_window_point(api, hwnd, x_dip, y_dip)
    if not point.ok:
        return precondition_failed_report(workflow, point.code or "refused", point.reason,
                                          point.to_dict()), None
    return None, send(point.x, point.y)
