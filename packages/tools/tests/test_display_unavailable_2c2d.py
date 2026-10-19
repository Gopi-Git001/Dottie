"""E01 rulings 2c/2d (dottie-e01 a147dbe, 9a14ead), tool-host side with the K8 fake.

The desktop answers a tool-host ApprovalRequested with ApprovalResolved{approved:false, reason:'display_unavailable'}:
(a) K8 mints no token; (b) nothing executes, sideEffect none; (c) the caller gets DENIED_BY_POLICY; K8 records reason
display_unavailable (CR5; never a user decline, 2d) and the host does not forward it (2f); (d) a later approve for the same actionId is rejected as
already answered (CR5 `reused`): no mint, no execution, still denied."""
from dottie_tools.reference.approval import APPROVAL_TTL_S, FakeCoordinator
from test_e08_draft4_host import one_window


def _desktop_unavailable(env):
    one_window(env)
    env.coord = FakeCoordinator(env.k8, env.clock)
    env.coord.answer = "desktop_display_unavailable"
    return env.call(category="local_change", coordinator=env.coord)


def _nothing_ran(env, sc):
    assert sc["verified"] is False and sc["sideEffect"] == "none", sc
    assert env.desktop.navigations == [] and env.desktop.launches == []


def test_2c_display_unavailable_mints_nothing_runs_nothing_and_denies(env):
    sc = _desktop_unavailable(env)
    aid = env.coord.requests[0]["actionId"]
    # (a) no token minted
    assert env.k8.minted == []
    assert not [r for r in env.k8.audit if r["kind"] == "tool_token.minted"]
    assert env.k8.consumed == []                                  # the host never tried to consume
    # (b) no execution
    _nothing_ran(env, sc)
    # (c) DENIED_BY_POLICY with reason display_unavailable (not USER_DECLINED: never "you declined", 2d)
    assert sc["error"]["code"] == "DENIED_BY_POLICY"
    assert "declined" not in sc["error"]["message"]
    # K8 is the source of display_unavailable: the host leaves reason OUT of toolCallFinished (ruling 2f)
    assert "reason" not in env.host.finished[-1], env.host.finished[-1]
    assert not any(d.get("reason") == "display_unavailable" for d in env.host.diag)
    assert {"kind": "approval.resolved", "actionId": aid, "taskId": "task-1", "toolId": "explorer.open_known_folder",
            "decision": "denied_by_policy", "reason": "display_unavailable"} in env.k8.audit
    assert "display_unavailable" not in sc["error"]["message"]                # the model sees the code only


def test_2c_later_approve_for_the_same_action_id_does_nothing(env):
    _desktop_unavailable(env)
    req = env.coord.requests[0]
    aid, b = req["actionId"], req["binding"]
    ids = {k: b[k] for k in ("threadId", "turnId", "itemId", "requestId")}
    # (d1) a late ApprovalResolved{approved:true} for that actionId straight to K8
    late = env.k8.resolve(aid, b["taskId"], b["method"], ids, env.clock() + APPROVAL_TTL_S, approved=True)
    assert (late.decision, late.reason, late.token) == ("denied_by_policy", "reused", None)
    assert env.k8.minted == [] and env.k8.live_approval("task-1", "explorer.open_known_folder") is None
    # (d2) the same call again, the desktop now clicking approve for the same actionId: still denied, nothing runs
    env.coord.answer = "desktop_approve"
    sc = env.call(category="local_change", coordinator=env.coord)
    assert env.coord.requests[-1]["actionId"] == aid                            # really the same actionId
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and "reason" not in env.host.finished[-1]
    assert env.k8.audit[-1]["reason"] == "reused" and env.k8.audit[-1]["actionId"] == aid      # 2f: kept
    _nothing_ran(env, sc)
    assert env.k8.minted == [] and env.k8.consumed == []


def test_2c_control_a_fresh_action_approved_on_the_desktop_does_run(env):
    """Control for the mutants: the same desktop path with approved:true mints once and executes."""
    one_window(env)
    env.coord = FakeCoordinator(env.k8, env.clock)
    env.coord.answer = "desktop_approve"
    sc = env.call(category="local_change", coordinator=env.coord)
    assert sc["verified"] is True and len(env.k8.minted) == 1 and env.desktop.navigations
