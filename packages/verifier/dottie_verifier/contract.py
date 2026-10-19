"""Shapes the verifier returns, per arch/CONTRACTS.md **v2** (ADR-0012; E01 rulings of 2026-10-19).

The verifier returns data; it never emits events.

* §2.3 ``VerificationResult`` (what ``VerifierPort.verify`` returns):
  ``{outcome, verified, observedState, error?, evidenceRef?}``. ``outcome`` is the verifier enum
  ``verified | partially_verified | unverified | failed``.
* §5 MCP tool result produced by the tool host around a verified tool:
  ``structuredContent = {verified, observedState, sideEffect, error?, evidenceRef?}``,
  ``isError = !verified``. There is no ``success`` key.
* The ``ToolResult`` event (envelope, ``eventId``, ``correlationId``,
                            ``causationId``) is built by the
  coordinator's tool router, not here. ``tests/router_fixture.py`` has a test-only stand-in.
* ``task_outcome`` / ``ledger_value`` are reference helpers. The coordinator owns the mapping.

``ObservedState.decision`` is ``done | retry | ask_user | stop``. Cancellation is ``stop`` plus
``error.code = CANCELLED``. All enum values are snake_case.
"""

from __future__ import annotations

import re
from typing import Any

from dottie_verifier.model import CheckStatus, Outcome, VerificationReport

# CONTRACTS v2 §5 / ADR-0012 §8 error codes, verbatim.
DENIED_BY_POLICY = "DENIED_BY_POLICY"
PERMISSION_REQUIRED = "PERMISSION_REQUIRED"
APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
AMBIGUOUS = "AMBIGUOUS"
NOT_FOUND = "NOT_FOUND"
TIMEOUT = "TIMEOUT"
PRECONDITION_FAILED = "PRECONDITION_FAILED"
POSTCONDITION_FAILED = "POSTCONDITION_FAILED"
POSTCONDITION_UNKNOWN = "POSTCONDITION_UNKNOWN"
CANCELLED = "CANCELLED"
# Schema-invalid or malformed arguments, incl. a malformed targetId (E01 2026-10-19).
INVALID_ARGUMENT = "INVALID_ARGUMENT"
USER_DECLINED = "USER_DECLINED"   # the user declined an approval; never retried (E01 2026-10-19)
INTERNAL = "INTERNAL"
ERROR_CODES = (DENIED_BY_POLICY, PERMISSION_REQUIRED, APPROVAL_REQUIRED, AMBIGUOUS, NOT_FOUND,
               TIMEOUT, PRECONDITION_FAILED, POSTCONDITION_FAILED, POSTCONDITION_UNKNOWN, CANCELLED,
               INVALID_ARGUMENT, USER_DECLINED, INTERNAL)
# Refused before acting. None of these is ever retried and the tool is never re-invoked after them.
POLICY_CODES = (DENIED_BY_POLICY, PERMISSION_REQUIRED, APPROVAL_REQUIRED, USER_DECLINED)
DECISIONS = ("done", "retry", "ask_user", "stop")   # CONTRACTS v2 §5 ObservedState.decision
_LEGACY_CODES = {"NEEDS_APPROVAL": APPROVAL_REQUIRED}   # CONTRACTS v1 spelling (§3 migration table)

# Strings E04's Bot registry returns today (src/Bot/tools/registry.py:189-200).
# "Action not approved." is the user answering "no" to an approval prompt: USER_DECLINED, not
# DENIED_BY_POLICY (which is reserved for actions that can never be granted).
_BOT_POLICY_ERRORS = {"user approval required.": APPROVAL_REQUIRED,
                      "action not approved.": USER_DECLINED}

# §3 ToolResult.sideEffect. E04's ``attempted`` maps to ``unknown`` (ADR-0012 §8).
SIDE_EFFECT_NONE, SIDE_EFFECT_COMMITTED, SIDE_EFFECT_UNKNOWN = "none", "committed", "unknown"
SIDE_EFFECTS = (SIDE_EFFECT_NONE, SIDE_EFFECT_COMMITTED, SIDE_EFFECT_UNKNOWN)

