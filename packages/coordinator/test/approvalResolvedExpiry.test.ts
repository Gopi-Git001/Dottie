/**
 * E01 rulings 1m/1n (CONTRACTS 7994303/0d53abc §3 ApprovalResolved; DOT-060 acceptance 9 and 10):
 * - ApprovalResolved gains decision?: 'expired' (coordinator → desktop only, approved:false) and reason?: 'display_unavailable'
 *   (desktop → coordinator, approved:false, no decision). validateEvent rejects expired+approved:true, reason+approved:true,
 *   decision+reason.
 * - On the C-08 timeout the coordinator emits ApprovalResolved{approved:false, decision:'expired'}, once per request.
 * - The desktop never sends expiry: an inbound decision:'expired' is rejected and changes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, POSSIBLE_REPEAT_SIDE_EFFECTS } from '../src/contracts.js';
import type { CodexApprovalRequest, PolicyPort } from '../src/ports.js';
import { allowAllChannels, approval, envelope, fixture, flush, hexId, obs, fileParams } from './helpers.js';

const confirm: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log', risk: 'high', category: 'delete' }) };
const del = (label: string): CodexApprovalRequest => ({ actionId: hexId(label), summary: 'Delete old.log', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() });
const resolved = (p: Record<string, unknown>) => validateEvent({ ...envelope('ApprovalResolved', { actionId: hexId('v'), approved: false, timestamp: '2026-10-19T00:00:00Z' }), payload: { actionId: hexId('v'), timestamp: '2026-10-19T00:00:00Z', ...p } as never, taskId: 't' });

test('DOT-060 AC 9 (E01 1m): POSSIBLE_REPEAT_SIDE_EFFECTS includes committed, and a committed prior ledger yields priorSideEffect committed', async () => {
  assert.deepEqual([...POSSIBLE_REPEAT_SIDE_EFFECTS].sort(), ['committed', 'possible', 'unknown']);
  const f = await fixture({ policy: allowAllChannels });
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'files.delete', observedState: obs('deleted', 'committed'), verified: true, sideEffect: 'committed' });
    return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
  });
  const p = f.say('delete old.log', 'req_ac9');
  await f.drain();
  const prior = (p as { taskId: string }).taskId;
  f.c.handleWake(envelope('WakeDetected', { timestamp: '2026-10-18T13:00:00.000Z', deviceId: 'mic-1', confidence: 0.9 }));
  f.c.handleListeningStarted();
  f.c.handleCaptureEnded();
  f.c.submitUtterance(envelope('UtteranceReady', { requestId: 'req_ac9_retry', text: 'Retry the last task.', locale: 'en-US', endReason: 'tray', retryOfTaskId: prior }));
  await flush();
  const req = f.sink.of('ApprovalRequested').at(-1)!;
  assert.deepEqual(req.payload.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'committed' });
  assert.ok(validateEvent(req).ok);
  f.c.resolveApproval(approval(req.payload.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('DOT-060 AC 10 (E01 1m): the C-08 timeout emits ApprovalResolved{approved:false, decision:expired} exactly once per request, before TaskFinished (fake clock)', async () => {
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_ac10');
  await flush();
  const req = f.sink.of('ApprovalRequested')[0]!;
  await f.clock.advance(59_999);
  await flush();
  assert.equal(f.sink.of('ApprovalResolved').length, 0, 'not before the expiry');
  await f.clock.advance(1);
  await f.drain();
  const out = f.sink.of('ApprovalResolved');
  assert.equal(out.length, 1);
  assert.deepEqual({ ...out[0]!.payload, timestamp: 'x' }, { actionId: req.payload.actionId, approved: false, decision: 'expired', timestamp: 'x' });
  assert.equal(out[0]!.taskId, req.taskId);
  assert.ok(validateEvent(out[0]!).ok, JSON.stringify(validateEvent(out[0]!)));
  const types = f.sink.events.map(e => e.type);
  assert.ok(types.indexOf('ApprovalResolved') < types.indexOf('TaskFinished'));
  // a late approve after expiry has no effect
  assert.equal(f.c.resolveApproval(approval(req.payload.actionId, true, f), 'secure_ui').kind, 'rejected');
  await f.drain();
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.sink.of('ApprovalResolved').length, 1);
});

test('DOT-060 AC 10 (E01 1m): a joined request (declined, 1o c) never extends the FIRST expiry; one ApprovalResolved{decision:expired} for the one dialog', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const got: Array<[string, number]> = [];
  f.codex.scripts.push(async ({ hooks }) => {
    const a = hooks.requestApproval(del('j'));
    await f.clock.advance(20_000);
    const b = hooks.requestApproval(del('j'));
    const [da, db] = await Promise.all([a, b]);
    got.push([da.reason, f.clock.now()], [db.reason, f.clock.now()]);
    return { status: 'completed', summary: 'ok' };
  });
  f.say('delete old.log', 'req_ac10_join');
  await flush();
  await f.clock.advance(40_000);
  await f.drain();
  assert.deepEqual(got.map(g => g[0]), ['expired', 'duplicate_request'], 'first expires at the FIRST expiry; the join is declined (1o c)');
  assert.equal(f.sink.of('ApprovalRequested').length, 1);
  const out = f.sink.of('ApprovalResolved');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.payload.decision, 'expired');
});

test('E01 1m: a cancel-settled approval is announced without decision (only expiry carries decision:expired)', async () => {
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_cancel_ann');
  await flush();
  f.c.cancelTask();
  await f.drain();
  const out = f.sink.of('ApprovalResolved');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.payload.decision, undefined);
});

test('E01 1m: the desktop never sends expiry: an inbound ApprovalResolved with decision:expired is rejected and the dialog stays open', async () => {
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_desk_exp');
  await flush();
  const req = f.sink.of('ApprovalRequested')[0]!;
  const ev = approval(req.payload.actionId, false, f);
  const bad = { ...ev, payload: { ...ev.payload, decision: 'expired' as const } };
  assert.deepEqual(f.c.resolveApproval(bad, 'secure_ui'), { kind: 'rejected', reason: 'invalid_answer' });
  assert.equal(f.c.state, 'CONFIRMING');
  f.c.resolveApproval(approval(req.payload.actionId, true, f), 'secure_ui');
  await f.drain();
  assert.equal(f.codex.runs.length, 1, 'the real answer still works');
});

test('E01 1n: a desktop ApprovalResolved{approved:false, reason:display_unavailable} declines (fail closed)', async () => {
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_disp_un');
  await flush();
  const req = f.sink.of('ApprovalRequested')[0]!;
  const ev = approval(req.payload.actionId, false, f);
  const withReason = { ...ev, payload: { ...ev.payload, reason: 'display_unavailable' as const } };
  assert.ok(validateEvent(withReason).ok);
  assert.equal(f.c.resolveApproval(withReason, 'secure_ui').kind, 'accepted');
  await f.drain();
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'declined');
});

test('E01 1n: validateEvent on ApprovalResolved: decision only expired, reason only display_unavailable; rejects expired+approved:true, reason+approved:true, decision+reason', () => {
  assert.ok(resolved({ approved: false }).ok);
  assert.ok(resolved({ approved: true }).ok);
  assert.ok(resolved({ approved: false, decision: 'expired' }).ok);
  assert.ok(resolved({ approved: false, reason: 'display_unavailable' }).ok);
  assert.equal(resolved({ approved: true, decision: 'expired' }).ok, false);
  assert.equal(resolved({ approved: true, reason: 'display_unavailable' }).ok, false);
  assert.equal(resolved({ approved: false, decision: 'expired', reason: 'display_unavailable' }).ok, false);
  assert.equal(resolved({ approved: false, decision: 'denied' }).ok, false);
  assert.equal(resolved({ approved: false, reason: 'user_declined' }).ok, false);
});
