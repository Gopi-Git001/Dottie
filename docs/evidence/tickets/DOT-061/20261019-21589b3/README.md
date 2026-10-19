# DOT-061: re-vendor E02 0146c90 (1y follow-up), case-insensitive `hasUiActionPrefix`, own-property-only key lookups: evidence for commit 21589b3 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: 5422112 / a86d6af (2c, 257/257). Source: dottie-e02 `feature/E02-approvals-bridge` @ 0146c90 (read-only).

## Re-vendor (0146c90)
- `display.ts` changed (blob `0498f79`); `canonical.ts` (`36bfbaf`) and `enums.ts` (`48e25aa`) unchanged. `vectors.json` → blob `1530244`. NOTICE.md and both SHA256SUMS updated; `sha256sum -c` OK for all four; the blob-id test checks them.
- **Earlier hashes: 77 checked, 0 differences** (23 actionId + 41 displays + 9 displayCuts + 4 pathBindings, i.e. the 73 required plus the pathBindings).
- **New:** 2 accepted displays pinned (uix.click `257971a2…`, file.read `4bcf7734…`), 0 differences; the 5 new rejected vectors (ui.Click, `window.`, UI.x, Window.close, ui.click as a tool) are rejected by the vendored validator, and the builder-reachable ones are refused by our builders too. Counts: 43 displays / 9 cuts / 23 actionIds / 17 invalid bindings / 62 invalid displays.

## Fixes
1. **BUG (1y follow-up):** `hasUiActionPrefix` was case-sensitive, so a kind-`tool` display with `UI.x` / `Window.close` got past `toolDisplay` and `validateEvent` (the 2581593 vendor accepted it too). Now `/^(ui|window)\./i`.
2. **Prototype keys:** `toolDisplay` threw `keys.includes is not a function` for category `toString`; validateEvent accepted a display / payload whose fields were inherited. Now `Object.hasOwn` in toolDisplay's tables, `checkField`'s reads and the display checks, plus `plainOwnDisplay` (prototype Object.prototype or null, recursive) in validateEvent. The toolCatalog is already a `Map`. The port has no guard of ours: E02's `canonicalJson` throws `non-plain object`.

| file | case | result |
|---|---|---|
| `*_proto-red_red_tap.txt` | new tests on a86d6af src + 2581593 vendor | **RED: 260 pass / 3 fail (263)**: UI.x accepted as tool; toString throw; inherited display accepted |
| `*_proto-payload-red_red_tap.txt` | inherited-payload test with the contracts.ts fix reverted (= mutant P8) | **RED: 264 pass / 1 fail (265)** (test written after the fix, so its red is the revert) |
| `*_vendor-hashes_hash_table.txt` | vendored 0146c90 vs pinned values | **77/77 earlier + 2/2 new, 0 differences** |
| `*_proto-mutation_mutation_summary.txt` | P1–P10 (P6 dropped with the port guard) | **6/9 killed**; P4 equivalent; P5 and P9 redundant with each other, **combined P5+P9 killed** |
| `*_proto-final_final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 21589b3 | **GREEN: 265/265**, exit 0 |

**Tests:** `test/protoKeys.test.ts` (8): 1y follow-up any case; prototype-name categories through every builder; validateEvent prototype kind/category/extra key/requestSource; inherited display (validateEvent + port; null-prototype OK); toolCatalog own entries only; Codex approval with prototype-name category → display_unavailable; inherited payload fields; `plainOwnDisplay` unit. Names used: `toString`, `__proto__`, `constructor`, `hasOwnProperty`, `valueOf`. Each gives null / display_unavailable / unknown / a validateEvent rejection; none throws or is valid.

## Notes for E02 (not changed: vendored files are never edited)
- E02's `validateApprovalDisplay` uses `in` for required keys and returns `{ok:true}` for `Object.create(<valid pre_dispatch display>)` (all fields inherited). Its `canonicalJson` refuses it, so hashing fails closed, but the validator alone does not.
- Left as is: `PROGRESS_TEXT[to]`, `ACCOUNT_COPY[cls]`, `TRANSITIONS[from]` are indexed only by typed internal values, never by event input.

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, over the pack's log files.
- 6 hits, all the test **name** "… no API-key fallback" (2 per tap file). No credential, token or key value appears.
