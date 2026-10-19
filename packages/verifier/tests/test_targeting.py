from dottie_verifier.targeting import (
    dip_to_physical,
    monitor_for_rect,
    resolve_window_point,
    virtual_screen,
)
from dottie_verifier.winapi import Rect


def test_dip_scaling_on_150_percent_monitor_left_of_primary():
    assert dip_to_physical(Rect(-2500, 100, -1000, 1200), 144, 100, 40) == (-2350, 160)


def test_monitor_for_rect_picks_largest_overlap(desktop):
    desktop.add_monitor(2, Rect(1920, 0, 4480, 1440), dpi=120)
    m = monitor_for_rect(desktop.monitors(), Rect(1800, 100, 2600, 700))
    assert m.handle == 2
    assert monitor_for_rect(desktop.monitors(), Rect(9000, 0, 9100, 100)) is None
    assert virtual_screen(desktop.monitors()) == Rect(0, 0, 4480, 1440)


def test_point_resolved_and_hit_tested_on_secondary_monitor(desktop):
    desktop.add_monitor(2, Rect(-2880, 0, 0, 1620), dpi=144)
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(-2500, 100, -1000, 1200), dpi=144)
    t = resolve_window_point(desktop, w.hwnd, 100, 40)
    assert t.ok and (t.x, t.y) == (-2350, 160) and t.monitor == 2


def test_refuses_when_not_per_monitor_v2(desktop):
    w = desktop.add_explorer("C:\\", foreground=True)
    desktop.awareness = "system"
    t = resolve_window_point(desktop, w.hwnd, 10, 10)
    assert not t.ok and "virtualized" in t.reason


def test_refuses_occluded_point(desktop):
    behind = desktop.add_explorer("C:\\", rect=Rect(0, 0, 800, 600))
    desktop.add_explorer("D:\\", foreground=True, rect=Rect(0, 0, 800, 600))
    t = resolve_window_point(desktop, behind.hwnd, 50, 50)
    assert not t.ok and "occluded" in t.reason


def test_refuses_outside_frame_minimized_and_missing(desktop):
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(0, 0, 200, 200))
    assert "outside" in resolve_window_point(desktop, w.hwnd, 500, 10).reason
    w.minimized = True
    assert "minimized" in resolve_window_point(desktop, w.hwnd, 10, 10).reason
    assert "no longer exists" in resolve_window_point(desktop, 999, 1, 1).reason


def test_refuses_point_in_gap_between_monitors(desktop):
    desktop.add_monitor(2, Rect(2000, 0, 3000, 1000))
    w = desktop.add_explorer("C:\\", foreground=True, rect=Rect(1800, 0, 2200, 400))
    t = resolve_window_point(desktop, w.hwnd, 150, 10)   # x=1950: in the gap
    assert not t.ok and "monitor" in t.reason
