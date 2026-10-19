"""Failing-first contract tests for explorer.open_known_folder{folder, targetId?}
(CONTRACTS v2 §5 incl. "E04 review" rulings + processStartTime amendment, E01 2026-10-19).
Subject: the clean-room reference; the same tests become packages/tools adapter tests after DOT-030.
IDs match e04-tools-plan.md (d) and docs/contracts/tools.md."""
import re

import pytest

from support.fakes import DOCS, DOWNLOADS, PICS
from dottie_tools.targets import HostContext


def ask(env, ctx="default"):
    sc = env.call(ctx=ctx)
    assert sc["error"]["code"] == "AMBIGUOUS", sc
    return sc["observedState"]["candidates"]


def snapshot(desktop):
    return {h: list(w.tabs) for h, w in desktop.windows.items()}


def assert_invariants(sc):
    assert ("error" in sc) == (sc["verified"] is False)
    assert sc["sideEffect"] == sc["observedState"]["sideEffect"]
    if sc.get("error", {}).get("retryable"):
        assert sc["sideEffect"] == "none"
    assert set(sc["observedState"]) >= {"outcome", "decision", "checks", "sideEffect"}
    blob = repr(sc["observedState"])
    assert "Users" not in blob and ":\\" not in blob          # no full user paths, no titles


def assert_refused_untouched(sc, env, before, code):
    assert_invariants(sc)
    assert sc["verified"] is False and sc["error"]["code"] == code, sc
    assert sc["error"]["retryable"] is False and sc["sideEffect"] == "none"
    assert sc["observedState"]["decision"] == "stop"
    assert env.desktop.navigations == [] and env.desktop.launches == []
    assert snapshot(env.desktop) == before


def two_windows_and_ask(env, *paths):
    wins = [env.desktop.add(p) for p in (paths or (DOCS, PICS))]
    cands = ask(env)
    return wins, cands


# TID-01 unknown / malformed targetId ---------------------------------------------------------------
@pytest.mark.parametrize("unknown", ["c_000000000000", "c_abcdefabcdef"])
def test_tid01_well_formed_unknown_target_id_is_not_found(env, unknown):
    two_windows_and_ask(env)
    before = snapshot(env.desktop)
    assert_refused_untouched(env.call(targetId=unknown), env, before, "NOT_FOUND")


@pytest.mark.parametrize("bad", ["", "not-an-id", "c_ABCDEF123456", "c_123", "c_" + "a" * 13, 12345, ["c_x"],
                                 {"id": "c_000000000000"}, True])
def test_tid01m_malformed_target_id_is_invalid_argument(env, bad):
    two_windows_and_ask(env)
    before = snapshot(env.desktop)
    assert_refused_untouched(env.call(targetId=bad), env, before, "INVALID_ARGUMENT")


def test_tid01b_cross_task_superseded_ended_past_cap_are_not_found(env):
    env.desktop.add(DOCS), env.desktop.add(PICS)
    other_task = ask(env, ctx=HostContext("task-A", "thr-1", "turn-9"))[0]["id"]
    old = ask(env)[0]["id"]
    ask(env)                                                        # same windows re-registered: `old` superseded
    before = snapshot(env.desktop)
    for tid in (other_task, old):
        assert_refused_untouched(env.call(targetId=tid), env, before, "NOT_FOUND")
    fresh = ask(env)[0]["id"]
    env.clock.t += 1801                                             # past the 30-min safety cap (C3 PROPOSAL)
    assert_refused_untouched(env.call(targetId=fresh), env, before, "NOT_FOUND")
    ended = ask(env)[0]["id"]
    env.registry.end_task(env.ctx.task_id)                          # control-channel endTask(taskId)
    assert_refused_untouched(env.call(targetId=ended), env, before, "NOT_FOUND")


