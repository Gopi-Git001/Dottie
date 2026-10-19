"""Deterministic fakes for the Windows surface (no pywin32 needed)."""

from __future__ import annotations

from dataclasses import dataclass, field

from dottie_verifier.known_folders import FOLDERID
from dottie_verifier.paths import normalize
from dottie_verifier.winapi import MonitorInfo, Rect, ShellWindowEntry, ShellWindowList, WindowState

EXPLORER = r"C:\Windows\explorer.exe"
DOWNLOADS = r"C:\Users\<user>\Downloads"


def url_for(path: str) -> str:
    if path.startswith("::"):
        return path
    return "file:///" + path.replace("\\", "/").replace(" ", "%20")


@dataclass
class Tab:
    tab_hwnd: int
    path: str
    name: str = ""
    pending_path: str | None = None   # becomes `path` after `delay` observations
    delay: int = 0


@dataclass
class FakeWindow:
    hwnd: int
    process_image: str = EXPLORER
    class_name: str = "CabinetWClass"
    pid: int = 4242
    process_start_time: int = 134_000_000_000_000_000   # FILETIME ticks (any stable value)
    visible: bool = True
    minimized: bool = False
    cloaked: bool | None = False      # None = DWMWA_CLOAKED read failed
    rect: Rect = field(default_factory=lambda: Rect(100, 100, 1100, 800))
    dpi: int | None = 96              # None = GetDpiForWindow failed
    tabs: list[Tab] = field(default_factory=list)
    active_tab: int | None = None
    title: str = "Downloads"
    restore_works: bool = True

    @property
    def is_explorer(self) -> bool:
        return self.process_image.lower().endswith("explorer.exe")


class FakeDesktop:
    def __init__(self):
        self.windows: dict[int, FakeWindow] = {}
        self.foreground = 0
        self.allow_foreground = True
        self.known = {FOLDERID["downloads"]: DOWNLOADS}
        self.dirs = {normalize(DOWNLOADS)}
        self.final_paths: dict[str, str] = {}
        self.uia_values: dict[int, str] = {}
        self.awareness = "per_monitor_v2"
        self.enum_complete = True         # False = IShellWindows skipped an unreadable entry
        self.expose_tab_hwnds = True
        self.active_tab_known = True
        self.monitor_list = [
            MonitorInfo(1, r"\\.\DISPLAY1", Rect(0, 0, 1920, 1080), Rect(0, 0, 1920, 1040), 96,
                        True),
        ]
        self.calls: list[str] = []
        self._next = 0x1000

    # -- helpers for tests ------------------------------------------------
    def new_hwnd(self) -> int:
        self._next += 0x10
        return self._next

    def add_explorer(self, path: str, *, foreground: bool = False, **kw) -> FakeWindow:
        hwnd = self.new_hwnd()
        tab = Tab(hwnd + 1, path)
        w = FakeWindow(hwnd, tabs=[tab], active_tab=tab.tab_hwnd, **kw)
        self.windows[hwnd] = w
        if foreground:
            self.foreground = hwnd
        return w

    def add_dir(self, path: str):
        self.dirs.add(normalize(path))

    def add_monitor(self, handle: int, rect: Rect, dpi: int | None = 96, primary: bool = False):
        self.monitor_list.append(MonitorInfo(handle, rf"\\.\DISPLAY{handle}", rect, rect, dpi,
                                             primary))

    def _monitor_of(self, rect: Rect) -> int | None:
        best, area = None, 0
        for m in self.monitor_list:
            a = rect.intersection_area(m.rect)
            if a > area:
                best, area = m.handle, a
        return best

    # -- WindowsApi ----------------------------------------------------------
    def get_known_folder_path(self, folder_id):
        return self.known.get(folder_id)

    def final_path(self, path):
        return self.final_paths.get(normalize(path), path)

    def path_is_dir(self, path):
        return normalize(path) in self.dirs

    def window_state(self, hwnd):
        w = self.windows.get(hwnd)
        if w is None:
            return WindowState(hwnd=hwnd, exists=False)
        return WindowState(hwnd, True, w.visible, w.minimized, w.cloaked, w.class_name, w.pid,
                           w.process_image, w.rect,
                           None if w.minimized or w.rect is None else self._monitor_of(w.rect),
                           w.dpi, w.title, w.process_start_time)

    def foreground_window(self):
        return self.foreground

    def root_window(self, hwnd):
        for w in self.windows.values():
            if hwnd == w.hwnd or any(t.tab_hwnd == hwnd for t in w.tabs):
                return w.hwnd
        return hwnd

    def shell_windows(self):
        out = []
        for w in self.windows.values():
            if not w.is_explorer:
                continue
            for t in w.tabs:
                if t.pending_path is not None:
                    if t.delay <= 0:
                        t.path, t.pending_path = t.pending_path, None
                    else:
                        t.delay -= 1
                out.append(ShellWindowEntry(
                    w.hwnd, t.tab_hwnd if self.expose_tab_hwnds else None, EXPLORER,
                    t.path, url_for(t.path), t.name))
        return ShellWindowList(out, complete=self.enum_complete,
                               skipped=0 if self.enum_complete else 1)

    def active_tab(self, hwnd):
        w = self.windows.get(hwnd)
        return w.active_tab if w and self.active_tab_known else None

    def uia_address_value(self, hwnd):
        return self.uia_values.get(hwnd)

    def top_level_windows(self):
        return list(self.windows)

    def monitors(self):
        return list(self.monitor_list)

    def window_from_point(self, x, y):
        # top-most = foreground first, then insertion order
        order = sorted(self.windows.values(), key=lambda w: w.hwnd != self.foreground)
        for w in order:
            if w.visible and not w.minimized and w.rect is not None and w.rect.contains(x, y):
                return w.hwnd
        return 0

    def process_dpi_awareness(self):
        return self.awareness

    def restore_window(self, hwnd):
        self.calls.append(f"restore:{hwnd}")
        w = self.windows[hwnd]
        if w.restore_works:
            w.minimized = False
            w.visible = True
        return not w.minimized

    def set_foreground(self, hwnd):
        self.calls.append(f"foreground:{hwnd}")
        if self.allow_foreground:
            self.foreground = hwnd
        return self.foreground == hwnd

    def move_window_to_monitor(self, hwnd, monitor):
        self.calls.append(f"move:{hwnd}:{monitor}")
        m = next(m for m in self.monitor_list if m.handle == monitor)
        w = self.windows[hwnd]
        w.rect = Rect(m.rect.left + 50, m.rect.top + 50, m.rect.left + 50 + w.rect.width,
                      m.rect.top + 50 + w.rect.height)
        return True

    def shell_navigate(self, hwnd, target):
        self.calls.append(f"navigate:{hwnd}:{target}")
        w = self.windows[hwnd]
        tab = next(t for t in w.tabs if t.tab_hwnd == w.active_tab)
        tab.path = target
        return True


