"""Generic runner behaviour with a minimal workflow (no Windows involved)."""

from typing import ClassVar

from dottie_verifier.model import Check, CheckStatus, Outcome
from dottie_verifier.recovery import RetryPolicy
from dottie_verifier.workflow import run_verified, safe_tool_call


class Counter:
    name = "demo"
    action = "demo_tool"
    stop_on: ClassVar[dict] = {}

    def __init__(self, passes_after=0, recover_steps=True):
        self.verifies = 0
        self.passes_after = passes_after
        self.recover_steps = recover_steps

    def snapshot(self):
        return {}

    def act(self, ctx):
        return {"success": True}

    def verify(self, ctx):
        self.verifies += 1
        ok = self.verifies > self.passes_after
        return [Check("D-1", "demo", CheckStatus.PASS if ok else CheckStatus.FAIL)]

    def recoverable(self, check, ctx):
        return True

    def recover(self, checks, ctx, attempt):
        return ["poke"] if self.recover_steps else []

    def ask_question(self, check, ctx):
        return "?"


def test_settle_timeout_bounds_polling(clock):
    wf = Counter(passes_after=10_000)
    policy = RetryPolicy(max_attempts=2, settle_timeout=1.0, poll_interval=0.25, jitter=0)
    report = run_verified(wf, policy, sleep=clock.sleep, clock=clock)
    assert report.outcome is Outcome.FAILED
    assert len(report.attempts) == 2
    assert wf.verifies == 10           # 5 polls per round (0, .25, .5, .75, 1.0)


def test_no_recovery_steps_ends_honestly(clock):
    wf = Counter(passes_after=10_000, recover_steps=False)
    report = run_verified(wf, RetryPolicy(settle_timeout=0, jitter=0), sleep=clock.sleep,
                          clock=clock)
    assert report.decision == "done" and report.decision_reason == "no applicable recovery step"


def test_total_deadline(clock):
    wf = Counter(passes_after=10_000)
    policy = RetryPolicy(max_attempts=50, settle_timeout=2.0, total_deadline=5.0, jitter=0)
    report = run_verified(wf, policy, sleep=clock.sleep, clock=clock)
    assert "deadline" in report.decision_reason and clock.t < 10


def test_safe_tool_call_captures_errors():
    assert safe_tool_call(lambda n, a: 1 / 0, "x", {})["exception"] == "ZeroDivisionError"
    assert safe_tool_call(lambda n, a: "ok", "x", {})["success"] is False
