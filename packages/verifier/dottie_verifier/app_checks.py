"""App-launch postconditions: a new top-level window owned by the expected process image."""

from __future__ import annotations

import ntpath

from dottie_verifier.model import Check, CheckStatus
from dottie_verifier.winapi import WindowsApi
from dottie_verifier.window_checks import (
    check_foreground,
    check_not_minimized,
    check_visible_on_monitor,
)

# UWP / packaged apps are hosted by ApplicationFrameHost.exe; the real process differs.
UWP_HOST = "applicationframehost.exe"


def find_app_windows(api: WindowsApi, images: set[str], before: set[int]) -> list[int]:
    wanted = {i.casefold() for i in images}
    found = []
    for hwnd in api.top_level_windows():
        if hwnd in before:
            continue
        st = api.window_state(hwnd)
        if st.exists and ntpath.basename(st.process_image).casefold() in wanted:
            found.append(hwnd)
    return found


def verify_app_launched(api: WindowsApi, images: set[str], before: set[int]) -> list[Check]:
    """APP-01..05. ``images`` should include the UWP host when the app is packaged (e.g.
    Calculator)."""
    found = find_app_windows(api, images, before)
    if len(found) != 1:
        status = CheckStatus.FAIL if not found else CheckStatus.UNKNOWN
        ev = {"new_windows": found, "images": sorted(images)}
        if len(found) > 1:
            ev["ambiguous"] = True
        return [Check("APP-01", "Exactly one new top-level window owned by the app", status,
                      evidence=ev, source="EnumWindows diff + process image")]
    hwnd = found[0]
    st = api.window_state(hwnd)
    return [
        Check("APP-01", "Exactly one new top-level window owned by the app", CheckStatus.PASS,
              evidence={"hwnd": hwnd, "pid": st.pid, "process_image": st.process_image}),
        check_not_minimized("APP-02", st),
        check_visible_on_monitor("APP-03", st, api),
        check_foreground("APP-04", st, api, critical=False),
    ]
