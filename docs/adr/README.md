# ADR index and the brief's ADR map (draft for DOT-075)

Dottie ADRs use 4-digit numbers (`ADR-NNNN`). The brief (spec v2.0 §18) lists ADR-001…010 by topic. They map like this:

| Brief | Topic | Dottie ADR | Status (2026-10-19) |
|---|---|---|---|
| ADR-001 | Codex TS SDK vs App Server | ADR-0001 (App Server) | Proposed, pending Week-1 Stage A/B |
| ADR-002 | Electron/Node boundaries; native helper | ADR-desktop-001, ADR-0005, ADR-0006 | Proposed |
| ADR-003 | Wake engine | ADR-0007 | Proposed (Q5) |
| ADR-004 | STT/TTS provider and audio mode | none yet; comes out of DOT-020 | Blocked on Q4/Q12 |
| ADR-005 | UIA strategy; screenshot fallback | none yet; DOT-077 | Not started |
| ADR-006 | Persistence / thread lifecycle | none yet; DOT-076 | Not started |
| ADR-007 | Browser profile and auth model | none yet; DOT-078 | Not started |
| ADR-008 | Installer, signing, auto-update | none yet; DOT-080 (ADR-0003 covers only Codex packaging) | Not started |
| ADR-009 | Security approval model | ADR-0009 (+ ADR-0015 for sign-in URLs) | Proposed |
| ADR-010 | Telemetry/privacy defaults | none yet; DOT-079 | Not started |

Other ADRs: 0002 ChatGPT auth (Accepted, personal use), 0003 pin, 0004 CODEX_HOME, 0008 tool hosting, 0010 state machine, 0011 monorepo, 0012 contract v2 (Accepted), 0013 supervisor (Accepted, shape only), 0014 data root, 0016 shell path.
