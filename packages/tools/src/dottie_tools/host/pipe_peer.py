"""Pipe peer checks, DOT-092 DRAFT 5 §2.2 (E08 item 1, N1/H-13, R4). Reference model with Windows mocked:
proves the decision logic only; the Win32 calls are named, not made. Not derived from Bot.

Server side (Electron main, E08-owned; modelled here so the host tests pin the same rule): ALL must pass,
in this order, else the peer is disconnected and K8 writes toolhost.peer_rejected{outcome:'denied', reason}
with actionId/taskId/toolId OMITTED (R4):
  0 a live connection already exists                         -> second_connection
  1 GetNamedPipeClientProcessId + GetProcessTimes: the client is a member of the app-server Job
    (IsProcessInJob(client, dottieJob))                      -> not_in_job        (replaces the parent chain)
  2 its image SHA-256 equals the build-pinned value          -> image_mismatch
  3 its start time still matches the pid (PID reuse)          -> start_time_mismatch
  4 its token's user SID and logon SID equal main's          -> sid_mismatch
  5 hello.catalog equals the pinned catalog                  -> catalog_mismatch  (R4, C-19)
A refused peer never counts as "the one live connection".

Client side (this host): CreateFileW on the pipe with SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, so a
squatting server can't impersonate the host; then GetNamedPipeServerProcessId -> the server image must be
the Dottie main executable with a matching start time, else the host refuses the pipe.
"""
from __future__ import annotations

from dataclasses import dataclass

SECURITY_SQOS_PRESENT = 0x00100000
SECURITY_IDENTIFICATION = 0x00010000          # SecurityIdentification << 16
PEER_REJECT_REASONS = ("second_connection", "not_in_job", "image_mismatch", "start_time_mismatch",
                       "sid_mismatch", "catalog_mismatch")


def client_open_flags() -> int:
    """dwFlagsAndAttributes for CreateFileW on the control pipe (E08 1)."""
    return SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION


@dataclass(frozen=True)
class PeerFacts:
    """What the server reads about a connecting client. None = could not be read (fails closed)."""
    pid: int | None
    start_time: int | None
    start_time_now: int | None          # GetProcessTimes re-read for that pid at check time
    in_job: bool | None
    image_sha256: str | None
    user_sid: str | None
    logon_sid: str | None


@dataclass(frozen=True)
class Expected:
    image_sha256: str                   # build-pinned (TB4 rule)
    user_sid: str
    logon_sid: str


def server_check(peer: PeerFacts, expected: Expected, *, live_connection: bool,
                 catalog_ok: bool | None = True) -> str | None:
    """None = accept; otherwise the toolhost.peer_rejected reason. Unreadable facts fail closed."""
    if live_connection:
        return "second_connection"
    if peer.in_job is not True:
        return "not_in_job"
    if not isinstance(peer.image_sha256, str) or peer.image_sha256.lower() != expected.image_sha256.lower():
        return "image_mismatch"
    if peer.start_time is None or peer.start_time_now is None or peer.start_time != peer.start_time_now:
        return "start_time_mismatch"
    if peer.user_sid != expected.user_sid or peer.logon_sid != expected.logon_sid or peer.logon_sid is None:
        return "sid_mismatch"
    if catalog_ok is not True:
        return "catalog_mismatch"
    return None


def rejection_record(reason: str) -> dict:
    """K8's audit record for a refused peer: ids omitted, never null; no catalog contents (R4)."""
    return {"kind": "toolhost.peer_rejected", "outcome": "denied", "reason": reason}


@dataclass(frozen=True)
class ServerFacts:
    image_path: str | None
    start_time: int | None
    start_time_now: int | None


def client_accepts_server(server: ServerFacts, dottie_main_image: str, open_flags: int) -> bool:
    """Host side: refuse a pipe whose server is not Dottie main (squat), or one opened without SQOS."""
    if open_flags & client_open_flags() != client_open_flags():
        return False
    if not isinstance(server.image_path, str) or server.image_path.lower() != dottie_main_image.lower():
        return False
    return server.start_time is not None and server.start_time == server.start_time_now
