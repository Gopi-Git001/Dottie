"""E01 ruling 1y (CONTRACTS dottie-e01 c0b36d4) and E02 895676d display keys, for the P27 catalog."""
import json
import re

import pytest

from dottie_tools.reference.catalog import (CATALOG, HOST_CATALOG, TOOL_DISPLAY_KEYS, UI_ACTION_APP_KEYS,
                                            UI_ACTION_DISPLAY_KEYS, display_shape, is_ui_action_method,
                                            load_pinned, prefix_rule_violations)



def _cat(*entries):
    return {t: {"category": c, "scope": s} for t, c, s in entries}


# ------------------------------------------------------------------ the rule, on the real catalog(s)
def test_1y_host_catalog_complies_both_ways():
    assert prefix_rule_violations(CATALOG) == []
    assert prefix_rule_violations(load_pinned(json.dumps(HOST_CATALOG))) == []


def test_1y_every_desktop_control_tool_is_ui_or_window_and_vice_versa():
    for tool_id, e in CATALOG.items():
        assert (e["scope"] == "desktop.control") == is_ui_action_method(tool_id), tool_id
        if tool_id.startswith("app."):
            assert e["scope"] != "desktop.control", tool_id


# ------------------------------------------------------------------ negative fixtures: the test bites
@pytest.mark.parametrize("catalog,expected", [
    (_cat(("desktop.click", "local_change", "desktop.control")),
     [("desktop.click", "desktop_control_without_ui_or_window_prefix")]),
    (_cat(("explorer.close_window", "local_change", "desktop.control")),
     [("explorer.close_window", "desktop_control_without_ui_or_window_prefix")]),
    (_cat(("UI.click", "local_change", "desktop.control")),              # case matters
     [("UI.click", "desktop_control_without_ui_or_window_prefix")]),
    (_cat(("uiclick", "local_change", "desktop.control")),
     [("uiclick", "desktop_control_without_ui_or_window_prefix")]),
    (_cat(("ui.click", "local_change", "files.write")),
     [("ui.click", "ui_or_window_prefix_without_desktop_control")]),
    (_cat(("window.focus", "navigate", "files.navigate")),
     [("window.focus", "ui_or_window_prefix_without_desktop_control")]),
    (_cat(("app.launch", "local_change", "desktop.control")),
     [("app.launch", "desktop_control_without_ui_or_window_prefix"), ("app.launch", "app_is_not_desktop_control")]),
    (_cat(("app.terminate", "local_change", "desktop.control"), ("ui.type", "local_change", "desktop.control")),
     [("app.terminate", "desktop_control_without_ui_or_window_prefix"),
      ("app.terminate", "app_is_not_desktop_control")]),
    ({"ui.click": {"category": "local_change"}}, [("'ui.click'", "malformed")]),
    ("not a dict", [("<catalog>", "malformed")]),
], ids=["desktop_prefix", "explorer_prefix", "upper_UI", "no_dot", "ui_wrong_scope", "window_wrong_scope",
        "app_desktop_control", "mixed_one_bad", "no_scope", "malformed"])
def test_1y_negative_fixtures_are_caught(catalog, expected):
    assert prefix_rule_violations(catalog) == expected


def test_1y_compliant_fixture_with_all_three_families_passes():
    cat = _cat(("ui.click", "local_change", "desktop.control"), ("ui.type_text", "local_change", "desktop.control"),
               ("ui.press_key", "local_change", "desktop.control"), ("ui.invoke", "local_change", "desktop.control"),
               ("window.focus", "local_change", "desktop.control"), ("window.close", "local_change", "desktop.control"),
               ("window.move", "local_change", "desktop.control"), ("window.minimize", "local_change", "desktop.control"),
               ("window.maximize", "local_change", "desktop.control"),
               # app.control: E01-proposed scope, pending E08 co-sign; TEST-ONLY (no app.* tool in the pinned catalog)
               ("app.launch", "local_change", "app.control"), ("app.terminate", "local_change", "app.control"),
               ("explorer.open_known_folder", "navigate", "files.navigate"))
    assert prefix_rule_violations(cat) == []


RULING_1Z = re.compile(r"^(ui|window)\.[a-z][a-z0-9_]*$")       # E01 ruling 1z, verbatim


@pytest.mark.parametrize("m", ["ui.click", "window.minimize", "window.close", "ui.type_text", "ui.press_key2",
                               "ui.invoke", "window.move", "ui.a"])
def test_1z_positive_methods(m):
    assert is_ui_action_method(m) and RULING_1Z.match(m)
    assert prefix_rule_violations(_cat((m, "local_change", "desktop.control"))) == []


