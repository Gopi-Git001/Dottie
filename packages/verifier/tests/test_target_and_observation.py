"""E01 rulings of 2026-10-19: targetId follow-up (§5 candidate selection), pure observation calls
(sideEffect none, may be retryable) and re-observe-before-recovery for mutating calls."""

import re

import pytest

from dottie_verifier.candidates import CandidateRegistry
from dottie_verifier.contract import to_structured_content
from dottie_verifier.explorer import identify_target
from dottie_verifier.explorer_workflow import (
    OpenExplorerKnownFolder,
    allow_all,
    observe_explorer_folder,
    verify_open_downloads,
)
from dottie_verifier.model import Outcome
from dottie_verifier.recovery import RetryPolicy
from dottie_verifier.workflow import run_verified
from tests.fakes import DOWNLOADS, FakeE04Tools

RETRY = RetryPolicy(jitter=0)
DOCS = r"C:\Users\<user>\Documents"
PICS = r"C:\Users\<user>\Pictures"


def open_dl(desktop, clock, tools, registry, task_id="task-1", target_id=None):
    return verify_open_downloads(desktop, tools, retry=RETRY, sleep=clock.sleep, clock=clock,
                                 recovery_gate=allow_all, task_id=task_id,
                                 candidates=registry, target_id=target_id)


def ask(desktop, clock, registry, task_id="task-1"):
    """Two unfocused Explorer windows -> AMBIGUOUS with task-scoped candidate ids."""
    sc = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry, task_id))
    assert sc["error"]["code"] == "AMBIGUOUS"
    return sc["observedState"]["candidates"]


def tab_path(window):
    return next(t.path for t in window.tabs if t.tab_hwnd == window.active_tab)


# --- targetId: the happy path -------------------------------------------------------------------

