import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelReport, decideStopStatus, isCleanStop } from '../src/cancellation.js';
import { STOP_STATUSES, SIDE_EFFECT_SUMMARIES } from '../src/contracts.js';
import type { VerifierPort } from '../src/ports.js';
import { obs, fixture, flush, untilAborted, utterance, hexId, fileParams } from './helpers.js';

// The only two "clean" phrasings, plus any undo claim. "I have not undone anything" is the required honest form.
const CLEAN_CLAIM = /before it changed anything|didn't start that task|stopped cleanly|cancelled cleanly|(was|were|been) undone|\bundid\b|reverted/i;

test('report text never claims a clean stop when side effects exist (all combinations)', () => {
  const actions = [{ toolId: 'mail.send', observedState: obs('sent to bob'), certainty: 'committed' as const }];
  for (const status of STOP_STATUSES) for (const se of SIDE_EFFECT_SUMMARIES) {
    const text = cancelReport(status, se, se === 'none' ? [] : actions.map(a => ({ ...a, certainty: se === 'committed' ? 'committed' as const : 'possible' as const })));
    if (se !== 'none') {
      assert.doesNotMatch(text, CLEAN_CLAIM, `${status}/${se}: ${text}`);
      assert.match(text, /mail\.send/);
      assert.match(text, /not undone anything/);
      assert.equal(isCleanStop(status, se), false);
    }
  }
  assert.equal(decideStopStatus({ dispatched: true, ack: { stopped: true }, completedBeforeStop: false, sideEffects: 'committed', toolsInFlight: false }), 'stopped_after_side_effects');
  assert.equal(decideStopStatus({ dispatched: true, ack: { stopped: true }, completedBeforeStop: false, sideEffects: 'possible', toolsInFlight: false }), 'stopped_after_side_effects');
  assert.equal(decideStopStatus({ dispatched: true, ack: undefined, completedBeforeStop: false, sideEffects: 'none', toolsInFlight: false }), 'stop_unconfirmed');
  assert.equal(decideStopStatus({ dispatched: true, ack: { stopped: false }, completedBeforeStop: false, sideEffects: 'none', toolsInFlight: false }), 'stop_unconfirmed');
});

test('cancel before any side effect: clean stop, propagated to Codex, reported as clean', async () => {
  const f = await fixture();
  f.codex.scripts.push(untilAborted);
  f.say('search the web for flights');
  await flush();
  assert.equal(f.c.cancelTask().kind, 'cancelling');
  assert.equal(f.c.cancelTask().kind, 'already_cancelling');
  await f.drain();
  assert.equal(f.codex.cancels.length, 1);
  const p = f.sink.of('TaskCancelled')[0]!.payload;
  assert.equal(p.stopStatus, 'stopped_no_side_effects');
  assert.equal(p.sideEffects, 'none');
  assert.equal(p.sideEffectsCommitted, false);
  assert.equal(f.speech.spoken.at(-1)!.text, p.report);
  assert.equal(f.sink.of('TaskFinished').length, 0);
  assert.deepEqual(f.c.transitions.filter(t => t.accepted).map(t => t.to).slice(-4), ['EXECUTING', 'CANCELLING', 'SPEAKING', 'STANDBY']);
});

test('cancel AFTER an external side effect is never reported as clean', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    hooks.toolStarted({ toolId: 'mail.send', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'mail.send', observedState: obs('message sent to bob@example.com', 'committed', true), verified: true, sideEffect: 'committed' });
    hooks.toolStarted({ toolId: 'files.read', mayHaveSideEffects: false });
    await aborted;
    return { status: 'aborted' };
  });
  f.say('email bob the report then summarise it');
  await flush();
  f.c.cancelTask();
  await f.drain();
  const p = f.sink.of('TaskCancelled')[0]!.payload;
  assert.equal(p.stopStatus, 'stopped_after_side_effects');
  assert.equal(p.sideEffects, 'committed');
  assert.equal(p.sideEffectsCommitted, true);
  assert.deepEqual(p.committedActions, [{ toolId: 'mail.send', observedState: obs('message sent to bob@example.com', 'committed', true), certainty: 'committed' }]);
  assert.doesNotMatch(p.report, CLEAN_CLAIM);
  assert.match(p.report, /not a clean stop/);
  const spoken = f.speech.spoken.at(-1)!;
  assert.equal(spoken.kind, 'cancel_report');
  assert.equal(spoken.text, p.report, 'spoken text reflects side effects');
  assert.ok(f.log.find('coordinator.task.cancelled').some(l => l.level === 'warn'));
});

