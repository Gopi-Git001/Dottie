"""Generic verified-action runner that wraps an E04 tool call.

act -> poll postconditions until they settle -> decide -> (recover -> re-verify)* -> report.
The tool result is evidence. An exception or ``success: False`` does not skip verification,
because the action may still have happened.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from dottie_verifier.model import (
    Attempt,
    Check,
    CheckStatus,
    Outcome,
    VerificationReport,
    classify,
)
from dottie_verifier.policy import Decision, StopRules, decide, is_ambiguous, triggers_stop
from dottie_verifier.recovery import RetryPolicy

ToolRunner = Callable[[str, dict], dict]
DENIED_PREFIX = "denied_by_policy:"   # same shape as Bot tools.registry.execute_tool


@dataclass
class ActionContext:
    before: dict[str, Any]
    started_at: float
    tool_result: dict[str, Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class Workflow(Protocol):
    name: str
    action: str
    stop_on: StopRules

    def snapshot(self) -> dict[str, Any]: ...
    def act(self, ctx: ActionContext) -> dict[str, Any]: ...
    def verify(self, ctx: ActionContext) -> list[Check]: ...
    def recoverable(self, check: Check, ctx: ActionContext) -> bool: ...
    def recover(self, checks: list[Check], ctx: ActionContext, attempt: int) -> list[str]: ...
    def ask_question(self, check: Check, ctx: ActionContext) -> str: ...
    # Optional: ``ask_candidates(check, ctx) -> list[{"id", "label"}]`` with opaque ids and safe
    # labels; ``precheck(ctx) -> str | None`` returns a reason if the target is gone before act;
    # ``actionable(ctx) -> tuple[code, reason] | None`` refuses a live but non-actionable target.


def precondition_failed_report(workflow: str, code: str, reason: str,
                               evidence: dict[str, Any] | None = None,
                               mutating: bool = True) -> VerificationReport:
    """The target is not actionable right before the action (e.g. DPI or cloaked state
    unreadable): PRECONDITION_FAILED, ``sideEffect: none``, nothing sent (CONTRACTS §5)."""
    check = Check("PRE-02", "Target is actionable right before the action is sent",
                  CheckStatus.FAIL, evidence={"precondition_failed": True, "code": code,
                                              "reason": reason, **(evidence or {})})
    return VerificationReport(workflow=workflow, checks=[check], decision=Decision.STOP.value,
                              decision_reason=f"{reason}; nothing was sent", tool_invoked=False,
                              mutating=mutating, notes=["tool not invoked"])


def safe_tool_call(runner: ToolRunner, name: str, args: dict) -> dict:
    try:
        out = runner(name, args)
    except Exception as exc:  # noqa: BLE001 - recorded, then verified anyway
        return {"success": False, "error": str(exc), "exception": type(exc).__name__}
    if not isinstance(out, dict):
        return {"success": False, "error": f"tool returned {type(out).__name__}", "raw": repr(out)}
    return out


def run_verified(
    wf: Workflow,
    retry: RetryPolicy | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    wall_clock: Callable[[], float] = time.time,
    rng: random.Random | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> VerificationReport:
    """``cancelled`` is polled before dispatch, between observations and before any recovery
    (ADR-0010).

    Cancellation is not an outcome and not a decision (CONTRACTS v2 §5: TaskCancelled covers
    it). On cancel the runner stops acting and reports the verifier outcome it last observed
    with ``decision="stop"`` and ``cancelled=True``; the contract layer adds
    ``error.code=CANCELLED``. If the goal was already verified when the cancel arrived, the
    report stays ``done``/verified, so the coordinator can say ``completed_before_stop``."""
    is_cancelled = cancelled or (lambda: False)
    mutating = getattr(wf, "mutating", True)
    was_cancelled = False
    retry = retry or RetryPolicy()
    t0 = clock()
    ctx = ActionContext(before=wf.snapshot(), started_at=wall_clock())
    if is_cancelled():
        return VerificationReport(workflow=wf.name, checks=[], decision=Decision.STOP.value,
                                  decision_reason="cancelled before the tool was invoked",
                                  tool_invoked=False, cancelled=True, mutating=mutating,
                                  notes=["tool not invoked"])
    # Last look right before the action is sent (CONTRACTS v2 §5): a target that is already gone
    # is PRECONDITION_FAILED with nothing sent.
    gone = wf.precheck(ctx) if hasattr(wf, "precheck") else None
    if gone:
        check = Check("PRE-01", "Target window still exists right before the action is sent",
                      CheckStatus.FAIL, evidence={"target_gone_before_dispatch": True,
                                                  "reason": gone})
        return VerificationReport(workflow=wf.name, checks=[check], decision=Decision.STOP.value,
                                  decision_reason=f"{gone}; nothing was sent",
                                  tool_invoked=False, mutating=mutating,
                                  notes=["tool not invoked"])
    blocked = wf.actionable(ctx) if hasattr(wf, "actionable") else None
    if blocked:
        return precondition_failed_report(wf.name, blocked[0], blocked[1], mutating=mutating)
    ctx.tool_result = wf.act(ctx)
    tool_claim = bool(ctx.tool_result.get("success")) if ctx.tool_result is not None else None

    attempts: list[Attempt] = []
    attempt = 0
    checks: list[Check] = []
    while True:
        attempt += 1
        started = clock() - t0
        checks = _poll(wf, ctx, retry, sleep, clock, is_cancelled)
        if is_cancelled() and classify(checks) is not Outcome.VERIFIED:
            decision, reason, question = Decision.STOP, "cancelled during verification", ""
            was_cancelled = True
        else:
            decision, reason, question = decide(
                checks, attempt, retry.max_attempts, clock() - t0, retry.total_deadline,
                wf.stop_on, lambda c: wf.recoverable(c, ctx), lambda c: wf.ask_question(c, ctx))
        record = Attempt(attempt, wf.action, ctx.tool_result, classify(checks), [], started)
        attempts.append(record)
        if decision is not Decision.RETRY:
            break
        sleep(retry.delay(attempt, rng))
        if is_cancelled():
            decision, reason, was_cancelled = Decision.STOP, "cancelled before recovery", True
            break
        steps = wf.recover(checks, ctx, attempt)
        record.recovery = steps
        if not steps:
            decision, reason = Decision.DONE, "no applicable recovery step"
            break
        if all(st.startswith(DENIED_PREFIX) for st in steps):
            decision, reason = Decision.DONE, "recovery denied by policy (ADR-0009 fail-closed)"
            break

    candidates: list[dict[str, str]] = []
    if decision is Decision.ASK_USER and hasattr(wf, "ask_candidates"):
        ambiguous = next((c for c in checks if is_ambiguous(c)), None)
        candidates = wf.ask_candidates(ambiguous, ctx) if ambiguous else []
    return VerificationReport(
        workflow=wf.name, checks=checks, attempts=attempts, tool_claimed_success=tool_claim,
        decision=decision.value, decision_reason=reason, question=question, candidates=candidates,
        cancelled=was_cancelled, mutating=mutating)


def _poll(wf: Workflow, ctx: ActionContext, retry: RetryPolicy,
          sleep: Callable[[float], None], clock: Callable[[], float],
          is_cancelled: Callable[[], bool] = lambda: False) -> list[Check]:
    start = clock()
    while True:
        checks = wf.verify(ctx)
        if classify(checks) is Outcome.VERIFIED or is_cancelled():
            return checks
        failing = [c for c in checks if c.status.value != "pass"]
        if any(is_ambiguous(c) or triggers_stop(c, wf.stop_on) for c in failing):
            return checks
        if clock() - start >= retry.settle_timeout:
            return checks
        sleep(retry.poll_interval)
