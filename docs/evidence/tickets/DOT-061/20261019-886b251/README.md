# DOT-061: actionId per CONTRACTS §3.3 / ADR-0009 (ActionIdPort, fail closed, validator), evidence for commit 886b251 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. No build and no installer, so `build` and `installerSha256` are null. This pack supersedes the final log in `../20261019-d02e545/`.

| file | case | result |
|---|---|---|
| `*_DOT-061-actionid-red_tap.txt` | new and updated tests plus the test fake, run against unchanged source (1e98d10). tsc reports the two missing port types, which is the expected red; JS is still emitted | **RED: 114 pass / 6 fail (120)** |
| `*_DOT-061-actionid-mutation_summary.txt` | M1–M8: validator accepts any string (Requested / Resolved), port output unchecked, unwired port falls back to an `act_` id, a throw escapes, adapter id unchecked, binding drops a null field, copy claims the user declined | **8/8 killed** |
| `*_DOT-061-actionid-e02_crosscheck.txt` | the pre-dispatch binding hashed by E02's **uncommitted** `packages/contracts/src/canonical.ts` `computeActionId` (a /tmp copy; E02's worktree was read only) compared with `FakeActionIdPort` | identical hash |
| `*_DOT-061-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on the committed tree 886b251 | **GREEN: 120/120**, exit 0, 0 vulnerabilities |

Notes:
- **One test was fixed between red and green.** The approve case in `actionId: a valid hex id flows end to end` first expected an ApprovalResolved from the coordinator on a UI approval. The UI owns that event; the coordinator re-emits only on expiry or cancel. That assertion now validates the UI-owned ApprovalResolved that carries the hex id instead.
- **Existing fixtures updated:**
  - non-hex ids in `contracts`, `coordinator` and `cancellation` tests (`act_del`, `a1`, `a` …) now use `hexId()`;
  - the 2 contract tests that failed on `a1` / `a` at the first green attempt are exactly the new validator rule working.
- **Fail-closed outcome choice:** `declined`, citing ADR-0009 CR1 ("any failure … in the hash computation … resolves as decline"). The copy is truthful and never says "you declined". This is open for E01, the alternative being `failed`.
- **Secret sweep:** clean (see below).
## Secret sweep

The pattern was `api[_-]?key|secret|token|password|bearer|authorization:|sk-…|ghp_…|PRIVATE KEY` (case-insensitive) over every file in this pack. There were 4 hits, all the test **name** "plan_limit is never retried … no API-key fallback" (2 in the red log, 2 in the final log). No credential, token or key value appears. Logs contain ids, states and kinds only.
