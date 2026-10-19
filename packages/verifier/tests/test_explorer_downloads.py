"""First demo: "Dottie, open File Explorer and go to Downloads"."""

import json

import pytest

from dottie_verifier.contract import to_verification_result
from dottie_verifier.explorer import observe_folder, verify_explorer_at_known_folder
from dottie_verifier.explorer_workflow import allow_all, spoken_summary, verify_open_downloads
from dottie_verifier.known_folders import FOLDERID
from dottie_verifier.model import CheckStatus, Outcome
from dottie_verifier.recovery import RetryPolicy
from dottie_verifier.winapi import Rect
from tests.fakes import DOWNLOADS, FakeE04Tools, Tab

RETRY = RetryPolicy(jitter=0)


def run(desktop, clock, tools, gate=allow_all, cancelled=None):
    return verify_open_downloads(desktop, tools, retry=RETRY, sleep=clock.sleep, clock=clock,
                                 recovery_gate=gate, cancelled=cancelled)


def statuses(report):
    return {c.id: c.status.value for c in report.checks}


# --- happy paths ---------------------------------------------------------------

def test_opens_new_window_and_verifies_every_postcondition(desktop, clock):
    tools = FakeE04Tools(desktop)
    report = run(desktop, clock, tools)
    assert report.outcome is Outcome.VERIFIED, report.to_dict()
    assert set(statuses(report).values()) == {"pass"}
    assert [c.id for c in report.checks] == [f"EXP-0{i}" for i in range(1, 9)]
    assert report.decision == "done"
    assert len(tools.calls) == 1
    assert report.check("EXP-06").source == "IShellWindows.Document.Folder.Self.Path"
    assert spoken_summary(report) == "File Explorer is showing Downloads."


def test_reuses_existing_foreground_window_without_opening_another(desktop, clock):
    existing = desktop.add_explorer(r"C:\Users\<user>\Documents", foreground=True)
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.outcome is Outcome.VERIFIED
    assert report.check("EXP-02").evidence["hwnd"] == existing.hwnd
    assert report.check("EXP-08").evidence["new_explorer_hwnds"] == []


