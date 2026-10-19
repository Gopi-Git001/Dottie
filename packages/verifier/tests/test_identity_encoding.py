"""Window identity wire encoding (CONTRACTS §3.3, E01 2026-10-19): numbers that can exceed 2^53
are canonical unsigned decimal strings, never JSON numbers; parsing is strict."""

import json

import pytest

from dottie_verifier.candidates import CandidateRegistry
from dottie_verifier.contract import error_code, to_structured_content, to_verification_result
from dottie_verifier.explorer_workflow import OpenExplorerKnownFolder, invalid_argument_report
from dottie_verifier.model import wire_safe
from dottie_verifier.winapi import WindowState
from dottie_verifier.window_identity import (
    FIELD_MAX,
    STRING_FIELDS,
    InvalidArgumentError,
    LocalWindowRegistry,
    WindowIdentity,
    format_uint,
    parse_filetime,
    parse_uint,
)
from dottie_verifier.workflow import ActionContext
from tests.fakes import FakeE04Tools
from tests.test_window_gone_and_args import open_dl

UINT_FIELDS = ["hwnd", "pid", "processStartTime"]
ABOVE_2_53 = 2**53 + 1                      # not representable as an IEEE double
BIG_FILETIME = 2**60 + 3                     # also above 2^53; odd so float rounding shows
REAL_FILETIME = 133_700_000_000_000_001      # 2024-ish FILETIME, above 2^53
DOCS = r"C:\Users\<user>\Documents"

MALFORMED_STRINGS = [
    "", " ", "01", "00", "007", "+1", "-1", "-0", " 1", "1 ", "\t1", "1\n", "1.0", "1.", ".5",
    "1e3", "0x1f", "1_000", "1,000", "abc", "12a", "\u0661\u0662",  # Arabic-Indic digits
    "\uff11",                                                         # fullwidth 1
    "18446744073709551616",                                           # 2^64, out of range
    "1" * 21, "9" * 5000,
]
NON_STRINGS = [0, 1, ABOVE_2_53, 1.0, float(2**60), True, False, None, [], {}, b"1"]


def big_values(field):
    return [1, FIELD_MAX[field]] + ([ABOVE_2_53, BIG_FILETIME, REAL_FILETIME]
                                       if FIELD_MAX[field] > 2**53 else [2**31, 4_294_967_295])


@pytest.mark.parametrize("field", UINT_FIELDS)
def test_uint_codec_round_trips_exactly_including_above_2_53(field):
    for v in big_values(field):
        s = format_uint(field, v)
        assert isinstance(s, str) and s == str(v)
        assert parse_uint(field, s) == v
        assert parse_uint(field, json.loads(json.dumps(s))) == v      # survives a JSON hop


def test_values_above_2_53_would_be_corrupted_as_json_numbers():
    # Why the string rule exists: a JS/double reader rounds these.
    assert int(float(ABOVE_2_53)) != ABOVE_2_53 and int(float(BIG_FILETIME)) != BIG_FILETIME
    assert parse_filetime(format_uint("processStartTime", BIG_FILETIME)) == BIG_FILETIME


@pytest.mark.parametrize("field", UINT_FIELDS)
@pytest.mark.parametrize("bad", MALFORMED_STRINGS)
def test_malformed_strings_are_rejected(field, bad):
    with pytest.raises(InvalidArgumentError):
        parse_uint(field, bad)


@pytest.mark.parametrize("field", UINT_FIELDS)
@pytest.mark.parametrize("bad", NON_STRINGS, ids=repr)
def test_non_strings_are_rejected(field, bad):
    with pytest.raises(InvalidArgumentError):
        parse_uint(field, bad)


@pytest.mark.parametrize("field", UINT_FIELDS)
def test_zero_is_rejected_and_range_is_enforced(field):
    # CONTRACTS §3.3: "0" is invalid for hwnd, pid and processStartTime (E04 review 2026-10-19).
    for bad in ("0", str(FIELD_MAX[field] + 1)):
        with pytest.raises(InvalidArgumentError):
            parse_uint(field, bad)
    assert parse_uint(field, "1") == 1
    for bad in (0, -1, FIELD_MAX[field] + 1, True, 1.0):
        with pytest.raises(InvalidArgumentError):
            format_uint(field, bad)


def identity(hwnd=0x1A2B3C, pid=4242, start=REAL_FILETIME):
    return WindowIdentity(hwnd, pid, "CabinetWClass", start)


def test_identity_serialization_follows_contract_and_round_trips():
    ident = identity(hwnd=FIELD_MAX["hwnd"], pid=FIELD_MAX["pid"], start=BIG_FILETIME)
    wire = json.loads(json.dumps(ident.to_contract()))
    assert wire["processStartTime"] == str(BIG_FILETIME)
    assert STRING_FIELDS == {"hwnd", "pid", "processStartTime"}       # CONTRACTS §3.3
    assert wire["hwnd"] == str(FIELD_MAX["hwnd"]) and wire["pid"] == str(FIELD_MAX["pid"])
    assert WindowIdentity.from_contract(wire) == ident