# §2.3 verifier outcome enum and §3 TaskFinished.outcome enum.
VERIFIER_OUTCOMES = tuple(o.value for o in Outcome)
TASK_OUTCOMES = ("succeeded", "answered", "partial", "unverified", "failed",
                 "failed_after_side_effects",
                 "declined", "blocked_auth")
CHECK_STATUSES = tuple(s.value for s in CheckStatus)
# §5 retryable codes: only when nothing was changed and an identical call could plausibly verify.
_RETRYABLE_CODES = (TIMEOUT, POSTCONDITION_FAILED, POSTCONDITION_UNKNOWN)


def tool_policy_error(tool_result: dict | None) -> str | None:
    """Return the §5 policy code if the wrapped tool was refused before acting."""
    if not tool_result or tool_result.get("success"):
        return None
    err = tool_result.get("error")
    if isinstance(err, dict):
        code = _LEGACY_CODES.get(err.get("code"), err.get("code"))
        return code if code in POLICY_CODES else None
    if isinstance(err, str):
        return _BOT_POLICY_ERRORS.get(err.strip().lower())
    return None


def side_effect(report: VerificationReport) -> str:
    """Conservative: anything not proven unchanged may have happened."""
    if not report.tool_invoked:
        return SIDE_EFFECT_NONE          # cancelled before dispatch, or targetId not found
    if not report.mutating and not any(a.recovery and any(not s.startswith("reobserve")
                                                          for s in a.recovery)
                                       for a in report.attempts):
        return SIDE_EFFECT_NONE          # pure observation: looked, changed nothing
    if report.outcome in (Outcome.VERIFIED, Outcome.PARTIALLY_VERIFIED):
        return SIDE_EFFECT_COMMITTED
    if report.attempts and all(tool_policy_error(a.tool_result) for a in report.attempts) \
            and not any(a.recovery for a in report.attempts):
        return SIDE_EFFECT_NONE          # refused before acting, no recovery ran
    return SIDE_EFFECT_UNKNOWN


def _flag(report: VerificationReport, key: str) -> bool:
    return any(c.evidence.get(key) for c in report.checks)


def error_code(report: VerificationReport) -> str | None:
    if report.outcome is Outcome.VERIFIED:
        return None
    if report.cancelled:
        return CANCELLED
    if _flag(report, "invalid_argument"):
        return INVALID_ARGUMENT
    if _flag(report, "target_id_not_found"):
        return NOT_FOUND
    if _flag(report, "target_gone_before_dispatch"):
        return PRECONDITION_FAILED          # window gone before the action was sent
    if _flag(report, "precondition_failed"):
        return PRECONDITION_FAILED          # target not actionable (fail-closed observation)
    if report.tool_invoked and _flag(report, "target_gone"):
        return POSTCONDITION_UNKNOWN        # window gone after the action was sent
    if any(c.critical and c.status is not CheckStatus.PASS
           and c.evidence.get("enumeration_incomplete") for c in report.checks):
        # §5 names no code for complete:false; E11 choice (flagged to E01): the action's
        # result can't be observed after dispatch, and the target can't be chosen before it.
        return POSTCONDITION_UNKNOWN if report.tool_invoked else PRECONDITION_FAILED
    last = report.attempts[-1].tool_result if report.attempts else None
    policy = tool_policy_error(last)
    if policy:
        return policy
    if report.decision == "ask_user":
        return AMBIGUOUS
    if report.decision == "stop":
        failing = [c for c in report.failing() if c.critical]
        if any(c.evidence.get("expected_path") and c.evidence.get("expected_exists") is False
               for c in failing):
            return NOT_FOUND
        return PRECONDITION_FAILED
    if "deadline" in report.decision_reason:
        return TIMEOUT
    if any(c.status is CheckStatus.FAIL for c in report.checks):
        return POSTCONDITION_FAILED
    return POSTCONDITION_UNKNOWN


def is_retryable(report: VerificationReport, code: str | None) -> bool:
    """§5: ``retryable`` may be true only when ``sideEffect`` is ``none``."""
    return (side_effect(report) == SIDE_EFFECT_NONE and code in _RETRYABLE_CODES
            and report.decision not in ("stop", "ask_user"))


