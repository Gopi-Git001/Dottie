"""First demo: "Dottie, open File Explorer and go to Downloads".

Wraps E04's ``open_downloads`` tool (Bot ``tools/desktop_tools.py``) without modifying it.
E04's own ``verified: True`` is kept as evidence only: its fallback accepts any location
text containing "downloads" and does not pick the active Windows 11 tab.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any, ClassVar

from dottie_verifier.candidates import CandidateRegistry, is_well_formed_target_id
from dottie_verifier.contract import tool_policy_error
from dottie_verifier.explorer import (
    explorer_snapshot,
    observe_folder,
    verify_explorer_at_known_folder,
)
from dottie_verifier.known_folders import FOLDERID, resolve_known_folder
from dottie_verifier.model import Check, CheckStatus, Outcome, VerificationReport
from dottie_verifier.paths import same_path
from dottie_verifier.recovery import RetryPolicy
from dottie_verifier.winapi import WindowsApi
from dottie_verifier.window_identity import LocalWindowRegistry, WindowIdentity, WindowRegistry
from dottie_verifier.workflow import ActionContext, ToolRunner, run_verified, safe_tool_call

RecoveryGate = Callable[[str, dict], bool]


def deny_all(_primitive: str, _target: dict) -> bool:
    return False


def allow_all(_primitive: str, _target: dict) -> bool:
    """For tests/fakes only. Production must pass the E08 policy gate (ADR-0009)."""
    return True


class OpenExplorerKnownFolder:
    action = "open_downloads"
    # Unresolvable/missing Downloads, or positive evidence of a non-Explorer window: stop.
    stop_on: ClassVar[dict[str, set[CheckStatus]]] = {
        "EXP-01": {CheckStatus.FAIL, CheckStatus.UNKNOWN},
        "EXP-03": {CheckStatus.FAIL},
    }

    def __init__(self, api: WindowsApi, tool_runner: ToolRunner, folder: str = "downloads",
                 tool_name: str = "open_downloads", tool_args: dict | None = None,
                 sleep: Callable[[float], None] | None = None, sample_interval: float = 0.25,
                 recovery_gate: RecoveryGate = deny_all, task_id: str = "",
                 candidates: CandidateRegistry | None = None,
                 target: WindowIdentity | None = None,
                 window_registry: WindowRegistry | None = None):
        self.api = api
        self.tool_runner = tool_runner
        self.folder = folder
        self.tool_name = tool_name
        self.action = tool_name
        self.tool_args = tool_args or {}
        self.name = f"explorer.open_known_folder:{folder}"
        self.sleep = sleep
        self.sample_interval = sample_interval
        # ADR-0009 fail-closed: direct Windows recovery primitives (restore/focus/move/navigate) are
        # side effects outside E04's allowlisted tools, so each one must pass the policy gate.
        # Default deny; re-observing and re-invoking the (policy-gated) E04 tool need no extra
        # grant.
        self.recovery_gate = recovery_gate
        self.task_id = task_id
        # Task-scoped issuer of opaque ask-the-user ids (resolved later via ``targetId``).
        self.candidates = candidates if candidates is not None else CandidateRegistry()
        # Window identity {hwnd, pid, windowClass} behind a swappable interface: today a local
        # adapter, later E04's shared registry in packages/tools (CONTRACTS v2 §5).
        self.windows = window_registry or LocalWindowRegistry(api)
        # The window the user picked through ``targetId``: the only acceptable target.
        self.target = target

    @property
    def target_hwnd(self) -> int | None:
        return self.target.hwnd if self.target is not None else None

    def _target_gone(self) -> bool:
        return self.target is not None and not self.windows.is_alive(self.target)

    def precheck(self, ctx: ActionContext) -> str | None:
        """Right before dispatch: is the pinned window still the same window?"""
        if self._target_gone():
            return "target window closed (or its handle was reused) before the action was sent"
        return None

    def actionable(self, ctx: ActionContext) -> tuple[str, str] | None:
        """A pinned window whose cloaked state can't be read is not actionable (CONTRACTS §5)."""
        if self.target is None:
            return None
        return _not_actionable(self.api.window_state(self.target.hwnd))

    # -- lifecycle -------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        hwnds, complete = explorer_snapshot(self.api)
        return {"explorer_hwnds": hwnds, "explorer_complete": complete,
                "foreground": self.api.foreground_window()}

    def act(self, ctx: ActionContext) -> dict[str, Any]:
        ctx.extra["tool_calls"] = ctx.extra.get("tool_calls", 0) + 1
        args = dict(self.tool_args)
        if self.target_hwnd is not None:
            args["hwnd"] = self.target_hwnd   # tool host contract: navigate exactly this window
        return safe_tool_call(self.tool_runner, self.tool_name, args)

    def verify(self, ctx: ActionContext) -> list[Check]:
        checks, target, state = verify_explorer_at_known_folder(
            self.api, self.folder, ctx.tool_result, ctx.before["explorer_hwnds"],
            sample_count=2, sleep=self.sleep, sample_interval=self.sample_interval,
            pinned=self.target_hwnd, pinned_gone=self._target_gone(),
            before_complete=ctx.before.get("explorer_complete", False))
        ctx.extra["target"] = target
        ctx.extra["state"] = state
        # Identity seen by this observation. Any recovery primitive re-checks against it right
        # before acting (TOCTOU, RISKS R23).
        observed = self.windows.identify(target.hwnd) if target.hwnd is not None else None
        ctx.extra["observed_identity"] = observed
        if observed is not None:
            # Local evidence only (never observedState); processStartTime is a decimal string.
            ident_check = next((c for c in checks if c.id == "EXP-02"), checks[0])
            ident_check.evidence["window_identity"] = observed.to_contract()
        if ctx.tool_result is not None:
            # The tool's claim is recorded next to the observation, never used as a pass.
            checks[-1].evidence["tool_claim"] = {
                k: ctx.tool_result.get(k) for k in ("success", "verified", "hwnd", "error", "path")
                if k in ctx.tool_result}
        return checks

    # -- recovery --------------------------------------------------------
    def _gated(self, steps: list[str], primitive: str, hwnd: int | None, call,
               ctx: ActionContext | None = None) -> None:
        """Run one recovery primitive with TOCTOU checks (RISKS R23, ADR-0017):

        1. re-resolve the identity and compare it with the one the last observation saw;
        2. ask the gate with that identity (the approval hash includes it);
        3. re-resolve again right after the gate answers and immediately before the Win32 call.

        Any mismatch, or an unreadable identity, means the primitive is not called."""
        observed = (ctx.extra.get("observed_identity") if ctx is not None else None)
        ident = self.windows.identify(hwnd) if hwnd is not None else None
        if ident is None or (observed is not None and ident != observed):
            steps.append(f"denied_by_policy:{primitive}(identity_changed)")
            return
        blocked = _not_actionable(self.api.window_state(hwnd))
        if blocked:
            steps.append(f"precondition_failed:{primitive}({blocked[0]})")
            return
        window = ident.to_contract()        # hwnd/pid/processStartTime as decimal strings
        target = {"hwnd": window["hwnd"], "workflow": self.name, "window": window}
        if not self.recovery_gate(primitive, target):
            steps.append(f"denied_by_policy:{primitive}(hwnd={hwnd})")
            return
        if self.windows.identify(hwnd) != ident:
            steps.append(f"denied_by_policy:{primitive}(identity_changed_after_approval)")
            return
        steps.append(f"{primitive}(hwnd={hwnd}) -> {call()}")

    def _reinvoke(self, steps: list[str], ctx: ActionContext) -> None:
        """Re-invoke the E04 tool. A pinned target gets the same identity re-check as the first
        dispatch, immediately before the call (TOCTOU, RISKS R23)."""
        if self.precheck(ctx):
            steps.append(f"denied_by_policy:reinvoke_tool(identity_changed):{self.tool_name}")
            return
        ctx.tool_result = self.act(ctx)
        steps.append(f"reinvoke_tool:{self.tool_name}")

    def recoverable(self, check: Check, ctx: ActionContext) -> bool:
        if check.status is CheckStatus.PASS or check.evidence.get("ambiguous"):
            return False
        if tool_policy_error(ctx.tool_result):
            return False   # never retry around a policy refusal, a decline or a missing approval
        if self.target_hwnd is not None and check.id == "EXP-02":
            return False   # the chosen window is gone: re-invoking would open a different one
        target = ctx.extra.get("target")
        if check.evidence.get("enumeration_incomplete") or (
                target is not None and target.enumeration_incomplete):
            return False   # can't tell which windows exist: re-invoking could open another one
        if check.id == "EXP-05":
            if check.evidence.get("not_actionable"):
                return False       # unreadable cloaked state / frame: never act on it
            return "cloaked" not in check.evidence.get("reasons", [])
        return check.id in {"EXP-02", "EXP-04", "EXP-06", "EXP-07"}

    def recover(self, checks: list[Check], ctx: ActionContext, attempt: int) -> list[str]:
        failing = {c.id: c for c in checks
                   if c.status is not CheckStatus.PASS and self.recoverable(c, ctx)}
        target = ctx.extra.get("target")
        hwnd = target.hwnd if target is not None else None
        steps: list[str] = []

        if hwnd is None and self.target_hwnd is not None:
            return steps
        if "EXP-02" in failing or hwnd is None:
            # Window missing or never identified: re-enumerate happens on the next verify;
            # re-invoke the idempotent navigation tool once per attempt.
            steps.append("reenumerate_windows")
            self._reinvoke(steps, ctx)
            return steps

        if "EXP-04" in failing:
            self._gated(steps, "restore_window", hwnd, lambda: self.api.restore_window(hwnd), ctx)
        if "EXP-05" in failing:
            reasons = failing["EXP-05"].evidence.get("reasons", [])
            if "not_visible" in reasons and "EXP-04" not in failing:
                self._gated(steps, "restore_window", hwnd,
                            lambda: self.api.restore_window(hwnd), ctx)
            if "off_screen" in reasons or "empty_rect" in reasons:
                primary = next((m for m in self.api.monitors() if m.primary), None)
                if primary is not None:
                    self._gated(steps, "move_window_to_monitor", hwnd,
                                lambda: self.api.move_window_to_monitor(hwnd, primary.handle), ctx)
        if "EXP-06" in failing:
            check = failing["EXP-06"]
            if check.status is CheckStatus.UNKNOWN:
                steps.append("reobserve_folder")       # COM not settled yet; wait and look again
            elif not ctx.extra.get("reinvoked_for_folder"):
                ctx.extra["reinvoked_for_folder"] = True
                self._reinvoke(steps, ctx)
            else:
                expected = resolve_known_folder(self.api, self.folder)
                self._gated(steps, "shell_navigate", hwnd,
                            lambda: self.api.shell_navigate(hwnd, expected.path or ""), ctx)
        if "EXP-07" in failing:
            self._gated(steps, "set_foreground", hwnd, lambda: self.api.set_foreground(hwnd), ctx)
        # If every step was denied nothing changed; the runner sees that and stops honestly.
        return steps

    def _safe_label(self, hwnd: int, index: int) -> str:
        """Known-folder name if the window shows one, else a neutral ordinal. Never a title or
        full path (CONTRACTS v2 §5 ObservedState rule)."""
        path = observe_folder(self.api, hwnd).path
        if path:
            for name in FOLDERID:
                kf = resolve_known_folder(self.api, name)
                if kf.path and same_path(path, kf.path, self.api.final_path):
                    return f"File Explorer window showing {name.capitalize()}"
        return f"File Explorer window {index}"

    def ask_candidates(self, check: Check, ctx: ActionContext) -> list[dict[str, str]]:
        if check.id == "EXP-06":
            return []
        hwnds = check.evidence.get("candidates", [])[:5]
        targets = []
        for i, h in enumerate(hwnds, start=1):
            ident = self.windows.identify(h)
            if ident is not None:
                targets.append((ident, self._safe_label(h, i)))
        return self.candidates.issue(self.task_id or "untracked-task", targets)

    def ask_question(self, check: Check, ctx: ActionContext) -> str:
        if check.id == "EXP-06":
            return ("That File Explorer window has several tabs and I can't tell which one is "
                    "active. Which tab should show Downloads?")
        candidates = check.evidence.get("candidates", [])
        labels = [self._safe_label(h, i) for i, h in enumerate(candidates[:5], start=1)]
        listed = "; ".join(labels)
        return (f"I see {len(candidates)} File Explorer windows ({listed}). Which one should "
                f"I switch to Downloads, or should I open a new window?")


