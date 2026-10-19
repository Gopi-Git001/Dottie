# CONTRACTS source

`packages/contracts` mirrors **dottie-e01 `arch/CONTRACTS.md` @ `e41d1ca` + rulings 1v (`c19b751`), 1w (`f4784ee`), 1x (`474c502`), 1z (`492c01c`), 2a (`972d5f4`) and 2b (`97e7bc0`)** (E01 rulings
through 1u: `fcded34` + `e41d1ca` wording; supersedes the earlier pins `dd082ec`, `819b30d` and `1f3ac60`), including
ADR-0009 as amended there. Ruling 1w (`f4784ee`): `sourceChannel` adds `renderer_ipc` (`RENDERER_IPC_CHANNEL`);
its join rule is coordinator/desktop behaviour, not a contracts change, and no vector hash moved.

Ruling 1x (`474c502`): Codex `writeStdin` command approvals have NO display kind. The adapter declines every one with
`display_unavailable` (permanent, not a switch), and it is never rendered as `codex_command`, never asks the coordinator
and never opens a dialog. Its JSON-RPC requestId gets exactly one response. 1x also confirms the tool per-category keys
(`TOOL_FIELD_KEYS`) as committed in `895676d`. No contracts code or vector changes.

Ruling 1z (`492c01c`): `isUiActionMethod` is exactly `^(ui|window)\.[a-z][a-z0-9_]*$` (`UI_ACTION_METHOD_RE`; it
replaces the E03 `3029c7b` prefix test). `displaysInvalid` gains the negatives `ui.`, `window.`, `ui.Click`, `ui.1x`,
`uix.click` and `ui.click.extra`. A single-file delete/overwrite still carries `paths` (one entry) and `fileCount: "1"`.
No display or actionId hash changed (57 of 57 identical). No Python mirror is needed because the Python checkers
recompute hashes and do not validate display shapes.

Ruling 1v (display key names): the `ApprovalDisplay` wire keys are E03 `3029c7b` `DISPLAY_KEYS`, verbatim, in the one
key table `DISPLAY_KEYS` (src/display.ts): pre_dispatch `summaryUntrusted` (the §2.1 preimage arg stays `summary`);
`ui_action` = `{kind, category, method, app{appName, windowTitle, processImage}}`, no `targetLabel` (tool kind only);
codex_command `{commandLine, workingDirectory, networkAccess, escalation, reasonUntrusted}`; codex_file_change
`{paths, fileCount, reasonUntrusted}`. Value conventions: strings only (flags `requested|not_requested`, counts as
decimal strings), `escalation: []` when none, `fileCount = String(paths.length)` (a move lists both paths).
Display limits (`DISPLAY_MAX` cut / `DISPLAY_HARD_LIMITS` never cut) are the cross-team values E03 implements in
`f3672da`/`69e4055`; the cut rule is cross-checked byte for byte by `fixtures/action-id/vectors.json` `displayCuts`.

Ruling 2a (`972d5f4`): the 1l coverage rule (dialog categories only) applies to kind `tool` only. `ui_action` stays
`local_change` or stricter. `pre_dispatch`, `codex_command` and `codex_file_change` are complete by kind for every
category including `read` and `navigate` (`KIND_COMPLETE_CATEGORIES`, `displayCategories(kind)`), which restores D14
C-25. `credential_access` still has no display rule for any kind (ruling 1l: always DENIED_BY_POLICY, no request).
This is the conservative reading of "every category". `displayHashGuard` takes an optional `kind` (default `tool`,
old behaviour). The two invalid event fixtures `approval-requested-{read,navigate}-no-display-rule.json` are now
tool-kind, a valid `approval-requested-pre-dispatch-read.json` is added, and ruling 1g (no `possibleRepeat` with
read/navigate) is unchanged. Vectors: 4 new displays (pre_dispatch read/navigate, codex_command read,
codex_file_change navigate) and 4 new invalid ones (tool read, ui_action read, pre_dispatch/codex_command
credential_access); `read has no display rule` (pre_dispatch read) is removed. No existing hash changed (57 of 57).
2a also moves DOT-090 item 10 (tool-catalog hash pin) to E04.
2a additions (agreed with E03): the former invalid vector `read has no display rule` (a pre_dispatch read) is a
valid display vector. `method` moves from `DISPLAY_MAX` (cut) to `DISPLAY_HARD_LIMITS` (never cut,
`{ maxCodePoints: 64 }`, `METHOD_MAX`), because a cut method (`ui.mmm…`) would break the 1z regex. Over 64 code
points → `display_unavailable` in the builders (`uiActionDisplay` → null), and `validateEvent` rejects it. Vectors
at 64 (accepted) and 65 (rejected) cover ui_action and tool. No method-cut vector existed, so nothing was moved to
`superseded.json`, and no existing hash changed (70 of 70).

