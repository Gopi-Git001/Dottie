import assert from 'node:assert/strict';
import { DIALOG_CATEGORIES, DISPLAY_KINDS } from '../src/display.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_CATEGORIES,
  AUTH_STATES,
  EVENT_TYPES,
  authStateAdmitsTasks,
  validateEvent,
  type AnyEvent,
} from '../src/index.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (sub: string) =>
  readdirSync(join(PKG, 'fixtures', 'events', sub))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, json: JSON.parse(readFileSync(join(PKG, 'fixtures', 'events', sub, f), 'utf8')) as unknown }));

const valid = load('valid');
const invalid = load('invalid') as { name: string; json: { errorPath: string; alsoAt?: string[]; event: unknown } }[];

for (const { name, json } of valid) {
  test(`valid fixture ${name} validates`, () => {
    const r = validateEvent(json);
    assert.deepEqual(r.ok ? [] : r.issues, []);
  });
}

test('every event type has at least one valid fixture', () => {
  const covered = new Set(valid.map((v) => (v.json as AnyEvent).type));
  assert.deepEqual([...EVENT_TYPES].filter((t) => !covered.has(t)), []);
});

for (const { name, json } of invalid) {
  test(`invalid fixture ${name} is rejected at ${json.errorPath}`, () => {
    const r = validateEvent(json.event);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(
        r.issues.some((i) => i.path === json.errorPath),
        `expected an issue at ${json.errorPath}, got ${JSON.stringify(r.issues)}`,
      );
      // ...and only there (or below it): a fixture must not pass on an unrelated defect.
      const under = (path: string, at: string): boolean => path === at || path.startsWith(`${at}.`) || path.startsWith(`${at}[`);
      const stray = r.issues.filter((i) => ![json.errorPath, ...(json.alsoAt ?? [])].some((at) => under(i.path, at)));
      assert.deepEqual(stray, [], `${name}: issues outside ${json.errorPath}`);
    }
  });
}

test('v1 envelopes are rejected, not coerced', () => {
  const v1 = { version: 1, type: 'TaskFinished', eventId: 'e', correlationId: 'c', timestamp: '2026-10-18T19:00:00Z', payload: {} };
  const r = validateEvent(v1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.some((i) => i.path === 'version'));
});

test('non-objects are rejected', () => {
  for (const v of [null, 42, 'TaskFinished', [], undefined]) assert.equal(validateEvent(v).ok, false);
});

test('only signed_in admits tasks', () => {
  assert.deepEqual(AUTH_STATES.filter(authStateAdmitsTasks), ['signed_in']);
});

test('X5 coverage (ruling 1l, scoped by ruling 2a dottie-e01 972d5f4): per display kind', () => {
  const load = (n: string) => JSON.parse(readFileSync(join(PKG, 'fixtures/events/valid', n), 'utf8')) as { payload: Record<string, unknown> & { display: Record<string, unknown> } };
  const withCat = (ev: ReturnType<typeof load>, category: string) => ({ ...ev, payload: { ...ev.payload, category, display: { ...ev.payload.display, category } } });
  const accepted = (n: string) => APPROVAL_CATEGORIES.filter((c) => validateEvent(withCat(load(n), c)).ok);
  const KIND_COMPLETE = ['read', 'navigate', ...DIALOG_CATEGORIES];
  // pre_dispatch / codex_command / codex_file_change: every category incl. read and navigate; never credential_access.
  for (const n of ['approval-requested-pre-dispatch-clean-retry.json', 'approval-requested-codex-command.json', 'approval-requested-codex-file-change.json']) {
    assert.deepEqual(accepted(n).sort(), [...KIND_COMPLETE].sort(), n);
  }
  // ui_action: local_change or stricter (dialog categories only).
  assert.deepEqual(accepted('approval-requested-ui-action.json'), [...DIALOG_CATEGORIES]);
  // tool: read / navigate / credential_access rejected for the category itself (not only for its per-category keys).
  const tool = load('approval-requested.json');
  for (const c of ['read', 'navigate', 'credential_access']) {
    const r = validateEvent(withCat(tool, c));
    assert.equal(r.ok, false, c);
    assert.ok(r.issues.some((i) => i.path === 'payload.display.category' && /no display rule/.test(i.message)), `tool ${c}: ${JSON.stringify(r.issues)}`);
  }
  // ruling 1g still holds: a possible-repeat pre_dispatch is never read/navigate.
  assert.deepEqual(accepted('approval-requested-pre-dispatch.json'), [...DIALOG_CATEGORIES]);
  // The vectors: pre_dispatch read and codex_command read accepted; tool read rejected.
  const v = JSON.parse(readFileSync(join(PKG, 'fixtures/action-id/vectors.json'), 'utf8')) as { displays: { name: string; display: Record<string, unknown> }[]; displaysInvalid: { name: string; display: Record<string, unknown> }[] };
  const ok = v.displays.filter((x) => x.name.startsWith('ruling 2a:')).map((x) => `${String(x.display['kind'])}/${String(x.display['category'])}`);
  assert.deepEqual(ok, ['pre_dispatch/read', 'pre_dispatch/navigate', 'codex_command/read', 'codex_file_change/navigate', 'pre_dispatch/read']);
  const bad = v.displaysInvalid.filter((x) => x.name.startsWith('ruling 2a:')).map((x) => `${String(x.display['kind'])}/${String(x.display['category'])}`);
  assert.deepEqual(bad, ['tool/read', 'ui_action/read', 'pre_dispatch/credential_access', 'codex_command/credential_access']);
});

