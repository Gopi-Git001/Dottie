"""DOT-092 DRAFT 5 (+ 5.1 reasons ruled by E08): R4 re-mint failure codes and `superseded` (K-07b), R2
consume records (K-04/K-07), R3 gate_state_unavailable (K-06b), R4 omitted ids, X5 catalog_mismatch (C-23),
revocation reasons never reach the model, H-13 peer checks (mocked)."""
import json

import pytest

from dottie_tools.host.pipe_peer import (Expected, PeerFacts, ServerFacts, client_accepts_server,
                                          client_open_flags, rejection_record, server_check)
from dottie_tools.reference.approval import REVOCATION_AUDIT_REASON, FakeCoordinator
from support.fakes import DOCS, DOWNLOADS, PICS

M = "explorer.open_known_folder"
IDS = {"threadId": "thr-1", "turnId": "turn-1", "itemId": "item-1", "requestId": "req-1"}
AID = "a" * 64


def remint(env, action=AID, call_id="call-1", offer=True):
    if offer:
        env.k8.live_approval("task-1", M, call_id)
    return env.k8.request_tool_token({"v": 1, "callId": call_id, "actionId": action}, task_id="task-1", tool_id=M)


# R4 / K-07b -------------------------------------------------------------------------------------------
@pytest.mark.parametrize("setup,code,reason", [
    (lambda k, c: None, None, None),
    (lambda k, c: setattr(c, "action", "b" * 64), "APPROVAL_REQUIRED", "wrong_action"),
    (lambda k, c: setattr(k, "muted", True), "APPROVAL_REQUIRED", "mute"),
    (lambda k, c: setattr(k, "locked", True), "APPROVAL_REQUIRED", "locked"),
    (lambda k, c: setattr(c, "advance", 61), "APPROVAL_REQUIRED", "expired"),
    (lambda k, c: k.stop("task-1"), "CANCELLED", "task_cancel"),
    (lambda k, c: k.panic_stopped.add("task-1"), "CANCELLED", "panic_stop"),
    (lambda k, c: setattr(k, "gate_unavailable", True), "DENIED_BY_POLICY", "gate_state_unavailable"),
    (lambda k, c: setattr(c, "offer", False), "DENIED_BY_POLICY", "missing"),
], ids=["ok", "wrong_action", "mute", "locked", "expired", "stop", "panic", "gate", "not_offered"])
def test_k07b_re_mint_failure_codes(env, setup, code, reason):
    env.k8.approve(AID, "task-1", M, IDS, 60.0)
    c = type("C", (), {"action": AID, "advance": 0, "offer": True})()
    env.k8.live_approval("task-1", M, "call-1")                      # offered while live
    setup(env.k8, c)
    env.clock.t += c.advance
    if not c.offer:
        env.k8._offers.clear()
    r = env.k8.request_tool_token({"v": 1, "callId": "call-1", "actionId": c.action}, task_id="task-1", tool_id=M)
    if code is None:
        assert r["ok"] is True and env.k8.audit[-1]["reason"] == "remint"
    else:
        assert r == {"ok": False, "error": {"code": code, "message": "not re-minted", "retryable": False},
                     "sideEffect": "none"}
        assert env.k8.audit[-1] == {"kind": "tool_token.minted", "taskId": "task-1", "toolId": M,
                                    "outcome": "refused", "reason": reason}


def test_k07b_executed_approval_refuses_with_reused(env):
    tok = env.k8.approve(AID, "task-1", M, IDS, 60.0)
    env.k8.live_approval("task-1", M, "call-1")
    assert env.k8.consume(tok, AID, "task-1", M) == "ok"
    r = remint(env, offer=False)
    assert r["error"]["code"] == "APPROVAL_REQUIRED" and env.k8.audit[-1]["reason"] == "reused"


@pytest.mark.parametrize("params", [{"v": 1, "callId": "call-1"}, {"v": "1", "callId": "call-1", "actionId": AID},
                                    {"v": 1, "callId": "call-1", "actionId": AID, "token": "x"}, None, []])
def test_k07b_malformed_re_mint_is_denied(env, params):
    env.k8.approve(AID, "task-1", M, IDS, 60.0)
    env.k8.live_approval("task-1", M, "call-1")
    r = env.k8.request_tool_token(params, task_id="task-1", tool_id=M)
    assert r["error"]["code"] == "DENIED_BY_POLICY" and env.k8.audit[-1]["reason"] == "malformed"


