/**
 * CONTRACTS §3.2 `dottie.audit` v1 record and `Redacted<T>`, and §3.3 `WindowIdentity` / `RecoveryToken`
 * (E01 2026-10-19 addition 3). Shape and validators only: the K8 key, MAC computation and verification stay with E08's
 * policy (ADR-0017), and `redact()` / `isRedacted()` stay with the shared redactor.
 *
 * The JSON Schema files in `schemas/` are generated from the consts below (scripts/json-schemas.mjs) so Python consumers
 * (E04, E11) validate against the same source. JSON Schema can't express every rule; each rule only these validators
 * enforce is listed in the schema's `$comment` and pinned by the differential fixtures in fixtures/records.
 */
import { APPROVAL_CATEGORIES, RISK_SEVERITIES, type ApprovalCategory, type Risk } from './enums.js';

// ---------------------------------------------------------------- Redacted<T> (§3.2, E08 P-e)

declare const redactedBrand: unique symbol; // not exported: only the redactor's cast can produce the brand
/** Output type of the shared redactor's `redact()`, the only constructor. Loggers and audit writers accept only this. */
export type Redacted<T> = T & { readonly [redactedBrand]: true };
export type RedactedJson = string | number | boolean | null | readonly RedactedJson[] | { readonly [k: string]: RedactedJson };
/** What an audit writer accepts (it must also call the redactor's `isRedacted()` at runtime; types are erased). */
export type RedactedAuditRecord = Redacted<AuditRecord>;

// ---------------------------------------------------------------- shared shapes

export interface RecordIssue {
  readonly path: string;
  readonly message: string;
}
export type RecordResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly RecordIssue[] };

/** Compile-time equality: the key tuples below must name exactly the interface's keys (the TS/JSON Schema sync, part 1). */
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export const SHA256_HEX_PATTERN = '^[0-9a-f]{64}$';
/** 128-bit value, base64url without padding: 22 chars, the last carrying 2 data bits. */
export const BASE64URL_128_PATTERN = '^[A-Za-z0-9_-]{21}[AQgw]$';
/** 256-bit value (HMAC-SHA-256), base64url without padding: 43 chars, the last carrying 4 data bits. */
export const BASE64URL_256_PATTERN = '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$';
/** Unsigned decimal string, no leading zeros, "0" invalid (§3.3). */
export const POSITIVE_DECIMAL_PATTERN = '^[1-9][0-9]*$';
export const ISO_OFFSET_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$';
/** Audit `reason` and enum values: lowercase snake_case (§3.2 casing rule). */
export const SNAKE_CASE_PATTERN = '^[a-z][a-z0-9]*(_[a-z0-9]+)*$';
/** §5 tool ids: `area.verb_object`. */
export const TOOL_ID_PATTERN = '^[a-z][a-z0-9]*(_[a-z0-9]+)*\\.[a-z][a-z0-9]*(_[a-z0-9]+)*$';
/** Redactor value pattern for K8 token values (§3.2): a record containing one is invalid. */
export const K8_TOKEN_PATTERN = '\\bk8[tr]1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b';

const re = (p: string) => new RegExp(p);
const SHA = re(SHA256_HEX_PATTERN);
const ISO = re(ISO_OFFSET_PATTERN);
const SNAKE = re(SNAKE_CASE_PATTERN);
const TOOL_ID = re(TOOL_ID_PATTERN);
const K8 = re(K8_TOKEN_PATTERN);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}
function keysOnly(v: Record<string, unknown>, allowed: readonly string[], path: string, out: RecordIssue[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) out.push({ path: `${path}${k}`, message: 'is not a field of this record' });
}
function done<T>(v: unknown, out: RecordIssue[]): RecordResult<T> {
  return out.length === 0 ? { ok: true, value: v as T } : { ok: false, issues: out };
}

// ---------------------------------------------------------------- WindowIdentity (§3.3)