test('ruling 2b (dottie-e01 97e7bc0): display.category must equal the event category for every kind (both directions)', () => {
  const load = (n: string) => JSON.parse(readFileSync(join(PKG, 'fixtures/events/valid', n), 'utf8')) as { payload: Record<string, unknown> & { display: Record<string, unknown> } };
  // [fixture, a different category the kind's display accepts]
  const cases = [
    ['approval-requested.json', 'tool', 'overwrite'],
    ['approval-requested-ui-action.json', 'ui_action', 'delete'],
    ['approval-requested-codex-command.json', 'codex_command', 'read'],
    ['approval-requested-codex-file-change.json', 'codex_file_change', 'navigate'],
    ['approval-requested-pre-dispatch-clean-retry.json', 'pre_dispatch', 'overwrite'],
  ] as const;
  assert.deepEqual(cases.map(([, k]) => k).sort(), [...DISPLAY_KINDS].sort(), 'one case per kind');
  for (const [n, kind, other] of cases) {
    const ev = load(n);
    assert.equal(ev.payload.display['kind'], kind);
    assert.equal(validateEvent(ev).ok, true, n);
    for (const bad of [
      { ...ev, payload: { ...ev.payload, display: { ...ev.payload.display, category: other } } },
      { ...ev, payload: { ...ev.payload, category: other } },
    ]) {
      const r = validateEvent(bad);
      assert.equal(r.ok, false, `${kind}: mismatch rejected`);
      assert.deepEqual(r.issues.map((i) => i.path), ['payload.display.category'], `${kind}: only the mismatch (${JSON.stringify(r.issues)})`);
    }
  }
  // The negative fixture set covers every kind.
  const inv = readdirSync(join(PKG, 'fixtures/events/invalid')).filter((f) => /category-mismatch\.json$/.test(f)).map((f) => (JSON.parse(readFileSync(join(PKG, 'fixtures/events/invalid', f), 'utf8')) as { event: { payload: { display: { kind: string } } } }).event.payload.display.kind);
  assert.deepEqual([...new Set(inv)].sort(), [...DISPLAY_KINDS].sort());
});

test('all Dottie enum values are snake_case', async () => {
  const enums = await import('../src/enums.js');
  for (const [name, values] of Object.entries(enums)) {
    if (!Array.isArray(values) || ['COORDINATOR_STATES', 'TOOL_ERROR_CODES', 'CAPABILITY_SCOPES'].includes(name)) continue;
    for (const v of values as string[]) assert.match(v, /^[a-z]+(_[a-z]+)*$/, `${name}: ${v}`);
  }
});