@pytest.mark.parametrize("m", ["ui.", "window.", "ui.Click", "ui.1x", "ui.click.extra", "ui.-x", "UI.click",
                               "uiclick", "window", "", "xui.click", " ui.click", "ui.click ", "ui.click\n",
                               "ui._x", "ui.cl-ick", "ui.clíck", "app.launch"])
def test_1z_negative_methods(m):
    assert not is_ui_action_method(m)
    assert not RULING_1Z.match(m) or m.endswith("\n")                 # Python $ matches before a final \n
    assert prefix_rule_violations(_cat((m, "local_change", "desktop.control"))) != []


@pytest.mark.parametrize("m", ["ui.", "window.", "ui.Click", "ui.1x", "ui.click.extra", "ui.-x"])
@pytest.mark.parametrize("scope", ["desktop.control", "files.write"])
def test_1z_malformed_ui_or_window_name_is_caught_whatever_the_scope(m, scope):
    assert prefix_rule_violations(_cat((m, "local_change", scope))) == [(m, "malformed_ui_action_method")]


# ------------------------------------------------------------------ display shape (E02 895676d keys)
def test_e02_tool_display_keys_verbatim():
    base = ["kind", "category", "method", "targetLabel"]
    assert {k: list(v) for k, v in TOOL_DISPLAY_KEYS.items()} == {
        "local_change": base + ["targets", "itemCount"],
        "delete": base + ["paths", "fileCount"],
        "overwrite": base + ["paths", "fileCount"],
        "external_send": base + ["recipients", "channel", "bodyUntrusted"],
        "external_upload": base + ["path", "destinationHost"],
        "purchase": base + ["merchant", "amount", "currency"],
        "install_or_elevate": base + ["package", "publisher", "version", "source"],
        "security_setting": base + ["setting", "currentValue", "newValue"],
    }
    assert UI_ACTION_DISPLAY_KEYS == ("kind", "category", "method", "app")
    assert UI_ACTION_APP_KEYS == ("appName", "windowTitle", "processImage")


def test_1z_delete_overwrite_always_paths_list_and_file_count_even_for_one_file():
    for c in ("delete", "overwrite"):
        keys = TOOL_DISPLAY_KEYS[c]
        assert "paths" in keys and "fileCount" in keys
        assert "path" not in keys and "targetLabel" in keys       # no single-path form, whatever the count
    cat = _cat(("files.delete_item", "delete", "files.write"), ("files.overwrite_file", "overwrite", "files.write"))
    for t in cat:
        assert set(("paths", "fileCount")) <= set(display_shape(t, cat)[1])


def test_e02_no_detail_slot_body_untrusted_and_file_count():
    every = {k for v in TOOL_DISPLAY_KEYS.values() for k in v} | set(UI_ACTION_DISPLAY_KEYS)
    assert "detail" not in every and "body" not in every and "summary" not in every
    assert "bodyUntrusted" in TOOL_DISPLAY_KEYS["external_send"]
    for c in ("delete", "overwrite"):
        assert "fileCount" in TOOL_DISPLAY_KEYS[c] and "itemCount" not in TOOL_DISPLAY_KEYS[c]
    assert "targetLabel" not in UI_ACTION_DISPLAY_KEYS                       # ruling 1v


def test_display_shape_per_catalog_entry():
    cat = _cat(("ui.click", "local_change", "desktop.control"), ("window.close", "local_change", "desktop.control"),
               ("app.launch", "local_change", "app.control"), ("files.delete_item", "delete", "files.write"),
               ("mail.send", "external_send", "mail.send"), ("explorer.open_known_folder", "navigate", "files.navigate"),
               ("files.list_dir", "read", "files.read"), ("vault.read", "credential_access", "credentials.access"))
    assert display_shape("ui.click", cat)[0] == "ui_action"
    assert display_shape("window.close", cat)[0] == "ui_action"
    assert display_shape("app.launch", cat) == ("tool", TOOL_DISPLAY_KEYS["local_change"])   # app.* is kind tool
    assert display_shape("files.delete_item", cat) == ("tool", TOOL_DISPLAY_KEYS["delete"])
    assert display_shape("mail.send", cat)[1][-1] == "bodyUntrusted"
    for t in ("explorer.open_known_folder", "files.list_dir", "vault.read", "unknown.tool"):
        assert display_shape(t, cat) is None
    assert display_shape("explorer.open_known_folder") is None           # our only tool: navigate, no dialog
