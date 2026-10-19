"""Bounded retry with exponential backoff and jitter. Time and randomness are injectable."""

from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3          # verification rounds, including the first
    base_delay: float = 0.25       # seconds before the first recovery
    max_delay: float = 2.0
    jitter: float = 0.2            # +/- fraction of the delay
    settle_timeout: float = 3.0    # how long one round polls for the postconditions to settle
    poll_interval: float = 0.2
    total_deadline: float = 15.0   # hard ceiling for the whole verified action

    def delay(self, attempt: int, rng: random.Random | None = None) -> float:
        """Backoff before recovery after ``attempt`` (1-based): 0.25, 0.5, 1.0 ... capped."""
        raw = min(self.max_delay, self.base_delay * (2 ** max(0, attempt - 1)))
        if not self.jitter:
            return raw
        r = (rng or random).uniform(-self.jitter, self.jitter)
        return max(0.0, raw * (1 + r))
