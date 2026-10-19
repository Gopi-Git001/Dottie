"""CONTRACTS v2 §5 (E04 review, E01 2026-10-19): window-gone rule, INVALID_ARGUMENT, and the
swappable window-identity interface ({hwnd, pid, windowClass})."""

import pytest

from dottie_verifier.candidates import CandidateRegistry, is_well_formed_target_id
from dottie_verifier.contract import to_structured_content
from dottie_verifier.explorer_workflow import allow_all, verify_open_downloads
from dottie_verifier.model import Outcome, VerificationReport
from dottie_verifier.recovery import RetryPolicy
from dottie_verifier.winapi import WindowState
from dottie_verifier.window_checks import check_exists
from dottie_verifier.window_identity import LocalWindowRegistry, WindowIdentity
from tests.fakes import DOWNLOADS, FakeE04Tools

RETRY = RetryPolicy(jitter=0)
DOCS = r"C:\Users\<user>\Documents"
PICS = r"C:\Users\<user>\Pictures"


def open_dl(desktop, clock, tools, registry, target_id=None, windows=None, gate=allow_all):
    return verify_open_downloads(desktop, tools, retry=RETRY, sleep=clock.sleep, clock=clock,
                                 recovery_gate=gate, task_id="task-1", candidates=registry,
                                 target_id=target_id, window_registry=windows)


def ask(desktop, clock, registry, windows=None):
    a, b = desktop.add_explorer(DOCS), desktop.add_explorer(PICS)
    sc = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry,
                                       windows=windows))
    assert sc["error"]["code"] == "AMBIGUOUS"
    return a, b, [c["id"] for c in sc["observedState"]["candidates"]]


def assert_refused(report, tools, code):
    sc = to_structured_content(report)
    assert tools.calls == [] and report.tool_invoked is False
    assert sc["verified"] is False and sc["error"]["code"] == code
    assert sc["sideEffect"] == "none" and sc["error"]["retryable"] is False
    assert sc["observedState"]["decision"] == "stop"


# --- (b) INVALID_ARGUMENT vs NOT_FOUND ---------------------------------------------------------

MALFORMED = ["", "not-an-id", "c_123", "c_0000000000000", "C_00000000000a", "c_00000000000A",
             "c_00000000000g", " c_000000000000", "c_000000000000\n", 12345, ["c_000000000000"],
             {"id": "x"}]


@pytest.mark.parametrize("target_id", MALFORMED)
def test_malformed_target_id_is_invalid_argument(desktop, clock, target_id):
    registry = CandidateRegistry(clock=clock)
    ask(desktop, clock, registry)
    tools = FakeE04Tools(desktop)
    assert_refused(open_dl(desktop, clock, tools, registry, target_id=target_id), tools,
                   "INVALID_ARGUMENT")


