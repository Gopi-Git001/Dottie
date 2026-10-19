"""ADR-0009 CR2/CR3/CR6/item 7 + CONTRACTS §3/§3.3/§5 and E01's 2026-10-19 rulings:
* category `navigate` (explorer.open_known_folder) runs with no confirm and needs no token;
* mutating desktop tools (exercised here as category local_change) need the in-call requestApproval
  round-trip (tool-host-control §4.4) and a single-use K8 token bound to taskId + toolId + actionId
  (decision C5: NOT turnId; the resolved four-field window identity is inside actionId), short TTL;
* ApprovalResolution.decision uses the CONTRACTS §3.2 enum (C6); a cancel-caused revocation is CANCELLED (C7);
* APPROVAL_REQUIRED = grantable but not yet approved; DENIED_BY_POLICY = never grantable OR the required
  authorization is missing, invalid, expired, used or foreign.
Behavioural: each test drives the tool and checks the (fake) desktop."""
import json

import pytest

from dottie_tools.reference.approval import action_doc, action_id
from dottie_tools.reference.approval import FakeCoordinator
from support.fakes import DOCS, DOWNLOADS, PICS
from dottie_tools.targets import CanonicalError, HostContext, WindowIdentity, canonical_json, parse_canonical

CTX = HostContext("task-1", "thr-1", "turn-1", "item-1", "req-1")   # = conftest Env.ctx default
W = WindowIdentity(0x1010, 700, "CabinetWClass", 133_700_000_000_000_123)
ARGS = {"folder": "downloads", "path": "c:\\x"}
M = "explorer.open_known_folder"


def snap(env):
    return {h: list(w.tabs) for h, w in env.desktop.windows.items()}


def denied_untouched(sc, env, before, reason=None):
    assert sc["verified"] is False and sc["error"]["code"] == "DENIED_BY_POLICY", sc
    assert sc["sideEffect"] == "none" and sc["error"]["retryable"] is False
    assert env.desktop.navigations == [] and env.desktop.launches == []
    assert snap(env) == before
    if reason:
        assert env.k8.audit[-1]["reason"] == reason                         # K8 audits its verdict (X1)
    assert not any(t in repr(env.host.diag) + repr(env.k8.audit) + repr(env.k8.requests)
                   for t in env.k8.minted)                                    # token values never logged


# APH: actionId ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("change", [dict(hwnd=0x1020), dict(pid=701), dict(window_class="ExploreWClass"),
                                    dict(process_start_time=W.process_start_time + 1)])
def test_aph01_action_id_changes_with_each_window_identity_field(change):
    other = WindowIdentity(**{**W.__dict__, **change})
    assert action_id(M, ARGS, W, CTX) != action_id(M, ARGS, other, CTX)


def test_aph02_action_id_is_stable_and_covers_args_and_context():
    base = action_id(M, ARGS, W, CTX)
    assert base == action_id(M, dict(reversed(list(ARGS.items()))), W, CTX)
    assert base != action_id(M, {**ARGS, "folder": "documents"}, W, CTX)
    assert base != action_id(M, ARGS, None, CTX)
    for ctx in (HostContext("task-2", "thr-1", "turn-1", "item-1", "req-1"),
                HostContext("task-1", "thr-1", "turn-2", "item-1", "req-1"),
                HostContext("task-1", "thr-1", "turn-1", "item-2", "req-1"),
                HostContext("task-1", "thr-1", "turn-1", "item-1", "req-2")):
        assert base != action_id(M, ARGS, W, ctx)
    assert len(base) == 64 and base == base.lower()


def test_aph03_hash_input_is_canonical_all_strings_with_purpose():
    doc = action_doc(M, ARGS, W, CTX)
    obj = parse_canonical(doc)                                      # canonical form, no duplicate keys
    assert obj["purpose"] == "dottie.actionId.v1"
    assert obj["targets"]["window"] == {"hwnd": "4112", "pid": "700", "windowClass": "CabinetWClass",
                                        "processStartTime": "133700000000000123"}
    assert set(obj) == {"purpose", "method", "args", "targets", "taskId", "threadId", "turnId", "itemId", "requestId"}


def test_aph04_values_above_2_53_hash_exactly():
    big = WindowIdentity(2**60, 2**32 - 1, "CabinetWClass", 2**60)
    nxt = WindowIdentity(2**60 + 1, 2**32 - 1, "CabinetWClass", 2**60 + 1)
    assert float(2**60) == float(2**60 + 1)
    assert action_id(M, ARGS, big, CTX) != action_id(M, ARGS, nxt, CTX)
    assert f'"processStartTime":"{2**60}"' in action_doc(M, ARGS, big, CTX)


