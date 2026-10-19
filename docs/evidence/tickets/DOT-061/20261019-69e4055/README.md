# DOT-061: E02 FINAL display limits (E01 ruling 1v): evidence for commit 69e4055 (Linux box)

E03, 2026-10-19 (CDT). Linux box only, Node v20.19.2, npm 11.21.0. This is **not** Windows evidence. `build` and `installerSha256` are null. Base: f3672da / 9e76fa1 (220/220).

**Ruling 1v (relayed by the parent):** the key names stay as they were at 3029c7b. `summaryUntrusted` stays and ui_action has no `targetLabel`, so nothing was renamed. These are E02's FINAL limits; they replace the provisional ones from f3672da.

**Cut fields** (`DISPLAY_MAX_LENGTH`): Unicode code points; over the limit the text becomes the first max−1 code points plus U+2026.
- summaryUntrusted 500
- reasonUntrusted 500
- app.windowTitle 256
- method 64 (tool, ui_action)
- targetLabel 256 (tool)
- app.appName 128
- app.processImage 260

**Never-cut bounds** (`DISPLAY_HARD_LIMITS`): over any of them the builder returns null, so the approval is declined `display_unavailable` with no dialog.
- commandLine: 8192 raw UTF-8 bytes
- paths: ≤500 entries, each ≤4096 bytes (codex_file_change and tool)
- workingDirectory: ≤4096 bytes
- escalation: ≤32 entries, each ≤256 code points

`validateEvent` rejects every over-length value; it never repairs one. `displayHash` covers the cut, shown text for cut fields and the raw bytes for never-cut fields.

| file | case | result |
|---|---|---|
| `*_limits-red_tap.txt` | four 1v tests on f3672da src (tsc exits 2; JS still emitted) | **RED: 220 pass / 2 fail / 2 cancelled (224)** |
| `*_limits-mutation_summary.txt` | V1–V25 | **24/25 killed**. V12 survived; it is equivalent (see below) |
| `*_limits-final_tap.txt` | `rm -rf node_modules dist && npm ci && npm test` on 69e4055 | **GREEN: 224/224**, exit 0, 0 vulnerabilities |

**Test coverage:**
- **Cut fields:** max−1, max and max+1 for every field, plus a case with characters outside the Basic Multilingual Plane (so code points, not UTF-16 units). The ui_action method keeps its `ui.` prefix when cut.
- **Never-cut bounds:** limit and limit+1 in the builder. Multi-byte characters prove the limits are counted in bytes.
- **End to end:** cwd, escalation count, escalation entry and path bytes each end in a `display_unavailable` decline with no ApprovalRequested.
- **validateEvent:** each field is accepted at its limit and rejected at limit+1 (16 rows).

**V12 is equivalent, not a coverage gap.** V12 cut escalation entries to 256 instead of declining them. Entries over 256 are already declined before that point, so the cut never changes a value.

**Still waiting:** the vector re-pin and the real `computeActionId` swap, until E02's regenerated commit lands.

**Still provisional (not covered by 1v):**
- `CodexApprovalRequest.display` param field names
- the `ui.*` / `window.*` UI-action method prefix
- extra per-category keys on `tool`

## Secret sweep
- Pattern: `api[_-]?key|secret|password|bearer|sk-…|ghp_…|PRIVATE KEY`, run over this pack.
- Hits: 4 API-key fallback, all the test **name** "… no API-key fallback".
- No credential, token or key value appears.
