"""The narrow Windows surface the verifier needs, as a Protocol.

``win32_backend.Win32Api`` implements it on Windows; tests use ``tests/fakes.py``.
Everything is addressed by HWND / PID, never by window title or raw screen coordinates.
Rects are in physical virtual-screen pixels (the process must be Per-Monitor-v2 DPI aware).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Rect:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    @property
    def empty(self) -> bool:
        return self.width <= 0 or self.height <= 0

    def contains(self, x: int, y: int) -> bool:
        return self.left <= x < self.right and self.top <= y < self.bottom

    def intersection_area(self, other: Rect) -> int:
        w = min(self.right, other.right) - max(self.left, other.left)
        h = min(self.bottom, other.bottom) - max(self.top, other.top)
        return max(0, w) * max(0, h)

    def to_list(self) -> list[int]:
        return [self.left, self.top, self.right, self.bottom]


@dataclass(frozen=True)
class MonitorInfo:
    handle: int
    device: str
    rect: Rect          # full monitor rect, physical pixels
    work_area: Rect
    dpi: int | None     # effective DPI (96 = 100%); None = GetDpiForMonitor failed (no fallback)
    primary: bool = False

    @property
    def scale(self) -> float | None:
        return self.dpi / 96.0 if self.dpi else None


@dataclass(frozen=True)
class WindowState:
    hwnd: int
    exists: bool
    visible: bool = False
    minimized: bool = False
    # DWMWA_CLOAKED: other virtual desktop / suspended UWP. None = the read failed: the window is
    # then not actionable (CONTRACTS §5 "Fail-closed observations"), never "not cloaked".
    cloaked: bool | None = None
    # Identity fields (CONTRACTS §3.3). None = couldn't be read; never a fail-open default such as
    # 0 or "", which would look like a real value. Any None means the window has no identity.
    class_name: str | None = None   # GetClassNameW; None if it returned 0
    pid: int | None = None          # GetWindowThreadProcessId; None if it reported 0
    process_image: str = ""         # full image path from QueryFullProcessImageName
    rect: Rect | None = None        # DWMWA_EXTENDED_FRAME_BOUNDS (GetWindowRect fallback); None =
                                    # unreadable, never a zero rect
    monitor: int | None = None      # MonitorFromWindow(MONITOR_DEFAULTTONULL)
    dpi: int | None = None          # GetDpiForWindow; None = unreadable, never a 96 fallback
    title: str = ""                 # recorded as evidence only; never used for targeting
    # GetProcessTimes creation time (FILETIME, 100 ns ticks since 1601). Part of the window
    # identity because HWND and PID values get reused (ADR-0017 Decision 8). None = unreadable.
    process_start_time: int | None = None


@dataclass(frozen=True)
class ShellWindowEntry:
    """One IShellWindows item. Windows 11 tabs share a top-level HWND, so one HWND can have many."""

    hwnd: int                       # IWebBrowser2.HWND (top-level CabinetWClass)
    tab_hwnd: int | None            # IShellBrowser::GetWindow (ShellTabWindowClass), if available
    full_name: str                  # IWebBrowser2.FullName (process image of the host)
    folder_path: str                # Document.Folder.Self.Path ("" or "::{...}" for virtual)
    location_url: str               # IWebBrowser2.LocationURL
    location_name: str = ""         # localized display name: evidence only


class ShellWindowList(list):
    """IShellWindows enumeration result. ``complete`` is False when any entry was skipped
    (unreadable handle, COM error) or the enumeration itself failed (CONTRACTS §5 "Fail-closed
    observations"). A plain ``list`` from an implementation counts as incomplete."""

    def __init__(self, entries=(), complete: bool = False, skipped: int = 0):
        super().__init__(entries)
        self.complete = complete
        self.skipped = skipped


def enumeration_complete(entries: object) -> bool:
    return isinstance(entries, ShellWindowList) and entries.complete is True


class WindowsApi(Protocol):
    def get_known_folder_path(self, folder_id: str) -> str | None: ...
    def final_path(self, path: str) -> str | None: ...
    def path_is_dir(self, path: str) -> bool: ...
    def window_state(self, hwnd: int) -> WindowState: ...
    def foreground_window(self) -> int: ...
    def root_window(self, hwnd: int) -> int: ...
    def shell_windows(self) -> ShellWindowList: ...
    def active_tab(self, hwnd: int) -> int | None: ...
    def uia_address_value(self, hwnd: int) -> str | None: ...
    def top_level_windows(self) -> list[int]: ...
    def monitors(self) -> list[MonitorInfo]: ...
    def window_from_point(self, x: int, y: int) -> int: ...
    def process_dpi_awareness(self) -> str: ...
    # Recovery primitives (all HWND-targeted; none take screen coordinates)
    def restore_window(self, hwnd: int) -> bool: ...
    def set_foreground(self, hwnd: int) -> bool: ...
    def move_window_to_monitor(self, hwnd: int, monitor: int) -> bool: ...
    def shell_navigate(self, hwnd: int, target: str) -> bool: ...
