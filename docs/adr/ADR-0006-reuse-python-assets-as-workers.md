# ADR-0006: Reuse existing Python Windows-tool code as a supervised worker. Do not port it in Week 1-5.

- Status: **Proposed**. Date: 2026-10-18. Deciders: E01, E04, E11, E05. Spec: §16.1 "preserve working code"; audit §2, risk 5.

## Context
The only real Windows desktop control code is Python: `src/Bot/tools/desktop_tools.py` (1,736 lines) and `file_tools.py` (963 lines) on branch
`fix/unexpected-session-exit` @ 5268c8d. It has no tests. Its approval flow is in `voice_assistant.py` and fails open (lines 545–547). The target shell is Electron/TS.

- 2026-10-19: `tools/desktop_tools.py` and `tools/file_tools.py` are **identical** on Bot `main` 504da3e and `5268c8d`. `git -C src/Bot diff --stat main 5268c8d` lists only `tools/session_tools.py` and `voice_assistant.py`.
  Tool imports therefore pin to `main` 504da3e (skills-review #19). The fail-open references to `voice_assistant.py` stay at 5268c8d.

## Decision
- Wrap the Bot tool *functions* (not `voice_assistant.py` and not its approval flow) as a **Python MCP stdio server** "dottie-tools" (ADR-0008), after first adding
  characterization tests on Windows CI. Ship it with an embedded, pinned Python runtime that is signed with the app.
- Re-implement approval and policy gating in code at the MCP boundary (ADR-0009). Do not use model-supplied `overwrite=True` as consent.
- The audio worker language is **open** (Python reusing sounddevice/MDC patterns vs Node native). This is decided in the P1 spike (BACKLOG DOT-020).

## Alternatives
A full TS port now (slower, and it discards verified Explorer logic). Use Python for everything (conflicts with the spec's Electron shell).

## Consequences
Packaging, signing and supervising a Python runtime. Two languages in CI. Licenses for pywin32/pywinauto/pyautogui/mss/pycaw must be inventoried (spec §5 Licensing).
