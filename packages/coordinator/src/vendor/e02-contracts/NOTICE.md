# Vendored: E02 `packages/contracts` (DOT-090 computeActionId / ApprovalDisplay)

- **Source:** `/workspace/dottie-e02`, branch `feature/E02-approvals-bridge`, commit `45129fe9b9e6ab98d009c88620a3cc2183ef9b43` ("contracts: validators take plain data objects only; hasOwn for every key check (E03 report)"), on top of 0146c90 (E01 1y follow-up), 2581593 (E01 2b, pins dottie-e01 97e7bc0), cc22afb (2a additions), 93535e5 (Node 20 check), ffc68da (2a) and 455ce18 (1z). canonical.ts, display.ts and vectors.json changed vs 0146c90 (vectors: two displaysInvalid error strings only; no hash changed); enums.ts and the event fixtures are unchanged. Previously vendored: 895676d, 2581593, then 0146c90.
- **Owner:** E02 (Dottie, same project; internal code, no third-party licence).
- **Files** (verbatim, byte-identical, git blob ids at 45129fe):

| file | source path | git blob |
|---|---|---|
| `canonical.ts` | `packages/contracts/src/canonical.ts` | `3bf7343e6e00877b5634794bc5a937ba7cd6a99c` |
| `display.ts` | `packages/contracts/src/display.ts` | `6c9091e788cf627914c314fceeed4e2e52645765` |
| `enums.ts` | `packages/contracts/src/enums.ts` | `48e25aadf78b5dbe8022a241d69af75bde92f6cd` |
| `test/fixtures/e02/vectors.json` | `packages/contracts/fixtures/action-id/vectors.json` | `524d2c311f91c3b2c86022b5b1cdeaa0dccdc4b9` |
| `test/fixtures/e02/events/invalid/approval-requested-display-category-mismatch.json` (tool) | `packages/contracts/fixtures/events/invalid/…` | `a710e49fbeabfaaa1fcffec831664048938aa526` |
| `test/fixtures/e02/events/invalid/approval-requested-pre-dispatch-category-mismatch.json` | same dir | `9bbe6b258bea75ec5e9bfd59b4ab6bc3bb386131` |
| `test/fixtures/e02/events/invalid/approval-requested-ui-action-category-mismatch.json` | same dir | `56d5cccf91a13359a7268377aaa016b2ee7890ec` |
| `test/fixtures/e02/events/invalid/approval-requested-codex-command-category-mismatch.json` | same dir | `afd9ca67c9adca857f982bf130675eb6a6f9cd93` |
| `test/fixtures/e02/events/invalid/approval-requested-codex-file-change-category-mismatch.json` | same dir | `6e3842830e2c6f54139d9554af228a761c9d681c` |

- **SHA-256:** see `SHA256SUMS` (here, in `test/fixtures/e02/` and in `test/fixtures/e02/events/invalid/`). `test/e02Vectors.test.ts` fails if a vendored file's hash changes without this NOTICE and the SUMS being updated.
- **Why vendored:** the coordinator has no runtime dependencies. It imports only Node built-ins (`node:crypto`, `node:path`) through these files, so it doesn't depend on `@dottie/contracts` (whose engines field is Node ≥22; these three files compile and run on Node 20 under our tsconfig).
- **Rules:** never edit these files. Local behaviour belongs in `src/display.ts` / `src/actionIdPort.ts`. To re-vendor, copy the files from the new E02 commit unchanged, update this table, both `SHA256SUMS` files and the pins in the tests, then run `npm test`.
