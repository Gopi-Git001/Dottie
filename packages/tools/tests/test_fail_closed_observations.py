"""CONTRACTS §5 "Fail-closed observations" (E01 2026-10-19, E11 410b59e) on the open_known_folder path and
in the registry: windowClass 1-256 chars; unreadable DPI never falls back to 96 (PRECONDITION_FAILED, none);
a failed cloaked check = not actionable (PRECONDITION_FAILED, none). Behavioural, Windows mocked."""
import pytest

from dottie_tools.targets import (Actionability, IdentityFormatError, NotActionable, WindowIdentity,
                                  actionability, identify, to_physical, window_dpi)
from support.fakes import DOCS, DOWNLOADS, PICS, HOME

FT = 133_700_000_000_000_123


def snap(env):
    return {h: list(w.tabs) for h, w in env.desktop.windows.items()}


def precondition_failed_untouched(sc, env, before):
    assert sc["verified"] is False and sc["error"]["code"] == "PRECONDITION_FAILED", sc
    assert sc["sideEffect"] == "none" and sc["observedState"]["sideEffect"] == "none"
    assert sc["error"]["retryable"] is False and sc["observedState"]["decision"] == "stop"
    assert env.desktop.navigations == [] and env.desktop.launches == [] and snap(env) == before


# FCO: cloaked check -------------------------------------------------------------------------------------
@pytest.mark.parametrize("cloaked", [True, None])
def test_fco01_foreground_target_cloaked_or_unreadable_is_precondition_failed(env, cloaked):
    w = env.desktop.add(DOCS, foreground=True)
    w.cloaked = cloaked
    before = snap(env)
    precondition_failed_untouched(env.call(), env, before)
    assert env.host.approval_requests == []


def test_fco02_cloak_reader_raising_is_not_actionable_and_never_raises(env):
    env.desktop.add(DOCS, foreground=True)
    def boom(hwnd):
        raise OSError("DwmGetWindowAttribute failed")
    env.desktop.is_cloaked = boom
    before = snap(env)
    precondition_failed_untouched(env.call(), env, before)


def test_fco03_target_id_window_that_became_cloaked_is_precondition_failed(env):
    a, b = env.desktop.add(DOCS), env.desktop.add(PICS)
    cands = env.call()["observedState"]["candidates"]
    for w in (a, b):
        w.cloaked = True
    before = snap(env)
    precondition_failed_untouched(env.call(targetId=cands[0]["id"]), env, before)


def test_fco04_cloaked_right_before_dispatch_is_precondition_failed_and_token_not_spent(env):
    a = env.desktop.add(DOCS, foreground=True)
    env.desktop.on_before_dispatch = lambda d: setattr(a, "cloaked", None)
    before = snap(env)
    sc = env.mutating()                                          # local_change: approval + token path
    precondition_failed_untouched(sc, env, before)
    assert len(env.k8.minted) == 1
    assert env.k8.consume(env.k8.minted[0], env.coord.requests[-1]["actionId"], "task-1",
                          "explorer.open_known_folder") == "ok"   # never consumed by the refused call


def test_fco05_non_actionable_windows_are_never_offered_as_candidates(env):
    a, b, c = env.desktop.add(DOCS), env.desktop.add(PICS), env.desktop.add(HOME)
    c.cloaked = True
    sc = env.call()
    assert sc["error"]["code"] == "AMBIGUOUS"
    ids = [x["id"] for x in sc["observedState"]["candidates"]]
    assert len(ids) == 2
    resolved = {env.registry.resolve(env.ctx, i, reader=env.desktop).identity.hwnd for i in ids}
    assert resolved == {a.hwnd, b.hwnd}


def test_fco06_all_windows_non_actionable_is_precondition_failed_not_a_launch(env):
    for p in (DOCS, PICS):
        env.desktop.add(p).cloaked = None
    before = snap(env)
    precondition_failed_untouched(env.call(), env, before)


def test_fco07_cloaked_window_already_showing_the_folder_is_not_verified(env):
    w = env.desktop.add(DOWNLOADS, foreground=True)
    w.cloaked = True
    before = snap(env)
    precondition_failed_untouched(env.call(), env, before)


