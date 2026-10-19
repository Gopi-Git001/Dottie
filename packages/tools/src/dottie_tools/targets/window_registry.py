"""Shared, task-scoped window-target registry for dottie-tools (scratch API sketch).

Owner E04, reviewer E11 (CONTRACTS v2 §5 "E04 review"; §3.3 WindowIdentity; E01 rulings 2026-10-19).

* Identity = {hwnd, pid, windowClass, processStartTime}. A mismatch on ANY field = closed window.
  If ANY field can't be read, the window has NO identity: it can't be offered, pinned or acted on.
* Internally all numeric fields are Python ints; processStartTime is the FILETIME of process
  creation (GetProcessTimes): 100-ns ticks since 1601-01-01 UTC.
* Wire form (CONTRACTS §3.3, E01 2026-10-19): hwnd, pid and processStartTime are canonical unsigned
  decimal STRINGS, no leading zeros, "0" invalid; windowClass is the plain class-name string.
* Candidate ids are opaque: ``c_`` + 12 lowercase hex, task-scoped (taskId from HostContext, never
  from model args), valid across turns of the task until endTask(taskId) (decision C3), superseded
  per window (the SAME window re-registered under a new id in the same task kills only its old id;
  other windows' ids are unaffected; E03/E04 settled, DOT-092 DRAFT 3 §4.2), plus a 30-min safety cap (PROPOSAL, not ruled). Malformed -> INVALID_ARGUMENT;
  well-formed but unknown / cross-task / ended task / superseded / past the cap / closed / no identity
  -> NOT_FOUND.
* Thread-safe (one lock); identify/is_alive need only plain Win32 reads through the port (no COM).
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

DEFAULT_TTL_S = 1800.0      # safety cap, PROPOSAL (C3); the real bound is endTask(taskId)
TARGET_ID_RE = re.compile(r"^c_[0-9a-f]{12}$")
_CANON_UINT_RE = re.compile(r"^[1-9][0-9]*$")      # no sign, no leading zero, no whitespace, no hex; zero rejected
U64_MAX = 2**64 - 1
U32_MAX = 2**32 - 1
MAX_CLASS_LEN = 256          # UTF-16 code units (CONTRACTS §3.3, E01): GetClassNameW's unit, not Python len()


def utf16_units(s: str) -> int:
    """Length in UTF-16 code units: a non-BMP char (emoji) counts 2. Callers check _utf8_ok first, so no
    lone surrogate reaches here (encode would raise on one)."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2
MAX_UINT_DIGITS = 20         # len(str(2**64 - 1)); checked BEFORE int() so CPython's int max-str-digits
                             # ValueError (> 4300 digits) can never escape the INVALID_ARGUMENT mapping


class IdentityFormatError(ValueError):
    """A wire identity is malformed. Wherever an identity is *input*, map this to INVALID_ARGUMENT."""
    error_code = "INVALID_ARGUMENT"


def _uint_to_wire(value: int, name: str, maximum: int) -> str:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise IdentityFormatError(f"{name} out of range")
    return str(value)


def _uint_from_wire(value: object, name: str, maximum: int) -> int:
    if not isinstance(value, str) or len(value) > MAX_UINT_DIGITS:      # length first: no int() on huge input
        raise IdentityFormatError(f"{name} must be a canonical unsigned decimal string of at most 20 digits")
    if not value.isascii() or not _CANON_UINT_RE.fullmatch(value):
        raise IdentityFormatError(f"{name} must be a canonical unsigned decimal string")
    n = int(value)                                                       # <= 20 ASCII digits: cannot raise
    if n > maximum:
        raise IdentityFormatError(f"{name} out of range")
    return n


