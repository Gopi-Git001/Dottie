/**
 * actionId (CONTRACTS §3 ApprovalRequested + §3.3 canonicaliser, ADR-0009 CR2, Accepted; E01 2026-10-19):
 * lowercase-hex SHA-256 of canonical JSON with purpose `dottie.actionId.v1`. The coordinator never mints `act_…`
 * ids again. They come from the injected ActionIdPort (packages/contracts computeActionId once DOT-090 lands).
 * Fail closed (CR1: any hash-computation failure resolves as decline): no port, a throw, or output that isn't
 * /^[0-9a-f]{64}$/ → NO ApprovalRequested; the confirmation counts as declined and nothing is dispatched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/contracts.js';
import { preDispatchDisplay } from '../src/display.js';
import type { PolicyPort } from '../src/ports.js';
import { allowAllChannels, approval, codexDisp, displayHashOf, fixture, flush, hexId, RecordingActionIdPort, fileParams } from './helpers.js';

const HEX = /^[0-9a-f]{64}$/;
/** E02 895676d vectors.json actionId "pre_dispatch_confirmation" (re-pinned; was 3c60c777… on the pre-1k three-key preimage). */
const PRE_DISPATCH_VECTOR_HASH = 'c95085229aab3dd9dd9e4f13bfd36213a9203322a69d1b9224bdbcea1a806a95';
const PRE_DISPATCH_VECTOR_DISPLAY_HASH = '1af4547418602b5bb9ad80149f7e006109da68aa851d288109cfda4c8deb5a8d';
const confirmPolicy: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log in Downloads', risk: 'high', category: 'delete' }) };
type F = Awaited<ReturnType<typeof fixture>>;
const noActIds = (f: F) => assert.doesNotMatch(JSON.stringify(f.sink.events), /act_/, 'no act_ id in any emitted event');

test('actionId: the CONFIRMING path gets its id from the ActionIdPort with the CR2 binding; IdSource is never asked for one', async () => {
  const f = await fixture({ policy: confirmPolicy });
  f.say('delete old.log', 'req_conf');
  await flush();
  assert.equal(f.c.state, 'CONFIRMING');
  const req = f.sink.of('ApprovalRequested')[0]!.payload;
  assert.match(req.actionId, HEX);
  const taskId = f.sink.of('ApprovalRequested')[0]!.taskId!;
  assert.deepEqual(f.actionIds!.bindings, [{
    purpose: 'dottie.actionId.v1',
    method: 'dottie.pre_dispatch_confirmation',
    args: { category: 'delete', risk: 'high', summary: 'Delete old.log in Downloads', possibleRepeat: null, retryOfTaskId: null, displayHash: displayHashOf(req.display) },
    targets: null,
    taskId,
    threadId: null,
    turnId: `${taskId}.t1`,
    itemId: null,
    requestId: 'req_conf',
    displayHash: displayHashOf(req.display),
    requestSource: 'coordinator',
  }]);
  assert.ok(!f.ids.asked.includes('act'), 'IdSource never mints action ids');
  f.c.resolveApproval(approval(req.actionId, true, f), 'secure_ui');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.codex.runs[0]!.turnId, `${taskId}.t1`, 'the dispatched turn is the SAME turn the approval was bound to');
  assert.equal(f.codex.runs[0]!.clientUserMessageId, f.codex.runs[0]!.turnId);
  noActIds(f);
});

test('actionId (CONTRACTS §2.1 pre-dispatch preimage): the same summary under a different turnId or task gives a different actionId', async () => {
  const f = await fixture({ policy: confirmPolicy });
  f.say('delete old.log', 'req_a');
  await flush();
  const first = f.sink.of('ApprovalRequested')[0]!.payload;
  f.c.resolveApproval(approval(first.actionId, false, f), 'voice');
  await f.drain();
  await f.clock.advance(60_000); // past the dedupe window
  f.say('delete old.log', 'req_b');
  await flush();
  const second = f.sink.of('ApprovalRequested')[1]!.payload;
  assert.notEqual(second.taskId, first.taskId);
  assert.equal(second.summary, first.summary);
  assert.notEqual(second.actionId, first.actionId, 'a new task gets a new id: no cross-task replay');

  const port = new RecordingActionIdPort();
  const b = f.actionIds!.bindings[0]!;
  const sameButTurn = await port.computeActionId({ ...b, turnId: `${b.taskId}.t2` });
  assert.notEqual(sameButTurn, first.actionId, 'a different turnId gives a different id: no cross-turn replay');
  assert.equal(await port.computeActionId({ ...b }), first.actionId, 'deterministic for the same binding');
});