def test_well_formed_unknown_target_id_stays_not_found(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    ask(desktop, clock, registry)
    tools = FakeE04Tools(desktop)
    assert is_well_formed_target_id("c_0123456789ab")
    assert_refused(open_dl(desktop, clock, tools, registry, target_id="c_0123456789ab"), tools,
                   "NOT_FOUND")


def test_issued_ids_are_always_well_formed(clock):
    registry = CandidateRegistry(clock=clock)
    targets = [(WindowIdentity(i, 1, "CabinetWClass", 7), "x") for i in range(1, 51)]
    ids = registry.issue("t", targets)
    assert all(is_well_formed_target_id(c["id"]) for c in ids)


# --- (a) window gone: at resolution / before dispatch / after dispatch ---------------------------

def test_closed_at_resolution_is_not_found(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    a, _b, ids = ask(desktop, clock, registry)
    del desktop.windows[a.hwnd]
    tools = FakeE04Tools(desktop)
    report = open_dl(desktop, clock, tools, registry, target_id=ids[0])
    assert_refused(report, tools, "NOT_FOUND")
    assert report.checks[0].evidence["reason"] == "window_closed"


@pytest.mark.parametrize("change", ["pid", "class_name"])
def test_reused_handle_at_resolution_counts_as_closed(desktop, clock, change):
    registry = CandidateRegistry(clock=clock)
    a, _b, ids = ask(desktop, clock, registry)
    setattr(a, change, 9999 if change == "pid" else "CabinetWClass2")
    tools = FakeE04Tools(desktop)
    report = open_dl(desktop, clock, tools, registry, target_id=ids[0])
    assert_refused(report, tools, "NOT_FOUND")
    assert report.checks[0].evidence["reason"] == "handle_reused"


class ScriptedRegistry(LocalWindowRegistry):
    """Stand-in for E04's shared registry: the target dies after ``alive_checks`` checks."""

    def __init__(self, api, alive_checks):
        super().__init__(api)
        self.remaining = alive_checks

    def is_alive(self, identity):
        if self.remaining <= 0:
            return False
        self.remaining -= 1
        return super().is_alive(identity)


def test_gone_between_resolution_and_dispatch_is_precondition_failed(desktop, clock):
    registry = CandidateRegistry(clock=clock)
    _a, _b, ids = ask(desktop, clock, registry)
    tools = FakeE04Tools(desktop)
    windows = ScriptedRegistry(desktop, alive_checks=1)   # alive at resolve, gone at precheck
    report = open_dl(desktop, clock, tools, registry, target_id=ids[1], windows=windows)
    assert_refused(report, tools, "PRECONDITION_FAILED")
    assert report.checks[0].evidence["target_gone_before_dispatch"] is True


class ClosesTargetTools(FakeE04Tools):
    """The pinned window vanishes right after the action is sent (closed or handle reused)."""

    def __init__(self, desktop, how="close"):
        super().__init__(desktop)
        self.how = how

    def __call__(self, name, args):
        out = super().__call__(name, args)
        w = self.d.windows[args["hwnd"]]
        if self.how == "close":
            del self.d.windows[w.hwnd]
        else:
            w.pid = 31337                     # same HWND now owned by another process
        return out


@pytest.mark.parametrize("how", ["close", "reuse"])
def test_pinned_window_gone_after_dispatch_is_postcondition_unknown(desktop, clock, how):
    registry = CandidateRegistry(clock=clock)
    a, _b, ids = ask(desktop, clock, registry)
    tools = ClosesTargetTools(desktop, how)
    report = open_dl(desktop, clock, tools, registry, target_id=ids[1])
    sc = to_structured_content(report)
    assert len(tools.calls) == 1                         # never re-invoked against another window
    assert report.outcome is Outcome.UNVERIFIED and sc["verified"] is False
    assert sc["error"]["code"] == "POSTCONDITION_UNKNOWN"
    assert sc["sideEffect"] == "unknown" and sc["error"]["retryable"] is False
    assert report.check("EXP-02").evidence["target_gone"] is True
    first = next(t.path for t in a.tabs if t.tab_hwnd == a.active_tab)
    assert first == DOCS and len([w for w in desktop.windows.values() if w.is_explorer]) <= 2


def test_unpinned_window_gone_after_dispatch_is_unknown_not_failed():
    check = check_exists("EXP-02", WindowState(hwnd=0x10, exists=False), "tool_reported_hwnd")
    assert check.status.value == "unknown" and check.evidence["target_gone"] is True
    report = VerificationReport("w", [check], decision="done")
    sc = to_structured_content(report)
    assert sc["error"]["code"] == "POSTCONDITION_UNKNOWN" and sc["sideEffect"] == "unknown"


# --- (c) identity interface ---------------------------------------------------------------------

def test_local_registry_identity_and_reuse_rule(desktop):
    w = desktop.add_explorer(DOWNLOADS)
    reg = LocalWindowRegistry(desktop)
    ident = reg.identify(w.hwnd)
    assert ident == WindowIdentity(w.hwnd, w.pid, w.class_name, w.process_start_time)
    assert ident.to_contract() == {"hwnd": str(w.hwnd), "pid": str(w.pid),
                                   "windowClass": w.class_name,
                                   "processStartTime": str(w.process_start_time)}
    assert reg.is_alive(ident)
    w.pid += 1
    assert not reg.is_alive(ident)
    assert reg.identify(0xBAD) is None


def test_gate_sees_resolved_window_identity(desktop, clock):
    seen = []

    def gate(primitive, target):
        seen.append(target["window"])
        return True

    open_dl(desktop, clock, FakeE04Tools(desktop, mode="minimized"), CandidateRegistry(clock=clock),
            gate=gate)
    assert seen and all(set(s) == {"hwnd", "pid", "windowClass", "processStartTime"}
                        for s in seen)


def test_custom_registry_is_used_end_to_end(desktop, clock):
    class E04StubRegistry(LocalWindowRegistry):
        calls = 0

        def is_alive(self, identity):
            E04StubRegistry.calls += 1
            return super().is_alive(identity)

    registry, windows = CandidateRegistry(clock=clock), E04StubRegistry(desktop)
    _a, _b, ids = ask(desktop, clock, registry, windows=windows)
    report = open_dl(desktop, clock, FakeE04Tools(desktop), registry, target_id=ids[1],
                     windows=windows)
    assert report.verified and E04StubRegistry.calls >= 2
