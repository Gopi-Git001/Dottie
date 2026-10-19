/**
 * E01 ruling 2g (dottie-e01 90ceed5, CONTRACTS §3 ApprovalResolved row + changelog): the desktop's CoordinatorPort
 * snapshot carries `activeTaskId: string | null`, the coordinator's single active task (ADR-0010). The desktop drops
 * any ApprovalRequested whose taskId isn't the active task (ruling 2e), so the id must be set when the task starts
 * (before any TaskProgress) and cleared to null when that task's TaskFinished or TaskCancelled is emitted, never later.
 * Snapshot shape and member names follow E06's port (dottie feature/E06-runtime-status 7f022d2, services/types.ts):
 * `getState(): CoordinatorSnapshot` = `{state, taskActive, activeTaskId}` and `onStateChange(listener)`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinatorSnapshot } from '../src/coordinator.js';
import type { AnyEvent } from '../src/contracts.js';
import type { PolicyPort } from '../src/ports.js';
import { allowAllChannels, approval, envelope, fixture, flush, Sink, type Fixture } from './helpers.js';

const confirm: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log', risk: 'high', category: 'delete' }) };

type Entry = { readonly at: 'snapshot'; readonly s: CoordinatorSnapshot } | { readonly at: 'event'; readonly e: AnyEvent; readonly s: CoordinatorSnapshot };
/** One timeline of snapshot notifications and emitted events, each event with getState() read inside the emit. */
function record(f: Fixture): Entry[] {
  const out: Entry[] = [];
  f.c.onStateChange(s => out.push({ at: 'snapshot', s }));
  f.sink.emit = (e: AnyEvent) => { out.push({ at: 'event', e, s: f.c.getState() }); Sink.prototype.emit.call(f.sink, e); };
  return out;
}
/** The last snapshot a caching listener holds right before entry i. */
const heldBefore = (t: Entry[], i: number): CoordinatorSnapshot | undefined => {
  for (let j = i - 1; j >= 0; j--) { const x = t[j]!; if (x.at === 'snapshot') return x.s; }
  return undefined;
};
const terminalIdx = (t: Entry[], type: 'TaskFinished' | 'TaskCancelled') => t.findIndex(x => x.at === 'event' && x.e.type === type);
function assertNoStaleAt(t: Entry[], i: number, label: string) {
  const ev = t[i] as Extract<Entry, { at: 'event' }>;
  assert.equal(ev.s.activeTaskId, null, `${label}: getState() inside the ${ev.e.type} emit is already null`);
  assert.equal(ev.s.taskActive, false, `${label}: taskActive false with it`);
  assert.equal(heldBefore(t, i)?.activeTaskId ?? null, null, `${label}: a snapshot listener already holds null when ${ev.e.type} arrives`);
}

test('2g: activeTaskId is null at boot and in STANDBY; the snapshot is {state, taskActive, activeTaskId}', async () => {
  const f = await fixture({ boot: false });
  const t = record(f);
  assert.deepEqual(f.c.getState(), { state: 'BOOTING', taskActive: false, activeTaskId: null });
  await f.c.boot();
  assert.deepEqual(f.c.getState(), { state: 'STANDBY', taskActive: false, activeTaskId: null });
  assert.deepEqual(t.at(-1), { at: 'snapshot', s: { state: 'STANDBY', taskActive: false, activeTaskId: null } }, 'listeners hear the boot transition');
});

