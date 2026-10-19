import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyPort, VerifierPort, VerificationResult } from '../src/ports.js';
import { obs, allowAllChannels, approval, fixture, flush, untilAborted, utterance, wake, hexId, fileParams } from './helpers.js';

const states = (f: { c: { transitions: readonly { to: string; accepted: boolean }[] } }) => f.c.transitions.filter(t => t.accepted).map(t => t.to);

test('happy path walks the spec state sequence and reports a verified outcome', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'explorer.navigate', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'explorer.navigate', observedState: obs('Explorer shows Downloads', 'committed', true), verified: true, sideEffect: 'committed' });
    return { status: 'completed', summary: 'Downloads is open.' };
  });
  assert.equal(f.say('open file explorer and go to downloads').kind, 'started');
  await f.drain();
  assert.deepEqual(states(f), ['STANDBY', 'WAKE_DETECTED', 'LISTENING', 'TRANSCRIBING', 'EXECUTING', 'VERIFYING', 'SPEAKING', 'STANDBY']);
  const fin = f.sink.of('TaskFinished');
  assert.equal(fin.length, 1);
  assert.equal(fin[0]!.payload.outcome, 'succeeded');
  assert.equal(fin[0]!.payload.verified, true);
  assert.deepEqual(f.speech.spoken.map(s => s.text), ['On it.', 'Downloads is open.']);
  assert.equal(f.c.rejectedTransitions, 0);
  assert.equal(f.codex.runs[0]!.idempotencyKey, f.codex.runs[0]!.taskId);
});

test('tool-reported success without verification is not reported as success', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'files.open', observedState: obs('process exited 0', 'committed', false), verified: false, sideEffect: 'committed' });
    return { status: 'completed', summary: 'Opened it.' };
  });
  f.say('open the report');
  await f.drain();
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.equal(fin.outcome, 'unverified');
  assert.match(f.speech.spoken.at(-1)!.text, /couldn't confirm/);
});

test('injected verifier decides the postcondition', async () => {
  let r: VerificationResult = { outcome: 'unverified', verified: false, observedState: obs('viewer shows a different file', 'none', false) };
  const verifier: VerifierPort = { verify: async () => r };
  const f = await fixture({ verifier });
  f.say('show the newest pdf');
  await f.drain();
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'unverified');
  r = { outcome: 'verified', verified: true, observedState: obs('viewer shows report.pdf') };
  await f.clock.advance(20_000);
  f.say('show the newest pdf again');
  await f.drain();
  assert.equal(f.sink.of('TaskFinished')[1]!.payload.outcome, 'succeeded');
});

test('invalid inputs are rejected and logged, never silently applied', async () => {
  const f = await fixture();
  assert.equal(f.c.submitUtterance(utterance('delete everything', 'r0')).kind, 'rejected', 'no utterance from STANDBY');
  assert.equal(f.c.handleCaptureEnded().ok, false, 'STANDBY -> TRANSCRIBING');
  assert.equal(f.c.state, 'STANDBY');
  f.codex.scripts.push(untilAborted);
  f.say('long task');
  await flush();
  assert.equal(f.c.state, 'EXECUTING');
  const r = f.c.handleWake(wake());
  assert.equal(r.ok, false, 'wake during EXECUTING');
  assert.equal(f.c.state, 'EXECUTING');
  assert.ok(f.c.rejectedTransitions >= 2);
  assert.ok(f.log.find('coordinator.transition.rejected').length >= 2);
  assert.ok(f.log.find('coordinator.utterance.rejected').length >= 1);
  f.c.cancelTask();
  await f.drain();
});

test('mute blocks wake; mute during a task is deferred and applied when the task ends', async () => {
  const f = await fixture();
  f.c.setMuted(true);
  assert.equal(f.c.state, 'MUTED');
  assert.equal(f.c.handleWake(wake()).ok, false);
  f.c.setMuted(false);
  assert.equal(f.c.state, 'STANDBY');
  let release!: () => void;
  f.codex.scripts.push(async () => { await new Promise<void>(r => (release = r)); return { status: 'completed', summary: 'ok' }; });
  f.say('task');
  await flush();
  assert.equal(f.c.setMuted(true), 'EXECUTING');
  release();
  await f.drain();
  assert.equal(f.c.state, 'MUTED');
  assert.equal(f.sink.of('TaskFinished').length, 1);
});

