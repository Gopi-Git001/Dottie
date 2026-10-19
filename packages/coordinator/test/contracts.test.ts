import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, validateEvent } from '../src/contracts.js';
import { obs, allowAllChannels, approval, fixture, flush, untilAborted, wake, utterance, hexId, fileParams, codexDisp } from './helpers.js';

test('every event the coordinator emits validates against contract v1 and carries ids + timestamps', async () => {
  const f = await fixture({ policy: allowAllChannels });
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.threadAssigned('thr_1');
    hooks.progress('Searching Downloads', 'files.search');
    hooks.toolStarted({ toolId: 'files.search', mayHaveSideEffects: false });
    hooks.toolResult({ toolId: 'files.search', observedState: obs('found 1 pdf', 'none', true), verified: true, sideEffect: 'none' });
    const d = await hooks.requestApproval({ actionId: hexId('open'), summary: 'Open report.pdf', risk: 'low', category: 'read', display: fileParams() });
    assert.equal(d.approved, true);
    return { status: 'completed', summary: 'Opened report.pdf.' };
  });
  f.say('open the newest pdf in downloads');
  await flush(); // not drain(): that would fire the approval expiry timer
  // approval pending -> resolve then finish
  assert.equal(f.c.state, 'PERMISSION_REQUIRED');
  f.c.resolveApproval(approval(hexId('open'), true, f), 'secure_ui');
  await f.drain();
  f.codex.scripts.push(untilAborted);
  f.say('close it');
  await flush();
  f.c.cancelTask();
  await f.drain();
  const seen = new Set(f.sink.events.map(e => e.type));
  for (const t of ['TaskRequested', 'TaskProgress', 'ApprovalRequested', 'ToolResult', 'TaskFinished', 'TaskCancelled'] as const) assert.ok(seen.has(t), t);
  for (const e of f.sink.events) {
    const r = validateEvent(JSON.parse(JSON.stringify(e)));
    assert.ok(r.ok, `${e.type}: ${r.ok ? '' : r.errors.join(', ')}`);
    assert.ok(e.eventId && e.correlationId && e.timestamp);
    assert.equal(e.taskId, (e.payload as { taskId?: string }).taskId ?? e.taskId);
  }
  assert.equal(new Set(f.sink.events.map(e => e.eventId)).size, f.sink.events.length, 'eventIds unique');
});

test('inbound E05/E06 events validate too', () => {
  for (const e of [wake(), utterance('hello', 'r1'), approval(hexId('a1'), false)]) assert.ok(validateEvent(e).ok, e.type);
  assert.equal(EVENT_TYPES.length, 9);
});

test('validator rejects unknown versions, unknown types, missing fields, bad enums and bad timestamps', () => {
  const good = utterance('hi', 'r1');
  const bad = (patch: Record<string, unknown>) => validateEvent({ ...JSON.parse(JSON.stringify(good)), ...patch });
  assert.equal(bad({ version: 1 }).ok, false, 'v1 events are rejected, never coerced (DOT-060 AC1)');
  assert.equal(bad({ version: 3 }).ok, false);
  assert.equal(bad({ schema: 'other' }).ok, false);
  assert.equal(bad({ type: 'TaskExploded' }).ok, false);
  assert.equal(bad({ timestamp: 'yesterday' }).ok, false);
  assert.equal(bad({ payload: { requestId: 'r1', locale: 'en-US', endReason: 'vad_silence' } }).ok, false, 'missing text');
  assert.equal(bad({ payload: { requestId: 'r1', text: 'x', locale: 'en-US', endReason: 'whenever' } }).ok, false, 'bad enum');
  assert.equal(validateEvent({ ...approval(hexId('a'), true), payload: { actionId: hexId('a'), approved: 'yes', timestamp: '2026-10-18T13:00:00Z' } }).ok, false, 'approved must be boolean');
  assert.equal(validateEvent(null).ok, false);
});

