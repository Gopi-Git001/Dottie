"""ADR-0009 item 8 `navigate` exception, conditions 1-7 (E08 co-signed, E01 2026-10-19) and CONTRACTS §3
(category `navigate`, scope `files.navigate`, audit reason `known_folder_redirected`)."""
import json

import pytest

from support.fakes import DOCS, DOWNLOADS, HOME
from dottie_tools.reference.reference import EXPLORER_EXE, HostState


def snap(env):
    return {h: list(w.tabs) for h, w in env.desktop.windows.items()}


def refused(sc, env, before, code):
    assert sc["verified"] is False and sc["error"]["code"] == code, sc
    assert sc["sideEffect"] == "none" and sc["error"]["retryable"] is False
    assert env.desktop.navigations == [] and env.desktop.launches == [] and snap(env) == before


def no_paths_in_audit(env):
    """X1: the host writes no audit. What it hands to K8/the coordinator (checkPolicy, toolCallFinished)
    and its diagnostic log carry no paths, titles or identities."""
    assert not hasattr(env.host, "audit")
    blob = json.dumps([env.host.diag, env.host.finished, env.k8.requests if env.k8 else []])
    assert "Users" not in blob and ":\\\\" not in blob and "\\\\\\\\" not in blob and "OneDrive" not in blob


# Condition 2: the arg is the `folder` enum; no path, subpath, /select or verbs -------------------------
@pytest.mark.parametrize("folder", ["Downloads", "DOWNLOADS", "download", "profile", "appdata", "windows",
                                    "", None, 3, ["downloads"]])
def test_nav02a_non_enum_folder_is_invalid_argument(env, folder):
    env.desktop.add(DOCS, foreground=True)
    before = snap(env)
    refused(env.raw({"folder": folder}), env, before, "INVALID_ARGUMENT")


@pytest.mark.parametrize("folder", [
    r"C:\Users\gopi\Downloads", r"\\srv\share", "downloads\\sub", "downloads/sub", "downloads\\..\\..\\Windows",
    "/select,C:\\Windows\\System32\\calc.exe", "downloads /select,C:\\x", "downloads,/e", "shell:Downloads",
    "shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", "downloads & calc", "\"downloads\" /root,C:\\",
    "file:///C:/", "%USERPROFILE%\\Downloads",
])
def test_nav02b_path_subpath_select_or_verb_injection_in_folder_is_rejected(env, folder):
    env.desktop.add(DOCS, foreground=True)
    before = snap(env)
    refused(env.call(folder=folder), env, before, "INVALID_ARGUMENT")


@pytest.mark.parametrize("extra", [{"select": "C:\\x"}, {"verb": "runas"}, {"subpath": "a"}, {"path": "C:\\"},
                                   {"args": "/select,C:\\x"}, {"operation": "open"}])
def test_nav02c_extra_injection_keys_are_rejected(env, extra):
    env.desktop.add(DOCS, foreground=True)
    before = snap(env)
    refused(env.call(**extra), env, before, "INVALID_ARGUMENT")


def test_nav02d_explorer_gets_a_fixed_argv_never_a_shell_string(env):
    sc = env.call()
    assert sc["verified"] is True
    assert env.desktop.launches == [[EXPLORER_EXE, DOWNLOADS]]
    argv = env.desktop.launches[0]
    assert not any(a.startswith("/") or "," in a for a in argv)


# Condition 3: redirected / missing -> DENIED_BY_POLICY known_folder_redirected, no confirm fallback --------
def test_nav03a_unc_redirected_downloads_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    env.desktop.known["downloads"] = r"\\fileserver\users\gopi\Downloads"
    before = snap(env)
    refused(env.call(), env, before, "DENIED_BY_POLICY")
    assert env.host.diag[-1] == {"event": "tool.refused", "code": "DENIED_BY_POLICY",
                                 "reason": "known_folder_redirected"}
    assert env.host.finished[-1]["reason"] == "known_folder_redirected"     # so K8 can audit it (E-P8 proposal)
    assert env.host.approval_requests == []                         # never falls back to a confirm
    no_paths_in_audit(env)


