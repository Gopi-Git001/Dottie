"""Clean-room contract reference for explorer.open_known_folder{folder, targetId?}.

Sources: CONTRACTS v2 §3 (category `navigate`, scope `files.navigate`), §3.2 audit, §3.3 identity and
canonicaliser, §5 (E04 review rulings); ADR-0009 CR2/CR3/CR6, item 7, item 8 + `navigate` exception
(conditions 1-7); E01 rulings 2026-10-19 (DENIED_BY_POLICY vs APPROVAL_REQUIRED; reserved model args).
Not production code and not derived from Bot.

Category AND scope come from the pinned catalog entry (``catalog``, default the pinned copy; E01 1z), never
one from the other. Tests exercise the mutating path (approval round-trip + K8 token) by passing a pinned
catalog FIXTURE whose entry is local_change with its own scope. ``category``, if given, is the category stated
for the call; any disagreement with the pinned entry, or a missing/unreadable entry -> DENIED_BY_POLICY
{catalog_mismatch} (CR5 reason, E01 ruling 1z.1).

Check order (each step returns before any later step runs; nothing is touched before step 11):
 1 reserved model-arg keys -> INVALID_ARGUMENT + diagnostic of key names only (host writes no audit, X1) (checked first, as in 16b3880);
   then authorizeToolCall's answer: AuthRefusal -> its code (P24 navigate gate DENIED_BY_POLICY, 2 s
   timeout PRECONDITION_FAILED, ...); no context                    -> PRECONDITION_FAILED (decision C1)
 2 schema (any other extra key, non-enum folder, malformed targetId -> INVALID_ARGUMENT)
 3 pinned entry readable and agreeing with any stated category else DENIED_BY_POLICY; its scope granted else PERMISSION_REQUIRED
 4 session not locked / panic-stopped / muted (host re-check of P24; unreadable -> gate_state_unavailable)
                                                                 else DENIED_BY_POLICY
 5 known folder resolves, exists, is local and inside the profile after reparse resolution
                                                                 else DENIED_BY_POLICY known_folder_redirected
 6 target lookup (targetId / pinned / P9 adoption)               NOT_FOUND / AMBIGUOUS
 6b target actionable: not cloaked, cloaked check readable       else PRECONDITION_FAILED (CONTRACTS §5)
    (no coordinates needed, so DPI is not read; a coordinate action would also need a readable DPI)
 7 already showing the folder                                    -> verified, none (nothing to approve)
 8 actionId; approval-needing category: in-call requestApproval (tool-host-control §4.4), unless the
   coordinator attached a token for a re-issued call. ApprovalResolution.decision (CONTRACTS §3.2, C6):
   declined -> USER_DECLINED; expired / revoked (mute, locked, ...) -> APPROVAL_REQUIRED; cancelled, or
   revoked by task_cancel / panic_stop / quit -> CANCELLED (C7); denied_by_policy or a non-§3.2 value ->
   DENIED_BY_POLICY; no answer in expiry + 5 s -> APPROVAL_REQUIRED (turn live) else CANCELLED (§2.3.1);
   no coordinator -> APPROVAL_REQUIRED (+ actionId)
 9 identity re-check right before dispatch                       else PRECONDITION_FAILED (token not spent)
10b navigate only: checkPolicy right before the Explorer call (§4.5c)  else DENIED_BY_POLICY
10 K8 consume(token, actionId recomputed now, taskId, toolId)     revoked-by-cancel -> CANCELLED (C7);
   (C5: bound to taskId+toolId+actionId, not turnId)              anything else, or no answer in 2 s ->
                                                                 DENIED_BY_POLICY
11 dispatch (Navigate2 on the active tab, or explorer.exe with a fixed argv); phase -> after_send first
12 pinned verification                                           POSTCONDITION_UNKNOWN / POSTCONDITION_FAILED
Cancellation points (§6.5): before lookup, before consume, right before dispatch -> CANCELLED/none
(phase before_send); every verify sample -> CANCELLED/unknown (after_send). toolCallFinished once per
authorized call with the furthest phase (completed when verified).
"""
from __future__ import annotations