test('expired sign-in: wake still works, dispatch is blocked truthfully, reconnect returns to STANDBY', async () => {
  const f = await fixture({ auth: 'expired' });
  assert.equal(f.c.state, 'AUTH_REQUIRED');
  assert.equal(f.say('open downloads').kind, 'started');
  await f.drain();
  assert.equal(f.codex.runs.length, 0, 'no Codex call without sign-in');
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'blocked_auth');
  assert.match(f.speech.spoken.at(-1)!.text, /reconnect ChatGPT/);
  assert.equal(f.c.state, 'AUTH_REQUIRED');
  f.codex.auth = 'signed_in';
  f.c.handleAuthChanged('signed_in');
  assert.equal(f.c.state, 'STANDBY');
});

test('auth expiring mid-task goes to AUTH_REQUIRED and is not retried', async () => {
  const f = await fixture();
  f.codex.scripts.push(async () => ({ status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: 'token expired' } }));
  f.say('do something');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.ok(states(f).includes('AUTH_REQUIRED'));
  assert.equal(f.c.state, 'AUTH_REQUIRED');
});

// ------------------------------------------------------------------------------------------- retries
test('transient failures retry with exponential backoff, resume the same thread, then succeed', async () => {
  const f = await fixture();
  f.codex.scripts.push(
    async ({ hooks }) => { hooks.threadAssigned('thr_9'); return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'socket closed' } }; },
    async () => ({ status: 'failed', error: { kind: 'rate_limited', origin: 'turn_failed', message: '429' } }),
    async () => ({ status: 'completed', summary: 'Done.' }),
  );
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 3);
  assert.deepEqual(f.codex.runs.map(r => [r.attempt, r.resume, r.threadId]), [[1, false, undefined], [2, true, 'thr_9'], [3, true, 'thr_9']]);
  assert.deepEqual(new Set(f.codex.runs.map(r => r.idempotencyKey)).size, 1);
  assert.deepEqual(f.clock.sleeps.filter(ms => ms === 500 || ms === 1000), [500, 1000]);
  assert.equal(states(f).filter(s => s === 'RECOVERING').length, 2);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'answered');
});

test('retries are bounded by maxAttempts', async () => {
  const f = await fixture({ config: { retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250, jitterRatio: 0 } } });
  f.codex.defaultScript = async () => ({ status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'offline' } });
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 4);
  assert.deepEqual(f.clock.sleeps.filter(ms => ms <= 250), [100, 200, 250], 'capped exponential');
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.equal(fin.outcome, 'failed');
  assert.match(fin.summary, /tried 4 times/);
  assert.equal(f.c.state, 'STANDBY');
});

test('never retries after a side effect was committed (or may have been)', async () => {
  for (const effect of ['committed', 'in_flight'] as const) {
    const f = await fixture();
    f.codex.scripts.push(async ({ hooks }) => {
      hooks.toolStarted({ toolId: 'files.move', mayHaveSideEffects: true });
      if (effect === 'committed') hooks.toolResult({ toolId: 'files.move', observedState: obs('moved a.txt', 'committed', true), verified: true, sideEffect: 'committed' });
      return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'network' } };
    });
    f.say('move a.txt to archive');
    await f.drain();
    assert.equal(f.codex.runs.length, 1, effect);
    const fin = f.sink.of('TaskFinished')[0]!.payload;
    assert.equal(fin.outcome, 'failed_after_side_effects', effect);
    assert.match(fin.summary, effect === 'committed' ? /already happened: files\.move/ : /may have taken effect: files\.move/);
  }
});

test('fatal errors are not retried', async () => {
  const f = await fixture();
  f.codex.defaultScript = async () => ({ status: 'failed', error: { kind: 'fatal', origin: 'turn_failed', message: 'bad request' } });
  f.say('x y z');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'failed');
});

// ------------------------------------------------------------------------------------------- approvals
function approvalScript(f: Awaited<ReturnType<typeof fixture>>, risk: 'low' | 'high' = 'high') {
  const decisions: boolean[] = [];
  f.codex.scripts.push(async ({ hooks }) => {
    const d = await hooks.requestApproval({ actionId: hexId('del'), summary: 'Delete old.log', risk, category: 'delete', toolId: 'files.delete', display: fileParams() });
    decisions.push(d.approved);
    if (d.approved) hooks.toolResult({ toolId: 'files.delete', observedState: obs('old.log deleted', 'committed', true), verified: true, sideEffect: 'committed' });
    return { status: 'completed', summary: d.approved ? 'Deleted old.log.' : 'Left old.log alone.' };
  });
  return decisions;
}

