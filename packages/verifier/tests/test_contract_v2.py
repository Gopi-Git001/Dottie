"""CONTRACTS v2 (ADR-0012, accepted 2026-10-19): every shape the verifier emits, plus
ADR-0009/0010."""

import json
import re

import pytest

from dottie_verifier.contract import (
    CHECK_STATUSES,
    DECISIONS,
    ERROR_CODES,
    SIDE_EFFECTS,
    TASK_OUTCOMES,
    VERIFIER_OUTCOMES,
    ledger_value,
    side_effect,
    task_outcome,
    to_mcp_tool_result,
    to_structured_content,
    to_verification_result,
)
from dottie_verifier.explorer_workflow import (
    allow_all,
    deny_all,
    spoken_summary,
    verify_open_downloads,
)
from dottie_verifier.known_folders import FOLDERID
from dottie_verifier.model import Outcome
from dottie_verifier.recovery import RetryPolicy
from tests.fakes import DOWNLOADS, FakeDesktop, FakeE04Tools
from tests.router_fixture import router_tool_result_event

RETRY = RetryPolicy(jitter=0)
ISO = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d"
SNAKE = re.compile(r"^[a-z][a-z0-9_]*$")
MODES = ["normal", "lies", "raises", "minimized", "no_focus", "two_windows", "wrong_folder",
         "wrong_folder_once", "background_tab"]


def run(desktop, clock, tools, gate=allow_all, cancelled=None):
    return verify_open_downloads(desktop, tools, retry=RETRY, sleep=clock.sleep, clock=clock,
                                 recovery_gate=gate, cancelled=cancelled)


def run_mode(desktop, clock, mode):
    desktop.allow_foreground = mode != "no_focus"
    return run(desktop, clock, FakeE04Tools(desktop, mode=mode))


class PolicyRefusingTools(FakeE04Tools):
    def __init__(self, desktop, error="User approval required."):
        super().__init__(desktop)
        self.error = error

    def __call__(self, name, args):
        self.calls.append((name, args))
        return {"success": False, "error": self.error}


def assert_observed_state(state):
    assert {"outcome", "decision", "checks", "sideEffect"} <= set(state)
    assert set(state) <= {"outcome", "decision", "checks", "sideEffect", "question", "candidates"}
    assert state["outcome"] in VERIFIER_OUTCOMES and state["sideEffect"] in SIDE_EFFECTS
    assert state["decision"] in DECISIONS
    assert all(v in CHECK_STATUSES for v in state["checks"].values())
    for c in state.get("candidates", []):
        assert set(c) == {"id", "label"}


def assert_error(err, side):
    assert set(err) == {"code", "message", "retryable"} and err["code"] in ERROR_CODES
    assert isinstance(err["message"], str) and err["message"]
    if err["retryable"]:
        assert side == "none"


# --- §5 MCP structuredContent / isError -------------------------------------------------------

def test_verified_structured_content_is_exact(desktop, clock):
    sc = to_structured_content(run(desktop, clock, FakeE04Tools(desktop)), evidence_ref="ev-1")
    assert set(sc) == {"verified", "observedState", "sideEffect", "evidenceRef"}
    assert "success" not in sc and sc["verified"] is True and sc["sideEffect"] == "committed"
    assert sc["observedState"]["sideEffect"] == sc["sideEffect"]
    assert_observed_state(sc["observedState"])


@pytest.mark.parametrize("mode", MODES)
def test_every_shape_obeys_v2_invariants(desktop, clock, mode):
    report = run_mode(desktop, clock, mode)
    sc = to_structured_content(report)
    mcp = to_mcp_tool_result(report, spoken_summary(report))
    vr = to_verification_result(report)
    payload = router_tool_result_event(mcp, task_id="t1", tool_id="explorer.open_known_folder",
                                       correlation_id="corr", causation_id="call-1")["payload"]
    assert mcp["isError"] is (not report.verified) and mcp["structuredContent"] == sc
    assert set(sc) <= {"verified", "observedState", "sideEffect", "error", "evidenceRef"}
    assert set(vr) <= {"outcome", "verified", "observedState", "error", "evidenceRef"}
    assert vr["verified"] is (vr["outcome"] == "verified")
    assert set(payload) <= {"taskId", "toolId", "observedState", "verified", "error", "sideEffect",
                            "evidenceRef"}
    for shape in (sc, vr, payload):
        assert "success" not in shape
        assert ("error" in shape) is (not shape["verified"])        # error ⇔ verified:false
        assert_observed_state(shape["observedState"])
        if "error" in shape:
            assert_error(shape["error"], sc["sideEffect"])