import ntpath
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from dottie_tools.reference.approval import (CANCEL_CAUSES, DECISIONS, NO_CONFIRM_CATEGORIES, RESERVED_MODEL_ARGS,
                                             AuthRefusal, action_id, is_reserved_key)
from dottie_tools.reference.catalog import CATALOG, KNOWN_CATEGORIES
from dottie_tools.reference.ports import ExplorerPort, WindowGone
from dottie_tools.targets import (actionability, HostContext, IdentityFormatError, WindowIdentity, WindowRegistry, identify,
                      is_well_formed_target_id, live_identities, liveness)

TOOL_ID = "explorer.open_known_folder"
FOLDERS = ("downloads", "documents", "desktop", "pictures", "music", "videos")
ALLOWED_KEYS = frozenset({"folder", "targetId"})
EXPLORER_EXE = r"%SystemRoot%\explorer.exe"     # resolved by the real adapter; never a shell string
# E01 ruling 1z: the scope comes from the PINNED catalog entry, never from the category (no category->scope map).


@dataclass
class HostState:
    """Host-side policy state delivered by the coordinator/K8 (control channel)."""
    scopes: frozenset = frozenset({"files.navigate", "files.write"})
    locked: bool | None = False          # None = unreadable -> fail closed (gate_state_unavailable)
    panic_stopped: bool | None = False
    muted: bool | None = False
    turn_live: bool = True               # from setActiveTurn; decides APPROVAL_REQUIRED vs CANCELLED on timeout
    diag: list = field(default_factory=list)                # redacted diagnostic log: reason codes and key
                                                            # names only; the host writes NO audit (E08 X1)
    finished: list = field(default_factory=list)            # toolCallFinished notifications (§4.6b, E-P5)
    approval_requests: list = field(default_factory=list)   # previews sent to the coordinator


def _same(port: ExplorerPort, a: str | None, b: str | None) -> bool:
    return bool(a) and bool(b) and port.final_path(a) == port.final_path(b)


def _result(*, verified: bool, outcome: str, decision: str, checks: dict[str, str], side_effect: str,
            code: str | None = None, message: str = "", question: str | None = None,
            candidates: list[dict[str, str]] | None = None, extra: dict | None = None) -> dict[str, Any]:
    state: dict[str, Any] = {"outcome": outcome, "decision": decision, "checks": checks, "sideEffect": side_effect}
    if question:
        state["question"] = question
    if candidates:
        state["candidates"] = candidates
    if extra:
        state.update(extra)
    out: dict[str, Any] = {"verified": verified, "observedState": state, "sideEffect": side_effect}
    if code is not None:
        out["error"] = {"code": code, "message": message, "retryable": False}
    return out


def _stop(code: str, message: str, checks: dict[str, str], side_effect: str = "none",
          outcome: str = "failed", extra: dict | None = None) -> dict[str, Any]:
    return _result(verified=False, outcome=outcome, decision="stop", checks=checks,
                   side_effect=side_effect, code=code, message=message, extra=extra)


def _done(checks: dict[str, str], side_effect: str) -> dict[str, Any]:   # caller sets phase completed
    return _result(verified=True, outcome="verified", decision="done", checks=checks, side_effect=side_effect)


def _active_path(port: ExplorerPort, hwnd: int) -> str | None:
    try:
        return port.active_tab_path(hwnd)
    except WindowGone:
        return None


def _inside(port: ExplorerPort, path: str, root: str) -> bool:
    p, r = port.final_path(path), port.final_path(root)
    return p == r or p.startswith(r + "\\")


class _Track:
    phase = "not_started"
    reason: str | None = None


_ALLOWED = {"ok": True, "data": {"allowed": True}}
_CONSUMED = {"ok": True, "data": {"consumed": True}}


def _exact(reply: Any, expected: dict) -> bool:
    """Exact control-channel reply: same keys, same values AND types (True must not match 1)."""
    if type(reply) is not type(expected):
        return False
    if isinstance(expected, dict):
        return set(reply) == set(expected) and all(_exact(reply[k], v) for k, v in expected.items())
    return reply == expected


