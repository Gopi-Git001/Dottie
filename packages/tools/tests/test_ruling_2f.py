"""E01 ruling 2f (dottie-e01 9a49722): (1) toolCallFinished.reason is a CLOSED enum of host-detected refusals and
never carries a K8-originated reason; (2) a late approve on an already-answered actionId -> reused;
(3) a malformed desktop ApprovalResolved for a tool-host approval -> DENIED_BY_POLICY{schema_invalid}, no token,
nothing dispatched, sideEffect none."""
import pytest

from dottie_tools.reference.approval import ChannelTimeout, FakeCoordinator
from dottie_tools.reference.reference import FINISHED_REASONS, finished_reason
from test_e08_draft4_host import one_window

CLOSED = {"known_folder_redirected", "locked", "schema_invalid", "catalog_mismatch", "precondition_failed"}


# ------------------------------------------------------------------ (1) closed enum
def test_2f_enum_is_exactly_the_ruled_five():
    assert FINISHED_REASONS == CLOSED


@pytest.mark.parametrize("r", ["display_unavailable", "reused", "user_declined", "channel_not_allowed", "mute",
                               "panic_stop", "task_cancel", "gate_state_unavailable", "remint_refused",
                               "unknown_decision", "revoked_cancel", "no_k8", "consume_refused", "consume_timeout",
                               "check_policy_failed", "wrong_action", "superseded", "turn_end", "LOCKED", "locked ",
                               "", None, 1, ["locked"]])
def test_2f_anything_outside_the_enum_is_never_emitted(r):
    assert finished_reason(r) is None


def test_2f_host_detected_reasons_map_into_the_enum():
    for r in CLOSED:
        assert finished_reason(r) == r
    assert finished_reason("reserved_model_arg") == "schema_invalid"


def _scenarios():
    """Many host paths, each ending with a toolCallFinished."""
    def coord(env, answer):
        env.coord = FakeCoordinator(env.k8, env.clock)
        env.coord.answer = answer
        return env.call(category="local_change", coordinator=env.coord)

    yield "navigate_ok", lambda env: env.call()
    yield "redirected", lambda env: (env.desktop.known.__setitem__("downloads", r"\\srv\share\Downloads"),
                                     env.call())
    yield "locked", lambda env: (setattr(env.host, "locked", True), env.call())
    yield "gate_unreadable", lambda env: (setattr(env.host, "locked", None), env.call())
    yield "muted", lambda env: (setattr(env.host, "muted", True), env.call())
    yield "reserved_key", lambda env: env.call(taskId="x")
    yield "catalog_mismatch", lambda env: env.call(stated_category="read")
    yield "policy_denied", lambda env: (setattr(env, "policy_reply", {"ok": False, "error": {"code": "DENIED_BY_POLICY"}}),
                                        env.call())
    yield "policy_timeout", lambda env: (setattr(env, "policy_reply", ChannelTimeout("2 s")), env.call())
    yield "no_k8_consume", lambda env: (setattr(env.k8, "silent", True), coord(env, "click_approve"))
    for a in ("click_approve", "click_deny", "tray_yes", "timeout", "task_cancel", "mute", "panic_stop",
              "ipc_disconnect", "denied", "unknown_none", "desktop_display_unavailable", "desktop_raw",
              "desktop_approve"):
        yield f"approval_{a}", (lambda a: lambda env: coord(env, a))(a)


@pytest.mark.parametrize("name,run", list(_scenarios()), ids=[n for n, _ in _scenarios()])
def test_2f_host_only_ever_emits_the_closed_enum(env, name, run):
    one_window(env)
    run(env)
    assert env.host.finished, name
    for note in env.host.finished:
        assert "reason" not in note or note["reason"] in CLOSED, (name, note)