def test_r4_re_mint_revokes_the_earlier_unused_token_as_superseded(env):
    first = env.k8.approve(AID, "task-1", M, IDS, 60.0)
    n = len(env.k8.audit)
    second = remint(env)["data"]["token"]
    assert [r["kind"] for r in env.k8.audit[n:]] == ["tool_token.minted"]      # no tool_token.rejected at re-mint
    assert env.k8.consume(first, AID, "task-1", M) == "revoked"
    assert env.k8.audit[-1]["reason"] == "superseded"
    assert env.k8.consume(second, AID, "task-1", M) == "ok"


@pytest.mark.parametrize("code_path", ["DENIED_BY_POLICY", "CANCELLED", "APPROVAL_REQUIRED"])
def test_r4_host_follows_the_re_mint_code(env, code_path):
    """APPROVAL_REQUIRED -> fresh requestApproval; CANCELLED -> final; DENIED_BY_POLICY -> no fallback."""
    a = env.desktop.add(DOCS, foreground=True)
    coord = FakeCoordinator(env.k8, env.clock)
    env.desktop.on_before_dispatch = lambda d: env.k8.end_turn("task-1")
    env.authorized(category="local_change", coordinator=coord)                 # approved, token died at turn end
    env.desktop.on_before_dispatch = None
    env.next_turn("task-1.t2")
    if code_path == "DENIED_BY_POLICY":
        env.k8.gate_unavailable = True
    elif code_path == "CANCELLED":
        env.k8.panic_stopped.add("task-1")
    else:
        env.k8.muted = True
    coord.answer = "click_deny"
    n = len(coord.requests)
    sc = env.authorized(category="local_change", coordinator=coord)
    expect = {"DENIED_BY_POLICY": "DENIED_BY_POLICY", "CANCELLED": "CANCELLED",
              "APPROVAL_REQUIRED": "USER_DECLINED"}[code_path]
    assert sc["error"]["code"] == expect and env.desktop.navigations == [] and a.tabs == [DOCS]
    assert len(coord.requests) == n + (1 if code_path == "APPROVAL_REQUIRED" else 0)


# R2 / K-04 / K-07 ----------------------------------------------------------------------------------------
def consumed_records(env):
    return [r["outcome"] for r in env.k8.audit if r["kind"] == "tool_token.consumed"]


def test_r2_accepted_consume_then_after_send_report(env):
    env.desktop.add(DOCS, foreground=True)
    assert env.mutating("click_approve")["verified"] is True
    assert consumed_records(env) == ["postcondition_unknown", "consumed"]


def test_r2_accepted_consume_then_host_timeout_reports_not_dispatched(env):
    env.desktop.add(DOCS, foreground=True)
    env.k8.silent = True
    assert env.mutating("click_approve")["error"]["code"] == "DENIED_BY_POLICY"
    assert consumed_records(env) == ["postcondition_unknown", "consumed_not_dispatched"]
    assert env.desktop.navigations == []


def test_r2_disconnect_with_no_report_stays_postcondition_unknown_and_approval_is_executed(env):
    tok = env.k8.approve(AID, "task-1", M, IDS, 60.0)
    env.k8.consume_tool_token({"v": 1, "callId": "c9", "token": tok, "actionId": AID, "taskId": "task-1",
                               "toolId": M})
    env.k8.ipc_disconnect()
    rec = [r for r in env.k8.audit if r["kind"] == "tool_token.consumed"]
    assert len(rec) == 1 and rec[0]["outcome"] == "postcondition_unknown" and rec[0]["reason"] == "ipc_disconnect"
    assert env.k8.live_approval("task-1", M) is None                            # executed: never re-mints
    env.k8.tool_call_finished({"callId": "c9", "phase": "before_send", "sideEffect": "none"})   # too late
    assert consumed_records(env) == ["postcondition_unknown"]


# R3 / K-06b ---------------------------------------------------------------------------------------------
def test_k06b_consume_with_gate_unavailable_is_denied_and_burns_the_token(env):
    tok = env.k8.approve(AID, "task-1", M, IDS, 60.0)
    env.k8.gate_unavailable = True
    assert env.k8.consume(tok, AID, "task-1", M) == "gate_state_unavailable"
    env.k8.gate_unavailable = False
    assert env.k8.consume(tok, AID, "task-1", M) == "reused"


def test_k06b_navigate_check_policy_with_gate_unavailable_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    env.k8.gate_unavailable = True
    sc = env.call()
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and env.desktop.navigations == []
    assert env.k8.audit[-1]["reason"] == "gate_state_unavailable"


