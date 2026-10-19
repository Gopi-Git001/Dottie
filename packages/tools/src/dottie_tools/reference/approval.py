"""Approval binding for desktop tools. Scratch only; aligned to docs/contracts/tool-host-control.md (DOT-092
DRAFT 3, E03) and E01/E03 decisions C1-C7 (2026-10-19).

* ``action_doc``/``action_id``: CONTRACTS §3.3 canonical JSON of {purpose:"dottie.actionId.v1", method, args,
  targets{window}, taskId, threadId, turnId, itemId, requestId}; lowercase-hex SHA-256 (ADR-0009 CR2).
* ``FakeK8`` (DOT-092 DRAFT 4 §4.5/§4.5b/§4.5c/§5, E08 review): approval records ``approved -> executed``
  (X4); token bound to taskId + toolId + actionId (E08 4), purpose dottie.approvalToken.v1, single use
  (also burnt on mismatch), TTL = min(approval expiry, mint + 10 s), at most one live token per approval.
  Revoked at turn end (setActiveTurn(null)), every stop, endTask, item-7 events (E08 6). The only
  cross-turn path is an Option 1 re-mint via requestToolToken from the live, unexecuted approval
  (E08 5). Consume-time state check (locked / mute / panic-stop / stop requested). K8 writes every audit
  record (X1); the host writes none. Replies use the exact control-channel shapes.
* ``FakeAuthorizer``: coordinator ``authorizeToolCall`` incl. the P24 navigate gate (no token, fails closed).
* ``FakeCoordinator.request_approval``: the in-call ``requestApproval`` round-trip (§4.4) answering with the
  CONTRACTS §3.2 ``decision`` enum (decision C6).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass

from dottie_tools.targets import CanonicalError, HostContext, WindowIdentity, canonical_json

PURPOSE_ACTION_ID = "dottie.actionId.v1"
PURPOSE_TOKEN = "dottie.approvalToken.v1"            # DOT-092 DRAFT 3 §5.3 (P17 purpose value; PROPOSAL until E08/E01)
CANCEL_CAUSES = frozenset({"task_cancel", "panic_stop", "quit"})   # revocations that also cancel the task (§4.4/§4.5, C7)
# Revocation cause -> the lowercase audit reason K8 writes when a revoked token is later used. E08 ruled
# (2026-10-19, DRAFT 5.1 §5.7) to ADD superseded / turn_end / end_task as reasons, so the map is identity;
# kept as one table so a future rename is a one-line change. Cancel causes keep their reasons and give the
# CANCELLED ToolError; every other cause gives DENIED_BY_POLICY. The model only ever sees the ToolError code.
REVOCATION_AUDIT_REASON = {
    "superseded": "superseded",      # earlier unused token revoked by a re-mint of the same approval (R4)
    "turn_end": "turn_end",          # setActiveTurn(null): turn end or interrupt (E08 6)
    "end_task": "end_task",          # endTask after a normal task end
    "task_cancel": "task_cancel", "panic_stop": "panic_stop", "quit": "quit",
    "mute": "mute", "locked": "locked", "app_server_restart": "app_server_restart",
    "ipc_disconnect": "ipc_disconnect",
}
GATE_MAX_AGE_S = 1.0                                 # P24a gateStateMaxAgeMs = 1000 ms (PROVISIONAL)
RESERVED_MODEL_ARGS = frozenset({"taskId", "turnId", "threadId", "hwnd", "pid"})   # E03/E04 decided 2026-10-19
_RESERVED_NORM = frozenset(k.lower() for k in RESERVED_MODEL_ARGS)


def is_reserved_key(key: object) -> bool:
    """tool-host-control P9 (PROPOSAL): case-insensitive after removing '_' and '-' (task_id, TaskID, turn-id)."""
    return isinstance(key, str) and key.replace("_", "").replace("-", "").lower() in _RESERVED_NORM
APPROVAL_TTL_S = 60.0                                # ADR-0009 item 7 default; hard max 120 s
APPROVAL_TTL_MAX_S = 120.0
TOKEN_TTL_CAP_S = 10.0                               # P18, PROPOSAL
NO_CONFIRM_CATEGORIES = frozenset({"read", "navigate"})   # ADR-0009 item 8 + navigate exception
DECISIONS = ("approved", "declined", "cancelled", "denied_by_policy", "expired", "revoked")   # CONTRACTS §3.2


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _string_args(args: object) -> dict:
    """Resolved args must already be strings or None; never str() a number (CPython's int->str digit
    limit would raise ValueError on a huge int, and coercion hides type bugs)."""
    if not isinstance(args, dict):
        raise CanonicalError("args must be an object")
    for k, v in args.items():
        if not isinstance(k, str) or not (v is None or isinstance(v, str)):
            raise CanonicalError("resolved args must be string -> string|null")
    return dict(args)


def action_doc(method: str, args: dict, target: WindowIdentity | None, ctx: HostContext) -> str:
    return canonical_json({
        "purpose": PURPOSE_ACTION_ID,
        "method": method,
        "args": _string_args(args),
        "targets": {"window": target.to_wire() if target else None},
        "taskId": ctx.task_id, "threadId": ctx.thread_id, "turnId": ctx.turn_id,
        "itemId": ctx.item_id, "requestId": ctx.request_id,
    })


def action_id(method: str, args: dict, target: WindowIdentity | None, ctx: HostContext) -> str:
    return hashlib.sha256(action_doc(method, args, target, ctx).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class AuthRefusal:
    """authorizeToolCall answered ok:false (or the host timed out waiting, §2.3.1). The host returns this
    code with sideEffect none and runs nothing else."""
    code: str
    reason: str


@dataclass(frozen=True)
class GateSnapshot:
    """PolicyPort.gateState() (DOT-092 D8): None / a raise / a malformed or stale snapshot = unavailable."""
    locked: object
    panic_stopped: object
    muted: object
    observed_at: object


class FakeAuthorizer:
    """Coordinator side of authorizeToolCall (DOT-092 §4.3 as in 16b3880, plus P24/P24a for navigate).
    Order: reserved model-arg keys -> INVALID_ARGUMENT; no active turn -> PRECONDITION_FAILED; for a
    `navigate` tool the K8 gate state, read with NO token: locked / panic_stop / mute -> DENIED_BY_POLICY;
    unreadable, malformed, stale (> 1000 ms, missing or future observedAt) or no K8 -> DENIED_BY_POLICY
    gate_state_unavailable (fail closed). Scope is left to the host (PERMISSION_REQUIRED there)."""

    def __init__(self, clock=lambda: 0.0, catalog_category=None, k8=None) -> None:
        self.clock = clock
        self.k8 = k8                        # for Option 1 `approval` ids (E08 5)
        self.catalog_ok = True              # hello.catalog equalled the pinned catalog (X2); else refuse all
        self.context: HostContext | None = None
        self.gate: object = "fresh"         # "fresh" -> a clear snapshot at now; or a GateSnapshot / None / Exception
        self.k8_wired = True
        self.silent = False                 # host gives up after 2 s (§2.3.1)
        self.audit: list[dict] = []
        self.tokens_minted = 0              # must stay 0: the gate check never needs a token
        from dottie_tools.reference.catalog import category_of
        self._category = catalog_category or category_of

    def _gate(self):
        g = self.gate
        if g == "fresh":
            return GateSnapshot(False, False, False, self.clock())
        if isinstance(g, BaseException):
            raise g
        return g

    def authorize(self, tool_id: str, model_args: object) -> HostContext | AuthRefusal:
        if self.silent:
            return AuthRefusal("PRECONDITION_FAILED", "authorize_timeout")
        if not self.catalog_ok:
            return AuthRefusal("PRECONDITION_FAILED", "catalog_mismatch")
        if isinstance(model_args, dict):
            reserved = sorted(k for k in model_args if is_reserved_key(k))
            if reserved:
                self.audit.append({"kind": "policy.denied", "reason": "reserved_model_arg", "argKeys": reserved})
                return AuthRefusal("INVALID_ARGUMENT", "reserved_model_arg")
        if self.context is None:
            return AuthRefusal("PRECONDITION_FAILED", "no_active_turn")
        if self._category(tool_id) == "navigate":
            reason = self._gate_reason()
            if reason:
                self.audit.append({"kind": "policy.denied", "toolId": tool_id, "decision": "denied_by_policy",
                                   "reason": reason})
                return AuthRefusal("DENIED_BY_POLICY", reason)
        return self.context

    def approval_for(self, tool_id: str, call_id: str | None = "call-1") -> dict | None:
        """``data.approval`` of an ok answer: ids of the live, unexecuted approval, never a token (E08 5)."""
        if self.k8 is None or self.context is None:
            return None
        return self.k8.live_approval(self.context.task_id, tool_id, call_id)

    def _gate_reason(self) -> str | None:
        if not self.k8_wired:
            return "gate_state_unavailable"
        try:
            g = self._gate()
        except Exception:
            return "gate_state_unavailable"
        if not isinstance(g, GateSnapshot):
            return "gate_state_unavailable"
        flags = (g.locked, g.panic_stopped, g.muted)
        if not all(isinstance(f, bool) for f in flags):
            return "gate_state_unavailable"
        at = g.observed_at
        if isinstance(at, bool) or not isinstance(at, (int, float)) or at > self.clock() \
                or self.clock() - at > GATE_MAX_AGE_S:
            return "gate_state_unavailable"
        for flag, reason in zip(flags, ("locked", "panic_stop", "mute")):
            if flag:
                return reason
        return None


class ChannelTimeout(TimeoutError):
    """The control-channel request got no answer within its §2.3.1 host timeout."""


@dataclass
class _Approval:
    action_id: str
    task_id: str
    tool_id: str
    binding: dict | None             # approved ids {threadId, turnId, itemId, requestId}; None = not re-mintable
    expires_at: float
    state: str = "approved"          # approved -> executed | revoked  (X4; expiry is checked by time)
    live_token: str | None = None


@dataclass(frozen=True)
class ApprovalResolution:
    decision: str                    # CONTRACTS §3.2 enum
    reason: str | None = None
    token: str | None = None


@dataclass
class _Grant:
    action_id: str
    task_id: str
    tool_id: str
    expires_at: float
    mac: str
    approval: _Approval | None = None
    revoked: str | None = None       # cause, e.g. task_cancel / mute / panic_stop / turn_end


_CONSUMED = {"ok": True, "data": {"consumed": True}}


_MISSING = object()


class FakeK8:
    def __init__(self, clock=lambda: 0.0) -> None:
        self._key = secrets.token_bytes(32)
        self._grants: dict[str, _Grant] = {}
        self._used: set[str] = set()
        self._approvals: list[_Approval] = []
        self.clock = clock
        self.minted: list[str] = []
        self.audit: list[dict] = []                       # K8 is the only audit writer (X1)
        self.requests: list[dict] = []                    # every control message the host sent to K8
        self.consumed: list[str] = []                     # actionIds the host asked to consume
        self.silent = False                               # consume unanswered -> ChannelTimeout (2 s)
        self.reply_override: object = None                # a scripted consume reply (shape tests)
        self.late_replies: list[dict] = []                # replies K8 produced after the host timed out
        self.gate_unavailable = False                     # gate state unreadable/stale/unwired (R3, K-06b)
        self._offers: dict[str, tuple[str, str, str]] = {}     # callId -> (task, tool, actionId) offered (R4)
        self._accepted: dict[str, dict] = {}              # callId -> postcondition_unknown record (R2)
        self.locked = False                               # consume-time state (E08 2)
        self.muted = False
        self.panic_stopped: set[str] = set()              # task ids
        self.stop_requested: set[str] = set()
        self.resolved: dict[str, str] = {}                # actionId -> final decision (one answer per actionId)

    # -- desktop answer to a tool-host ApprovalRequested (CONTRACTS ApprovalResolved; rulings 1n/2c/2d) -------
    def resolve(self, action_id: object, task_id: str, tool_id: str, binding: dict | None,
                approval_expires_at: float, *, approved: object = _MISSING, reason: object = None,
                decision: object = None) -> ApprovalResolution:
        """Keyword form of resolve_message (tests and the fake coordinator)."""
        msg: dict = {"actionId": action_id, "timestamp": self.clock()}
        if approved is not _MISSING:
            msg["approved"] = approved
        if reason is not None:
            msg["reason"] = reason
        if decision is not None:
            msg["decision"] = decision
        return self.resolve_message(msg, task_id, tool_id, binding, approval_expires_at)

    def resolve_message(self, msg: object, task_id: str, tool_id: str, binding: dict | None,
                        approval_expires_at: float, expected_action_id: str | None = None) -> ApprovalResolution:
        """The coordinator forwards the desktop's ApprovalResolved{actionId, approved, timestamp, reason?} for a
        tool-host approval (CONTRACTS; rulings 1n/2c/2d/2f). Never raises.
        * malformed (not an object, actionId not a non-empty string or not the requested one, approved missing or
          not a bool, unknown/extra keys, a reason other than display_unavailable, reason with approved:true,
          any decision from the desktop) -> denied_by_policy{schema_invalid} (2f); no token.
        * already answered actionId -> denied_by_policy{reused} (2f); no token.
        * approved:false + reason display_unavailable -> denied_by_policy{display_unavailable}; never a user
          decline (2d); no token. approved:false -> declined{user_declined}. approved:true -> approved + token."""
        ok_keys = {"actionId", "approved", "timestamp", "reason"}
        aid = msg.get("actionId") if isinstance(msg, dict) else None
        malformed = (not isinstance(msg, dict) or not set(msg) <= ok_keys or not isinstance(aid, str) or not aid
                     or (expected_action_id is not None and aid != expected_action_id)
                     or type(msg.get("approved")) is not bool
                     or ("reason" in msg and (msg["reason"] != "display_unavailable" or msg["approved"] is True)))
        if malformed:
            out = ApprovalResolution("denied_by_policy", "schema_invalid")
            rec = {"kind": "approval.resolved", "taskId": task_id, "toolId": tool_id,
                   "decision": out.decision, "reason": out.reason}
            if isinstance(expected_action_id, str):           # the live request is final either way
                rec["actionId"] = expected_action_id
                self.resolved.setdefault(expected_action_id, out.decision)
            self._audit(rec)
            return out
        if aid in self.resolved:
            self._audit({"kind": "approval.resolved", "actionId": aid, "taskId": task_id, "toolId": tool_id,
                         "decision": "denied_by_policy", "reason": "reused"})
            return ApprovalResolution("denied_by_policy", "reused")
        if msg["approved"] is True:
            out = ApprovalResolution("approved", None, self.approve(aid, task_id, tool_id, binding,
                                                                    approval_expires_at))
        elif msg.get("reason") == "display_unavailable":
            out = ApprovalResolution("denied_by_policy", "display_unavailable")
        else:
            out = ApprovalResolution("declined", "user_declined")
        self.resolved[aid] = out.decision
        self._audit({"kind": "approval.resolved", "actionId": aid, "taskId": task_id, "toolId": tool_id,
                     "decision": out.decision, "reason": out.reason})
        return out

    # -- issuance -------------------------------------------------------------------------------------------
    def _mint(self, ap: _Approval, reason: str | None = None) -> str:
        now = self.clock()
        expires = min(ap.expires_at, now + TOKEN_TTL_CAP_S)
        token_id, nonce = _b64(secrets.token_bytes(16)), _b64(secrets.token_bytes(16))
        mac_input = canonical_json({"actionId": ap.action_id, "expiresAt": repr(expires), "nonce": nonce,
                                    "purpose": PURPOSE_TOKEN, "taskId": ap.task_id, "toolId": ap.tool_id})
        mac = _b64(hmac.new(self._key, mac_input.encode(), hashlib.sha256).digest())
        if ap.live_token:                                 # at most one live token per approval (E08 6)
            old = self._grants.get(ap.live_token)
            if old:
                old.revoked = old.revoked or "superseded"
        self._grants[token_id] = _Grant(ap.action_id, ap.task_id, ap.tool_id, expires, mac, ap)
        ap.live_token = token_id
        tok = f"k8t1.{token_id}.{mac}"
        self.minted.append(tok)
        self._audit({"kind": "tool_token.minted", "actionId": ap.action_id, "taskId": ap.task_id,
                     "toolId": ap.tool_id, "outcome": "minted", "reason": reason})
        return tok

    def approve(self, action: str, task_id: str, tool_id: str, binding: dict | None,
                approval_expires_at: float) -> str:
        """secure_ui click on a live approval -> approval record + first token."""
        ap = _Approval(action, task_id, tool_id, binding, approval_expires_at)
        self._approvals.append(ap)
        return self._mint(ap)

    def mint(self, action: str, task_id: str, tool_id: str, approval_expires_at: float) -> str:
        """Test helper: an approved record without re-mint ids."""
        return self.approve(action, task_id, tool_id, None, approval_expires_at)

    def _live(self, task_id: str, tool_id: str) -> list[_Approval]:
        now = self.clock()
        return [a for a in self._approvals if a.task_id == task_id and a.tool_id == tool_id
                and a.state == "approved" and now <= a.expires_at and a.binding is not None]

    def _audit(self, rec: dict) -> None:
        """Absent ids are OMITTED, never null (§5.7, E08 R4)."""
        self.audit.append({k: v for k, v in rec.items() if v is not None})

    def live_approval(self, task_id: str, tool_id: str, call_id: str | None = None) -> dict | None:
        """For authorizeToolCall's ``approval`` (E08 5): ids only, NO token; exactly one live record.
        The offer is remembered per callId for this live turn (R4 `missing`)."""
        if task_id in self.stop_requested:
            return None
        live = self._live(task_id, tool_id)
        if len(live) != 1:
            return None                                   # 0 or several -> fail closed to a fresh approval
        if call_id is not None:
            self._offers[call_id] = (task_id, tool_id, live[0].action_id)
        return {"actionId": live[0].action_id, "binding": dict(live[0].binding)}

    def _state_refusal(self, task_id: str) -> str | None:
        if task_id in self.stop_requested:
            return "task_cancel"
        if task_id in self.panic_stopped:
            return "panic_stop"
        if self.gate_unavailable:
            return "gate_state_unavailable"
        if self.locked:
            return "locked"
        if self.muted:
            return "mute"
        return None

    def request_tool_token(self, params: dict, *, task_id: str, tool_id: str) -> dict:
        """§4.5b requestToolToken{v, callId, actionId}; task/tool come from the coordinator's live context.
        Failure codes per E08 R4: APPROVAL_REQUIRED (no reusable approval, still grantable -> host makes a
        fresh requestApproval), CANCELLED final, DENIED_BY_POLICY (missing offer, malformed, gate unavailable)."""
        self.requests.append({"method": "requestToolToken", **params} if isinstance(params, dict)
                             else {"method": "requestToolToken"})
        if self.silent:
            raise ChannelTimeout("requestToolToken")

        def refuse(code: str, reason: str) -> dict:
            self._audit({"kind": "tool_token.minted", "taskId": task_id, "toolId": tool_id, "outcome": "refused",
                         "reason": reason})
            return {"ok": False, "error": {"code": code, "message": "not re-minted", "retryable": False},
                    "sideEffect": "none"}
        if not (isinstance(params, dict) and set(params) == {"v", "callId", "actionId"} and params["v"] == 1
                and type(params["v"]) is int and isinstance(params["callId"], str)
                and isinstance(params["actionId"], str)):
            return refuse("DENIED_BY_POLICY", "malformed")
        state = self._state_refusal(task_id)
        if state in CANCEL_CAUSES:
            return refuse("CANCELLED", state)
        offer = self._offers.get(params["callId"])
        if offer is None:
            return refuse("DENIED_BY_POLICY", "missing")
        if state == "gate_state_unavailable":
            return refuse("DENIED_BY_POLICY", state)
        if state:                                                    # locked / mute: grantable later
            return refuse("APPROVAL_REQUIRED", state)
        o_task, o_tool, o_action = offer
        if o_task != task_id:
            return refuse("APPROVAL_REQUIRED", "task_mismatch")
        if o_tool != tool_id:
            return refuse("APPROVAL_REQUIRED", "tool_mismatch")
        ap = next((a for a in self._approvals if a.action_id == o_action and a.task_id == task_id), None)
        if ap is None or ap.state == "revoked":
            return refuse("APPROVAL_REQUIRED", "revoked")
        if ap.state == "executed":
            return refuse("APPROVAL_REQUIRED", "reused")
        if self.clock() > ap.expires_at:
            return refuse("APPROVAL_REQUIRED", "expired")
        if params["actionId"] != ap.action_id:
            return refuse("APPROVAL_REQUIRED", "wrong_action")
        tok = self._mint(ap, reason="remint")                       # revokes an earlier unused token: superseded
        return {"ok": True, "data": {"token": tok, "expiresAt": repr(self._grants[tok.split(".")[1]].expires_at)}}

    # -- revocation (E08 6) ---------------------------------------------------------------------------------
    def _revoke(self, pred, reason: str) -> None:
        for g in self._grants.values():
            if pred(g):
                g.revoked = g.revoked or reason

    def revoke_all(self, reason: str) -> None:       # panic_stop, mute, quit, task_cancel, locked, app_server_restart
        self._revoke(lambda g: True, reason)

    def end_turn(self, task_id: str) -> None:
        """setActiveTurn(null): turn end or interrupt. Tokens die; the approval record stays re-mintable."""
        self._revoke(lambda g: g.task_id == task_id, "turn_end")
        self._offers = {k: v for k, v in self._offers.items() if v[0] != task_id}   # offers are per live turn

    def stop(self, task_id: str, reason: str = "task_cancel") -> None:
        self.stop_requested.add(task_id)
        self._revoke(lambda g: g.task_id == task_id, reason)
        for a in self._approvals:
            if a.task_id == task_id and a.state == "approved":
                a.state = "revoked"

    def end_task(self, task_id: str) -> None:
        self._revoke(lambda g: g.task_id == task_id, "end_task")
        for a in self._approvals:
            if a.task_id == task_id and a.state == "approved":
                a.state = "revoked"

    # -- consume ---------------------------------------------------------------------------------------------
    def consume(self, token: str | None, action: str, task_id: str, tool_id: str) -> str:
        """Verdict. ok | missing | malformed | reused | unknown_token | expired | revoked | revoked_cancel
        (task_cancel / panic_stop / quit) | task_mismatch | tool_mismatch | wrong_action | locked | mute."""
        self.consumed.append(action)
        self._cause = None
        verdict = self._consume(token, action, task_id, tool_id)
        rec = {"kind": "tool_token.consumed" if verdict == "ok" else "tool_token.rejected",
               "actionId": action if isinstance(action, str) else None, "taskId": task_id, "toolId": tool_id,
               "outcome": "postcondition_unknown" if verdict == "ok" else "denied"}   # R2: at acceptance
        if verdict != "ok":
            rec["reason"] = REVOCATION_AUDIT_REASON[self._cause] if self._cause else \
                ("revoked" if verdict == "revoked_cancel" else verdict)
        self._audit(rec)
        return verdict

    def _consume(self, token, action, task_id, tool_id) -> str:
        if not token:
            return "missing"
        if not isinstance(token, str):
            return "malformed"
        parts = token.split(".")
        if len(parts) != 3 or parts[0] != "k8t1":
            return "unknown_token"
        token_id, mac = parts[1], parts[2]
        if token_id in self._used:
            return "reused"
        g = self._grants.pop(token_id, None)
        if g is None or not hmac.compare_digest(g.mac, mac):
            return "unknown_token"
        self._used.add(token_id)                      # burnt before answering, also on mismatch
        if g.revoked:
            self._cause = g.revoked
            return "revoked_cancel" if g.revoked in CANCEL_CAUSES else "revoked"
        if self.clock() > g.expires_at:
            return "expired"
        if g.task_id != task_id:
            return "task_mismatch"
        if g.tool_id != tool_id:
            return "tool_mismatch"
        if g.action_id != action:
            return "wrong_action"
        state = self._state_refusal(task_id)          # consume-time state (E08 2)
        if state:
            if state in CANCEL_CAUSES:
                self._cause = state
                return "revoked_cancel"
            return state
        if g.approval is not None:
            if g.approval.state != "approved":
                return "revoked"
            g.approval.state = "executed"             # X4: can never mint again
        return "ok"

    def consume_tool_token(self, params: dict) -> dict:
        """§4.5 consumeToolToken{v, callId, token, actionId, taskId, toolId} -> exact reply shape."""
        self.requests.append({"method": "consumeToolToken", **{k: v for k, v in params.items() if k != "token"},
                              "token": "<present>" if params.get("token") else None})
        verdict = self.consume(params.get("token"), params.get("actionId"), params.get("taskId"),
                               params.get("toolId"))
        reply = _CONSUMED if verdict == "ok" else {
            "ok": False, "error": {"code": "CANCELLED" if verdict == "revoked_cancel" else "DENIED_BY_POLICY",
                                   "message": verdict, "retryable": False}}
        if verdict == "ok":
            self._accepted[params.get("callId")] = self.audit[-1]
        if self.silent:
            self.late_replies.append(reply)           # K8 answered, but after the host's 2 s timeout
            raise ChannelTimeout("consumeToolToken")
        if self.reply_override is not None:
            return self.reply_override
        return dict(reply)

    def tool_call_finished(self, note: dict) -> None:
        """R2: a second tool_token.consumed record only on an explicit toolCallFinished for that callId."""
        first = self._accepted.pop(note.get("callId"), None)
        if first is None:
            return
        if note.get("phase") in ("not_started", "before_send") and note.get("sideEffect") == "none":
            outcome = "consumed_not_dispatched"
        elif note.get("phase") in ("after_send", "completed"):
            outcome = "consumed"
        else:
            return
        self._audit({**{k: first.get(k) for k in ("kind", "actionId", "taskId", "toolId")}, "outcome": outcome})

    def ipc_disconnect(self) -> None:
        """No report before disconnect: the outcome stays postcondition_unknown + reason ipc_disconnect."""
        for rec in self._accepted.values():
            rec["reason"] = "ipc_disconnect"
        self._accepted.clear()
        self.revoke_all("ipc_disconnect")

    def check_policy(self, params: dict, *, task_id: str, scopes=frozenset({"files.navigate"})) -> dict:
        """§4.5c checkPolicy{v, callId, toolId, category:'navigate'}: P24 conditions re-run right before send."""
        self.requests.append({"method": "checkPolicy", **params})
        from dottie_tools.reference.catalog import CATALOG, category_of
        reason = None
        entry = CATALOG.get(params.get("toolId")) if isinstance(params.get("toolId"), str) else None
        if category_of(params.get("toolId")) != "navigate":
            reason = "not_navigate_member"
        elif entry["scope"] not in scopes:                    # scope from the pinned entry (E01 1z)
            self._audit({"kind": "policy.denied", "toolId": params.get("toolId"), "reason": "scope"})
            return {"ok": False, "error": {"code": "PERMISSION_REQUIRED", "message": "scope", "retryable": False},
                    "sideEffect": "none"}
        else:
            reason = self._state_refusal(task_id)
        if reason:
            self._audit({"kind": "policy.denied", "toolId": params.get("toolId"),
                         "decision": "denied_by_policy", "reason": reason})
            return {"ok": False, "error": {"code": "DENIED_BY_POLICY", "message": reason, "retryable": False},
                    "sideEffect": "none"}
        return {"ok": True, "data": {"allowed": True}}


class FakeCoordinator:
    """In-call approval round-trip (tool-host-control §4.4). ``answer`` scripts what the user/session does."""

    def __init__(self, k8: FakeK8, clock=lambda: 0.0, pinned: dict | None = None) -> None:
        self.k8, self.clock = k8, clock
        self.pinned = pinned            # X5: category/risk must equal the pinned catalog (None = not checked)
        self.answer = "click_approve"   # see the table below; "scripted" returns approved + ``script_token``
        self.script_token: str | None = None
        self.requests: list[dict] = []
        self.desktop_message = lambda aid: {"actionId": aid, "approved": False, "timestamp": 0.0}

    def request_approval(self, req: dict) -> ApprovalResolution:
        self.requests.append(req)
        if self.pinned is not None:
            e = self.pinned.get(req["binding"]["method"]) if isinstance(self.pinned, dict) else None
            pv = req.get("preview", {})
            if not isinstance(e, dict) or e.get("category") != pv.get("category") or \
                    ("risk" in e and e["risk"] != pv.get("risk")):
                return ApprovalResolution("denied_by_policy", "catalog_mismatch")    # E08 R4, C-23
        a = self.answer
        if a == "silent":
            raise ChannelTimeout("requestApproval: no answer within expiry + 5 s")
        if a == "approved_without_token":
            return ApprovalResolution("approved", None, None)
        if a == "scripted":
            return ApprovalResolution("approved", None, self.script_token)
        if a in ("desktop_display_unavailable", "desktop_approve", "desktop_raw"):   # desktop ApprovalResolved
            b = req["binding"]
            ids = {"threadId": b["threadId"], "turnId": b["turnId"], "itemId": b["itemId"],
                   "requestId": b["requestId"]}
            if a == "desktop_raw":                         # ``desktop_message(actionId)`` builds the raw payload
                return self.k8.resolve_message(self.desktop_message(req["actionId"]), b["taskId"], b["method"],
                                               ids, self.clock() + APPROVAL_TTL_S,
                                               expected_action_id=req["actionId"])
            if a == "desktop_approve":
                return self.k8.resolve(req["actionId"], b["taskId"], b["method"], ids,
                                       self.clock() + APPROVAL_TTL_S, approved=True)
            return self.k8.resolve(req["actionId"], b["taskId"], b["method"], ids, self.clock() + APPROVAL_TTL_S,
                                   approved=False, reason="display_unavailable")
        if a == "click_approve":
            b = req["binding"]
            exp = self.clock() + APPROVAL_TTL_S
            ids = {"threadId": b["threadId"], "turnId": b["turnId"], "itemId": b["itemId"],
                   "requestId": b["requestId"]}
            return ApprovalResolution("approved", None,
                                      self.k8.approve(req["actionId"], b["taskId"], b["method"], ids, exp))
        return {
            "click_deny": ApprovalResolution("declined", "user_declined"),
            "tray_yes": ApprovalResolution("denied_by_policy", "channel_not_allowed"),
            "voice_yes": ApprovalResolution("denied_by_policy", "channel_not_allowed"),
            "timeout": ApprovalResolution("expired", "timeout"),
            "task_cancel": ApprovalResolution("revoked", "task_cancel"),      # CONTRACTS §3.2 row "task cancel"
            "turn_ended": ApprovalResolution("cancelled", "turn_ended"),
            "mute": ApprovalResolution("revoked", "mute"),
            "locked": ApprovalResolution("revoked", "locked"),
            "panic_stop": ApprovalResolution("revoked", "panic_stop"),
            "quit": ApprovalResolution("revoked", "quit"),
            "ipc_disconnect": ApprovalResolution("cancelled", "ipc_disconnect"),
            "denied": ApprovalResolution("denied_by_policy", "wrong_action"),
            "unknown_none": ApprovalResolution("none", None),          # not a §3.2 value
            "unknown_typo": ApprovalResolution("Approved", None),      # not a §3.2 value (case matters)
        }[a]
