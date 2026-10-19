# DOT-061 / DOT-060: PR 1, the in-operator sweep plus the E02 45129fe plain-data re-vendor, on main. Evidence for commit 5963319 (Linux box)

E03, 2026-10-19 (CDT). This was run on the Linux box with Node v22.23.3 / npm 10.9.9 (the CI pin). It is **not** Windows evidence. `build` and `installerSha256` are null (`buildNote: n/a: unpackaged`). `dirtyTree` covers the whole repo's `git status --porcelain`, excluding `docs/evidence/`.

**Base:** `dottie/main` 079b635. Its `packages/coordinator` and `docs/evidence/tickets/DOT-061` are byte-identical to our local 0ee1e08 (ruling 2g.1). DOT-060/061 core and rulings 1x through 2g.1 are already on main.

## Commits in this PR (cherry-picked; the original local SHAs are in brackets)
1. `0a70c7e` [2aade8f]: re-vendor E02 45129fe (plain data only). This drops our own-property checks that the vendored code now covers, and closes payloads.
2. `121e78e` [e165952]: the original evidence pack `20261019-2aade8f/`. It is bound to the **local** SHA 2aade8f, which has the same tree content as `0a70c7e` for `packages/coordinator`. It holds the red run and the Q1–Q9 mutation record and is kept as history.
3. `4e69c75` [e0c1134]: the E01 in-operator sweep in the tests (`in` → `Object.hasOwn`).
4. `5963319`: finishes the sweep. An AST scan (TypeScript `InKeyword` binary expressions plus `for..in`) found 2 `in` checks that the grep-based sweep had missed: `test/possibleRepeat.test.ts:172` and `test/toolHost.test.ts:75`.

## CI-equivalent checks on 5963319
| file | check | result |
|---|---|---|
| `20261019T115257-0500_5963319_DOT061-pr1-coord-clean_final-tap.txt` | coord-clean | **pass**: 285/285 pass, 0 fail |
| `20261019T115258-0500_5963319_DOT061-pr1-in-scan_in-scan.txt` | in-scan | **pass**: in-scan: 0 hit(s) in 38 file(s) |
| `20261019T115258-0500_5963319_DOT061-pr1-catalog-pin_catalog-pin.txt` | catalog-pin | **pass**: packages/contracts/tool-catalog.json: OK |
| `20261019T115258-0500_5963319_DOT061-pr1-docs-paths_docs-paths.txt` | docs-paths | **pass**:  |
| `20261019T115258-0500_5963319_DOT061-pr1-secret-scan-history_secret-scan.txt` | secret-scan-history | **pass**: secret-scan: PASS (0 hits) |
| `20261019T115301-0500_5963319_DOT061-pr1-secret-scan-selftest_secret-scan-selftest.txt` | secret-scan-selftest | **pass**: secret-scan self-test: PASS (canaries failed the scan and were removed) |
| `20261019T115301-0500_5963319_DOT061-pr1-secret-scan-coord_secret-scan-coordinator.txt` | secret-scan-coord | **pass**: secret-scan: PASS (0 hits) |

The `in-scan` check is `in-scan.mjs`, an AST walk (a verbatim copy is in this pack as `in-scan.mjs.txt`; run it with `node in-scan.mjs <pkgdir> <files…>`). It walks over every tracked `.ts` file in `packages/coordinator` (src, the vendored files and the tests) and finds 0 `in` operators and 0 `for..in`.

## Secret sweep
- `scripts/secret-scan.sh --history dottie/main..HEAD .` and `scripts/secret-scan.sh packages/coordinator`: PASS, 0 hits.
- The self-test passes.
- No credential, token or key value appears in this pack.