test('authGate (CONTRACTS §2.1, E01 2026-10-19): only signed_in admits; unavailable/unknown never map to a sign-in reason', async () => {
  const { authGate } = await import('../src/index.js');
  assert.deepEqual(authGate('signed_in'), { admit: true });
  assert.deepEqual(authGate('signed_out'), { admit: false, outcome: 'blocked_auth', reason: 'auth_required' });
  assert.deepEqual(authGate('expired'), { admit: false, outcome: 'blocked_auth', reason: 'auth_required' });
  assert.deepEqual(authGate('signing_in'), { admit: false, outcome: 'blocked_auth', reason: 'sign_in_in_progress' });
  assert.deepEqual(authGate('unsupported'), { admit: false, outcome: 'blocked_auth', reason: 'account_unsupported' });
  for (const s of ['unavailable', 'unknown'] as const) assert.deepEqual(authGate(s), { admit: false, outcome: 'blocked_unavailable', reason: 'codex_unavailable' });
});

test('CONTRACTS §3 / ADR-0012 §4 sets (E01 drift fix 2026-10-19): scopes, categories, always-confirm, error codes, runtime', async () => {
  const m = await import('../src/index.js');
  assert.ok((m.CAPABILITY_SCOPES as readonly string[]).includes('files.navigate'));
  assert.equal(m.APPROVAL_CATEGORIES.length, 11, 'CONTRACTS §3 ApprovalRequested.category: exactly 11 (E03 2026-10-19)');
  assert.deepEqual([...m.APPROVAL_CATEGORIES], ['read', 'navigate', 'local_change', 'delete', 'overwrite', 'external_send', 'external_upload', 'purchase', 'install_or_elevate', 'security_setting', 'credential_access']);
  assert.deepEqual([...m.ALWAYS_CONFIRM_CATEGORIES].sort(), ['delete', 'external_send', 'external_upload', 'install_or_elevate', 'local_change', 'overwrite', 'purchase', 'security_setting']);
  assert.deepEqual([...m.NO_CONFIRM_CATEGORIES].sort(), ['navigate', 'read']);
  for (const c of m.APPROVAL_CATEGORIES) {
    const sets = [m.ALWAYS_CONFIRM_CATEGORIES.has(c), m.NO_CONFIRM_CATEGORIES.has(c), m.FORBIDDEN_CATEGORIES.has(c)].filter(Boolean).length;
    assert.equal(sets, 1, `${c} is in exactly one of always-confirm / no-confirm / forbidden`);
  }
  assert.deepEqual([...m.TOOL_ERROR_CODES], ['DENIED_BY_POLICY', 'PERMISSION_REQUIRED', 'APPROVAL_REQUIRED', 'AMBIGUOUS', 'NOT_FOUND', 'TIMEOUT', 'PRECONDITION_FAILED', 'POSTCONDITION_FAILED', 'POSTCONDITION_UNKNOWN', 'CANCELLED', 'INVALID_ARGUMENT', 'USER_DECLINED', 'INTERNAL']);
  assert.deepEqual([...m.RUNTIME_STATUSES], ['unknown', 'starting', 'running', 'backoff', 'breaker_open', 'half_open', 'waiting_for_env', 'stopped']);
  assert.deepEqual([...m.EXIT_CLASSES], ['clean', 'crash', 'hang', 'env_unavailable']);
  assert.equal(m.REDACTED_METADATA_MAX_KEYS, 32);
  assert.equal(m.REDACTED_METADATA_MAX_BYTES, 2048);
});

test('TaskFinished reason pairing = E03 reasonFitsOutcome (61447a6): every outcome × reason', async () => {
  const m = await import('../src/index.js');
  const expect = (o: string, r: string | undefined): boolean => {
    if (o === 'blocked_auth') return r !== undefined && (m.BLOCKED_AUTH_REASONS as readonly string[]).includes(r);
    if (o === 'blocked_unavailable') return r === 'codex_unavailable';
    if (o === 'failed') return r === undefined || r === 'clarification_timeout' || r === 'clarification_cancelled' || r === 'retry_not_allowed';
    if (o === 'declined') return r === undefined || r === 'approval_unavailable';
    if (o === 'failed_after_side_effects') return true;
    return r === undefined;
  };
  for (const o of m.TASK_OUTCOMES) for (const r of [undefined, ...m.TASK_FINISHED_REASONS]) {
    assert.equal(m.taskFinishedReasonFits(o, r), expect(o, r), `${o} + ${String(r)}`);
  }
  assert.deepEqual([...m.TASK_FINISHED_REASONS], ['auth_required', 'sign_in_in_progress', 'account_unsupported', 'codex_unavailable', 'clarification_timeout', 'clarification_cancelled', 'approval_unavailable', 'retry_not_allowed']);
});
