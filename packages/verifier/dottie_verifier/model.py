"""Outcome model shared by every verifier.

Classification rules (docs/verifier-design.md section 5):

* FAILED: a critical check has positive evidence of failure.
* UNVERIFIED: no critical check failed, but one or more could not be observed.
* PARTIALLY_VERIFIED: every critical check passed, but a non-critical check failed or was unknown.
* VERIFIED: every check passed.

Only VERIFIED counts toward the >=95% verified-completion target.

``to_dict`` is the full local evidence artifact (may contain paths and titles; never sent over
IPC). Contract shapes (CONTRACTS v2 §2.3/§3/§5) are produced by ``dottie_verifier.contract``,
which redacts. ``to_dict`` passes evidence through ``wire_safe`` so window handles, pids and
FILETIMEs are written as decimal strings (CONTRACTS §3.3), never as JSON numbers.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


def iso_local(epoch: float) -> str:
    """ISO-8601 with UTC offset, as the CONTRACTS v2 §3 envelope ``timestamp`` requires."""
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="milliseconds")


class CheckStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"


class Outcome(str, Enum):
    VERIFIED = "verified"
    PARTIALLY_VERIFIED = "partially_verified"
    UNVERIFIED = "unverified"
    FAILED = "failed"


@dataclass
class Check:
    """One postcondition with its observed evidence."""

    id: str
    description: str
    status: CheckStatus
    critical: bool = True
    evidence: dict[str, Any] = field(default_factory=dict)
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "description": self.description,
            "status": self.status.value,
            "critical": self.critical,
            "source": self.source,
            "evidence": wire_safe(self.evidence),
        }


MAX_SAFE_INT = 2**53 - 1
_ID_KEYS = frozenset({"hwnd", "pid", "processStartTime", "process_start_time", "foreground"})


def _is_id_key(key: object) -> bool:
    return isinstance(key, str) and (key in _ID_KEYS or key.endswith(("_hwnd", "_hwnds", "hwnds")))


def wire_safe(value: Any, key: object = None) -> Any:
    """Serialized form of local evidence: ints under window-handle / pid / start-time keys, and
    any int beyond 2^53, become canonical decimal strings. Other values are unchanged."""
    if isinstance(value, dict):
        return {k: wire_safe(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        items = sorted(value) if isinstance(value, (set, frozenset)) else value
        return [wire_safe(v, key) for v in items]
    if type(value) is int and (_is_id_key(key) or abs(value) > MAX_SAFE_INT):
        return str(value)
    return value


def classify(checks: list[Check]) -> Outcome:
    if not checks:
        return Outcome.UNVERIFIED
    critical = [c for c in checks if c.critical]
    if any(c.status is CheckStatus.FAIL for c in critical):
        return Outcome.FAILED
    if any(c.status is CheckStatus.UNKNOWN for c in critical):
        return Outcome.UNVERIFIED
    if all(c.status is CheckStatus.PASS for c in checks):
        return Outcome.VERIFIED
    return Outcome.PARTIALLY_VERIFIED


@dataclass
class Attempt:
    number: int
    action: str
    tool_result: dict[str, Any] | None
    outcome: Outcome
    recovery: list[str] = field(default_factory=list)
    started_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "number": self.number,
            "action": self.action,
            "outcome": self.outcome.value,
            "recovery": self.recovery,
            "tool_result": wire_safe(self.tool_result),
            "started_at": self.started_at,
        }


@dataclass
class VerificationReport:
    workflow: str
    checks: list[Check]
    attempts: list[Attempt] = field(default_factory=list)
    tool_claimed_success: bool | None = None
    decision: str = ""
    decision_reason: str = ""
    question: str = ""
    # Safe ask-the-user candidates: [{"id": opaque id, "label": safe label}] (CONTRACTS v2 §5).
    candidates: list[dict[str, str]] = field(default_factory=list)
    tool_invoked: bool = True
    # The run stopped because the task was cancelled (decision "stop"; contract error.code
    # CANCELLED).
    cancelled: bool = False
    # False for pure observation workflows: they never change the desktop (sideEffect "none").
    mutating: bool = True
    notes: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)

    @property
    def outcome(self) -> Outcome:
        return classify(self.checks)

    @property
    def verified(self) -> bool:
        return self.outcome is Outcome.VERIFIED

    @property
    def false_success(self) -> bool:
        """The tool reported success but the verifier did not confirm it."""
        return bool(self.tool_claimed_success) and self.outcome is not Outcome.VERIFIED

    def failing(self) -> list[Check]:
        return [c for c in self.checks if c.status is not CheckStatus.PASS]

    def check(self, check_id: str) -> Check | None:
        return next((c for c in self.checks if c.id == check_id), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflow": self.workflow,
            "outcome": self.outcome.value,
            "verified": self.verified,
            "tool_claimed_success": self.tool_claimed_success,
            "false_success": self.false_success,
            "decision": self.decision,
            "decision_reason": self.decision_reason,
            "question": self.question,
            "candidates": wire_safe(self.candidates),
            "tool_invoked": self.tool_invoked,
            "cancelled": self.cancelled,
            "mutating": self.mutating,
            "checks": [c.to_dict() for c in self.checks],
            "attempts": [a.to_dict() for a in self.attempts],
            "notes": self.notes,
            "created_at": self.created_at,
            "timestamp": iso_local(self.created_at),
        }
