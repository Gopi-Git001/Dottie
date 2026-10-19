"""Host side of the E08 review as merged in DOT-092 DRAFT 4: item 12 (navigate: second K8 checkPolicy
right before Explorer + the host's own lock and enum checks; H-19, C-18b host half), item 2 (exact consume
reply; consume-time state; K-06/K-07 host half), item 10 (late consume reply; H-20), item 11 (CANCELLED is
final), X1/X7 (the host writes no audit; fallback observedState has no path/title; H-21)."""
import json

import pytest

from dottie_tools.reference.approval import ChannelTimeout, FakeCoordinator
from support.fakes import DOCS, DOWNLOADS

ALLOWED = {"ok": True, "data": {"allowed": True}}


def one_window(env):
    return env.desktop.add(DOCS, foreground=True)


def refused(sc, env, code):
    assert sc["verified"] is False and sc["error"]["code"] == code, sc
    assert sc["sideEffect"] == "none" and env.desktop.navigations == [] and env.desktop.launches == []


def methods(env):
    return [r["method"] for r in env.k8.requests]


# item 12: checkPolicy + host checks ---------------------------------------------------------------------
def test_h18_navigate_calls_check_policy_once_right_before_explorer(env):
    a = one_window(env)
    order = []
    env.desktop.on_navigate = lambda d, h, p: order.append("explorer")
    env.policy_reply = lambda req: (order.append("checkPolicy"), env.k8.check_policy(req, task_id="task-1"))[1]
    assert env.call()["verified"] is True and a.path == DOWNLOADS
    assert order == ["checkPolicy", "explorer"]
    assert env.policy_requests == [{"v": 1, "callId": "call-1", "toolId": "explorer.open_known_folder",
                                    "category": "navigate"}]


@pytest.mark.parametrize("what", ["muted", "locked", "panic"])
def test_c18b_host_mute_lock_panic_between_authorize_and_send_is_denied(env, what):
    one_window(env)

    def flip(d):
        if what == "muted":
            env.k8.muted = True
        elif what == "locked":
            env.k8.locked = True
        else:
            env.k8.panic_stopped.add("task-1")
    env.desktop.on_before_dispatch = flip
    refused(env.authorized(), env, "DENIED_BY_POLICY")
    assert env.k8.audit[-1]["reason"] == {"muted": "mute", "locked": "locked", "panic": "panic_stop"}[what]