# --- redaction (§5 ObservedState rules, CONTRACTS §4) ---------------------------------------------
_PATH_RE = re.compile(r"(?:\\\\\?\\)?(?:[A-Za-z]:\\|\\\\)[^\s;,'\"]*|/(?:home|Users)/[^\s;,'\"]*")


def redact_text(text: str) -> str:
    """Replace anything path-shaped with ``<path>``. Messages are built from check ids, so this is a
    backstop."""
    return _PATH_RE.sub("<path>", text)


def observed_state(report: VerificationReport) -> dict[str, Any]:
    state: dict[str, Any] = {
        "outcome": report.outcome.value,
        "decision": report.decision,
        "checks": {c.id: c.status.value for c in report.checks},
        "sideEffect": side_effect(report),
    }
    if report.question:
        state["question"] = redact_text(report.question)
    if report.candidates:
        state["candidates"] = [{"id": c["id"],
                                "label": redact_text(c["label"])} for c in report.candidates]
    return state


def tool_error(report: VerificationReport, message: str = "") -> dict[str, Any] | None:
    code = error_code(report)
    if code is None:
        return None
    failing = ", ".join(f"{c.id}={c.status.value}" for c in report.failing()
                        if c.critical or c.status is CheckStatus.FAIL)
    text = message or "; ".join(p for p in (report.decision, failing) if p) or "no checks observed"
    return {"code": code, "message": redact_text(text), "retryable": is_retryable(report, code)}


def _with_optional(out: dict[str, Any], err: dict | None, evidence_ref: str | None) -> dict[str,
        Any]:
    if err is not None:
        out["error"] = err
    if evidence_ref:
        out["evidenceRef"] = evidence_ref
    return out


def to_verification_result(report: VerificationReport, evidence_ref: str | None = None) -> dict[str,
        Any]:
    """§2.3 ``VerificationResult``."""
    out = {"outcome": report.outcome.value, "verified": report.verified,
           "observedState": observed_state(report)}
    return _with_optional(out, tool_error(report), evidence_ref)


def to_structured_content(report: VerificationReport, evidence_ref: str | None = None) -> dict[str,
        Any]:
    """§5 MCP ``structuredContent``."""
    out = {"verified": report.verified, "observedState": observed_state(report),
           "sideEffect": side_effect(report)}
    return _with_optional(out, tool_error(report), evidence_ref)


def to_mcp_tool_result(report: VerificationReport, summary: str,
                       evidence_ref: str | None = None) -> dict[str, Any]:
    """MCP ``CallToolResult``: ``isError = !verified``. ``summary`` must already be safe to show."""
    return {"content": [{"type": "text", "text": redact_text(summary)}],
            "structuredContent": to_structured_content(report, evidence_ref),
            "isError": not report.verified}


def task_outcome(verifier_outcome: str, ledger_side_effects: str) -> str:
    """REFERENCE HELPER ONLY, not called by the verifier. The coordinator owns the mapping to
    ``TaskFinished.outcome`` using its own ledger (CONTRACTS v2 §3.1, ADR-0012 §6, E01 2026-10-19).
    This copy exists so tests pin the documented rule; production code must not use it.
    ``ledger_side_effects`` is ``none | committed | possible``; a ToolResult ``unknown`` counts as
    ``possible``."""
    if verifier_outcome == Outcome.VERIFIED.value:
        return "succeeded"
    if verifier_outcome == Outcome.PARTIALLY_VERIFIED.value:
        return "partial"
    if verifier_outcome == Outcome.UNVERIFIED.value:
        return "unverified"
    if verifier_outcome == Outcome.FAILED.value:
        return "failed" if ledger_side_effects == "none" else "failed_after_side_effects"
    raise ValueError(f"not a verifier outcome: {verifier_outcome!r}")


def ledger_value(side_effect_value: str) -> str:
    """REFERENCE HELPER ONLY (see ``task_outcome``). ToolResult ``sideEffect`` -> coordinator ledger
    ``sideEffects`` (``unknown`` -> ``possible``)."""
    return {"none": "none", "committed": "committed", "unknown": "possible"}[side_effect_value]