@pytest.mark.parametrize("bad", [{"a": 1}, {"a": True}, {"a": 1.5}, {"a": ["x"]}, {"a": {"b": 2}}])
def test_aph05_canonicaliser_rejects_non_string_values(bad):
    with pytest.raises(CanonicalError):
        canonical_json(bad)


def test_aph06_canonical_parser_rejects_duplicates_and_non_canonical_text():
    with pytest.raises(CanonicalError):
        parse_canonical('{"a":"1","a":"2"}')
    with pytest.raises(CanonicalError):
        parse_canonical('{"b":"1", "a":"2"}')
    assert parse_canonical(json.dumps({"a": "2", "b": None}, separators=(",", ":"))) == {"a": "2", "b": None}


# NAV: category navigate needs no confirm and no token -----------------------------------------------
def test_nav01_navigate_runs_without_approval_or_token(env):
    a = env.desktop.add(DOCS, foreground=True)
    sc = env.call()
    assert sc["verified"] is True and env.desktop.navigations == [(a.hwnd, DOWNLOADS)]
    assert env.host.approval_requests == [] and env.k8.minted == [] and env.k8.consumed == []
    assert [r["method"] for r in env.k8.requests] == ["checkPolicy"]   # no token, but K8 is involved (E08 12)


def test_nav01b_navigate_with_no_k8_wired_is_denied(env):
    """DRAFT 4 reverses DRAFT 3's 'a missing K8 gate doesn't block navigate': checkPolicy can't run."""
    env.desktop.add(DOCS, foreground=True)
    env.k8 = None
    sc = env.call()
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and env.desktop.navigations == []


# MUT: mutating desktop tools still need the round-trip + token ---------------------------------------
def test_mut01_no_coordinator_returns_approval_required_with_action_id_and_touches_nothing(env):
    env.desktop.add(DOCS, foreground=True)
    before = snap(env)
    sc = env.call(category="local_change")
    assert sc["error"]["code"] == "APPROVAL_REQUIRED" and sc["sideEffect"] == "none"
    assert sc["error"]["retryable"] is False and snap(env) == before and env.desktop.navigations == []
    aid = sc["observedState"]["actionId"]
    assert env.host.approval_requests[-1]["actionId"] == aid and env.host.approval_requests[-1]["category"] == "local_change"


def test_mut02_secure_ui_click_mints_a_token_that_is_accepted_exactly_once(env):
    a = env.desktop.add(DOCS, foreground=True)
    sc = env.mutating()
    assert sc["verified"] is True and sc["sideEffect"] == "committed"
    assert env.desktop.navigations == [(a.hwnd, DOWNLOADS)]
    req = env.coord.requests[-1]
    assert req["binding"]["targets"]["window"]["pid"] == str(a.pid)          # pid is a decimal string (C2)
    assert env.k8.consume(env.k8.minted[-1], req["actionId"], "task-1", M) == "reused"


@pytest.mark.parametrize("answer,code", [
    ("click_deny", "USER_DECLINED"),          # declined / user_declined
    ("timeout", "APPROVAL_REQUIRED"),         # expired / timeout
    ("mute", "APPROVAL_REQUIRED"),            # revoked / mute, task still live
    ("task_cancel", "CANCELLED"),             # revoked / task_cancel -> CANCELLED (C7)
    ("turn_ended", "CANCELLED"),              # cancelled / turn_ended
    ("tray_yes", "DENIED_BY_POLICY"),         # denied_by_policy / channel_not_allowed
    ("voice_yes", "DENIED_BY_POLICY"),
    ("denied", "DENIED_BY_POLICY"),           # denied_by_policy / wrong_action
])
def test_mut03_decision_enum_maps_to_tool_codes_and_nothing_runs(env, answer, code):
    env.desktop.add(DOCS, foreground=True)
    before = snap(env)
    sc = env.mutating(answer=answer)
    assert sc["error"]["code"] == code and sc["sideEffect"] == "none" and sc["error"]["retryable"] is False
    assert snap(env) == before and env.desktop.navigations == [] and env.k8.minted == []


def test_tok01_authorization_without_token_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    before = snap(env)
    sc = env.with_token(None)
    denied_untouched(sc, env, before, "missing")


def test_tok02_used_token_is_denied(env):
    a = env.desktop.add(DOCS, foreground=True)
    aid, tok = env.unspent_token()
    assert env.with_token(tok)["verified"] is True
    a.tabs[0] = DOCS
    env.desktop.navigations.clear()
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before, "reused")


def test_tok03_token_for_another_action_id_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token(aid="0" * 64)
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before,
                     "wrong_action")


def test_tok03b_token_minted_for_another_task_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token(task_id="task-OTHER")
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before,
                     "task_mismatch")