export interface WindowIdentity {
  /** Unsigned decimal string, no leading zeros, "0" invalid. HWND is pointer-sized: at most 2^64-1. */
  readonly hwnd: string;
  /** Unsigned decimal string, no leading zeros, "0" invalid. A DWORD: at most 2^32-1. */
  readonly pid: string;
  /** Plain class name, 1-256 UTF-16 code units, no lone surrogate. */
  readonly windowClass: string;
  /** FILETIME of process creation (100-ns ticks since 1601-01-01 UTC) as a decimal string; at most 2^63-1. */
  readonly processStartTime: string;
}
export const WINDOW_IDENTITY_KEYS = ['hwnd', 'pid', 'windowClass', 'processStartTime'] as const;
export type _WindowIdentityKeysInSync = Assert<Equal<keyof WindowIdentity, (typeof WINDOW_IDENTITY_KEYS)[number]>>;
/** Upper bounds (inclusive) for the decimal fields; CONTRACTS gives none, so these are the Windows type ranges. */
export const WINDOW_IDENTITY_MAX = { hwnd: 18446744073709551615n, pid: 4294967295n, processStartTime: 9223372036854775807n } as const;
export const WINDOW_CLASS_MAX_UTF16 = 256;

function checkWindowIdentity(v: unknown, path: string, out: RecordIssue[]): void {
  if (!isObj(v)) {
    out.push({ path: path || '(root)', message: 'must be an object' });
    return;
  }
  const p = path ? `${path}.` : '';
  keysOnly(v, WINDOW_IDENTITY_KEYS, p, out);
  for (const k of ['hwnd', 'pid', 'processStartTime'] as const) {
    const x = v[k];
    if (typeof x !== 'string' || !re(POSITIVE_DECIMAL_PATTERN).test(x)) {
      out.push({ path: `${p}${k}`, message: 'must be an unsigned decimal string with no leading zeros, not "0" (§3.3)' });
    } else if (BigInt(x) > WINDOW_IDENTITY_MAX[k]) {
      out.push({ path: `${p}${k}`, message: `must be at most ${WINDOW_IDENTITY_MAX[k]}` });
    }
  }
  const c = v['windowClass'];
  if (typeof c !== 'string' || c.length < 1 || c.length > WINDOW_CLASS_MAX_UTF16) {
    out.push({ path: `${p}windowClass`, message: `must be a string of 1-${WINDOW_CLASS_MAX_UTF16} UTF-16 code units (§5)` });
  } else if (hasLoneSurrogate(c)) {
    out.push({ path: `${p}windowClass`, message: 'must not contain a lone surrogate (§5: no identity)' });
  }
}
/** A failed check means the window has no identity: NOT_FOUND at lookup, no recovery (§3.3/§5). */
export function validateWindowIdentity(v: unknown): RecordResult<WindowIdentity> {
  const out: RecordIssue[] = [];
  checkWindowIdentity(v, '', out);
  return done(v, out);
}

// ---------------------------------------------------------------- RecoveryToken (§3.3, ADR-0017)

export const RECOVERY_ACTIONS = ['restore', 'focus', 'move_to_monitor'] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];
export const RECOVERY_TOKEN_PURPOSE = 'dottie.recoveryToken.v1' as const;
/** Wire prefix (§3.3): `k8r1.`; approval tokens use `k8t1.` and each gate rejects the other's. */
export const RECOVERY_TOKEN_WIRE_PREFIX = 'k8r1.' as const;

/** Minted and checked by K8, main process only. `mac` is never logged. */
export interface RecoveryToken {
  readonly actionId: string;
  readonly parentActionId: string;
  readonly recoveryAction: RecoveryAction;
  readonly taskId: string;
  readonly windowIdentity: WindowIdentity;
  /** 128-bit random, base64url. */
  readonly nonce: string;
  /** HMAC-SHA-256(k8Key, canonical MAC input), base64url (the encoding §3.3 gives for the approval token's mac). */
  readonly mac: string;
}
export const RECOVERY_TOKEN_KEYS = ['actionId', 'parentActionId', 'recoveryAction', 'taskId', 'windowIdentity', 'nonce', 'mac'] as const;
export type _RecoveryTokenKeysInSync = Assert<Equal<keyof RecoveryToken, (typeof RECOVERY_TOKEN_KEYS)[number]>>;

