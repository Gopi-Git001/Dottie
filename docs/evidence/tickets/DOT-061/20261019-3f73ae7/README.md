# DOT-061: E01 ruling 2i (closed envelope and payload; no port field reaches an event): evidence for commit 3f73ae7 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 2aade8f / e165952 (285/285).

## What changed

**`validateEvent` (src/contracts.ts)**
- **The envelope is closed.** Known keys: schema, version, type, eventId, correlationId, causationId?, taskId?, timestamp, payload. Any other own key is "not a v2 field", matched by name against the list, so `constructor` / `__proto__` are never known. A missing `payload` is rejected.
- Getters, symbol keys, inherited fields and class instances on the envelope were already rejected by the vendored `isPlainObject` (2aade8f); those tests are kept as regression.
- **Nested payload objects are closed as in E02's validateEvent:**
  - `error`;
  - `workspaceScope` {scopes ∈ CapabilityScope, paths: strings};
  - `committedActions[]` {toolId, observedState or null, certainty};
  - `candidates[]` {id, label};
  - `possibleRepeat`.
- `observedState` admits tool-specific keys only with scalar values (E02's `scalar` rule).

**Coordinator (src/coordinator.ts)**
- Port results are copied field by field, never passed through.
  - **Fixed leaks:** the Codex tool result `error` (an adapter `stack` reached ToolResult), `observedState` (non-scalar extras dropped, logged `coordinator.port_field.dropped` by count) and the policy `workspaceScope`.
  - **Already whitelisted, now tested:** the ToolResult top level, ApprovalRequested (Codex request fields), and TaskFinished (run result).

**Sweep:** `test/helpers.ts` `Sink` validates every event any test's coordinator emits; an invalid one fails that test file at exit. With the full suite (291 tests, all emit sites) it is clean.

| file | case | result |
|---|---|---|
| `*_2i-red_red_tap.txt` | final tests (ruling2i + helpers sweep) on 2aade8f src | **RED: 287 pass / 4 fail (291)** |
| `*_2i-mutation_mutation_summary.txt` | R1–R12 | **12/12 killed** |
| `*_2i-final_final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 3f73ae7 | **GREEN: 291/291**, exit 0, sweep clean |

R12 (the coordinator adds an extra envelope key to every event) is caught by the sweep in 21 test files.

## Notes
- **E02's adapter owns the "wire with an extra field still parses" test.** The Codex App Server wire stays tolerant at E02's adapter boundary; nothing changed here.
- **Cross-team mismatch:** E02's validateEvent requires a non-null `committedActions[].observedState`. Ours, and the coordinator, use `null` for a tool still in flight at the stop (`CommittedAction.observedState: ObservedState | null`). E01/E02 should settle this.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, over the pack's log files.
- 4 hits, all the test **name** "… no API-key fallback". No credential, token or key value appears.