def spoken_summary(report: VerificationReport, folder_label: str = "Downloads") -> str:
    outcome = report.outcome
    if report.decision == "ask_user" and report.question:
        return report.question
    if outcome is Outcome.VERIFIED:
        return f"File Explorer is showing {folder_label}."
    if outcome is Outcome.PARTIALLY_VERIFIED:
        caveats = []
        for c in report.failing():
            if c.id == "EXP-07":
                caveats.append("I couldn't bring it to the front")
            elif c.id == "EXP-08":
                caveats.append("an extra Explorer window was opened")
            else:
                caveats.append(c.description.lower())
        return f"File Explorer is showing {folder_label}, but " + " and ".join(caveats) + "."
    if outcome is Outcome.UNVERIFIED:
        return f"I asked File Explorer to open {folder_label}, but I couldn't confirm it."
    first = next((c for c in report.failing() if c.critical and c.status is CheckStatus.FAIL), None)
    why = first.description.lower() if first else "the result didn't match"
    return f"I couldn't open {folder_label} in File Explorer. Check failed: {why}."


def _not_actionable(state) -> tuple[str, str] | None:
    """Fail-closed observation gate for any action on a window (CONTRACTS §5)."""
    if state.exists and state.cloaked is None:
        return "cloaked_unreadable", "cloaked state could not be read; window not actionable"
    return None