@dataclass(frozen=True)
class WindowIdentity:
    """Same attribute names as E11's dottie_verifier.window_identity.WindowIdentity."""
    hwnd: int
    pid: int
    window_class: str
    process_start_time: int    # FILETIME int (100-ns ticks since 1601 UTC)

    def __post_init__(self) -> None:   # an identity is all-or-nothing; validate every field
        _uint_to_wire(self.hwnd, "hwnd", U64_MAX)
        _uint_to_wire(self.pid, "pid", U32_MAX)
        _uint_to_wire(self.process_start_time, "processStartTime", U64_MAX)
        if not isinstance(self.window_class, str) or not self.window_class \
                or len(self.window_class) > MAX_CLASS_LEN \
                or not 1 <= utf16_units(self.window_class) <= MAX_CLASS_LEN:
            raise IdentityFormatError("windowClass must be 1-256 UTF-16 code units")
        if not _utf8_ok(self.window_class):          # lone UTF-16 surrogate: would break the UTF-8 hash input
            raise IdentityFormatError("windowClass must be valid Unicode")

    def to_wire(self) -> dict:
        """Canonical JSON form (CONTRACTS §3.3). Also the approval-hash input."""
        return {"hwnd": _uint_to_wire(self.hwnd, "hwnd", U64_MAX),
                "pid": _uint_to_wire(self.pid, "pid", U32_MAX),
                "windowClass": self.window_class,
                "processStartTime": _uint_to_wire(self.process_start_time, "processStartTime", U64_MAX)}

    # E11 spelling
    to_contract = to_wire

    @classmethod
    def from_wire(cls, obj: object) -> WindowIdentity:
        if not isinstance(obj, dict) or set(obj) != {"hwnd", "pid", "windowClass", "processStartTime"}:
            raise IdentityFormatError("identity must have exactly hwnd, pid, windowClass, processStartTime")
        pid = _uint_from_wire(obj["pid"], "pid", U32_MAX)
        wc = obj["windowClass"]
        if not isinstance(wc, str):
            raise IdentityFormatError("windowClass must be a string")
        return cls(_uint_from_wire(obj["hwnd"], "hwnd", U64_MAX), pid, wc,
                   _uint_from_wire(obj["processStartTime"], "processStartTime", U64_MAX))


class CanonicalError(ValueError):
    pass


MAX_CANON_DEPTH = 16


def _utf8_ok(s: str) -> bool:
    try:
        s.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def _check_leaves(obj: object, path: str = "$", depth: int = 0) -> None:
    if depth > MAX_CANON_DEPTH:
        raise CanonicalError("nesting too deep")     # never a RecursionError
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not isinstance(k, str) or not _utf8_ok(k):
                raise CanonicalError("non-string or non-UTF-8 key")
            _check_leaves(v, path + "." + k, depth + 1)
    elif obj is None:
        return
    elif isinstance(obj, str):
        if not _utf8_ok(obj):
            raise CanonicalError("string is not valid UTF-8 (lone surrogate)")
        return                                       # CR2: null only for fields that don't apply
    else:
        raise CanonicalError(f"non-string value at {path}")   # numbers, bools, lists rejected, never coerced


def canonical_json(obj: object) -> str:
    """CONTRACTS §3.3 / ADR-0009 CR2 canonicaliser (scratch mirror): keys sorted, UTF-8, no whitespace,
    every value a string (null where a field doesn't apply), non-string values rejected. The normative
    implementation and test vectors live in packages/policy (E08)."""
    _check_leaves(obj)
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def parse_canonical(text: str) -> object:
    """Parse canonical JSON, rejecting duplicate keys (CR2) and non-canonical spelling."""
    def hook(pairs):
        keys = [k for k, _ in pairs]
        if len(keys) != len(set(keys)):
            raise CanonicalError("duplicate key")
        return dict(pairs)
    if not isinstance(text, str):
        raise CanonicalError("canonical JSON must be text")
    try:
        obj = json.loads(text, object_pairs_hook=hook)
    except CanonicalError:
        raise
    except (ValueError, RecursionError) as exc:      # bad JSON, int max-str-digits, absurd nesting
        raise CanonicalError("not valid JSON") from None
    if canonical_json(obj) != text:
        raise CanonicalError("not in canonical form")
    return obj


class WindowFieldReader(Protocol):
    """Plain Win32 reads (no COM): IsWindow + GA_ROOT, GetWindowThreadProcessId, GetClassNameW,
    GetProcessTimes(PROCESS_QUERY_LIMITED_INFORMATION). Each returns None when it can't read."""
    def top_level_explorer_hwnds(self) -> list[int]: ...
    def read_fields(self, hwnd: int) -> tuple[int | None, str | None, int | None] | None: ...  # None = gone
    def process_image_name(self, pid: int) -> str | None: ...                               # QueryFullProcessImageName basename
    def is_cloaked(self, hwnd: int) -> bool | None: ...      # DwmGetWindowAttribute(DWMWA_CLOAKED) != 0; None = unreadable
    def window_dpi(self, hwnd: int) -> int | None: ...       # GetDpiForWindow; 0 / failure -> None (NEVER 96)


@dataclass(frozen=True)
class HostContext:
    """Per-call context from the coordinator control channel (ADR-0010, §5). Never from model args."""
    task_id: str
    thread_id: str
    turn_id: str
    item_id: str | None = None
    request_id: str | None = None


class Liveness(str, Enum):
    LIVE = "live"
    WINDOW_GONE = "window_gone"
    IDENTITY_MISMATCH = "identity_mismatch"
    NO_IDENTITY = "no_identity"              # some field unreadable now

    @property
    def closed(self) -> bool:
        return self is not Liveness.LIVE


