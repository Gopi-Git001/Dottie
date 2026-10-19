"""Window identity behind a small, swappable interface.

CONTRACTS v2 §5 (E04 review, E01 2026-10-19).

The identity is ``{hwnd, pid, windowClass, processStartTime}`` (ADR-0017 Decision 8 / ADR-0009 CR2,
E01 2026-10-19; CONTRACTS §5 still shows the 3-field form). The one shared
registry module in ``packages/tools`` (owner E04, reviewer E11). Until it exists, the verifier
uses ``LocalWindowRegistry``, a thin adapter over its own ``WindowsApi``. Swapping in E04's
module means writing one adapter that satisfies ``WindowRegistry``; nothing else changes.

Rule: a mismatch on **any** field counts as closed, because HWND and PID values get reused. A
window whose process start time can't be read has no identity (fail-closed): it can't be pinned,
offered as a candidate, or acted on through a recovery primitive.

``processStartTime`` is a FILETIME (100 ns ticks since 1601-01-01 UTC). It is an ``int`` in memory
and an unsigned decimal string with no leading zeros on the wire and in every
serialized shape (CONTRACTS §3.3, E01 2026-10-19), because real values (~1.3e17) exceed 2^53.
Zero is invalid for hwnd, pid and processStartTime (CONTRACTS §3.3): a zero value means the field
could not be read, so the window has no identity. Parsing rejects non-strings, zero, signs,
leading zeros, whitespace and non-digits (INVALID_ARGUMENT).
``hwnd`` and ``pid`` use the same encoding (CONTRACTS §3.3).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Protocol

from dottie_verifier.winapi import WindowsApi

# Positive decimal string: digits with no leading zero, so "0" is rejected (CONTRACTS §3.3). No
# sign, whitespace, point or exponent, and ASCII digits only (``str.isdigit`` would accept other
# scripts' digits). At most 20 digits, so ``int()`` never sees an oversized string.
_UINT_RE = re.compile(r"[1-9][0-9]{0,19}")
FIELD_MAX = {"hwnd": 2**64 - 1, "pid": 2**32 - 1, "processStartTime": 2**64 - 1}
FILETIME_MAX = FIELD_MAX["processStartTime"]
# Fields serialized as decimal strings: all three numeric fields (CONTRACTS §3.3, E01 2026-10-19).
STRING_FIELDS = frozenset({"hwnd", "pid", "processStartTime"})
MAX_CLASS_LEN = 256    # CONTRACTS §3.3: windowClass is 1-256 UTF-16 code units (the Windows count)
_IDENTITY_KEYS = frozenset({"hwnd", "pid", "windowClass", "processStartTime"})


class InvalidArgumentError(ValueError):
    """A malformed identity field arrived as an argument. Callers report INVALID_ARGUMENT."""


def _check_uint(field: str, value: object) -> int:
    if type(value) is not int or not 1 <= value <= FIELD_MAX[field]:
        msg = f"{field} must be an int in [1, {FIELD_MAX[field]}] (zero is invalid)"
        raise InvalidArgumentError(msg)
    return value


def format_uint(field: str, value: int) -> str:
    """Canonical unsigned decimal string for the wire. Never a JSON number."""
    return str(_check_uint(field, value))


def parse_uint(field: str, value: object) -> int:
    """Parse a positive decimal string. Rejects non-strings (ints, floats, bools, None), "0",
    signs, leading zeros, whitespace, non-ASCII digits and anything else with INVALID_ARGUMENT."""
    if not isinstance(value, str) or not _UINT_RE.fullmatch(value):
        msg = f"{field} must be an unsigned decimal string without leading zeros"
        raise InvalidArgumentError(msg)
    return _check_uint(field, int(value))


def format_filetime(value: int) -> str:
    return format_uint("processStartTime", value)


def parse_filetime(value: object) -> int:
    return parse_uint("processStartTime", value)


def utf16_units(value: str) -> int | None:
    """UTF-16 code units, as Windows counts (CONTRACTS §3.3: ``len(s.encode('utf-16-le'))//2``).
    None for a string with a lone surrogate, which has no UTF-16 encoding."""
    try:
        return len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return None


def _check_class(value: object) -> str:
    """windowClass: a str of 1-256 UTF-16 code units. A lone surrogate is rejected: §3.3 says
    nothing about it, and such a string has no well-formed UTF-16 form (flagged to E01)."""
    units = utf16_units(value) if isinstance(value, str) else None
    if units is None or not 1 <= units <= MAX_CLASS_LEN:
        msg = f"windowClass must be a string of 1-{MAX_CLASS_LEN} UTF-16 code units"
        raise InvalidArgumentError(msg)
    return value


def _encode(field: str, value: int) -> int | str:
    return format_uint(field, value) if field in STRING_FIELDS else _check_uint(field, value)


def _decode(field: str, value: object) -> int:
    if field in STRING_FIELDS:
        return parse_uint(field, value)
    if type(value) is not int:
        msg = f"{field} must be an integer"
        raise InvalidArgumentError(msg)
    return _check_uint(field, value)


@dataclass(frozen=True)
class WindowIdentity:
    hwnd: int
    pid: int
    window_class: str
    process_start_time: int

    def __post_init__(self) -> None:
        for field, value in (("hwnd", self.hwnd), ("pid", self.pid),
                             ("processStartTime", self.process_start_time)):
            _check_uint(field, value)
        _check_class(self.window_class)

    def to_contract(self) -> dict[str, Any]:
        """The serialized spelling ``{hwnd, pid, windowClass, processStartTime}`` (CONTRACTS
        §3.3). Fields in ``STRING_FIELDS`` are canonical decimal strings."""
        return {"hwnd": _encode("hwnd", self.hwnd), "pid": _encode("pid", self.pid),
                "windowClass": self.window_class,
                "processStartTime": _encode("processStartTime", self.process_start_time)}

    @classmethod
    def from_contract(cls, obj: object) -> WindowIdentity:
        """Parse an identity that arrived as an argument. Raises ``InvalidArgumentError``."""
        if not isinstance(obj, dict) or set(obj) != _IDENTITY_KEYS:
            msg = "window identity must have exactly hwnd, pid, windowClass, processStartTime"
            raise InvalidArgumentError(msg)
        window_class = _check_class(obj["windowClass"])
        return cls(_decode("hwnd", obj["hwnd"]), _decode("pid", obj["pid"]), window_class,
                   _decode("processStartTime", obj["processStartTime"]))


class WindowRegistry(Protocol):
    """What the verifier needs from E04's shared window registry."""

    def identify(self, hwnd: int) -> WindowIdentity | None:
        """Current identity of a live top-level window, or None if it doesn't exist."""

    def is_alive(self, identity: WindowIdentity) -> bool:
        """True only if the same HWND still exists with the same pid, class and process start
        time."""


class LocalWindowRegistry:
    """Interim adapter over the verifier's ``WindowsApi`` (IsWindow, GetWindowThreadProcessId,
    GetClassName, GetProcessTimes on Windows; fakes in tests). Replace with E04's module."""

    def __init__(self, api: WindowsApi):
        self.api = api

    def identify(self, hwnd: int) -> WindowIdentity | None:
        state = self.api.window_state(hwnd)
        if not state.exists:
            return None
        # Any field unreadable (None, empty class, zero) -> no identity (CONTRACTS §3.3). No field
        # has a fail-open default: WindowState uses None for "couldn't read".
        if (state.pid is None or state.process_start_time is None or not state.class_name
                or not hwnd):
            return None
        try:
            return WindowIdentity(hwnd, state.pid, state.class_name, state.process_start_time)
        except InvalidArgumentError:
            return None                 # zero / out-of-range / wrong type: no identity

    def is_alive(self, identity: WindowIdentity) -> bool:
        return self.identify(identity.hwnd) == identity
