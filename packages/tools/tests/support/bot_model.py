"""Behaviour model of Bot's open_downloads targeting (NOT Bot code; written from e04-tools-plan.md (b) and
verifier-design §12). Used only to pin today's gaps as strict xfails:

* `open_downloads()` takes no arguments, so a targetId/hwnd is either rejected by the dispatcher's
  signature.bind or (if a host strips unknown args) silently ignored.
* Target = tracked/foreground Explorer, else the single one; two unfocused -> RuntimeError text.
* Navigates the first IShellWindows entry for the HWND (may be a background tab).
* Verifies if ANY entry of that HWND matches, with a substring fallback on the location text.
"""
from __future__ import annotations

from typing import Any

from support.fakes import FakeDesktop


def bot_open_downloads(desktop: FakeDesktop, args: dict[str, Any], *, strip_unknown_args: bool) -> dict[str, Any]:
    if args and not strip_unknown_args:
        return {"success": False, "error": "open_downloads() got an unexpected keyword argument"}
    wins = desktop.explorer_windows()
    fg = desktop.foreground_root()
    if fg in {w.hwnd for w in wins}:
        target = fg
    elif len(wins) == 1:
        target = wins[0].hwnd
    elif wins:
        return {"success": False, "verified": False,
                "error": "Multiple Explorer windows are open. Focus the desired Explorer window first."}
    else:
        desktop.launch_explorer(["explorer.exe", desktop.known["downloads"]])
        target = desktop.foreground_root()
    desktop.navigate_first_entry(target, desktop.known["downloads"])
    w = desktop.windows.get(target)
    tabs = w.tabs if w else []
    ok = any(desktop.final_path(t) == desktop.final_path(desktop.known["downloads"]) or "downloads" in t.lower()
             for t in tabs)
    return {"success": ok, "verified": ok, "hwnd": target}


def as_v2(bot: dict[str, Any]) -> dict[str, Any]:
    """Naive wrapper a host might write: trusts Bot's verified flag (what CONTRACTS §5 forbids relying on)."""
    v = bool(bot.get("verified"))
    se = "committed" if v else "unknown"
    out: dict[str, Any] = {"verified": v, "sideEffect": se,
                           "observedState": {"outcome": "verified" if v else "failed",
                                             "decision": "done" if v else "stop", "checks": {}, "sideEffect": se}}
    if not v:
        out["error"] = {"code": "INTERNAL", "message": str(bot.get("error", "")), "retryable": False}
    return out