def identify(reader: WindowFieldReader, hwnd: int) -> WindowIdentity | None:
    """Current identity of a live top-level window, or None (gone or any field unreadable). Never raises
    for a dead handle; never uses the title."""
    try:
        fields = reader.read_fields(hwnd)
    except Exception:            # noqa: BLE001 - a dead or protected handle is "no identity", never an error
        return None
    if fields is None or any(f is None for f in fields):
        return None
    pid, cls, start = fields
    try:
        return WindowIdentity(hwnd, pid, cls, start)
    except IdentityFormatError:
        return None


def live_identities(reader: WindowFieldReader) -> list[WindowIdentity]:
    """Identified Explorer windows only; windows without a full identity are never offered."""
    return [i for h in reader.top_level_explorer_hwnds() if (i := identify(reader, h)) is not None]


def liveness(reader: WindowFieldReader, identity: WindowIdentity) -> Liveness:
    try:
        fields = reader.read_fields(identity.hwnd)
    except Exception:            # noqa: BLE001
        return Liveness.NO_IDENTITY
    if fields is None or identity.hwnd not in reader.top_level_explorer_hwnds():
        return Liveness.WINDOW_GONE
    current = identify(reader, identity.hwnd)
    if current is None:
        return Liveness.NO_IDENTITY
    return Liveness.LIVE if current == identity else Liveness.IDENTITY_MISMATCH


def check_live(identity: WindowIdentity, live: Iterable[WindowIdentity]) -> Liveness:
    """Pure variant over an already-read identity set (e.g. one snapshot per poll)."""
    same = [w for w in live if w.hwnd == identity.hwnd]
    if not same:
        return Liveness.WINDOW_GONE
    return Liveness.LIVE if identity in same else Liveness.IDENTITY_MISMATCH


# ---- Fail-closed observations outside the identity (CONTRACTS §5, E01 2026-10-19) ----------------------
MIN_DPI, MAX_DPI = 24, 2880          # sanity bounds for GetDpiForWindow; outside = unreadable (PROPOSAL bounds)


class Actionability(str, Enum):
    ACTIONABLE = "actionable"
    CLOAKED = "cloaked"                   # DWM-cloaked (other virtual desktop, suspended UWP, ...)
    CLOAK_UNREADABLE = "cloak_unreadable"  # the cloaked check failed -> not actionable (fail closed)
    DPI_UNREADABLE = "dpi_unreadable"      # only for actions that need coordinates

    @property
    def ok(self) -> bool:
        return self is Actionability.ACTIONABLE


class NotActionable(Exception):
    """The window can't be acted on. CONTRACTS §5: PRECONDITION_FAILED, sideEffect none."""
    error_code = "PRECONDITION_FAILED"
    side_effect = "none"

    def __init__(self, reason: Actionability) -> None:
        super().__init__(reason.value)
        self.reason = reason


def window_dpi(reader: WindowFieldReader, identity: WindowIdentity) -> int | None:
    """DPI of the window, or None. There is NO fallback to 96 (CONTRACTS §5)."""
    try:
        dpi = reader.window_dpi(identity.hwnd)
    except Exception:            # noqa: BLE001 - unreadable, never an error
        return None
    if isinstance(dpi, bool) or not isinstance(dpi, int) or not MIN_DPI <= dpi <= MAX_DPI:
        return None
    return dpi


def actionability(reader: WindowFieldReader, identity: WindowIdentity, *,
                  needs_coordinates: bool = False) -> Actionability:
    """Never raises. A cloaked window, or a cloaked check that can't be read, is not actionable; an action
    that needs coordinates also needs a readable DPI."""
    try:
        cloaked = reader.is_cloaked(identity.hwnd)
    except Exception:            # noqa: BLE001 - includes a reader without is_cloaked
        cloaked = None
    if not isinstance(cloaked, bool):
        return Actionability.CLOAK_UNREADABLE
    if cloaked:
        return Actionability.CLOAKED
    if needs_coordinates and window_dpi(reader, identity) is None:
        return Actionability.DPI_UNREADABLE
    return Actionability.ACTIONABLE


def to_physical(reader: WindowFieldReader, identity: WindowIdentity, x: int, y: int) -> tuple[int, int]:
    """Logical (96-dpi) point -> physical pixels for this window. Raises NotActionable when the window
    isn't actionable or its DPI is unreadable; never assumes 96."""
    state = actionability(reader, identity, needs_coordinates=True)
    if not state.ok:
        raise NotActionable(state)
    dpi = window_dpi(reader, identity)
    assert dpi is not None
    return (x * dpi + 48) // 96, (y * dpi + 48) // 96


