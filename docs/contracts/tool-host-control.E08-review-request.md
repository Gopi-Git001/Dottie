# E08 review request: DOT-092 tool-host control channel (token + pipe parts)

> **STATUS: ANSWERED** by E08 on 2026-10-19 (CDT) in `tool-host-control.E08-review.md`: **ACCEPT WITH CHANGES**. E03 accepts every change; all applied in `tool-host-control.md` **DRAFT 4** (item → section map in its §10.2). Answers in brief: 1 change (no secret; logon-SID DACL; Job/image-hash/SID checks); 2 accept with changes; 3 accept (K8 in main, no broker); 4 accept; 5 Option 1 with changes (no token in `approval`, new `requestToolToken`), Option 2 rejected; 6 TTL/burn accepted, token now revoked at turn end and every stop; 7 accept with changes (256-bit per-launch key); 8 accept with changes; 9 accept with changes (five kinds); 10 accept with changes (`consumed_not_dispatched`); 11 accept; 12 change (no token, two K8 checks incl. `checkPolicy`). Extra findings X1–X7 applied. Small follow-ups left for E08: Q-E08-9 in DRAFT 4 §9 (P24a, `consumed_not_dispatched` in the outcome list, late-reply detection, catalog-mismatch audit kind, re-mint error codes, X5 reason). The text below is the original DRAFT 3 request, kept for the record.

- **To:** E08 (Platform/Security), required reviewer for the token parts (BACKLOG DOT-092; ADR-0009 CR6).
- **From:** E03 (with E04). **Doc:** `docs/contracts/tool-host-control.md` **DRAFT 3** (2026-10-19 CDT). Sections in scope: **§2.2** (pipe), **§2.3.1** (fail-closed timeouts), **§4.4–§4.5** (approval round-trip and token consume), **§5** (token, marked *E08 review*), **§6.5** (phase rule), tests **§8.3 K-01…K-04** and **H-07, H-11, H-13, H-14**.
- **Blocks:** DOT-031 and DOT-090 (A9-I2). DOT-092 AC 3 needs your review recorded.
- **Already aligned with you:** CR6 purpose `dottie.approvalToken.v1` (your follow-up 4, BACKLOG DOT-092); one canonicaliser + test vectors (CONTRACTS §3.3); token value/mac/nonce never logged; never in model args, results, MCP `_meta` or events (§5.6).

## Decisions requested (please answer each: accept / change / reject)
1. **Pipe peer authentication (§2.2, E-P1, Q-E08-1).** Name is derived from SHA-256(`"dottie.toolhost.pipe.v1"` ‖ user SID ‖ logon session), not a secret. Main creates it first-instance with a current-user DACL, rejecting remote clients, max one instance. Peer check both ways (ancestry, image path and process start time). A pre-existing name counts as squatting: the tools don't start and an audit record is written. Is that enough **without a handshake secret**? If you want a secret: env-allowlist carrier (DOT-089 `env.ts`), per-launch random, never logged.
2. **CR6 "tool server verifies it" (§4.5, Q-E08-2).** `k8Key` never leaves main, so the host can't check the MAC. Its re-check is to recompute `actionId` from what it's about to do, then call `consumeToolToken`, a round-trip where K8 answers yes or no. Does that satisfy CR6?
3. **Minter (§5.2, Q-E08-3).** Does the K8 module in main mint directly, or an E08 broker? The coordinator only relays the token in `ApprovalResolution`.
4. **Binding (§5.3, Q-E08-5).** `taskId + toolId + actionId`. **`turnId` is dropped** (E03+E04, §10 C5), because retries or the approved call can land on a later turn, and `actionId` already covers the resolved args and the 4-field window identity. Wire form is `k8t1.<tokenId>.<mac>`, with MAC input `{actionId, expiresAt, nonce, purpose:"dottie.approvalToken.v1", taskId, toolId}`.
5. **C5 vs CR2 (§5.3, Q-E08-7, with E01).** `turnId` is still in the CR2 `actionId` preimage, so a later-turn retry recomputes a different `actionId`. Pick one:
   - **Option 1 (E-P3):** `authorizeToolCall` returns the approved binding ids, and K8 re-mints a fresh token from the still-live approval. No CR2 change.
   - **Option 2:** E01 amends CR2 to drop `turnId` (E04's memo also drops `itemId`/`requestId`) from `actionId`.
6. **TTL and single use (§5.4–§5.5, Q-E08-4).** `expiresAt = min(approval.expiresAt, mint + 10 s)`. Burned on **any** consume attempt, including a mismatch. Revoked by `endTask`, task cancel, the ADR-0009 item 7 events and IPC disconnect, but **not** by the end of a turn. One live token per approved `actionId`.
7. **Key rotation (§5.8, P20).** Per-process `k8Key` only, with no in-process rotation in V1.
8. **Storage (§5.6, Q-E08-5).** Memory only on both sides. The host drops the token after consume, `cancelToolCall` or `endTask`. Excluded from crash dumps (DOT-091).
9. **Audit (§5.7, Q-E08-6).** New kinds `tool_token.minted | consumed | rejected` (reasons `reused | expired | revoked | wrong_action | task_mismatch | tool_mismatch | unknown_token | missing`), plus one kind for a refused pipe peer or squatted name. Add `token`/`toolToken` keys and the `k8t1.` prefix to the redactor.
10. **Fail-closed timeouts (§2.3.1, E-P2).** Consume timeout of 2 s → `DENIED_BY_POLICY`. No K8 wired → `DENIED_BY_POLICY`. Nothing dispatches on a timeout.
11. **Cancel-caused revocation (§4.4–§4.5, C7).** A token or approval revoked by a task cancel yields tool `CANCELLED`, `sideEffect:'none'`, not `DENIED_BY_POLICY`, so cancel reports stay truthful. The audit decision is `revoked`/`task_cancel` (CONTRACTS §3.2).
12. **`navigate` (§4.0, Q-E08-8).**
    - Does a `navigate` call need a CR6 token? E04 says no.
    - Approve **P24 + P24a** (**E04 agrees**, fail-closed). For a `navigate` call, `authorizeToolCall` reads the K8 gate state (locked, panic-stop, mute) with no token. Any of those → `DENIED_BY_POLICY`, `sideEffect:'none'`, reason `locked`/`panic_stop`/`mute`. An unreadable state, a stale one (snapshot older than 1000 ms, or missing/future `observedAt`) or no K8 wired → `DENIED_BY_POLICY`, `sideEffect:'none'`, reason `gate_state_unavailable`. Needs `PolicyPort.gateState()` (D8). Tests C-18a…h; E04 is adding host-side tests.
    - Does "after panic-stop or mute" mean while muted, or for the rest of the task?

## Not for E08
Everything else in DRAFT 3 (message shapes, idempotency, versioning, port deltas) goes to E01 in `tool-host-control.E01-approvals.md`.
