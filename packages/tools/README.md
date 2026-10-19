# packages/tools (`dottie-tools`)

Owner **E04** (Windows Integration). Reviewer for `dottie_tools.targets`: **E11**. Spec §8 layout (`packages/tools/`: scoped desktop/browser/office/shell adapters).

**Status: contract layer only.** Windows is mocked; these tests run on Linux and prove contract logic, never Windows behaviour. **No Bot code** is in this package (the DOT-030 import waits on the PO's OK and DOT-003). Nothing here is production code yet.

| Path | What |
|---|---|
| `src/dottie_tools/targets/` | the shared window registry: four-field `WindowIdentity` with the CONTRACTS §3.3 wire encoding, `identify`/`liveness`, E11's `WindowIdentityService` protocol, the task-scoped candidate-id `WindowRegistry`, the scratch canonicaliser mirror |
| `src/dottie_tools/reference/` | clean-room contract reference for `explorer.open_known_folder{folder, targetId?}` (`reference.py`), the Windows seam (`ports.py`), `actionId` + fake K8 / coordinator (`approval.py`), tool catalog policy (`catalog.py`) |
| `tests/` | behavioural contract tests (TID/CTX/NOID/PIN/NAV/MUT/TOK/APH/CAT…); `tests/targets/` registry and hostile-input tests; `tests/support/` in-memory Explorer desktop and the Bot behaviour model (not Bot code) used for strict xfails |

Contracts: `docs/contracts/tools.md` (tool schema draft, E01 approves by PR) and `docs/contracts/tool-host-control.e04-host-positions.md` (E04 positions merged into E03's DOT-092 draft). Plan: `docs/plans/e04-tools-plan.md` (v1 kept at `docs/history/e04-tools-plan.v1-2026-10-18.md`).

Run: `cd packages/tools && python3 -m pytest` (Python ≥ 3.11, pytest ≥ 7).