def test_tid01e_target_id_survives_turns_through_an_ambiguous_round_trip(env):
    """C3: an id is valid until endTask(taskId), not 300 s. AMBIGUOUS in t1, the user answers 6 min later
    (clarification = same task, new turn t2), the id still works; and again in t3 after another 10 min."""
    env.desktop.add(DOCS), env.desktop.add(PICS)
    env.ctx = HostContext("task-1", "thr-1", "task-1.t1", "item-1", "req-1")
    first = env.call()
    assert first["error"]["code"] == "AMBIGUOUS" and first["sideEffect"] == "none"
    cid = first["observedState"]["candidates"][1]["id"]
    env.clock.t += 360
    env.next_turn("task-1.t2")
    r = env.call(targetId=cid)
    assert r["verified"] is True and r["sideEffect"] == "committed"
    assert len(env.desktop.navigations) == 1 and env.desktop.navigations[0][1] == DOWNLOADS
    env.clock.t += 600
    env.next_turn("task-1.t3")
    again = env.call(targetId=cid)
    assert again["verified"] is True and again["sideEffect"] == "none"     # already showing; still resolvable


def test_tid01c_missing_host_context_is_precondition_failed_and_touches_nothing(env):
    """C1: no host context (no active turn, stop requested, channel down) -> PRECONDITION_FAILED, not INTERNAL."""
    env.desktop.add(DOCS, foreground=True)
    before = snapshot(env.desktop)
    for ctx in (None, HostContext("", "thr-1", "turn-1"), HostContext("task-1", "thr-1", "")):
        assert_refused_untouched(env.call(ctx=ctx, targetId="c_123456789abc"), env, before, "PRECONDITION_FAILED")
        assert_refused_untouched(env.call(ctx=ctx), env, before, "PRECONDITION_FAILED")


def test_tid01d_unknown_folder_is_invalid_argument(env):
    env.desktop.add(DOCS, foreground=True)
    before = snapshot(env.desktop)
    for f in ("Downloads", "C:\\Users\\gopi\\Downloads", "appdata", None):
        assert_refused_untouched(env.raw({"folder": f}), env, before, "INVALID_ARGUMENT")
    assert_refused_untouched(env.raw({}), env, before, "INVALID_ARGUMENT")
    assert_refused_untouched(env.raw(["downloads"]), env, before, "INVALID_ARGUMENT")


# CTX: task identity comes from the host context, never from model args ----------------------------
RESERVED = ["taskId", "turnId", "threadId", "hwnd", "pid"]


@pytest.mark.parametrize("key", RESERVED)
def test_ctx01_reserved_model_arg_is_rejected_and_only_its_name_is_logged(env, key):
    """E03/E04 decided 2026-10-19: reject (not strip). INVALID_ARGUMENT, sideEffect none; key names are
    logged, values never are."""
    env.desktop.add(DOCS), env.desktop.add(PICS)
    tid = ask(env, ctx=HostContext("task-A", "thr-1", "turn-1"))[0]["id"]   # id belongs to task-A
    before = snapshot(env.desktop)
    secret_value = "VALUE-task-A-4112-should-never-be-logged"
    for args in ({key: secret_value, "targetId": tid}, {key: secret_value}):
        env.host.diag.clear()
        assert_refused_untouched(env.call(**args), env, before, "INVALID_ARGUMENT")
        recs = [r for r in env.host.diag if r.get("reason") == "reserved_model_arg"]
        assert len(recs) == 1 and recs[0]["argKeys"] == [key]
        assert secret_value not in repr(env.host.diag)


def test_ctx01b_several_reserved_args_log_all_names_sorted_and_no_values(env):
    env.desktop.add(DOCS, foreground=True)
    before = snapshot(env.desktop)
    vals = {"turnId": "v-turn-77", "taskId": "v-task-88", "pid": "v-pid-99"}
    assert_refused_untouched(env.call(**vals), env, before, "INVALID_ARGUMENT")
    assert env.host.diag[-1]["argKeys"] == ["pid", "taskId", "turnId"]
    assert not any(v in repr(env.host.diag) for v in vals.values())


@pytest.mark.parametrize("key", ["task_id", "TaskID", "turn-id", "THREAD_ID", "HWnd", "p_i_d"])
def test_ctx01d_spelling_variants_of_reserved_keys_are_reserved_too(env, key):
    """tool-host-control P9 (PROPOSAL): same normalisation as the coordinator's authorizeToolCall."""
    env.desktop.add(DOCS, foreground=True)
    before = snapshot(env.desktop)
    assert_refused_untouched(env.call(**{key: "v-should-not-log"}), env, before, "INVALID_ARGUMENT")
    assert env.host.diag[-1]["reason"] == "reserved_model_arg" and env.host.diag[-1]["argKeys"] == [key]
    assert "v-should-not-log" not in repr(env.host.diag)


