"""Real Windows implementation of ``WindowsApi`` (ctypes + pywin32 COM).

NOT exercised on the Linux CI box. Every method here needs real Windows 11 validation
(docs/verifier-design.md section 10). Import only on win32.

The host process must be Per-Monitor-v2 DPI aware (manifest or
SetProcessDpiAwarenessContext(-4)) or rects/points below are virtualized.
"""

from __future__ import annotations

import sys

if sys.platform != "win32":  # pragma: no cover - guarded import
    raise ImportError("win32_backend is only available on Windows")

import ctypes
import ctypes.wintypes as wt
import logging
from contextlib import contextmanager, suppress

import pythoncom
import pywintypes
import win32com.client
import win32gui

from dottie_verifier.paths import normalize, strip_extended_prefix
from dottie_verifier.winapi import (
    MonitorInfo,
    Rect,
    ShellWindowEntry,
    ShellWindowList,
    WindowState,
)

# Failures of one COM/UIA read are recorded as "no observation", never raised past the verifier.
# pywin32 raises pywintypes.com_error; comtypes (pywinauto UIA) raises _ctypes.COMError; a stale or
# half-initialized shell item can surface as AttributeError/TypeError/ValueError/OSError.
COM_ERRORS: tuple[type[BaseException], ...] = (
    pywintypes.com_error, ctypes.COMError, AttributeError, TypeError, ValueError, OSError)
UIA_ERRORS: tuple[type[BaseException], ...] = (*COM_ERRORS, NotImplementedError, RuntimeError)

log = logging.getLogger(__name__)
user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32")
ole32 = ctypes.WinDLL("ole32")
dwmapi = ctypes.WinDLL("dwmapi")
shcore = ctypes.WinDLL("shcore")

GA_ROOT = 2
SW_RESTORE = 9
MONITOR_DEFAULTTONULL = 0
DWMWA_EXTENDED_FRAME_BOUNDS = 9
DWMWA_CLOAKED = 14
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)
MDT_EFFECTIVE_DPI = 0
SID_STopLevelBrowser = "{4C96BE40-915C-11CF-99D3-00AA004AE837}"
IID_IShellBrowser = "{000214E2-0000-0000-C000-000000000046}"

user32.GetAncestor.restype = wt.HWND
user32.GetForegroundWindow.restype = wt.HWND
user32.MonitorFromWindow.restype = wt.HMONITOR
user32.WindowFromPoint.restype = wt.HWND
user32.WindowFromPoint.argtypes = [wt.POINT]
user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
user32.AreDpiAwarenessContextsEqual.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
kernel32.CreateFileW.restype = wt.HANDLE


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


def _guid(text: str) -> GUID:
    g = GUID()
    hr = ole32.CLSIDFromString(ctypes.c_wchar_p(text), ctypes.byref(g))
    if hr != 0:
        raise OSError(f"CLSIDFromString failed: {hr:#x}")
    return g


@contextmanager
def _com():
    pythoncom.CoInitialize()
    try:
        yield
    finally:
        pythoncom.CoUninitialize()


def _hwnd(value) -> int:
    return int(value or 0)