test('cancel while a side-effecting tool is still in flight reports "possible", not clean and not committed', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    hooks.toolStarted({ toolId: 'shell.run', mayHaveSideEffects: true });
    await aborted;
    return { status: 'aborted' };
  });
  f.say('run the cleanup script');
  await flush();
  f.c.cancelTask();
  await f.drain();
  const p = f.sink.of('TaskCancelled')[0]!.payload;
  assert.equal(p.sideEffects, 'possible');
  assert.equal(p.sideEffectsCommitted, false);
  assert.equal(p.stopStatus, 'stopped_after_side_effects');
  assert.match(p.report, /can't confirm whether these took effect: shell\.run/);
});

test('unacknowledged cancel reports stop_unconfirmed; later side effects are surfaced, not swallowed', async () => {
  const f = await fixture({ config: { cancelAckTimeoutMs: 2_000 } });
  f.codex.cancelAck = 'never';
  let late!: () => void;
  f.codex.scripts.push(({ hooks }) => new Promise(resolve => {
    late = () => {
      hooks.toolResult({ toolId: 'files.delete', observedState: obs('deleted tmp.txt', 'committed', true), verified: true, sideEffect: 'committed' });
      resolve({ status: 'completed', summary: 'Deleted.' });
    };
  }));
  f.say('delete tmp.txt');
  await flush();
  f.c.cancelTask();
  await flush();
  assert.equal(f.c.state, 'CANCELLING');
  await f.clock.advance(2_000);
  const p = f.sink.of('TaskCancelled')[0]!.payload;
  assert.equal(p.stopStatus, 'stop_unconfirmed');
  assert.match(p.report, /couldn't confirm that it stopped/);
  late();
  await f.drain();
  const warn = f.sink.of('TaskProgress').filter(e => e.payload.redactedMetadata['lateAfterStop'] === true);
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!.payload.toolId, 'files.delete');
  assert.equal(f.log.find('coordinator.side_effect_after_cancel')[0]!.level, 'error');
  assert.equal(f.sink.of('TaskFinished').length, 0, 'not re-reported as finished');
});

test('cancel during VERIFYING reports that the task had already completed', async () => {
  let release!: () => void;
  const verifier: VerifierPort = { verify: (_i, signal) => new Promise(r => { release = () => r({ outcome: 'verified', verified: true, observedState: obs('ok') }); signal.addEventListener('abort', () => r({ outcome: 'unverified', verified: false, observedState: obs('aborted', 'none', false) })); }) };
  const f = await fixture({ verifier });
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'explorer.navigate', observedState: obs('Downloads open', 'committed', true), verified: true, sideEffect: 'committed' });
    return { status: 'completed', summary: 'Downloads is open.' };
  });
  f.say('open downloads');
  await flush();
  assert.equal(f.c.state, 'VERIFYING');
  f.c.cancelTask();
  await f.drain();
  void release;
  const p = f.sink.of('TaskCancelled')[0]!.payload;
  assert.equal(p.stopStatus, 'completed_before_stop');
  assert.equal(p.sideEffectsCommitted, true);
  assert.match(p.report, /already finished before I could stop it/);
});

test('cancel while an approval is pending denies the action and stops cleanly', async () => {
  const f = await fixture();
  const decisions: string[] = [];
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    const d = await hooks.requestApproval({ actionId: hexId('buy'), summary: 'Buy headphones', risk: 'critical', category: 'purchase', display: fileParams() });
    decisions.push(d.reason);
    await aborted;
    return { status: 'aborted' };
  });
  f.say('buy the headphones');
  await flush();
  assert.equal(f.c.state, 'PERMISSION_REQUIRED');
  f.c.cancelTask();
  await f.drain();
  assert.deepEqual(decisions, ['cancelled']);
  assert.equal(f.sink.of('ApprovalResolved')[0]!.payload.approved, false);
  assert.equal(f.sink.of('TaskCancelled')[0]!.payload.stopStatus, 'stopped_no_side_effects');
});

test('cancel during backoff (RECOVERING) stops without another attempt', async () => {
  const f = await fixture();
  f.codex.defaultScript = async () => ({ status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'offline' } });
  f.say('open downloads');
  await flush();
  assert.equal(f.c.state, 'RECOVERING');
  f.c.cancelTask();
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.sink.of('TaskCancelled')[0]!.payload.stopStatus, 'stopped_no_side_effects');
});