test('actionId: pre-dispatch vector re-pinned to E02 895676d (un-held): the real port gives the vector bytes for the coordinator\'s own binding', async () => {
  const display = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 'Delete old.log in Downloads' });
  const port = new RecordingActionIdPort();
  assert.equal(await port.computeDisplayHash!(display), PRE_DISPATCH_VECTOR_DISPLAY_HASH);
  const b = { purpose: 'dottie.actionId.v1', method: 'dottie.pre_dispatch_confirmation', args: { summary: 'Delete old.log in Downloads', risk: 'high', category: 'delete', possibleRepeat: null, retryOfTaskId: null, displayHash: PRE_DISPATCH_VECTOR_DISPLAY_HASH }, targets: null, taskId: 'task_1', threadId: null, turnId: 'task_1.t1', itemId: null, requestId: 'req_conf', displayHash: PRE_DISPATCH_VECTOR_DISPLAY_HASH, requestSource: 'coordinator' } as const;
  assert.equal(await port.computeActionId(b), PRE_DISPATCH_VECTOR_HASH);
  // and the coordinator, given task_1 / req_conf, binds exactly that object
  const f = await fixture({ policy: confirmPolicy, actionIds: port });
  f.say('delete old.log', 'req_conf');
  await flush();
  const got = port.bindings.at(-1)!;
  assert.deepEqual({ ...got, taskId: 'task_1', turnId: 'task_1.t1' }, b);
});

test('actionId: a valid hex id flows end to end: approve → dispatched; deny → declined; expiry → declined', async () => {
  const yes = await fixture({ policy: confirmPolicy });
  yes.say('delete old.log');
  await flush();
  const a = yes.sink.of('ApprovalRequested')[0]!.payload.actionId;
  assert.deepEqual(yes.c.resolveApproval(approval(a, true, yes), 'secure_ui'), { kind: 'accepted' });
  await yes.drain();
  assert.equal(yes.codex.runs.length, 1);
  assert.ok(validateEvent(JSON.parse(JSON.stringify(approval(a, true, yes)))).ok, 'the UI-owned ApprovalResolved carrying the hex id validates');
  for (const e of yes.sink.events) assert.ok(validateEvent(JSON.parse(JSON.stringify(e))).ok, e.type);

  const no = await fixture({ policy: confirmPolicy });
  no.say('delete old.log');
  await flush();
  const b = no.sink.of('ApprovalRequested')[0]!.payload.actionId;
  assert.deepEqual(no.c.resolveApproval(approval(b, false, no), 'voice'), { kind: 'accepted' });
  await no.drain();
  assert.equal(no.codex.runs.length, 0);
  assert.equal(no.sink.of('TaskFinished')[0]!.payload.outcome, 'declined');

  const late = await fixture({ policy: confirmPolicy, config: { approvalTimeoutMs: 1_000 } });
  late.say('delete old.log');
  await flush();
  const c = late.sink.of('ApprovalRequested')[0]!.payload.actionId;
  await late.clock.advance(1_000);
  await late.drain();
  assert.equal(late.codex.runs.length, 0);
  assert.equal(late.sink.of('TaskFinished')[0]!.payload.outcome, 'declined');
  assert.deepEqual(late.sink.of('ApprovalResolved').map(e => [e.payload.actionId, e.payload.approved]), [[c, false]]);
  for (const f of [yes, no, late]) noActIds(f);
});