# DPI: never falls back to 96 ---------------------------------------------------------------------------
def test_dpi01_unreadable_dpi_does_not_block_a_tool_that_needs_no_coordinates(env):
    a = env.desktop.add(DOCS, foreground=True)
    a.dpi = None
    sc = env.call()
    assert sc["verified"] is True and env.desktop.navigations == [(a.hwnd, DOWNLOADS)]


@pytest.mark.parametrize("dpi", [None, 0, -96, True, 96.0, "96", 10**9])
def test_dpi02_unreadable_or_absurd_dpi_is_none_never_96(desktop, dpi):
    w = desktop.add(DOCS)
    w.dpi = dpi
    ident = identify(desktop, w.hwnd)
    assert window_dpi(desktop, ident) is None
    assert actionability(desktop, ident, needs_coordinates=True) is Actionability.DPI_UNREADABLE
    with pytest.raises(NotActionable) as e:
        to_physical(desktop, ident, 100, 100)
    assert e.value.error_code == "PRECONDITION_FAILED" and e.value.side_effect == "none"


def test_dpi03_dpi_reader_raising_is_unreadable(desktop):
    w = desktop.add(DOCS)
    ident = identify(desktop, w.hwnd)
    desktop.window_dpi = lambda h: (_ for _ in ()).throw(OSError("GetDpiForWindow"))
    assert window_dpi(desktop, ident) is None
    with pytest.raises(NotActionable):
        to_physical(desktop, ident, 1, 1)


def test_dpi04_readable_dpi_scales_and_cloaked_beats_dpi(desktop):
    w = desktop.add(DOCS)
    w.dpi = 144
    ident = identify(desktop, w.hwnd)
    assert to_physical(desktop, ident, 100, 200) == (150, 300)
    w.cloaked = True
    with pytest.raises(NotActionable) as e:
        to_physical(desktop, ident, 100, 200)
    assert e.value.reason is Actionability.CLOAKED


# windowClass 1-256 UTF-16 code units (CONTRACTS §3.3, E01; E11 review) ------------------------------------------------------------
def _wire(cls):
    return {"hwnd": "4112", "pid": "700", "windowClass": cls, "processStartTime": str(FT)}


def test_wcls01_256_chars_accepted_257_and_empty_rejected():
    assert WindowIdentity.from_wire(_wire("C" * 256)).window_class == "C" * 256
    for bad in ("C" * 257, "", "C" * 100_000):
        with pytest.raises(IdentityFormatError):
            WindowIdentity.from_wire(_wire(bad))


@pytest.mark.parametrize("cls", ["C" * 257, ""])
def test_wcls02_live_window_with_bad_class_length_has_no_identity(desktop, cls):
    w = desktop.add(DOCS)
    w.cls = cls
    assert identify(desktop, w.hwnd) is None


E = "\U0001F600"                                     # one emoji = 2 UTF-16 code units (a surrogate pair)


@pytest.mark.parametrize("cls,units", [
    (E * 129, 258), (E * 256, 512), ("a" * 255 + E, 257), ("a" * 3 + E * 127, 257),
], ids=["129emoji", "256emoji", "255ascii+1emoji", "3ascii+127emoji"])
def test_wcls03_over_256_utf16_units_rejected_even_when_len_is_small(cls, units, desktop):
    assert len(cls.encode("utf-16-le")) // 2 == units and len(cls) <= 256
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire(_wire(cls))
    w = desktop.add(DOCS)
    w.cls = cls
    assert identify(desktop, w.hwnd) is None                     # live read: no identity either


@pytest.mark.parametrize("cls", [E * 128, "a" * 254 + E], ids=["128emoji", "254ascii+1emoji"])
def test_wcls04_exactly_256_utf16_units_accepted(cls, desktop):
    assert len(cls.encode("utf-16-le")) // 2 == 256
    assert WindowIdentity.from_wire(_wire(cls)).window_class == cls
    w = desktop.add(DOCS)
    w.cls = cls
    assert identify(desktop, w.hwnd) is not None


@pytest.mark.parametrize("cls", ["\ud83d", "a\ude00b", "\ude00\ud83d"], ids=["lone_high", "lone_low", "reversed"])
def test_wcls05_lone_surrogates_still_rejected(cls):
    with pytest.raises(IdentityFormatError):
        WindowIdentity.from_wire(_wire(cls))
