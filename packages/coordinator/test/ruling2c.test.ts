/**
 * E01 ruling 2c (dottie-e01 a147dbe): the desktop may answer ANY ApprovalRequested it can't validate or show, from
 * every requestSource, with ApprovalResolved{approved:false, reason:'display_unavailable'} (no decision field).
 * Per source, the coordinator side:
 * (a) codex: the Codex request is answered exactly once, declined with reason display_unavailable (not 'denied');
 * (b) tool_host: K8 owns tool-host approvals and their tokens (E08/E04); the coordinator has no pending dialog for
 *     them, so it accepts nothing, mints nothing, emits nothing and starts nothing;
 * (c) coordinator (pre_dispatch): the task ends TaskFinished declined{approval_unavailable} (the only `declined`
 *     reason in CONTRACTS §3 TaskFinished; the approval-level reason is display_unavailable), zero Codex dispatch.
 * Every case: the desktop's ApprovalResolved is the only one (the coordinator emits none), no TTS says the user
 * declined, and a later approve for the same actionId is ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/contracts.js';
import type { ApprovalDecision, PolicyPort } from '../src/ports.js';
import { allowAllChannels, approval, fileParams, fixture, flush, hexId, type Fixture } from './helpers.js';

const confirm: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log', risk: 'high', category: 'delete' }) };
const unshowable = (actionId: string, f: Fixture) => {
  const ev = approval(actionId, false, f);
  const e = { ...ev, payload: { ...ev.payload, reason: 'display_unavailable' as const } };
  assert.ok(validateEvent(e).ok, 'a valid 2c answer (no decision field)');
  assert.equal('decision' in e.payload, false);
  return e;
};
const USER_DECLINED = /you declined|declined it|won't do that|you said no|cancelled by you/i;
const spoken = (f: Fixture) => f.speech.spoken.map(s => s.text).join(' | ');

test('2c (a) codex: a desktop display_unavailable answers the Codex request exactly once with display_unavailable; no coordinator ApprovalResolved, no "you declined" TTS, a later approve is ignored', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const answers: ApprovalDecision[] = [];
  let first!: Promise<ApprovalDecision>;
  f.codex.scripts.push(async ({ hooks }) => {
    first = hooks.requestApproval({ actionId: hexId('c2c'), summary: 'Delete old.log', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() });
    answers.push(await first);
    return { status: 'completed', summary: 'ok' };
  });
  f.say('delete old.log', 'req_2c_a');
  await flush();
  await flush();
  const req = f.sink.of('ApprovalRequested');
  assert.equal(req.length, 1);
  assert.equal(req[0]!.payload.requestSource, 'codex');
  assert.equal(f.c.resolveApproval(unshowable(req[0]!.payload.actionId, f), 'secure_ui').kind, 'accepted');
  await flush();
  assert.deepEqual(f.c.resolveApproval(approval(req[0]!.payload.actionId, true, f), 'secure_ui'), { kind: 'rejected', reason: 'already_resolved' }, 'later approve ignored');
  await f.drain();
  assert.deepEqual(answers, [{ approved: false, reason: 'display_unavailable' }], 'answered exactly once, display_unavailable');
  assert.equal(f.sink.of('ApprovalResolved').length, 0, 'the desktop answer is the only ApprovalResolved');
  assert.doesNotMatch(spoken(f), USER_DECLINED);
  assert.equal(f.log.find('coordinator.approval.display_unavailable').length, 1);
});

test('2c (b) tool_host: a desktop display_unavailable for a tool-host actionId (K8-owned dialog) is not accepted by the coordinator: no dialog settled, no event, no Codex run, no TTS; a later approve is ignored too', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const id = hexId('tool_host_k8');
  const before = { events: f.sink.events.length, state: f.c.state, runs: f.codex.runs.length };
  const ev = { ...unshowable(id, f), taskId: 'task_k8' };
  assert.deepEqual(f.c.resolveApproval(ev, 'secure_ui'), { kind: 'rejected', reason: 'unknown_action' });
  assert.deepEqual(f.c.resolveApproval({ ...approval(id, true, f), taskId: 'task_k8' }, 'secure_ui'), { kind: 'rejected', reason: 'unknown_action' }, 'a later approve is not an approval either');
  await f.drain();
  assert.deepEqual({ events: f.sink.events.length, state: f.c.state, runs: f.codex.runs.length }, before, 'nothing emitted, started or changed');
  assert.equal(f.speech.spoken.length, 0);
  assert.doesNotMatch(JSON.stringify(f.log.find('coordinator.approval.rejected')), /task_k8/, 'warning carries no values beyond the id');
});

test('2c (c) pre_dispatch: a desktop display_unavailable ends the task declined{approval_unavailable} with zero Codex dispatch; no coordinator ApprovalResolved, no "you declined" TTS, a later approve is ignored', async () => {
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_2c_c');
  await flush();
  const req = f.sink.of('ApprovalRequested');
  assert.equal(req.length, 1);
  assert.equal(req[0]!.payload.requestSource, 'coordinator');
  const id = req[0]!.payload.actionId;
  assert.equal(f.c.resolveApproval(unshowable(id, f), 'secure_ui').kind, 'accepted');
  await flush();
  assert.deepEqual(f.c.resolveApproval(approval(id, true, f), 'secure_ui'), { kind: 'rejected', reason: 'already_resolved' }, 'later approve ignored');
  await f.drain();
  assert.equal(f.codex.runs.length, 0, 'zero Codex dispatch');
  const fin = f.sink.of('TaskFinished');
  assert.equal(fin.length, 1);
  assert.deepEqual([fin[0]!.payload.outcome, fin[0]!.payload.reason, fin[0]!.payload.verified], ['declined', 'approval_unavailable', false]);
  assert.doesNotMatch(fin[0]!.payload.summary, USER_DECLINED);
  assert.equal(f.sink.of('ApprovalResolved').length, 0, 'the desktop answer is the only ApprovalResolved');
  assert.doesNotMatch(spoken(f), USER_DECLINED);
  assert.ok(f.speech.spoken.length >= 1, 'the user is told why');
});

test('2c contrast: a plain secure-UI "no" (no reason) is still the user\'s decline: Codex gets denied, a pre-dispatch confirmation ends declined without approval_unavailable', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const answers: ApprovalDecision[] = [];
  f.codex.scripts.push(async ({ hooks }) => {
    answers.push(await hooks.requestApproval({ actionId: hexId('c2c_no'), summary: 'Delete old.log', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() }));
    return { status: 'completed', summary: 'ok' };
  });
  f.say('delete old.log', 'req_2c_no_a');
  await flush();
  await flush();
  const id = f.sink.of('ApprovalRequested')[0]!.payload.actionId;
  assert.equal(f.c.resolveApproval(approval(id, false, f), 'secure_ui').kind, 'accepted');
  await f.drain();
  assert.deepEqual(answers, [{ approved: false, reason: 'denied' }]);

  const g = await fixture({ policy: confirm });
  g.say('delete old.log', 'req_2c_no_c');
  await flush();
  const pid = g.sink.of('ApprovalRequested')[0]!.payload.actionId;
  assert.equal(g.c.resolveApproval(approval(pid, false, g), 'secure_ui').kind, 'accepted');
  await g.drain();
  const fin = g.sink.of('TaskFinished')[0]!.payload;
  assert.equal(fin.outcome, 'declined');
  assert.equal(fin.reason, undefined, 'the user said no: not approval_unavailable');
  assert.equal(g.codex.runs.length, 0);
});
