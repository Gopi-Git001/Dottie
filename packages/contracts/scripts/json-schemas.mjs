#!/usr/bin/env node
/**
 * Generates the JSON Schema (draft 2020-12) files in schemas/ from the TS consts in src/records.ts and src/enums.ts
 * (built to dist/), so the schema and the TS types share one source (E01 2026-10-19 addition 3). `--check` fails when a
 * committed schema differs from what the consts produce. The TS-only rules each schema can't express are listed in
 * its `$comment`; test/records.test.ts pins both directions with the differential fixtures in fixtures/records.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const c = await import(join(root, 'dist/src/index.js'));
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** Anchored patterns plus a no-newline guard: Python's `re` `$` also matches before a trailing "\n". */
const pat = (pattern, extra = {}) => ({ type: 'string', pattern, not: { pattern: '\\n' }, ...extra });
const caseless = (p) => p.replace(/[A-Za-z]/g, (ch) => `[${ch.toUpperCase()}${ch.toLowerCase()}]`);
const ifKind = (kinds, then, otherwise) => {
  const cond = { required: ['kind'], properties: { kind: kinds.length === 1 ? { const: kinds[0] } : { enum: [...kinds] } } };
  return otherwise === undefined ? { if: cond, then } : { if: cond, then, else: otherwise };
};
const forbid = (...keys) => ({ properties: Object.fromEntries(keys.map((k) => [k, false])) });

function windowIdentity() {
  return {
    title: 'WindowIdentity (CONTRACTS §3.3)',
    $comment:
      'TS-only rules (validateWindowIdentity): hwnd <= 2^64-1, pid <= 2^32-1, processStartTime <= 2^63-1; windowClass is 1-256 UTF-16 code units (JSON Schema counts code points) with no lone surrogate. Any failure = the window has no identity.',
    type: 'object',
    additionalProperties: false,
    required: [...c.WINDOW_IDENTITY_KEYS],
    properties: {
      hwnd: pat(c.POSITIVE_DECIMAL_PATTERN, { maxLength: 20 }),
      pid: pat(c.POSITIVE_DECIMAL_PATTERN, { maxLength: 10 }),
      windowClass: { type: 'string', minLength: 1, maxLength: c.WINDOW_CLASS_MAX_UTF16 },
      processStartTime: pat(c.POSITIVE_DECIMAL_PATTERN, { maxLength: 19 }),
    },
  };
}

function recoveryToken() {
  return {
    title: 'RecoveryToken (CONTRACTS §3.3, ADR-0017): shape only; the MAC is verified by K8 (E08)',
    $comment: 'TS-only rules (validateRecoveryToken): actionId differs from parentActionId; the WindowIdentity TS-only rules.',
    type: 'object',
    additionalProperties: false,
    required: [...c.RECOVERY_TOKEN_KEYS],
    properties: {
      actionId: { $ref: '#/$defs/sha256Hex' },
      parentActionId: { $ref: '#/$defs/sha256Hex' },
      recoveryAction: { enum: [...c.RECOVERY_ACTIONS] },
      taskId: { type: 'string', minLength: 1 },
      windowIdentity: { $ref: '#/$defs/windowIdentity' },
      nonce: pat(c.BASE64URL_128_PATTERN),
      mac: pat(c.BASE64URL_256_PATTERN),
    },
    $defs: { sha256Hex: pat(c.SHA256_HEX_PATTERN), windowIdentity: windowIdentity() },
  };
}