/** Shape check only; it does not verify the MAC (E08's K8 does, in constant time). */
export function validateRecoveryToken(v: unknown): RecordResult<RecoveryToken> {
  const out: RecordIssue[] = [];
  if (!isObj(v)) return { ok: false, issues: [{ path: '(root)', message: 'must be an object' }] };
  keysOnly(v, RECOVERY_TOKEN_KEYS, '', out);
  for (const k of ['actionId', 'parentActionId'] as const) {
    if (typeof v[k] !== 'string' || !SHA.test(v[k])) out.push({ path: k, message: 'must be a lowercase-hex SHA-256' });
  }
  if (v['actionId'] !== undefined && v['actionId'] === v['parentActionId']) out.push({ path: 'actionId', message: 'a recovery attempt has a new id, never the parent approval\'s' });
  if (typeof v['recoveryAction'] !== 'string' || !(RECOVERY_ACTIONS as readonly string[]).includes(v['recoveryAction'])) {
    out.push({ path: 'recoveryAction', message: `must be one of ${RECOVERY_ACTIONS.join('|')}` });
  }
  if (typeof v['taskId'] !== 'string' || v['taskId'].length === 0) out.push({ path: 'taskId', message: 'must be a non-empty string' });
  checkWindowIdentity(v['windowIdentity'], 'windowIdentity', out);
  if (typeof v['nonce'] !== 'string' || !re(BASE64URL_128_PATTERN).test(v['nonce'])) out.push({ path: 'nonce', message: 'must be 128 bits, base64url without padding' });
  if (typeof v['mac'] !== 'string' || !re(BASE64URL_256_PATTERN).test(v['mac'])) out.push({ path: 'mac', message: 'must be 256 bits, base64url without padding' });
  return done(v, out);
}

// ---------------------------------------------------------------- AuditRecord (§3.2)

export const AUDIT_SCHEMA = 'dottie.audit' as const;
export const AUDIT_VERSION = 1 as const;
export const AUDIT_KINDS = [
  'approval.requested', 'approval.resolved', 'approval.expired', 'approval.revoked', 'policy.denied',
  'auth.url_check', 'auth.login_started', 'auth.login_completed', 'auth.logout',
  'env.scrub', 'server_request.unknown', 'tool.denied_path', 'redactor.fallback',
  'recovery_token.minted', 'recovery_token.used', 'recovery_token.rejected',
  'tool_token.minted', 'tool_token.consumed', 'tool_token.rejected', 'tool_token.revoked',
  'toolhost.peer_rejected', 'toolhost.pipe_squatted', 'tool_call.host_refused',
  'input.field_stripped',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const AUDIT_DECISIONS = ['approved', 'declined', 'cancelled', 'denied_by_policy', 'expired', 'revoked'] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];
export const AUDIT_WIRE_REPLIES = ['accept', 'decline', 'cancel', 'error_32601', 'none'] as const;
export type AuditWireReply = (typeof AUDIT_WIRE_REPLIES)[number];
export const AUDIT_CHANNELS = ['secure_ui', 'tray', 'voice'] as const;
/** input.field_stripped only (ruling 1i): the channel the stripped field arrived on. */
/** Origin-check channel ids (ruling 1o): the main process accepts UtteranceReady.retryOfTaskId only from these; the same strings as sourceChannel. */
export const VOICE_WORKER_CHANNEL = 'voice_worker';
export const TRAY_IPC_CHANNEL = 'tray_ipc';
/** Ruling 1w: any renderer-process IPC. The renderer is untrusted: never an allowed retryOfTaskId origin, only a sourceChannel. */
export const RENDERER_IPC_CHANNEL = 'renderer_ipc';
export const AUDIT_SOURCE_CHANNELS = [VOICE_WORKER_CHANNEL, TRAY_IPC_CHANNEL, RENDERER_IPC_CHANNEL, 'model', 'codex', 'tool_host'] as const;
export type AuditSourceChannel = (typeof AUDIT_SOURCE_CHANNELS)[number];
/** input.field_stripped only (ruling 1h): the stripped field's name, never its value. */
export const STRIPPED_FIELDS = ['retryOfTaskId', 'possibleRepeat'] as const;
export type StrippedField = (typeof STRIPPED_FIELDS)[number];
/** Base record fields (always allowed when valid). */
/** Kinds that may carry displayHash / joinedTo (ruling 1k). */
export const APPROVAL_RECORD_KINDS = AUDIT_KINDS.filter((k) => k.startsWith('approval.'));
export const AUDIT_BASE_KEYS = ['schema', 'version', 'eventId', 'correlationId', 'causationId', 'timestamp', 'kind'] as const;
/** input.field_stripped carries nothing beyond the base fields and these (ruling 1i). */
export const FIELD_STRIPPED_KEYS = [...AUDIT_BASE_KEYS, 'decision', 'field', 'sourceChannel', 'reason', 'taskId'] as const;
/** policy.denied{schema_invalid} carries only taskId, toolId, reason and timestamps (ruling 1e, E08); plus actionId:null and
 *  the constant decision/outcome of every policy.denied record. */
