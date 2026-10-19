"""Stop-or-ask policy. Under uncertainty the verifier stops or asks; it never guesses a target."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from enum import Enum

from dottie_verifier.model import Check, CheckStatus, Outcome, classify


class Decision(str, Enum):
    DONE = "done"            # stop acting; report the outcome as-is (verified or not)
    RETRY = "retry"          # run a bounded, HWND-targeted recovery step, then re-verify
    ASK_USER = "ask_user"    # several plausible targets or conflicting evidence: ask, don't pick
    STOP = "stop"            # continuing is unsafe (wrong process, missing precondition) or the
                             # task was cancelled (CONTRACTS v2 §5: cancel = stop + error.code
                             # CANCELLED)


StopRules = Mapping[str, "set[CheckStatus]"]


def is_ambiguous(check: Check) -> bool:
    return check.status is not CheckStatus.PASS and bool(check.evidence.get("ambiguous"))


def triggers_stop(check: Check, stop_on: StopRules) -> bool:
    """``stop_on`` maps a check id to the statuses that make further action unsafe.

    e.g. {"EXP-01": {FAIL, UNKNOWN}, "EXP-03": {FAIL}}: an unknown process (no window yet)
    is recoverable, positive evidence of the wrong process is not.

    A critical check left unresolved by an incomplete enumeration always stops (CONTRACTS §5:
    decisions needing the full list fail closed; acting again could hit an unseen window).
    """
    if (check.critical and check.status is not CheckStatus.PASS
            and check.evidence.get("enumeration_incomplete")):
        return True
    return check.status in stop_on.get(check.id, set())


def decide(
    checks: list[Check],
    attempt: int,
    max_attempts: int,
    elapsed: float,
    deadline: float,
    stop_on: StopRules,
    recoverable: Callable[[Check], bool],
    ask_question: Callable[[Check], str] | None = None,
) -> tuple[Decision, str, str]:
    """Return (decision, reason, question)."""
    outcome = classify(checks)
    if outcome is Outcome.VERIFIED:
        return Decision.DONE, "all postconditions observed", ""

    failing = [c for c in checks if c.status is not CheckStatus.PASS]
    for c in failing:
        if triggers_stop(c, stop_on):
            return (Decision.STOP,
                    f"{c.id} {c.status.value}: {c.description}; acting further is unsafe", "")
    for c in failing:
        if is_ambiguous(c):
            question = (ask_question(c) if ask_question
                        else f"I am not sure which target you mean ({c.id}).")
            return Decision.ASK_USER, f"{c.id} ambiguous: refusing to guess", question

    if attempt >= max_attempts:
        return Decision.DONE, f"retry budget exhausted after {attempt} attempts", ""
    if elapsed >= deadline:
        return Decision.DONE, f"deadline {deadline:.1f}s exceeded", ""

    fixable = [c for c in failing if recoverable(c)]
    if fixable:
        return Decision.RETRY, "recoverable: " + ", ".join(c.id for c in fixable), ""
    return Decision.DONE, "no safe recovery for: " + ", ".join(c.id for c in failing), ""
