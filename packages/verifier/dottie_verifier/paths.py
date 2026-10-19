"""Windows path comparison that does not depend on the host OS.

Uses ``ntpath`` so the same rules run on the Linux CI box and on Windows.
Compares filesystem identity, never display names (localized names such as
"Téléchargements" are display strings and do not appear here).
"""

from __future__ import annotations

import ntpath
from collections.abc import Callable
from urllib.parse import unquote, urlparse

FinalPathResolver = Callable[[str], "str | None"]


def strip_extended_prefix(path: str) -> str:
    r"""Remove ``\\?\`` and ``\\?\UNC\`` prefixes that GetFinalPathNameByHandle returns."""
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[len("\\\\?\\UNC\\"):]
    if path.startswith("\\\\?\\"):
        return path[len("\\\\?\\"):]
    return path


def normalize(path: str) -> str:
    """Return a canonical, case-folded Windows path for comparison, or "" if not a filesystem
    path."""
    if not path:
        return ""
    raw = strip_extended_prefix(path.strip().strip('"'))
    if raw.startswith("::{") or raw.lower().startswith("shell:"):
        return ""  # virtual shell namespace item, not a filesystem folder
    raw = raw.replace("/", "\\")
    drive, _rest = ntpath.splitdrive(raw)
    if not drive:
        return ""  # relative paths are never accepted as evidence
    norm = ntpath.normpath(raw)
    if len(norm) > 3 and norm.endswith("\\"):
        norm = norm.rstrip("\\")
    if len(drive) == 2 and len(norm) == 2:  # "C:" -> "C:\"
        norm += "\\"
    return ntpath.normcase(norm)


def file_url_to_path(url: str) -> str:
    """Decode an IShellWindows LocationURL (file:///C:/x, file://server/share/x) to a Windows
    path."""
    if not url or not url.lower().startswith("file:"):
        return ""
    parsed = urlparse(url)
    path = unquote(parsed.path)
    if parsed.netloc and parsed.netloc.lower() != "localhost":
        return "\\\\" + parsed.netloc + path.replace("/", "\\")
    if path.startswith("/") and len(path) > 2 and path[2] == ":":
        path = path[1:]
    return path.replace("/", "\\")


def same_path(a: str, b: str, resolver: FinalPathResolver | None = None) -> bool:
    """True when ``a`` and ``b`` name the same folder.

    A textual match after normalization is enough. Otherwise, when a resolver is
    available (GetFinalPathNameByHandle on Windows), both sides are resolved to
    follow junctions, symlinks, 8.3 short names and redirected folders.
    """
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if resolver is None:
        return False
    ra, rb = resolver(a), resolver(b)
    if not ra or not rb:
        return False
    return normalize(ra) == normalize(rb)