def test_h19_host_lock_check_refuses_even_when_k8_says_yes(env):
    one_window(env)

    def k8_says_yes_but_session_locks(req):
        env.host.locked = True                                     # WTSQuerySessionInformation: locked
        return dict(ALLOWED)
    env.policy_reply = k8_says_yes_but_session_locks
    refused(env.call(), env, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "locked"


def test_h19b_host_lock_state_unreadable_right_before_send_is_denied(env):
    one_window(env)

    def unreadable(req):
        env.host.locked = None
        return dict(ALLOWED)
    env.policy_reply = unreadable
    refused(env.call(), env, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "gate_state_unavailable"


@pytest.mark.parametrize("folder", ["Downloads", "..\\Windows", "profile", None])
def test_h19c_folder_outside_the_enum_never_reaches_k8(env, folder):
    one_window(env)
    refused(env.raw({"folder": folder}), env, "INVALID_ARGUMENT")
    assert env.policy_requests == []


def test_h19d_bad_known_folder_result_never_reaches_k8(env):
    one_window(env)
    env.desktop.known["downloads"] = r"\\evil\share"
    refused(env.call(), env, "DENIED_BY_POLICY")
    assert env.policy_requests == [] and env.host.diag[-1]["reason"] == "known_folder_redirected"


@pytest.mark.parametrize("reply", [
    {"ok": 1, "data": {"allowed": True}}, {"ok": True, "data": {"allowed": 1}}, {"ok": True, "data": {"allowed": "true"}},
    {"ok": True, "data": {"allowed": True, "x": 1}}, {"ok": True, "data": {"allowed": True}, "id": "c:9"},
    {"ok": True}, {"ok": False, "error": {"code": "DENIED_BY_POLICY"}}, None, "yes", [], ChannelTimeout("2 s"),
    RuntimeError("pipe closed"),
], ids=["ok_int", "allowed_int", "allowed_str", "extra_data_key", "extra_key", "no_data", "denied", "none",
        "str", "list", "timeout", "channel_error"])
def test_h18b_only_the_exact_allowed_reply_lets_explorer_run(env, reply):
    one_window(env)
    env.policy_reply = reply
    refused(env.call(), env, "DENIED_BY_POLICY")


def test_h18c_check_policy_permission_required_is_passed_through(env):
    one_window(env)
    env.policy_reply = {"ok": False, "error": {"code": "PERMISSION_REQUIRED", "message": "scope", "retryable": False},
                        "sideEffect": "none"}
    refused(env.call(), env, "PERMISSION_REQUIRED")


def test_h18d_mutating_and_launch_paths_do_not_call_check_policy(env):
    one_window(env)
    assert env.mutating("click_approve")["verified"] is True
    assert env.policy_requests == [] and "checkPolicy" not in methods(env)


# item 2 / 10 / 11: consume ------------------------------------------------------------------------------
@pytest.mark.parametrize("reply", [
    {"ok": True, "data": {"consumed": 1}}, {"ok": "true", "data": {"consumed": True}},
    {"ok": True, "data": {"consumed": True}, "x": 1}, {"ok": True, "data": {"consumed": True, "token": "t"}},
    {"ok": True}, {"ok": True, "data": None}, [], "ok",
], ids=["consumed_int", "ok_str", "extra_key", "extra_data_key", "no_data", "data_none", "list", "str"])
def test_k07_host_any_consume_reply_but_the_exact_one_never_dispatches(env, reply):
    w = one_window(env)
    env.k8.reply_override = reply
    refused(env.mutating("click_approve"), env, "DENIED_BY_POLICY")
    assert w.tabs == [DOCS]


def test_h20_consume_silent_then_late_ok_never_dispatches_or_retries(env):
    w = one_window(env)
    env.k8.silent = True
    sc = env.mutating("click_approve")
    refused(sc, env, "DENIED_BY_POLICY")
    assert env.k8.late_replies == [{"ok": True, "data": {"consumed": True}}]          # arrived late, ignored
    assert methods(env).count("consumeToolToken") == 1 and w.tabs == [DOCS]           # no retry
    assert env.host.finished[-1]["phase"] == "before_send" and env.host.finished[-1]["sideEffect"] == "none"
    assert env.k8.audit[-1]["outcome"] == "consumed_not_dispatched"


@pytest.mark.parametrize("state,code,reason", [("locked", "DENIED_BY_POLICY", "locked"),
                                               ("muted", "DENIED_BY_POLICY", "mute"),
                                               ("panic", "CANCELLED", "panic_stop"),
                                               ("stop", "CANCELLED", "task_cancel")])
def test_k06_host_consume_time_state_is_checked_by_k8(env, state, code, reason):
    one_window(env)

    def flip(d):
        if state == "locked":
            env.k8.locked = True
        elif state == "muted":
            env.k8.muted = True
        elif state == "panic":
            env.k8.panic_stopped.add("task-1")
        else:
            env.k8.stop_requested.add("task-1")
    env.desktop.on_before_dispatch = flip
    refused(env.mutating("click_approve"), env, code)
    assert env.k8.audit[-1]["reason"] == reason


def test_e08_11_cancelled_consume_is_final_no_retry_no_new_approval(env):
    one_window(env)
    env.desktop.on_before_dispatch = lambda d: env.k8.revoke_all("task_cancel")
    refused(env.mutating("click_approve"), env, "CANCELLED")
    assert len(env.coord.requests) == 1 and methods(env).count("consumeToolToken") == 1


# X1 / X7 -------------------------------------------------------------------------------------------------
def test_h21_host_writes_no_audit_and_its_diagnostics_carry_no_args_tokens_or_paths(env):
    one_window(env)
    env.call(folder="pictures")                                    # ok
    env.k8.reply_override = {"ok": False}
    env.mutating("click_approve")                                  # consume refused
    env.call(taskId="SECRET-ARG-VALUE")                            # reserved key
    env.desktop.known["downloads"] = r"\\srv\share"
    env.call()                                                     # redirected
    assert not hasattr(env.host, "audit")
    blob = json.dumps([env.host.diag, env.host.finished])
    for bad in ["SECRET-ARG-VALUE", "Users", ":\\\\", "srv", "k8t1."] + env.k8.minted:
        assert bad not in blob, bad
    for rec in env.host.diag:
        assert set(rec) <= {"event", "code", "reason", "argKeys"}


def test_h21b_fallback_observed_state_has_no_full_path_or_title(env):
    one_window(env)
    sc = env.call(category="local_change")                         # no coordinator path -> APPROVAL_REQUIRED
    assert sc["error"]["code"] == "APPROVAL_REQUIRED"
    blob = json.dumps(sc)
    assert "Users" not in blob and ":\\\\" not in blob and "Documents" not in blob
    assert set(sc["observedState"]) <= {"outcome", "decision", "checks", "sideEffect", "actionId"}


@pytest.mark.parametrize("code", ["CANCELLED", "PRECONDITION_FAILED"])
def test_h18e_check_policy_r1_codes_pass_through_without_k8_text(env, code):
    """DRAFT 5 §4.5c R1: CheckPolicyResult may be CANCELLED / PRECONDITION_FAILED; the host passes the code
    through, sends nothing, and never relays K8's message (reason) to the model."""
    one_window(env)
    env.policy_reply = {"ok": False, "error": {"code": code, "message": "turn_end secret-reason", "retryable": False},
                        "sideEffect": "none"}
    r = env.call()
    refused(r, env, code)
    assert "turn_end" not in str(r) and "secret-reason" not in str(r)