function auditRecord() {
  const sha = { $ref: '#/$defs/sha256Hex' };
  const iso = { $ref: '#/$defs/isoTimestamp' };
  const nonEmpty = { type: 'string', minLength: 1 };
  const snake = pat(c.SNAKE_CASE_PATTERN);
  const rules = [];
  for (const k of c.AUDIT_KINDS) {
    if (k === 'redactor.fallback') continue;
    const o = c.AUDIT_OUTCOMES[k];
    rules.push(ifKind([k], o === null ? forbid('outcome') : { properties: { outcome: { enum: [...o] } } }));
  }
  rules.push({
    if: { required: ['actionId'], properties: { actionId: { type: 'null' } } },
    then: { required: ['kind', 'reason'], properties: { kind: { const: 'policy.denied' }, reason: { const: 'schema_invalid' } } },
  });
  rules.push(ifKind(c.AUDIT_KINDS_WITHOUT_IDS, forbid('actionId', 'taskId', 'toolId')));
  rules.push(ifKind(c.AUDIT_KINDS_WITH_IDS, { required: ['actionId', 'taskId', 'toolId'] }));
  rules.push(ifKind(['tool_call.host_refused'], { required: ['source', 'reason'], properties: { reason: { enum: [...c.HOST_REFUSED_REASONS] } } }, forbid('source')));
  rules.push(ifKind(['tool_token.revoked'], {
    required: ['decision', 'reason', 'requestedAt', 'expiresAt', 'resolvedAt'],
    properties: { decision: { const: 'revoked' }, reason: { enum: [...c.TOOL_TOKEN_REVOKE_REASONS] } },
  }));
  rules.push(ifKind(c.RECOVERY_KINDS, {}, forbid('parentActionId', 'recoveryAction')));
  rules.push(ifKind(c.RECOVERY_KINDS.filter((k) => k !== 'recovery_token.rejected'), { properties: { recoveryAction: { enum: [...c.RECOVERY_ACTIONS] } } }));
  rules.push(ifKind(['server_request.unknown'], { required: ['wireReply'], properties: { wireReply: { const: 'error_32601' } } }));
  rules.push(ifKind(['env.scrub'], { required: ['env'] }, forbid('env')));
  rules.push(ifKind(c.APPROVAL_RECORD_KINDS, {}, forbid('displayHash', 'joinedTo')));
  // d88c9c3: input.field_stripped (rulings 1h/1i).
  rules.push(ifKind(['input.field_stripped'], {
    required: ['decision', 'field', 'sourceChannel', 'reason'],
    properties: { reason: { const: 'untrusted_origin' } },
    propertyNames: { enum: [...c.FIELD_STRIPPED_KEYS] },
  }, forbid('field', 'sourceChannel')));
  // Fixed decisions per kind (ruling 3b); decision required on the tool-host kinds.
  for (const [k, d] of Object.entries(c.TOOL_HOST_DECISIONS)) rules.push(ifKind([k], { properties: { decision: { const: d } } }));
  rules.push(ifKind(c.AUDIT_KINDS.filter((k) => k.startsWith('tool_token.') || k.startsWith('toolhost.') || k === 'tool_call.host_refused'), { required: ['decision'] }));
  rules.push(ifKind(['tool_token.minted'], {
    required: ['outcome'],
    allOf: [
      { if: { properties: { outcome: { const: 'minted' } } }, then: { required: ['decision'], properties: { decision: { const: 'approved' } } } },
      { if: { properties: { outcome: { const: 'refused' } } }, then: { required: ['decision'], properties: { decision: { not: { const: 'approved' } } } } },
    ],
  }));
  // Tool-host-call approval.* / policy.* records (toolId set) carry the three ids (ruling 1b).
  rules.push({
    if: { required: ['kind', 'toolId'], properties: { kind: { enum: c.AUDIT_KINDS.filter((k) => k.startsWith('approval.') || k.startsWith('policy.')) } } },
    then: { required: ['actionId', 'taskId'] },
  });
  // policy.denied{schema_invalid}: actionId null, taskId + toolId, nothing else (ruling 1e).
  rules.push({
    if: { required: ['kind', 'reason'], properties: { kind: { const: 'policy.denied' }, reason: { const: 'schema_invalid' } } },
    then: { required: ['taskId', 'toolId', 'actionId'], properties: { actionId: { type: 'null' } }, propertyNames: { enum: [...c.SCHEMA_INVALID_DENIAL_KEYS] } },
  });
  rules.push(ifKind(c.RECOVERY_KINDS, { required: [...c.RECOVERY_RECORD_REQUIRED] }));
  rules.push({
    if: { required: ['env'], properties: { env: { required: ['canary'], properties: { canary: { const: 'present' } } } } },
    then: { required: ['outcome'], properties: { outcome: { const: 'canary_detected' } } },
    else: { properties: { outcome: { not: { const: 'canary_detected' } } } },
  });
  const full = {
    type: 'object',
    additionalProperties: false,
    required: [...c.AUDIT_RECORD_REQUIRED],
    properties: {
      schema: { const: c.AUDIT_SCHEMA },
      version: { const: c.AUDIT_VERSION },
      eventId: nonEmpty,
      correlationId: nonEmpty,
      causationId: nonEmpty,
      taskId: nonEmpty,
      timestamp: iso,
      kind: { enum: c.AUDIT_KINDS.filter((k) => k !== 'redactor.fallback') },
      actionId: { if: { type: 'string' }, then: sha, else: { type: 'null' } },
      toolId: pat(c.TOOL_ID_PATTERN),
      field: { enum: [...c.STRIPPED_FIELDS] },
      source: { const: 'host' },
      parentActionId: sha,
      recoveryAction: snake,
      targetHash: sha,
      argsHash: sha,
      displayHash: sha,
      joinedTo: nonEmpty,
      category: { enum: [...c.APPROVAL_CATEGORIES] },
      risk: { enum: [...c.RISK_SEVERITIES] },
      decision: { enum: [...c.AUDIT_DECISIONS] },
      wireReply: { enum: [...c.AUDIT_WIRE_REPLIES] },
      requestedAt: iso,
      expiresAt: iso,
      resolvedAt: iso,
      channel: { enum: [...c.AUDIT_CHANNELS] },
      sourceChannel: { enum: [...c.AUDIT_SOURCE_CHANNELS] },
      reason: snake,
      outcome: { type: 'string' },
      env: {
        type: 'object',
        additionalProperties: false,
        required: [...c.AUDIT_ENV_KEYS],
        properties: {
          keptNames: { type: 'array', uniqueItems: true, items: nonEmpty },
          removedSensitiveNames: { type: 'array', uniqueItems: true, items: pat(caseless(c.ENV_SENSITIVE_NAME_PATTERN)) },
          removedOtherCount: { type: 'integer', minimum: 0 },
          keptCount: { type: 'integer', minimum: 0 },
          removedCount: { type: 'integer', minimum: 0 },
          canary: { enum: [...c.ENV_CANARY_STATES] },
        },
      },
    },
    allOf: rules,
  };
  const fallback = {
    type: 'object',
    additionalProperties: false,
    required: [...c.AUDIT_FALLBACK_KEYS],
    properties: { kind: { const: 'redactor.fallback' }, eventId: nonEmpty, error: pat(c.ERROR_CLASS_PATTERN) },
  };
  return {
    title: 'dottie.audit v1 record (CONTRACTS §3.2), or the fail-closed redactor.fallback record',
    $comment: [
      'TS-only rules (validateAuditRecord):',
      `at most ${c.AUDIT_RECORD_MAX_BYTES} UTF-8 bytes per record;`,
      'no string anywhere matches the K8 token pattern;',
      'timestamps are real dates (Date.parse);',
      'argsHash equals actionId when both are present;',
      'joinedTo differs from the record\'s own eventId;',
      'env name lists are sorted;',
      'env.keptCount = keptNames.length and env.removedCount = removedSensitiveNames.length + removedOtherCount.',
      'Codex-side approval.* and other pre-existing kinds: per-kind id presence is OPEN in CONTRACTS and not enforced.',
    ].join(' '),
    if: { type: 'object', required: ['kind'], properties: { kind: { const: 'redactor.fallback' } } },
    then: fallback,
    else: full,
    $defs: { sha256Hex: pat(c.SHA256_HEX_PATTERN), isoTimestamp: pat(c.ISO_OFFSET_PATTERN) },
  };
}