@pytest.mark.parametrize("extra", [{"select": "x"}, {"verb": "runas"}, {"path": "C:\\x"}, {"windowId": "1"}])
def test_ctx01c_other_extra_args_are_invalid_argument(env, extra):
    env.desktop.add(DOCS, foreground=True)
    before = snapshot(env.desktop)
    assert_refused_untouched(env.call(**extra), env, before, "INVALID_ARGUMENT")


def test_ctx02_clarification_answer_in_next_turn_of_same_task_resolves(env):
    (a, b), cands = two_windows_and_ask(env)
    env.next_turn("turn-2")                                         # E01 ruling 2: same taskId, new turn
    sc = env.call(targetId=cands[1]["id"])
    assert sc["verified"] is True and env.desktop.navigations == [(b.hwnd, DOWNLOADS)]


def test_ctx03_same_thread_different_task_is_not_found(env):
    _, cands = two_windows_and_ask(env)
    before = snapshot(env.desktop)
    sc = env.call(ctx=HostContext("task-2", env.ctx.thread_id, "turn-2"), targetId=cands[0]["id"])
    assert_refused_untouched(sc, env, before, "NOT_FOUND")


# TID-02 known targetId -> navigates and verifies only that window -----------------------------------
def test_tid02_known_target_id_navigates_only_that_window(env):
    (a, b), cands = two_windows_and_ask(env)
    sc = env.call(targetId=cands[1]["id"])
    assert_invariants(sc)
    assert sc["verified"] is True and sc["sideEffect"] == "committed"
    assert env.desktop.navigations == [(b.hwnd, DOWNLOADS)]
    assert a.tabs == [DOCS] and b.path == DOWNLOADS and len(env.desktop.windows) == 2
    assert sc["observedState"]["checks"]["EXP-06"] == "pass"


def test_tid02b_pinned_even_when_another_window_is_foreground(env):
    (a, b), cands = two_windows_and_ask(env)
    env.desktop.foreground = b.hwnd
    sc = env.call(targetId=cands[0]["id"])
    assert sc["verified"] is True and env.desktop.navigations == [(a.hwnd, DOWNLOADS)] and b.tabs == [PICS]


def test_tid02c_pinned_navigates_and_reads_the_active_tab(env):
    a = env.desktop.add(DOCS, PICS, active=1)
    env.desktop.add(DOCS)
    cands = ask(env)
    sc = env.call(targetId=cands[0]["id"])
    assert sc["verified"] is True and a.tabs == [DOCS, DOWNLOADS]


# TID-03 another Explorer window (or tab) reaching Downloads must not count -------------------------
def test_tid03_decoy_window_at_downloads_does_not_count(env):
    (a, b), cands = two_windows_and_ask(env)
    env.desktop.navigate_is_noop = True
    env.desktop.on_navigate = lambda d, h, p: d.windows[b.hwnd].tabs.__setitem__(0, DOWNLOADS)
    sc = env.call(targetId=cands[0]["id"])
    assert_invariants(sc)
    assert sc["verified"] is False and sc["error"]["code"] == "POSTCONDITION_FAILED"
    assert sc["sideEffect"] == "unknown" and sc["error"]["retryable"] is False
    assert sc["observedState"]["decision"] == "stop" and sc["observedState"]["checks"]["EXP-06"] == "fail"


def test_tid03b_decoy_already_at_downloads_and_foreground(env):
    (a, _), cands = two_windows_and_ask(env)
    decoy = env.desktop.add(DOWNLOADS, foreground=True)
    env.desktop.navigate_is_noop = True
    sc = env.call(targetId=cands[0]["id"])
    assert sc["verified"] is False and env.desktop.navigations == [(a.hwnd, DOWNLOADS)] and decoy.tabs == [DOWNLOADS]


def test_tid03c_background_tab_of_target_at_downloads_does_not_count(env):
    env.desktop.add(DOWNLOADS, DOCS, active=1)
    env.desktop.add(PICS)
    cands = ask(env)
    env.desktop.navigate_is_noop = True
    sc = env.call(targetId=cands[0]["id"])
    assert sc["verified"] is False and sc["error"]["code"] == "POSTCONDITION_FAILED"


