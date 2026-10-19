"""Characterization of Bot's targeting gaps against a BEHAVIOUR MODEL (not Bot code). Strict xfail:
when the real lifted adapter (DOT-030) replaces the model, these flip to pass in the fix PR (DOT-031)."""
import pytest

from support.bot_model import as_v2, bot_open_downloads
from support.fakes import DOCS, DOWNLOADS, PICS


def test_bot_rejects_target_id_when_dispatcher_binds_signature(desktop):
    desktop.add(DOCS), desktop.add(PICS)
    out = bot_open_downloads(desktop, {"targetId": "c_123456789abc"}, strip_unknown_args=False)
    assert out["success"] is False and desktop.navigations == []     # current behaviour, passes today


@pytest.mark.xfail(strict=True, reason="DOT-031: Bot open_downloads ignores targetId/hwnd (E11 via E01)")
def test_bot_honours_pinned_window(desktop):
    a = desktop.add(DOCS)
    b = desktop.add(PICS, foreground=True)
    bot_open_downloads(desktop, {"hwnd": a.hwnd}, strip_unknown_args=True)
    assert desktop.navigations == [(a.hwnd, DOWNLOADS)]


@pytest.mark.xfail(strict=True, reason="DOT-031: Bot verifies any tab of the HWND, not the active tab")
def test_bot_background_tab_does_not_verify(desktop):
    desktop.add(DOCS, PICS, active=1, foreground=True)
    sc = as_v2(bot_open_downloads(desktop, {}, strip_unknown_args=True))
    assert sc["verified"] is False or desktop.windows[desktop.foreground].path == DOWNLOADS


@pytest.mark.xfail(strict=True, reason="DOT-031: Bot substring fallback ('downloads' in location) false-verifies")
def test_bot_substring_folder_does_not_verify(desktop):
    desktop.add(DOCS, foreground=True)
    desktop.navigate_is_noop = True
    desktop.windows[desktop.foreground].tabs[0] = r"C:\Users\gopi\Old Downloads"
    sc = as_v2(bot_open_downloads(desktop, {}, strip_unknown_args=True))
    assert sc["verified"] is False


@pytest.mark.xfail(strict=True, reason="DOT-031: two unfocused windows -> Bot error text, not AMBIGUOUS+candidates")
def test_bot_two_unfocused_is_ambiguous(desktop):
    desktop.add(DOCS), desktop.add(PICS)
    sc = as_v2(bot_open_downloads(desktop, {}, strip_unknown_args=True))
    assert sc["error"]["code"] == "AMBIGUOUS"
