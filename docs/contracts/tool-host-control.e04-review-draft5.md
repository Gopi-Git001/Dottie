# E04 review of DOT-092 `tool-host-control.md` DRAFT 5 (+ the DRAFT 5.1 reason ruling)

- Reviewer: **E04** (host sections). Mon 2026-10-19 ~01:55 CDT (UTC-5). Answers **Q-E04-9** and **Q-E04-10**.
- Reviewed: `/workspace/dottie/docs/contracts/tool-host-control.md` DRAFT 5 (read-only), `tool-host-control.E08-review.md`, plus E08's 5.1 ruling: `superseded`, `turn_end` and `end_task` become §5.7 audit reasons as they are.
- Evidence: `packages/tools/` on `feature/E04-start`. Linux, Windows mocked: 575 passed, 4 xfailed.

## Verdict
**Sign-off on the host sections, with the non-blocking fixes below.** None of them changes a security property E08 ruled on. Each one is a wording or consistency fix that E03 can fold into 5.1 or 5.2.

E04 has adopted every E08 change in the code and tests:
- items 1, 2, 5, 6, 10, 11 and 12;
- X1, X2 and X5;
- R1–R4 (host halves);
- N1.

## Adopted (host side): test ids in `packages/tools/tests`
| DRAFT 5 rule | Host behaviour | Tests |
|---|---|---|
| E08 6: token revoked at turn end and on every stop | `FakeK8.end_turn` and `stop`; `Env.next_turn` sends `setActiveTurn(null)` | TOK-09, `test_rev0*` |
| E08 5 / §4.5b: Option 1 re-mint | `approval` carries ids only. The host recomputes `actionId` and calls `requestToolToken`. On R4 codes: `APPROVAL_REQUIRED` → fresh approval; `CANCELLED` → final; `DENIED_BY_POLICY` → no fallback | TOK-09/09a–e, `test_r4_host_follows_the_re_mint_code`, K-07b |
| R4 / §5.2: a re-mint revokes the earlier unused token | reason `superseded`; no `tool_token.rejected` at re-mint | `test_r4_re_mint_revokes…` |
| E08 2: exact consume reply; consume-time state | dispatch only on `{ok:true,data:{consumed:true}}`, types checked | K-07 (host), K-06 (host) |
| R2: consume records | `postcondition_unknown` at acceptance; the second record comes only from `toolCallFinished`; disconnect → `ipc_disconnect` | `test_r2_*`, H-20 |
| R3: `gate_state_unavailable` | applies at consume, re-mint, checkPolicy and P24 | K-06b, GATE-02/02b |
| E08 12 / R1: `checkPolicy` before Explorer, plus the host's own lock and enum checks | exact `allowed:true` reply only; host lock re-check right before send | H-18/18b–e (R1 codes pass through as codes only), H-19/19b–d, C-18b (host half) |
| X1: the host writes no audit | `HostState.diag` holds reason codes and key names only. "No path in audit" tests now assert on what the host hands K8 | H-21/21b, NAV-06 |
| X2: pinned catalog, copy-check | `check_hello_catalog`: exact equality; any difference → refuse; no `mutating` field | H-12, X2/X2b/X2c |
| X5 / R4: `catalog_mismatch` | coordinator fake denies with `catalog_mismatch` | C-23 (host half) |
| R4: absent ids omitted | K8 fake `_audit` drops `None` values | `test_r4_audit_records_omit…` |
| N1 / H-13 / E08 1: peer check | `host/pipe_peer.py`: Job membership, pinned image SHA-256, start time, user + logon SID, `catalog_mismatch`; the client opens the pipe with `SECURITY_SQOS_PRESENT \| SECURITY_IDENTIFICATION` and refuses a squatting server | `test_h13*` (mocked; the real run is on `<test-pc>`) |
| 5.1 reasons | `REVOCATION_AUDIT_REASON` is a single identity table. The model sees only the ToolError code | `test_revocation_reason_reaches_the_model_only…` |

## Issues (non-blocking), each with section and fix
1. **§2.3.1 `requestApproval` row vs §4.4 last row and H-16.** §2.3.1 says "`CANCELLED` if the task was cancelled". §4.4 says "`APPROVAL_REQUIRED` if the turn is still live, **else** `CANCELLED`". A turn that ended without a cancel isn't covered by the §2.3.1 wording.
   - **Fix:** use the §4.4 wording in §2.3.1 and in H-16.
2. **`app_server_restart` has two meanings.** It appears in all of these:
   - §4.4 table: `revoked` (`app_server_restart`) → `APPROVAL_REQUIRED`;
   - §4.4 "Deny on cancel / revoke": listed as a `cancelled` CR1 bridge failure;
   - §4.6 `cancelToolCall.reason`: listed, and the call result is `CANCELLED`.

   **Fix:** pick one decision for a pending approval (E04 suggests `revoked`/`app_server_restart` → `APPROVAL_REQUIRED`, since the task is still live) and remove it from the `cancelled` list. Say explicitly that a `cancelToolCall{reason:'app_server_restart'}` gives `CANCELLED` for the in-flight call. The host follows `CANCEL_CAUSES = {task_cancel, panic_stop, quit}`.
