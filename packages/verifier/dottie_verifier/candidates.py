"""Opaque ask-the-user candidate ids and ``targetId`` resolution (CONTRACTS v2 §5, E01 2026-10-19).

A tool that returned ``candidates`` accepts an optional ``targetId`` on the follow-up call.
The id must have been issued earlier **in the same task**. Unknown, stale or cross-task ids
resolve to nothing, and the caller returns ``NOT_FOUND``. Nothing is ever guessed.

An id is *stale* when any of these is true:

* a newer candidate list was issued for the same task (only the latest question is answerable);
* it is older than ``ttl`` seconds;
* the window it names no longer exists as an Explorer window (checked by the caller).

Ids are random (``c_`` + 12 hex digits) and carry no HWND, title or path. The registry
lives in the tool host process for the life of the task; ``forget_task`` drops a finished
task's ids.
"""

from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass

# CONTRACTS v2 §5: a targetId that does not match this is malformed -> INVALID_ARGUMENT.
TARGET_ID_RE = re.compile(r"c_[0-9a-f]{12}")


def is_well_formed_target_id(value: object) -> bool:
    return isinstance(value, str) and TARGET_ID_RE.fullmatch(value) is not None

DEFAULT_TTL_S = 300.0


@dataclass(frozen=True)
class _Entry:
    task_id: str
    generation: int
    target: object      # a WindowIdentity {hwnd, pid, windowClass}
    label: str
    issued_at: float


@dataclass(frozen=True)
class Resolution:
    target: object | None
    reason: str          # "ok" | "unknown" | "cross_task" | "superseded" | "expired"

    @property
    def ok(self) -> bool:
        return self.target is not None


class CandidateRegistry:
    def __init__(self, ttl: float = DEFAULT_TTL_S, clock: Callable[[], float] = time.monotonic,
                 token: Callable[[], str] | None = None):
        self.ttl = ttl
        self.clock = clock
        self._token = token or (lambda: secrets.token_hex(6))
        self._entries: dict[str, _Entry] = {}
        self._generation: dict[str, int] = {}

    def issue(self, task_id: str, targets: list[tuple[object, str]]) -> list[dict[str, str]]:
        """Issue a fresh candidate list for ``task_id``; earlier ids of that task become stale."""
        if not task_id:
            raise ValueError("candidate ids are task-scoped; task_id is required")
        gen = self._generation.get(task_id, 0) + 1
        self._generation[task_id] = gen
        now = self.clock()
        out = []
        for target, label in targets:
            cid = "c_" + self._token()
            while cid in self._entries:
                cid = "c_" + self._token()
            self._entries[cid] = _Entry(task_id, gen, target, label, now)
            out.append({"id": cid, "label": label})
        return out

    def resolve(self, task_id: str, candidate_id: str) -> Resolution:
        entry = self._entries.get(candidate_id) if isinstance(candidate_id, str) else None
        if entry is None:
            return Resolution(None, "unknown")
        if entry.task_id != task_id:
            return Resolution(None, "cross_task")
        if entry.generation != self._generation.get(task_id):
            return Resolution(None, "superseded")
        if self.clock() - entry.issued_at > self.ttl:
            return Resolution(None, "expired")
        return Resolution(entry.target, "ok")

    def forget_task(self, task_id: str) -> None:
        self._entries = {k: v for k, v in self._entries.items() if v.task_id != task_id}
        self._generation.pop(task_id, None)
