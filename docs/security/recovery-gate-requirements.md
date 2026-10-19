# Recovery-reuse gate requirements (E08, for ADR-0017)

Status: binding input for `packages/policy` (DOT-008). No gate code exists yet; implement exactly this.

## Explicit allowlist, explicit deny
- The recovery-reuse check is a closed allowlist: `restore`, `focus`, `move_to_monitor`. Any other action denies with `DENIED_BY_POLICY`.
- On top of the allowlist, the gate carries an explicit deny entry for `shell_navigate` (and `type_text`, `hotkey`, `key_press`, `close_window`, `clipboard_*`, `launch`, `terminate`, `uia_click`, every file mutation), checked before the allowlist, so a future allowlist edit cannot let it through silently. Tool error code: `DENIED_BY_POLICY`; audit reason: `recovery_action_forbidden` (explicit deny list) or `not_covered` (anything else off the allowlist).
- Casing (E01 final ruling 2026-10-19): ToolError codes are UPPER_SNAKE (`DENIED_BY_POLICY`); audit reason codes and all enum values are lowercase snake_case (`recovery_action_forbidden`, `not_covered`, `denied_by_policy` as a `decision`).

## Recovery token HMAC input
- HMAC-SHA-256 with a K8-only key over UTF-8 canonical JSON (keys sorted, no whitespace; every value a string) of:
  `{"action":<recovery action>,"hwnd":<decimal string>,"nonce":<base64url 128-bit>,"parentActionId":<hex>,"pid":<decimal string>,"processStartTime":<FILETIME as decimal string>,"purpose":"dottie.recoveryToken.v1","taskId":<string>,"windowClass":<string>}`
- **`purpose` key (domain separation, accepted by E01 2026-10-19):** the recovery-token object carries `"purpose":"dottie.recoveryToken.v1"`, and the `actionId` canonical object (ADR-0009 CR2) carries `"purpose":"dottie.actionId.v1"`. Both use the same canonicaliser. A missing or different `purpose` is rejected, so a value computed for one purpose never verifies as the other.
- `processStartTime` is the 64-bit FILETIME (100 ns since 1601-01-01 UTC) as an unsigned decimal string with no leading zeros, matching the window-identity contract. Never a number type (precision loss above 2^53 in JS), never ISO-8601.
- `hwnd` and `pid` are also decimal strings, for the same reason.
- **WindowIdentity type:** `hwnd`, `pid` and `processStartTime` are decimal strings in the CONTRACTS §3.3 `WindowIdentity` type itself, not only in the MAC input (CONTRACTS currently types `hwnd: unknown`, `pid: number`; E01 to align).
- The token value is never logged.

## Required gate tests
- `recovery_shell_navigate_denied_explicitly`: a valid, unexpired token for the same task and window identity, action `shell_navigate`, is denied with `DENIED_BY_POLICY` and audit reason `recovery_action_forbidden`, and stays denied when `shell_navigate` is temporarily added to the allowlist in the test.
- `recovery_hmac_filetime_encoding`: tokens computed with processStartTime as a JSON number, an ISO string, or a zero-padded decimal fail verification. Only the canonical decimal string verifies.
- `recovery_hmac_purpose_bound`: a MAC computed over the same fields with `purpose` `dottie.actionId.v1`, a different string, or no `purpose` key fails verification.
- `recovery_identity_start_time_mismatch_denied`: same hwnd and pid with a different processStartTime is denied.
- Plus the ADR-0017 set: different window, different task, expired, reused, non-covered action, revocations, one redacted audit record per case.
