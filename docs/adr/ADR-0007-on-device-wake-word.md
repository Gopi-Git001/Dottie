# ADR-0007: On-device wake word; no audio leaves the device in STANDBY

- Status: **Proposed. The engine choice is pending license and cost review (Open Q5).** Date: 2026-10-18. Deciders: E01, E05, E10, E08. Spec: §3, §9 steps 2–5, §14.

## Context
The spec requires local "Dottie" detection and names Porcupine (https://picovoice.ai/docs/quick-start/console-porcupine/). Both existing voice codebases stream
the mic continuously to the cloud (`src/Bot/voice_assistant.py:438-452`; MDC per audit, ❓). That violates §9.2.

## Decision
The audio worker runs wake-word detection locally. Until a wake event: no network calls from the audio path, and no buffering beyond the detector window.
The Porcupine custom keyword "Dottie" is the default candidate, subject to Picovoice licence terms for the PO's distribution model. An open-source alternative
is evaluated in the same spike for comparison. Benchmarks are the spec §14 targets.

## Consequences
Licence and AccessKey handling for Porcupine (a credential Dottie *does* own, which is separate from ChatGPT). The false-wake and latency harness is owned by E10.
