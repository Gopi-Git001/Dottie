import random

import pytest

from dottie_verifier.contract import to_verification_result
from dottie_verifier.model import Check, CheckStatus, Outcome, VerificationReport, classify
from dottie_verifier.policy import Decision, decide
from dottie_verifier.recovery import RetryPolicy

P, F, U = CheckStatus.PASS, CheckStatus.FAIL, CheckStatus.UNKNOWN


def c(cid, status, critical=True, **ev):
    return Check(cid, cid, status, critical, ev)


@pytest.mark.parametrize("checks,outcome", [
    ([c("a", P), c("b", P, False)], Outcome.VERIFIED),
    ([c("a", P), c("b", F, False)], Outcome.PARTIALLY_VERIFIED),
    ([c("a", P), c("b", U, False)], Outcome.PARTIALLY_VERIFIED),
    ([c("a", U), c("b", P)], Outcome.UNVERIFIED),
    ([c("a", U), c("b", F)], Outcome.FAILED),
    ([c("a", F, False), c("b", U)], Outcome.UNVERIFIED),
    ([], Outcome.UNVERIFIED),
])
def test_classification_table(checks, outcome):
    assert classify(checks) is outcome


def test_report_false_success_and_event():
    r = VerificationReport("w", [c("a", F)], tool_claimed_success=True)
    assert r.false_success
    ev = to_verification_result(r)
    assert ev["verified"] is False and ev["error"]["code"] == "POSTCONDITION_FAILED"
    assert "a=fail" in ev["error"]["message"]
    assert ev["observedState"]["outcome"] == "failed"


def _decide(checks, attempt=1, stop_on=None, recoverable=lambda ch: True, elapsed=0.0):
    return decide(checks, attempt, 3, elapsed, 10.0, stop_on or {}, recoverable,
                  lambda ch: f"which {ch.id}?")


def test_decision_order():
    assert _decide([c("a", P)])[0] is Decision.DONE
    assert _decide([c("a", F)], stop_on={"a": {F}})[0] is Decision.STOP
    assert _decide([c("a", U)], stop_on={"a": {F}})[0] is Decision.RETRY
    d, _r, q = _decide([c("a", U, ambiguous=True)])
    assert d is Decision.ASK_USER and q == "which a?"
    # stop beats ask: positive evidence of a wrong target is never "clarified" away
    assert _decide([c("a", F), c("b", U, ambiguous=True)], stop_on={"a": {F}})[0] is Decision.STOP
    assert _decide([c("a", F)], attempt=3)[0] is Decision.DONE
    assert _decide([c("a", F)], elapsed=11)[0] is Decision.DONE
    assert _decide([c("a", F)], recoverable=lambda ch: False)[0] is Decision.DONE


def test_backoff_and_jitter_bounds():
    p = RetryPolicy(base_delay=0.25, max_delay=1.0, jitter=0)
    assert [p.delay(i) for i in (1, 2, 3, 4)] == [0.25, 0.5, 1.0, 1.0]
    j = RetryPolicy(jitter=0.2)
    rng = random.Random(7)
    for attempt in range(1, 5):
        base = min(j.max_delay, j.base_delay * 2 ** (attempt - 1))
        assert base * 0.8 <= j.delay(attempt, rng) <= base * 1.2