# ------------------------------------------------------------------ (3) malformed desktop answers
MALFORMED = {
    "missing_approved": lambda aid: {"actionId": aid, "timestamp": 0.0},
    "approved_str": lambda aid: {"actionId": aid, "approved": "false", "timestamp": 0.0},
    "approved_int": lambda aid: {"actionId": aid, "approved": 0, "timestamp": 0.0},
    "approved_null": lambda aid: {"actionId": aid, "approved": None, "timestamp": 0.0},
    "unknown_reason": lambda aid: {"actionId": aid, "approved": False, "reason": "user_busy", "timestamp": 0.0},
    "reason_with_approve": lambda aid: {"actionId": aid, "approved": True, "reason": "display_unavailable",
                                        "timestamp": 0.0},
    "action_id_int": lambda aid: {"actionId": 7, "approved": False, "timestamp": 0.0},
    "action_id_list": lambda aid: {"actionId": [aid], "approved": False, "timestamp": 0.0},
    "action_id_empty": lambda aid: {"actionId": "", "approved": False, "timestamp": 0.0},
    "action_id_other": lambda aid: {"actionId": "f" * 64, "approved": True, "timestamp": 0.0},
    "desktop_decision": lambda aid: {"actionId": aid, "approved": False, "decision": "expired", "timestamp": 0.0},
    "extra_key_token": lambda aid: {"actionId": aid, "approved": True, "token": "k8t1.x.y", "timestamp": 0.0},
    "not_an_object": lambda aid: [aid, True],
}


@pytest.mark.parametrize("shape", list(MALFORMED))
def test_2f_malformed_desktop_answer_is_schema_invalid_no_token_no_dispatch(env, shape):
    one_window(env)
    env.coord = FakeCoordinator(env.k8, env.clock)
    env.coord.answer = "desktop_raw"
    env.coord.desktop_message = MALFORMED[shape]
    sc = env.call(category="local_change", coordinator=env.coord)
    assert sc["verified"] is False and sc["sideEffect"] == "none"
    assert sc["error"]["code"] == "DENIED_BY_POLICY"
    assert env.k8.minted == [] and env.k8.consumed == []
    assert env.desktop.navigations == [] and env.desktop.launches == []
    rec = env.k8.audit[-1]
    assert rec["kind"] == "approval.resolved" and rec["decision"] == "denied_by_policy" \
        and rec["reason"] == "schema_invalid"
    assert "reason" not in env.host.finished[-1]                                    # K8's reason, not forwarded


def test_2f_after_a_malformed_answer_the_action_id_is_final(env):
    test_2f_malformed_desktop_answer_is_schema_invalid_no_token_no_dispatch(env, "missing_approved")
    aid = env.coord.requests[0]["actionId"]
    env.coord.answer = "desktop_approve"
    sc = env.call(category="local_change", coordinator=env.coord)
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and env.k8.minted == [] and env.desktop.navigations == []
    assert env.k8.audit[-1]["reason"] == "reused" and env.k8.audit[-1]["actionId"] == aid


@pytest.mark.parametrize("approved,reason,want", [(True, None, "approved"), (False, None, "declined"),
                                                  (False, "display_unavailable", "denied_by_policy")])
def test_2f_well_formed_answers_still_work(env, approved, reason, want):
    one_window(env)
    env.coord = FakeCoordinator(env.k8, env.clock)
    env.coord.answer = "desktop_raw"
    env.coord.desktop_message = lambda aid: {"actionId": aid, "approved": approved, "timestamp": 0.0,
                                             **({"reason": reason} if reason else {})}
    sc = env.call(category="local_change", coordinator=env.coord)
    assert env.k8.audit[[r["kind"] for r in env.k8.audit].index("approval.resolved")]["decision"] == want
    assert sc["verified"] is (want == "approved")


@pytest.mark.parametrize("name,want", [("redirected", "known_folder_redirected"), ("locked", "locked"),
                                       ("reserved_key", "schema_invalid"), ("catalog_mismatch", "catalog_mismatch")])
def test_2f_scenarios_do_emit_host_reasons(env, name, want):
    """The enum test is not vacuous: host-detected refusals still carry their (closed-enum) reason."""
    one_window(env)
    dict(_scenarios())[name](env)
    assert env.host.finished[-1].get("reason") == want, env.host.finished[-1]
