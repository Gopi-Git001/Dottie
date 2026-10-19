"""TOCTOU (RISKS R23, owner E11; ADR-0017 Decision 8): the target changes between verification /
approval and the action. Test ids T1-T7 match docs/verifier-design.md §16."""

import pytest

from dottie_verifier.candidates import CandidateRegistry
from dottie_verifier.contract import to_structured_content
from dottie_verifier.explorer_workflow import (
    OpenExplorerKnownFolder,
    allow_all,
    verify_open_downloads,
)
from dottie_verifier.model import Outcome
from dottie_verifier.recovery import RetryPolicy
from dottie_verifier.window_identity import LocalWindowRegistry
from dottie_verifier.workflow import ActionContext
from tests.fakes import FakeE04Tools

RETRY = RetryPolicy(jitter=0)
DOCS = r"C:\Users\<user>\Documents"
PICS = r"C:\Users\<user>\Pictures"


def mutate(window, kind):
    """T1 hwnd reused by a new process; T2 same pid, new start time; T3 window class change;
    T7 a field (start time, pid, class) no longer readable."""
    if kind == "new_process":
        window.pid += 1000
        window.process_start_time += 10_000_000
    elif kind == "same_pid_new_start":
        window.process_start_time += 1
    elif kind == "class_change":
        window.class_name = "CabinetWClass_reused"
    elif kind == "start_time_unreadable":
        window.process_start_time = None
    elif kind == "pid_unreadable":
        window.pid = None
    elif kind == "class_unreadable":
        window.class_name = None
    else:
        raise ValueError(kind)


KINDS = ["new_process", "same_pid_new_start", "class_change", "start_time_unreadable",
         "pid_unreadable", "class_unreadable"]


def open_dl(desktop, clock, tools, registry, target_id=None, windows=None, gate=allow_all):
    return verify_open_downloads(desktop, tools, retry=RETRY, sleep=clock.sleep, clock=clock,
                                 recovery_gate=gate, task_id="task-1", candidates=registry,
                                 target_id=target_id, window_registry=windows)


def ask(desktop, clock, registry):
    a, b = desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    sc = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry))
    assert sc["error"]["code"] == "AMBIGUOUS"
    return a, b, [c["id"] for c in sc["observedState"]["candidates"]]


def code_and_effect(report):
    sc = to_structured_content(report)
    return sc["error"]["code"], sc["sideEffect"], sc["error"]["retryable"]


# --- mitigation 1: identity re-check immediately before acting -----------------------------------

@pytest.mark.parametrize("kind", KINDS)
def test_identity_change_before_resolution_is_not_found(desktop, clock, kind):
    registry = CandidateRegistry(clock=clock)
    _a, b, ids = ask(desktop, clock, registry)
    mutate(b, kind)
    tools = FakeE04Tools(desktop)
    report = open_dl(desktop, clock, tools, registry, target_id=ids[1])
    assert tools.calls == []
    assert code_and_effect(report) == ("NOT_FOUND", "none", False)


class MutatesOnSecondCheck(LocalWindowRegistry):
    """Identity is fine at targetId resolution, then changes before the final pre-dispatch check."""

    def __init__(self, api, window, kind):
        super().__init__(api)
        self.window, self.kind, self.checks = window, kind, 0

    def is_alive(self, identity):
        self.checks += 1
        if self.checks == 2:
            mutate(self.window, self.kind)
        return super().is_alive(identity)


@pytest.mark.parametrize("kind", KINDS)
def test_identity_change_before_dispatch_is_precondition_failed(desktop, clock, kind):
    registry = CandidateRegistry(clock=clock)
    _a, b, ids = ask(desktop, clock, registry)
    tools = FakeE04Tools(desktop)
    report = open_dl(desktop, clock, tools, registry, target_id=ids[1],
                     windows=MutatesOnSecondCheck(desktop, b, kind))
    assert tools.calls == []
    assert code_and_effect(report) == ("PRECONDITION_FAILED", "none", False)


def _observed_then_recover(desktop, gate, before_recover=None, mode="minimized"):
    wf = OpenExplorerKnownFolder(desktop, FakeE04Tools(desktop, mode=mode), recovery_gate=gate)
    ctx = ActionContext(before=wf.snapshot(), started_at=0.0)
    ctx.tool_result = wf.act(ctx)
    checks = wf.verify(ctx)
    if before_recover:
        before_recover(ctx)
    return wf.recover(checks, ctx, 1), ctx


@pytest.mark.parametrize("kind", KINDS)
def test_identity_change_between_observation_and_recovery_blocks_primitive(desktop, kind):
    gate_calls = []

    def gate(primitive, target):
        gate_calls.append(primitive)
        return True

    steps, _ctx = _observed_then_recover(
        desktop, gate, lambda ctx: mutate(desktop.windows[ctx.extra["target"].hwnd], kind))
    assert any("identity_changed" in s for s in steps)
    assert gate_calls == []                         # never asked to approve a different window
    assert not any(c.startswith("restore:") for c in desktop.calls)


# --- window closes (or changes) between approval and action --------------------------------------