# TID-04 closed target window (§5: closed targetId -> NOT_FOUND; gone before send -> PRECONDITION_FAILED;
#        gone after send -> POSTCONDITION_UNKNOWN). Any identity-field mismatch counts as closed. -----------
def test_tid04_target_closed_before_call_is_not_found(env):
    (a, _), cands = two_windows_and_ask(env)
    env.desktop.close(a.hwnd)
    before = snapshot(env.desktop)
    sc = env.call(targetId=cands[0]["id"])
    assert_refused_untouched(sc, env, before, "NOT_FOUND")
    assert "window_gone" in sc["error"]["message"]


@pytest.mark.parametrize("pinned", [True, False])
def test_tid04a_target_closed_after_resolution_but_before_send_is_precondition_failed(env, pinned):
    if pinned:
        (a, b), cands = two_windows_and_ask(env)
        args = {"targetId": cands[0]["id"]}
    else:
        a, b = env.desktop.add(DOCS, foreground=True), env.desktop.add(PICS)
        args = {}
    env.desktop.on_before_dispatch = lambda d: d.close(a.hwnd)   # e.g. while the approval dialog was open
    before_others = list(b.tabs)
    sc = env.call(**args)
    assert_invariants(sc)
    assert sc["error"]["code"] == "PRECONDITION_FAILED" and sc["sideEffect"] == "none"
    assert sc["error"]["retryable"] is False and sc["observedState"]["decision"] == "stop"
    assert env.desktop.navigations == [] and env.desktop.launches == [] and b.tabs == before_others
    assert env.host.approval_requests == []                         # navigate: no approval round-trip


def test_tid04b_target_closed_after_send_is_postcondition_unknown(env):
    (a, b), cands = two_windows_and_ask(env)
    env.desktop.navigate_is_noop = True
    env.desktop.on_navigate = lambda d, h, p: d.close(h)
    sc = env.call(targetId=cands[0]["id"])
    assert_invariants(sc)
    assert sc["verified"] is False and sc["error"]["code"] == "POSTCONDITION_UNKNOWN"
    assert sc["sideEffect"] == "unknown" and sc["error"]["retryable"] is False
    assert sc["observedState"]["decision"] == "stop"
    assert env.desktop.launches == [] and b.tabs == [PICS]         # no relaunch, no other window


def test_tid04c_reused_hwnd_with_new_pid_counts_as_closed(env):
    """HWND reuse: the same hwnd value now names another Explorer window (different pid and start time)."""
    a = env.desktop.add(DOCS, pid=700, start=111)
    env.desktop.add(PICS)
    cands = ask(env)
    env.desktop.close(a.hwnd)
    env.desktop.add(DOCS, hwnd=a.hwnd, pid=701, start=222)
    before = snapshot(env.desktop)
    sc = env.call(targetId=cands[0]["id"])
    assert_refused_untouched(sc, env, before, "NOT_FOUND")
    assert "identity_mismatch" in sc["error"]["message"]


def test_tid04d_same_hwnd_pid_class_but_different_process_start_time_counts_as_closed(env):
    """E01 amendment: pid reuse too. Only processStartTime differs."""
    a = env.desktop.add(DOCS, pid=700, start=111)
    env.desktop.add(PICS)
    cands = ask(env)
    env.desktop.close(a.hwnd)
    env.desktop.add(DOCS, hwnd=a.hwnd, pid=700, start=999)          # hwnd, pid, class identical
    before = snapshot(env.desktop)
    sc = env.call(targetId=cands[0]["id"])
    assert_refused_untouched(sc, env, before, "NOT_FOUND")
    assert "identity_mismatch" in sc["error"]["message"]


def test_tid04e_process_start_time_swap_before_send_is_precondition_failed(env):
    a = env.desktop.add(DOCS, pid=700, start=111, foreground=True)
    def swap(d):
        d.close(a.hwnd)
        d.add(DOCS, hwnd=a.hwnd, pid=700, start=999, foreground=True)
    env.desktop.on_before_dispatch = swap
    sc = env.call()
    assert sc["error"]["code"] == "PRECONDITION_FAILED" and sc["sideEffect"] == "none"
    assert env.desktop.navigations == []


