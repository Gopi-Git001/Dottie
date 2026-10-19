"""E01 ruling 2a (DOT-090 item 10, doc test K-12): packages/contracts/tool-catalog.json is hash-pinned by
packages/contracts/tool-catalog.json.sha256 in exact `sha256sum` format; the pin is over the RAW file bytes, so any
change to the catalog (even whitespace) without updating the pin fails. CODEOWNERS for both files: E08 + E01."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

import pytest

from dottie_tools.reference.catalog import PINNED_CATALOG_PATH, REPO_ROOT, load_pinned_file

PIN_PATH = PINNED_CATALOG_PATH + ".sha256"
PIN_LINE = re.compile(r"([0-9a-f]{64})  ([^\s]+)\n")   # no spaces, \r or tabs in the path
STALE = Path(__file__).parent / "fixtures" / "catalog-pin-stale"


def pin_problems(catalog_bytes: bytes, pin_bytes: bytes) -> list[str]:
    """Why ``pin_bytes`` does not pin ``catalog_bytes`` (empty = OK)."""
    try:
        text = pin_bytes.decode("ascii")
    except UnicodeDecodeError:
        return ["pin_not_ascii"]
    m = PIN_LINE.fullmatch(text)
    if m is None:
        return ["pin_format"]                       # one line, 64 lowercase hex, two spaces, path, trailing \n
    out = []
    if m.group(2) != PINNED_CATALOG_PATH:
        out.append("pin_path")
    if m.group(1) != hashlib.sha256(catalog_bytes).hexdigest():
        out.append("hash_mismatch")
    return out


def test_k12_pinned_catalog_matches_its_pin():
    cat = (REPO_ROOT / PINNED_CATALOG_PATH).read_bytes()
    pin = (REPO_ROOT / PIN_PATH).read_bytes()
    assert pin_problems(cat, pin) == [], "tool-catalog.json changed without updating tool-catalog.json.sha256"


def test_k12_pin_file_format_is_exact_sha256sum():
    pin = (REPO_ROOT / PIN_PATH).read_bytes()
    assert pin.count(b"\n") == 1 and pin.endswith(b"\n") and b"\r" not in pin
    digest, sep, path = pin[:64], pin[64:66], pin[66:-1]
    assert re.fullmatch(rb"[0-9a-f]{64}", digest) and sep == b"  "
    assert path == b"packages/contracts/tool-catalog.json" and (REPO_ROOT / path.decode()).is_file()


def test_k12_stale_pin_fixture_fails():
    """Negative fixture: a modified catalog copy + the OLD pin -> hash_mismatch."""
    cat, pin = (STALE / "tool-catalog.json").read_bytes(), (STALE / "tool-catalog.json.sha256").read_bytes()
    assert pin == (REPO_ROOT / PIN_PATH).read_bytes()                     # really the old (current) pin
    assert cat != (REPO_ROOT / PINNED_CATALOG_PATH).read_bytes()
    assert pin_problems(cat, pin) == ["hash_mismatch"]


@pytest.mark.parametrize("mutate", [
    lambda b: b + b"\n", lambda b: b.replace(b" ", b"  ", 1), lambda b: b.rstrip(b"\n"),
    lambda b: b.replace(b"\n", b"\r\n"),
], ids=["trailing_newline", "whitespace", "strip_newline", "crlf"])
def test_k12_any_raw_byte_change_fails(mutate):
    cat = (REPO_ROOT / PINNED_CATALOG_PATH).read_bytes()
    assert pin_problems(mutate(cat), (REPO_ROOT / PIN_PATH).read_bytes()) == ["hash_mismatch"]


@pytest.mark.parametrize("bad,why", [
    (lambda p: p.upper(), "pin_format"),                                   # uppercase hex (and path)
    (lambda p: p.rstrip(b"\n"), "pin_format"),                             # no trailing newline
    (lambda p: p + p, "pin_format"),                                       # two lines
    (lambda p: p.replace(b"  ", b" ", 1), "pin_format"),                   # one space
    (lambda p: p.replace(b"  ", b" *", 1), "pin_format"),                  # binary-mode marker
    (lambda p: p[1:], "pin_format"),                                       # 63 hex
    (lambda p: p.replace(b"\n", b"\r\n"), "pin_format"),
    (lambda p: p.replace(b"packages/contracts/", b"./packages/contracts/"), "pin_path"),
    (lambda p: p.replace(b"packages/contracts/tool-catalog.json", b"/workspace/x/tool-catalog.json"), "pin_path"),
    (lambda p: p.replace(b"  ", b"  \xe2\x80\x8b", 1), "pin_not_ascii"),
], ids=["upper", "no_newline", "two_lines", "one_space", "binary_star", "short_hex", "crlf", "dot_slash",
        "abs_path", "non_ascii"])
def test_k12_bad_pin_files_are_rejected(bad, why):
    cat = (REPO_ROOT / PINNED_CATALOG_PATH).read_bytes()
    assert why in pin_problems(cat, bad((REPO_ROOT / PIN_PATH).read_bytes()))


def test_k12_sha256sum_c_from_repo_root():
    r = subprocess.run(["sha256sum", "-c", PIN_PATH], cwd=REPO_ROOT, capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout == f"{PINNED_CATALOG_PATH}: OK\n", r


def test_k12_sha256sum_c_fails_on_the_stale_fixture(tmp_path):
    (tmp_path / "packages/contracts").mkdir(parents=True)
    (tmp_path / PINNED_CATALOG_PATH).write_bytes((STALE / "tool-catalog.json").read_bytes())
    (tmp_path / PIN_PATH).write_bytes((STALE / "tool-catalog.json.sha256").read_bytes())
    r = subprocess.run(["sha256sum", "-c", PIN_PATH], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode != 0 and "FAILED" in r.stdout


def test_pinned_catalog_has_no_app_tools():
    """app.control is an E01-proposed scope pending E08 co-sign: TEST-ONLY; no app.* tool is pinned."""
    pinned = load_pinned_file()
    assert not any(t.startswith("app.") for t in pinned)
    assert all(e["scope"] != "app.control" for e in pinned.values())
    assert b"app.control" not in (REPO_ROOT / PINNED_CATALOG_PATH).read_bytes()
