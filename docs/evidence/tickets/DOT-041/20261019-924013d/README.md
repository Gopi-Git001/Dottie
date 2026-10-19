# DOT-041: PR 3, E01 ruling 2j (TaskCancelled.committedActions[].observedState: ObservedState | null; still running → stop_unconfirmed). Evidence for commit 924013d (Linux box)

E03, 2026-10-19 (CDT). This was run on the Linux box with Node v22.23.3 / npm 10.9.9 (the CI pin). It is **not** Windows evidence. `build` and `installerSha256` are null (`buildNote: n/a: unpackaged`).

**Stacked on PR 2:** `feature/E03-DOT-060-closed-envelope` (5c7765a).

## Commits (cherry-picked; the original local SHAs are in brackets)
1. `bfc01aa` [799370b]: ruling 2j.
   - `validateEvent`, TaskCancelled:
     - (a) a null `observedState` needs certainty `possible`;
     - (b) any null entry means stopStatus is not `stopped_no_side_effects` / `completed_before_stop`, and sideEffects is ≥ `possible`;
     - (d) the key itself is still required, so null must be explicit.
   - (c) The copy says "still running when the stop was requested; its result is unknown".
   - `StopInputs.toolsInFlight` was added.
2. `924013d` [f4855b5]: the original pack `docs/evidence/tickets/DOT-061/20261019-799370b/`. It holds the red run (293/7 of 300) and J1–J12 + R9 (13/13 killed), kept as history.

## New truth-table row (E01-approved; for E07 review)
| dispatched | completedBeforeStop | side-effecting tool still in flight | → stopStatus |
|---|---|---|---|
| yes | yes (cancel in VERIFYING: the run completed, the verifier was pending) | yes (started, never reported) | **`stop_unconfirmed`** (was `completed_before_stop` + "already finished") |

That old path was the one coordinator emit that violated 2j: a null entry together with `completed_before_stop` and done-copy. It is fixed in `bfc01aa`. Test: `test/ruling2j.test.ts`, "the run completed but the tool never reported (cancel during VERIFYING)".

## CI-equivalent checks on 924013d
| file | check | result |
|---|---|---|
| `20261019T115419-0500_924013d_DOT041-pr3-coord-clean_final-tap.txt` | coord-clean | **pass**: 300/300 pass, 0 fail |
| `20261019T115420-0500_924013d_DOT041-pr3-in-scan_in-scan.txt` | in-scan | **pass**: in-scan: 0 hit(s) in 40 file(s) |
| `20261019T115420-0500_924013d_DOT041-pr3-catalog-pin_catalog-pin.txt` | catalog-pin | **pass**: packages/contracts/tool-catalog.json: OK |
| `20261019T115420-0500_924013d_DOT041-pr3-docs-paths_docs-paths.txt` | docs-paths | **pass**:  |
| `20261019T115420-0500_924013d_DOT041-pr3-secret-scan-history_secret-scan.txt` | secret-scan-history | **pass**: secret-scan: PASS (0 hits) |
| `20261019T115422-0500_924013d_DOT041-pr3-secret-scan-selftest_secret-scan-selftest.txt` | secret-scan-selftest | **pass**: secret-scan self-test: PASS (canaries failed the scan and were removed) |
| `20261019T115422-0500_924013d_DOT041-pr3-secret-scan-coord_secret-scan-coordinator.txt` | secret-scan-coord | **pass**: secret-scan: PASS (0 hits) |

## Secret sweep
- `scripts/secret-scan.sh --history dottie/main..HEAD .` and `scripts/secret-scan.sh packages/coordinator`: PASS, 0 hits.
- No credential, token or key value appears in this pack.