def test_tid04f_process_start_time_swap_after_send_is_postcondition_unknown(env):
    a = env.desktop.add(DOCS, pid=700, start=111, foreground=True)
    env.desktop.navigate_is_noop = True
    def swap(d, h, p):
        d.close(a.hwnd)
        d.add(DOWNLOADS, hwnd=a.hwnd, pid=700, start=999)          # impostor even shows Downloads
    env.desktop.on_navigate = swap
    sc = env.call()
    assert sc["verified"] is False and sc["error"]["code"] == "POSTCONDITION_UNKNOWN"
    assert sc["sideEffect"] == "unknown"


# TID-05 no targetId -> existing behaviour per contract (DOT-031 AC + TRIAGE P9) -------------------
def test_tid05a_foreground_explorer_is_adopted(env):
    a, b = env.desktop.add(DOCS, foreground=True), env.desktop.add(PICS)
    sc = env.call()
    assert sc["verified"] is True and env.desktop.navigations == [(a.hwnd, DOWNLOADS)] and b.tabs == [PICS]


def test_tid05b_single_explorer_is_adopted(env):
    a = env.desktop.add(DOCS)
    sc = env.call()
    assert sc["verified"] is True and env.desktop.navigations == [(a.hwnd, DOWNLOADS)] and env.desktop.launches == []


def test_tid05c_no_explorer_opens_exactly_one(env):
    sc = env.call()
    assert sc["verified"] is True and len(env.desktop.launches) == 1 and len(env.desktop.windows) == 1
    assert sc["sideEffect"] == "committed" and sc["observedState"]["checks"]["EXP-08"] == "pass"


def test_tid05d_two_unfocused_is_ambiguous_with_opaque_candidates(env):
    a, b = env.desktop.add(DOCS), env.desktop.add(PICS)
    sc = env.call()
    assert_invariants(sc)
    assert sc["error"]["code"] == "AMBIGUOUS" and sc["observedState"]["decision"] == "ask_user"
    assert sc["sideEffect"] == "none" and env.desktop.navigations == [] and env.desktop.launches == []
    assert env.host.approval_requests == []                         # nothing to approve: no action
    cands = sc["observedState"]["candidates"]
    assert len(cands) == 2 and all(re.fullmatch(r"c_[0-9a-f]{12}", c["id"]) for c in cands)
    assert all(str(a.hwnd) not in c["id"] and "Documents" not in c["label"] for c in cands)
    assert sc["observedState"]["question"]


def test_tid05e_two_unfocused_one_already_at_target_is_verified_without_action(env):
    env.desktop.add(DOCS), env.desktop.add(DOWNLOADS)
    sc = env.call()
    assert sc["verified"] is True and sc["sideEffect"] == "none" and env.desktop.navigations == []


def test_tid05f_no_target_id_verification_is_also_pinned_to_the_adopted_window(env):
    env.desktop.add(DOCS, foreground=True)
    b = env.desktop.add(PICS)
    env.desktop.navigate_is_noop = True
    env.desktop.on_navigate = lambda d, h, p: d.windows[b.hwnd].tabs.__setitem__(0, DOWNLOADS)
    sc = env.call()
    assert sc["verified"] is False and sc["error"]["code"] == "POSTCONDITION_FAILED"


def test_tid05g_explicit_null_target_id_means_absent(env):
    env.desktop.add(DOCS)
    assert env.call(targetId=None)["verified"] is True


# TID-06 full ask -> answer round trip (answer arrives as the next turn of the same task) -----------
def test_tid06_round_trip(env):
    (a, b, c), cands = two_windows_and_ask(env, DOCS, PICS, DOCS)
    env.next_turn("turn-2")
    sc = env.call(targetId=cands[2]["id"])
    assert sc["verified"] is True and env.desktop.navigations == [(c.hwnd, DOWNLOADS)]
    assert a.tabs == [DOCS] and b.tabs == [PICS]


# NOID: a window with any unreadable identity field has no identity and can't be targeted ------------
@pytest.mark.parametrize("field", ["pid", "cls", "start"])
def test_noid01_foreground_window_without_identity_is_not_found(env, field):
    env.desktop.add(DOCS, foreground=True, unreadable=field)
    before = snapshot(env.desktop)
    sc = env.call()
    assert_refused_untouched(sc, env, before, "NOT_FOUND")
    assert env.host.approval_requests == []                         # nothing offered for approval