test('v2 (DOT-060): ToolResult invariants, ApprovalResolved taskId, TaskFinished verified rule, category', () => {
  const tr = (payload: Record<string, unknown>) =>
    validateEvent({ schema: 'dottie.event', version: 2, type: 'ToolResult', eventId: 'e', correlationId: 'c', taskId: 't', timestamp: '2026-10-19T00:00:00-05:00', payload: { taskId: 't', toolId: 'x.y', sideEffect: 'none', observedState: obs('n'), ...payload } });
  assert.equal(tr({ verified: true }).ok, true);
  assert.equal(tr({ verified: false }).ok, false, 'verified:false needs an error');
  assert.equal(tr({ verified: true, error: { code: 'INTERNAL', message: 'm', retryable: false } }).ok, false, 'error implies verified:false');
  assert.equal(tr({ verified: false, error: { code: 'NOPE', message: 'm', retryable: false } }).ok, false, 'unknown error code');
  assert.equal(tr({ verified: false, sideEffect: 'committed', error: { code: 'TIMEOUT', message: 'm', retryable: true } }).ok, false, 'retryable only with sideEffect none');
  assert.equal(tr({ verified: true, observedState: 'a string' }).ok, false, 'observedState must be an object');
  assert.equal(tr({ verified: true, observedState: { outcome: 'verified', decision: 'cancelled', checks: {}, sideEffect: 'none' } }).ok, false, 'no cancelled decision');
  const { taskId: _drop, ...noTask } = approval(hexId('a'), true);
  void _drop;
  assert.equal(validateEvent(noTask).ok, false, 'ApprovalResolved requires envelope taskId');
  const fin = (outcome: string, verified: boolean) =>
    validateEvent({ schema: 'dottie.event', version: 2, type: 'TaskFinished', eventId: 'e', correlationId: 'c', timestamp: '2026-10-19T00:00:00Z', payload: { taskId: 't', outcome, verified, summary: 's' } });
  assert.equal(fin('succeeded', true).ok, true);
  assert.equal(fin('partial', true).ok, false, 'verified:true only with succeeded');
  assert.equal(fin('failed_after_side_effects', false).ok, true);
  const ar = (extra: Record<string, unknown>) =>
    validateEvent({ schema: 'dottie.event', version: 2, type: 'ApprovalRequested', eventId: 'e', correlationId: 'c', timestamp: '2026-10-19T00:00:00Z', payload: { taskId: 't', actionId: hexId('a'), summary: 's', risk: 'high', expiry: '2026-10-19T00:01:00Z', ...codexDisp(extra['category']), ...extra } });
  assert.equal(ar({}).ok, false, 'category required');
  assert.equal(ar({ category: 'delete' }).ok, true);
});

test('v2 (DOT-060): verifier outcomes map per CONTRACTS §3.1, failed splits on the ledger', async () => {
  const { fixture: mk } = await import('./helpers.js');
  const cases = [
    ['verified', 'none', 'succeeded'],
    ['partially_verified', 'committed', 'partial'],
    ['unverified', 'committed', 'unverified'],
    ['failed', 'none', 'failed'],
    ['failed', 'committed', 'failed_after_side_effects'],
  ] as const;
  for (const [vo, effect, expected] of cases) {
    const f = await mk({ verifier: { verify: async () => ({ outcome: vo, verified: vo === 'verified', observedState: obs('v', effect, vo === 'verified') }) } });
    f.codex.scripts.push(async ({ hooks }) => {
      hooks.toolResult({ toolId: 'files.save', observedState: obs('saved', effect), verified: true, sideEffect: effect });
      return { status: 'completed', summary: 'Saved.' };
    });
    f.say(`save it ${vo} ${effect}`);
    await f.drain();
    const p = f.sink.of('TaskFinished')[0]!.payload;
    assert.equal(p.outcome, expected, `${vo}/${effect}`);
    assert.equal(p.verified, expected === 'succeeded');
  }
});

test('v2 (DOT-060): adapter tool results that break §5 invariants are normalised fail-safe', async () => {
  const { fixture: mk } = await import('./helpers.js');
  const f = await mk();
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'a.b', observedState: obs('x'), verified: true, error: { code: 'INTERNAL', message: 'boom', retryable: false }, sideEffect: 'none' });
    hooks.toolResult({ toolId: 'c.d', observedState: obs('y', 'committed'), verified: false, error: { code: 'TIMEOUT', message: 't', retryable: true }, sideEffect: 'committed' });
    return { status: 'completed', summary: 'done' };
  });
  f.say('do two things');
  await f.drain();
  const [a, b] = f.sink.of('ToolResult').map(e => e.payload);
  assert.equal(a!.verified, false, 'error forces verified:false');
  assert.equal(b!.error!.retryable, false, 'retryable cleared when a side effect exists');
  for (const e of f.sink.events) assert.ok(validateEvent(JSON.parse(JSON.stringify(e))).ok, e.type);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'unverified');
});

test('E01 2026-10-19: TaskFinished.reason enum and its pairing with outcome (CONTRACTS §3, §2.1)', () => {
  const fin = (outcome: string, reason?: unknown) =>
    validateEvent({ schema: 'dottie.event', version: 2, type: 'TaskFinished', eventId: 'e', correlationId: 'c', timestamp: '2026-10-19T00:00:00Z', payload: { taskId: 't', outcome, verified: false, summary: 's', ...(reason !== undefined ? { reason } : {}) } });
  const ok: [string, string | undefined][] = [
    ['failed', undefined], ['answered', undefined],
    ['blocked_auth', 'auth_required'], ['blocked_auth', 'sign_in_in_progress'], ['blocked_auth', 'account_unsupported'],
    ['blocked_unavailable', 'codex_unavailable'],
    ['failed', 'clarification_timeout'], ['failed', 'clarification_cancelled'],
    ['failed_after_side_effects', 'clarification_timeout'], ['failed_after_side_effects', 'clarification_cancelled'],
    ['failed_after_side_effects', 'codex_unavailable'], ['failed_after_side_effects', 'auth_required'],
  ];
  for (const [o, r] of ok) assert.equal(fin(o, r).ok, true, `${o}/${String(r)}`);
  const bad: [string, unknown, string][] = [
    ['blocked_auth', 'codex_unavailable', 'codex_unavailable never with blocked_auth'],
    ['blocked_unavailable', 'auth_required', 'blocked_unavailable only with codex_unavailable'],
    ['blocked_unavailable', undefined, 'blocked_unavailable needs its reason'],
    ['blocked_auth', undefined, 'blocked_auth needs an auth reason'],
    ['blocked_auth', 'clarification_timeout', 'clarification reasons only with failed outcomes'],
    ['succeeded', 'clarification_cancelled', 'no reason on success'],
    ['failed', 'CodexUnavailable', 'not an approved value'],
    ['failed', 42, 'not a string'],
  ];
  for (const [o, r, why] of bad) assert.equal(fin(o, r).ok, false, why);
});

