# ADR-0005: Process model, IPC and supervision

- Status: **Proposed**. *2026-10-19: the restart/backoff policy is defined only in ADR-0013. The "Supervisor" bullet below is replaced by it.* Date: 2026-10-18. Deciders: E01, E06, E09, E08. Spec: §4 "Process separation", §9.1, §13.3–13.5.

## Decision
- One per-user Electron app started at user sign-in through a per-user startup entry (no Session-0 service). Single instance.
- Electron **main** owns the lifecycle, the IPC broker, the coordinator (K3), the Codex adapter client (K4), policy (K8) and the store (K11).
- **Renderer** is sandboxed with `contextIsolation`, exposes only typed preload APIs, and never receives secrets, raw audio or tokens.
- **Children:** `audio-worker` and `codex-app-server` are both supervised. MCP tool servers are children *of App Server* (ADR-0008).
  Spawn with `windowsHide:true` (no console, spec §9.1).
- Supervisor: ~~restart only crashed children, using exponential backoff (1 s → 60 s cap) and at most 5 restarts per 10 min before showing an ERROR state.~~ See ADR-0013. A user Quit means no restart.
  After an app-server restart: `initialize` → `initialized` → `account/read` → `thread/resume` for any active thread. An in-flight turn at crash time is
  reported as "unknown/interrupted", never as completed.
- IPC: typed messages validated against `packages/contracts` (zod or equivalent) with schema `v` and correlation IDs (CONTRACTS.md §4).

## Alternatives
Run app-server inside the main process (impossible; it is a separate binary). A privileged Windows service (spec §13.3 forbids it).

## Consequences
E09 must measure the RAM/CPU of an always-running app-server (eager mode) against lazy start. That is an open measurement.