# toolCallFinished.reason: CLOSED enum of host-detected refusals (P26; E01 ruling 2f). Anything else is never
# emitted. Internal host reason codes map onto it; unmapped ones (K8-originated or host bookkeeping) are dropped.
FINISHED_REASONS = frozenset({"known_folder_redirected", "locked", "schema_invalid", "catalog_mismatch",
                              "precondition_failed"})
_TO_FINISHED_REASON = {"reserved_model_arg": "schema_invalid"}


def finished_reason(reason: object) -> str | None:
    """Host reason code -> toolCallFinished.reason, or None (= leave the key out). Never raises."""
    if not isinstance(reason, str):
        return None
    r = _TO_FINISHED_REASON.get(reason, reason)
    return r if r in FINISHED_REASONS else None

_POLICY_PASSTHROUGH = {
    "PERMISSION_REQUIRED": "scope not granted; nothing was changed",
    "CANCELLED": "cancelled; nothing was changed",
    "PRECONDITION_FAILED": "precondition failed; nothing was changed",
}

def open_known_folder(port: ExplorerPort, registry: WindowRegistry | None, ctx: HostContext | AuthRefusal | None,
                      args: Any, *, clock: Callable[[], float], sleep: Callable[[float], None],
                      host: HostState | None = None, k8: Any = None,
                      approval: dict | None = None, coordinator: Any = None,
                      category: str | None = None, catalog: Any = None,
                      pinned: Any = None, timeout: float = 6.0, interval: float = 0.2,
                      samples: int = 2, cancel: Callable[[], bool] | None = None,
                      call_id: str = "call-1", check_policy: Callable[[dict], Any] | None = None) -> dict[str, Any]:
    """``ctx`` is what authorizeToolCall returned: a HostContext, an AuthRefusal (incl. the P24 navigate
    gate and the 2 s timeout), or None (no answer / no channel). Every call that passed authorizeToolCall
    ends with exactly one toolCallFinished in ``host.finished`` (§4.6b) carrying the furthest phase (§6.5)."""
    host = host or HostState()
    track = _Track()
    out = _run(port, registry, ctx, args, clock=clock, sleep=sleep, host=host, k8=k8,
               approval=approval, coordinator=coordinator, category=category, catalog=catalog, pinned=pinned,
               timeout=timeout, interval=interval, samples=samples, cancel=cancel or (lambda: False), track=track,
               check_policy=check_policy, call_id=call_id)
    if out["verified"]:
        track.phase = "completed"
    if isinstance(ctx, HostContext):
        note = {"v": 1, "callId": call_id, "toolId": TOOL_ID, "taskId": ctx.task_id,
                "phase": track.phase, "sideEffect": out["sideEffect"]}
        reason = finished_reason(track.reason)   # closed enum only (2f); lets K8 audit a host-detected refusal
        if reason is not None:
            note["reason"] = reason
        host.finished.append(note)
    return out


