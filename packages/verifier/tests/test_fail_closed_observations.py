"""Fail-closed observations (CONTRACTS §3.3 windowClass 1-256; §5 "Fail-closed observations",
E01 2026-10-19) and the DPI matrix box cases (e11-cur-multimonitor-dpi-matrix skill; docs
verifier-design §8.1 ids DPI-B*)."""

import pytest

from dottie_verifier.candidates import CandidateRegistry
from dottie_verifier.contract import error_code, is_retryable, to_structured_content
from dottie_verifier.explorer_workflow import OpenExplorerKnownFolder, allow_all
from dottie_verifier.targeting import coordinate_action, monitor_for_rect, resolve_window_point
from dottie_verifier.winapi import MonitorInfo, Rect, WindowState
from dottie_verifier.window_checks import check_visible_on_monitor
from dottie_verifier.window_identity import (
    MAX_CLASS_LEN,
    InvalidArgumentError,
    LocalWindowRegistry,
    WindowIdentity,
)
from dottie_verifier.workflow import ActionContext
from tests.fakes import FakeE04Tools
from tests.test_window_gone_and_args import open_dl

DOCS = r"C:\Users\<user>\Documents"
PICS = r"C:\Users\<user>\Pictures"
WIRE = {"hwnd": "4112", "pid": "4242", "windowClass": "CabinetWClass",
        "processStartTime": "133700000000000001"}


# --- windowClass 1-256 UTF-16 code units (CONTRACTS §3.3); non-BMP vectors live in
# --- test_enumeration_and_class_units.py ---------------------------------------------------------

@pytest.mark.parametrize("cls", ["C", "C" * 255, "C" * MAX_CLASS_LEN, "Ünïcødé", " "])
def test_window_class_of_1_to_256_utf16_units_is_accepted(cls):
    assert WindowIdentity.from_contract({**WIRE, "windowClass": cls}).window_class == cls
    assert WindowIdentity(1, 1, cls, 1).window_class == cls


@pytest.mark.parametrize("cls", ["", "C" * 257, "C" * 5000, None, 7, b"Cabinet"], ids=repr)
def test_window_class_empty_too_long_or_not_a_string_is_invalid_argument(cls):
    with pytest.raises(InvalidArgumentError):
        WindowIdentity.from_contract({**WIRE, "windowClass": cls})
    with pytest.raises(InvalidArgumentError):
        WindowIdentity(1, 1, cls, 1)


@pytest.mark.parametrize("cls", ["", "C" * 257, None])
def test_backend_class_out_of_range_means_no_identity_and_not_found(desktop, clock, cls):
    registry = CandidateRegistry(clock=clock)
    a = desktop.add_explorer(DOCS)
    desktop.add_explorer(PICS)
    first = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry))
    ids = [c["id"] for c in first["observedState"]["candidates"]]
    a.class_name = cls
    assert LocalWindowRegistry(desktop).identify(a.hwnd) is None
    sc = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry,
                                       target_id=ids[0]))
    assert sc["error"]["code"] == "NOT_FOUND" and sc["sideEffect"] == "none"


# --- no fail-open defaults in WindowState / MonitorInfo -----------------------------------------

def test_observation_fields_default_to_unreadable_not_to_a_plausible_value():
    st = WindowState(hwnd=0x10, exists=True)
    assert (st.dpi, st.cloaked, st.rect, st.monitor) == (None, None, None, None)
    m = MonitorInfo(1, "d", Rect(0, 0, 10, 10), Rect(0, 0, 10, 10), None)
    assert m.scale is None


# --- DPI / cloaked unreadable -> PRECONDITION_FAILED, sideEffect none, tool never called ------

def _send_spy():
    sent = []

    def send(x, y):
        sent.append((x, y))
        return {"success": True}
    return sent, send


@pytest.mark.parametrize(("attr", "value", "code"), [
    ("dpi", None, "dpi_unreadable"), ("dpi", 0, "dpi_unreadable"),
    ("cloaked", None, "cloaked_unreadable"),
])
def test_coordinate_action_refused_on_unreadable_observation(desktop, attr, value, code):
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(0, 0, 800, 600))
    setattr(w, attr, value)
    point = resolve_window_point(desktop, w.hwnd, 10, 10)
    assert not point.ok and point.code == code
    sent, send = _send_spy()
    refusal, result = coordinate_action(desktop, w.hwnd, 10, 10, send)
    assert sent == [] and result is None                 # the tool is never called
    sc = to_structured_content(refusal)
    assert error_code(refusal) == "PRECONDITION_FAILED"
    assert sc["sideEffect"] == "none" and sc["verified"] is False
    assert refusal.tool_invoked is False and refusal.checks[0].evidence["code"] == code
    assert sc["error"]["code"] == "PRECONDITION_FAILED"
    assert sc["error"]["retryable"] is is_retryable(refusal, "PRECONDITION_FAILED") is False


def test_coordinate_action_sends_only_a_confirmed_point(desktop):
    desktop.add_monitor(2, Rect(-2880, 0, 0, 1620), dpi=144)
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(-2500, 100, -1000, 1200), dpi=144)
    sent, send = _send_spy()
    refusal, result = coordinate_action(desktop, w.hwnd, 100, 40, send)
    assert refusal is None and result == {"success": True} and sent == [(-2350, 160)]