class WindowIdentityService:
    """Satisfies E11's ``WindowRegistry`` protocol (identify / is_alive) plus EXP-03's image lookup."""

    def __init__(self, reader: WindowFieldReader) -> None:
        self.reader = reader

    def identify(self, hwnd: int) -> WindowIdentity | None:
        return identify(self.reader, hwnd)

    def is_alive(self, identity: WindowIdentity) -> bool:
        return liveness(self.reader, identity) is Liveness.LIVE

    def process_image_name(self, identity: WindowIdentity) -> str | None:
        if not self.is_alive(identity):
            return None
        try:
            return self.reader.process_image_name(identity.pid)
        except Exception:        # noqa: BLE001
            return None


def identity_digest(identity: WindowIdentity | None) -> str:
    """Digest of the canonical wire identity for audit records (no raw hwnd/pid in logs, ADR-0017 §7)."""
    if identity is None:
        return "none"
    return hashlib.sha256(canonical_json(identity.to_wire()).encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Resolution:
    identity: WindowIdentity | None
    reason: str   # ok | malformed | unknown | cross_task | superseded | safety_cap | window_gone | identity_mismatch | no_identity

    @property
    def ok(self) -> bool:
        return self.identity is not None

    @property
    def error_code(self) -> str | None:
        if self.ok:
            return None
        return "INVALID_ARGUMENT" if self.reason == "malformed" else "NOT_FOUND"


def is_well_formed_target_id(value: object) -> bool:
    return isinstance(value, str) and bool(TARGET_ID_RE.fullmatch(value))


@dataclass(frozen=True)
class _Entry:
    task_id: str
    identity: WindowIdentity
    label: str
    issued_at: float
    issued_turn: str


class WindowRegistry:
    """One instance per tool-host process, shared by the E04 adapters and E11's verifier."""

    def __init__(self, ttl: float = DEFAULT_TTL_S, clock: Callable[[], float] = time.monotonic,
                 token: Callable[[], str] | None = None) -> None:
        self.ttl = ttl
        self.clock = clock
        self._token = token or (lambda: secrets.token_hex(6))
        self._entries: dict[str, _Entry] = {}
        self._superseded: set[str] = set()
        self._lock = threading.Lock()

    def issue(self, ctx: HostContext, targets: list[tuple[WindowIdentity, str]]) -> list[dict[str, str]]:
        """Candidate list for ctx.task_id -> [{id, label}]. Per-window supersede: an older id of the SAME
        window (same 4-field identity) in the same task becomes NOT_FOUND; other windows' ids stay valid."""
        if not ctx.task_id:
            raise ValueError("candidate ids are task-scoped; HostContext.task_id is required")
        for ident, _ in targets:
            if not isinstance(ident, WindowIdentity):
                raise TypeError("registry entries must be a full WindowIdentity")
        with self._lock:
            fresh = {ident for ident, _ in targets}
            for cid, e in self._entries.items():
                if e.task_id == ctx.task_id and e.identity in fresh:
                    self._superseded.add(cid)
            now = self.clock()
            out = []
            for ident, label in targets:
                cid = "c_" + self._token()
                while cid in self._entries or cid in self._superseded or not TARGET_ID_RE.fullmatch(cid):
                    cid = "c_" + secrets.token_hex(6)
                self._entries[cid] = _Entry(ctx.task_id, ident, label, now, ctx.turn_id)
                out.append({"id": cid, "label": label})
            return out

    def resolve(self, ctx: HostContext, target_id: object, live: Iterable[WindowIdentity] | None = None,
                reader: WindowFieldReader | None = None) -> Resolution:
        """Resolve a model-supplied targetId for this task and re-check the window NOW (pass ``reader``
        for a live Win32 re-read, or ``live`` for a snapshot). Without either, nothing is usable."""
        if not is_well_formed_target_id(target_id):
            return Resolution(None, "malformed")
        with self._lock:
            entry = self._entries.get(target_id)  # type: ignore[arg-type]
            if entry is None or not ctx.task_id:
                return Resolution(None, "unknown")
            if entry.task_id != ctx.task_id:
                return Resolution(None, "cross_task")
            if target_id in self._superseded:
                return Resolution(None, "superseded")
            if self.clock() - entry.issued_at > self.ttl:
                return Resolution(None, "safety_cap")
        if reader is not None:
            state = liveness(reader, entry.identity)
        elif live is not None:
            state = check_live(entry.identity, live)
        else:
            return Resolution(None, "window_gone")
        if state.closed:
            return Resolution(None, state.value)
        return Resolution(entry.identity, "ok")

    def end_task(self, task_id: str) -> None:
        """Control-channel ``endTask(taskId)``: every id of the task is dead from now on (-> NOT_FOUND)."""
        self.forget_task(task_id)

    def forget_task(self, task_id: str) -> None:
        with self._lock:
            dead = {k for k, v in self._entries.items() if v.task_id == task_id}
            self._entries = {k: v for k, v in self._entries.items() if k not in dead}
            self._superseded -= dead
