# DOT-061: six-key pre-dispatch binding + bound approval display (E01 1k/1l/1o/1p/1q/1r/1s/1t/1u): evidence for commit 3029c7b (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 54d047e (192/192).

Sources (read-only): `/workspace/dottie-e01/arch/CONTRACTS.md` / `BACKLOG.md`.
- Commits: 47e5fa8 (1o), 6834524 (1p), 423233a / dd082ec (1q), 08cfc6c / 819b30d (1r/1s), 1f3ac60 / b326b03 (1t).
- 1u is as relayed by the parent; it had not landed when this was read.

| file | case | result |
|---|---|---|
| `*_bind-red1_tap.txt` | binding/display/join/TaskProgress tests on unchanged coordinator/contracts (new `display.ts` draft + port types present). tsc exits 2; JS still emitted | **RED: 189 pass / 10 fail / 9 cancelled (208)** |
| `*_bind-red2_tap.txt` | 1r tests (requestSource, kind/source guard, pre_dispatch consistency, DOT-060 AC 11) on the step-1 implementation | **RED: 209 pass / 4 fail (213)** |
| `*_bind-mutation_summary.txt` | B1–B22 | **22/22 killed**. B12 survived the first run and was killed after the test fix (see below) |
| `*_bind-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 3029c7b | **GREEN: 217/217**, exit 0, 0 vulnerabilities |

Notes:
- **B12 (ui_action `app.*` fields not required) survived at first.** The display-rule test's negative cases passed no `requestSource`, so they failed for the wrong reason. Every case now passes the right `requestSource`, and B12 is killed.
- **The 1t tests have no pre-implementation red run.** They were written right after the builder change; mutants B18 (bound command stripped) and B19 (renderer strips instead of escaping) show the tests catch a regression.
- **Mutation-run safety.** `coordinator.ts`, `contracts.ts` and `display.ts` were copied before the run and compared with `cmp` afterwards: identical.

**PROVISIONAL (flagged for E01/E02):**
- **Key names.** `ApprovalDisplay` keys sit in `src/display.ts` `DISPLAY_KEYS` (one edit to rename), pending E02's type (DOT-095).
- **Codex params.** `CodexApprovalRequest.display` is `{kind:'codex_command', commandLine, workingDirectory, networkAccess:boolean, escalation?:string[], reason?:string}` or `{kind:'codex_file_change', paths:string[], reason?:string}`.
- **UI actions.** UI-action methods are `ui.*` / `window.*`; `ui_action` uses `app.{appName, windowTitle, processImage}`.
- **`tool` displays** accept extra (per-category) keys; E02 defines them.
- **`displayHash`** is in both `args` and CR2 top-level (1q).
- **The fake hash** is sorted-key canonical JSON + SHA-256. The old `PRE_DISPATCH_VECTOR_HASH` test is held until E02's regenerated vectors (1r).

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over this pack.
- 6 hits, all the test **name** "… no API-key fallback".
- No credential, token or key value appears.
