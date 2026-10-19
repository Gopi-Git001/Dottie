# ADR-0001: Use Codex App Server (stdio) as the sole Codex integration

- Status: **Proposed**. It becomes Accepted only when WEEK1_GO_NO_GO passes on Windows 11.
- Date: 2026-10-18. Deciders: E01 (owner), E02, E08. Spec: §2, §4, §5.

## Context
Spec §2 says to pick **either** the TS SDK **or** App Server after a PoC, with no dual control path. Spec §5 needs an in-app "Sign in with ChatGPT",
an account-state read, session reuse and logout.
- TS SDK (`src/codex/sdk/typescript/src/codexOptions.ts`) exposes only `codexPathOverride, baseUrl, apiKey, config, configOverrides, env`. No file in
  `sdk/typescript/src` mentions login (checked with `rg -n login`). The SDK runs `codex exec --experimental-json` (audit §3). It cannot start or observe a ChatGPT login.
- App Server has `account/login/start|cancel`, `account/logout`, `account/read`, `account/login/completed` and `account/updated`, plus thread/turn/approval
  methods (`app-server-protocol/src/protocol/common.rs`). All of these were checked in the 0.163.0 generated schema (`docs/evidence/W1/linux-smoke/schema-0.163.0/`).
  Official docs: "Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent
  events" (https://developers.openai.com/codex/app-server).

## Decision
Electron main spawns `codex app-server --listen stdio://` as a supervised child and talks JSONL JSON-RPC to it. The TS SDK is not used. The Python SDK
(`sdk/python`) is a *reference* for message order only.

## Alternatives
1. TS SDK + `codex login` CLI helper. Rejected: no in-app status or logout, and an opaque login (spec §5 says "Do not simulate a native OAuth flow").
2. App Server over WebSocket. Rejected: "experimental and unsupported" (official page).
3. Fork Codex core. Rejected: spec §2.

## Consequences
- Dottie owns protocol lifecycle work: the handshake, request IDs, server requests (approvals), restarts and version skew.
- The protocol is large and many fields are `experimental`. Dottie uses only the stable surface (`experimentalApi:false`) unless a later ADR decides otherwise.
- The official page also says "The app-server command and WebSocket transport are experimental and aren't supported for production workloads" (in the
  Code Mode host section). **Ambiguous**: it is unclear whether this covers the stdio app-server as a whole. This is RISKS R2 and an open question.