def _run(port, registry, ctx, args, *, clock, sleep, host, k8, approval, coordinator, category, catalog, pinned,
         timeout, interval, samples, cancel, track, check_policy, call_id) -> dict[str, Any]:

    def deny(reason: str, folder: str | None, checks: dict[str, str]) -> dict[str, Any]:
        host.diag.append({"event": "tool.refused", "code": "DENIED_BY_POLICY", "reason": reason})
        track.reason = reason
        return _stop("DENIED_BY_POLICY", "denied by policy; nothing was changed", checks)

    # 1 reserved model-arg keys first (same order as authorizeToolCall in 16b3880), then host context
    if isinstance(args, dict):
        reserved = sorted(k for k in args if is_reserved_key(k))
        if reserved:
            host.diag.append({"event": "tool.refused", "code": "INVALID_ARGUMENT", "reason": "reserved_model_arg",
                              "argKeys": reserved})                            # key names only, never values
            track.reason = "reserved_model_arg"
            return _stop("INVALID_ARGUMENT", "reserved argument names are not accepted from the model", {})
    if isinstance(ctx, AuthRefusal):
        return _stop(ctx.code, "not authorized; nothing was changed", {})
    if ctx is None or not ctx.task_id or not ctx.turn_id or registry is None:
        return _stop("PRECONDITION_FAILED", "no active task turn; nothing was changed", {})
    # 2 schema
    if not isinstance(args, dict):
        return _stop("INVALID_ARGUMENT", "arguments do not match the tool schema", {})
    if not set(args) <= ALLOWED_KEYS or "folder" not in args:
        return _stop("INVALID_ARGUMENT", "arguments do not match the tool schema", {})
    folder, tid = args.get("folder"), args.get("targetId")
    if folder not in FOLDERS:
        return _stop("INVALID_ARGUMENT", "folder must be one of the known-folder ids", {})
    if tid is not None and not is_well_formed_target_id(tid):
        return _stop("INVALID_ARGUMENT", "targetId is malformed", {})
    pinned_ident: WindowIdentity | None = None
    if pinned is not None:
        if tid is not None:
            return _stop("INVALID_ARGUMENT", "targetId and a pinned identity are mutually exclusive", {})
        try:
            pinned_ident = WindowIdentity.from_wire(pinned)
        except IdentityFormatError:
            return _stop("INVALID_ARGUMENT", "pinned window identity is malformed", {})
    # 3 scope, from the pinned catalog entry only (E01 1z). ``category`` is the category stated for this call
    # (e.g. by the authorization binding); if it disagrees with the pinned entry -> DENIED_BY_POLICY, sideEffect
    # none: a stated category can neither upgrade nor downgrade the scope (or skip approval).
    entry = (CATALOG if catalog is None else catalog)
    entry = entry.get(TOOL_ID) if isinstance(entry, dict) else None
    pinned_cat = entry.get("category") if isinstance(entry, dict) else None
    scope = entry.get("scope") if isinstance(entry, dict) else None
    if not (isinstance(pinned_cat, str) and pinned_cat in KNOWN_CATEGORIES and isinstance(scope, str) and scope):
        return deny("catalog_mismatch", folder, {})          # missing/unreadable entry (1z.1)
    if category is not None and category != pinned_cat:
        return deny("catalog_mismatch", folder, {})          # stated category != pinned (1z.1)
    category = pinned_cat
    if scope not in host.scopes:
        return _stop("PERMISSION_REQUIRED", "scope not granted; nothing was changed", {})
    # 4 session state
    flags = (host.locked, host.panic_stopped, host.muted)
    if not all(isinstance(f, bool) for f in flags):                       # unreadable gate state: fail closed
        return deny("gate_state_unavailable", folder, {})
    for flag, reason in zip(flags, ("locked", "panic_stop", "mute")):
        if flag:
            return deny(reason, folder, {})
    # 5 known folder: resolved server-side, local, existing, inside the profile after reparse resolution
    expected = port.known_folder(folder)
    if (not expected or not port.folder_exists(expected) or expected.startswith("\\\\")
            or port.is_network_path(expected) or not _inside(port, expected, port.user_profile())):
        return deny("known_folder_redirected", folder, {"EXP-01": "fail"})
    checks = {"EXP-01": "pass"}

    def cancelled(side_effect: str) -> dict[str, Any] | None:
        if not cancel():
            return None
        if side_effect == "none":
            return _stop("CANCELLED", "the task was stopped before the action was sent; nothing was changed", checks)
        return _stop("CANCELLED", "the task was stopped after the action was sent; the result was not verified",
                     {**checks, "EXP-06": "unknown"}, side_effect="unknown", outcome="unverified")

    # 6 target lookup
    track.phase = "before_send"
    if (c := cancelled("none")) is not None:
        return c
    ident: WindowIdentity | None
    launch = False
    if tid is not None:
        res = registry.resolve(ctx, tid, reader=port)
        if not res.ok:
            return _stop(res.error_code or "NOT_FOUND", f"targetId not usable ({res.reason}); nothing was changed",
                         {**checks, "EXP-02": "fail"})
        ident = res.identity
    elif pinned_ident is not None:
        state = liveness(port, pinned_ident)
        if state.closed:
            return _stop("NOT_FOUND", f"pinned window not usable ({state.value}); nothing was changed",
                         {**checks, "EXP-02": "fail"})
        ident = pinned_ident
    else:
        hwnds = port.top_level_explorer_hwnds()
        wins = live_identities(port)
        fg = port.foreground_root()
        if fg in hwnds or len(hwnds) == 1:
            ident = identify(port, fg if fg in hwnds else hwnds[0])
            if ident is None:
                return _stop("NOT_FOUND", "target window has no readable identity; nothing was changed",
                             {**checks, "EXP-02": "fail"})
        elif not hwnds:
            ident, launch = None, True
        else:
            if not wins:
                return _stop("NOT_FOUND", "no Explorer window has a readable identity; nothing was changed",
                             {**checks, "EXP-02": "fail"})
            wins = [w for w in wins if actionability(port, w).ok]          # never offer a non-actionable window
            if not wins:
                return _stop("PRECONDITION_FAILED", "no Explorer window can be acted on (cloaked or unreadable); "
                             "nothing was changed", {**checks, "EXP-02": "fail"})
            at_target = [w for w in wins if _same(port, _active_path(port, w.hwnd), expected)]
            if len(at_target) == 1:
                return _done({**checks, "EXP-02": "pass", "EXP-06": "pass"}, "none")
            cands = registry.issue(ctx, [(w, f"File Explorer window {i}") for i, w in enumerate(wins, 1)])
            return _result(verified=False, outcome="unverified", decision="ask_user",
                           checks={**checks, "EXP-02": "unknown"}, side_effect="none", code="AMBIGUOUS",
                           message="several Explorer windows; none is in front",
                           question=f"I see {len(hwnds)} File Explorer windows. Which one should I use?",
                           candidates=cands)
    # 6b actionable (CONTRACTS §5 fail-closed observations)
    if ident is not None and not actionability(port, ident).ok:
        return _stop("PRECONDITION_FAILED", "target window can't be acted on (cloaked or unreadable); nothing was changed",
                     {**checks, "EXP-02": "fail"})
    checks["EXP-02"] = "pass"

    # 7 already there
    if ident is not None and _same(port, _active_path(port, ident.hwnd), expected):
        return _done({**checks, "EXP-06": "pass"}, "none")

    # 8 actionId + approval (in-call requestApproval, tool-host-control §4.4)
    resolved_args = {"folder": folder, "path": port.final_path(expected)}
    needs_approval = category not in NO_CONFIRM_CATEGORIES
    # The ids hashed into actionId are this call's, or (call re-issued in a later turn, E08 5 Option 1) the
    # approved ids from authorizeToolCall's `approval`, which carries NO token: the host recomputes actionId
    # from those ids + args and window re-resolved NOW and asks K8 to re-mint (requestToolToken, §4.5b).
    bind_ctx = ctx
    token = None
    aid = action_id(TOOL_ID, resolved_args, ident, ctx)
    if needs_approval and approval is not None:
        b = approval.get("binding") if isinstance(approval, dict) else None
        if isinstance(b, dict) and isinstance(b.get("turnId"), str):
            approved_ctx = HostContext(ctx.task_id, b.get("threadId"), b["turnId"], b.get("itemId"), b.get("requestId"))
            remint_aid = action_id(TOOL_ID, resolved_args, ident, approved_ctx)
            try:
                if k8 is None:
                    raise TimeoutError("no K8 wired")
                reply = k8.request_tool_token({"v": 1, "callId": call_id, "actionId": remint_aid},
                                              task_id=ctx.task_id, tool_id=TOOL_ID)
            except Exception:                            # §2.3.1: 2 s -> APPROVAL_REQUIRED (turn live) else CANCELLED
                reply = "timeout"
            if reply == "timeout":
                code = "APPROVAL_REQUIRED" if host.turn_live and not cancel() else "CANCELLED"
                return _stop(code, "no token arrived in time; nothing was changed", checks)
            data = reply.get("data") if isinstance(reply, dict) else None
            if (isinstance(reply, dict) and reply.get("ok") is True and set(reply) == {"ok", "data"}
                    and isinstance(data, dict) and set(data) == {"token", "expiresAt"}
                    and isinstance(data["token"], str)):
                token, bind_ctx, aid = data["token"], approved_ctx, remint_aid
            else:
                code = reply.get("error", {}).get("code") if isinstance(reply, dict) and \
                    isinstance(reply.get("error"), dict) else None
                if code == "CANCELLED":
                    return _stop("CANCELLED", "the task was stopped; nothing was changed", checks)   # final (E08 11)
                if code != "APPROVAL_REQUIRED":                  # DENIED_BY_POLICY or any odd reply: no fallback
                    return deny("remint_refused", folder, checks)
                # APPROVAL_REQUIRED: fall back to a fresh approval with this call's ids (E08 5, R4)
    if needs_approval and token is None:
        req = {"actionId": aid, "binding": {"method": TOOL_ID, "args": resolved_args,
                                            "targets": {"window": ident.to_wire() if ident else None},
                                            "taskId": ctx.task_id, "threadId": ctx.thread_id, "turnId": ctx.turn_id,
                                            "itemId": ctx.item_id, "requestId": ctx.request_id},
               "preview": {"summary": f"Show {folder} in File Explorer", "risk": "low", "category": category}}
        host.approval_requests.append({"actionId": aid, "category": category, "risk": "low",
                                       "summary": req["preview"]["summary"]})
        if coordinator is None:
            return _stop("APPROVAL_REQUIRED", "approval needed in the Dottie approval dialog; nothing was changed",
                         checks, extra={"actionId": aid})
        try:
            res = coordinator.request_approval(req)      # the coordinator/K8 write the approval.* audit records
        except Exception:                                # §2.3.1: no answer within expiry + 5 s (or channel error)
            if host.turn_live and not cancel():
                return _stop("APPROVAL_REQUIRED", "no approval arrived in time; nothing was changed", checks,
                             extra={"actionId": aid})
            return _stop("CANCELLED", "the turn ended while waiting for approval; nothing was changed", checks,
                         extra={"actionId": aid})
        if res.decision not in DECISIONS:                # not a §3.2 value: fail closed, never "approved"
            return deny("unknown_decision", folder, checks)
        if res.decision != "approved":
            cancel_caused = res.decision == "cancelled" or (res.decision == "revoked" and res.reason in CANCEL_CAUSES)
            if cancel_caused:                                                          # C7
                code, msg = "CANCELLED", "the task was stopped; nothing was changed"
            else:
                code, msg = {
                    "declined": ("USER_DECLINED", "you declined in the approval dialog; nothing was changed"),
                    "expired": ("APPROVAL_REQUIRED", "the approval timed out; nothing was changed"),
                    "revoked": ("APPROVAL_REQUIRED", "the approval was revoked; nothing was changed"),
                }.get(res.decision, ("DENIED_BY_POLICY", "denied by policy; nothing was changed"))
            # K8-originated reasons (display_unavailable, reused, schema_invalid, ...) are NOT forwarded in
            # toolCallFinished.reason: K8 is their source (E01 ruling 2f).
            return _stop(code, msg, checks, extra={"actionId": aid})
        token = res.token

    # 9 time-of-use identity re-check (token not spent on failure)
    hook = getattr(port, "on_before_dispatch", None)
    if hook:
        hook(port)
    if ident is not None and liveness(port, ident).closed:
        return _stop("PRECONDITION_FAILED", "target window closed before the action was sent; nothing was changed",
                     {**checks, "EXP-02": "fail"})
    if ident is not None and not actionability(port, ident).ok:
        return _stop("PRECONDITION_FAILED", "target window can't be acted on (cloaked or unreadable); nothing was changed",
                     {**checks, "EXP-02": "fail"})
    # 10 K8 token (CR6; C5 binding taskId+toolId+actionId), consumed before the side effect
    if needs_approval:
        aid_now = action_id(TOOL_ID, {"folder": folder, "path": port.final_path(port.known_folder(folder) or "")},
                            ident, bind_ctx)
        if (c := cancelled("none")) is not None:
            return c
        params = {"v": 1, "callId": call_id, "token": token, "actionId": aid_now, "taskId": ctx.task_id,
                  "toolId": TOOL_ID}
        try:
            reply = k8.consume_tool_token(params) if k8 is not None else None
        except Exception:                # §2.3.1 consume silent 2 s / channel error: no retry, late reply ignored
            reply = "consume_timeout"
        token = params["token"] = None   # drop the reference right after consume (E08 8)
        if not _exact(reply, _CONSUMED):
            if isinstance(reply, dict) and isinstance(reply.get("error"), dict) \
                    and reply["error"].get("code") == "CANCELLED":                  # C7, final (E08 11)
                track.reason = "revoked_cancel"
                return _stop("CANCELLED", "the task was stopped before the action was sent; nothing was changed",
                             checks)
            reason = reply if isinstance(reply, str) else ("no_k8" if reply is None else "consume_refused")
            return deny(reason, folder, checks)          # K8 audits its own verdict; host: diag only

    # 10b navigate: K8 checkPolicy immediately before the Explorer call (DOT-092 DRAFT 4 §4.5c, E08 12).
    # Dispatch only on the exact allowed reply; no K8 wired, a timeout, an error or any other shape -> deny.
    if category == "navigate":
        req = {"v": 1, "callId": call_id, "toolId": TOOL_ID, "category": "navigate"}
        try:
            reply = check_policy(req) if check_policy is not None else None
        except Exception:                                # 2 s timeout / channel error -> deny (E08 12)
            reply = "check_policy_timeout"
        if not _exact(reply, _ALLOWED):
            reason = "no_k8" if check_policy is None else (reply if isinstance(reply, str) else "check_policy_failed")
            # R1 (DRAFT 5 §4.5c): PERMISSION_REQUIRED, CANCELLED and PRECONDITION_FAILED pass through as codes
            # only (generic message); anything else -> DENIED_BY_POLICY.
            code = reply["error"].get("code") if isinstance(reply, dict) and isinstance(reply.get("error"), dict) \
                else None
            if code in _POLICY_PASSTHROUGH:
                return _stop(code, _POLICY_PASSTHROUGH[code], checks)
            return deny(reason, folder, checks)
    # 10c host's own WTSQuerySessionInformation lock check right before send (E08 12), whatever K8 said
    if host.locked is not False:
        return deny("locked" if host.locked else "gate_state_unavailable", folder, checks)
    # 11 dispatch. Last cancellation point with sideEffect none, then the phase flips (§6.5 rule).
    if (c := cancelled("none")) is not None:
        return c
    before = set(port.top_level_explorer_hwnds())
    track.phase = "after_send"
    if launch:
        port.launch_explorer([EXPLORER_EXE, ntpath.normpath(expected)])
        new_hwnds = [h for h in port.top_level_explorer_hwnds() if h not in before]
        fresh = [i for h in new_hwnds if (i := identify(port, h)) is not None]
        if len(new_hwnds) != 1 or len(fresh) != 1:
            return _stop("POSTCONDITION_UNKNOWN", "new Explorer window could not be identified",
                         {**checks, "EXP-02": "unknown", "EXP-08": "fail" if fresh else "unknown"},
                         side_effect="unknown", outcome="unverified")
        ident = fresh[0]
        checks["EXP-08"] = "pass"
    else:
        try:
            port.navigate_active_tab(ident.hwnd, expected)
        except WindowGone:                               # refused by the port before anything was sent
            track.phase = "before_send"
            return _stop("PRECONDITION_FAILED", "target window closed before the action was sent; nothing was changed",
                         {**checks, "EXP-02": "fail"})

    # 12 pinned verification
    deadline = clock() + timeout
    streak = 0
    while clock() < deadline:
        sleep(interval)
        if (c := cancelled("unknown")) is not None:
            return c
        if liveness(port, ident).closed:
            return _stop("POSTCONDITION_UNKNOWN", "target window closed after the action was sent",
                         {**checks, "EXP-02": "fail", "EXP-06": "unknown"}, side_effect="unknown",
                         outcome="unverified")
        try:
            observed = port.active_tab_path(ident.hwnd)
        except WindowGone:
            return _stop("POSTCONDITION_UNKNOWN", "target window closed after the action was sent",
                         {**checks, "EXP-02": "fail", "EXP-06": "unknown"}, side_effect="unknown",
                         outcome="unverified")
        streak = streak + 1 if _same(port, observed, expected) else 0
        if streak >= samples:
            return _done({**checks, "EXP-06": "pass"}, "committed")
    return _stop("POSTCONDITION_FAILED", "target window did not show the folder before the deadline",
                 {**checks, "EXP-06": "fail"}, side_effect="unknown")