3. **H-08 (§8.2):** "`none` → `INVALID_ARGUMENT`". `INVALID_ARGUMENT` describes model arguments (CONTRACTS §5), but a bad `ApprovalResolution.decision` is a coordinator bug.
   - **Fix:** a value outside the §3.2 enum → `DENIED_BY_POLICY` (fail closed). The host implements this, with diagnostic `unknown_decision`.
4. **§4.3 "Where host checks run" is stale.** It lists schema → scope → lookup → approval → identity re-check → consume → send. It is missing three steps:
   - the Option 1 `requestToolToken` (between lookup and approval);
   - `checkPolicy` for `navigate` (right before send);
   - the host's own lock re-check right before send.

   **Fix:** the full order is: reserved keys → context → schema → scope → host gate re-check → known folder → lookup → actionable (CONTRACTS §5) → [re-mint | requestApproval] → identity re-check → consume | checkPolicy → host lock → send → verify.
5. **§6.3 is missing the CONTRACTS §5 fail-closed observation rows** (E01): a cloaked window or a failed cloaked check → `PRECONDITION_FAILED`/`none`, and unreadable DPI never falls back to 96 → `PRECONDITION_FAILED`/`none`.
   - **Fix:** add one row citing CONTRACTS §5.
6. **X1 audit gap for host-detected refusals (§4.0 E08 12, §4.6b).** E08 12 lists `known_folder_redirected` as a `policy.denied` reason. But only the host detects it (and the host's WTS lock refusal, and schema refusals), and the host may not audit. K8 never sees these refusals.
   - **Fix:** give `toolCallFinished` an optional `reason` (lowercase §3.2 value, no paths) that K8 audits as `policy.denied`. The host already sends it (proposal **E-P8**).
7. **§4.5 verdict table and §4.5b R4 sentence vs the 5.1 reasons.** The §4.5 `DENIED_BY_POLICY` row lists "`revoked` (non-cancel cause)". R4 says "the revoked token's later use gives `revoked`".
   - **Fix:** add one note (5.1 already touches §5.7, so a cross-reference is enough): "`revoked` is the verdict and the ToolError is `DENIED_BY_POLICY`; the audit `reason` is the cause (`superseded`, `turn_end`, `end_task`, `mute`, `locked`, `app_server_restart`, `ipc_disconnect`)". Reword K-07b the same way.
8. **§2.3.1 `requestToolToken` timeout row** says "`APPROVAL_REQUIRED` if the turn is live (fall back to a fresh approval)". It's ambiguous whether the host returns `APPROVAL_REQUIRED` or first tries a fresh `requestApproval`. The host currently returns `APPROVAL_REQUIRED` and sends nothing.
   - **Fix:** say "returns `APPROVAL_REQUIRED`, no new `requestApproval` in this call".
9. **[RESOLVED by E01 ruling 1z: `packages/contracts/tool-catalog.json`]** **D13 / X2: the pinned catalog has no name.** The host's copy-check needs the file or export name in `packages/contracts`. The host uses the placeholder `packages/contracts/tool-catalog.json` (UNVERIFIED).
   - **Fix:** name it in D13.
10. **Header and §10.3 cite the old memo path** `e04-scratch/docs/contracts/tool-host-control.e04-host-positions.md`. Per E01, E04 material now lives in the E04 worktree.
    - **Fix:** use `docs/contracts/tool-host-control.e04-host-positions.md` (branch `feature/E04-start`) and add this review file.

Closed (no longer an issue):
- the revoke-reason mismatch (E08 ruled: add `superseded`, `turn_end` and `end_task` as they are);
- H-12's `mutating` field (fixed in DRAFT 4; E04's `hello_catalog` dropped it too);
- the "newer list supersedes all" wording (per-window, Q-E04-8).

## E04 positions that E08 reversed (Q-E04-10), now applied
- **E-P3:** a token carried in `approval` is replaced by ids-only plus `requestToolToken` (E08 5).
- **C5 "no end-of-turn revocation"** is replaced by revocation at turn end (E08 6). The binding is still `taskId + toolId + actionId`.
- **E-P6:** the host-declared category becomes a copy-check of the pinned catalog (X2).
- **The host's `policy.denied` writes** become no host audit (X1).
- **E-P1 ancestry check:** replaced by Job membership + pinned image hash + logon SID, with an SQOS client open (E08 1). The parent chain is at most an extra signal.
- **DRAFT 3 "a missing K8 doesn't block navigate"** becomes: no K8 → `checkPolicy` can't run → `DENIED_BY_POLICY`.
