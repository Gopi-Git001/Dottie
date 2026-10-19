import hashlib
import os
import time
import zipfile

from dottie_verifier.artifacts import (
    ProcessRun,
    check_download_complete,
    check_file_saved,
    check_process_result,
)
from dottie_verifier.model import Outcome, classify


def ids(checks):
    return {c.id: c.status.value for c in checks}


def docx_ok(path):
    with zipfile.ZipFile(path) as z:
        return ("word/document.xml" in z.namelist(), "has word/document.xml")


def make_docx(path, text="hello"):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", f"<w:t>{text}</w:t>")


def test_saved_docx_verified(tmp_path):
    start = time.time()
    p = tmp_path / "Report.docx"
    make_docx(p)
    checks = check_file_saved(str(p), start, content_check=docx_ok)
    assert classify(checks) is Outcome.VERIFIED, ids(checks)


def test_missing_file_failed(tmp_path):
    checks = check_file_saved(str(tmp_path / "nope.txt"), time.time())
    assert classify(checks) is Outcome.FAILED


def test_stale_file_not_written_by_this_action(tmp_path):
    p = tmp_path / "old.txt"
    p.write_text("x")
    os.utime(p, (time.time() - 3600, time.time() - 3600))
    checks = check_file_saved(str(p), time.time(), content_check=lambda _: (True, ""))
    assert ids(checks)["FILE-03"] == "fail" and classify(checks) is Outcome.FAILED


def test_size_mismatch_and_hash(tmp_path):
    start = time.time()
    p = tmp_path / "a.bin"
    p.write_bytes(b"abc")
    assert ids(check_file_saved(str(p), start, expected_size=4))["FILE-02"] == "fail"
    good = hashlib.sha256(b"abc").hexdigest()
    assert classify(check_file_saved(str(p), start, expected_sha256=good)) is Outcome.VERIFIED
    assert ids(check_file_saved(str(p), start, expected_sha256="00" * 32))["FILE-05"] == "fail"


def test_no_content_check_means_unverified(tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("x")
    assert classify(check_file_saved(str(p), time.time() - 1)) is Outcome.UNVERIFIED


def test_office_lock_file_is_partial(tmp_path):
    start = time.time()
    p = tmp_path / "Budget.xlsx"
    p.write_bytes(b"PK..")
    (tmp_path / "~$Budget.xlsx").write_bytes(b"")
    checks = check_file_saved(str(p), start, content_check=lambda _: (True, ""))
    assert ids(checks)["FILE-04"] == "fail"
    assert classify(checks) is Outcome.PARTIALLY_VERIFIED


def test_download_complete_with_content_length(tmp_path):
    start = time.time()
    p = tmp_path / "file.pdf"
    p.write_bytes(b"%PDF-1.7 body")
    checks = check_download_complete(str(p), start, expected_size=13, sleep=lambda s: None)
    assert classify(checks) is Outcome.VERIFIED, ids(checks)


def test_download_still_in_progress(tmp_path):
    start = time.time()
    p = tmp_path / "file.pdf"
    p.write_bytes(b"%PDF")
    (tmp_path / "file.pdf.crdownload").write_bytes(b"partial")
    checks = check_download_complete(str(p), start, magic=b"%PDF", sleep=lambda s: None)
    assert ids(checks)["DL-02"] == "fail" and classify(checks) is Outcome.FAILED


def test_download_growing_between_samples(tmp_path):
    start = time.time()
    p = tmp_path / "big.zip"
    p.write_bytes(b"PK" + b"0" * 10)

    def grow(_s):
        with open(p, "ab") as fh:
            fh.write(b"more")

    checks = check_download_complete(str(p), start, magic=b"PK", sleep=grow)
    assert ids(checks)["DL-03"] == "fail"


def test_download_without_integrity_reference_is_partial(tmp_path):
    p = tmp_path / "x.bin"
    p.write_bytes(b"data")
    checks = check_download_complete(str(p), time.time() - 1, sleep=lambda s: None)
    assert ids(checks)["DL-04"] == "unknown"
    assert classify(checks) is Outcome.PARTIALLY_VERIFIED


def test_download_hash_mismatch_and_browser_failure(tmp_path):
    p = tmp_path / "x.bin"
    p.write_bytes(b"data")
    checks = check_download_complete(str(p), time.time() - 1, expected_sha256="0" * 64,
                                     browser_reported_failure="canceled", sleep=lambda s: None)
    assert ids(checks)["DL-04"] == "fail" and ids(checks)["DL-06"] == "fail"


def test_process_exit_zero_alone_is_not_verified():
    checks = check_process_result(ProcessRun(0, "ok", ""), meaningful=None)
    assert classify(checks) is Outcome.UNVERIFIED


def test_process_meaningful_result():
    run = ProcessRun(0, "Name : notes.txt\nLength : 42", "")
    ok = check_process_result(run, meaningful=lambda r: ("notes.txt" in r.stdout, "listed"))
    assert classify(ok) is Outcome.VERIFIED
    bad = check_process_result(run, meaningful=lambda r: ("report.txt" in r.stdout, "missing"))
    assert classify(bad) is Outcome.FAILED


def test_powershell_nonterminating_error_exit_zero_is_partial():
    run = ProcessRun(0, "done", "Get-Item : Cannot find path 'C:\\x'")
    checks = check_process_result(run, meaningful=lambda r: (True, ""))
    assert classify(checks) is Outcome.PARTIALLY_VERIFIED


def test_process_timeout_and_bad_exit():
    assert classify(check_process_result(ProcessRun(None, "", "", timed_out=True),
                                         meaningful=lambda r: (True, ""))) is Outcome.FAILED
    assert classify(check_process_result(ProcessRun(1, "", ""),
                                         meaningful=lambda r: (True, ""))) is Outcome.FAILED