def test_identity_numbers_are_never_json_numbers():
    ident = identity()
    parsed = json.loads(json.dumps(ident.to_contract()))
    assert parsed == {"hwnd": str(ident.hwnd), "pid": str(ident.pid),
                      "windowClass": "CabinetWClass", "processStartTime": str(REAL_FILETIME)}
    assert not any(isinstance(v, (int, float)) for v in parsed.values())


def test_wire_safe_stringifies_ids_and_unsafe_ints_only():
    ev = {"hwnd": 5, "pid": 0, "tab_hwnd": 6, "explorer_hwnds": {9, 7}, "count": 3,
          "big": BIG_FILETIME, "flag": True, "nested": [{"hwnd": 8, "dpi": 96}],
          "window_identity": identity().to_contract()}
    assert wire_safe(ev) == {"hwnd": "5", "pid": "0", "tab_hwnd": "6", "explorer_hwnds": ["7", "9"],
                             "count": 3, "big": str(BIG_FILETIME), "flag": True,
                             "nested": [{"hwnd": "8", "dpi": 96}],
                             "window_identity": identity().to_contract()}


def wire(**over):
    w = identity().to_contract()
    w.update(over)
    return w


@pytest.mark.parametrize("field", UINT_FIELDS)
@pytest.mark.parametrize("bad", ["01", "+5", "-5", " 5", "5 ", "5.0", "five", "", 5.0, None, True])
def test_from_contract_rejects_malformed_fields(field, bad):
    with pytest.raises(InvalidArgumentError):
        WindowIdentity.from_contract(wire(**{field: bad}))


@pytest.mark.parametrize("field", sorted(STRING_FIELDS))
def test_from_contract_rejects_ints_for_string_fields(field):
    for bad in (REAL_FILETIME, 5):
        with pytest.raises(InvalidArgumentError):
            WindowIdentity.from_contract(wire(**{field: bad}))


@pytest.mark.parametrize("obj", [None, "x", [], {}, {"hwnd": "1"},
                                 dict(wire(), extra=1), wire(windowClass=""),
                                 wire(windowClass=7)], ids=repr)
def test_from_contract_rejects_bad_shapes(obj):
    with pytest.raises(InvalidArgumentError):
        WindowIdentity.from_contract(obj)


def test_parse_error_is_reported_as_invalid_argument():
    with pytest.raises(InvalidArgumentError) as exc:
        WindowIdentity.from_contract(wire(processStartTime=REAL_FILETIME))
    report = invalid_argument_report("explorer.open_known_folder:downloads", str(exc.value))
    sc = to_structured_content(report)
    assert error_code(report) == "INVALID_ARGUMENT"
    assert sc["sideEffect"] == "none" and report.tool_invoked is False


def test_registry_fail_closed_on_unreadable_or_out_of_range_fields(desktop):
    a = desktop.add_explorer(DOCS)
    b = desktop.add_explorer(DOCS)
    c = desktop.add_explorer(DOCS)
    a.class_name = ""                          # class unreadable
    b.pid = 2**32                              # not a valid pid
    c.process_start_time = 2**64               # not a valid FILETIME
    windows = LocalWindowRegistry(desktop)
    assert [windows.identify(w.hwnd) for w in (a, b, c)] == [None, None, None]


def test_emitted_shapes_carry_start_time_only_as_string(desktop):
    w = desktop.add_explorer(DOCS, foreground=True, minimized=True, process_start_time=BIG_FILETIME)
    seen = []

    def gate(primitive, target):
        seen.append(json.loads(json.dumps(target)))      # as if serialized to K8
        return True

    wf = OpenExplorerKnownFolder(desktop, FakeE04Tools(desktop), recovery_gate=gate)
    ctx = ActionContext(before=wf.snapshot(), started_at=0.0)
    ctx.tool_result = {"success": True, "hwnd": w.hwnd}
    checks = wf.verify(ctx)
    wf.recover(checks, ctx, 1)
    # policy-gate payload
    assert seen and all(t["window"]["processStartTime"] == str(BIG_FILETIME) for t in seen)
    assert all(WindowIdentity.from_contract(t["window"]).process_start_time == BIG_FILETIME
               for t in seen)
    assert all(t["hwnd"] == str(w.hwnd) for t in seen)
    # local evidence (report.to_dict -> evidence file)
    ev = json.loads(json.dumps([c.to_dict() for c in checks]))
    idents = [c["evidence"]["window_identity"] for c in ev if "window_identity" in c["evidence"]]
    assert idents == [{**idents[0], "processStartTime": str(BIG_FILETIME)}]
    assert str(BIG_FILETIME) not in json.dumps(ev).replace(f'"{BIG_FILETIME}"', "")
    assert_no_numeric_ids(ev)