class Win32Api:
    # -- known folders / paths -------------------------------------------
    def get_known_folder_path(self, folder_id: str) -> str | None:
        ptr = ctypes.c_wchar_p()
        hr = shell32.SHGetKnownFolderPath(ctypes.byref(_guid(folder_id)), 0, None,
                                          ctypes.byref(ptr))
        try:
            if hr != 0:
                raise OSError(f"SHGetKnownFolderPath {folder_id} failed: {hr & 0xFFFFFFFF:#x}")
            return ptr.value
        finally:
            ole32.CoTaskMemFree(ptr)

    def final_path(self, path: str) -> str | None:
        handle = kernel32.CreateFileW(path, 0, 0x7, None, OPEN_EXISTING,
                                      FILE_FLAG_BACKUP_SEMANTICS, None)
        if not handle or handle == INVALID_HANDLE_VALUE:
            return None
        try:
            buf = ctypes.create_unicode_buffer(32768)
            n = kernel32.GetFinalPathNameByHandleW(handle, buf, len(buf), 0)
            return strip_extended_prefix(buf.value) if n else None
        finally:
            kernel32.CloseHandle(handle)

    def path_is_dir(self, path: str) -> bool:
        import os
        return os.path.isdir(path)

    # -- windows -----------------------------------------------------------
    def window_state(self, hwnd: int) -> WindowState:
        if not user32.IsWindow(hwnd):
            return WindowState(hwnd=hwnd, exists=False)
        cls = ctypes.create_unicode_buffer(257)
        class_name = cls.value if user32.GetClassNameW(hwnd, cls, 257) else None
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        pid = wt.DWORD()
        thread_id = user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        # Unreadable identity fields stay None (never 0): a 0 thread id or pid means the read
        # failed, and pid 0 is the System Idle Process, never a window owner.
        owner = pid.value if thread_id and pid.value else None
        image = ""
        start_time = None
        proc = (kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, owner)
                if owner else None)
        if proc:
            try:
                buf = ctypes.create_unicode_buffer(1024)
                size = wt.DWORD(len(buf))
                if kernel32.QueryFullProcessImageNameW(proc, 0, buf, ctypes.byref(size)):
                    image = buf.value
                created, exited, kern, user = (wt.FILETIME(), wt.FILETIME(), wt.FILETIME(),
                                               wt.FILETIME())
                if kernel32.GetProcessTimes(proc, ctypes.byref(created), ctypes.byref(exited),
                                            ctypes.byref(kern), ctypes.byref(user)):
                    ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
                    start_time = ticks or None          # 0 = not a real creation time
            finally:
                kernel32.CloseHandle(proc)
        # Observations fail closed (CONTRACTS §5): a failed read is None, never a default.
        cloaked_raw = wt.DWORD()
        hr = dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked_raw), 4)
        cloaked = bool(cloaked_raw.value) if hr == 0 else None
        r = wt.RECT()
        rect_ok = dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r),
                                               ctypes.sizeof(r)) == 0
        if not rect_ok:
            rect_ok = bool(user32.GetWindowRect(hwnd, ctypes.byref(r)))
        dpi = int(user32.GetDpiForWindow(hwnd)) or None     # 0 = failure; no 96 fallback
        mon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL)
        return WindowState(
            hwnd=hwnd, exists=True, visible=bool(user32.IsWindowVisible(hwnd)),
            minimized=bool(user32.IsIconic(hwnd)), cloaked=cloaked,
            class_name=class_name, pid=owner, process_image=image,
            rect=Rect(r.left, r.top, r.right, r.bottom) if rect_ok else None,
            monitor=_hwnd(mon) or None, dpi=dpi, title=title.value,
            process_start_time=start_time)

    def foreground_window(self) -> int:
        return _hwnd(user32.GetForegroundWindow())

    def root_window(self, hwnd: int) -> int:
        return _hwnd(user32.GetAncestor(hwnd, GA_ROOT)) if hwnd else 0

    def top_level_windows(self) -> list[int]:
        out: list[int] = []
        win32gui.EnumWindows(lambda h, _: out.append(int(h)) or True, None)
        return out

    def window_from_point(self, x: int, y: int) -> int:
        return _hwnd(user32.WindowFromPoint(wt.POINT(x, y)))

    def process_dpi_awareness(self) -> str:
        ctx = user32.GetThreadDpiAwarenessContext()
        if user32.AreDpiAwarenessContextsEqual(ctx, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2):
            return "per_monitor_v2"
        return {0: "unaware", 1: "system", 2: "per_monitor"}.get(
            user32.GetAwarenessFromDpiAwarenessContext(ctypes.c_void_p(ctx)), "unknown")

    def monitors(self) -> list[MonitorInfo]:
        import win32api
        out = []
        for handle, _dc, _rect in win32api.EnumDisplayMonitors():
            info = win32api.GetMonitorInfo(handle)
            dx, dy = ctypes.c_uint(), ctypes.c_uint()
            dpi = None                      # unreadable: no 96 fallback (CONTRACTS §5)
            hr = shcore.GetDpiForMonitor(int(handle), MDT_EFFECTIVE_DPI, ctypes.byref(dx),
                                         ctypes.byref(dy))
            if hr == 0 and dx.value:
                dpi = dx.value
            out.append(MonitorInfo(int(handle), info["Device"], Rect(*info["Monitor"]),
                                   Rect(*info["Work"]), dpi, bool(info["Flags"] & 1)))
        return out

    # -- Explorer via IShellWindows -----------------------------------------
    def _tab_hwnd(self, item) -> int | None:
        try:
            from win32com.shell import shell  # noqa: F401  (registers PyIShellBrowser)
            sp = item._oleobj_.QueryInterface(pythoncom.IID_IServiceProvider)
            browser = sp.QueryService(pythoncom.MakeIID(SID_STopLevelBrowser),
                                      pythoncom.MakeIID(IID_IShellBrowser))
            return int(browser.GetWindow())
        except COM_ERRORS:
            return None

    def shell_windows(self) -> ShellWindowList:
        """Every IShellWindows entry. A skipped entry (unreadable HWND/FullName) or a failed
        enumeration makes the result ``complete=False``; callers then fail closed."""
        out: list[ShellWindowEntry] = []
        skipped = 0
        try:
            with _com():
                for w in win32com.client.Dispatch("Shell.Application").Windows():
                    try:
                        hwnd, full = int(w.HWND), str(w.FullName)
                    except COM_ERRORS:
                        log.debug("shell window without HWND/FullName skipped", exc_info=True)
                        skipped += 1
                        continue
                    try:
                        folder = str(w.Document.Folder.Self.Path)
                    except COM_ERRORS:
                        folder = ""
                    url = name = ""
                    with suppress(*COM_ERRORS):
                        url, name = str(w.LocationURL), str(w.LocationName)
                    out.append(ShellWindowEntry(hwnd, self._tab_hwnd(w), full, folder, url, name))
        except COM_ERRORS:
            log.debug("IShellWindows enumeration failed", exc_info=True)
            return ShellWindowList(out, complete=False, skipped=skipped + 1)
        return ShellWindowList(out, complete=skipped == 0, skipped=skipped)

    def active_tab(self, hwnd: int) -> int | None:
        # The topmost ShellTabWindowClass child is the active tab (Win11 22H2+). Validate per build.
        tab = win32gui.FindWindowEx(hwnd, 0, "ShellTabWindowClass", None)
        return int(tab) if tab else None

    def uia_address_value(self, hwnd: int) -> str | None:
        """Experimental: read an absolute path from the address bar. Returns None if unsure."""
        try:
            from pywinauto import Desktop
        except ImportError:
            return None
        win = Desktop(backend="uia").window(handle=hwnd)
        for ctrl in win.descendants(control_type="Edit"):
            try:
                value = ctrl.get_value()
            except UIA_ERRORS:
                value = ctrl.window_text()
            if value and normalize(value):
                return value
        for bar in win.descendants(control_type="ToolBar"):
            text = bar.window_text()
            if ": " in text and normalize(text.split(": ", 1)[1]):
                return text.split(": ", 1)[1]   # Win10 "Address: C:\..." (label is localized)
        return None

    # -- recovery primitives (HWND-targeted) ----------------------------------
    def restore_window(self, hwnd: int) -> bool:
        user32.ShowWindow(hwnd, SW_RESTORE)
        return not user32.IsIconic(hwnd)

    def set_foreground(self, hwnd: int) -> bool:
        # No AttachThreadInput / input-injection tricks: if Windows' foreground lock refuses,
        # EXP-07 stays failed and the report is honestly partial. (Needs E08 decision.)
        user32.SetForegroundWindow(hwnd)
        return self.root_window(self.foreground_window()) == hwnd

    def move_window_to_monitor(self, hwnd: int, monitor: int) -> bool:
        target = next((m for m in self.monitors() if m.handle == monitor), None)
        st = self.window_state(hwnd)
        if target is None or st.rect is None:
            return False
        w = min(st.rect.width, target.work_area.width - 100)
        h = min(st.rect.height, target.work_area.height - 100)
        user32.SetWindowPos(hwnd, None, target.work_area.left + 50, target.work_area.top + 50,
                            w, h, SWP_NOZORDER | SWP_NOACTIVATE)
        return _hwnd(user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL)) == monitor

    def shell_navigate(self, hwnd: int, target: str) -> bool:
        active = self.active_tab(hwnd)
        with _com():
            items = [w for w in win32com.client.Dispatch("Shell.Application").Windows()
                     if _safe_int(w, "HWND") == hwnd]
            if len(items) > 1 and active is not None:
                items = [w for w in items if self._tab_hwnd(w) == active]
            if len(items) != 1:
                return False   # ambiguous tab: never navigate a guessed tab
            items[0].Navigate2(target)
            return True


def _safe_int(obj, attr: str) -> int:
    try:
        return int(getattr(obj, attr))
    except COM_ERRORS:
        return 0