def _refusal_report(workflow: str, flag: str, reason: str, message: str) -> VerificationReport:
    check = Check("ARG-01", "targetId refers to a window this task may act on", CheckStatus.FAIL,
                  evidence={flag: True, "reason": reason}, source="candidate registry")
    return VerificationReport(workflow=workflow, checks=[check], decision="stop",
                              decision_reason=f"{message}; nothing was sent",
                              tool_invoked=False, notes=["tool not invoked"])


def target_not_found_report(workflow: str, reason: str) -> VerificationReport:
    """Well-formed ``targetId`` that is unknown, stale, cross-task, expired or closed: NOT_FOUND."""
    return _refusal_report(workflow, "target_id_not_found", reason,
                           f"targetId not usable ({reason})")


def invalid_argument_report(workflow: str, reason: str) -> VerificationReport:
    """Schema-invalid or malformed arguments (e.g. a malformed ``targetId``): INVALID_ARGUMENT."""
    return _refusal_report(workflow, "invalid_argument", reason, f"invalid argument ({reason})")


def resolve_target(api: WindowsApi, registry: CandidateRegistry | None, task_id: str,
                   target_id: str, windows: WindowRegistry | None = None
                   ) -> tuple[WindowIdentity | None, str]:
    """Resolve a well-formed ``targetId``. CONTRACTS v2 §5 (E04 review) names a *closed*
    ``targetId`` explicitly as NOT_FOUND, so a window that is already gone (or whose handle was
    reused: any identity field changed) at resolution time is reported here as NOT_FOUND."""
    if registry is None:
        return None, "unknown"
    res = registry.resolve(task_id, target_id)
    if not res.ok:
        return None, res.reason
    windows = windows or LocalWindowRegistry(api)
    ident = res.target
    if not isinstance(ident, WindowIdentity):
        return None, "unknown"
    if not windows.is_alive(ident):
        now = windows.identify(ident.hwnd)
        return None, "handle_reused" if now is not None else "window_closed"
    hwnds, complete = explorer_snapshot(api)
    if ident.hwnd not in hwnds:
        return None, "window_closed" if complete else "enumeration_incomplete"
    return ident, "ok"


