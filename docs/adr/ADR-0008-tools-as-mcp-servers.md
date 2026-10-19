# ADR-0008: Expose Dottie computer-control tools to Codex as MCP stdio servers configured in Dottie's CODEX_HOME

- Status: **Proposed. W1-S2 decides it (DOT-005). Re-reviewed 2026-10-19 against the E04 plan's preference for dynamic tools. Still not decided, because the deciding evidence (desktop access from each host) doesn't exist yet.** Date: 2026-10-18. Deciders: E01, E04, E02, E08. Spec: §4 "Tool router (MCP/adapters)", §10, §11.

## Context
- The App Server emits `mcpToolCall` items and supports MCP elicitation (`mcpServer/elicitation/request`) and app tool approvals (official page "Approvals").
- Dynamic client tools (`dynamicTools` on `thread/start`, server request `item/tool/call`) are **experimental** (official page "Dynamic tool calls (experimental)").
- Codex's own shell exec runs under the Windows sandbox (MXC/elevated/unelevated). The legacy modes "use a private desktop for stronger UI isolation"
  (https://developers.openai.com/codex/windows), so UI automation through Codex shell commands is not expected to reach the user's desktop.

## Evidence added 2026-10-19
- In the pinned 0.163.0 **stable** schema, `ThreadStartParams` has **no** `dynamicTools` field. The field appears only in the schema generated with `--experimental`
  (`docs/evidence/W1/linux-smoke/schema-0.163.0/` vs `schema-0.163.0-experimental/`; `rg -c dynamicTools`). So option (A) dynamic tools requires `capabilities.experimentalApi:true`.
  That is the experimental surface ADR-0001 avoids. The server request `item/tool/call` is listed in the stable `ServerRequest.json`.
- E04 prefers (A) because the policy gate stays in Dottie's own process (`e04-tools-plan.md:135-138`). That benefit is real. MCP (B) needs the gate inside the tool server, which ADR-0009 already requires.
- Unknown for both: whether the tool host can reach the interactive desktop. For MCP that is a grandchild of Electron through app-server; for (A) it is an E04 worker spawned by Electron main.

## Decision (proposed)
Register a `dottie-tools` MCP server (stdio) in Dottie's `config.toml`. Tools are explicit and allowlisted (pattern: `src/Bot/tools/registry.py:86-152`). Each returns
`{success, verified, observedState, error?}` (CONTRACTS.md §5). Policy is enforced inside the server (ADR-0009). Codex shell exec stays at
`sandbox: read-only` / `workspace-write` with approvals `on-request` and is not used for UI automation.

## Decision rule (W1-S2, DOT-005)
Run the same probe tool from both hosts on <pc-host>. It checks: foreground window, `IShellWindows` enumeration and active-tab `Folder.Self.Path`, `SHGetKnownFolderPath(FOLDERID_Downloads)`,
`SetForegroundWindow` under the foreground lock, and Per-Monitor-v2 DPI awareness (E11 P11).
- If MCP passes everything → (B) is Accepted.
- If only (A) passes → (A) is Accepted, together with an ADR-0001 amendment allowing `experimentalApi:true` for exactly `dynamicTools`/`item/tool/call`, and a pin-diff watch.
- If both pass → (B), because it uses the stable surface.

## Open points
- *Unverified:* whether App-Server-launched MCP servers inherit sandbox or private-desktop restrictions on Windows. If they do, use the experimental dynamic tools
  (`item/tool/call`, executed in Electron main) as plan B. That requires `experimentalApi:true` and an ADR update.
- How MCP tool approval prompts surface for a local stdio server (vs "apps"/connectors) needs verification against 0.163.0.
