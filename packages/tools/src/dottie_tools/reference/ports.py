"""Windows seam for explorer.open_known_folder (E04 plan (c) platform/ports.py). Mocked in tests."""
from __future__ import annotations

from typing import Protocol

EXPLORER_CLASS = "CabinetWClass"


class WindowGone(Exception):
    """The HWND no longer names a live window (IsWindow false / COM entry vanished)."""


from dottie_tools.targets import WindowIdentity  # noqa: E402,F401  four-field identity (hwnd, pid, window_class, process_start_time)


class ExplorerPort(Protocol):
    def top_level_explorer_hwnds(self) -> list[int]: ...             # IShellWindows top-level HWNDs (GA_ROOT), deduped
    def read_fields(self, hwnd: int): ...                             # (pid|None, class|None, FILETIME|None) or None if gone
    def process_image_name(self, pid: int) -> str | None: ...
    def is_cloaked(self, hwnd: int) -> bool | None: ...                # DWMWA_CLOAKED; None = unreadable (-> not actionable)
    def window_dpi(self, hwnd: int) -> int | None: ...                 # GetDpiForWindow; None = unreadable (never 96)
    def explorer_windows(self) -> list[WindowIdentity]: ...          # identified windows only (registry.live_identities)
    def foreground_root(self) -> int | None: ...                      # GetAncestor(GetForegroundWindow(), GA_ROOT)
    def active_tab_path(self, hwnd: int) -> str | None: ...           # Document.Folder.Self.Path of the ACTIVE tab; raises WindowGone
    def navigate_active_tab(self, hwnd: int, path: str) -> None: ...  # IWebBrowser2.Navigate2 on the active tab; raises WindowGone
    def launch_explorer(self, argv: list[str]) -> None: ...           # CreateProcess with a fixed argv [explorer.exe, path]; never a shell string
    def folder_exists(self, path: str) -> bool: ...
    def is_network_path(self, path: str) -> bool: ...                 # UNC or a remote drive (GetDriveTypeW == DRIVE_REMOTE)
    def user_profile(self) -> str: ...                                # FOLDERID_Profile
    def known_folder(self, folder: str) -> str | None: ...            # SHGetKnownFolderPath(FOLDERID_*)
    def final_path(self, path: str) -> str: ...                       # GetFinalPathNameByHandle-normalised
