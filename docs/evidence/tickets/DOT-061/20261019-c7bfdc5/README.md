# DOT-061 / D14: possible-repeat retry approval (test C-25), evidence for commit c7bfdc5 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null. Base: a18eae2 (124/124).

Sources (read-only, `/workspace/dottie/docs/contracts/tool-host-control.md` DRAFT 8, APPROVED): §4.4 (E08 ruling 4 addition (2)), §4.6, port delta D14, test C-25. Contract shape: E01's revision on 2026-10-19, `possibleRepeat?: {priorTaskId, priorSideEffect: 'possible' | 'unknown'}`, taken from the prior task's ledger or `ToolResult.sideEffect`, never from an outcome. This replaces the earlier `priorOutcome` proposal, which the validator now rejects.

| file | case | result |
|---|---|---|
| `*_DOT-061-D14-red_tap.txt` | 14 new tests in `test/possibleRepeat.test.ts` on unchanged source (src = a18eae2). tsc exits 2 with the expected TS2353/TS2339 errors (`retryOfTaskId` and `possibleRepeat` don't exist yet), but JS is still emitted, so the tests run | **RED: 129 pass / 9 fail (138)** |
| `*_DOT-061-D14-mutation_summary.txt` | bug-reintroduction check. M1–M14: read accepted, open shape/`priorOutcome` accepted, no forced approval, warning on read, `unknown` signal dropped, in-flight `possible` dropped, secure_ui not required, retry deduped by text, unknown prior not fail-closed, cancelled tasks not remembered, wrong priorTaskId, empty id accepted, committed-only treated as a repeat, adapter fields passed through | **14/14 killed** |
| `*_DOT-061-D14-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on the committed tree c7bfdc5 | **GREEN: 138/138**, exit 0, 0 vulnerabilities |

## C-25 mapping (`test/possibleRepeat.test.ts`)
| C-25 clause / task item | test(s) | red on a18eae2? |
|---|---|---|
| non-read retry after `sideEffect:'unknown'` → fresh approval, new actionId, `possibleRepeat{priorTaskId, unknown}` | "a non-read retry after a sideEffect:unknown attempt…" | red |
| the same after ledger `possible` (side-effecting tool never reported; also via a cancel) | "…ledger:possible attempt…", "…CANCELLED with possible side effects…" | red |
| `read` retry shows no warning | "a read-category retry gets no possibleRepeat…" | passes on base (guard: base never emits the field) |
| clean failure → no warning | "…after a clean failure (ledger none)…" | passes on base (guard) |
| committed-only is not a possible repeat (E01 trigger) | "…only committed side effects…" | passes on base (guard; M13 kills it) |
| validator: rejects on read, malformed, old `priorOutcome` | "validator (D14): possibleRepeat…" | red |
| validator: PROPOSED `UtteranceReady.retryOfTaskId` | "validator (D14, PROPOSED)…" | red |
| Codex/model auto-retry never opens an approval or dispatches | "…a Codex/model auto-retry never happens…" | passes on base (guard; the §1.5 rule already holds) |
| Codex can't set `possibleRepeat`; no retry without the user field | "…only the user retry field marks a repeat…" | passes on base (guard; M14 kills it) |
| never auto-approved: deny / expiry / voice / tray → declined, 0 runs | "…never auto-approved…", "…non-secure_ui channel… inside the retry" | red |
| dedupe/idempotency: new taskId not deduped by text; a requestId replay is | "dedupe/idempotency…" | red |
| unknown prior fails closed | "…a task the coordinator has no record of…" | red |

The dialog text ("this action may already have happened", with Approve disabled until it shows) is E06's secure UI. It isn't covered here: the coordinator only supplies the flag.

## Secret sweep
- The skill's box sweep (`eyJ…`, `refresh_token`, `access_token`, `code_challenge`, `sk-…`, `Bearer `, `CANARY-`) found no hits.
- The broad sweep (`api[_-]?key|secret|token|password|bearer|authorization:|ghp_|PRIVATE KEY|DESKTOP-|email`, case-insensitive) found 4 hits. All 4 are the test **name** "plan_limit is never retried … no API-key fallback" (2 in the red log, 2 in the final log). No credential, token or key value appears.