Ruling 2b (`97e7bc0`): (1) `credential_access` stays rejected for every kind (1l overrides 2a's "every category"),
as already implemented in `ffc68da`. (2) The codex-adapter bridge passes the classifier/coordinator category through
unchanged; the raise of read/navigate to `local_change` is gone. A Codex approval always opens exactly one dialog or
is declined, and is never skipped as low risk. (3) `validateEvent` requires `display.category === payload.category`
for every kind. The rule was already unconditional; 2b adds negative event fixtures for ui_action, codex_command and
codex_file_change (tool and pre_dispatch already had them) and a test in both directions per kind. 2b also confirms
"method never cut" (`cc22afb`). No vector or hash changed.

Ruling 1y follow-up (E01, confirmed after 97e7bc0): the `ui.` / `window.` namespace belongs to kind `ui_action` only.
A kind-`tool` display rejects any method matching `/^(ui|window)\./i` (`UI_ACTION_PREFIX_RE`, `hasUiActionPrefix`),
including `ui.Click`, `window.`, `UI.x`, `Window.close` and the valid `ui.click`. It replaces the earlier tool check
(reject only exact 1z methods). Valid UI methods go only through ui_action with the 1z regex. Enforced in
`validateApprovalDisplay` / `validateEvent` and in the new `toolDisplay` builder (mirrors E03 `toolDisplay`;
null = display_unavailable). Vectors: 5 negatives (those five methods) and 2 positives (`uix.click`, `file.read`).
No existing hash changed (73 of 73). E03's `hasUiActionPrefix` is case-sensitive and should take the `i` flag.

Plain-object hardening (E03 report, 2026-10-19): the validators used `in` for required keys, so a display whose fields
were all inherited (`Object.create({kind, ...})`) validated while `canonicalJson` refused it. Now
`validateApprovalDisplay` (nested `app` included), `validateEvent` and `computeActionId` take only plain data
objects (`isPlainObject`: prototype `Object.prototype` or null, no symbol keys, own enumerable data properties only,
so no getters) and plain dense arrays (`isPlainArray`). Every required/allowed key check uses `hasOwn`. A JSON-parsed
`"__proto__"` key is an unknown own key and is rejected. A key named like an `Object.prototype` member (`constructor`,
`toString`) is no longer treated as a known event field. A polluted `Object.prototype` / `Array.prototype` never
supplies a missing field or array entry. Null-prototype objects are accepted and hash the same. No hash changed (75
of 75); two `displaysInvalid` error strings changed.

E01 ruling 2i (closed internal events; given 2026-10-19 11:23 CDT, not yet committed in dottie-e01, so no pin SHA:
the pin stays at the last E01 commit mirrored). Internal Dottie events are closed. The envelope and every payload
object reject unknown keys (prototype names included) without throwing. `test/closed-events.test.ts` is table-driven
over every event type's valid fixtures: it injects an ordinary unknown key and every `Object.prototype` member name
(as own keys) into every object node and expects exactly that path rejected. The three open-by-contract maps
(ObservedState's tool-specific scalar keys, `observedState.checks`, `redactedMetadata`; §5/§3.2) stay open for
ordinary keys. Prototype member names (`RESERVED_KEY_NAMES`) are now rejected there too ("reserved prototype member
name"). No hash changed.

When E01 lands a new ruling, update the mirror and this pin in the same commit. Where CONTRACTS leaves
something open, the conservative reading is implemented and noted at the code site (search for
`ruling` / `TODO(DOT-095)` / `TODO(E03 port`).