export const SCHEMA_INVALID_DENIAL_KEYS = [...AUDIT_BASE_KEYS, 'taskId', 'toolId', 'actionId', 'reason', 'decision', 'outcome', 'requestedAt', 'expiresAt', 'resolvedAt'] as const;
/** The fixed decision per tool-host kind (ruling 3b); tool_token.minted follows its outcome (refinement). */
export const TOOL_HOST_DECISIONS: Readonly<Partial<Record<AuditKind, AuditDecision>>> = {
  'tool_token.consumed': 'approved',
  'tool_token.rejected': 'denied_by_policy',
  'tool_token.revoked': 'revoked',
  'toolhost.peer_rejected': 'denied_by_policy',
  'toolhost.pipe_squatted': 'denied_by_policy',
  'tool_call.host_refused': 'denied_by_policy',
  'input.field_stripped': 'denied_by_policy',
  'policy.denied': 'denied_by_policy',
};
/** recovery_token.* records carry these (P-c). */
export const RECOVERY_RECORD_REQUIRED = ['actionId', 'parentActionId', 'recoveryAction', 'taskId', 'decision', 'targetHash'] as const;
export type AuditChannel = (typeof AUDIT_CHANNELS)[number];
export const ENV_CANARY_STATES = ['absent', 'present', 'not_run'] as const;
/** tool_token.revoked reasons (12, §3.2; `locked`, not `lock`). */
export const TOOL_TOKEN_REVOKE_REASONS = [
  'superseded', 'turn_end', 'end_task', 'task_cancel', 'stop', 'panic_stop', 'mute', 'locked', 'app_server_restart', 'ipc_disconnect', 'main_restart', 'quit',
] as const;
/** tool_call.host_refused (P26): validated host reasons, or `host_reported_other` (no text stored). */
export const HOST_REFUSED_REASONS = ['known_folder_redirected', 'locked', 'schema_invalid', 'catalog_mismatch', 'precondition_failed', 'host_reported_other'] as const;
/** §3.2 outcome per kind; `null` = the kind carries no outcome. */
export const AUDIT_OUTCOMES: Readonly<Record<AuditKind, readonly string[] | null>> = {
  'approval.requested': ['displayed', 'not_displayed'],
  'approval.resolved': ['reply_sent', 'reply_failed', 'already_executed'],
  'approval.expired': ['reply_sent', 'reply_failed', 'already_executed'],
  'approval.revoked': ['reply_sent', 'reply_failed', 'already_executed'],
  'policy.denied': ['denied'],
  'auth.url_check': ['opened', 'rejected'],
  'auth.login_started': ['started', 'unavailable', 'already_in_progress'],
  'auth.login_completed': ['success', 'failure', 'cancelled', 'timeout'],
  'auth.logout': ['signed_out', 'failed'],
  'env.scrub': ['ok', 'canary_detected'],
  'server_request.unknown': ['rejected'],
  'tool.denied_path': ['denied'],
  'redactor.fallback': ['written'],
  'recovery_token.minted': ['minted', 'refused'],
  'recovery_token.used': ['executed', 'postcondition_failed', 'postcondition_unknown'],
  'recovery_token.rejected': ['denied'],
  'tool_token.minted': ['minted', 'refused'],
  'tool_token.consumed': ['consumed', 'consumed_not_dispatched', 'postcondition_unknown'],
  'tool_token.rejected': ['denied'],
  'tool_token.revoked': null,
  'toolhost.peer_rejected': ['denied'],
  'toolhost.pipe_squatted': ['refused_start'],
  'tool_call.host_refused': null,
  'input.field_stripped': null,
};
/** Kinds that must omit actionId/taskId/toolId entirely (even null) (§3.2 per-kind ids). */
export const AUDIT_KINDS_WITHOUT_IDS: readonly AuditKind[] = ['toolhost.peer_rejected', 'toolhost.pipe_squatted'];
/** input.field_stripped omits actionId and toolId (taskId when known) and channel (ruling 1h/1i). */
export const FIELD_STRIPPED_OMITS = ['actionId', 'toolId', 'channel'] as const;
/** Kinds that must carry all three ids (K-10, K-11). Other kinds: OPEN in CONTRACTS, not enforced. */
export const AUDIT_KINDS_WITH_IDS: readonly AuditKind[] = ['tool_token.minted', 'tool_token.consumed', 'tool_token.rejected', 'tool_token.revoked', 'tool_call.host_refused'];
export const RECOVERY_KINDS: readonly AuditKind[] = ['recovery_token.minted', 'recovery_token.used', 'recovery_token.rejected'];
/** Removed env names counted as sensitive (§3.2 P-d), matched case-insensitively. */
export const ENV_SENSITIVE_NAME_PATTERN = '^(OPENAI_|AZURE_OPENAI_|CODEX_).*$|^.*_(KEY|TOKEN|SECRET|PASSWORD)$';
export const AUDIT_RECORD_MAX_BYTES = 16384;
/** The fail-closed record (§3.2): `error` is a class name only. */
export const ERROR_CLASS_PATTERN = '^[A-Za-z_$][A-Za-z0-9_$]{0,63}$';

