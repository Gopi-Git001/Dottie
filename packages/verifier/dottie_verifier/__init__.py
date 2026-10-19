"""Dottie verification layer (E11 Computer-Use Reliability).

A tool's own "success"/"verified" flags are recorded as evidence, never as proof.
Every workflow passes only when its observed postconditions hold.
Windows access goes through the ``WindowsApi`` protocol, so the logic runs on Linux with fakes.
"""

from dottie_verifier.model import (
    Check,
    CheckStatus,
    Outcome,
    VerificationReport,
)

__all__ = ["Check", "CheckStatus", "Outcome", "VerificationReport"]