def verify_open_downloads(api: WindowsApi, tool_runner: ToolRunner,
                          retry: RetryPolicy | None = None,
                          sleep: Callable[[float], None] = time.sleep,
                          clock: Callable[[], float] = time.monotonic,
                          recovery_gate: RecoveryGate = deny_all,
                          cancelled: Callable[[], bool] | None = None,
                          task_id: str = "",
                          candidates: CandidateRegistry | None = None,
                          target_id: object = None,
                          window_registry: WindowRegistry | None = None) -> VerificationReport:
    """``explorer.open_known_folder{folder:"downloads", targetId?}``.

    ``task_id`` comes from the coordinator's control channel, never from model arguments.
    ``candidates`` must be the tool host's task-scoped registry so that ids issued by an
    AMBIGUOUS answer can be resolved by the follow-up call's ``targetId``.

    Window-gone rule (CONTRACTS v2 §5, E04 review):

    * malformed ``targetId`` -> INVALID_ARGUMENT; well-formed but unknown / stale / cross-task /
      superseded / expired / already closed -> NOT_FOUND (tool not called, sideEffect none);
    * resolved, but gone right before dispatch -> PRECONDITION_FAILED, sideEffect none;
    * gone after dispatch -> POSTCONDITION_UNKNOWN, sideEffect unknown.
    """
    name = "explorer.open_known_folder:downloads"
    windows = window_registry or LocalWindowRegistry(api)
    target = None
    if target_id is not None:
        if not is_well_formed_target_id(target_id):
            return invalid_argument_report(name, "targetId must match c_ + 12 lowercase hex")
        target, reason = resolve_target(api, candidates, task_id, str(target_id), windows)
        if target is None:
            return target_not_found_report(name, reason)
    wf = OpenExplorerKnownFolder(api, tool_runner, "downloads", "open_downloads", sleep=sleep,
                                 recovery_gate=recovery_gate, task_id=task_id,
                                 candidates=candidates, target=target, window_registry=windows)
    return run_verified(wf, retry=retry, sleep=sleep, clock=clock, cancelled=cancelled)