export interface AuditEnvScrub {
  readonly keptNames: readonly string[];
  readonly removedSensitiveNames: readonly string[];
  readonly removedOtherCount: number;
  readonly keptCount: number;
  readonly removedCount: number;
  readonly canary: (typeof ENV_CANARY_STATES)[number];
}
export const AUDIT_ENV_KEYS = ['keptNames', 'removedSensitiveNames', 'removedOtherCount', 'keptCount', 'removedCount', 'canary'] as const;
export type _AuditEnvKeysInSync = Assert<Equal<keyof AuditEnvScrub, (typeof AUDIT_ENV_KEYS)[number]>>;

export interface AuditRecord {
  readonly schema: typeof AUDIT_SCHEMA;
  readonly version: typeof AUDIT_VERSION;
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly taskId?: string;
  readonly timestamp: string;
  readonly kind: AuditKind;
  /** null only on policy.denied{reason:'schema_invalid'} (ruling 1e: no validated args to hash). */
  readonly actionId?: string | null;
  readonly toolId?: string;
  readonly field?: StrippedField;
  readonly source?: 'host';
  readonly parentActionId?: string;
  readonly recoveryAction?: RecoveryAction | string;
  readonly targetHash?: string;
  readonly argsHash?: string;
  /** approval.* only: SHA-256 of the canonical ApprovalDisplay; the display itself is never logged (ruling 1k). */
  readonly displayHash?: string;
  /** Joined approval.* records only: eventId of the first record for the same actionId (ruling 1k). */
  readonly joinedTo?: string;
  readonly category?: ApprovalCategory;
  readonly risk?: Risk;
  readonly decision?: AuditDecision;
  readonly wireReply?: AuditWireReply;
  readonly requestedAt?: string;
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
  readonly channel?: AuditChannel;
  readonly sourceChannel?: AuditSourceChannel;
  readonly reason?: string;
  readonly outcome?: string;
  readonly env?: AuditEnvScrub;
}
export const AUDIT_RECORD_KEYS = [
  'schema', 'version', 'eventId', 'correlationId', 'causationId', 'taskId', 'timestamp', 'kind', 'actionId', 'toolId', 'field', 'source',
  'parentActionId', 'recoveryAction', 'targetHash', 'argsHash', 'displayHash', 'joinedTo', 'category', 'risk', 'decision', 'wireReply', 'requestedAt',
  'expiresAt', 'resolvedAt', 'channel', 'sourceChannel', 'reason', 'outcome', 'env',
] as const;
export type _AuditRecordKeysInSync = Assert<Equal<keyof AuditRecord, (typeof AUDIT_RECORD_KEYS)[number]>>;
export const AUDIT_RECORD_REQUIRED = ['schema', 'version', 'eventId', 'correlationId', 'timestamp', 'kind'] as const;

/** The only record written when redact() throws (§3.2): exactly these three keys. */
export interface AuditFallbackRecord {
  readonly kind: 'redactor.fallback';
  readonly eventId: string;
  readonly error: string;
}
export const AUDIT_FALLBACK_KEYS = ['kind', 'eventId', 'error'] as const;
export type _AuditFallbackKeysInSync = Assert<Equal<keyof AuditFallbackRecord, (typeof AUDIT_FALLBACK_KEYS)[number]>>;

