"""Unit tests for the shared registry API sketch (dottie_tools/targets/window_registry.py)."""
import json

import pytest

from dottie_tools.targets import (HostContext, IdentityFormatError, Liveness, WindowIdentity,
                      WindowIdentityService, WindowRegistry, canonical_json, check_live, identify,
                      identity_digest, is_well_formed_target_id, live_identities, liveness)

BIG = 2**53 + 1                       # not representable as an IEEE double
FT = 133_700_000_000_000_123          # realistic FILETIME (2024-ish), > 2^53


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


class Reader:
    """Minimal WindowFieldReader fake."""
    def __init__(self, **wins):
        self.w = {int(k[1:]): v for k, v in wins.items()}   # h<hwnd>=(pid, cls, start)

    def top_level_explorer_hwnds(self):
        return [h for h, f in self.w.items() if f[1] in ("CabinetWClass", None)]

    def read_fields(self, hwnd):
        return self.w.get(hwnd)

    def process_image_name(self, pid):
        return "explorer.exe"


A = WindowIdentity(4112, 700, "CabinetWClass", FT)
B = WindowIdentity(4128, 701, "CabinetWClass", FT + 1)
T1 = HostContext("task-1", "thr-1", "turn-1")


@pytest.fixture
def reg():
    return WindowRegistry(clock=Clock())          # default = 30-min safety cap (C3 proposal)


def wire(**over):
    base = A.to_wire()
    base.update(over)
    return base


# ---- wire encoding (CONTRACTS §3.3) --------------------------------------------------------------
def test_wire01_shape_and_types():
    w = A.to_wire()
    assert w == {"hwnd": "4112", "pid": "700", "windowClass": "CabinetWClass", "processStartTime": str(FT)}
    assert all(isinstance(w[k], str) for k in w)


@pytest.mark.parametrize("value", [BIG, 2**63 - 1, 2**64 - 1, FT])
def test_wire02_values_above_2_53_round_trip_exactly(value):
    ident = WindowIdentity(value, 2**32 - 1, "CabinetWClass", value)
    text = json.dumps(ident.to_wire())
    back = WindowIdentity.from_wire(json.loads(text))
    assert back == ident and back.process_start_time == value and back.hwnd == value
    assert str(value) in text and f'"{value}"' in text          # quoted decimal, not a number


def test_wire03_canonical_form_has_no_leading_zero_sign_or_exponent():
    for v in (1, 9, 10, BIG, 2**64 - 1):
        for k, s in WindowIdentity(v, min(v, 2**32 - 1), "C", v).to_wire().items():
            if k != "windowClass":
                assert s[0] != "0" and s.lstrip("+-") == s and s.isascii() and s.isdigit()


@pytest.mark.parametrize("field", ["hwnd", "pid", "processStartTime"])
@pytest.mark.parametrize("bad", [
    FT, 4112, float(FT), 1.0, True,                     # JSON numbers / bools
    "2024-05-01T12:00:00Z", "2024-05-01",               # ISO dates
    "0133700000000000123", "04112", "00", "0700",       # zero-padded
    "0",                                                # zero: not a valid window/process (see tools.md §6)
    "+4112", "-4112",                                   # signs
    " 4112", "4112 ", "41 12", "\t4112", "4112\n",      # whitespace
    "0x1010", "1010h", "1e3", "4112.0",                 # hex / exponent / decimal point
    "",                                                 # empty
    "٤١١٢",                                             # non-ASCII digits
    str(2**64),                                         # out of range (pid: also 2^32 below)
    None, [], {},
])
def test_wire04_parser_rejects_non_canonical(field, bad):
    with pytest.raises(IdentityFormatError) as e:
        WindowIdentity.from_wire(wire(**{field: bad}))
    assert e.value.error_code == "INVALID_ARGUMENT"


@pytest.mark.parametrize("bad", [str(2**32), str(2**40)])
def test_wire05_pid_range_is_32_bit(bad):
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire(wire(pid=bad))


def test_wire05b_pid_as_json_number_is_rejected():
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire(json.loads('{"hwnd":"4112","pid":700,"windowClass":"CabinetWClass","processStartTime":"%d"}' % FT))


@pytest.mark.parametrize("obj", [
    {"hwnd": "4112", "pid": "700", "windowClass": "CabinetWClass"},                     # missing field
    {**A.to_wire(), "title": "x"},                                                     # extra field
    {**A.to_wire(), "windowClass": ""}, {**A.to_wire(), "windowClass": 5},
    [A.to_wire()], "4112",
])
def test_wire06_parser_requires_exact_shape(obj):
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire(obj)


