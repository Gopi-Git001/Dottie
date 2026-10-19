# docs/: where things moved (DOT-003)

Until 2026-10-19 the architecture lived in `/workspace/dottie/arch/` on the shared box. The import **copied** it here:

| Old (box) | New |
|---|---|
| `spec.md` v1.0 | `history/spec-v1.0-2026-10-18.md`. `spec.md` here is **v2.0** (Gopi's brief). §1–§16 are identical; v1's §17 "final acceptance" is now §27 |
| `arch/ARCHITECTURE.md` | `architecture.md` |
| `arch/CONTRACTS.md` | `contracts/CONTRACTS.md` (v2) |
| `arch/adr/ADR-NNNN-*.md` | `adr/` (next to `ADR-desktop-001`). Brief ADR-001…010 ↔ these: `adr/README.md` |
| `arch/RISKS.md`, `arch/BACKLOG.md`, `arch/WEEK1_GO_NO_GO.md` | `risks.md`, `backlog.md`, `week1-go-no-go.md` |
| `arch/TRIAGE-2026-10-18.md`, `arch/BRIEF-CONFLICTS-2026-10-19.md`, `arch/ISSUES-DRAFT.json` | `triage/` |
| `arch/history/` | `history/` |
| `arch/evidence/linux-smoke/`, `codex-0.163.0-windows-assets.sha256` | `evidence/W1/` |
| `arch/evidence/week1-probe/` | `../scripts/week1-probe/` (the script + its Linux self-test) |
| `arch/evidence/secret-sweep-2026-10-19.md` | `security/secret-sweep-2026-10-19.md` |
| `audit.md`, `skills-review/` | `reviews/` |
| `provenance/` (E01) | `provenance/` (commits recorded under the wrong identity) |
| `docs/e04/e04-tools-plan.md` (E04 branch) | `plans/e04-tools-plan.md` (v1 in `history/`). `perf-reliability-plan.md` and `voice-plan.md` are not imported (never committed) |
| `e10/baseline.md`, `e10/sim/` | **not imported** (never committed on an E10 branch; the MDC mirror is also out: Q16) |
| `src/verifier/` | `../packages/verifier/` |

Path references inside E01's moved files were rewritten mechanically (evidence packs, history, reviews and other owners' files are untouched). No host names were found.
The linux-smoke transcript's cancelled sign-in URL was already redacted at the source commit.
`requirements-matrix.md` (DOT-009) and `weekly-status.md` (brief §7) are stubs.
