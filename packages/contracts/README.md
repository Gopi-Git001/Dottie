# @dottie/contracts (E01 + E02)

Shared contracts for Dottie: the event and IPC schemas (CONTRACTS v2), action-id vectors, the Codex App Server schema generated from the pinned 0.163.0 binary, and the hash-pinned tool catalog (`tool-catalog.json`, reviewed with E08).

```sh
cd packages/contracts
npm ci
npm run check            # tsc, including the generated schema
npm run vectors:check
npm run schemas:check
npm test                 # node:test
```

Needs Node 22. `codex:check` needs the pinned Codex binary (`CODEX_BIN`) and stays skipped in CI. The Python jsonschema cross-check runs when `jsonschema` is installed (`DOTTIE_PYTHON`).
