"""Tool catalog (DOT-092 DRAFT 4 §4.0, E08 X2). Categories come ONLY from the E08-reviewed catalog pinned
in packages/contracts; the host's own list is a copy that is checked against it.

* ``HOST_CATALOG``: what this host declares in ``hello.catalog`` ({toolId, category, scope}; no ``mutating``
  field: needs-confirm/mutating is DERIVED from the category, E-P6 kept by X2).
* ``check_hello_catalog(declared, pinned)``: exact equality (same entries, no duplicates, no extra keys).
  Any difference, or no readable pinned catalog, refuses the host: PRECONDITION_FAILED for every call.
* ``category_of(tool_id, pinned)``: from the PINNED catalog. A tool missing from it, or an unknown or odd
  category, is None = needs-confirm and mutating. Never raises.
* No-confirm categories: ``navigate`` (closed membership, E08 sign-off) and ``read`` in scope (ADR-0009
  item 8). No-confirm is not "no side effect": only ``read`` has mayHaveSideEffects false.
* ``PINNED_CATALOG_PATH`` is the pinned file, ``packages/contracts/tool-catalog.json`` (E01 rulings 1z/1z.1; E04
  creates it, E08 required reviewer, E01 contract approval). ``CATALOG`` is loaded from it; test-only entries
  live in ``tests/fixtures/tool-catalog.test-only.json``, never in the pinned file.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

NO_CONFIRM = frozenset({"read", "navigate"})
KNOWN_CATEGORIES = frozenset({"read", "navigate", "local_change", "overwrite", "delete", "external_send",
                              "external_upload", "purchase", "install_or_elevate", "security_setting",
                              "credential_access"})
PINNED_CATALOG_PATH = "packages/contracts/tool-catalog.json"     # E01 ruling 1z; owned by E08/E01
HOST_CATALOG = [{"toolId": "explorer.open_known_folder", "category": "navigate", "scope": "files.navigate"}]
_ENTRY_KEYS = {"toolId", "category", "scope"}


def _entries(obj: object) -> list[tuple[str, str, str]] | None:
    """Validated entry tuples, or None if anything is off (shape, types, extra keys, duplicates)."""
    if not isinstance(obj, list):
        return None
    out = []
    for e in obj:
        if not isinstance(e, dict) or set(e) != _ENTRY_KEYS or not all(type(e[k]) is str for k in _ENTRY_KEYS):
            return None
        out.append((e["toolId"], e["category"], e["scope"]))
    if len({t for t, _, _ in out}) != len(out):
        return None
    return out


def load_pinned(text: object) -> dict | None:
    """Parse the pinned catalog file text ([{toolId, category, scope}, ...]). Never raises; None = refuse."""
    try:
        obj = json.loads(text) if isinstance(text, (str, bytes)) else None
    except (ValueError, RecursionError):
        return None
    ents = _entries(obj)
    if ents is None:
        return None
    return {t: {"category": c, "scope": s} for t, c, s in ents}


REPO_ROOT = Path(__file__).resolve().parents[5]


def load_pinned_file(path: object = None) -> dict | None:
    """Read and parse the pinned catalog (default ``REPO_ROOT / PINNED_CATALOG_PATH``). Never raises; None = refuse."""
    try:
        text = Path(path if path is not None else REPO_ROOT / PINNED_CATALOG_PATH).read_bytes()
    except (OSError, TypeError, ValueError):
        return None
    return load_pinned(text)


# The host's pinned catalog, loaded from the real file. Unreadable -> {} (fail closed: every tool is missing, so
# the host refuses with catalog_mismatch and K8 treats it as needs-confirm).
CATALOG: dict = load_pinned_file() or {}


def check_hello_catalog(declared: object, pinned: object) -> tuple[bool, str]:
    """X2: hello.catalog must EQUAL the pinned catalog. -> (ok, reason)."""
    if not isinstance(pinned, dict):
        return False, "pinned_catalog_unavailable"
    ents = _entries(declared)
    if ents is None:
        return False, "catalog_malformed"
    want = set()
    for t, e in pinned.items():
        if not isinstance(e, dict):
            return False, "pinned_catalog_unavailable"
        want.add((t, e.get("category"), e.get("scope")))
    return (True, "ok") if set(ents) == want else (False, "catalog_mismatch")


def category_of(tool_id: object, catalog: object = None) -> str | None:
    """From the pinned catalog (default: the pinned file). Never raises: odd input -> None (= mutating)."""
    cat_map = CATALOG if catalog is None else catalog
    if not isinstance(tool_id, str) or not isinstance(cat_map, dict):
        return None
    entry = cat_map.get(tool_id)
    if not isinstance(entry, dict):
        return None
    cat = entry.get("category")
    return cat if isinstance(cat, str) and cat in KNOWN_CATEGORIES else None


def needs_approval(tool_id: str, catalog: dict | None = None) -> bool:
    return category_of(tool_id, catalog) not in NO_CONFIRM


def may_have_side_effects(tool_id: str, catalog: dict | None = None) -> bool:
    return category_of(tool_id, catalog) != "read"


def hello_catalog(catalog: dict | None = None) -> list[dict]:
    """hello.catalog entries {toolId, category, scope}; no `mutating` field (X2, H-12). Never raises."""
    out = []
    cat_map = CATALOG if catalog is None else catalog
    if not isinstance(cat_map, dict):
        return out
    for tool_id, e in sorted(cat_map.items(), key=lambda kv: repr(kv[0])):
        cat = category_of(tool_id, cat_map)
        scope = e.get("scope") if isinstance(e, dict) else None
        out.append({"toolId": tool_id, "category": cat, "scope": scope if isinstance(scope, str) else None})
    return out


# ---------------------------------------------------------------- E01 ruling 1y: UI-action method prefixes
# CONTRACTS (dottie-e01 c0b36d4): UI-action methods are exactly `ui.*` (in-app control: click, type, key press,
# UIA invoke) and `window.*` (focus, close, move, minimize, maximize). Every desktop.control tool uses one of the
# two prefixes and no other tool may; `app.*` (launch, terminate) is not a UI action (display kind `tool`).
# Ruling 1z tightens the method to exactly ^(ui|window)\.[a-z][a-z0-9_]*$ (a bare `ui.` is not a method);
# E02 isUiActionMethod and E03 mirror it. Runtime enforcement (refusing to register a host tool that breaks the
# rule, policy.denied audit) is K8's (E08); E04 keeps the catalog-side test only.
UI_ACTION_METHOD_RE = re.compile(r"(ui|window)\.[a-z][a-z0-9_]*")    # used with fullmatch: no \n slip past $
UI_ACTION_SCOPE = "desktop.control"


def is_ui_action_method(method: object) -> bool:
    return isinstance(method, str) and UI_ACTION_METHOD_RE.fullmatch(method) is not None


def prefix_rule_violations(catalog: object) -> list[tuple[str, str]]:
    """Ruling 1y, both ways. -> [(toolId, rule)], empty when the catalog complies. Never raises; a catalog that
    isn't a {toolId: {category, scope}} dict is one violation ("malformed")."""
    if not isinstance(catalog, dict):
        return [("<catalog>", "malformed")]
    out = []
    for tool_id, e in catalog.items():
        scope = e.get("scope") if isinstance(e, dict) else None
        if not isinstance(tool_id, str) or not isinstance(scope, str):
            out.append((repr(tool_id), "malformed"))
            continue
        ui = is_ui_action_method(tool_id)
        if not ui and tool_id.startswith(("ui.", "window.")):
            out.append((tool_id, "malformed_ui_action_method"))       # `ui.`, `ui.Click`, `ui.a.b` (ruling 1z)
        elif scope == UI_ACTION_SCOPE and not ui:
            out.append((tool_id, "desktop_control_without_ui_or_window_prefix"))
        if ui and scope != UI_ACTION_SCOPE:
            out.append((tool_id, "ui_or_window_prefix_without_desktop_control"))
        if tool_id.startswith("app.") and scope == UI_ACTION_SCOPE:
            out.append((tool_id, "app_is_not_desktop_control"))
    return out


