# DOT-061 / D14 follow-up rulings, evidence for commit f7e999e (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 5bae08b (152/152).

Sources (read-only): `/workspace/dottie-e01/arch/CONTRACTS.md` @ 42fa1e9 (D14 rulings; rulings 1f, 1g, 1h), plus E01's relayed rulings: `retryOfTaskId` accepted, `committed` added (precedence unknown > possible > committed), only side effects outside `read`/`navigate` count, and the forced category skips `read`/`navigate`.

| file | case | result |
|---|---|---|
| `*_D14b-red1_tap.txt` | follow-up tests on unchanged source (src = 5bae08b). tsc exits 2 (TS2305 `ToolCatalogPort`), but JS is still emitted | **RED 1: 154 pass / 5 fail (159)** |
| `*_D14b-red2_tap.txt` | ruling 1g/1h tests, run on the working copy that already had the part-1 implementation (green at 159) | **RED 2: 158 pass / 3 fail (161)** |
| `*_D14b-mutation_summary.txt` | P1–P12 | **11/12 killed**; P12 survives (see below) |
| `*_D14b-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on the committed tree f7e999e | **GREEN: 161/161**, exit 0, 0 vulnerabilities |

Notes:
- **Tests that passed before the change** guard behaviour that already held: the precedence test, the 1f(a) "names the task the user chose" test, the missing-from-catalog test, the clean-failure policy approval test, and the approval-gated-actionId test (ruling 1g (2)). Mutants P2, P4, P9 and P11 show that these tests catch regressions.
- **P12 (invariant guard removed) survives.** That's expected: with correct derivation the guard can't fire. It is defence in depth. P9 (wrong priorTaskId derivation) is killed both with the guard (decline → no approval) and without it (wrong id asserted).
- **Commit message amended.** The code commit was first made as a52c638 and then amended, still local and unpushed, to correct the test count in its message. The tree is identical.
- **Not implemented, held as pending E08 by the E03 brief:** binding `possibleRepeat`/`retryOfTaskId` into the pre-dispatch preimage `args`. CONTRACTS @ 42fa1e9 §2.1 already lists them as E08 co-signed.

## Secret sweep
- The skill's box patterns found no hits.
- The broad sweep found 6 hits, all the test **name** "… no API-key fallback". No credential, token or key value appears.
