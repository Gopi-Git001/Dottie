"""Glue to E04's Python tool registry (src/Bot/tools/registry.py), Windows only.

The verifier never imports E04's modules at import time (they need pywin32/pyautogui).
"""

from __future__ import annotations

import sys
from collections.abc import Callable


def bot_tool_runner(bot_root: str,
                    approval_callback: Callable[[str, dict], bool] | None = None
                    ) -> Callable[[str, dict], dict]:
    """Return ``runner(name, args)`` that dispatches through E04's ``execute_tool``.

    ``approval_callback`` must come from the policy gate (E08). Do NOT pass Bot's
    voice_assistant approval flow: it fails open (audit.md risk 3).
    """
    if bot_root not in sys.path:
        sys.path.insert(0, bot_root)
    from tools.registry import execute_tool  # type: ignore[import-not-found]

    def runner(name: str, args: dict) -> dict:
        return execute_tool(name, args, approval_callback=approval_callback)

    return runner


def open_downloads_on_this_machine(bot_root: str):
    """Manual smoke entry point for a real Windows 11 box (docs section 10)."""
    from dottie_verifier.explorer_workflow import spoken_summary, verify_open_downloads
    from dottie_verifier.win32_backend import Win32Api

    report = verify_open_downloads(Win32Api(), bot_tool_runner(bot_root))
    return report, spoken_summary(report)


if __name__ == "__main__":  # pragma: no cover
    import json

    rep, speech = open_downloads_on_this_machine(sys.argv[1] if len(sys.argv) > 1 else "../Bot")
    print(json.dumps(rep.to_dict(), indent=2, default=str))   # local evidence (unredacted)
    from dottie_verifier.contract import to_mcp_tool_result
    print(json.dumps(to_mcp_tool_result(rep, speech), indent=2))   # CONTRACTS v2 §5 shape
    print(speech)
