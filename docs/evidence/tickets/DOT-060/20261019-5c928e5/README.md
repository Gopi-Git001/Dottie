# DOT-060: PR 2, E01 ruling 2i (closed envelope and payload; no port field reaches an event). Evidence for commit 5c928e5 (Linux box)

E03, 2026-10-19 (CDT). This was run on the Linux box with Node v22.23.3 / npm 10.9.9 (the CI pin). It is **not** Windows evidence. `build` and `installerSha256` are null (`buildNote: n/a: unpackaged`).

**Stacked on PR 1:** `feature/E03-DOT-061-in-sweep-plain-data` (e8a0e84).

## Commits (cherry-picked; the original local SHAs are in brackets)
1. `b460215` [3f73ae7]: ruling 2i.
   - `validateEvent` closes the envelope (`ENVELOPE_KEYS`) and the nested `error` / `workspaceScope` / `committedActions[]` / `candidates[]` objects.
   - `observedState` may carry extra keys, but only with scalar values.
   - The coordinator copies port results field by field (`copyScope`, `copyError`, `copyObserved`).
   - The test `Sink` validates every emitted event.
2. `5c928e5` [a0e04f7]: the original pack `docs/evidence/tickets/DOT-061/20261019-3f73ae7/`. It is bound to the local SHA 3f73ae7 and holds the red run (287/4 of 291) and R1–R12 (12/12 killed), kept as history. Its `packages/coordinator` differs from `b460215` only by the in-sweep lines from PR 1 (10 lines in 5 test files).

## CI-equivalent checks on 5c928e5
| file | check | result |
|---|---|---|
| `20261019T115353-0500_5c928e5_DOT060-pr2-coord-clean_final-tap.txt` | coord-clean | **pass**: 291/291 pass, 0 fail |
| `20261019T115353-0500_5c928e5_DOT060-pr2-in-scan_in-scan.txt` | in-scan | **pass**: in-scan: 0 hit(s) in 39 file(s) |
| `20261019T115353-0500_5c928e5_DOT060-pr2-catalog-pin_catalog-pin.txt` | catalog-pin | **pass**: packages/contracts/tool-catalog.json: OK |
| `20261019T115353-0500_5c928e5_DOT060-pr2-docs-paths_docs-paths.txt` | docs-paths | **pass**:  |
| `20261019T115354-0500_5c928e5_DOT060-pr2-secret-scan-history_secret-scan.txt` | secret-scan-history | **pass**: secret-scan: PASS (0 hits) |
| `20261019T115356-0500_5c928e5_DOT060-pr2-secret-scan-selftest_secret-scan-selftest.txt` | secret-scan-selftest | **pass**: secret-scan self-test: PASS (canaries failed the scan and were removed) |
| `20261019T115356-0500_5c928e5_DOT060-pr2-secret-scan-coord_secret-scan-coordinator.txt` | secret-scan-coord | **pass**: secret-scan: PASS (0 hits) |

`in-scan` is the AST scan described in PR 1's pack (`docs/evidence/tickets/DOT-061/20261019-5963319/in-scan.mjs.txt`).

## Notes
- E02's adapter owns the "wire with an extra field still parses" test; the Codex wire stays tolerant at E02's adapter boundary.
- **Cross-team:** E02's `validateEvent` requires a non-null `committedActions[].observedState`. Ruling 2j (PR 3) makes `null` explicit, so E02 needs to align.

## Secret sweep
- `scripts/secret-scan.sh --history dottie/main..HEAD .` and `scripts/secret-scan.sh packages/coordinator`: PASS, 0 hits.
- No credential, token or key value appears in this pack.