def assert_no_numeric_ids(obj, key=None):
    if isinstance(obj, dict):
        for k, v in obj.items():
            assert_no_numeric_ids(v, k)
    elif isinstance(obj, list):
        for v in obj:
            assert_no_numeric_ids(v, key)
    elif key in {"hwnd", "pid", "tab_hwnd", "processStartTime"} or (
            isinstance(key, str) and key.endswith("hwnds")):
        assert not isinstance(obj, (int, float)) or isinstance(obj, bool), (key, obj)


def test_evidence_file_has_no_numeric_window_ids(desktop, clock):
    report = open_dl(desktop, clock, FakeE04Tools(desktop, mode="minimized"),
                     CandidateRegistry(clock=clock))
    data = json.loads(json.dumps(report.to_dict()))
    assert_no_numeric_ids(data)
    hwnd = report.check("EXP-02").evidence["hwnd"]           # int in memory
    assert type(hwnd) is int
    assert any(c["evidence"].get("hwnd") == str(hwnd) for c in data["checks"])


def test_identity_never_reaches_observed_state(desktop, clock):
    report = open_dl(desktop, clock, FakeE04Tools(desktop, mode="minimized"),
                     CandidateRegistry(clock=clock))
    blob = json.dumps([to_structured_content(report), to_verification_result(report)])
    assert "processStartTime" not in blob and "window_identity" not in blob


# --- zero / unreadable fields: never an identity (CONTRACTS §3.3, E04 review 2026-10-19) ---------

@pytest.mark.parametrize("field", UINT_FIELDS)
def test_zero_field_is_never_an_identity(field):
    kwargs = {"hwnd": 0x1A2B3C, "pid": 4242, "start": REAL_FILETIME}
    kwargs[{"processStartTime": "start"}.get(field, field)] = 0
    with pytest.raises(InvalidArgumentError):
        identity(**kwargs)
    with pytest.raises(InvalidArgumentError):
        WindowIdentity.from_contract(wire(**{field: "0"}))


def test_window_state_identity_fields_have_no_fail_open_defaults():
    st = WindowState(hwnd=0x10, exists=True)
    assert st.pid is None and st.class_name is None and st.process_start_time is None


class StateApi:
    """Minimal WindowsApi double that returns one fixed WindowState."""

    def __init__(self, **fields):
        self.fields = fields

    def window_state(self, hwnd):
        return WindowState(**{"hwnd": hwnd, "exists": True, **self.fields})


GOOD = {"pid": 4242, "class_name": "CabinetWClass", "process_start_time": REAL_FILETIME}


@pytest.mark.parametrize(("field", "value"), [
    ("pid", None), ("pid", 0), ("class_name", None), ("class_name", ""),
    ("process_start_time", None), ("process_start_time", 0),
    ("pid", 2**32), ("process_start_time", 2**64), ("pid", True),
])
def test_unreadable_or_zero_backend_field_means_no_identity(field, value):
    assert LocalWindowRegistry(StateApi(**GOOD)).identify(0x10) is not None
    assert LocalWindowRegistry(StateApi(**{**GOOD, field: value})).identify(0x10) is None


def test_hwnd_zero_or_defaults_only_means_no_identity():
    assert LocalWindowRegistry(StateApi(**GOOD)).identify(0) is None
    assert LocalWindowRegistry(StateApi()).identify(0x10) is None       # all defaults


@pytest.mark.parametrize("kind", ["pid_none", "pid_zero", "class_none", "start_zero"])
def test_window_losing_a_field_makes_its_target_id_not_found(desktop, clock, kind):
    registry = CandidateRegistry(clock=clock)
    a = desktop.add_explorer(DOCS)
    b = desktop.add_explorer(r"C:\Users\<user>\Pictures")
    first = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry))
    assert first["error"]["code"] == "AMBIGUOUS"
    ids = [c["id"] for c in first["observedState"]["candidates"]]
    attr, value = {"pid_none": ("pid", None), "pid_zero": ("pid", 0),
                   "class_none": ("class_name", None),
                   "start_zero": ("process_start_time", 0)}[kind]
    setattr(a, attr, value)
    # The window that lost a field is gone from the registry's view: its id is NOT_FOUND.
    sc = to_structured_content(open_dl(desktop, clock, FakeE04Tools(desktop), registry,
                                       target_id=ids[0]))
    assert sc["error"]["code"] == "NOT_FOUND" and sc["sideEffect"] == "none"
    assert LocalWindowRegistry(desktop).identify(a.hwnd) is None
    assert LocalWindowRegistry(desktop).identify(b.hwnd) is not None
