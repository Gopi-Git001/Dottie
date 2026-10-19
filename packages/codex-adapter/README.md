# @dottie/codex-adapter (E02)

Codex App Server client for Dottie: a supervised stdio child, JSON-RPC, ChatGPT auth, the server-request and approvals bridge, and the child env allowlist. Implements `CodexPort` and `AuthPort` from `@dottie/contracts`.

```sh
cd packages/codex-adapter
npm ci
npm run check
npm test                 # node:test against fakes
```

Needs Node 22. The live smoke (`npm run test:live`) talks to the pinned 0.163.0 binary and stays skipped unless `DOTTIE_CODEX_BIN` is set. CI does not set it. Sign-in is ChatGPT only; there is no API-key fallback.
