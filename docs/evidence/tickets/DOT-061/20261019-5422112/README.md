# DOT-061: E01 ruling 2c (desktop display_unavailable for any unshowable ApprovalRequested, every source): evidence for commit 5422112 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 7b8a148 / b5e2e20 (253/253). Source: dottie-e01 a147dbe (ruling 2c).

**Finding: not already covered; a real bug.** `resolveApproval` settled a desktop `ApprovalResolved{approved:false, reason:'display_unavailable'}` as `denied`:
- a Codex request got `denied`, not `display_unavailable`;
- a pre-dispatch confirmation ended `declined` with no reason and the user-decline line "Okay, I won't do that.".

The only existing test ("E01 1n: … declines (fail closed)") checked the outcome `declined` and no Codex run, nothing more.

**Fix:** that answer now settles `{approved:false, reason:'display_unavailable'}`.

| file | case | result |
|---|---|---|
| `*_2c-red_tap.txt` | the three per-source tests on 7b8a148 src | **RED: 254 pass / 2 fail (256)** ((a) Codex got `denied`; (c) TaskFinished had no `approval_unavailable` reason). (b) passed on the old code |
| `*_2c-mutation_summary.txt` | C1–C6 | **6/6 killed**. C2 ("any decline → display_unavailable") first survived. It was killed after adding the contrast test (a plain "no" stays `denied` / declined without a reason). That test came after the fix, so it has no red run |
| `*_2c-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 5422112 | **GREEN: 257/257**, exit 0 |

**Per source** (test/ruling2c.test.ts):
- **(a) codex:** answered exactly once with `{approved:false, reason:'display_unavailable'}`.
- **(b) tool_host:** the coordinator has no tool-host dialogs. K8 (E08/E04) owns those approvals and their tokens, so nothing to refuse or mint exists here. A display_unavailable or a later approve for a tool-host actionId is `rejected unknown_action`; no event, no state change, no Codex run, no speech. **Not covered here:** "no token minted / tool call refused / nothing executes" is K8's to test.
- **(c) pre_dispatch:** TaskFinished `declined{approval_unavailable}`, zero Codex dispatch, and the line "couldn't ask for your approval safely". **Contract note:** CONTRACTS §3 TaskFinished allows only `approval_unavailable` with `declined`. `display_unavailable` is the approval-level reason, so no `TaskFinished` reason `display_unavailable` was added; that would need an E01/E02 contract change.

**Every source:** the coordinator emits no ApprovalResolved (the desktop's is the only one), no TTS says the user declined, and a later approve is `already_resolved` (a/c) or `unknown_action` (b).

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over the pack's log files.
- 4 hits, all the test **name** "… no API-key fallback".
- No credential, token or key value appears.
