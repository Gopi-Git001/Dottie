"""Keep the fake, the Protocol and the real Win32 backend in sync (the backend can't run here)."""

import ast
import pathlib
import sys

import pytest

from dottie_verifier.winapi import WindowsApi
from tests.fakes import FakeDesktop

PKG = pathlib.Path(__file__).resolve().parents[1] / "dottie_verifier"


def protocol_methods():
    return {n for n, v in vars(WindowsApi).items() if callable(v) and not n.startswith("_")}


def win32_methods():
    tree = ast.parse((PKG / "win32_backend.py").read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Win32Api")
    return {f.name for f in cls.body if isinstance(f,
                                                   ast.FunctionDef) and not f.name.startswith("_")}


def test_real_backend_implements_protocol():
    assert protocol_methods() <= win32_methods()


def test_fake_implements_protocol():
    missing = {m for m in protocol_methods() if not callable(getattr(FakeDesktop, m, None))}
    assert not missing


@pytest.mark.skipif(sys.platform == "win32", reason="guard only matters off Windows")
def test_backend_refuses_to_import_off_windows():
    with pytest.raises(ImportError):
        import dottie_verifier.win32_backend  # noqa: F401


def test_verifier_never_imports_e04_modules_at_import_time():
    for f in PKG.glob("*.py"):
        tree = ast.parse(f.read_text())
        top = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
        for node in top:
            mod = getattr(node, "module", None) or ""
            assert not mod.startswith("tools"), f"{f.name} imports E04 at module level"
