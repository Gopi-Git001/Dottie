"""Artifact postconditions: saved files, completed downloads, shell process results.

These use the real filesystem through ``os`` and run the same on Linux and Windows.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Callable
from dataclasses import dataclass

from dottie_verifier.model import Check, CheckStatus

PARTIAL_SUFFIXES = (".crdownload", ".part", ".partial", ".download", ".tmp", ".opdownload")
ContentCheck = Callable[[str], "tuple[bool, str]"]


def sha256_of(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while block := fh.read(chunk):
            h.update(block)
    return h.hexdigest()


def _stat(path: str):
    try:
        return os.stat(path)
    except OSError:
        return None


def check_file_saved(
    path: str,
    started_at: float,
    *,
    min_size: int = 1,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
    content_check: ContentCheck | None = None,
    mtime_tolerance: float = 2.0,
    prefix: str = "FILE",
) -> list[Check]:
    """FILE-01..05: present, sized, written by this action, not locked/temp, meaningful content."""
    st = _stat(path)
    checks = [Check(f"{prefix}-01", "File exists at the expected path and is a regular file",
                    CheckStatus.PASS if st and os.path.isfile(path) else CheckStatus.FAIL,
                    evidence={"path": path}, source="os.stat")]
    if st is None:
        for n, d in ((2, "size"), (3, "mtime"), (4, "not locked"), (5, "content")):
            checks.append(Check(f"{prefix}-0{n}", f"File {d}", CheckStatus.UNKNOWN,
                                critical=n != 4))
        return checks

    size_ok = st.st_size >= min_size and (expected_size is None or st.st_size == expected_size)
    checks.append(Check(f"{prefix}-02", "File size matches expectation",
                        CheckStatus.PASS if size_ok else CheckStatus.FAIL,
                        evidence={"size": st.st_size, "min_size": min_size,
                                  "expected_size": expected_size}, source="os.stat"))
    fresh = st.st_mtime >= started_at - mtime_tolerance
    checks.append(Check(f"{prefix}-03", "File was modified by this action (mtime >= action start)",
                        CheckStatus.PASS if fresh else CheckStatus.FAIL,
                        evidence={"mtime": st.st_mtime, "action_started_at": started_at,
                                  "tolerance_s": mtime_tolerance}, source="os.stat"))
    folder, name = os.path.split(path)
    # Excel/PowerPoint: "~$Name.xlsx"; Word replaces the first two characters: "~$port.docx".
    lock_names = {"~$" + name, "~$" + name[2:]} if len(name) > 2 else {"~$" + name}
    lock_present = any(os.path.exists(os.path.join(folder, n)) for n in lock_names)
    readable = True
    try:
        with open(path, "rb") as fh:
            fh.read(1)
    except OSError:
        readable = False
    checks.append(Check(f"{prefix}-04", "File is readable and no Office owner lock file remains",
                        CheckStatus.PASS if readable and not lock_present else CheckStatus.FAIL,
                        critical=False,
                        evidence={"readable": readable, "office_lock_present": lock_present}))

    if expected_sha256:
        digest = sha256_of(path) if readable else ""
        ok, detail = digest == expected_sha256.lower(), {"sha256": digest,
                                                         "expected": expected_sha256}
        status = CheckStatus.PASS if ok else CheckStatus.FAIL
    elif content_check:
        try:
            ok, msg = content_check(path)
            status, detail = (CheckStatus.PASS if ok else CheckStatus.FAIL), {"detail": msg}
        except Exception as exc:  # noqa: BLE001
            status, detail = CheckStatus.FAIL, {"error": str(exc)}
    else:
        status, detail = CheckStatus.UNKNOWN, {"reason": "no content check supplied"}
    checks.append(Check(f"{prefix}-05", "File content is meaningful (hash or format/content check)",
                        status, evidence=detail))
    return checks


def check_download_complete(
    path: str,
    started_at: float,
    *,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
    magic: bytes | None = None,
    browser_reported_failure: str | None = None,
    stability_interval: float = 0.5,
    sleep: Callable[[float], None] = time.sleep,
    mtime_tolerance: float = 2.0,
) -> list[Check]:
    """DL-01..06: final file exists, no in-progress sibling, size stable, integrity, fresh."""
    st1 = _stat(path)
    checks = [Check("DL-01", "Downloaded file exists at its final name",
                    CheckStatus.PASS if st1 else CheckStatus.FAIL, evidence={"path": path})]
    folder = os.path.dirname(path) or "."
    base = os.path.basename(path)
    try:
        siblings = os.listdir(folder)
    except OSError:
        siblings = []
    partial = [s for s in siblings
               if s.lower().endswith(PARTIAL_SUFFIXES)
               and s.startswith((base, os.path.splitext(base)[0]))]
    checks.append(Check("DL-02", "No in-progress partial file (.crdownload/.part/...) remains",
                        CheckStatus.FAIL if partial else CheckStatus.PASS,
                        evidence={"partial_files": partial}))
    if st1 is None:
        checks += [Check(i, d, CheckStatus.UNKNOWN) for i, d in
                   (("DL-03", "Size stable and non-zero"), ("DL-04", "Integrity"),
                    ("DL-05", "Fresh"))]
        checks.append(Check("DL-06", "Browser reported no failure",
                            CheckStatus.FAIL if browser_reported_failure else CheckStatus.UNKNOWN,
                            evidence={"failure": browser_reported_failure}))
        return checks
    sleep(stability_interval)
    st2 = _stat(path)
    stable = st2 is not None and st2.st_size == st1.st_size and st1.st_size > 0
    checks.append(Check("DL-03", "Size is non-zero and stable across two samples",
                        CheckStatus.PASS if stable else CheckStatus.FAIL,
                        evidence={"size_1": st1.st_size, "size_2": st2.st_size if st2 else None,
                                  "interval_s": stability_interval}))
    integrity = CheckStatus.UNKNOWN
    ev: dict = {}
    if expected_sha256:
        digest = sha256_of(path)
        integrity = CheckStatus.PASS if digest == expected_sha256.lower() else CheckStatus.FAIL
        ev = {"sha256": digest, "expected_sha256": expected_sha256}
    elif expected_size is not None:
        integrity = CheckStatus.PASS if st1.st_size == expected_size else CheckStatus.FAIL
        ev = {"size": st1.st_size, "expected_size (Content-Length)": expected_size}
    elif magic is not None:
        with open(path, "rb") as fh:
            head = fh.read(len(magic))
        integrity = CheckStatus.PASS if head == magic else CheckStatus.FAIL
        ev = {"magic_expected": magic.hex(), "magic_observed": head.hex()}
    else:
        ev = {"reason": "no hash, Content-Length or magic bytes to check against"}
    # Without any integrity reference the result can be at most partially verified.
    checks.append(Check("DL-04", "Integrity: sha256, Content-Length or file signature matches",
                        integrity, critical=integrity is not CheckStatus.UNKNOWN, evidence=ev))
    fresh = st1.st_mtime >= started_at - mtime_tolerance
    checks.append(Check("DL-05", "File was written after the action started",
                        CheckStatus.PASS if fresh else CheckStatus.FAIL,
                        evidence={"mtime": st1.st_mtime, "action_started_at": started_at}))
    checks.append(Check("DL-06", "Browser reported no download failure",
                        CheckStatus.FAIL if browser_reported_failure else CheckStatus.PASS,
                        evidence={"failure": browser_reported_failure},
                        source="Playwright download.failure()"))
    return checks


@dataclass
class ProcessRun:
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool = False
    cancelled: bool = False
    still_running: bool = False


ResultPredicate = Callable[[ProcessRun], "tuple[bool, str]"]


def check_process_result(
    run: ProcessRun,
    *,
    meaningful: ResultPredicate | None,
    expected_exit_codes: frozenset[int] = frozenset({0}),
    stderr_must_be_empty: bool = False,
) -> list[Check]:
    """PROC-01..04. Exit code alone is never enough: without a ``meaningful`` predicate
    PROC-03 is UNKNOWN and the result can at best be UNVERIFIED."""
    finished = (not (run.timed_out or run.cancelled or run.still_running)
                and run.exit_code is not None)
    checks = [Check("PROC-01", "Process finished (not timed out, cancelled or still running)",
                    CheckStatus.PASS if finished else CheckStatus.FAIL,
                    evidence={"timed_out": run.timed_out, "cancelled": run.cancelled,
                              "still_running": run.still_running})]
    if run.exit_code is None:
        checks.append(Check("PROC-02", "Exit code is expected", CheckStatus.UNKNOWN))
    else:
        checks.append(Check("PROC-02", f"Exit code in {sorted(expected_exit_codes)}",
                            CheckStatus.PASS if run.exit_code in expected_exit_codes
                            else CheckStatus.FAIL, evidence={"exit_code": run.exit_code}))
    if meaningful is None:
        checks.append(Check("PROC-03", "Meaningful result postcondition", CheckStatus.UNKNOWN,
                            evidence={"reason": "no result predicate supplied; "
                                                "exit code alone is insufficient"}))
    else:
        try:
            ok, msg = meaningful(run)
            checks.append(Check("PROC-03", "Meaningful result postcondition",
                                CheckStatus.PASS if ok else CheckStatus.FAIL,
                                evidence={"detail": msg}))
        except Exception as exc:  # noqa: BLE001
            checks.append(Check("PROC-03", "Meaningful result postcondition", CheckStatus.FAIL,
                                evidence={"error": str(exc)}))
    stderr = run.stderr.strip()
    checks.append(Check("PROC-04", "stderr is clean (PowerShell non-terminating errors exit 0)",
                        CheckStatus.FAIL if stderr else CheckStatus.PASS,
                        critical=stderr_must_be_empty, evidence={"stderr_head": stderr[:500]}))
    return checks