test('E01 2026-10-19: confirmed defaults (5 s auth read, 30 s clarification, 3 rounds)', async () => {
  const { DEFAULT_CONFIG } = await import('../src/coordinator.js');
  assert.equal(DEFAULT_CONFIG.authReadTimeoutMs, 5_000);
  assert.equal(DEFAULT_CONFIG.clarificationTimeoutMs, 30_000);
  assert.equal(DEFAULT_CONFIG.maxClarificationTurns, 3);
});

test('CONTRACTS §2.1/§3 (E01 2026-10-19): any reason from the shared set is accepted with failed_after_side_effects; anything outside the set is rejected for every outcome', async () => {
  const { TASK_FINISH_REASONS, TASK_OUTCOMES } = await import('../src/contracts.js');
  const fin = (outcome: string, reason: unknown) =>
    validateEvent({ schema: 'dottie.event', version: 2, type: 'TaskFinished', eventId: 'e', correlationId: 'c', timestamp: '2026-10-19T00:00:00Z', payload: { taskId: 't', outcome, verified: false, summary: 's', reason } });
  assert.deepEqual([...TASK_FINISH_REASONS].sort(), ['account_unsupported', 'approval_unavailable', 'auth_required', 'clarification_cancelled', 'clarification_timeout', 'codex_unavailable', 'retry_not_allowed', 'sign_in_in_progress']);
  // E01 §5 (c): retry_not_allowed means no task started, so it never pairs with failed_after_side_effects.
  for (const r of TASK_FINISH_REASONS) assert.equal(fin('failed_after_side_effects', r).ok, r !== 'retry_not_allowed', r);
  const outside = ['bogus', 'AUTH_REQUIRED', 'authRequired', 'auth-required', '', ' auth_required', 'timeout', null, 7, {}, ['auth_required']];
  for (const outcome of TASK_OUTCOMES) {
    for (const r of outside) {
      const v = fin(outcome, r);
      assert.equal(v.ok, false, `${outcome} + ${JSON.stringify(r)}`);
      if (!v.ok) assert.ok(v.errors.some(e => e.includes('reason')), `${outcome}: error names the reason field`);
    }
  }
});

test('CONTRACTS §3 TaskFinished (E01 2026-10-19): declined carries no reason or approval_unavailable only; approval_unavailable fits only declined (and failed_after_side_effects)', async () => {
  const { TASK_FINISH_REASONS, TASK_OUTCOMES } = await import('../src/contracts.js');
  const fin = (outcome: string, reason?: string) =>
    validateEvent({ schema: 'dottie.event', version: 2, type: 'TaskFinished', eventId: 'e', correlationId: 'c', timestamp: '2026-10-19T00:00:00Z', payload: { taskId: 't', outcome, verified: false, summary: 's', ...(reason !== undefined ? { reason } : {}) } });
  assert.equal(fin('declined').ok, true, 'declined by the user: no reason');
  assert.equal(fin('declined', 'approval_unavailable').ok, true);
  for (const r of TASK_FINISH_REASONS) if (r !== 'approval_unavailable') assert.equal(fin('declined', r).ok, false, `declined + ${r}`);
  for (const o of TASK_OUTCOMES) if (o !== 'declined' && o !== 'failed_after_side_effects') assert.equal(fin(o, 'approval_unavailable').ok, false, `${o} + approval_unavailable`);
});

test('CONTRACTS §3 ApprovalRequested.category: exactly the 11 CONTRACTS values in order; navigate accepted, unknown rejected', async () => {
  const { APPROVAL_CATEGORIES } = await import('../src/contracts.js');
  assert.deepEqual([...APPROVAL_CATEGORIES], ['read', 'navigate', 'local_change', 'delete', 'overwrite', 'external_send', 'external_upload', 'purchase', 'install_or_elevate', 'security_setting', 'credential_access']);
  const req = (category: unknown) => validateEvent({ schema: 'dottie.event', version: 2, type: 'ApprovalRequested', eventId: 'e', correlationId: 'c', taskId: 't', timestamp: '2026-10-19T00:00:00Z', payload: { taskId: 't', actionId: hexId('nav'), summary: 'Open Downloads', risk: 'low', expiry: '2026-10-19T00:01:00Z', category, ...codexDisp(category) } });
  assert.equal(req('navigate').ok, true, 'navigate accepted');
  for (const bad of ['browse', 'Navigate', 'files.navigate', 'navigation', '', null]) assert.equal(req(bad).ok, false, JSON.stringify(bad));
});
