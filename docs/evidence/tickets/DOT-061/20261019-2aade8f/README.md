# DOT-061: re-vendor E02 45129fe (plain data only), our now-covered checks removed, closed payloads: evidence for commit 2aade8f (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 7ed7517 / 0ee1e08 (278/278). Source (read-only, `git show`): dottie-e02 `feature/E02-approvals-bridge` @ 45129fe.

## Re-vendor (45129fe)
- **Changed:** `canonical.ts` (blob `3bf7343`; adds `isPlainObject` / `isPlainArray` / `hasOwn`), `display.ts` (`6c9091e`), `vectors.json` (`524d2c3`).
- **Unchanged:** `enums.ts` (`48e25aa`) and the 5 event fixtures; their blob ids match 45129fe.
- NOTICE.md, both SHA256SUMS files and the blob-id test are updated; `sha256sum -c` OK.
- **Hashes:** 75/75 byte-identical (23 actionId + 43 displays + 9 displayCuts), plus 4 pathBindings: 79 checked, 0 differences.
- **Vectors:** identical to 1530244 except two `displaysInvalid` error strings ("pre-1v shape: ui_action app fields flat", "ui_action without processImage"), as E02 said.

## Removed (the vendored code now fully covers it)
- `plainOwnDisplay` in `src/display.ts` and its export (prototype check, recursive). Its unit test in protoKeys now goes through the vendored path: `validateEvent` plus the port.
- The `own()` helper and own-only reads in `displayProblems` (`need` / `maxLen` / `maxBytes`).
- The pre_dispatch own-required-key loop (the vendored `hasOwn` required check covers it).
- The port guard was already gone (2g pair); its comment is updated.

## Kept or added (ours; the vendored code can't see these)
- **`validateEvent`** (ours; E02's `validate.ts` is not vendored):
  - records use the vendored `isPlainObject`, `'array'` fields use `isPlainArray`;
  - `checkField` reads own fields only;
  - **payloads are now closed:** any unknown own key is "not a v2 field", matched by name against the spec list, so `constructor` / `toString` / `valueOf` / `__proto__` are never "known". Before this, our validator accepted **any** extra payload key, even `notAField`.
- **`displayProblems`:** a short-circuit (`plainValue`, built only from the vendored helpers) returns the vendored issues before our event-level checks read a non-plain display, `app` or list, so no getter is ever invoked. Kept event-level checks: category equality, kind/source, pre_dispatch consistency, limits.
- **Builders:** `codexDisplay` params and `toolDisplay` fields must be plain data. The builders copy values into a fresh display, so a getter would be materialised where the vendored validator can no longer see it.
- **Also kept:** `toolDisplay`'s `Object.hasOwn` on category tables, the `/i` prefix guard and the toolCatalog `Map`.

| file | case | result |
|---|---|---|
| `*_plain-red_red_tap.txt` | final tests on 7ed7517 src + 0146c90 vendor | **RED: 279 pass / 6 fail (285)** |
| `*_plain-vendor-only_red_tap.txt` | final tests, 45129fe vendor, none of our changes | **280 pass / 5 fail**: the vendor alone closes the sparse-display gap; params getters/symbols, payload getters/symbols/unknown keys and list fields still need our boundary |
| `*_plain-vendor-hashes_hash_table.txt` | vendored 45129fe vs pinned | **79/79, 0 differences** |
| `*_plain-mutation_mutation_summary.txt` | Q1–Q9 | **9/9 killed** |
| `*_plain-final_final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 2aade8f | **GREEN: 285/285**, exit 0 |

Q2 and Q7 survived the first mutation run. The list-fields test (sparse or getter-indexed lists, event level and display) was added after the implementation to kill them, so its red is from the copy run, not from before the fix.

## Notes
- The envelope is still open in ours (E02's is closed); only payloads were closed here.
- `redactedMetadata` stays open by design.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, over the pack's log files.
- 6 hits, all the test **name** "… no API-key fallback". No credential, token or key value appears.