def test_wire07_constructor_rejects_partial_or_invalid_identity():
    for args in ((0, 700, "C", FT), (4112, 0, "C", FT), (4112, 700, "", FT), (4112, 700, "C", 0),
                 (4112, 700, "C", None), (4112, None, "C", FT), ("4112", 700, "C", FT)):
        with pytest.raises(IdentityFormatError):
            WindowIdentity(*args)


def test_wire08_canonical_json_never_emits_floats_for_identity():
    s = canonical_json({"w": WindowIdentity(BIG, 700, "C", BIG).to_wire()})
    assert f'"hwnd":"{BIG}"' in s and f'"processStartTime":"{BIG}"' in s


# ---- identify / liveness (E11 §15 items 2, 3, 8) --------------------------------------------------
def test_id01_identify_reads_all_four_fields():
    r = Reader(h4112=(700, "CabinetWClass", FT))
    assert identify(r, 4112) == A
    assert identify(r, 9999) is None


@pytest.mark.parametrize("fields", [(None, "CabinetWClass", FT), (700, None, FT), (700, "CabinetWClass", None)])
def test_id02_any_unreadable_field_means_no_identity(fields):
    r = Reader(h4112=fields)
    assert identify(r, 4112) is None
    assert live_identities(r) == []                     # never offered as a candidate
    assert liveness(r, A) is Liveness.NO_IDENTITY and not WindowIdentityService(r).is_alive(A)


def test_id03_is_alive_never_raises_for_dead_or_protected_handle():
    class Boom(Reader):
        def read_fields(self, hwnd):
            raise OSError("access denied")
    svc = WindowIdentityService(Boom())
    assert svc.identify(4112) is None and svc.is_alive(A) is False


@pytest.mark.parametrize("fields,state", [
    ((701, "CabinetWClass", FT), Liveness.IDENTITY_MISMATCH),
    ((700, "CabinetWClass", FT + 5), Liveness.IDENTITY_MISMATCH),      # only processStartTime differs
    ((700, "ExploreWClass", FT), Liveness.WINDOW_GONE),                # no longer an Explorer top-level
])
def test_id04_any_field_mismatch_is_closed(fields, state):
    r = Reader(h4112=fields)
    assert liveness(r, A) is state and state.closed


def test_id05_process_image_name_only_for_live_identity():
    r = Reader(h4112=(700, "CabinetWClass", FT))
    svc = WindowIdentityService(r)
    assert svc.process_image_name(A) == "explorer.exe"
    assert svc.process_image_name(WindowIdentity(4112, 700, "CabinetWClass", FT + 1)) is None


# ---- candidate registry ---------------------------------------------------------------------------
def test_reg01_issue_returns_opaque_ids_and_labels_only(reg):
    out = reg.issue(T1, [(A, "File Explorer window 1"), (B, "File Explorer window 2")])
    assert [set(c) for c in out] == [{"id", "label"}] * 2
    assert all(is_well_formed_target_id(c["id"]) for c in out) and len({c["id"] for c in out}) == 2


def test_reg02_issue_requires_task_and_full_identity(reg):
    with pytest.raises(ValueError):
        reg.issue(HostContext("", "thr", "turn"), [(A, "w")])
    with pytest.raises(TypeError):
        reg.issue(T1, [(4112, "w")])


def test_reg03_resolve_ok_needs_a_live_recheck(reg):
    cid = reg.issue(T1, [(A, "w1"), (B, "w2")])[0]["id"]
    assert reg.resolve(T1, cid, [A, B]).identity == A
    assert reg.resolve(T1, cid, reader=Reader(h4112=(700, "CabinetWClass", FT))).identity == A
    assert reg.resolve(T1, cid).reason == "window_gone"


@pytest.mark.parametrize("bad", ["", "c_123", "C_000000000000", "c_00000000000g", None, 7, ["c_0"]])
def test_reg04_malformed_maps_to_invalid_argument(reg, bad):
    r = reg.resolve(T1, bad, [A])
    assert r.reason == "malformed" and r.error_code == "INVALID_ARGUMENT"


def test_reg05_unknown_cross_task_superseded_past_cap_map_to_not_found(reg):
    first = reg.issue(T1, [(A, "w1")])[0]["id"]
    other = reg.issue(HostContext("task-2", "thr-1", "turn-1"), [(A, "w1")])[0]["id"]
    reg.issue(T1, [(A, "w1 again")])                     # same window re-registered -> `first` superseded
    second = reg.issue(T1, [(B, "w2")])[0]["id"]
    assert reg.resolve(T1, "c_000000000000", [A, B]).reason == "unknown"
    assert reg.resolve(T1, other, [A, B]).reason == "cross_task"
    assert reg.resolve(T1, first, [A, B]).reason == "superseded"
    reg.clock.t += 301                                   # the old 300 s TTL is gone (C3)
    assert reg.resolve(T1, second, [A, B]).ok
    reg.clock.t = 1801                                   # past the 30-min safety cap (PROPOSAL)
    r = reg.resolve(T1, second, [A, B])
    assert r.reason == "safety_cap" and r.error_code == "NOT_FOUND"