test('2g: activeTaskId equals the task while its pre-dispatch approval is pending, set before any TaskProgress', async () => {
  const f = await fixture({ policy: confirm });
  const t = record(f);
  const r = f.say('delete old.log', 'req_2g_pending');
  assert.equal(r.kind, 'started');
  const taskId = (r as { taskId: string }).taskId;
  await flush();
  const req = f.sink.of('ApprovalRequested');
  assert.equal(req.length, 1);
  assert.equal(f.c.state, 'CONFIRMING');
  assert.deepEqual(f.c.getState(), { state: 'CONFIRMING', taskActive: true, activeTaskId: taskId });
  const first = t.findIndex(x => x.at === 'event' && x.e.taskId === taskId);
  assert.ok(first >= 0);
  assert.equal((t[first] as Extract<Entry, { at: 'event' }>).s.activeTaskId, taskId, 'already set at the first event of the task');
  assert.equal(heldBefore(t, first)?.activeTaskId, taskId, 'and listeners were told before it');
  const firstProgress = t.findIndex(x => x.at === 'event' && x.e.type === 'TaskProgress' && x.e.taskId === taskId);
  if (firstProgress >= 0) assert.ok(first <= firstProgress);
  const ar = t.findIndex(x => x.at === 'event' && x.e.type === 'ApprovalRequested');
  assert.equal(heldBefore(t, ar)?.activeTaskId, taskId, 'the desktop sees the dialog\'s task as active when ApprovalRequested arrives');
  f.c.resolveApproval(approval(req[0]!.payload.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('2g: null after TaskFinished; the snapshot is updated before the terminal event is emitted (no stale id)', async () => {
  const f = await fixture({ policy: confirm });
  const t = record(f);
  f.say('delete old.log', 'req_2g_fin');
  await flush();
  f.c.resolveApproval(approval(f.sink.of('ApprovalRequested')[0]!.payload.actionId, false, f), 'secure_ui');
  await f.drain();
  assert.equal(f.sink.of('TaskFinished').length, 1);
  assertNoStaleAt(t, terminalIdx(t, 'TaskFinished'), 'declined');
  assert.deepEqual(f.c.getState(), { state: 'STANDBY', taskActive: false, activeTaskId: null });
});

test('2g: null after TaskCancelled; updated before it is emitted; TaskCancelled is emitted exactly once', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const t = record(f);
  f.codex.scripts.push(async ({ aborted }) => { await aborted; return { status: 'aborted' }; });
  const r = f.say('send the report to Sam', 'req_2g_cancel');
  const taskId = (r as { taskId: string }).taskId;
  await flush();
  assert.equal(f.c.getState().activeTaskId, taskId);
  assert.equal(f.c.cancelTask().kind, 'cancelling');
  assert.equal(f.c.getState().activeTaskId, taskId, 'still active while CANCELLING (no terminal event yet)');
  await f.drain();
  const cancelled = f.sink.of('TaskCancelled');
  assert.equal(cancelled.length, 1, 'exactly one TaskCancelled');
  assert.equal(cancelled[0]!.taskId, taskId);
  assert.equal(f.sink.of('TaskFinished').length, 0);
  assertNoStaleAt(t, terminalIdx(t, 'TaskCancelled'), 'cancelled');
  assert.equal(f.c.getState().activeTaskId, null);
});

test('2g: a cancel during the pending pre-dispatch approval also ends null before TaskCancelled', async () => {
  const f = await fixture({ policy: confirm });
  const t = record(f);
  f.say('delete old.log', 'req_2g_cancel_confirm');
  await flush();
  assert.notEqual(f.c.getState().activeTaskId, null);
  f.c.cancelTask();
  await f.drain();
  assert.equal(f.sink.of('TaskCancelled').length, 1);
  assertNoStaleAt(t, terminalIdx(t, 'TaskCancelled'), 'cancel while confirming');
  assert.equal(f.c.getState().activeTaskId, null);
});

test('2g: a refused retry (fresh taskId, immediate TaskFinished retry_not_allowed) ends null, never stale', async () => {
  const f = await fixture({ policy: allowAllChannels });
  f.codex.scripts.push(async ({ aborted }) => { await aborted; return { status: 'aborted' }; });
  const prior = (f.say('send the report to Sam', 'req_2g_prior') as { taskId: string }).taskId;
  await flush();
  f.c.cancelTask();
  await f.drain();
  const t = record(f);
  f.c.handleWake(envelope('WakeDetected', { timestamp: '2026-10-18T13:00:00.000Z', deviceId: 'mic-1', confidence: 0.9 }));
  f.c.handleListeningStarted();
  f.c.handleCaptureEnded();
  const r = f.c.submitUtterance(envelope('UtteranceReady', { requestId: 'req_2g_retry', text: 'try again', locale: 'en-US', endReason: 'vad_silence', retryOfTaskId: prior }));
  const fresh = (r as { taskId: string }).taskId;
  assert.notEqual(fresh, prior);
  await f.drain();
  const fin = f.sink.of('TaskFinished').at(-1)!;
  assert.deepEqual([fin.taskId, fin.payload.reason], [fresh, 'retry_not_allowed']);
  assertNoStaleAt(t, terminalIdx(t, 'TaskFinished'), 'refused retry');
  assert.deepEqual(f.c.getState(), { state: 'STANDBY', taskActive: false, activeTaskId: null });
});

test('2g: a terminal event for a queued task never clears the running task; the next task becomes active only after the first ends', async () => {
  const f = await fixture({ policy: allowAllChannels, config: { maxQueued: 2 } });
  const t = record(f);
  f.codex.scripts.push(async ({ aborted }) => { await aborted; return { status: 'aborted' }; });
  const a = (f.say('first task', 'req_2g_a') as { taskId: string }).taskId;
  await flush();
  const qb = f.c.submitUtterance(envelope('UtteranceReady', { requestId: 'req_2g_b', text: 'second task', locale: 'en-US', endReason: 'vad_silence' }));
  assert.equal(qb.kind, 'queued');
  assert.equal(f.c.getState().activeTaskId, a, 'a queued task is not the active task');
  await f.c.shutdown();
  const cancelled = f.sink.of('TaskCancelled').map(e => e.taskId);
  assert.deepEqual([...cancelled].sort(), [a, (qb as { taskId: string }).taskId].sort());
  const qIdx = t.findIndex(x => x.at === 'event' && x.e.type === 'TaskCancelled' && x.e.taskId !== a);
  assert.equal((t[qIdx] as Extract<Entry, { at: 'event' }>).s.activeTaskId, a, 'the queued task\'s TaskCancelled leaves the running task active');
  const aIdx = t.findIndex(x => x.at === 'event' && x.e.type === 'TaskCancelled' && x.e.taskId === a);
  assertNoStaleAt(t, aIdx, 'running task on shutdown');
});

test('2g: onStateChange returns an unsubscribe; a throwing listener is logged and does not break the coordinator or other listeners', async () => {
  const f = await fixture({ policy: confirm });
  const seen: (string | null)[] = [];
  const off = f.c.onStateChange(() => { throw new Error('listener boom'); });
  const off2 = f.c.onStateChange(s => seen.push(s.activeTaskId));
  f.say('delete old.log', 'req_2g_listener');
  await flush();
  assert.equal(f.sink.of('ApprovalRequested').length, 1);
  assert.ok(seen.some(x => x !== null));
  assert.ok(f.log.find('coordinator.snapshot.listener_failed').length >= 1);
  off(); off2();
  const n = seen.length;
  f.c.cancelTask();
  await f.drain();
  assert.equal(seen.length, n, 'unsubscribed');
  assert.equal(f.sink.of('TaskCancelled').length, 1);
});