def test_async_navigation_is_polled_until_it_settles(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>\Documents", foreground=True)
    report = run(desktop, clock, FakeE04Tools(desktop, delay=6))
    assert report.outcome is Outcome.VERIFIED
    assert len(report.attempts) == 1 and report.attempts[0].recovery == []


def test_tool_result_event_is_verified_only_when_observed(desktop, clock):
    report = run(desktop, clock, FakeE04Tools(desktop))
    event = to_verification_result(report)
    assert event["verified"] is True and "error" not in event
    json.dumps(report.to_dict())  # serializable evidence


# --- "tool returned OK" is never sufficient -------------------------------------

def test_tool_claims_success_but_nothing_happened(desktop, clock):
    tools = FakeE04Tools(desktop, mode="lies")
    report = run(desktop, clock, tools)
    assert report.tool_claimed_success is True
    assert report.outcome is Outcome.UNVERIFIED
    assert report.false_success is True
    assert len(tools.calls) == RETRY.max_attempts  # bounded re-invocation
    assert to_verification_result(report)["verified"] is False
    assert "couldn't confirm" in spoken_summary(report)


def test_lying_tool_with_existing_window_is_repaired_by_hwnd_navigation(desktop, clock):
    w = desktop.add_explorer(r"C:\Users\<user>\Pictures", foreground=True)
    report = run(desktop, clock, FakeE04Tools(desktop, mode="lies"))
    assert report.outcome is Outcome.VERIFIED
    assert f"navigate:{w.hwnd}:{DOWNLOADS}" in desktop.calls
    assert report.false_success is False


def test_tool_exception_still_verifies_observed_state(desktop, clock):
    desktop.add_explorer(DOWNLOADS, foreground=True)
    report = run(desktop, clock, FakeE04Tools(desktop, mode="raises"))
    assert report.tool_claimed_success is False
    assert report.attempts[0].tool_result["exception"] == "RuntimeError"
    assert report.outcome is Outcome.VERIFIED


def test_substring_downloads_folder_is_not_accepted(desktop, clock):
    """E04's fallback accepts any location text containing 'downloads'. We do not."""
    trap = r"C:\Users\<user>\Old Downloads"
    desktop.add_dir(trap)
    w = desktop.add_explorer(trap, foreground=True)
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    folder = next(c for c in checks if c.id == "EXP-06")
    assert folder.status is CheckStatus.FAIL


def test_wrong_folder_once_recovers_by_reinvoking_idempotent_tool(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>\Desktop", foreground=True)
    tools = FakeE04Tools(desktop, mode="wrong_folder_once")
    report = run(desktop, clock, tools)
    assert report.outcome is Outcome.VERIFIED
    assert len(report.attempts) == 2
    assert report.attempts[0].recovery == ["reinvoke_tool:open_downloads"]
    assert len(tools.calls) == 2


# --- window-state recovery --------------------------------------------------------

def test_minimized_window_is_restored_by_handle(desktop, clock):
    report = run(desktop, clock, FakeE04Tools(desktop, mode="minimized"))
    assert report.outcome is Outcome.VERIFIED
    assert any(c.startswith("restore:") for c in desktop.calls)


def test_foreground_refused_is_reported_as_partial(desktop, clock):
    desktop.allow_foreground = False
    report = run(desktop, clock, FakeE04Tools(desktop, mode="no_focus"))
    assert report.outcome is Outcome.PARTIALLY_VERIFIED
    assert statuses(report)["EXP-07"] == "fail"
    assert report.decision == "done" and "exhausted" in report.decision_reason
    assert sum(c.startswith("foreground:") for c in desktop.calls) == RETRY.max_attempts - 1
    assert "couldn't bring it to the front" in spoken_summary(report)
    assert to_verification_result(report)["verified"] is False


def test_backoff_is_exponential_between_recoveries(desktop, clock):
    desktop.allow_foreground = False
    run(desktop, clock, FakeE04Tools(desktop, mode="no_focus"))
    backoffs = [s for s in clock.sleeps if s in (0.25, 0.5, 1.0)]
    assert backoffs[:1] == [0.25] and 0.5 in backoffs


def test_cloaked_window_on_other_virtual_desktop_fails_without_moving_it(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>", foreground=True, cloaked=True)
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.outcome is Outcome.FAILED
    assert "cloaked" in report.check("EXP-05").evidence["reasons"]
    assert not any(c.startswith("move:") for c in desktop.calls)


def test_offscreen_window_is_moved_to_primary_monitor(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>", foreground=True, rect=Rect(-3000, 100, -2000, 800))
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.outcome is Outcome.VERIFIED
    assert any(c.startswith("move:") for c in desktop.calls)


def test_window_on_secondary_high_dpi_monitor_left_of_primary(desktop, clock):
    desktop.add_monitor(2, Rect(-2880, 0, 0, 1620), dpi=144)
    desktop.add_explorer(r"C:\Users\<user>", foreground=True, rect=Rect(-2500, 100, -1000, 1200),
                         dpi=144)
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.outcome is Outcome.VERIFIED
    assert report.check("EXP-05").evidence["monitor"] == 2


# --- stop-or-ask ------------------------------------------------------------------

def test_multiple_windows_none_focused_asks_instead_of_guessing(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>\Documents")
    desktop.add_explorer(r"C:\Users\<user>\Pictures")
    tools = FakeE04Tools(desktop)
    report = run(desktop, clock, tools)
    assert report.decision == "ask_user"
    assert report.outcome is Outcome.UNVERIFIED
    assert "2 File Explorer windows" in report.question
    assert len(tools.calls) == 1 and desktop.calls == []  # no recovery actions, no clicks
    assert spoken_summary(report) == report.question


def test_multiple_windows_one_already_at_downloads_is_adopted(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>\Documents")
    at = desktop.add_explorer(DOWNLOADS)
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.outcome is Outcome.VERIFIED
    # Round 1 adopts it as the only window at Downloads; recovery then focuses it by HWND.
    assert report.check("EXP-02").evidence["hwnd"] == at.hwnd
    assert f"foreground:{at.hwnd}" in desktop.calls
    assert desktop.foreground == at.hwnd


def test_two_new_windows_is_partial_and_nothing_is_closed(desktop, clock):
    report = run(desktop, clock, FakeE04Tools(desktop, mode="two_windows"))
    assert report.outcome is Outcome.PARTIALLY_VERIFIED
    assert statuses(report)["EXP-08"] == "fail"
    assert len(desktop.windows) == 2
    assert "extra Explorer window" in spoken_summary(report)


def test_unresolvable_known_folder_stops(desktop, clock):
    desktop.known.clear()
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.decision == "stop"
    assert statuses(report)["EXP-01"] == "unknown"
    assert report.outcome is Outcome.UNVERIFIED


def test_missing_downloads_directory_fails_and_stops(desktop, clock):
    desktop.dirs.clear()
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.decision == "stop" and report.outcome is Outcome.FAILED


def test_wrong_window_class_stops(desktop, clock):
    desktop.add_explorer(DOWNLOADS, foreground=True, class_name="Progman")
    report = run(desktop, clock, FakeE04Tools(desktop, mode="lies"))
    assert statuses(report)["EXP-03"] == "fail"
    assert report.decision == "stop" and report.outcome is Outcome.FAILED


# --- folder identity: redirection, localization, aliases ----------------------------

def test_onedrive_redirected_downloads(desktop, clock):
    redirected = r"C:\Users\<user>\OneDrive\Downloads"
    desktop.known[FOLDERID["downloads"]] = redirected
    desktop.add_dir(redirected)
    report = run(desktop, clock, FakeE04Tools(desktop))
    assert report.outcome is Outcome.VERIFIED
    assert report.check("EXP-06").evidence["expected_path"] == redirected


def test_stale_profile_downloads_fails_when_known_folder_is_redirected(desktop):
    redirected = r"D:\Data\Downloads"
    desktop.known[FOLDERID["downloads"]] = redirected
    desktop.add_dir(redirected)
    w = desktop.add_explorer(DOWNLOADS, foreground=True)
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    assert next(c for c in checks if c.id == "EXP-06").status is CheckStatus.FAIL


def test_localized_display_name_does_not_matter(desktop, clock):
    w = desktop.add_explorer(DOWNLOADS, foreground=True, title="Téléchargements")
    w.tabs[0].name = "Téléchargements"
    report = run(desktop, clock, FakeE04Tools(desktop, mode="lies"))
    assert report.outcome is Outcome.VERIFIED


def test_window_title_alone_is_never_evidence(desktop):
    w = desktop.add_explorer(r"C:\Users\<user>\Documents", foreground=True, title="Downloads")
    w.tabs[0].name = "Downloads"
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    assert next(c for c in checks if c.id == "EXP-06").status is CheckStatus.FAIL


def test_short_name_and_junction_resolved_through_final_path(desktop):
    alias = r"C:\Users\<USER>~1\Downloads\\"
    desktop.final_paths[r"c:\users\<user>~1\downloads"] = DOWNLOADS
    w = desktop.add_explorer(alias, foreground=True)
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    assert next(c for c in checks if c.id == "EXP-06").status is CheckStatus.PASS


def test_location_url_used_when_folder_path_unavailable(desktop):
    spaced = r"C:\Users\<user> <surname>\Downloads"
    desktop.known[FOLDERID["downloads"]] = spaced
    desktop.add_dir(spaced)
    w = desktop.add_explorer(spaced, foreground=True)
    entries = desktop.shell_windows()
    assert "%20" in entries[0].location_url
    desktop.shell_windows = lambda: [e.__class__(e.hwnd, e.tab_hwnd, e.full_name, "",
                                                 e.location_url)
                                     for e in entries]
    obs = observe_folder(desktop, w.hwnd)
    assert obs.status == "ok" and obs.source == "IShellWindows.LocationURL"
    assert obs.path == spaced


def test_uia_address_bar_fallback_accepts_only_absolute_paths(desktop):
    w = desktop.add_explorer(DOWNLOADS)
    desktop.shell_windows = list
    desktop.uia_values[w.hwnd] = "Downloads"            # breadcrumb label: rejected
    assert observe_folder(desktop, w.hwnd).status == "missing"
    desktop.uia_values[w.hwnd] = DOWNLOADS
    obs = observe_folder(desktop, w.hwnd)
    assert obs.status == "ok" and obs.source == "UIA address bar ValuePattern"


def test_virtual_location_this_pc_fails(desktop):
    w = desktop.add_explorer("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", foreground=True)
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    assert next(c for c in checks if c.id == "EXP-06").status is CheckStatus.FAIL


def test_conflicting_com_sources_are_unknown(desktop):
    w = desktop.add_explorer(DOWNLOADS, foreground=True)
    e = desktop.shell_windows()[0]
    desktop.shell_windows = lambda: [e.__class__(e.hwnd, e.tab_hwnd, e.full_name, DOWNLOADS,
                                                 "file:///C:/Users/<user>/Documents")]
    assert observe_folder(desktop, w.hwnd).status == "conflict"


def test_unstable_observation_is_unknown(desktop):
    w = desktop.add_explorer(DOWNLOADS, foreground=True)
    flip = iter([DOWNLOADS, r"C:\Users\<user>\Documents"] * 5)
    real = desktop.shell_windows

    def flapping():
        out = real()
        return [e.__class__(e.hwnd, e.tab_hwnd, e.full_name, next(flip), "") for e in out]

    desktop.shell_windows = flapping
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    folder = next(c for c in checks if c.id == "EXP-06")
    assert folder.status is CheckStatus.UNKNOWN


# --- Windows 11 tabs ------------------------------------------------------------------

def _two_tabs(desktop, active_path, background_path):
    w = desktop.add_explorer(active_path, foreground=True)
    w.tabs.append(Tab(w.hwnd + 2, background_path))
    return w


def test_background_tab_at_downloads_does_not_count(desktop):
    w = _two_tabs(desktop, r"C:\Users\<user>\Documents", DOWNLOADS)
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    assert next(c for c in checks if c.id == "EXP-06").status is CheckStatus.FAIL


def test_active_tab_at_downloads_passes(desktop):
    w = _two_tabs(desktop, DOWNLOADS, r"C:\Users\<user>\Documents")
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd}, set())
    assert next(c for c in checks if c.id == "EXP-06").status is CheckStatus.PASS


def test_tabs_with_unknown_active_tab_ask_the_user(desktop, clock):
    _two_tabs(desktop, r"C:\Users\<user>\Documents", r"C:\Users\<user>\Music")
    desktop.active_tab_known = False
    report = run(desktop, clock, FakeE04Tools(desktop, mode="lies"))
    assert report.decision == "ask_user"
    assert "tabs" in report.question


def test_e04_navigating_background_tab_is_caught_and_repaired(desktop, clock):
    w = _two_tabs(desktop, r"C:\Users\<user>\Documents", r"C:\Users\<user>\Music")
    tools = FakeE04Tools(desktop, mode="background_tab")
    report = run(desktop, clock, tools)
    assert report.tool_claimed_success is True
    assert report.outcome is Outcome.VERIFIED
    assert f"navigate:{w.hwnd}:{DOWNLOADS}" in desktop.calls


@pytest.mark.parametrize("mode", ["normal", "minimized", "wrong_folder_once"])
def test_reports_record_each_attempt(desktop, clock, mode):
    report = run(desktop, clock, FakeE04Tools(desktop, mode=mode))
    assert report.attempts and report.attempts[-1].outcome is report.outcome


def test_identify_target_never_uses_titles_and_never_guesses(desktop):
    from dottie_verifier.explorer import identify_target
    from dottie_verifier.known_folders import resolve_known_folder

    a = desktop.add_explorer(r"C:\Users\<user>\Documents", title="Downloads")
    b = desktop.add_explorer(r"C:\Users\<user>\Music")
    sel = identify_target(desktop, {}, set(), resolve_known_folder(desktop, "downloads"),
                          before_complete=True)
    assert sel.hwnd is None and sel.ambiguous and set(sel.candidates) == {a.hwnd, b.hwnd}
    c = desktop.add_explorer(DOWNLOADS)
    sel = identify_target(desktop, {}, {a.hwnd, b.hwnd, c.hwnd},
                          resolve_known_folder(desktop, "downloads"), before_complete=True)
    assert sel.hwnd == c.hwnd and sel.how == "only_explorer_window_showing_target"
