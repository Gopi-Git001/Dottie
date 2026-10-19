/**
 * E01 ruling 2g.1 (dottie-e01 499e61c): the desktop port delivers cancellation through its own
 * `onTaskCancelled(listener)` (returns an unsubscribe), separate from `onTaskFinished`, with no union: a cancel is
 * never read as a finish. The coordinator clears its active task before it notifies listeners or emits the event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../src/contracts.js';
import type { CoordinatorSnapshot } from '../src/coordinator.js';
import type { PolicyPort } from '../src/ports.js';
import { allowAllChannels, approval, envelope, fixture, flush, type Fixture } from './helpers.js';

const confirm: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log', risk: 'high', category: 'delete' }) };

function listen(f: Fixture) {
  const finished: { e: EventEnvelope<'TaskFinished'>; s: CoordinatorSnapshot; sinkCount: number }[] = [];
  const cancelled: { e: EventEnvelope<'TaskCancelled'>; s: CoordinatorSnapshot; sinkCount: number }[] = [];
  f.c.onTaskFinished(e => finished.push({ e, s: f.c.getState(), sinkCount: f.sink.of('TaskFinished').length }));
  f.c.onTaskCancelled(e => cancelled.push({ e, s: f.c.getState(), sinkCount: f.sink.of('TaskCancelled').length }));
  return { finished, cancelled };
}
async function runCancelled(f: Fixture, text = 'send the report to Sam'): Promise<string> {
  f.codex.scripts.push(async ({ aborted }) => { await aborted; return { status: 'aborted' }; });
  const taskId = (f.say(text, `req_2g1_c_${Math.random()}`) as { taskId: string }).taskId;
  await flush();
  assert.equal(f.c.getState().activeTaskId, taskId);
  f.c.cancelTask();
  await f.drain();
  return taskId;
}
async function runFinished(f: Fixture): Promise<string> {
  const taskId = (f.say('delete old.log', `req_2g1_f_${Math.random()}`) as { taskId: string }).taskId;
  await flush();
  f.c.resolveApproval(approval(f.sink.of('ApprovalRequested').at(-1)!.payload.actionId, false, f), 'secure_ui');
  await f.drain();
  return taskId;
}

test('2g.1: a TaskCancelled reaches onTaskCancelled exactly once (the emitted envelope) and never onTaskFinished; activeTaskId is already null inside the listener', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const l = listen(f);
  const taskId = await runCancelled(f);
  assert.equal(f.sink.of('TaskCancelled').length, 1);
  assert.equal(l.cancelled.length, 1, 'exactly once');
  assert.equal(l.finished.length, 0, 'never onTaskFinished');
  const got = l.cancelled[0]!;
  assert.equal(got.e, f.sink.of('TaskCancelled')[0], 'the same envelope the EventSink got');
  assert.equal(got.e.taskId, taskId);
  assert.deepEqual([got.s.activeTaskId, got.s.taskActive], [null, false], 'cleared before listeners hear the cancel');
  assert.equal(got.sinkCount, 1, 'delivered after the EventSink emit');
});

test('2g.1: a cancel while a pre-dispatch approval is pending also reaches only onTaskCancelled, once, with activeTaskId null', async () => {
  const f = await fixture({ policy: confirm });
  const l = listen(f);
  f.say('delete old.log', 'req_2g1_cc');
  await flush();
  assert.notEqual(f.c.getState().activeTaskId, null);
  f.c.cancelTask();
  await f.drain();
  assert.deepEqual([l.cancelled.length, l.finished.length], [1, 0]);
  assert.equal(l.cancelled[0]!.s.activeTaskId, null);
});

test('2g.1: a TaskFinished reaches onTaskFinished exactly once and never onTaskCancelled; activeTaskId is already null inside the listener', async () => {
  const f = await fixture({ policy: confirm });
  const l = listen(f);
  const taskId = await runFinished(f);
  assert.equal(f.sink.of('TaskFinished').length, 1);
  assert.equal(l.finished.length, 1, 'exactly once');
  assert.equal(l.cancelled.length, 0, 'never onTaskCancelled');
  assert.equal(l.finished[0]!.e, f.sink.of('TaskFinished')[0]);
  assert.equal(l.finished[0]!.e.taskId, taskId);
  assert.deepEqual([l.finished[0]!.s.activeTaskId, l.finished[0]!.s.taskActive], [null, false]);
});

test('2g.1: shutdown with a running and a queued task: two TaskCancelled, each delivered once to onTaskCancelled only', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const l = listen(f);
  f.codex.scripts.push(async ({ aborted }) => { await aborted; return { status: 'aborted' }; });
  f.say('first task', 'req_2g1_a');
  await flush();
  assert.equal(f.c.submitUtterance(envelope('UtteranceReady', { requestId: 'req_2g1_b', text: 'second task', locale: 'en-US', endReason: 'vad_silence' })).kind, 'queued');
  await f.c.shutdown();
  assert.equal(f.sink.of('TaskCancelled').length, 2);
  assert.deepEqual(l.cancelled.map(x => x.e), f.sink.of('TaskCancelled'));
  assert.equal(l.finished.length, 0);
});

test('2g.1: unsubscribe works for both; a throwing listener is logged and isolated (others still hear it, the task still ends)', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const okC: string[] = [], okF: string[] = [];
  const offBoomC = f.c.onTaskCancelled(() => { throw new Error('boom cancelled'); });
  const offC = f.c.onTaskCancelled(e => okC.push(e.taskId!));
  const offBoomF = f.c.onTaskFinished(() => { throw new Error('boom finished'); });
  const offF = f.c.onTaskFinished(e => okF.push(e.taskId!));
  await runCancelled(f);
  assert.equal(okC.length, 1, 'the other cancel listener still heard it');
  assert.ok(f.log.find('coordinator.task_listener.failed').some(r => JSON.stringify(r).includes('TaskCancelled')));
  assert.deepEqual(f.c.getState(), { state: 'STANDBY', taskActive: false, activeTaskId: null }, 'the coordinator carried on');

  const g = await fixture({ policy: confirm });
  const gF: string[] = [];
  g.c.onTaskFinished(() => { throw new Error('boom'); });
  g.c.onTaskFinished(e => gF.push(e.taskId!));
  await runFinished(g);
  assert.equal(gF.length, 1);
  assert.ok(g.log.find('coordinator.task_listener.failed').some(r => JSON.stringify(r).includes('TaskFinished')));

  offBoomC(); offC(); offBoomF(); offF();
  const before = f.log.find('coordinator.task_listener.failed').length;
  await runCancelled(f, 'send the notes to Ana');
  f.codex.scripts.push(async () => ({ status: 'completed', summary: 'done' }));
  f.say('what time is it', 'req_2g1_after');
  await f.drain();
  assert.ok(f.sink.of('TaskFinished').length >= 1, 'a TaskFinished happened after unsubscribing');
  assert.deepEqual([okC.length, okF.length], [1, 0], 'unsubscribed listeners hear nothing more');
  assert.equal(f.log.find('coordinator.task_listener.failed').length, before, 'unsubscribed throwing listeners are not called');
});