function scanStrings(v: unknown, path: string, out: RecordIssue[]): void {
  if (typeof v === 'string') {
    if (K8.test(v)) out.push({ path, message: 'contains a K8 token value (§3.2: never in a record)' });
  } else if (Array.isArray(v)) v.forEach((x, i) => scanStrings(x, `${path}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) scanStrings(x, path ? `${path}.${k}` : k, out);
}

function sortedUnique(a: readonly string[]): boolean {
  for (let i = 1; i < a.length; i++) if (!(a[i - 1]! < a[i]!)) return false;
  return true;
}

function checkEnv(v: unknown, out: RecordIssue[]): void {
  if (!isObj(v)) {
    out.push({ path: 'env', message: 'must be an object' });
    return;
  }
  keysOnly(v, AUDIT_ENV_KEYS, 'env.', out);
  const sensitive = new RegExp(ENV_SENSITIVE_NAME_PATTERN, 'i');
  for (const k of ['keptNames', 'removedSensitiveNames'] as const) {
    const a = v[k];
    if (!Array.isArray(a) || !a.every((x) => typeof x === 'string' && x.length > 0)) {
      out.push({ path: `env.${k}`, message: 'must be an array of names' });
      continue;
    }
    if (!sortedUnique(a as string[])) out.push({ path: `env.${k}`, message: 'must be sorted and without duplicates' });
    if (k === 'removedSensitiveNames') {
      a.forEach((x: string, i: number) => {
        if (!sensitive.test(x)) out.push({ path: `env.${k}[${i}]`, message: 'only sensitive-pattern names are listed; others are only counted (P-d)' });
      });
    }
  }
  for (const k of ['removedOtherCount', 'keptCount', 'removedCount'] as const) {
    if (!Number.isSafeInteger(v[k]) || (v[k] as number) < 0) out.push({ path: `env.${k}`, message: 'must be a non-negative integer' });
  }
  if (!(ENV_CANARY_STATES as readonly unknown[]).includes(v['canary'])) out.push({ path: 'env.canary', message: `must be one of ${ENV_CANARY_STATES.join('|')}` });
  if (out.length === 0) {
    const kept = (v['keptNames'] as string[]).length;
    const sens = (v['removedSensitiveNames'] as string[]).length;
    if (v['keptCount'] !== kept) out.push({ path: 'env.keptCount', message: 'must equal keptNames.length' });
    if (v['removedCount'] !== sens + (v['removedOtherCount'] as number)) out.push({ path: 'env.removedCount', message: 'must equal removedSensitiveNames.length + removedOtherCount' });
  }
}

/** Validate an untrusted audit record (either the full v1 record or the fail-closed fallback record). Never coerces. */
export function validateAuditRecord(v: unknown): RecordResult<AuditRecord | AuditFallbackRecord> {
  const out: RecordIssue[] = [];
  if (!isObj(v)) return { ok: false, issues: [{ path: '(root)', message: 'must be an object' }] };
  const bytes = new TextEncoder().encode(JSON.stringify(v)).length;
  if (bytes > AUDIT_RECORD_MAX_BYTES) out.push({ path: '(root)', message: `at most ${AUDIT_RECORD_MAX_BYTES} bytes per record (§3.2)` });
  scanStrings(v, '', out);
  const kind = v['kind'];
  if (typeof kind !== 'string' || !(AUDIT_KINDS as readonly string[]).includes(kind)) {
    out.push({ path: 'kind', message: 'must be a §3.2 audit kind' });
    return done(v, out);
  }
  const k = kind as AuditKind;
  const str = (f: string, test: (s: string) => boolean, msg: string, required = false) => {
    const x = v[f];
    if (x === undefined) {
      if (required) out.push({ path: f, message: 'is required' });
      return;
    }
    if (typeof x !== 'string' || !test(x)) out.push({ path: f, message: msg });
  };
  const nonEmpty = (s: string) => s.length > 0;
  const iso = (s: string) => ISO.test(s) && !Number.isNaN(Date.parse(s));
  const oneOf = (vals: readonly string[]) => (s: string) => vals.includes(s);
  const sha = (s: string) => SHA.test(s);

  if (k === 'redactor.fallback') {
    keysOnly(v, AUDIT_FALLBACK_KEYS, '', out);
    str('eventId', nonEmpty, 'must be a non-empty string', true);
    str('error', (s) => re(ERROR_CLASS_PATTERN).test(s), 'must be an error class name only (§3.2)', true);
    return done(v, out);
  }

  keysOnly(v, AUDIT_RECORD_KEYS, '', out);
  if (v['schema'] !== AUDIT_SCHEMA) out.push({ path: 'schema', message: `must be ${AUDIT_SCHEMA}` });
  if (v['version'] !== AUDIT_VERSION) out.push({ path: 'version', message: `unsupported version ${String(v['version'])}; only ${AUDIT_VERSION} is accepted` });
  str('eventId', nonEmpty, 'must be a non-empty string', true);
  str('correlationId', nonEmpty, 'must be a non-empty string', true);
  str('causationId', nonEmpty, 'must be a non-empty string');
  str('timestamp', iso, 'must be an ISO-8601 timestamp with an offset', true);
  for (const f of ['requestedAt', 'expiresAt', 'resolvedAt']) str(f, iso, 'must be an ISO-8601 timestamp with an offset');
  const schemaInvalidDenial = k === 'policy.denied' && v['reason'] === 'schema_invalid';
  if (v['actionId'] === null) {
    if (!schemaInvalidDenial) out.push({ path: 'actionId', message: "null only on policy.denied with reason 'schema_invalid' (DOT-092 ruling 1e)" });
  } else str('actionId', sha, 'must be a lowercase-hex SHA-256');
  for (const f of ['parentActionId', 'targetHash', 'argsHash', 'displayHash']) str(f, sha, 'must be a lowercase-hex SHA-256');
  str('joinedTo', nonEmpty, 'must be a non-empty eventId');
  // Ruling 1k: displayHash and joinedTo are approval-record fields only.
  if (!(APPROVAL_RECORD_KINDS as readonly string[]).includes(k)) {
    for (const f of ['displayHash', 'joinedTo']) if (v[f] !== undefined) out.push({ path: f, message: 'only approval.* records carry it (ruling 1k)' });
  }
  if (v['joinedTo'] !== undefined && v['joinedTo'] === v['eventId']) out.push({ path: 'joinedTo', message: 'names the first record for this actionId, never itself' });
  str('taskId', nonEmpty, 'must be a non-empty string');
  str('toolId', (s) => TOOL_ID.test(s), 'must be a §5 tool id area.verb_object');
  str('category', oneOf(APPROVAL_CATEGORIES), 'must be a §3 approval category');
  str('risk', oneOf(RISK_SEVERITIES), 'must be a §3 risk severity');
  str('decision', oneOf(AUDIT_DECISIONS), `must be one of ${AUDIT_DECISIONS.join('|')}`);
  str('wireReply', oneOf(AUDIT_WIRE_REPLIES), `must be one of ${AUDIT_WIRE_REPLIES.join('|')}`);
  str('channel', oneOf(AUDIT_CHANNELS), `must be one of ${AUDIT_CHANNELS.join('|')}`);
  str('reason', (s) => SNAKE.test(s), 'must be lowercase snake_case (§3.2)');

  // Per-kind ids (§3.2, E08 R4 / K-10 / K-11).
  const ids = ['actionId', 'taskId', 'toolId'] as const;
  if (AUDIT_KINDS_WITHOUT_IDS.includes(k)) {
    for (const f of ids) if (f in v) out.push({ path: f, message: `${k} omits actionId/taskId/toolId entirely, even as null` });
  }
  if (AUDIT_KINDS_WITH_IDS.includes(k)) {
    for (const f of ids) if (v[f] === undefined) out.push({ path: f, message: `is required for ${k}` });
  }
  if (v['argsHash'] !== undefined && v['actionId'] !== undefined && v['argsHash'] !== v['actionId']) {
    out.push({ path: 'argsHash', message: 'argsHash is the canonical-action SHA-256, the same hash as actionId (§3.2)' });
  }

  // outcome per kind.
  const outcomes = AUDIT_OUTCOMES[k];
  if (v['outcome'] !== undefined) {
    if (outcomes === null) out.push({ path: 'outcome', message: `${k} carries no outcome` });
    else if (typeof v['outcome'] !== 'string' || !outcomes.includes(v['outcome'])) out.push({ path: 'outcome', message: `for ${k} must be one of ${outcomes.join('|')}` });
  }

  // Kind-scoped fields.
  if (k === 'tool_call.host_refused') {
    if (v['source'] !== 'host') out.push({ path: 'source', message: "tool_call.host_refused requires source:'host' (P26)" });
    str('reason', oneOf(HOST_REFUSED_REASONS), `for tool_call.host_refused must be one of ${HOST_REFUSED_REASONS.join('|')}`, true);
  } else if (v['source'] !== undefined) out.push({ path: 'source', message: 'only tool_call.host_refused carries source' });

  if (k === 'tool_token.revoked') {
    if (v['decision'] === undefined) out.push({ path: 'decision', message: "is required for tool_token.revoked ('revoked')" });
    str('reason', oneOf(TOOL_TOKEN_REVOKE_REASONS), `for tool_token.revoked must be one of ${TOOL_TOKEN_REVOKE_REASONS.join('|')}`, true);
    for (const f of ['requestedAt', 'expiresAt', 'resolvedAt']) if (v[f] === undefined) out.push({ path: f, message: 'is required for tool_token.revoked' });
  }

  if (RECOVERY_KINDS.includes(k)) {
    str('recoveryAction', k === 'recovery_token.rejected' ? (s) => SNAKE.test(s) : oneOf(RECOVERY_ACTIONS),
      k === 'recovery_token.rejected' ? 'must be a snake_case action name' : `must be one of ${RECOVERY_ACTIONS.join('|')}`);
  } else {
    for (const f of ['parentActionId', 'recoveryAction']) if (v[f] !== undefined) out.push({ path: f, message: 'is set only on recovery_token.* records (ADR-0017)' });
  }

  // Fixed decisions (ruling 3b) and the tool_token.minted refinement.
  const fixed = TOOL_HOST_DECISIONS[k];
  if (fixed !== undefined && v['decision'] !== undefined && v['decision'] !== fixed) {
    out.push({ path: 'decision', message: `${k} has decision '${fixed}' (§3.2 ruling 3b)` });
  }
  if (k === 'tool_token.minted') {
    if (v['outcome'] === undefined) out.push({ path: 'outcome', message: 'is required for tool_token.minted' });
    if (v['outcome'] === 'minted' && v['decision'] !== 'approved') out.push({ path: 'decision', message: "tool_token.minted{minted} has decision 'approved'" });
    if (v['outcome'] === 'refused' && (v['decision'] === undefined || v['decision'] === 'approved')) out.push({ path: 'decision', message: "tool_token.minted{refused} carries the refusal's decision, never 'approved'" });
  }

  // Tool-host-call records (ruling 1b): an approval.* / policy.* record naming a toolId carries all three ids.
  if ((k.startsWith('approval.') || k.startsWith('policy.')) && v['toolId'] !== undefined) {
    for (const f of ['actionId', 'taskId'] as const) if (v[f] === undefined) out.push({ path: f, message: `is required on a ${k} record about a tool-host call (toolId set)` });
  }
  if (schemaInvalidDenial) {
    for (const f of ['taskId', 'toolId'] as const) if (v[f] === undefined) out.push({ path: f, message: "is required on policy.denied{schema_invalid}" });
    if (v['actionId'] !== null) out.push({ path: 'actionId', message: "policy.denied{schema_invalid} carries actionId: null (ruling 1e)" });
    keysOnly(v, SCHEMA_INVALID_DENIAL_KEYS, 'schema_invalid denial: ', out);
  }

  // input.field_stripped (rulings 1h/1i).
  if (k === 'input.field_stripped') {
    keysOnly(v, FIELD_STRIPPED_KEYS, '', out);
    str('field', oneOf(STRIPPED_FIELDS), `must be one of ${STRIPPED_FIELDS.join('|')}`, true);
    str('sourceChannel', oneOf(AUDIT_SOURCE_CHANNELS), `must be one of ${AUDIT_SOURCE_CHANNELS.join('|')}`, true);
    if (v['reason'] !== 'untrusted_origin') out.push({ path: 'reason', message: "input.field_stripped has reason 'untrusted_origin'" });
    if (v['decision'] === undefined) out.push({ path: 'decision', message: 'is required for input.field_stripped' });
  } else {
    for (const f of ['field', 'sourceChannel']) if (v[f] !== undefined) out.push({ path: f, message: 'only input.field_stripped carries it (ruling 1i)' });
  }
  if (k.startsWith('tool_token.') || k.startsWith('toolhost.') || k === 'tool_call.host_refused') {
    if (v['decision'] === undefined) out.push({ path: 'decision', message: `is required for ${k} (doc §5.7)` });
  }
  if (RECOVERY_KINDS.includes(k)) {
    for (const f of RECOVERY_RECORD_REQUIRED) if (v[f] === undefined) out.push({ path: f, message: `is required for ${k} (P-c)` });
  }

  if (k === 'server_request.unknown' && v['wireReply'] !== 'error_32601') out.push({ path: 'wireReply', message: "server_request.unknown requires wireReply 'error_32601'" });

  if (k === 'env.scrub') {
    if (v['env'] === undefined) out.push({ path: 'env', message: 'is required for env.scrub' });
    else {
      checkEnv(v['env'], out);
      const present = isObj(v['env']) && v['env']['canary'] === 'present';
      if (present !== (v['outcome'] === 'canary_detected')) out.push({ path: 'outcome', message: "outcome is 'canary_detected' exactly when env.canary is 'present'" });
    }
  } else if (v['env'] !== undefined) out.push({ path: 'env', message: 'only env.scrub carries env' });

  return done(v, out);
}