// ------------------------------------------------------------------------------------------- distinct intents
test('stop speaking during execution halts TTS only; the task keeps running and finishes', async () => {
  const f = await fixture();
  f.speech.manual = true;
  let release!: () => void;
  f.codex.scripts.push(async ({ hooks }) => {
    await new Promise<void>(r => (release = r));
    hooks.toolResult({ toolId: 'explorer.navigate', observedState: obs('Downloads open', 'committed', true), verified: true, sideEffect: 'committed' });
    return { status: 'completed', summary: 'Downloads is open.' };
  });
  f.say('open downloads');
  await flush();
  assert.equal(f.speech.playing, 1, '"On it." playing');
  const r = f.c.stopSpeaking();
  assert.deepEqual(r, { wasSpeaking: true, taskStillRunning: true });
  assert.equal(f.speech.playing, 0);
  assert.equal(f.c.state, 'EXECUTING');
  assert.equal(f.codex.cancels.length, 0, 'Codex not cancelled');
  release();
  await flush();
  assert.equal(f.c.state, 'SPEAKING');
  f.speech.completeAll();
  await f.drain();
  assert.equal(f.sink.of('TaskCancelled').length, 0);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'succeeded');
});

test('stop speaking during the result response returns to standby without any cancel event', async () => {
  const f = await fixture();
  f.speech.manual = true;
  f.say('what time is it');
  await flush();
  assert.equal(f.c.state, 'SPEAKING');
  assert.deepEqual(f.c.stopSpeaking(), { wasSpeaking: true, taskStillRunning: false });
  await f.drain();
  assert.equal(f.c.state, 'STANDBY');
  assert.equal(f.sink.of('TaskCancelled').length, 0);
  assert.equal(f.sink.of('TaskFinished').length, 1);
  assert.equal(f.c.cancelTask().kind, 'no_active_task', '"stop the task" after it finished does not fake a cancel');
});

test('new task during execution (queue policy): queued, not merged, runs after the first; overflow rejected', async () => {
  const f = await fixture();
  let release!: () => void;
  f.codex.scripts.push(async () => { await new Promise<void>(r => (release = r)); return { status: 'completed', summary: 'First done.' }; });
  const a = f.say('first task');
  await flush();
  const b = f.c.submitUtterance(utterance('second task', 'req_second'));
  assert.equal(b.kind, 'queued');
  assert.deepEqual(f.c.submitUtterance(utterance('third task', 'req_third')), { kind: 'rejected', reason: 'queue_full' });
  assert.equal(f.c.state, 'EXECUTING');
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.codex.cancels.length, 0, 'queue policy never cancels the running task');
  release();
  await f.drain();
  assert.equal(f.codex.runs.length, 2);
  assert.deepEqual(f.codex.runs.map(r => r.text), ['first task', 'second task']);
  assert.deepEqual(f.sink.of('TaskFinished').map(e => e.payload.taskId), [a.kind === 'started' ? a.taskId : '', b.kind === 'queued' ? b.taskId : '']);
  assert.equal(f.c.state, 'STANDBY');
});

test('new task during execution (cancel_then_start policy): first is cancelled honestly, then second runs', async () => {
  const f = await fixture({ config: { newTaskPolicy: 'cancel_then_start' } });
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    hooks.toolResult({ toolId: 'app.launch', observedState: obs('Word opened', 'committed', true), verified: true, sideEffect: 'committed' });
    await aborted;
    return { status: 'aborted' };
  });
  f.say('open word and write a letter');
  await flush();
  assert.equal(f.c.submitUtterance(utterance('actually open excel', 'req_x')).kind, 'queued');
  await f.drain();
  const cancelled = f.sink.of('TaskCancelled')[0]!.payload;
  assert.equal(cancelled.stopStatus, 'stopped_after_side_effects');
  assert.equal(cancelled.sideEffectsCommitted, true);
  assert.deepEqual(f.codex.runs.map(r => r.text), ['open word and write a letter', 'actually open excel']);
  assert.equal(f.sink.of('TaskFinished').length, 1);
  assert.equal(f.c.state, 'STANDBY');
});

test('shutdown during execution cancels first, records the stop, then reaches SHUTDOWN', async () => {
  const f = await fixture();
  f.codex.scripts.push(untilAborted);
  f.say('long task');
  await flush();
  await f.c.shutdown();
  assert.equal(f.c.state, 'SHUTDOWN');
  assert.equal(f.codex.cancels.length, 1);
  assert.equal(f.sink.of('TaskCancelled').length, 1);
  assert.equal(f.speech.spoken.filter(s => s.kind === 'cancel_report').length, 0, 'no speech while quitting');
  assert.equal(f.c.handleWake({ ...(await import('./helpers.js')).wake() }).ok, false, 'terminal');
});
