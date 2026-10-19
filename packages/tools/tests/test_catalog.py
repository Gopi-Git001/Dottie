"""DOT-092 DRAFT 4 §4.0 + E08 X2: categories come from the E08-reviewed catalog pinned in packages/contracts;
hello.catalog is a copy-check (any difference refuses the host); no `mutating` field (H-12)."""
import json
from pathlib import Path

import pytest

from dottie_tools.reference.approval import FakeAuthorizer
from dottie_tools.reference.catalog import (CATALOG, HOST_CATALOG, PINNED_CATALOG_PATH, REPO_ROOT,
                                            load_pinned_file, check_hello_catalog, hello_catalog, load_pinned,
                                            may_have_side_effects, needs_approval)
from dottie_tools.reference.catalog import prefix_rule_violations
from dottie_tools.targets import HostContext

# CONTRACTS CapabilityScope = the ADR-0009 scope list (~L213)
RULED_SCOPES = {"files.read", "files.navigate", "files.write", "shell.execute", "desktop.control",
                "browser.navigate", "network.send", "app.install", "credentials.access", "purchases"}

PINNED_TEXT = (REPO_ROOT / PINNED_CATALOG_PATH).read_bytes()     # THE pinned file (E01 1z/1z.1)


def test_cat01_open_known_folder_is_navigate_no_confirm_but_has_side_effects():
    pinned = load_pinned(PINNED_TEXT)
    assert needs_approval("explorer.open_known_folder", pinned) is False
    assert may_have_side_effects("explorer.open_known_folder", pinned) is True
    assert hello_catalog() == HOST_CATALOG == [{"toolId": "explorer.open_known_folder", "category": "navigate",
                                                "scope": "files.navigate"}]


def test_h12_hello_catalog_has_no_mutating_field_and_equals_the_pinned_copy():
    assert all(set(e) == {"toolId", "category", "scope"} for e in hello_catalog())
    assert check_hello_catalog(hello_catalog(), load_pinned(PINNED_TEXT)) == (True, "ok")


@pytest.mark.parametrize("declared,reason", [
    ([{"toolId": "explorer.open_known_folder", "category": "read", "scope": "files.navigate"}], "catalog_mismatch"),
    ([{"toolId": "explorer.open_known_folder", "category": "navigate", "scope": "files.read"}], "catalog_mismatch"),
    (HOST_CATALOG + [{"toolId": "window.close", "category": "navigate", "scope": "desktop.control"}], "catalog_mismatch"),
    ([], "catalog_mismatch"),
    (HOST_CATALOG * 2, "catalog_malformed"),
    ([{**HOST_CATALOG[0], "mutating": False}], "catalog_malformed"),
    ([{"toolId": "explorer.open_known_folder", "category": "navigate"}], "catalog_malformed"),
    ("not a list", "catalog_malformed"), (None, "catalog_malformed"),
], ids=["self_declared_read", "scope", "extra_tool_claims_navigate", "empty", "duplicate", "mutating_key",
        "missing_scope", "str", "none"])
def test_x2_any_difference_from_the_pinned_catalog_refuses_the_host(declared, reason):
    assert check_hello_catalog(declared, load_pinned(PINNED_TEXT)) == (False, reason)


@pytest.mark.parametrize("text", ["", "{", "[1]", '[{"toolId": 1, "category": "read", "scope": "x"}]',
                                  "[" * 100_000, None, b"\xff"])
def test_x2b_unreadable_pinned_catalog_refuses(text):
    assert load_pinned(text) is None
    assert check_hello_catalog(HOST_CATALOG, load_pinned(text)) == (False, "pinned_catalog_unavailable")


def test_x2c_refused_host_gets_precondition_failed_for_every_call():
    a = FakeAuthorizer()
    a.context = HostContext("task-1", "thr-1", "turn-1")
    a.catalog_ok = check_hello_catalog([{**HOST_CATALOG[0], "category": "read"}], load_pinned(PINNED_TEXT))[0]
    r = a.authorize("explorer.open_known_folder", {"folder": "downloads"})
    assert r.code == "PRECONDITION_FAILED" and r.reason == "catalog_mismatch"


def test_cat02_tool_missing_from_the_pinned_catalog_is_needs_confirm_and_mutating():
    pinned = load_pinned(PINNED_TEXT)
    assert needs_approval("window.close", pinned) is True and may_have_side_effects("window.close", pinned) is True


def test_cat03_read_needs_no_approval_and_no_side_effect():
    cat = {"files.list_dir": {"category": "read", "scope": "files.read"}}
    assert needs_approval("files.list_dir", cat) is False and may_have_side_effects("files.list_dir", cat) is False


def test_cat04_local_change_needs_approval_derived_from_the_category():
    cat = {"window.close": {"category": "local_change", "scope": "desktop.control"}}
    assert needs_approval("window.close", cat) is True and "mutating" not in hello_catalog(cat)[0]


# ------------------------------------------------------------------ the real pinned file (E01 1z.1)
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "tool-catalog.test-only.json").read_text())


def _tuples(entries):
    return {(e["toolId"], e["category"], e["scope"]) for e in entries}


def test_pinned_file_exists_parses_and_is_what_the_host_loads():
    assert PINNED_CATALOG_PATH == "packages/contracts/tool-catalog.json"
    pinned = load_pinned_file()
    assert pinned is not None and pinned == CATALOG == load_pinned(PINNED_TEXT)
    assert pinned == {"explorer.open_known_folder": {"category": "navigate", "scope": "files.navigate"}}
    assert check_hello_catalog(HOST_CATALOG, pinned) == (True, "ok")


def fixture_leaks(raw: str) -> list:
    """Why ``raw`` (pinned-file text) is not clean: fixture markers or fixture entries in it."""
    out = [m for m in ("_fixture", "TEST-ONLY", "test-only", "test_only") if m in raw]
    fixture_entries = _tuples(e for cat in FIXTURE["catalogs"].values() for e in cat)
    out += sorted(_tuples(json.loads(raw)) & fixture_entries)
    return out


def test_pinned_file_holds_no_fixture_marked_entries():
    assert FIXTURE["_fixture"].startswith("TEST-ONLY") and FIXTURE["catalogs"]["mutating"]
    assert fixture_leaks(PINNED_TEXT.decode("utf-8")) == []


def test_pinned_file_passes_the_1y_1z_prefix_checks():
    pinned = load_pinned_file()
    assert prefix_rule_violations(pinned) == []
    assert all(e["scope"] in RULED_SCOPES for e in pinned.values())        # ADR-0009 CapabilityScope list


def test_unreadable_pinned_file_refuses(tmp_path):
    (tmp_path / "bad.json").write_text("{")
    for bad in (tmp_path / "missing.json", tmp_path, tmp_path / "bad.json", 7):
        assert load_pinned_file(bad) is None


@pytest.mark.parametrize("polluted", [
    lambda pinned, fx: pinned + fx["catalogs"]["mutating"],
    lambda pinned, fx: pinned + [{"toolId": "x.y", "category": "read", "scope": "files.read", "_fixture": "t"}],
], ids=["fixture_entry", "fixture_marker"])
def test_the_fixture_check_bites(polluted):
    raw = json.dumps(polluted(json.loads(PINNED_TEXT), FIXTURE))
    assert fixture_leaks(raw) != []