def test_reg05c_supersede_is_per_window_not_per_list(reg):
    """E03/E04 settled (DOT-092 DRAFT 3 §4.2): only the re-registered window's old id dies."""
    a1, b1 = (c["id"] for c in reg.issue(T1, [(A, "w1"), (B, "w2")]))
    a2 = reg.issue(HostContext("task-1", "thr-1", "task-1.t2"), [(A, "w1")])[0]["id"]
    t2 = HostContext("task-1", "thr-1", "task-1.t2")
    assert reg.resolve(t2, a1, [A, B]).reason == "superseded"
    assert reg.resolve(t2, b1, [A, B]).identity == B          # another window's id is unaffected
    assert reg.resolve(t2, a2, [A, B]).identity == A
    other = HostContext("task-9", "thr-9", "task-9.t1")
    reg.issue(other, [(B, "w2")])                              # same window in ANOTHER task supersedes nothing here
    assert reg.resolve(t2, b1, [A, B]).identity == B


def test_reg05b_end_task_kills_every_id_of_that_task_only(reg):
    mine = reg.issue(T1, [(A, "w1")])[0]["id"]
    other_ctx = HostContext("task-2", "thr-2", "task-2.t1")
    theirs = reg.issue(other_ctx, [(B, "w2")])[0]["id"]
    reg.end_task("task-1")
    r = reg.resolve(T1, mine, [A, B])
    assert not r.ok and r.error_code == "NOT_FOUND"
    assert reg.resolve(other_ctx, theirs, [A, B]).ok


def test_reg06_next_turn_same_task_resolves(reg):
    cid = reg.issue(T1, [(A, "w1")])[0]["id"]
    assert reg.resolve(HostContext("task-1", "thr-1", "turn-2"), cid, [A]).ok


def test_reg06b_id_stays_valid_across_many_turns_until_end_task(reg):
    cid = reg.issue(T1, [(A, "w1"), (B, "w2")])[0]["id"]
    for n in range(2, 7):
        reg.clock.t += 290                               # 5 turns, ~24 min total, under the cap
        assert reg.resolve(HostContext("task-1", "thr-1", f"task-1.t{n}"), cid, [A, B]).identity == A
    reg.end_task("task-1")
    assert reg.resolve(HostContext("task-1", "thr-1", "task-1.t7"), cid, [A, B]).error_code == "NOT_FOUND"


@pytest.mark.parametrize("fields,reason", [
    (None, "window_gone"),
    ((999, "CabinetWClass", FT), "identity_mismatch"),
    ((700, "CabinetWClass", FT + 9), "identity_mismatch"),
    ((700, "CabinetWClass", None), "no_identity"),
])
def test_reg07_closed_or_unidentifiable_at_lookup_is_not_found(reg, fields, reason):
    cid = reg.issue(T1, [(A, "w1")])[0]["id"]
    r = reg.resolve(T1, cid, reader=Reader(**({} if fields is None else {"h4112": fields})))
    assert r.reason == reason and r.error_code == "NOT_FOUND"


def test_reg08_check_live_snapshot():
    assert check_live(A, [A, B]) is Liveness.LIVE
    assert check_live(A, []) is Liveness.WINDOW_GONE


def test_reg09_forget_task(reg):
    cid = reg.issue(T1, [(A, "w1")])[0]["id"]
    reg.forget_task("task-1")
    assert reg.resolve(T1, cid, [A]).reason == "unknown"


def test_reg10_identity_digest_hides_raw_values_and_tracks_every_field():
    d = identity_digest(A)
    assert "4112" not in d and "700" not in d and len(d) == 16
    assert d != identity_digest(WindowIdentity(A.hwnd, A.pid, A.window_class, FT + 1))
    assert identity_digest(None) == "none"


def test_reg11_thread_safety_smoke(reg):
    import threading
    errs = []

    def work():
        try:
            for _ in range(200):
                c = reg.issue(T1, [(A, "w")])[0]["id"]
                reg.resolve(T1, c, [A])
        except Exception as e:  # noqa: BLE001
            errs.append(e)
    ts = [threading.Thread(target=work) for _ in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert errs == []