test('approval: secure UI approves; voice cannot approve under the default fail-closed policy; single use', async () => {
  const f = await fixture();
  const decisions = approvalScript(f);
  f.say('delete old.log');
  await flush();
  assert.equal(f.c.state, 'PERMISSION_REQUIRED');
  const req = f.sink.of('ApprovalRequested')[0]!.payload;
  assert.equal(req.actionId, hexId('del'));
  assert.equal(req.expiry, new Date(f.clock.now() + 60_000).toISOString());
  assert.deepEqual(f.c.resolveApproval(approval(hexId('del'), true, f), 'voice'), { kind: 'rejected', reason: 'channel_not_allowed' });
  assert.equal(f.c.state, 'PERMISSION_REQUIRED', 'still waiting');
  assert.deepEqual(f.c.resolveApproval(approval(hexId('del'), true, f), 'secure_ui'), { kind: 'accepted' });
  assert.deepEqual(f.c.resolveApproval(approval(hexId('del'), true, f), 'secure_ui'), { kind: 'rejected', reason: 'already_resolved' });
  assert.deepEqual(f.c.resolveApproval(approval(hexId('nope'), true, f), 'secure_ui'), { kind: 'rejected', reason: 'unknown_action' });
  await f.drain();
  assert.deepEqual(decisions, [true]);
  assert.deepEqual(states(f).slice(4, 8), ['EXECUTING', 'PERMISSION_REQUIRED', 'EXECUTING', 'VERIFYING']);
});

test('approval: a spoken "no" is accepted as a denial; silence expires to denial', async () => {
  const f = await fixture();
  const d1 = approvalScript(f);
  f.say('delete old.log');
  await flush();
  assert.deepEqual(f.c.resolveApproval(approval(hexId('del'), false, f), 'voice'), { kind: 'accepted' });
  await f.drain();
  assert.deepEqual(d1, [false]);

  await f.clock.advance(20_000);
  const d2 = approvalScript(f);
  f.say('delete old.log please');
  await flush();
  assert.equal(f.c.state, 'PERMISSION_REQUIRED');
  await f.clock.advance(60_000);
  await f.drain();
  assert.deepEqual(d2, [false], 'silence never approves');
  const resolved = f.sink.of('ApprovalResolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.payload.approved, false);
});

test('pre-dispatch CONFIRMING: decline finishes as declined without contacting Codex', async () => {
  const policy: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: text => (text.includes('email') ? { summary: 'Send an email to Bob', risk: 'high', category: 'external_send' } : null) };
  const f = await fixture({ policy });
  f.say('send an email to bob');
  await flush();
  assert.equal(f.c.state, 'CONFIRMING');
  const actionId = f.sink.of('ApprovalRequested')[0]!.payload.actionId;
  f.c.resolveApproval(approval(actionId, false, f), 'secure_ui');
  await f.drain();
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'declined');
  await f.clock.advance(20_000);
  f.say('send an email to bob now');
  await flush();
  f.c.resolveApproval(approval(f.sink.of('ApprovalRequested')[1]!.payload.actionId, true, f), 'secure_ui');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
});

// ------------------------------------------------------------------------------------------- recovery outside tasks
test('idle faults: recoverable -> RECOVERING -> STANDBY; fatal -> ERROR -> RECOVERING -> STANDBY', async () => {
  const f = await fixture();
  assert.equal(f.c.handleFault('audio', false)?.to, 'RECOVERING');
  assert.equal(f.c.handleRecovered().ok, true);
  assert.equal(f.c.state, 'STANDBY');
  f.c.handleFault('codex_runtime', true);
  assert.equal(f.c.state, 'ERROR');
  assert.equal(f.c.handleRecovered().ok, true);
  assert.equal(f.c.state, 'STANDBY');
});

test('empty transcription prompts and returns to standby without creating a task', async () => {
  const f = await fixture();
  assert.deepEqual(f.say('  ...  '), { kind: 'rejected', reason: 'empty_utterance' });
  await f.drain();
  assert.equal(f.sink.of('TaskRequested').length, 0);
  assert.match(f.speech.spoken[0]!.text, /didn't catch/);
  assert.equal(f.c.state, 'STANDBY');
});