function actionIdVectors() {
  const str = { type: 'string' };
  const obj = { type: 'object' };
  const entry = (props, required) => ({ type: 'object', additionalProperties: false, required, properties: props });
  return {
    title: 'actionId / canonical JSON test vectors (ADR-0009 CR2, CONTRACTS §3.3): fixtures/action-id/vectors.json',
    $comment: 'Numbers that JSON cannot carry are written as {"$number": "<text>"} or {"$bigint": "<digits>"} inside an input.',
    type: 'object',
    additionalProperties: false,
    required: ['_readme', 'purpose', 'canonicalJson', 'canonicalJsonInvalid', 'displays', 'displaysInvalid', 'displayCuts', 'actionId', 'actionIdInvalid', 'shortNames', 'paths', 'pathBindings'],
    properties: {
      _readme: { type: 'array', items: str },
      purpose: { const: c.ACTION_ID_PURPOSE },
      canonicalJson: { type: 'array', items: entry({ name: str, input: obj, canonical: str }, ['name', 'input', 'canonical']) },
      canonicalJsonInvalid: { type: 'array', items: entry({ name: str, input: obj, error: str }, ['name', 'input', 'error']) },
      displays: { type: 'array', items: entry({ name: str, display: obj, canonical: str, displayHash: { $ref: '#/$defs/sha256Hex' } }, ['name', 'display', 'canonical', 'displayHash']) },
      displaysInvalid: { type: 'array', items: entry({ name: str, display: obj, error: str }, ['name', 'display', 'error']) },
      displayCuts: {
        type: 'array',
        items: entry(
          { name: str, field: { enum: ['summaryUntrusted', 'windowTitle'] }, max: { type: 'integer' }, input: str, inputCodePoints: { type: 'integer' }, output: str, outputCodePoints: { type: 'integer' }, cut: { type: 'boolean' }, display: obj, displayHash: { $ref: '#/$defs/sha256Hex' } },
          ['name', 'field', 'max', 'input', 'inputCodePoints', 'output', 'outputCodePoints', 'cut', 'display', 'displayHash'],
        ),
      },
      actionId: { type: 'array', items: entry({ name: str, input: obj, display: { type: ['string', 'null'] }, canonical: str, actionId: { $ref: '#/$defs/sha256Hex' } }, ['name', 'input', 'display', 'canonical', 'actionId']) },
      actionIdInvalid: { type: 'array', items: entry({ name: str, input: obj, error: str }, ['name', 'input', 'error']) },
      shortNames: { type: 'object', additionalProperties: str },
      paths: {
        type: 'array',
        items: entry({ name: str, platform: { enum: ['win32', 'posix'] }, raw: str, canonical: { type: ['string', 'null'] }, error: { type: ['string', 'null'] } }, ['name', 'platform', 'raw']),
      },
      pathBindings: {
        type: 'array',
        items: entry(
          { name: str, platform: { enum: ['win32', 'posix'] }, raws: { type: 'array', items: str }, actionIds: { type: 'array', items: { $ref: '#/$defs/sha256Hex' } }, same: { type: 'boolean' } },
          ['name', 'platform', 'raws', 'actionIds', 'same'],
        ),
      },
    },
    $defs: { sha256Hex: pat(c.SHA256_HEX_PATTERN) },
  };
}

export const SCHEMAS = {
  'window-identity.schema.json': ['urn:dottie:contracts:window-identity:v1', windowIdentity()],
  'recovery-token.schema.json': ['urn:dottie:contracts:recovery-token:v1', recoveryToken()],
  'audit-record.schema.json': ['urn:dottie:contracts:audit-record:v1', auditRecord()],
  'action-id-vectors.schema.json': ['urn:dottie:contracts:action-id-vectors:v1', actionIdVectors()],
};

const outDir = join(root, 'schemas');
let stale = 0;
for (const [file, [id, body]] of Object.entries(SCHEMAS)) {
  const text = `${JSON.stringify({ $schema: DRAFT, $id: id, ...body }, null, 2)}\n`;
  const path = join(outDir, file);
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(path, 'utf8'); } catch { /* missing */ }
    if (cur !== text) { console.error(`stale: schemas/${file} (run npm run schemas)`); stale++; }
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path, text);
  }
}
if (stale) process.exit(1);
