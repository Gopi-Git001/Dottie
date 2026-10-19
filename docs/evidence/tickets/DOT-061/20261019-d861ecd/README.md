# DOT-061 / DOT-092 ruling 1d: required actionId on authorizeToolCall, evidence for commit d861ecd (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 0e2b198 (138/138).

Sources (read-only): `/workspace/dottie-e01/arch/CONTRACTS.md` @ de045c9 §5 "navigate checks" (ruling 1d, E08 confirm; 1e pending) and `/workspace/dottie/docs/contracts/tool-host-control.md` DRAFT 8.1 §4.3/§4.5c. The doc doesn't have 1d folded in yet. E01's 1d clarifications and 1f (schema → `INVALID_ARGUMENT`, value never named) arrived as relayed rulings.

| file | case | result |
|---|---|---|
| `*_DOT-061-1d-red_tap.txt` | 14 new tests (`test/toolCallActionId.test.ts`), plus the existing tool-host tests and `FakeToolHost` moved to the params-object call, all on unchanged source. tsc exits 2 (TS2305/TS2554), but JS is still emitted, so the tests run | **RED: 114 pass / 38 fail (152)**. 24 of the 38 are existing tests that go through the new fake host call (signature collateral), not new behaviour |
| `*_DOT-061-1d-mutation_summary.txt` | N1–N9: check removed, any string accepted, missing accepted, case-insensitive hex, ruling-1c code `PRECONDITION_FAILED`, actionId checked before reserved keys, actionId checked before the active turn, id value logged, retryable:true | **9/9 killed** |
| `*_DOT-061-1d-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on the committed tree d861ecd | **GREEN: 152/152**, exit 0, 0 vulnerabilities |

Notes:
- **Amended commit.** The code commit was first made as 94239f9 and then amended, still local and unpushed, to add README documentation of E01's 1d clarifications. Only `README.md` differs between the two, so the mutation run on 94239f9's source applies to d861ecd.
- **Interrupted first mutation run.** The first run stopped after about 3 s, with mutant N1 still applied in `src/coordinator.ts`. That file was restored from the commit before the recorded run. The interrupted run produced no results.
- **Check order** (first failure wins, all `sideEffect:'none'`): reserved key → `INVALID_ARGUMENT`; no active turn or stop → `PRECONDITION_FAILED`; actionId missing or not 64 lowercase hex → `DENIED_BY_POLICY`.

## Secret sweep
- The skill's box patterns found no hits.
- The broad sweep found 4 hits, all the test **name** "… no API-key fallback". No credential, token or key value appears.
