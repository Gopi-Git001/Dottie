"""E01 ruling 1z: the host takes a tool's scope from its pinned catalog entry, never from the category; a stated
category that disagrees with the pinned entry, or a missing/unreadable entry -> DENIED_BY_POLICY{catalog_mismatch}
(CR5, ruling 1z.1), sideEffect none, before any approval or K8 call."""
import inspect

import pytest

import dottie_tools.reference.reference as ref
from conftest import MUTATING_CATALOG
from test_e08_draft4_host import one_window, refused

TOOL = "explorer.open_known_folder"


def _cat(category, scope):
    return {TOOL: {"category": category, "scope": scope}}


def test_1z_no_category_to_scope_derivation_left_in_the_host():
    assert not hasattr(ref, "SCOPE")
    src = inspect.getsource(ref)
    assert "desktop.control" not in src.split('"""', 2)[2]          # no hard-wired scope in the host code


@pytest.mark.parametrize("stated,pinned", [("local_change", "navigate"), ("navigate", "local_change"),
                                           ("read", "navigate"), ("delete", "local_change"), ("bogus", "navigate")],
                         ids=["upgrade", "downgrade_skips_approval", "read", "delete", "unknown"])
def test_1z_stated_category_disagreeing_with_pinned_entry_is_denied(env, stated, pinned):
    one_window(env)
    env.host.scopes = frozenset({"files.navigate", "files.write", "desktop.control"})
    sc = env.call(stated_category=stated, catalog=_cat(pinned, "files.navigate"))
    refused(sc, env, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "catalog_mismatch"
    assert env.host.approval_requests == [] and env.k8.requests == []      # stopped before any approval or K8 call


def test_1z_stated_category_agreeing_with_pinned_entry_runs(env):
    one_window(env)
    assert env.call(stated_category="navigate")["verified"] is True


def test_1z_category_cannot_upgrade_the_scope(env):
    """local_change no longer implies desktop.control: an entry's own scope is what is checked."""
    one_window(env)
    env.host.scopes = frozenset({"files.write"})                        # no desktop.control granted
    sc = env.mutating()                                                  # pinned fixture: local_change / files.write
    assert MUTATING_CATALOG[TOOL]["scope"] == "files.write"
    assert sc["verified"] is True, sc                                   # approved + done without desktop.control


@pytest.mark.parametrize("category", ["navigate", "local_change"])
def test_1z_category_cannot_downgrade_the_scope(env, category):
    """An entry demanding a scope the host lacks is PERMISSION_REQUIRED whatever its category says."""
    one_window(env)
    env.host.scopes = frozenset({"files.navigate", "files.write"})
    refused(env.call(catalog=_cat(category, "desktop.control")), env, "PERMISSION_REQUIRED")


@pytest.mark.parametrize("catalog", [{}, None, "x", {TOOL: {"category": "navigate"}},
                                     {TOOL: {"scope": "files.navigate"}}, _cat("bogus", "files.navigate"),
                                     _cat("navigate", ""), _cat("navigate", 1), {TOOL: "navigate"}],
                         ids=["empty", "none_means_default", "str", "no_scope", "no_category", "unknown_category",
                              "empty_scope", "int_scope", "str_entry"])
def test_1z_unreadable_pinned_entry_fails_closed(env, catalog):
    one_window(env)
    sc = env.call(catalog=catalog)
    if catalog is None:                                                  # None = the default pinned copy
        assert sc["verified"] is True
        return
    refused(sc, env, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "catalog_mismatch"
    assert env.host.approval_requests == [] and env.k8.requests == []
