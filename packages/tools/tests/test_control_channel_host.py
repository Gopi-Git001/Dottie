"""Host side of DOT-092 DRAFT 3: §2.3.1 timeouts (H-16), §4.4/§4.5 decision and verdict mapping incl.
panic_stop / quit as cancel causes and unknown decisions (H-08), endTask token revocation (§5.3), the
dottie.approvalToken.v1 purpose, toolCallFinished §4.6b (H-17), cancel points §6.5 (H-09), P23 cap budget
(H-04b)."""
import pytest

from dottie_tools.reference.approval import PURPOSE_ACTION_ID, PURPOSE_TOKEN, FakeCoordinator, FakeK8
from support.fakes import DOCS, DOWNLOADS, PICS


def one_window(env):
    return env.desktop.add(DOCS, foreground=True)


def refused(sc, env, code, side_effect="none"):
    assert sc["verified"] is False and sc["error"]["code"] == code, sc
    assert sc["sideEffect"] == side_effect and sc["error"]["retryable"] is False
    if side_effect == "none":
        assert env.desktop.navigations == [] and env.desktop.launches == []


# §2.3.1 timeouts -----------------------------------------------------------------------------------
def test_tmo01_request_approval_silent_turn_live_is_approval_required(env):
    one_window(env)
    refused(env.mutating("silent"), env, "APPROVAL_REQUIRED")
    assert env.k8.consumed == []


def test_tmo02_request_approval_silent_turn_ended_is_cancelled(env):
    one_window(env)
    env.host.turn_live = False
    refused(env.mutating("silent"), env, "CANCELLED")


def test_tmo03_consume_silent_is_denied_by_policy_and_nothing_sent(env):
    w = one_window(env)
    env.k8.silent = True
    refused(env.mutating("click_approve"), env, "DENIED_BY_POLICY")
    assert w.tabs == [DOCS] and env.host.diag[-1]["reason"] == "consume_timeout"


def test_tmo04_no_k8_wired_is_denied_by_policy(env):
    one_window(env)
    env.k8 = None
    env.coord = FakeCoordinator(FakeK8(env.clock), env.clock)
    refused(env.mutating("click_approve"), env, "DENIED_BY_POLICY")


# §4.4 / §4.5 mapping ------------------------------------------------------------------------------------
@pytest.mark.parametrize("answer,code", [
    ("click_deny", "USER_DECLINED"), ("timeout", "APPROVAL_REQUIRED"), ("mute", "APPROVAL_REQUIRED"),
    ("locked", "APPROVAL_REQUIRED"), ("task_cancel", "CANCELLED"), ("panic_stop", "CANCELLED"),
    ("quit", "CANCELLED"), ("turn_ended", "CANCELLED"), ("ipc_disconnect", "CANCELLED"),
    ("tray_yes", "DENIED_BY_POLICY"), ("denied", "DENIED_BY_POLICY"),
    ("unknown_none", "DENIED_BY_POLICY"), ("unknown_typo", "DENIED_BY_POLICY"),
    ("approved_without_token", "DENIED_BY_POLICY"),
])
def test_dec01_approval_decision_mapping_fails_closed(env, answer, code):
    one_window(env)
    refused(env.mutating(answer), env, code)


@pytest.mark.parametrize("cause,code", [("task_cancel", "CANCELLED"), ("panic_stop", "CANCELLED"),
                                        ("quit", "CANCELLED"), ("mute", "DENIED_BY_POLICY"),
                                        ("locked", "DENIED_BY_POLICY"), ("app_server_restart", "DENIED_BY_POLICY")])
def test_rev01_token_revoked_between_mint_and_consume(env, cause, code):
    w = one_window(env)
    env.desktop.on_before_dispatch = lambda d: env.k8.revoke_all(cause)
    refused(env.mutating("click_approve"), env, code)
    assert w.tabs == [DOCS]


def test_rev02_end_task_revokes_unconsumed_tokens(env):
    w = one_window(env)
    env.desktop.on_before_dispatch = lambda d: env.k8.end_task(env.ctx.task_id)
    refused(env.mutating("click_approve"), env, "DENIED_BY_POLICY")
    assert w.tabs == [DOCS] and env.k8.audit[-1]["reason"] == "end_task"   # K8 audits; host diag only


def test_rev03_end_task_of_another_task_leaves_the_token_valid(env):
    w = one_window(env)
    env.desktop.on_before_dispatch = lambda d: env.k8.end_task("task-other")
    assert env.mutating("click_approve")["verified"] is True and w.path == DOWNLOADS