def test_noid02_unidentifiable_window_is_never_offered_as_a_candidate(env):
    a = env.desktop.add(DOCS)
    env.desktop.add(PICS, unreadable="start")
    c = env.desktop.add(DOCS)
    sc = env.call()
    assert sc["error"]["code"] == "AMBIGUOUS" and len(sc["observedState"]["candidates"]) == 2
    env.next_turn("turn-2")
    sc2 = env.call(targetId=sc["observedState"]["candidates"][1]["id"])
    assert sc2["verified"] is True and env.desktop.navigations == [(c.hwnd, DOWNLOADS)]


def test_noid03_id_issued_earlier_then_field_unreadable_is_not_found(env):
    (a, _), cands = two_windows_and_ask(env)
    a.start = None                                                  # GetProcessTimes now fails
    before = snapshot(env.desktop)
    sc = env.call(targetId=cands[0]["id"])
    assert_refused_untouched(sc, env, before, "NOT_FOUND")
    assert "no_identity" in sc["error"]["message"]


def test_noid04_unreadable_before_send_is_precondition_failed(env):
    a = env.desktop.add(DOCS, foreground=True)
    env.desktop.on_before_dispatch = lambda d: setattr(a, "pid", None)
    sc = env.call()
    assert sc["error"]["code"] == "PRECONDITION_FAILED" and sc["sideEffect"] == "none"
    assert env.desktop.navigations == []


def test_noid05_unreadable_after_send_is_postcondition_unknown(env):
    a = env.desktop.add(DOCS, foreground=True)
    env.desktop.on_navigate = lambda d, h, p: setattr(a, "start", None)
    sc = env.call()
    assert sc["error"]["code"] == "POSTCONDITION_UNKNOWN" and sc["sideEffect"] == "unknown"


# PIN: internal adapter API (E11 verifier / control channel) takes a §3.3 wire identity ---------------
def _pinned_call(env, pinned, **args):
    from dottie_tools.reference.reference import open_known_folder
    return env.raw({"folder": "downloads", **args}, pinned=pinned)


def _wire(w):
    return {"hwnd": str(w.hwnd), "pid": str(w.pid), "windowClass": w.cls, "processStartTime": str(w.start)}


def test_pin01_valid_pinned_identity_navigates_only_that_window(env):
    a, b = env.desktop.add(DOCS, foreground=True), env.desktop.add(PICS)
    sc = _pinned_call(env, _wire(b))
    assert sc["verified"] is True and env.desktop.navigations == [(b.hwnd, DOWNLOADS)] and a.tabs == [DOCS]


@pytest.mark.parametrize("field,bad", [("processStartTime", "num"), ("hwnd", "num"), ("pid", "num"),
                                       ("processStartTime", "pad"), ("pid", "pad"), ("hwnd", "iso"),
                                       ("processStartTime", ""), ("pid", "zero"), ("hwnd", "zero")])
def test_pin02_malformed_pinned_identity_is_invalid_argument(env, field, bad):
    a = env.desktop.add(DOCS, foreground=True)
    w = _wire(a)
    w[field] = {"num": int(w[field]), "pad": "0" + w[field], "iso": "2024-05-01T00:00:00Z", "": "",
                "zero": "0"}[bad]
    before = snapshot(env.desktop)
    assert_refused_untouched(_pinned_call(env, w), env, before, "INVALID_ARGUMENT")


def test_pin03_pinned_identity_with_other_start_time_is_not_found(env):
    a = env.desktop.add(DOCS, foreground=True)
    w = _wire(a)
    w["processStartTime"] = str(a.start + 1)
    before = snapshot(env.desktop)
    assert_refused_untouched(_pinned_call(env, w), env, before, "NOT_FOUND")


def test_pin04_pinned_and_target_id_together_is_invalid_argument(env):
    (a, _), cands = two_windows_and_ask(env)
    before = snapshot(env.desktop)
    assert_refused_untouched(_pinned_call(env, _wire(a), targetId=cands[0]["id"]), env, before, "INVALID_ARGUMENT")