def test_target_id_navigates_exactly_the_chosen_window(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    a, b = desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    cands = ask(desktop, clock, registry)
    chosen = cands[1]["id"]                         # the user picked the second window
    tools = FakeE04Tools(desktop)
    report = open_dl(desktop, clock, tools, registry, target_id=chosen)
    sc = to_structured_content(report)
    assert sc["verified"] is True and report.outcome is Outcome.VERIFIED
    assert tools.calls == [("open_downloads", {"hwnd": b.hwnd})]
    assert tab_path(b) == DOWNLOADS and tab_path(a) == DOCS       # other window untouched
    assert report.check("EXP-02").evidence["identified_by"] == "user_selected_target"
    assert len(desktop.windows) == 2                                # no new window opened


# --- targetId: unknown / stale / cross-task -> NOT_FOUND, nothing invoked -------------------------

def _assert_not_found(report, tools, reason):
    sc = to_structured_content(report)
    assert tools.calls == [] and report.tool_invoked is False
    assert sc["verified"] is False and sc["error"]["code"] == "NOT_FOUND"
    assert sc["error"]["retryable"] is False and sc["sideEffect"] == "none"
    assert sc["observedState"]["decision"] == "stop"
    assert report.checks[0].evidence["reason"] == reason


@pytest.mark.parametrize("target_id", ["c_000000000000", "c_ffffffffffff"])
def test_unknown_target_id_is_not_found(desktop, clock, target_id):
    registry = CandidateRegistry(clock=clock)
    desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    ask(desktop, clock, registry)
    tools = FakeE04Tools(desktop)
    _assert_not_found(open_dl(desktop, clock, tools, registry, target_id=target_id), tools,
                      "unknown")


def test_cross_task_target_id_is_not_found(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    cid = ask(desktop, clock, registry, task_id="task-A")[0]["id"]
    tools = FakeE04Tools(desktop)
    _assert_not_found(open_dl(desktop, clock, tools, registry, task_id="task-B", target_id=cid),
                      tools, "cross_task")


def test_superseded_target_id_is_not_found(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    old = ask(desktop, clock, registry)[0]["id"]
    ask(desktop, clock, registry)                    # a newer question in the same task
    tools = FakeE04Tools(desktop)
    _assert_not_found(open_dl(desktop, clock, tools, registry, target_id=old), tools,
                      "superseded")


def test_expired_target_id_is_not_found(desktop, clock):
    registry = CandidateRegistry(ttl=60, clock=clock)
    desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    cid = ask(desktop, clock, registry)[0]["id"]
    clock.t += 61
    tools = FakeE04Tools(desktop)
    _assert_not_found(open_dl(desktop, clock, tools, registry, target_id=cid), tools, "expired")


def test_target_window_closed_is_not_found(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    a = desktop.add_explorer(DOCS)
    desktop.add_explorer(PICS)
    cands = ask(desktop, clock, registry)
    del desktop.windows[a.hwnd]                      # the user closed the chosen window
    tools = FakeE04Tools(desktop)
    _assert_not_found(open_dl(desktop, clock, tools, registry, target_id=cands[0]["id"]), tools,
                      "window_closed")


def test_target_id_without_registry_is_not_found(desktop, clock):
    tools = FakeE04Tools(desktop)
    _assert_not_found(open_dl(desktop, clock, tools, None, target_id="c_123456789abc"), tools,
                      "unknown")


def test_pinned_target_never_falls_back_to_another_window(desktop):
    a = desktop.add_explorer(DOWNLOADS, foreground=True)
    sel = identify_target(desktop, {"hwnd": a.hwnd}, set(), pinned=0xDEAD)
    assert sel.hwnd is None and sel.candidates == [] and not sel.ambiguous


def test_candidate_ids_are_opaque_and_task_scoped(clock):
    registry = CandidateRegistry(clock=clock)
    ids = registry.issue("t1", [(0x1010, "File Explorer window 1"), (0x1020, "x")])
    for c in ids:
        assert re.fullmatch(r"c_[0-9a-f]{12}", c["id"])
        assert "1010" not in c["id"] and "4112" not in c["id"]
    assert registry.resolve("t1", ids[0]["id"]).target == 0x1010
    registry.forget_task("t1")
    assert registry.resolve("t1", ids[0]["id"]).reason == "unknown"
    with pytest.raises(ValueError):
        registry.issue("", [(1, "x")])


# --- pure observation: sideEffect none, may be retryable -----------------------------------------

def observe(desktop, clock):
    return observe_explorer_folder(desktop, "downloads", retry=RETRY, sleep=clock.sleep,
                                   clock=clock)


def test_observation_verified_has_no_side_effect(desktop, clock):
    desktop.add_explorer(DOWNLOADS, foreground=True)
    report = observe(desktop, clock)
    sc = to_structured_content(report)
    assert sc["verified"] is True and sc["sideEffect"] == "none"
    assert report.tool_invoked and report.attempts[0].tool_result is None
    assert desktop.calls == []


@pytest.mark.parametrize("setup", ["other_folder", "no_explorer"])
def test_observation_failure_is_side_effect_free_and_retryable(desktop, clock, setup):
    if setup == "other_folder":
        desktop.add_explorer(DOCS, foreground=True)
    report = observe(desktop, clock)
    sc = to_structured_content(report)
    assert sc["verified"] is False and sc["sideEffect"] == "none"
    assert sc["error"]["code"] in ("POSTCONDITION_FAILED", "POSTCONDITION_UNKNOWN")
    assert sc["error"]["retryable"] is True
    assert desktop.calls == []                       # never restored, focused or navigated anything


def test_observation_ambiguity_still_asks_and_is_not_retryable(desktop, clock):
    desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    sc = to_structured_content(observe(desktop, clock))
    assert sc["sideEffect"] == "none" and sc["error"]["code"] == "AMBIGUOUS"
    assert sc["error"]["retryable"] is False


def test_mutating_failure_is_never_retryable(desktop, clock):
    sc = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop, mode="lies"),
                                       CandidateRegistry(clock=clock)))
    assert sc["sideEffect"] == "unknown" and sc["error"]["retryable"] is False


# --- mutating calls re-observe before any recovery -----------------------------------------------

class SpyWorkflow(OpenExplorerKnownFolder):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.log: list[str] = []

    def act(self, ctx):
        self.log.append("act")
        return super().act(ctx)

    def verify(self, ctx):
        self.log.append("verify")
        return super().verify(ctx)

    def recover(self, checks, ctx, attempt):
        self.log.append("recover")
        return super().recover(checks, ctx, attempt)


@pytest.mark.parametrize("mode", ["minimized", "no_focus", "wrong_folder", "lies"])
def test_mutating_call_reobserves_before_every_recovery(desktop, clock, mode):
    desktop.allow_foreground = mode != "no_focus"
    wf = SpyWorkflow(desktop, FakeE04Tools(desktop, mode=mode), sleep=clock.sleep,
                     recovery_gate=allow_all)
    run_verified(wf, retry=RETRY, sleep=clock.sleep, clock=clock)
    log = wf.log
    assert log[:2] == ["act", "verify"] and "recover" in log
    for i, step in enumerate(log):
        if step == "recover":
            assert log[i - 1] == "verify", log              # fresh observation right before
        if step == "act" and i > 0:
            assert log[i - 1] == "recover", log             # re-invoke only as a recovery step
    assert log[-1] == "verify"                              # the reported state is a fresh read