def test_pur01_token_purpose_is_approval_token_v1_and_distinct(env):
    assert PURPOSE_TOKEN == "dottie.approvalToken.v1" and PURPOSE_TOKEN != PURPOSE_ACTION_ID
    one_window(env)
    env.mutating("click_approve")
    tok = env.k8.minted[-1]
    assert tok.startswith("k8t1.") and tok.count(".") == 2


# toolCallFinished §4.6b + cancel points §6.5 ---------------------------------------------------------
def finished(env):
    assert len(env.host.finished) == 1, env.host.finished
    f = env.host.finished[0]
    return f["phase"], f["sideEffect"]


def test_fin01_verified_reports_completed_committed_once(env):
    one_window(env)
    assert env.call()["verified"] is True
    assert finished(env) == ("completed", "committed")
    assert env.host.finished[0]["taskId"] == "task-1" and env.host.finished[0]["toolId"] == "explorer.open_known_folder"


def test_fin02_already_there_is_completed_none(env):
    env.desktop.add(DOWNLOADS, foreground=True)
    env.call()
    assert finished(env) == ("completed", "none")


def test_fin03_refusals_report_not_started_or_before_send(env):
    env.call(folder="nope")
    assert finished(env) == ("not_started", "none")
    env.host.finished.clear()
    env.call(targetId="c_000000000000")
    assert finished(env) == ("before_send", "none")


def test_fin04_unauthorized_calls_send_no_notification(env):
    one_window(env)
    env.call(ctx=None)
    assert env.host.finished == []


def test_can01_cancel_before_dispatch_is_cancelled_none_before_send(env):
    w = one_window(env)
    env.desktop.on_before_dispatch = lambda d: setattr(env, "cancel_requested", True)
    refused(env.call(), env, "CANCELLED")
    assert finished(env) == ("before_send", "none") and w.tabs == [DOCS]


def test_can02_cancel_before_consume_keeps_the_token_unspent(env):
    one_window(env)
    env.desktop.on_before_dispatch = lambda d: setattr(env, "cancel_requested", True)
    refused(env.mutating("click_approve"), env, "CANCELLED")
    assert env.k8.consumed == [] and finished(env) == ("before_send", "none")


def test_can03_cancel_racing_the_call_is_unknown_after_send(env):
    one_window(env)
    env.desktop.on_navigate = lambda d, h, p: setattr(env, "cancel_requested", True)
    sc = env.call()
    assert sc["error"]["code"] == "CANCELLED" and sc["sideEffect"] == "unknown"
    assert finished(env) == ("after_send", "unknown")


def test_can04_cancel_at_start_of_lookup(env):
    one_window(env)
    env.cancel_requested = True
    refused(env.call(), env, "CANCELLED")
    assert finished(env) == ("before_send", "none")


def test_fin05_window_gone_after_send_is_after_send_unknown(env):
    one_window(env)
    env.desktop.navigate_is_noop = True
    env.desktop.on_navigate = lambda d, h, p: d.close(h)
    assert env.call()["error"]["code"] == "POSTCONDITION_UNKNOWN"
    assert finished(env) == ("after_send", "unknown")


def test_fin06_deadline_is_after_send_unknown(env):
    one_window(env)
    env.desktop.navigate_is_noop = True
    assert env.call()["error"]["code"] == "POSTCONDITION_FAILED"
    assert finished(env) == ("after_send", "unknown")


# H-04b P23 cap budget -----------------------------------------------------------------------------------
def test_cap01_three_clarifications_and_a_max_approval_never_trip_the_cap(env):
    a = env.desktop.add(DOCS)
    env.desktop.add(PICS)
    cands = env.call()["observedState"]["candidates"]
    for n in (2, 3, 4):                                  # 3 clarification turns x 30 s
        env.clock.t += 30
        env.next_turn(f"turn-{n}")
    env.clock.t += 120                                   # approval hard max
    sc = env.mutating("click_approve", targetId=cands[0]["id"])
    assert sc["verified"] is True and a.path == DOWNLOADS


@pytest.mark.parametrize("answer", ["unknown_none", "unknown_typo"])
def test_dec02_non_contract_decision_is_audited_as_unknown_decision(env, answer):
    one_window(env)
    refused(env.mutating(answer), env, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "unknown_decision" and env.k8.consumed == []