def test_tok03c_token_minted_for_another_tool_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token(tool_id="window.close")
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before,
                     "tool_mismatch")


def test_tok04_token_for_a_different_resolved_window_is_denied(env):
    a = env.desktop.add(DOCS, foreground=True)
    b = env.desktop.add(PICS)
    _, tok_a = env.unspent_token()
    env.desktop.foreground = b.hwnd                                 # the call now resolves window B
    before = snap(env)
    denied_untouched(env.with_token(tok_a), env, before,
                     "wrong_action")
    assert a.tabs == [DOCS] and b.tabs == [PICS]


def test_tok04b_same_hwnd_pid_class_new_process_start_time_is_denied(env):
    a = env.desktop.add(DOCS, pid=700, start=111, foreground=True)
    _, tok = env.unspent_token()
    env.desktop.close(a.hwnd)
    env.desktop.add(DOCS, hwnd=a.hwnd, pid=700, start=999, foreground=True)
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before,
                     "wrong_action")


def test_tok05_token_ttl_is_short_10_s_cap(env):
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token(approval_ttl=60)
    env.clock.t += 11                                               # P18 PROPOSAL: min(approval, mint + 10 s)
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before,
                     "expired")


def test_tok05b_token_never_outlives_the_approval(env):
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token(approval_ttl=5)
    env.clock.t += 6
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before,
                     "expired")


def test_tok06_revoked_token_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token()
    env.k8.revoke_all("mute")                                       # mute / lock / panic-stop / Quit / restart
    before = snap(env)
    denied_untouched(env.with_token(tok), env, before,
                     "mute")                                        # audit reason = revocation cause (§5.7)


def test_tok06b_revocation_caused_by_task_cancel_is_cancelled_with_no_side_effect(env):
    """C7: truthful reporting. The token was revoked because the task was cancelled -> CANCELLED, none."""
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token()
    env.k8.revoke_all("task_cancel")
    before = snap(env)
    sc = env.with_token(tok)
    assert sc["error"]["code"] == "CANCELLED" and sc["sideEffect"] == "none" and sc["error"]["retryable"] is False
    assert snap(env) == before and env.desktop.navigations == []


def test_tok07_unknown_token_and_no_gate_fail_closed(env):
    env.desktop.add(DOCS, foreground=True)
    before = snap(env)
    denied_untouched(env.with_token("k8t1.zzzz.zzzz"),
                     env, before, "unknown_token")
    denied_untouched(env.with_token("f" * 64),
                     env, before, "unknown_token")
    env.k8 = None
    sc = env.with_token("f" * 64)
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and env.desktop.navigations == []


def test_tok08_launch_path_is_gated_too(env):
    sc = env.with_token(None)
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and env.desktop.launches == []
    assert env.mutating(answer="click_deny")["error"]["code"] == "USER_DECLINED" and env.desktop.launches == []


def test_tok09_token_is_revoked_at_turn_end_and_the_later_turn_re_mints(env):
    """E08 6 + 5 (DRAFT 4 §5.3/§5.5, H-14): approved in t1, but t1 ends (setActiveTurn(null)) before the
    consume -> the token is revoked -> DENIED_BY_POLICY, nothing runs. In t2 authorizeToolCall returns the
    approved ids only (no token); the host recomputes actionId from them + window/args re-resolved now and
    calls requestToolToken; K8 re-mints; the call succeeds without a second dialog."""
    a = env.desktop.add(DOCS, foreground=True)
    coord = FakeCoordinator(env.k8, env.clock)
    env.desktop.on_before_dispatch = lambda d: env.k8.end_turn("task-1")
    sc = env.authorized(category="local_change", coordinator=coord)
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and env.desktop.navigations == []
    assert env.k8.audit[-1]["reason"] == "turn_end"                          # E08 5.1 reason, as-is
    old = env.k8.minted[-1]
    env.desktop.on_before_dispatch = None
    env.next_turn("task-1.t2")
    approval = env.authorizer.approval_for(M)
    assert set(approval) == {"actionId", "binding"} and approval["binding"]["turnId"] == "turn-1"   # ids only
    coord.answer = "click_deny"                                                # a second dialog would be declined
    sc = env.authorized(category="local_change", coordinator=coord)
    assert sc["verified"] is True and env.desktop.navigations == [(a.hwnd, DOWNLOADS)], sc
    assert [r["method"] for r in env.k8.requests][-2:] == ["requestToolToken", "consumeToolToken"]
    assert len(coord.requests) == 1 and env.k8.minted[-1] != old
    assert [r.get("reason") for r in env.k8.audit if r["kind"] == "tool_token.minted"] == [None, "remint"]
    assert env.k8.consume(old, approval["actionId"], "task-1", M) == "reused"   # the old token is dead