class ObserveExplorerKnownFolder(OpenExplorerKnownFolder):
    """Pure observation: "is File Explorer showing <folder>?" No tool call, no recovery primitive,
    so the report is ``mutating=False`` and its ``sideEffect`` is ``none`` (CONTRACTS v2 §5)."""

    mutating = False

    def act(self, ctx: ActionContext) -> dict[str, Any] | None:
        return None

    def recoverable(self, check: Check, ctx: ActionContext) -> bool:
        return check.id == "EXP-06" and check.status is CheckStatus.UNKNOWN \
            and not check.evidence.get("ambiguous")

    def recover(self, checks: list[Check], ctx: ActionContext, attempt: int) -> list[str]:
        return ["reobserve_folder"]


def observe_explorer_folder(api: WindowsApi, folder: str = "downloads",
                            retry: RetryPolicy | None = None,
                            sleep: Callable[[float], None] = time.sleep,
                            clock: Callable[[], float] = time.monotonic,
                            task_id: str = "",
                            candidates: CandidateRegistry | None = None) -> VerificationReport:
    wf = ObserveExplorerKnownFolder(api, _no_tool, folder, f"observe_{folder}", sleep=sleep,
                                    task_id=task_id, candidates=candidates)
    wf.name = f"explorer.get_current_folder:{folder}"
    return run_verified(wf, retry=retry, sleep=sleep, clock=clock)


def _no_tool(name: str, args: dict) -> dict:
    raise AssertionError(f"observation workflow must not call tools ({name})")
