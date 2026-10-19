"""In-memory Explorer desktop. Windows semantics: case-insensitive paths, one HWND with several tabs."""
from __future__ import annotations

import ntpath
from collections.abc import Callable
from dataclasses import dataclass, field

from dottie_tools.reference.ports import EXPLORER_CLASS, WindowGone, WindowIdentity
from dottie_tools.targets import live_identities

DOWNLOADS = r"C:\Users\gopi\Downloads"
DOCS = r"C:\Users\gopi\Documents"
PICS = r"C:\Users\gopi\Pictures"
HOME = r"C:\Users\gopi"


@dataclass
class FakeWindow:
    hwnd: int
    pid: int | None
    tabs: list[str]
    active: int = 0
    cls: str | None = EXPLORER_CLASS      # None = GetClassNameW failed
    start: int | None = 0                 # None = GetProcessTimes failed (access denied / exiting)
    image: str = "explorer.exe"
    cloaked: bool | None = False          # None = DwmGetWindowAttribute(DWMWA_CLOAKED) failed
    dpi: int | None = 96                  # None = GetDpiForWindow failed (returned 0)

    @property
    def path(self) -> str:
        return self.tabs[self.active]


@dataclass
class FakeDesktop:
    windows: dict[int, FakeWindow] = field(default_factory=dict)
    foreground: int | None = None
    known: dict[str, str] = field(default_factory=lambda: {"downloads": DOWNLOADS, "documents": DOCS,
                                                         "pictures": PICS})
    navigations: list[tuple[int, str]] = field(default_factory=list)
    launches: list[list[str]] = field(default_factory=list)     # argv lists, never a shell string
    profile: str = HOME
    missing: set = field(default_factory=set)                   # known-folder paths that don't exist
    reparse: dict = field(default_factory=dict)                 # path -> final target (junction/symlink)
    remote_drives: set = field(default_factory=set)             # mapped network drive letters, e.g. {"Z"}
    # Hooks: called after a navigate is dispatched. Return value ignored.
    on_navigate: Callable[[FakeDesktop, int, str], None] | None = None
    navigate_is_noop: bool = False
    _next_hwnd: int = 0x1000
    _next_pid: int = 500
    _next_start: int = 133_700_000_000_000_000      # realistic FILETIME, > 2**53
    # Called when the tool host is about to dispatch (after preview/approval); lets tests close a window
    on_before_dispatch: Callable[[FakeDesktop], None] | None = None

    # ---- test helpers ----
    def add(self, *paths: str, foreground: bool = False, active: int = 0, hwnd: int | None = None,
            pid: int | None = None, cls: str | None = EXPLORER_CLASS,
            start: int | None = None, unreadable: str | None = None) -> FakeWindow:
        if hwnd is None:
            self._next_hwnd += 0x10
            hwnd = self._next_hwnd
        if pid is None:
            self._next_pid += 1
            pid = self._next_pid
        if start is None:
            self._next_start += 1
            start = self._next_start
        w = FakeWindow(hwnd, pid, list(paths) or [HOME], active, cls, start)
        if unreadable:
            setattr(w, unreadable, None)
        self.windows[hwnd] = w
        if foreground:
            self.foreground = hwnd
        return w

    def close(self, hwnd: int) -> None:
        self.windows.pop(hwnd, None)
        if self.foreground == hwnd:
            self.foreground = None

    # ---- ExplorerPort ----
    # WindowFieldReader (plain Win32 reads)
    def top_level_explorer_hwnds(self) -> list[int]:
        return [w.hwnd for w in self.windows.values() if w.cls in (EXPLORER_CLASS, None)]

    def read_fields(self, hwnd: int):
        w = self.windows.get(hwnd)
        return None if w is None else (w.pid, w.cls, w.start)

    def is_cloaked(self, hwnd: int) -> bool | None:
        w = self.windows.get(hwnd)
        if w is None:
            raise WindowGone(hwnd)
        return w.cloaked

    def window_dpi(self, hwnd: int) -> int | None:
        w = self.windows.get(hwnd)
        return None if w is None else w.dpi

    def process_image_name(self, pid: int) -> str | None:
        return next((w.image for w in self.windows.values() if w.pid == pid), None)

    def explorer_windows(self) -> list[WindowIdentity]:
        return live_identities(self)

    def foreground_root(self) -> int | None:
        return self.foreground

    def active_tab_path(self, hwnd: int) -> str | None:
        w = self.windows.get(hwnd)
        if w is None:
            raise WindowGone(hwnd)
        return w.path

    def navigate_active_tab(self, hwnd: int, path: str) -> None:
        w = self.windows.get(hwnd)
        if w is None:
            raise WindowGone(hwnd)
        self.navigations.append((hwnd, path))
        if not self.navigate_is_noop:
            w.tabs[w.active] = path
        if self.on_navigate:
            self.on_navigate(self, hwnd, path)

    def navigate_first_entry(self, hwnd: int, path: str) -> None:
        """What Bot does: navigate the first IShellWindows entry for the HWND (may be a background tab)."""
        w = self.windows.get(hwnd)
        if w is None:
            raise WindowGone(hwnd)
        self.navigations.append((hwnd, path))
        if not self.navigate_is_noop:
            w.tabs[0] = path
        if self.on_navigate:
            self.on_navigate(self, hwnd, path)

    def launch_explorer(self, argv: list[str]) -> None:
        assert isinstance(argv, list), "Explorer must get an argv list, never a shell string"
        self.launches.append(list(argv))
        self.add(argv[-1], foreground=True)

    def folder_exists(self, path: str) -> bool:
        return path not in self.missing

    def is_network_path(self, path: str) -> bool:
        p = self.final_path(path)
        return p.startswith("\\\\") or (len(p) > 1 and p[1] == ":" and p[0].upper() in self.remote_drives)

    def user_profile(self) -> str:
        return self.profile

    def known_folder(self, folder: str) -> str | None:
        return self.known.get(folder)

    def final_path(self, path: str) -> str:
        for src, dst in self.reparse.items():                     # GetFinalPathNameByHandle follows reparse points
            if ntpath.normcase(path).startswith(ntpath.normcase(src)):
                path = dst + path[len(src):]
        return ntpath.normcase(ntpath.normpath(path)).rstrip("\\")


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s