class FakeE04Tools:
    """Mimics Bot ``execute_tool("open_downloads", {})`` behaviours, good and bad."""

    def __init__(self, desktop: FakeDesktop, mode: str = "normal", delay: int = 0,
                 wrong_path: str = r"C:\Users\<user>\Documents"):
        self.d = desktop
        self.mode = mode
        self.delay = delay
        self.wrong_path = wrong_path
        self.calls: list[tuple[str, dict]] = []

    def _target(self):
        explorers = [w for w in self.d.windows.values() if w.is_explorer]
        fg = self.d.windows.get(self.d.foreground)
        if fg is not None and fg.is_explorer:
            return fg
        if len(explorers) == 1:
            return explorers[0]
        if len(explorers) > 1:
            raise RuntimeError("Multiple Explorer windows are open. "
                               "Focus the desired Explorer window first.")
        return None

    def __call__(self, name: str, args: dict) -> dict:
        self.calls.append((name, args))
        mode = self.mode
        if mode == "lies":
            return {"success": True, "verified": True, "path": DOWNLOADS}
        if mode == "raises":
            raise RuntimeError("COM call failed: RPC server unavailable")
        if mode == "two_windows":
            a = self.d.add_explorer(DOWNLOADS, foreground=True)
            self.d.add_explorer(DOWNLOADS)
            return {"success": True, "verified": True, "hwnd": a.hwnd}
        try:
            if "hwnd" in args:   # tool host given an explicit window (targetId follow-up)
                target = self.d.windows.get(args["hwnd"])
                if target is None or not target.is_explorer:
                    return {"success": False, "verified": False, "error": "window not found"}
            else:
                target = self._target()
        except RuntimeError as exc:
            return {"success": False, "verified": False, "error": str(exc)}
        downloads = self.d.known.get(FOLDERID["downloads"], DOWNLOADS)
        dest = self.wrong_path if mode == "wrong_folder" else downloads
        if mode == "wrong_folder_once":
            dest = self.wrong_path if len(self.calls) == 1 else downloads
        reused = target is not None
        if target is None:
            target = self.d.add_explorer(r"C:\Users\<user>", foreground=mode not in {"no_focus",
                    "minimized"})
            if mode == "minimized":
                target.minimized = True
        tab = next(t for t in target.tabs if t.tab_hwnd == target.active_tab)
        if mode == "background_tab" and len(target.tabs) > 1:
            tab = next(t for t in target.tabs if t.tab_hwnd != target.active_tab)
        if self.delay:
            tab.pending_path, tab.delay = dest, self.delay
        else:
            tab.path = dest
        return {"success": True, "verified": True, "hwnd": target.hwnd, "path": dest,
                "reused_window": reused}