@pytest.mark.parametrize("setup,mode,code", [
    ("two_windows_unfocused", "normal", "AMBIGUOUS"),
    ("missing_dir", "normal", "NOT_FOUND"),
    ("no_known_folder", "normal", "PRECONDITION_FAILED"),
    ("wrong_class", "lies", "PRECONDITION_FAILED"),
    ("none", "lies", "POSTCONDITION_UNKNOWN"),
    ("deny_gate", "wrong_folder", "POSTCONDITION_FAILED"),
])
def test_error_codes_use_v2_vocabulary(desktop, clock, setup, mode, code):
    if setup == "two_windows_unfocused":
        desktop.add_explorer(r"C:\Users\<user>\Documents")
        desktop.add_explorer(r"C:\Users\<user>\Pictures")
    elif setup == "missing_dir":
        desktop.dirs.clear()
    elif setup == "no_known_folder":
        desktop.known.pop(FOLDERID["downloads"])
    elif setup == "wrong_class":
        desktop.add_explorer(DOWNLOADS, foreground=True, class_name="Progman")
    gate = deny_all if setup == "deny_gate" else allow_all
    report = run(desktop, clock, FakeE04Tools(desktop, mode=mode), gate=gate)
    sc = to_structured_content(report)
    assert sc["verified"] is False and sc["error"]["code"] == code
    assert_error(sc["error"], sc["sideEffect"])


def test_retryable_only_when_side_effect_none(desktop, clock):
    # "lies": the tool ran and nothing was observed -> side effect unknown -> never retryable.
    sc = to_structured_content(run(desktop, clock, FakeE04Tools(desktop, mode="lies")))
    assert sc["sideEffect"] == "unknown" and sc["error"]["retryable"] is False


@pytest.mark.parametrize("message,code", [("User approval required.", "APPROVAL_REQUIRED"),
                                          ("Action not approved.", "USER_DECLINED"),
                                          ({"code": "DENIED_BY_POLICY"}, "DENIED_BY_POLICY"),
                                          ({"code": "USER_DECLINED"}, "USER_DECLINED"),
                                          ({"code": "NEEDS_APPROVAL"}, "APPROVAL_REQUIRED"),
                                          ({"code": "PERMISSION_REQUIRED"}, "PERMISSION_REQUIRED")])
def test_policy_refusal_codes_and_no_retry(desktop, clock, message, code):
    tools = PolicyRefusingTools(desktop, message)
    report = run(desktop, clock, tools)
    sc = to_structured_content(report)
    assert len(tools.calls) == 1
    assert sc["error"]["code"] == code and sc["error"]["retryable"] is False
    assert sc["sideEffect"] == "none"


def test_side_effect_is_conservative(desktop, clock):
    assert side_effect(run(desktop, clock, FakeE04Tools(desktop))) == "committed"
    fresh = FakeDesktop()
    assert side_effect(run(fresh, clock, FakeE04Tools(fresh, mode="raises"))) == "unknown"


# --- ask-the-user path (P6) and redaction (P3) --------------------------------------------------

def test_ambiguous_carries_question_and_opaque_candidates(desktop, clock):
    desktop.known[FOLDERID["documents"]] = r"C:\Users\<user>\Documents"
    a = desktop.add_explorer(r"C:\Users\<user>\Documents")
    b = desktop.add_explorer(r"C:\Users\<user>\Projects\secret-client")
    sc = to_structured_content(run(desktop, clock, FakeE04Tools(desktop)))
    state = sc["observedState"]
    assert sc["error"]["code"] == "AMBIGUOUS" and state["question"]
    assert len(state["candidates"]) == 2
    labels = {c["label"] for c in state["candidates"]}
    assert "File Explorer window showing Documents" in labels and "File Explorer window 2" in labels
    ids = {c["id"] for c in state["candidates"]}
    assert all(re.fullmatch(r"c_[0-9a-f]{12}", i) for i in ids)
    assert str(a.hwnd) not in json.dumps(state) and str(b.hwnd) not in ids


@pytest.mark.parametrize("mode", MODES)
def test_emitted_shapes_never_leak_titles_or_user_paths(desktop, clock, mode):
    desktop.add_explorer(r"C:\Users\<user>\Projects\secret-client",
                         title="secret-client - File Explorer")
    report = run_mode(desktop, clock, mode)
    blob = json.dumps([to_structured_content(report), to_verification_result(report),
                       to_mcp_tool_result(report, "summary")])
    for leak in ("<user>", "Users", "secret-client", "File Explorer\"", ":\\\\"):
        assert leak not in blob, (mode, leak)


# --- §3: the coordinator's tool router builds ToolResult; the verifier only returns data ----------

def test_verifier_does_not_export_an_event_builder():
    from dottie_verifier import contract
    assert not any(hasattr(contract, n) for n in ("envelope", "to_tool_result_event",
                                                  "tool_result_payload"))


def test_router_fixture_fits_v2_envelope(desktop, clock):
    report = run(desktop, clock, FakeE04Tools(desktop))
    ev = router_tool_result_event(to_mcp_tool_result(report, "ok", evidence_ref="ev-1"),
                                  task_id="task-1", tool_id="explorer.open_known_folder",
                                  correlation_id="corr-1", causation_id="call-evt-1",
                                  event_id="e-1")
    assert set(ev) == {"schema", "version", "type", "eventId", "correlationId", "causationId",
                       "taskId", "timestamp", "payload"}
    assert ev["schema"] == "dottie.event" and ev["version"] == 2 and ev["type"] == "ToolResult"
    assert re.fullmatch(ISO, ev["timestamp"])
    assert set(ev["payload"]) == {"taskId", "toolId", "observedState", "verified", "sideEffect",
                                  "evidenceRef"}


