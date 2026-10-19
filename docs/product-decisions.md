# Product decisions (brief §26). NOT SIGNED: Gopi signs each row.

The questions come from the `docs/risks.md` Q-list and the brief §26 provisional defaults. "PROVISIONAL" means the team proceeds on the brief's safe default (brief §26: "Do not halt entirely on preference questions that have a safe default"). It is not an approval.

| # | Decision | Status | Value | Recorded |
|---|---|---|---|---|
| 1 | Audience / licensing (Q1) | **ANSWERED 2026-10-18** | Personal, single-user use only (Gopi). ADR-0002 Accepted | relayed by the parent agent |
| 1b | Repo licence + visibility (Q7) | OPEN | See `docs/LICENSE-OPTIONS.md`. Recommended: private, no licence | — |
| 2 | Voice services (Q4, Q12) | PROVISIONAL (§26.2) | Local wake required. Cloud STT/TTS allowed with notice; the cost needs separate approval. Provider, budget and key owner: OPEN | — |
| 3 | Speech response | PROVISIONAL (§26.3) | Brief and action-first; English first | — |
| 4 | Execution modes | PROVISIONAL (§26.4) | Local tasks preferred; browser only under policy; sensitive actions default-deny | — |
| 5 | Packaging (Q9, Q11) | PROVISIONAL (§26.5) | Windows 11 x64, per-user installer, manual update, optional launch at sign-in. Bundle size (Q11): OPEN | — |
| 6 | Account (Q6) | PROVISIONAL (§26.6) | Official ChatGPT/Codex login only. No API-key mode without new scope + billing approval | — |
| 7 | Capability scope | PROVISIONAL (§26.7) | Core V1 workflows (spec §17); later tiers gated | — |
| 8 | Data | PROVISIONAL (§26.8) | SQLite task summaries, explicit cleanup, no raw mic recordings | — |
| T | Test PC (Q2) | **ANSWERED 2026-10-18** | Gopi's Windows 11 Home PC, build 26200.8875 (the host name stays out of the repo: `GOPI-TEST-PC`) | — |
| — | Q3 CODEX_HOME, Q5 wake engine, Q8 busy behaviour, Q10 MDC/Dottie_Bot access, Q13 STT target, Q14 hardware, Q15 lock screen, Q16 MDC licence, reviewer accounts (BRIEF-CONFLICTS A1) | OPEN | see `docs/risks.md` | — |
