# E11 → E01: proposed contract changes (for approval; nothing applied)

**Status 2026-10-19: ruled by E01** (`docs/triage/TRIAGE-2026-10-18.md`, ADR-0012, CONTRACTS v2). Accepted: P1 (modified, no `cancelled` outcome), P2 (drop `success`; `isError = !verified`), P3–P11. Deferred: P12 (E08, DOT-074). The verifier implements v2 (DOT-064); see verifier-design §15.

Date: 2026-10-18 (CDT). Scope: CONTRACTS.md §3/§5, BACKLOG DOT-031, WEEK1 W1-S2. None of these are implemented in shared code; the verifier only emits the current draft shapes.

| # | Change | Why |
|---|---|---|
| P1 | `TaskFinished.outcome ∈ {succeeded, partial, unverified, failed, cancelled}` (+ E03's `answered, declined, blocked_auth` if accepted). Define `partial` = "goal state verified but a non-critical postcondition failed/unknown, OR failure after a committed side effect" — or split into `partial` and `failed_after_side_effect`. Mapping from verifier: verified→succeeded, partially_verified→partial, unverified→unverified, failed→failed (→partial if `sideEffect≠none`, E03 rule), cancelled→cancelled. | ARCHITECTURE §8 requires "unverified" to be spoken; CONTRACTS enum lacks it; "partial" currently has two meanings (E03 vs E11). |
| P2 | §5: `success` := `verified` for v1 (tool returns `success:true` only when its postconditions were observed). Or drop `success`. | §5 lists both without semantics; a `success:true, verified:false` result invites false-success speech. |
| P3 | `observedState` is an **object** (as §5), not a string (E03 `contracts.ts`). Minimum keys: `outcome`, `decision`, `checks: {id: pass\|fail\|unknown}`, `sideEffect`; optional `question`. Redacted: no titles, file contents or full user paths (evidence stays in local artifact). | §5 vs E03 code conflict; keeps payload small and safe for logs. |
| P4 | §3 `ToolResult.error?` uses the §5 object `{code, message, retryable}` instead of an untyped string. | One error shape end-to-end; coordinator can branch on `code`. |
| P5 | Adopt `sideEffect ∈ {none, committed, unknown}` into `ToolResult` v1 (from E03 extension); E04 plan's `ATTEMPTED` maps to `unknown`. | Coordinator retry safety already depends on it; three vocabularies exist today. |
| P6 | Tool-level clarification: `error.code=AMBIGUOUS` + `observedState.question` (+ optional `candidates`) is the sanctioned "ask" path; Codex speaks the question. No new event. | `requestUserInput` is unsupported in v1 (ADR-0009); verifier needs ASK for two-window / wrong-target cases. |
| P7 | Optional `ToolResult.evidenceRef` (local artifact id of the full verification report). | E07 trace replay / RB09 evidence without putting raw evidence on the bus. |
| P8 | DOT-031 AC: "verified by IShellWindows active-tab `Folder.Self.Path` == `SHGetKnownFolderPath(FOLDERID_Downloads)` (final-path compare; UIA as fallback; never window title)". | Current AC "verified by UIA" is the weaker signal (localized titles, OneDrive redirection). |
| P9 | Approve Explorer window-adoption rule (verifier-design §3): adopt the foreground Explorer already at target, or the single window at target; >1 candidate → ASK; never adopt by title. | E04 plan asks E01/E11 for this; it is user-visible behavior. |
| P10 | Confirm MCP tool id `explorer.open_known_folder{folder}` (ARCHITECTURE §5) as the `toolId` in ToolResult. | Verifier passes toolId through; Bot used `open_downloads`. |
| P11 | Extend W1-S2: from the dottie-tools MCP child (grandchild of Electron via app-server) confirm `IShellWindows` enumeration, `SHGetKnownFolderPath`, `GetForegroundWindow`, `SetForegroundWindow` (foreground lock), PMv2 DPI awareness. | Verifier depends on these; spike only checks foreground title today. |
| P12 | E08 to define policy scope for verifier recovery primitives (restore, focus, move-to-monitor, shell navigate) — proposed: covered by the original `desktop.control` approval for the same HWND within the task, no new prompt. | Implemented deny-by-default gate needs a production decision. |

Noticed, not E11-owned: `ApprovalRequested.risk` enum differs (CONTRACTS `low/sensitive/destructive/external/financial` vs E03 `low/medium/high/critical`); `endReason` casing/values differ (CONTRACTS `vadSilence,timeout,userStop,maxLength` vs E03 `vad_silence,timeout,max_duration,user_stop`).
