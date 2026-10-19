# DOT-061 / E01 rulings 1i, 1j, 1k (c), 1l, 1m (2) + pinned catalog SHA: evidence for commit 54d4aba (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: fbb4a8d (161/161).

Sources (read-only): `/workspace/dottie-e01/arch/CONTRACTS.md` @ 5b6b3f5, 060cd60/0aa0c9d, 19c14eb, e93907c (rulings 1i, 1j, 1k, 1l), plus E01's relayed 1m (2), which wasn't in E01 HEAD (e93907c) when this was run.

| file | case | result |
|---|---|---|
| `*_1j-red-step1_tap.txt` | catalog tests, no `toolCatalog.ts` (the module is missing, so the whole file fails to load) | RED: 139 pass / 1 fail (140) |
| `*_1j-red-step2_tap.txt` | API-only stub, catalog/precedence/1j/1i tests | RED: 160 pass / 7 fail (167) |
| `*_1j-red-step3_tap.txt` | retry-set, throwing-lookup and join tests on the step-2 implementation | RED: 172 pass / 9 fail (181) |
| `*_1j-red_tap.txt` | the final test suite on the parent's `coordinator.ts` and `contracts.ts` (toolCatalog.ts present) | **RED: 167 pass / 16 fail (183)** |
| `*_1j-mutation_summary.txt` | Q1–Q16, Q5b | **16/17 killed**; Q5 is equivalent (see below) |
| `*_1j-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on the committed tree 54d4aba | **GREEN: 185/185**, exit 0 |

Notes:
- **Q5 (the `end !== 'cancelled'` guard removed) survives because it is equivalent.** `'cancelled'.outcome` is undefined, so `RETRYABLE_OUTCOMES` already rejects it. Q5b, which records a cancel as `failed`, is killed.
- **Tests that pass before the change** (they characterise behaviour or guard regressions): the 1l empty-ledger `unverified` and failed-`categoryOf` forced-category tests, the old "partial" classification test (optional, moved to DOT-007 by 060cd60), and the 1m (2) expiry test. The coordinator already emitted one `ApprovalResolved{approved:false}` per actionId on timeout.
- **An interrupted mutation run** left Q13 (`'tray'` → `'tray_REMOVED'`) applied. It was found by grep and restored, and the working copy was re-verified green at 183 before the run was repeated.
- Interpretations (ambiguities) are in the commit report: the unknown floor for uncategorised tools, a late join after an *approved* resolution, and 1m's `decision:'expired'` field.

## Secret sweep
- Pattern: `api[_-]?key|secret|token|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over this pack and `src/toolCatalog.ts`.
- 10 hits in the TAP files, all in one test **name** ("DOT-061: plan_limit is never retried: … no API-key fallback"), plus the heading in this README.
- No credential, token or key value appears.
