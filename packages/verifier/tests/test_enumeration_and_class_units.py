"""CONTRACTS §3.3 windowClass = 1-256 UTF-16 code units, and §5 "Fail-closed observations":
an enumeration that skipped an entry is complete:false and every decision that needs the full
window list fails closed. "No foreground window" never feeds a critical decision."""

import pytest

from dottie_verifier.candidates import CandidateRegistry
from dottie_verifier.contract import error_code, to_structured_content
from dottie_verifier.explorer import (
    check_window_hygiene,
    identify_target,
    observe_folder,
    verify_explorer_at_known_folder,
)
from dottie_verifier.known_folders import resolve_known_folder
from dottie_verifier.winapi import ShellWindowList, enumeration_complete
from dottie_verifier.window_identity import (
    InvalidArgumentError,
    LocalWindowRegistry,
    WindowIdentity,
    utf16_units,
)
from tests.fakes import DOWNLOADS, FakeE04Tools
from tests.test_window_gone_and_args import open_dl

EMOJI = "\U0001F600"                       # outside the BMP: 2 UTF-16 code units
DOCS = r"C:\Users\<user>\Documents"
PICS = r"C:\Users\<user>\Pictures"
WIRE = {"hwnd": "4112", "pid": "4242", "windowClass": "CabinetWClass",
        "processStartTime": "133700000000000001"}

ACCEPT = {"128 emoji = 256 units": EMOJI * 128,
          "254 ASCII + 1 emoji = 256 units": "C" * 254 + EMOJI,
          "256 ASCII": "C" * 256, "1 unit": "C", "1 emoji = 2 units": EMOJI}
REJECT = {"129 emoji = 258 units": EMOJI * 129,
          "255 ASCII + 1 emoji = 257 units": "C" * 255 + EMOJI,
          "257 ASCII": "C" * 257, "empty": "", "lone high surrogate": "\ud800",
          "lone low surrogate in text": "Cab\udc00inet", "reversed pair": "\ude00\ud83d"}


# --- windowClass in UTF-16 code units ------------------------------------------------------------

def test_vectors_have_the_stated_unit_counts():
    assert utf16_units(EMOJI * 128) == 256 and utf16_units(EMOJI * 129) == 258
    assert utf16_units("C" * 254 + EMOJI) == 256 and utf16_units("C" * 255 + EMOJI) == 257
    assert utf16_units("\ud800") is None                    # no UTF-16 form


@pytest.mark.parametrize("cls", list(ACCEPT.values()), ids=list(ACCEPT))
def test_class_within_256_utf16_units_is_accepted(cls):
    assert WindowIdentity.from_contract({**WIRE, "windowClass": cls}).window_class == cls
    assert WindowIdentity(1, 1, cls, 1).window_class == cls


@pytest.mark.parametrize("cls", list(REJECT.values()), ids=list(REJECT))
def test_class_over_256_units_empty_or_lone_surrogate_is_invalid_argument(cls):
    with pytest.raises(InvalidArgumentError):
        WindowIdentity.from_contract({**WIRE, "windowClass": cls})
    with pytest.raises(InvalidArgumentError):
        WindowIdentity(1, 1, cls, 1)


@pytest.mark.parametrize(("cls", "ok"), [(EMOJI * 128, True), (EMOJI * 129, False),
                                         ("C" * 255 + EMOJI, False), ("\ud800", False)])
def test_backend_class_unit_rule_decides_identity(desktop, cls, ok):
    w = desktop.add_explorer(DOCS)
    w.class_name = cls
    assert (LocalWindowRegistry(desktop).identify(w.hwnd) is not None) is ok


# --- enumeration completeness --------------------------------------------------------------------

def test_plain_list_counts_as_incomplete():
    assert not enumeration_complete([])
    assert not enumeration_complete(ShellWindowList([], complete=False))
    assert enumeration_complete(ShellWindowList([], complete=True))


def test_incomplete_now_disables_every_full_list_rule(desktop):
    a = desktop.add_explorer(DOCS)
    b = desktop.add_explorer(DOWNLOADS)
    expected = resolve_known_folder(desktop, "downloads")
    # complete: "only window already at Downloads" picks b
    assert identify_target(desktop, {}, {a.hwnd, b.hwnd}, expected,
                           before_complete=True).hwnd == b.hwnd
    desktop.enum_complete = False
    sel = identify_target(desktop, {}, {a.hwnd, b.hwnd}, expected, before_complete=True)
    assert sel.hwnd is None and sel.enumeration_incomplete
    assert sel.candidates == [] and not sel.ambiguous            # no ask from a partial list


def test_incomplete_before_snapshot_disables_new_window_diff(desktop):
    a = desktop.add_explorer(DOCS)
    c = desktop.add_explorer(DOWNLOADS)                          # "new" relative to {a}
    sel = identify_target(desktop, {}, {a.hwnd}, None, before_complete=False)
    assert sel.hwnd is None and sel.how == "enumeration_incomplete"
    assert identify_target(desktop, {}, {a.hwnd}, None, before_complete=True).hwnd == c.hwnd


def test_foreground_plus_no_other_window_rule_needs_full_list(desktop):
    w = desktop.add_explorer(DOCS, foreground=True)
    assert identify_target(desktop, {}, {w.hwnd}, None, before_complete=True).hwnd == w.hwnd
    desktop.enum_complete = False
    assert identify_target(desktop, {}, {w.hwnd}, None, before_complete=True).hwnd is None


