"""P24/P24a (DOT-092 DRAFT 3 §4.0, agreed by E04): navigate's lock / panic-stop / mute gate is checked in
authorizeToolCall with NO token, failing closed when the gate state is unreadable, malformed, stale, or no
K8 is wired. The host refuses a navigate call whose authorizeToolCall answer is missing or late (§2.3.1),
and keeps its own gate re-check (defence in depth). Host side of C-18 / H-16."""
import pytest

from dottie_tools.reference.approval import FakeAuthorizer, GateSnapshot
from dottie_tools.targets import HostContext
from support.fakes import DOCS, DOWNLOADS


def one_window(env):
    return env.desktop.add(DOCS, foreground=True)


def authz(env, gate="fresh", **kw):
    env.authorizer = FakeAuthorizer(env.clock)
    env.authorizer.context = env.ctx
    env.authorizer.gate = gate
    for k, v in kw.items():
        setattr(env.authorizer, k, v)
    return env.authorizer


def assert_untouched(sc, env, code):
    assert sc["verified"] is False and sc["error"]["code"] == code, sc
    assert sc["sideEffect"] == "none" and sc["error"]["retryable"] is False
    assert env.desktop.navigations == [] and env.desktop.launches == []
    assert env.k8.minted == [] and env.k8.consumed == []           # the gate never involves a token
    assert env.host.approval_requests == []


@pytest.mark.parametrize("flag,reason", [("locked", "locked"), ("panic_stopped", "panic_stop"), ("muted", "mute")])
def test_gate01_locked_panic_muted_is_denied_in_authorize_without_a_token(env, flag, reason):
    w = one_window(env)
    snap = dict(locked=False, panic_stopped=False, muted=False, observed_at=0.0)
    snap[flag] = True
    a = authz(env, GateSnapshot(**snap))
    sc = env.authorized()
    assert_untouched(sc, env, "DENIED_BY_POLICY")
    assert a.audit[-1]["reason"] == reason and a.tokens_minted == 0
    assert w.tabs == [DOCS]
    assert env.host.finished == []                                  # never authorized -> no toolCallFinished


@pytest.mark.parametrize("gate", [
    None,                                                            # gateState() returned null
    RuntimeError("K8 read failed"),                                  # the read throws
    "not-a-snapshot",                                                # malformed
    GateSnapshot("no", False, False, 0.0),                           # non-bool flag
    GateSnapshot(None, False, False, 0.0),                           # unreadable flag
    GateSnapshot(False, False, False, None),                         # observedAt missing
    GateSnapshot(False, False, False, True),                         # bool is not a timestamp
    GateSnapshot(False, False, False, 10.0),                         # observedAt in the future
], ids=["null", "raises", "malformed", "nonbool", "noneflag", "no_observed_at", "bool_ts", "future"])
def test_gate02_unreadable_gate_state_fails_closed(env, gate):
    one_window(env)
    a = authz(env, gate)
    sc = env.authorized()
    assert_untouched(sc, env, "DENIED_BY_POLICY")
    assert a.audit[-1]["reason"] == "gate_state_unavailable"


def test_gate02b_stale_snapshot_and_no_k8_fail_closed(env):
    one_window(env)
    env.clock.t = 5.0
    a = authz(env, GateSnapshot(False, False, False, 3.99))          # 1.01 s old > 1000 ms
    assert_untouched(env.authorized(), env, "DENIED_BY_POLICY")
    assert a.audit[-1]["reason"] == "gate_state_unavailable"
    a = authz(env, "fresh", k8_wired=False)
    assert_untouched(env.authorized(), env, "DENIED_BY_POLICY")
    assert a.audit[-1]["reason"] == "gate_state_unavailable"


def test_gate03_clear_fresh_gate_navigates_with_no_token(env):
    w = one_window(env)
    env.clock.t = 5.0
    authz(env, GateSnapshot(False, False, False, 4.0))               # exactly 1000 ms old is still fresh
    sc = env.authorized()
    assert sc["verified"] is True and sc["sideEffect"] == "committed", sc
    assert w.path == DOWNLOADS
    assert env.k8.minted == [] and env.k8.consumed == [] and env.host.approval_requests == []


@pytest.mark.parametrize("flag", ["locked", "panic_stopped", "muted"])
@pytest.mark.parametrize("value", [True, None], ids=["set", "unreadable"])
def test_gate04_host_rechecks_the_gate_even_after_authorize_passed(env, flag, value):
    """Defence in depth: a lock/mute that lands between authorize and the host check, or an unreadable
    host-side copy, still denies before any lookup."""
    one_window(env)
    authz(env)
    setattr(env.host, flag, value)
    sc = env.authorized()
    assert_untouched(sc, env, "DENIED_BY_POLICY")
    expected = {"locked": "locked", "panic_stopped": "panic_stop", "muted": "mute"}[flag] if value else \
        "gate_state_unavailable"
    assert env.host.diag[-1]["reason"] == expected
    assert env.host.finished[-1]["phase"] == "not_started"


def test_gate05_authorize_late_or_missing_is_precondition_failed(env):
    one_window(env)
    authz(env, silent=True)                                          # no answer within 2 s (§2.3.1)
    assert_untouched(env.authorized(), env, "PRECONDITION_FAILED")
    assert_untouched(env.call(ctx=None), env, "PRECONDITION_FAILED")   # no channel / no answer at all
    assert env.host.finished == []


def test_gate06_scope_is_still_checked_by_the_host(env):
    one_window(env)
    authz(env)
    env.host.scopes = frozenset({"desktop.control"})
    assert_untouched(env.authorized(), env, "PERMISSION_REQUIRED")


def test_gate07_gate_check_applies_to_navigate_tools_only(env):
    a = authz(env, GateSnapshot(True, False, False, 0.0))
    assert a.authorize("someapp.unknown_tool", {}) == env.ctx        # mutating/unknown: K8 token path instead
    assert a.authorize("explorer.open_known_folder", {"folder": "downloads"}).code == "DENIED_BY_POLICY"


def test_ord01_reserved_key_wins_over_no_active_turn_and_the_gate(env):
    """16b3880 order: reserved keys -> INVALID_ARGUMENT before 'no active turn' and before the gate."""
    one_window(env)
    a = authz(env, GateSnapshot(True, True, True, 0.0))
    a.context = None
    r = a.authorize("explorer.open_known_folder", {"folder": "downloads", "task_id": "t"})
    assert r.code == "INVALID_ARGUMENT" and a.audit[-1]["argKeys"] == ["task_id"]
    sc = env.call(ctx=None, taskId="x")                              # host, no context at all
    assert_untouched(sc, env, "INVALID_ARGUMENT")
    assert env.host.diag[-1] == {"event": "tool.refused", "code": "INVALID_ARGUMENT",
                                 "reason": "reserved_model_arg", "argKeys": ["taskId"]}