def test_nav03b_mapped_network_drive_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    env.desktop.known["downloads"] = r"Z:\Downloads"
    env.desktop.remote_drives = {"Z"}
    before = snap(env)
    refused(env.call(), env, before, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "known_folder_redirected"


def test_nav03c_reparse_point_outside_the_profile_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    env.desktop.reparse = {DOWNLOADS: r"D:\Elsewhere\Downloads"}    # junction out of the profile
    before = snap(env)
    refused(env.call(), env, before, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "known_folder_redirected"
    no_paths_in_audit(env)


def test_nav03d_reparse_point_to_a_network_share_is_denied(env):
    env.desktop.add(DOCS, foreground=True)
    env.desktop.reparse = {DOWNLOADS: r"\\nas\dl"}
    before = snap(env)
    refused(env.call(), env, before, "DENIED_BY_POLICY")


@pytest.mark.parametrize("how", ["unresolvable", "missing_on_disk"])
def test_nav03e_missing_folder_is_denied(env, how):
    env.desktop.add(DOCS, foreground=True)
    if how == "unresolvable":
        env.desktop.known.pop("downloads")
    else:
        env.desktop.missing = {DOWNLOADS}
    before = snap(env)
    refused(env.call(), env, before, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == "known_folder_redirected"
    assert env.host.approval_requests == []


def test_nav03f_onedrive_backed_local_folder_is_allowed(env):
    od = HOME + r"\OneDrive\Downloads"
    env.desktop.known["downloads"] = od
    a = env.desktop.add(DOCS, foreground=True)
    sc = env.call()
    assert sc["verified"] is True and env.desktop.navigations == [(a.hwnd, od)]
    no_paths_in_audit(env)


def test_nav03g_reparse_inside_the_profile_is_allowed(env):
    env.desktop.reparse = {DOWNLOADS: HOME + r"\OneDrive\Downloads"}
    env.desktop.add(DOCS, foreground=True)
    assert env.call()["verified"] is True


# Condition 4: scope files.navigate; denied when locked / after panic-stop / after mute -------------------
def test_nav04a_scope_files_navigate_required(env):
    env.desktop.add(DOCS, foreground=True)
    env.host.scopes = frozenset({"desktop.control"})
    before = snap(env)
    refused(env.call(), env, before, "PERMISSION_REQUIRED")


@pytest.mark.parametrize("flag,reason", [("locked", "locked"), ("panic_stopped", "panic_stop"), ("muted", "mute")])
def test_nav04b_denied_when_locked_after_panic_stop_or_mute(env, flag, reason):
    env.desktop.add(DOCS, foreground=True)
    setattr(env.host, flag, True)
    before = snap(env)
    refused(env.call(), env, before, "DENIED_BY_POLICY")
    assert env.host.diag[-1]["reason"] == reason and env.k8.requests == []   # refused before checkPolicy


def test_nav04c_also_denied_with_no_window_open_no_launch(env):
    env.host.locked = True
    before = snap(env)
    refused(env.call(), env, before, "DENIED_BY_POLICY")


# Condition 5 (no chaining) is in test_approval_binding.py::test_tok10 ---------------------------------

# Condition 6: audit holds category, folder, decision; no resolved path ---------------------------------
def test_nav06_host_writes_no_audit_and_hands_k8_no_path(env):
    """Condition 6 under X1: the audit record (category, folder, decision) is K8's. The host hands K8 only
    {v, callId, toolId, category} in checkPolicy and {phase, sideEffect} in toolCallFinished."""
    env.desktop.add(DOCS, foreground=True)
    assert env.call()["verified"] is True
    assert env.k8.requests == [{"method": "checkPolicy", "v": 1, "callId": "call-1",
                                "toolId": "explorer.open_known_folder", "category": "navigate"}]
    assert env.host.diag == [] and set(env.host.finished[-1]) == {"v", "callId", "toolId", "taskId", "phase",
                                                                   "sideEffect"}
    no_paths_in_audit(env)
