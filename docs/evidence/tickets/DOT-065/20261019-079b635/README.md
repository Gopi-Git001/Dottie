# DOT-065 evidence (issue #35): E04 tools plan vocabulary aligned with v2

Base: `main` at 079b635 (PR #1). Branch `e04/dot-065-tools-plan`. Run on the box, Mon 2026-10-19 ~11:55 CDT (UTC-5). Commands and raw output: `checks.txt`.

Finding: on `main` the plan is at `docs/plans/e04-tools-plan.md` (v1 at `docs/history/`, see `docs/README.md` row for `docs/e04/`). The v2 vocabulary content was already imported in PR #1. This change fixes the stale paths: the `packages/tools/README.md` plan link (`docs/e04/` doesn't exist on main), the v1 link, and two links to `docs/contracts/tool-host-control.md`, which isn't on `main` yet (it's E03's DOT-092 doc).

| AC | Result | Evidence (checks.txt) |
|---|---|---|
| 1 RiskClass → severity floor + category | PASS | plan lines 190–197 |
| 2 ErrorCode per §5 list | PASS (list present; E01/E08 to confirm it matches CONTRACTS §5) | plan lines 208–210 |
| 3 ATTEMPTED → `unknown` | PASS | plan line 199 |
| 4 Hosting → ADR-0008 | PASS; "dynamic preferred" 0 hits | plan line 21 |
| 5 Shell → ADR-0016 | PASS | plan line 22 |
| 6 NEEDS_APPROVAL/ATTEMPTED only in mapping table | PASS: 2 hits, lines 198–199 | first command |

`packages/tools`: 748 passed, 4 xfailed. Secret sweep: 0 hits; the plan uses `<test-pc>`. Still needed: E08 review of the RiskClass rows.
