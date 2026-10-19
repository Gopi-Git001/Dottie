import json

import pytest

from dottie_verifier.app_checks import verify_app_launched
from dottie_verifier.metrics import TaskRun, load_jsonl, summarize, wilson_interval
from dottie_verifier.model import Outcome, classify
from tests.fakes import FakeWindow


def add_app(desktop, image, foreground=False):
    h = desktop.new_hwnd()
    desktop.windows[h] = FakeWindow(h, process_image=image, class_name="Notepad", tabs=[])
    if foreground:
        desktop.foreground = h
    return h


def test_app_launched_verified(desktop):
    before = set(desktop.windows)
    add_app(desktop, r"C:\Windows\System32\notepad.exe", foreground=True)
    assert classify(verify_app_launched(desktop, {"notepad.exe"}, before)) is Outcome.VERIFIED


def test_uwp_calculator_found_through_frame_host(desktop):
    before = set(desktop.windows)
    add_app(desktop, r"C:\Windows\System32\ApplicationFrameHost.exe", foreground=True)
    assert classify(verify_app_launched(desktop, {"CalculatorApp.exe"}, before)) is Outcome.FAILED
    checks = verify_app_launched(desktop, {"CalculatorApp.exe", "ApplicationFrameHost.exe"}, before)
    assert classify(checks) is Outcome.VERIFIED


def test_two_new_app_windows_are_ambiguous(desktop):
    before = set(desktop.windows)
    add_app(desktop, "notepad.exe")
    add_app(desktop, "notepad.exe")
    checks = verify_app_launched(desktop, {"notepad.exe"}, before)
    assert checks[0].evidence["ambiguous"] and classify(checks) is Outcome.UNVERIFIED


def test_wilson_interval_known_values():
    lo, hi = wilson_interval(95, 100)
    assert round(lo, 3) == 0.888 and round(hi, 3) == 0.978
    assert wilson_interval(0, 0) == (0.0, 0.0)


def test_summary_counts_only_verified():
    runs = [TaskRun("open_downloads", i, "verified", True) for i in range(19)]
    runs.append(TaskRun("open_downloads", 19, "partially_verified", True))
    runs += [TaskRun("launch_notepad", i, "verified", True) for i in range(18)]
    runs += [TaskRun("launch_notepad", 18, "failed", True), TaskRun("launch_notepad", 19, "asked",
            False)]
    s = summarize(runs, min_runs_per_task=20)
    assert s["runs"] == 40 and s["verified"] == 37
    assert s["verified_rate"] == pytest.approx(0.925)
    assert s["false_success"] == 2
    assert s["meets_target_point_estimate"] is False
    assert s["tasks_below_target"] == ["launch_notepad"]   # 19/20 = 0.95 meets the bar
    assert s["weakest_task"] == "launch_notepad"


def test_point_estimate_vs_confidence():
    runs = [TaskRun("t", i, "verified") for i in range(96)] + \
           [TaskRun("t", 96 + i, "failed") for i in range(4)]
    s = summarize(runs)
    assert s["meets_target_point_estimate"] is True
    assert s["meets_target_with_95pct_confidence"] is False   # need far more runs for that


def test_load_jsonl(tmp_path):
    p = tmp_path / "runs.jsonl"
    rows = [{"task_id": "open_downloads", "run": 1,
             "report": {"outcome": "verified", "tool_claimed_success": True, "decision": "done"}},
            {"task_id": "open_downloads", "run": 2,
             "report": {"outcome": "unverified", "tool_claimed_success": True}}]
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    runs = load_jsonl(str(p))
    assert [r.outcome for r in runs] == ["verified", "unverified"]
    assert summarize(runs)["false_success"] == 1