# R4 omitted ids / X5 / peer -------------------------------------------------------------------------------
def test_r4_audit_records_omit_absent_ids_never_null(env):
    env.desktop.add(DOCS, foreground=True)
    env.mutating("click_approve")
    env.k8.consume(None, None, "task-1", M)
    remint(env, offer=False)
    for rec in env.k8.audit:
        assert None not in rec.values(), rec
    assert rejection_record("catalog_mismatch") == {"kind": "toolhost.peer_rejected", "outcome": "denied",
                                                    "reason": "catalog_mismatch"}


def test_c23_host_side_x5_catalog_mismatch_is_denied_by_policy_no_dialog(env):
    env.desktop.add(DOCS, foreground=True)
    env.coord = FakeCoordinator(env.k8, env.clock, pinned={M: {"category": "navigate", "scope": "files.navigate"}})
    sc = env.mutating("click_approve")                                         # preview says local_change
    assert sc["error"]["code"] == "DENIED_BY_POLICY" and env.k8.minted == [] and env.desktop.navigations == []


# Revocation reasons never reach the model ----------------------------------------------------------------
@pytest.mark.parametrize("cause", sorted(REVOCATION_AUDIT_REASON))
def test_revocation_reason_reaches_the_model_only_as_its_tool_error_code(env, cause):
    env.desktop.add(DOCS, foreground=True)
    env.desktop.on_before_dispatch = lambda d: env.k8.revoke_all(cause)
    sc = env.mutating("click_approve")
    code = "CANCELLED" if cause in ("task_cancel", "panic_stop", "quit") else "DENIED_BY_POLICY"
    assert sc["error"]["code"] == code and sc["sideEffect"] == "none"
    assert env.k8.audit[-1]["reason"] == REVOCATION_AUDIT_REASON[cause] == cause       # identity (E08 ruling)
    blob = json.dumps(sc).lower()
    for word in set(REVOCATION_AUDIT_REASON) | {"revoked", "superseded", "remint", "k8t1"}:
        assert word not in blob, (word, blob)


def test_revocation_reason_table_is_identity_and_covers_e08_5_1_additions():
    assert {"superseded", "turn_end", "end_task"} <= set(REVOCATION_AUDIT_REASON)
    assert all(k == v for k, v in REVOCATION_AUDIT_REASON.items())


# H-13 (mocked) -------------------------------------------------------------------------------------------
EXP = Expected("ab" * 32, "S-1-5-21-1", "S-1-5-5-0-1")
GOOD = PeerFacts(pid=4242, start_time=7, start_time_now=7, in_job=True, image_sha256="AB" * 32,
                 user_sid="S-1-5-21-1", logon_sid="S-1-5-5-0-1")


@pytest.mark.parametrize("change,reason", [
    ({}, None), ({"in_job": False}, "not_in_job"), ({"in_job": None}, "not_in_job"),
    ({"image_sha256": "cd" * 32}, "image_mismatch"), ({"image_sha256": None}, "image_mismatch"),
    ({"start_time_now": 8}, "start_time_mismatch"), ({"start_time": None}, "start_time_mismatch"),
    ({"logon_sid": "S-1-5-5-0-2"}, "sid_mismatch"), ({"user_sid": "S-1-5-21-2"}, "sid_mismatch"),
    ({"logon_sid": None}, "sid_mismatch"),
])
def test_h13_server_peer_check_is_job_plus_pinned_image_hash_plus_sids(change, reason):
    peer = PeerFacts(**{**GOOD.__dict__, **change})
    assert server_check(peer, EXP, live_connection=False) == reason


def test_h13b_parent_chain_alone_never_admits_and_second_connection_and_catalog_refuse():
    assert server_check(PeerFacts(**{**GOOD.__dict__, "in_job": False}), EXP, live_connection=False) == "not_in_job"
    assert server_check(GOOD, EXP, live_connection=True) == "second_connection"
    assert server_check(GOOD, EXP, live_connection=False, catalog_ok=False) == "catalog_mismatch"


def test_h13c_host_opens_with_sqos_identification_and_refuses_a_squatting_server():
    flags = client_open_flags()
    assert flags == 0x00110000
    main = r"C:\Program Files\Dottie\Dottie.exe"
    assert client_accepts_server(ServerFacts(main, 5, 5), main, flags) is True
    assert client_accepts_server(ServerFacts(r"C:\evil\Dottie.exe", 5, 5), main, flags) is False
    assert client_accepts_server(ServerFacts(main, 5, 6), main, flags) is False
    assert client_accepts_server(ServerFacts(main, 5, 5), main, 0) is False             # no SQOS -> refuse
