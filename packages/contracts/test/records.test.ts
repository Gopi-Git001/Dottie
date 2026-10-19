/** E01 2026-10-19 addition 3: §3.2 AuditRecord / Redacted<T>, §3.3 WindowIdentity / RecoveryToken, and the TS ↔ JSON Schema sync. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_KINDS, AUDIT_OUTCOMES, AUDIT_RECORD_KEYS, RECOVERY_TOKEN_KEYS, TOOL_TOKEN_REVOKE_REASONS, WINDOW_IDENTITY_KEYS,
  validateAuditRecord, validateRecoveryToken, validateWindowIdentity, type Redacted, type AuditRecord, type RedactedAuditRecord,
} from '../src/index.js';
import { valid as schemaValid } from './json-schema-lite.js';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => JSON.parse(readFileSync(join(pkg, p), 'utf8'));
const SCHEMA_FILES = { WindowIdentity: 'schemas/window-identity.schema.json', RecoveryToken: 'schemas/recovery-token.schema.json', AuditRecord: 'schemas/audit-record.schema.json' } as const;
type Kind = keyof typeof SCHEMA_FILES;
const VALIDATORS = { WindowIdentity: validateWindowIdentity, RecoveryToken: validateRecoveryToken, AuditRecord: validateAuditRecord } as const;
interface Case { type: Kind; name: string; valid: boolean; schemaRejects?: boolean; value: unknown }
const cases: Case[] = read('fixtures/records/cases.json').cases;

test('sync: schemas/ is exactly what scripts/json-schemas.mjs generates from the TS consts (npm run schemas)', () => {
  execFileSync(process.execPath, [join(pkg, 'scripts/json-schemas.mjs'), '--check'], { stdio: 'pipe' });
});

test('sync: every case agrees between the TS validator and the JSON Schema (valid → both accept; schemaRejects → both reject)', () => {
  const seen: Record<Kind, [number, number, number]> = { WindowIdentity: [0, 0, 0], RecoveryToken: [0, 0, 0], AuditRecord: [0, 0, 0] };
  for (const c of cases) {
    const ts = VALIDATORS[c.type](c.value).ok;
    const js = schemaValid(read(SCHEMA_FILES[c.type]), c.value);
    if (c.valid) {
      assert.equal(ts, true, `${c.type} "${c.name}": TS validator must accept: ${JSON.stringify(VALIDATORS[c.type](c.value))}`);
      assert.equal(js, true, `${c.type} "${c.name}": schema must accept (the schema may never be stricter than TS)`);
      seen[c.type][0]++;
    } else {
      assert.equal(ts, false, `${c.type} "${c.name}": TS validator must reject`);
      assert.equal(js, !c.schemaRejects, `${c.type} "${c.name}": schema must ${c.schemaRejects ? 'reject' : 'accept (a TS-only rule; listed in $comment)'}`);
      seen[c.type][c.schemaRejects ? 1 : 2]++;
    }
  }
  for (const [t, [v, both, tsOnly]] of Object.entries(seen)) assert.ok(v! > 0 && both! > 0 && tsOnly! > 0, `${t} needs all three case kinds`);
});

test('sync: schema property names are the TS key tuples (which tsc pins to the interfaces)', () => {
  const props = (s: Record<string, unknown>) => Object.keys(s['properties'] as object).sort();
  assert.deepEqual(props(read(SCHEMA_FILES.WindowIdentity)), [...WINDOW_IDENTITY_KEYS].sort());
  assert.deepEqual(props(read(SCHEMA_FILES.RecoveryToken)), [...RECOVERY_TOKEN_KEYS].sort());
  assert.deepEqual(props(read(SCHEMA_FILES.AuditRecord).else as Record<string, unknown>), [...AUDIT_RECORD_KEYS].sort());
});

test('sync: every audit kind has a valid case, and the vectors file matches its schema', () => {
  const kinds = new Set(cases.filter((c) => c.type === 'AuditRecord' && c.valid).map((c) => (c.value as { kind: string }).kind));
  const missing = AUDIT_KINDS.filter((k) => !kinds.has(k) && !k.startsWith('auth.') && !['approval.expired', 'tool.denied_path', 'recovery_token.minted', 'tool_token.minted', 'tool_token.rejected'].includes(k));
  assert.deepEqual(missing, []);
  assert.equal(schemaValid(read('schemas/action-id-vectors.schema.json'), read('fixtures/action-id/vectors.json')), true);
  assert.equal(schemaValid(read('schemas/action-id-vectors.schema.json'), { ...read('fixtures/action-id/vectors.json'), purpose: 'dottie.recoveryToken.v1' }), false);
});

test('§3.2 enums: 24 kinds (d88c9c3), 12 tool_token.revoked reasons, kinds with no outcome', () => {
  assert.equal(AUDIT_KINDS.length, 24);
  assert.equal(TOOL_TOKEN_REVOKE_REASONS.length, 12);
  assert.ok(TOOL_TOKEN_REVOKE_REASONS.includes('locked') && !(TOOL_TOKEN_REVOKE_REASONS as readonly string[]).includes('lock'));
  assert.deepEqual(AUDIT_KINDS.filter((k) => AUDIT_OUTCOMES[k] === null), ['tool_token.revoked', 'tool_call.host_refused', 'input.field_stripped']);
});

test('Redacted<T>: a plain AuditRecord is not assignable to RedactedAuditRecord (compile-time brand)', () => {
  const plain = { schema: 'dottie.audit', version: 1, eventId: 'e', correlationId: 'c', timestamp: '2026-10-19T01:00:00Z', kind: 'auth.logout' } as const satisfies AuditRecord;
  // @ts-expect-error the brand is only produced by the shared redactor's redact()
  const bad: RedactedAuditRecord = plain;
  const stillBranded: Redacted<{ a: 1 }> extends { a: 1 } ? true : false = true;
  assert.ok(bad && stillBranded);
});

test('cases.json escapes the lone surrogate, so Python reads the same value', () => {
  const raw = readFileSync(join(pkg, 'fixtures/records/cases.json'), 'utf8');
  assert.match(raw, /\\ud800abc/);
});

test('Python jsonschema agrees with every case (DOTTIE_PYTHON with jsonschema installed; skipped otherwise)', (t) => {
  const py = process.env['DOTTIE_PYTHON'] ?? 'python3';
  if (spawnSync(py, ['-c', 'import jsonschema'], { stdio: 'ignore' }).status !== 0) {
    t.skip(`${py} has no jsonschema; run DOTTIE_PYTHON=<venv python> npm test`);
    return;
  }
  const out = execFileSync(py, [join(pkg, 'scripts/check_records_schemas.py')], { encoding: 'utf8' });
  assert.match(out, /^ok \d+/m);
});
