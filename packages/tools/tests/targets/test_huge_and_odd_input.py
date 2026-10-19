"""E11 bug report 2026-10-19: >4300-digit strings made int() raise a plain ValueError (CPython
int max-str-digits), escaping IdentityFormatError -> INVALID_ARGUMENT. Every parse path must map huge or
odd input to its own error type, never an unmapped exception."""
import json

import pytest

from dottie_tools.reference.approval import action_doc, action_id
from dottie_tools.reference.catalog import category_of, hello_catalog, needs_approval
from dottie_tools.targets import (CanonicalError, HostContext, IdentityFormatError, WindowIdentity, WindowRegistry,
                      canonical_json, is_well_formed_target_id, parse_canonical)

FT = 133_700_000_000_000_123
OK = {"hwnd": "4112", "pid": "700", "windowClass": "CabinetWClass", "processStartTime": str(FT)}
CTX = HostContext("task-1", "thr-1", "turn-1", "item-1", "req-1")
U64_MAX = str(2**64 - 1)                       # exactly 20 digits
HUGE = {"21-digit": "1" + "0" * 20, "4301-digit": "9" * 4301, "100k-digit": "7" * 100_000}
FIELDS = ["hwnd", "pid", "processStartTime"]


@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("label", list(HUGE))
def test_big01_overlong_numeric_strings_are_invalid_argument(field, label):
    with pytest.raises(IdentityFormatError) as e:
        WindowIdentity.from_wire({**OK, field: HUGE[label]})
    assert e.value.error_code == "INVALID_ARGUMENT"


@pytest.mark.parametrize("field", FIELDS)
def test_big01b_overlong_with_leading_garbage_is_still_invalid_argument(field):
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire({**OK, field: "0" + "9" * 5000})


@pytest.mark.parametrize("field", ["hwnd", "processStartTime"])
def test_big02_exactly_20_digit_max_u64_is_accepted_and_round_trips(field):
    assert len(U64_MAX) == 20
    ident = WindowIdentity.from_wire({**OK, field: U64_MAX})
    assert ident.to_wire()[field] == U64_MAX
    assert WindowIdentity.from_wire(ident.to_wire()) == ident


@pytest.mark.parametrize("field,value", [("hwnd", str(2**64)), ("processStartTime", str(2**64)),
                                         ("pid", str(2**32)), ("pid", U64_MAX)])
def test_big03_in_length_but_out_of_range_is_invalid_argument(field, value):
    assert len(value) <= 20
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire({**OK, field: value})


def test_big04_pid_max_u32_is_accepted():
    assert WindowIdentity.from_wire({**OK, "pid": str(2**32 - 1)}).pid == 2**32 - 1


@pytest.mark.parametrize("bad", ["Cabinet\ud800WClass", "\udfff"])
def test_odd01_lone_surrogate_window_class_is_invalid_argument(bad):
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire({**OK, "windowClass": bad})


@pytest.mark.parametrize("bad", ["c_" + "a" * 100_000, "c_" + "0" * 12 + "\n", "\uff43_000000000000",
                                 "c_\u0660" + "0" * 11, b"c_000000000000", None, 7,
                                 float("nan"), ["c_000000000000"], {"id": 1}])
def test_odd02_target_id_check_never_raises(bad):
    assert is_well_formed_target_id(bad) is False
    r = WindowRegistry().resolve(CTX, bad, [])
    assert r.error_code == "INVALID_ARGUMENT"


@pytest.mark.parametrize("text", [
    '{"a":' + "1" * 5000 + "}",                      # huge JSON int: CPython max-str-digits ValueError
    "[" * 100_000 + "]" * 100_000,                   # absurd nesting: RecursionError
    '{"a":"1"', "", "nul", '{"a":NaN}', '{"a":1e999}', '"\\ud800"', '{"a":"\\ud800"}',
])
def test_odd03_parse_canonical_maps_everything_to_canonical_error(text):
    with pytest.raises(CanonicalError):
        parse_canonical(text)


@pytest.mark.parametrize("bad", [None, 12, b"{}", ["{}"]])
def test_odd03b_parse_canonical_rejects_non_text(bad):
    with pytest.raises(CanonicalError):
        parse_canonical(bad)


def _deep(n):
    d = {"a": "x"}
    for _ in range(n):
        d = {"a": d}
    return d


@pytest.mark.parametrize("obj", [_deep(5000), {"a": "\ud800"}, {"\ud800": "x"}, {1: "x"}, {"a": 10**30}])
def test_odd04_canonical_json_maps_everything_to_canonical_error(obj):
    with pytest.raises(CanonicalError):
        canonical_json(obj)


@pytest.mark.parametrize("args", [{"folder": 2**20000}, {"folder": 3}, {"folder": b"x"},
                                  {1: "x"}, ["downloads"], {"folder": "\ud800"}])
def test_odd05_action_hash_maps_odd_args_to_canonical_error(args):
    with pytest.raises(CanonicalError):
        action_id("explorer.open_known_folder", args, None, CTX)


def test_odd05b_action_hash_of_max_identity_is_exact():
    big = WindowIdentity(2**64 - 1, 2**32 - 1, "C" * 256, 2**64 - 1)
    doc = json.loads(action_doc("m", {"folder": "downloads"}, big, CTX))
    assert doc["targets"]["window"]["hwnd"] == U64_MAX


@pytest.mark.parametrize("tool_id,catalog", [
    (["x"], None), ({"a": 1}, None), (None, None), ("x" * 100_000, None),
    ("x.y", {"x.y": None}), ("x.y", {"x.y": "navigate"}), ("x.y", {"x.y": {"category": ["read"]}}),
    ("x.y", {"x.y": {"category": {"read": 1}}}), ("x.y", ["not", "a", "dict"]), ("x.y", 42),
])
def test_odd06_catalog_never_raises_and_odd_input_is_treated_as_mutating(tool_id, catalog):
    assert category_of(tool_id, catalog) is None
    assert needs_approval(tool_id, catalog) is True


def test_odd06b_hello_catalog_survives_odd_entries():
    out = hello_catalog({"x.y": None, "a.b": {"category": ["read"], "scope": 5}, "c.d": {"category": "read"}})
    assert {e["toolId"]: e["category"] for e in out} == {"a.b": None, "c.d": "read", "x.y": None}
    assert all("mutating" not in e for e in out)                    # X2/H-12: no mutating field
