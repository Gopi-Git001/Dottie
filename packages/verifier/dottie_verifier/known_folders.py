"""Known Folder resolution. Always SHGetKnownFolderPath; never %USERPROFILE%\\Downloads guesses."""

from __future__ import annotations

from dataclasses import dataclass

from dottie_verifier.winapi import WindowsApi

FOLDERID = {
    "downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
    "documents": "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}",
    "desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
    "pictures": "{33E28130-4E1E-4676-835A-98395C3BC3BB}",
    "music": "{4BD8D571-6D19-48D3-BE97-422220080E43}",
    "videos": "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}",
}


@dataclass(frozen=True)
class ResolvedFolder:
    name: str
    folder_id: str
    path: str | None
    final_path: str | None
    exists: bool
    error: str = ""

    def evidence(self) -> dict:
        return {
            "known_folder": self.name,
            "folder_id": self.folder_id,
            "expected_path": self.path,
            "expected_final_path": self.final_path,
            "expected_exists": self.exists,
            **({"error": self.error} if self.error else {}),
        }


def resolve_known_folder(api: WindowsApi, name: str) -> ResolvedFolder:
    folder_id = FOLDERID[name]
    try:
        path = api.get_known_folder_path(folder_id)
    except Exception as exc:  # noqa: BLE001 - recorded as evidence
        return ResolvedFolder(name, folder_id, None, None, False,
                              f"SHGetKnownFolderPath failed: {exc}")
    if not path:
        return ResolvedFolder(name, folder_id, None, None, False,
                              "SHGetKnownFolderPath returned nothing")
    try:
        final = api.final_path(path)
    except Exception:  # noqa: BLE001
        final = None
    return ResolvedFolder(name, folder_id, path, final, api.path_is_dir(path))