async function assertNotApprovable(f: F, label: string) {
  f.say('delete old.log');
  await f.drain();
  assert.equal(f.sink.of('ApprovalRequested').length, 0, `${label}: no ApprovalRequested`);
  assert.equal(f.sink.of('ApprovalResolved').length, 0, `${label}: nothing to resolve`);
  assert.equal(f.codex.runs.length, 0, `${label}: nothing dispatched`);
  assert.equal(f.sink.of('TaskRequested').length, 1, `${label}: the request was admitted, then not approvable`);
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.equal(fin.outcome, 'declined', `${label}: CR1 (hash computation failure resolves as decline)`);
  assert.equal(fin.reason, 'approval_unavailable', `${label}: CONTRACTS §3 TaskFinished reason`);
  assert.match(fin.summary, /couldn't request your approval safely/i, `${label}: truthful: the user did not decline`);
  assert.doesNotMatch(f.speech.spoken.map(s => s.text).join(' '), /you declined|approve it in/i, label);
  const warn = f.log.find('coordinator.approval.action_id_unavailable');
  assert.equal(warn.length, 1, `${label}: one warning`);
  assert.ok(!JSON.stringify(f.log.lines).includes('Delete old.log'), `${label}: the warning carries no args`);
  assert.equal(f.c.state, 'STANDBY');
  noActIds(f);
}

test('actionId: no ActionIdPort wired (default until DOT-090) → fail closed: no ApprovalRequested, declined, warning without args', async () => {
  const f = await fixture({ policy: confirmPolicy, actionIds: null });
  await assertNotApprovable(f, 'unwired');
  assert.equal(f.log.find('coordinator.approval.action_id_unavailable')[0]!.fields['why'], 'no_port');
});

test('actionId: bad port output → fail closed (act_ id, uppercase hex, wrong length, non-string, throw, rejected promise)', async () => {
  const bad: [string, () => string | Promise<string>][] = [
    ['act_ id', () => 'act_7'],
    ['uppercase hex', () => hexId('x').toUpperCase()],
    ['63 chars', () => hexId('x').slice(1)],
    ['65 chars', () => `${hexId('x')}0`],
    ['non-string', () => 42 as unknown as string],
    ['throws', () => { throw new Error('canonicaliser rejected a non-string leaf'); }],
    ['rejects', () => Promise.reject(new Error('boom'))],
  ];
  for (const [label, impl] of bad) {
    const port = new RecordingActionIdPort();
    port.impl = impl;
    const f = await fixture({ policy: confirmPolicy, actionIds: port });
    await assertNotApprovable(f, label);
  }
});

test('actionId: an adapter-supplied Codex approval actionId must be 64 lowercase hex; otherwise no ApprovalRequested and Codex gets a decline', async () => {
  const f = await fixture();
  let decision: unknown;
  f.codex.scripts.push(async ({ hooks }) => {
    decision = await hooks.requestApproval({ actionId: 'act_del', summary: 'Delete old.log', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() });
    return { status: 'completed', summary: 'Not deleted.' };
  });
  f.say('delete old.log');
  await f.drain();
  assert.deepEqual(decision, { approved: false, reason: 'denied' });
  assert.equal(f.sink.of('ApprovalRequested').length, 0);
  assert.equal(f.log.find('coordinator.approval.action_id_unavailable')[0]!.fields['why'], 'invalid_adapter_id');
  noActIds(f);

  const g = await fixture();
  g.codex.scripts.push(async ({ hooks }) => {
    decision = await hooks.requestApproval({ actionId: hexId('del'), summary: 'Delete old.log', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() });
    return { status: 'completed', summary: 'Deleted.' };
  });
  g.say('delete old.log');
  await flush();
  assert.equal(g.sink.of('ApprovalRequested')[0]!.payload.actionId, hexId('del'));
  g.c.resolveApproval(approval(hexId('del'), true, g), 'secure_ui');
  await g.drain();
  assert.deepEqual(decision, { approved: true, reason: 'approved' });
});

test('actionId: validateEvent rejects act_ ids, uppercase hex and wrong lengths on ApprovalRequested and ApprovalResolved', () => {
  const env = (type: 'ApprovalRequested' | 'ApprovalResolved', actionId: unknown) => validateEvent({
    schema: 'dottie.event', version: 2, type, eventId: 'e', correlationId: 'c', taskId: 't', timestamp: '2026-10-19T00:00:00Z',
    payload: type === 'ApprovalRequested'
      ? { taskId: 't', actionId, summary: 's', risk: 'high', expiry: '2026-10-19T00:01:00Z', category: 'delete', ...codexDisp('delete') }
      : { actionId, approved: false, timestamp: '2026-10-19T00:00:00Z' },
  });
  for (const type of ['ApprovalRequested', 'ApprovalResolved'] as const) {
    assert.equal(env(type, hexId('ok')).ok, true, `${type}: valid`);
    for (const bad of ['act_1', 'act_3f2a', hexId('x').toUpperCase(), hexId('x').slice(1), `${hexId('x')}a`, '', `${hexId('x').slice(0, 63)}g`, 7, null]) {
      assert.equal(env(type, bad).ok, false, `${type}: ${JSON.stringify(bad)}`);
    }
  }
});