def test_tool_reported_hwnd_is_positive_evidence_even_when_incomplete(desktop):
    w = desktop.add_explorer(DOWNLOADS, foreground=True)
    desktop.enum_complete = False
    checks, target, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd},
                                                         {w.hwnd}, before_complete=True)
    assert target.hwnd == w.hwnd and target.how == "tool_reported_hwnd"
    exp08 = next(c for c in checks if c.id == "EXP-08")
    assert exp08.status.value == "unknown" and exp08.evidence["enumeration_incomplete"]


@pytest.mark.parametrize(("before_complete", "now_complete"), [(False, True), (True, False)])
def test_exp08_new_window_count_unknown_when_either_list_incomplete(desktop, before_complete,
                                                                    now_complete):
    desktop.add_explorer(DOCS)
    desktop.enum_complete = now_complete
    check = check_window_hygiene("EXP-08", desktop, set(), before_complete)
    assert check.status.value == "unknown" and check.critical is False


def test_end_to_end_incomplete_enumeration_stops_without_reinvoking(desktop, clock):
    """The tool opens a new window but doesn't report its hwnd; only the new-window diff could
    identify it, and that needs complete lists. Fail closed: stop, no re-invoke."""
    desktop.enum_complete = False
    inner = FakeE04Tools(desktop)

    def tools(name, args):
        return {k: v for k, v in inner(name, args).items() if k != "hwnd"}

    report = open_dl(desktop, clock, tools, CandidateRegistry(clock=clock))
    sc = to_structured_content(report)
    assert len(inner.calls) == 1                                  # never re-invoked
    assert report.check("EXP-02").status.value == "unknown"
    assert report.check("EXP-02").evidence["enumeration_incomplete"] is True
    assert report.decision == "stop" and error_code(report) == "POSTCONDITION_UNKNOWN"
    assert sc["verified"] is False and sc["sideEffect"] != "none"
    assert sc["error"]["retryable"] is False


def test_two_windows_no_focus_incomplete_does_not_ask(desktop, clock):
    desktop.add_explorer(DOCS)
    desktop.add_explorer(PICS)
    desktop.enum_complete = False
    report = open_dl(desktop, clock, FakeE04Tools(desktop), CandidateRegistry(clock=clock))
    sc = to_structured_content(report)
    assert sc["error"]["code"] != "AMBIGUOUS"
    assert "candidates" not in sc["observedState"] or not sc["observedState"]["candidates"]


def test_target_id_missing_from_incomplete_list_is_not_found(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    a = desktop.add_explorer(DOCS)
    desktop.add_explorer(PICS)
    first = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry))
    ids = [c["id"] for c in first["observedState"]["candidates"]]
    real = desktop.shell_windows
    desktop.shell_windows = lambda: ShellWindowList([e for e in real() if e.hwnd != a.hwnd],
                                                    complete=False, skipped=1)
    tools = FakeE04Tools(desktop)
    sc = to_structured_content(open_dl(desktop, clock, tools, registry, target_id=ids[0]))
    assert sc["error"]["code"] == "NOT_FOUND" and tools.calls == []


def test_single_tab_is_not_trusted_when_incomplete_and_active_tab_unknown(desktop):
    w = desktop.add_explorer(DOWNLOADS, foreground=True)
    desktop.enum_complete = False
    assert observe_folder(desktop, w.hwnd).status == "ok"         # active tab confirmed
    desktop.active_tab_known = False
    assert observe_folder(desktop, w.hwnd).status == "incomplete"
    checks, _t, _s = verify_explorer_at_known_folder(desktop, "downloads", {"hwnd": w.hwnd},
                                                     {w.hwnd}, before_complete=True)
    assert next(c for c in checks if c.id == "EXP-06").status.value == "unknown"


# --- "no foreground window" never feeds a critical decision --------------------------------------

def _critical_view(report):
    return [(c.id, c.status.value) for c in report.checks if c.critical]


def test_no_foreground_window_only_affects_non_critical_checks(desktop, clock):
    desktop.add_explorer(DOWNLOADS, foreground=True)
    with_fg = open_dl(desktop, clock, FakeE04Tools(desktop), CandidateRegistry(clock=clock))
    desktop.foreground_window = lambda: 0                         # GetForegroundWindow -> NULL
    no_fg = open_dl(desktop, clock, FakeE04Tools(desktop), CandidateRegistry(clock=clock))
    fg_checks = [c for r in (with_fg, no_fg) for c in r.checks
                 if "GetForegroundWindow" in c.source]
    assert fg_checks and all(c.critical is False for c in fg_checks)
    assert _critical_view(with_fg) == _critical_view(no_fg)
    assert all(status == "pass" for _id, status in _critical_view(no_fg))
    assert no_fg.check("EXP-07").status.value != "pass"
    assert with_fg.check("EXP-07").status.value == "pass"


def test_no_foreground_window_never_identifies_a_target(desktop):
    w = desktop.add_explorer(DOCS, foreground=True)
    assert identify_target(desktop, {}, {w.hwnd}, None,
                           before_complete=True).how == "foreground_explorer_window"
    desktop.foreground = 0
    sel = identify_target(desktop, {}, {w.hwnd}, None, before_complete=True)
    assert sel.hwnd is None and sel.how == "unidentified"
