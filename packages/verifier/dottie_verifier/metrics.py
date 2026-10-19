"""Task-suite measurement for the >=95% *verified* completion target (spec section 14).

Only Outcome.VERIFIED counts as a completion. Partial, unverified, failed and asked-user runs
all count against the rate. ``false_success`` (tool said OK, verifier disagreed) is tracked
separately because it is a release-blocker class ("silent errors misrepresented as success")."""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field


@dataclass(frozen=True)
class TaskRun:
    task_id: str
    run: int
    outcome: str                      # Outcome value
    tool_claimed_success: bool | None = None
    decision: str = ""
    duration_s: float = 0.0
    environment: dict = field(default_factory=dict, hash=False, compare=False)


def wilson_interval(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def summarize(runs: Iterable[TaskRun], target: float = 0.95,
              min_runs_per_task: int = 20) -> dict:
    runs = list(runs)
    n = len(runs)
    verified = sum(r.outcome == "verified" for r in runs)
    false_success = sum(bool(r.tool_claimed_success) and r.outcome != "verified" for r in runs)
    low, high = wilson_interval(verified, n)
    per_task: dict[str, dict] = {}
    grouped: dict[str, list[TaskRun]] = defaultdict(list)
    for r in runs:
        grouped[r.task_id].append(r)
    for task, items in sorted(grouped.items()):
        k = sum(r.outcome == "verified" for r in items)
        tl, th = wilson_interval(k, len(items))
        per_task[task] = {
            "runs": len(items), "verified": k, "rate": k / len(items),
            "wilson95": [round(tl, 4), round(th, 4)],
            "outcomes": dict(Counter(r.outcome for r in items)),
            "insufficient_sample": len(items) < min_runs_per_task,
        }
    rate = verified / n if n else 0.0
    return {
        "runs": n,
        "verified": verified,
        "verified_rate": rate,
        "wilson95": [round(low, 4), round(high, 4)],
        "outcomes": dict(Counter(r.outcome for r in runs)),
        "false_success": false_success,
        "false_success_rate": false_success / n if n else 0.0,
        "target": target,
        "meets_target_point_estimate": n > 0 and rate >= target,
        "meets_target_with_95pct_confidence": n > 0 and low >= target,
        "weakest_task": min(per_task, key=lambda t: per_task[t]["rate"]) if per_task else None,
        "tasks_below_target": sorted(t for t, v in per_task.items() if v["rate"] < target),
        "tasks_with_insufficient_sample": sorted(
            t for t, v in per_task.items() if v["insufficient_sample"]),
        "per_task": per_task,
    }


def load_jsonl(path: str) -> list[TaskRun]:
    """One JSON object per line: {task_id, run, report: VerificationReport.to_dict(), ...}."""
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            rep = row.get("report", {})
            out.append(TaskRun(row["task_id"], int(row.get("run", 0)),
                               rep.get("outcome", row.get("outcome", "unverified")),
                               rep.get("tool_claimed_success"), rep.get("decision", ""),
                               float(row.get("duration_s", 0.0)), row.get("environment", {})))
    return out