@pytest.mark.parametrize("change", ["close", "new_process", "same_pid_new_start", "class_change"])
def test_window_changes_between_approval_and_action(desktop, change):
    def gate(primitive, target):
        hwnd = int(target["hwnd"])
        if change == "close":
            del desktop.windows[hwnd]               # closed while the approval was pending
        else:
            mutate(desktop.windows[hwnd], change)
        return True

    steps, _ctx = _observed_then_recover(desktop, gate)
    assert any("identity_changed_after_approval" in s for s in steps)
    assert not any(c.startswith("restore:") for c in desktop.calls)


def test_pinned_window_changes_before_reinvoke_blocks_reinvoke(desktop):
    b = desktop.add_explorer(DOCS, foreground=True)
    windows = LocalWindowRegistry(desktop)
    tools = FakeE04Tools(desktop, mode="wrong_folder")
    wf = OpenExplorerKnownFolder(desktop, tools, recovery_gate=allow_all,
                                 target=windows.identify(b.hwnd), window_registry=windows)
    ctx = ActionContext(before=wf.snapshot(), started_at=0.0)
    ctx.tool_result = wf.act(ctx)
    checks = wf.verify(ctx)
    assert {c.id: c.status.value for c in checks}["EXP-06"] == "fail"   # would re-invoke
    mutate(b, "same_pid_new_start")
    steps = wf.recover(checks, ctx, 1)
    assert any(s.startswith("denied_by_policy:reinvoke_tool(identity_changed)") for s in steps)
    assert len(tools.calls) == 1                    # no second dispatch to a changed window


# --- mitigation 2: single-use tokens consumed before execution ------------------------------------

class SingleUseTokenGate:
    """Test double for the K8 recovery token (ADR-0017 §3-4): one token per (action, identity),
    consumed *before* the action runs; a second use is a replay and is denied."""

    def __init__(self):
        self.used, self.calls = set(), []

    def __call__(self, primitive, target):
        key = (primitive, tuple(sorted(target["window"].items())))
        self.calls.append(key)
        if key in self.used:
            return False                            # replay
        self.used.add(key)                          # consumed before the primitive is called
        return True


def test_token_replay_is_denied_and_gate_is_asked_every_time(desktop):
    w = desktop.add_explorer(DOCS, foreground=True, minimized=True, restore_works=False)
    gate = SingleUseTokenGate()
    wf = OpenExplorerKnownFolder(desktop, FakeE04Tools(desktop), recovery_gate=gate)
    ctx = ActionContext(before=wf.snapshot(), started_at=0.0)
    ctx.tool_result = {"success": True, "hwnd": w.hwnd}
    first = wf.recover(wf.verify(ctx), ctx, 1)
    second = wf.recover(wf.verify(ctx), ctx, 2)      # restore didn't stick; same identity again
    assert any(s.startswith("restore_window(") for s in first)
    assert any(s.startswith("denied_by_policy:restore_window(hwnd=") for s in second)
    assert [k[0] for k in gate.calls].count("restore_window") == 2   # asked every time, no cache
    assert sum(c.startswith("restore:") for c in desktop.calls) == 1  # executed once only


# --- mitigation 3: POSTCONDITION_UNKNOWN when the result can't be observed ------------------------

@pytest.mark.parametrize("kind", KINDS)
def test_pinned_identity_change_after_dispatch_is_postcondition_unknown(desktop, clock, kind):
    registry = CandidateRegistry(clock=clock)
    _a, b, ids = ask(desktop, clock, registry)

    class MutateAfter(FakeE04Tools):
        def __call__(self, name, args):
            out = super().__call__(name, args)
            mutate(b, kind)
            return out

    tools = MutateAfter(desktop)
    report = open_dl(desktop, clock, tools, registry, target_id=ids[1])
    assert len(tools.calls) == 1 and report.outcome is Outcome.UNVERIFIED
    assert code_and_effect(report) == ("POSTCONDITION_UNKNOWN", "unknown", False)


def test_observation_channel_lost_after_dispatch_is_postcondition_unknown(desktop, clock):
    class BlindsObserver(FakeE04Tools):
        def __call__(self, name, args):
            out = super().__call__(name, args)
            self.d.shell_windows = list             # IShellWindows stops answering
            return out

    report = open_dl(desktop, clock, BlindsObserver(desktop), CandidateRegistry(clock=clock))
    assert report.outcome is Outcome.UNVERIFIED and not report.verified
    code, effect, retryable = code_and_effect(report)
    assert code == "POSTCONDITION_UNKNOWN" and effect == "unknown" and retryable is False


def test_window_without_readable_start_time_is_never_a_candidate(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    a, b = desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    mutate(a, "start_time_unreadable")
    sc = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry))
    assert sc["error"]["code"] == "AMBIGUOUS"
    assert len(sc["observedState"]["candidates"]) == 1     # only b can be pinned (fail-closed)
    assert LocalWindowRegistry(desktop).identify(a.hwnd) is None
    assert LocalWindowRegistry(desktop).identify(b.hwnd) is not None
