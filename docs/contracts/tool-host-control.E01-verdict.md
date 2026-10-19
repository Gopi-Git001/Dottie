# E01 verdict: DOT-092 tool-host control channel, DRAFT 5 (38 items)

- **From:** E01, 2026-10-19 ~01:52 CDT. **Against:** `tool-host-control.md` DRAFT 5 and `tool-host-control.E01-approvals.md`.
- **Overall:** APPROVED WITH TWO AMENDMENTS (items 24 and 35). This sign-off takes effect once E08's spot-check of the R1–R4 paste and E04's DRAFT 5 sign-off are both recorded in the doc. The three items that need a run on Gopi's PC (K-08, H-13, and the restricted/AppContainer/Low-IL token question) gate DOT-031 completion, not this design.

| Item | Verdict | Note |
|---|---|---|
| 1–23, 20b | approve | 7: a late consume reply never dispatches. 21: turnId stays bound through actionId. |
| 24 | **amend** | Approve the kinds, outcomes and redactor keys and pattern. Because `toolhost.*` records omit `actionId`, `taskId` and `toolId`, CONTRACTS §3.2 makes those three fields optional, and **required for every kind except `toolhost.*`**. The validator enforces that per kind. |
| 25–34 | approve | 27: ADR-0010 is amended by E01. 28: E01 flips §2.5 to a link when signed. 29: fix the comment in the next E03 commit. |
| 35 | **amend** | Approve the K8 record states and the purpose and prefix cross-rejection. Strike "(or `approved`)": a recovery token (ADR-0017) is minted **only from an `executed` approval**, before expiry, because recovery restores after an action that actually ran. `executed` is not a §3.2 decision. |
| 36 | approve | Reasons are lowercase snake_case per the casing rule. |
| 37 | approve | `AuditRecord.toolId?: string`, plus the `tool_token.consumed` outcomes `consumed`, `consumed_not_dispatched` and `postcondition_unknown`. |

**E01 applies on sign-off:** CONTRACTS §2.5 becomes a link to this doc; §3.2 gets the kinds, the outcomes, `toolId?`, the per-kind field requirements, and the reasons `not_navigate_member`, `gate_state_unavailable`, `catalog_mismatch` and `ipc_disconnect`; §5 gets the targetId lifetime rules (item 11) and the "Tool-host context" update. ADR-0010 changes to "single active task", and ADR-0017's wording gets the executed-only recovery mint. E02 adds the pinned tool catalog and the audit kinds to `packages/contracts` (item 34, E08-reviewed).