# ---------------------------------------------------------------- ApprovalDisplay shape per catalog entry
# K8 builds the display (CONTRACTS X5); E04 builds none. What the catalog fixes is WHICH display K8 must build
# for a tool: kind `ui_action` for a UI-action method, else kind `tool` with the category's keys. Key names are
# E02 895676d packages/contracts/src/display.ts DISPLAY_KEYS / TOOL_FIELD_KEYS (E01 1x/1y): no `detail` slot,
# external_send body is `bodyUntrusted`; delete/overwrite ALWAYS carry `paths[]` + `fileCount`, even for a
# single item (E01 ruling 1z; fileCount = String(len(paths))).
_TOOL_BASE = ("kind", "category", "method", "targetLabel")
TOOL_DISPLAY_KEYS = {
    "local_change": _TOOL_BASE + ("targets", "itemCount"),
    "delete": _TOOL_BASE + ("paths", "fileCount"),
    "overwrite": _TOOL_BASE + ("paths", "fileCount"),
    "external_send": _TOOL_BASE + ("recipients", "channel", "bodyUntrusted"),
    "external_upload": _TOOL_BASE + ("path", "destinationHost"),
    "purchase": _TOOL_BASE + ("merchant", "amount", "currency"),
    "install_or_elevate": _TOOL_BASE + ("package", "publisher", "version", "source"),
    "security_setting": _TOOL_BASE + ("setting", "currentValue", "newValue"),
}
UI_ACTION_DISPLAY_KEYS = ("kind", "category", "method", "app")
UI_ACTION_APP_KEYS = ("appName", "windowTitle", "processImage")
NO_DIALOG = frozenset({"read", "navigate", "credential_access"})


def display_shape(tool_id: object, catalog: object = None) -> tuple[str, tuple[str, ...]] | None:
    """(kind, top-level keys) K8 must use for this tool's approval display, or None = no dialog (read, navigate,
    credential_access) or not displayable (unknown tool or category -> display_unavailable). Never raises."""
    cat = category_of(tool_id, catalog)
    if cat is None or cat in NO_DIALOG:
        return None
    if is_ui_action_method(tool_id):
        return "ui_action", UI_ACTION_DISPLAY_KEYS
    keys = TOOL_DISPLAY_KEYS.get(cat)
    return ("tool", keys) if keys else None