def test_dpi_is_never_defaulted_to_96(desktop):
    # A 150% window whose DPI read fails would land at the wrong pixel with a 96 fallback.
    desktop.add_monitor(2, Rect(-2880, 0, 0, 1620), dpi=144)
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(-2500, 100, -1000, 1200), dpi=None)
    t = resolve_window_point(desktop, w.hwnd, 100, 40)
    assert not t.ok and t.code == "dpi_unreadable" and (t.x, t.y) == (0, 0)


def test_pinned_window_with_unreadable_cloaked_state_is_precondition_failed(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    a = desktop.add_explorer(DOCS)
    desktop.add_explorer(PICS)
    first = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry))
    ids = [c["id"] for c in first["observedState"]["candidates"]]
    target = ids[0]
    a.cloaked = None
    tools = FakeE04Tools(desktop)
    report = open_dl(desktop, clock, tools, registry, target_id=target)
    sc = to_structured_content(report)
    assert sc["error"]["code"] == "PRECONDITION_FAILED" and sc["sideEffect"] == "none"
    assert tools.calls == [] and report.tool_invoked is False
    assert report.checks[0].evidence["code"] == "cloaked_unreadable"


def test_recovery_primitive_not_run_when_cloaked_state_unreadable(desktop):
    w = desktop.add_explorer(DOCS, foreground=True, minimized=True)
    wf = OpenExplorerKnownFolder(desktop, FakeE04Tools(desktop), recovery_gate=allow_all)
    ctx = ActionContext(before=wf.snapshot(), started_at=0.0)
    ctx.tool_result = {"success": True, "hwnd": w.hwnd}
    checks = wf.verify(ctx)
    w.cloaked = None                  # read fails between observation and recovery
    steps = wf.recover(checks, ctx, 1)
    assert any(s.startswith("precondition_failed:restore_window(cloaked_unreadable)")
               for s in steps)
    assert not any(c.startswith("restore:") for c in desktop.calls)


@pytest.mark.parametrize(("attr", "reason"), [("cloaked", "cloaked_unreadable"),
                                              ("rect", "rect_unreadable")])
def test_visibility_check_is_unknown_not_fail_and_nothing_is_moved(desktop, clock, attr, reason):
    w = desktop.add_explorer(r"C:\Users\<user>\Downloads", foreground=True)
    setattr(w, attr, None)
    state = desktop.window_state(w.hwnd)
    check = check_visible_on_monitor("EXP-05", state, desktop)
    assert check.status.value == "unknown" and reason in check.evidence["reasons"]
    report = open_dl(desktop, clock, FakeE04Tools(desktop), CandidateRegistry(clock=clock))
    assert not any(c.startswith(("move:", "restore:")) for c in desktop.calls)
    assert report.verified is False


# --- DPI matrix box cases (verifier-design §8.1) ----------------------------------------------

def test_dpi_b8_monitor_above_primary_negative_y(desktop):
    desktop.add_monitor(2, Rect(0, -1620, 2880, 0), dpi=144)
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(100, -1500, 1600, -400), dpi=144)
    t = resolve_window_point(desktop, w.hwnd, 100, 40)
    assert t.ok and (t.x, t.y) == (250, -1440) and t.monitor == 2


def test_dpi_b9_mixed_dpi_uses_window_dpi_not_monitor_or_primary(desktop):
    # Monitor DPI unreadable must not matter: the window's own DPI is the only scale used.
    desktop.add_monitor(2, Rect(1920, 0, 4800, 1620), dpi=None)
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(2000, 100, 3500, 1200), dpi=144)
    t = resolve_window_point(desktop, w.hwnd, 100, 40)
    assert t.ok and (t.x, t.y) == (2150, 160) and t.dpi == 144


def test_dpi_b10_window_spanning_monitors_point_on_other_monitor(desktop):
    desktop.add_monitor(2, Rect(1920, 0, 4800, 1620), dpi=144)
    # Mostly on monitor 1 (96 DPI per GetDpiForWindow), right edge crosses onto monitor 2.
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(1000, 100, 2200, 900), dpi=96)
    assert monitor_for_rect(desktop.monitors(), w.rect).handle == 1
    t = resolve_window_point(desktop, w.hwnd, 1100, 10)      # x=2100: on monitor 2
    assert t.ok and t.monitor == 2 and t.dpi == 96


def test_dpi_b11_monitor_unplugged_mid_task_refuses_then_moves_by_hwnd(desktop, clock):
    desktop.add_monitor(2, Rect(-2880, 0, 0, 1620), dpi=144)
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(-2500, 100, -1000, 1200), dpi=144)
    assert resolve_window_point(desktop, w.hwnd, 100, 40).ok
    desktop.monitor_list = [m for m in desktop.monitor_list if m.handle != 2]   # unplugged
    sent, send = _send_spy()
    refusal, _ = coordinate_action(desktop, w.hwnd, 100, 40, send)
    assert sent == [] and error_code(refusal) == "PRECONDITION_FAILED"
    assert refusal.checks[0].evidence["code"] == "off_monitor"


def test_dpi_b12_dpi_change_between_resolve_and_send_is_rechecked(desktop):
    # coordinate_action resolves immediately before send, so a DPI change (user changed scaling,
    # window dragged to another monitor) is seen at send time, never served from a cache.
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(0, 0, 800, 600), dpi=96)
    assert resolve_window_point(desktop, w.hwnd, 100, 40).x == 100
    w.dpi = 144
    sent, send = _send_spy()
    coordinate_action(desktop, w.hwnd, 100, 40, send)
    assert sent == [(150, 60)]