@pytest.mark.parametrize("mode", MODES)
def test_all_enum_values_are_snake_case(desktop, clock, mode):
    report = run_mode(desktop, clock, mode)
    state = to_structured_content(report)["observedState"]
    for value in (state["outcome"], state["decision"], state["sideEffect"],
                  *state["checks"].values()):
        assert SNAKE.match(value), value
    for value in (*VERIFIER_OUTCOMES, *TASK_OUTCOMES, *SIDE_EFFECTS):
        assert SNAKE.match(value)


# --- §3.1 outcome mapping (P1); there is no "cancelled" outcome ---------------------------------

@pytest.mark.parametrize("verifier,ledger,task", [
    ("verified", "committed", "succeeded"),
    ("partially_verified", "committed", "partial"),
    ("unverified", "possible", "unverified"),
    ("failed", "none", "failed"),
    ("failed", "committed", "failed_after_side_effects"),
    ("failed", "possible", "failed_after_side_effects"),
])
def test_task_outcome_mapping(verifier, ledger, task):
    assert task_outcome(verifier, ledger) == task and task in TASK_OUTCOMES
    assert "cancelled" not in TASK_OUTCOMES + VERIFIER_OUTCOMES + DECISIONS


def test_ledger_value_maps_unknown_to_possible():
    assert [ledger_value(s) for s in SIDE_EFFECTS] == ["none", "committed", "possible"]


# --- ADR-0009 fail-closed recovery (P12 deferred: default stays deny) ---------------------------

def test_direct_recovery_is_denied_by_default(desktop, clock):
    report = verify_open_downloads(desktop, FakeE04Tools(desktop, mode="minimized"), retry=RETRY,
                                   sleep=clock.sleep, clock=clock)   # default gate = deny_all
    assert not any(c.startswith("restore:") for c in desktop.calls)
    assert report.outcome is Outcome.FAILED
    assert report.decision_reason.startswith("recovery denied by policy")
    assert report.attempts[0].recovery[0].startswith("denied_by_policy:restore_window")


def test_gate_sees_each_primitive_with_its_target(desktop, clock):
    seen = []

    def gate(primitive, target):
        seen.append((primitive, int(target["hwnd"])))
        return primitive == "restore_window"

    desktop.allow_foreground = False
    report = run(desktop, clock, FakeE04Tools(desktop, mode="minimized"), gate=gate)
    assert ("restore_window", report.check("EXP-02").evidence["hwnd"]) in seen
    assert any(p == "set_foreground" for p, _ in seen)
    assert not any(c.startswith("foreground:") for c in desktop.calls)


def test_reinvoking_policy_gated_e04_tool_needs_no_extra_grant(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>\Desktop", foreground=True)
    report = run(desktop, clock, FakeE04Tools(desktop, mode="wrong_folder_once"), gate=deny_all)
    assert report.outcome is Outcome.VERIFIED


# --- ADR-0010 cancellation -> error.code CANCELLED (TaskCancelled is the coordinator's) -----------

def test_cancel_before_dispatch(desktop, clock):
    tools = FakeE04Tools(desktop)
    report = run(desktop, clock, tools, cancelled=lambda: True)
    sc = to_structured_content(report)
    assert tools.calls == [] and report.tool_invoked is False
    assert sc["verified"] is False and sc["sideEffect"] == "none"
    assert sc["error"] == {"code": "CANCELLED", "message": sc["error"]["message"],
                           "retryable": False}
    assert sc["observedState"]["decision"] == "stop"
    assert sc["observedState"]["outcome"] in VERIFIER_OUTCOMES


def test_cancel_during_verification_stops_recovery(desktop, clock):
    desktop.add_explorer(r"C:\Users\<user>\Documents", foreground=True)
    ticks = iter(range(1000))
    report = run(desktop, clock, FakeE04Tools(desktop, delay=50),
                 cancelled=lambda: next(ticks) >= 2)
    sc = to_structured_content(report)
    assert report.decision == "stop" and report.cancelled
    assert all(a.recovery == [] for a in report.attempts)
    assert not desktop.calls
    assert sc["error"]["code"] == "CANCELLED" and sc["error"]["retryable"] is False
    # the tool was dispatched; the ledger counts it as possible
    assert sc["sideEffect"] == "unknown"


def test_cancel_after_goal_verified_reports_verified(desktop, clock):
    ticks = iter(range(1000))
    report = run(desktop, clock, FakeE04Tools(desktop), cancelled=lambda: next(ticks) >= 1)
    sc = to_structured_content(report)
    assert report.decision == "done" and sc["verified"] is True and "error" not in sc