def test_tok09a_executed_approval_never_re_mints(env):
    a = env.desktop.add(DOCS, foreground=True)
    assert env.authorized(category="local_change", coordinator=FakeCoordinator(env.k8, env.clock))["verified"]
    a.tabs[0] = DOCS
    env.desktop.navigations.clear()
    env.next_turn("task-1.t2")
    assert env.authorizer.approval_for(M) is None                              # executed -> no `approval`
    sc = env.authorized(category="local_change")                               # no coordinator -> fresh approval needed
    assert sc["error"]["code"] == "APPROVAL_REQUIRED" and env.desktop.navigations == []


def test_tok09b_re_mint_with_a_changed_window_falls_back_to_a_fresh_approval(env):
    """The recomputed actionId (approved ids + window re-resolved now) no longer matches -> K8 refuses the
    re-mint -> the host asks for a fresh approval with this call's ids (E08 5); nothing runs on the old one."""
    a = env.desktop.add(DOCS, foreground=True)
    b = env.desktop.add(PICS)
    coord = FakeCoordinator(env.k8, env.clock)
    coord.answer = "click_approve"
    env.desktop.on_before_dispatch = lambda d: env.k8.end_turn("task-1")      # t1's token dies before consume
    assert env.authorized(category="local_change", coordinator=coord)["error"]["code"] == "DENIED_BY_POLICY"
    env.desktop.on_before_dispatch = None
    env.next_turn("task-1.t2")
    env.desktop.foreground = b.hwnd                                            # now resolves window B
    coord.answer = "click_deny"
    sc = env.authorized(category="local_change", coordinator=coord)
    assert sc["error"]["code"] == "USER_DECLINED" and env.desktop.navigations == []
    assert env.k8.audit[-1]["outcome"] == "refused"                             # the re-mint was refused
    assert coord.requests[-1]["binding"]["turnId"] == "task-1.t2"              # fresh approval, this call's ids
    assert a.tabs == [DOCS] and b.tabs == [PICS]


def test_tok09c_approval_of_task_1_is_not_offered_in_task_2(env):
    env.desktop.add(DOCS, foreground=True)
    _, tok = env.unspent_token()
    env.k8.approve(env.k8._approvals[-1].action_id, "task-1", M,
                   {"threadId": "thr-1", "turnId": "turn-1", "itemId": "item-1", "requestId": "req-1"}, 60.0)
    env.ctx = HostContext("task-2", "thr-1", "task-2.t1", "item-9", "req-9")
    before = snap(env)
    assert env.k8.live_approval("task-2", M) is None
    denied_untouched(env.with_token(tok), env, before, "task_mismatch")       # K8: token's taskId != live task
    r = env.k8.request_tool_token({"v": 1, "callId": "c", "actionId": env.k8._approvals[-1].action_id},
                                  task_id="task-2", tool_id=M)
    assert r["ok"] is False


def test_tok09d_two_live_approvals_for_the_same_tool_offer_none(env):
    ids = {"threadId": "thr-1", "turnId": "turn-1", "itemId": "item-1", "requestId": "req-1"}
    env.k8.approve("a" * 64, "task-1", M, ids, 60.0)
    assert env.k8.live_approval("task-1", M) == {"actionId": "a" * 64, "binding": ids}
    env.k8.approve("b" * 64, "task-1", M, ids, 60.0)
    assert env.k8.live_approval("task-1", M) is None                           # fail closed (E08 5)


def test_tok09e_stop_requested_offers_no_approval_and_re_mint_is_cancelled(env):
    ids = {"threadId": "thr-1", "turnId": "turn-1", "itemId": "item-1", "requestId": "req-1"}
    env.k8.approve("a" * 64, "task-1", M, ids, 60.0)
    env.k8.stop("task-1")
    assert env.k8.live_approval("task-1", M) is None
    r = env.k8.request_tool_token({"v": 1, "callId": "c", "actionId": "a" * 64}, task_id="task-1", tool_id=M)
    assert r["error"]["code"] == "CANCELLED"


def test_tok10_no_grant_carried_from_navigate_to_a_mutating_call_in_the_same_window(env):
    """ADR-0009 navigate condition 5: navigate grants nothing for chaining."""
    a = env.desktop.add(DOCS, foreground=True)
    assert env.call()["verified"] is True                          # navigate, no confirm
    a.tabs[0] = DOCS
    env.desktop.navigations.clear()
    sc = env.call(category="local_change")                          # same window, mutating
    assert sc["error"]["code"] == "APPROVAL_REQUIRED" and env.desktop.navigations == []
    sc2 = env.with_token(None)
    assert sc2["error"]["code"] == "DENIED_BY_POLICY" and env.desktop.navigations == []
