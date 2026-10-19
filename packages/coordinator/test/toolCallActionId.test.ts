/**
 * E01 DOT-092 ruling 1d (CONTRACTS @ de045c9 §5 "navigate checks", E08 confirm): for `navigate` and every other
 * non-approval gated call the host does schema → computeActionId → authorizeToolCall, and AuthorizeToolCallParams
 * carries a REQUIRED actionId (64 lowercase hex). Missing or malformed → DENIED_BY_POLICY, sideEffect none, the tool
 * never runs (CONTRACTS: K8 reason `malformed`).
 *
 * Check order in Coordinator.authorizeToolCall (first failure wins, all sideEffect none):
 *   1. reserved top-level key → INVALID_ARGUMENT
 *   2. no active turn / stop requested → PRECONDITION_FAILED
 *   3. actionId missing/malformed → DENIED_BY_POLICY   (single check site: checkCallActionId)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, flush, hexId, hostActionId, untilAborted, fileParams } from './helpers.js';

type F = Awaited<ReturnType<typeof fixture>>;
async function liveTurn(): Promise<F> {
  const f = await fixture();
  f.codex.scripts.push(untilAborted);
  f.say('open downloads');
  await flush();
  assert.ok(f.c.toolCallContext(), 'a live turn');
  return f;
}
const finish = async (f: F) => { f.c.cancelTask(); await f.drain(); };
const DENIED = { ok: false, code: 'DENIED_BY_POLICY', sideEffect: 'none' };

test('ruling 1d: a navigate call with the host-computed actionId is authorized with the coordinator context and args unchanged', async () => {
  const f = await liveTurn();
  const ctx = f.c.toolCallContext()!;
  const r = f.tools.call(f.c, 'explorer.open_known_folder', { folder: 'downloads' });
  assert.equal(r.ok, true);
  assert.equal(f.tools.sentActionIds[0], hostActionId('explorer.open_known_folder', { folder: 'downloads' }, ctx));
  assert.deepEqual(f.tools.calls[0], { toolId: 'explorer.open_known_folder', context: ctx, args: { folder: 'downloads' } });
  await finish(f);
});

test('ruling 1d: a MISSING actionId → DENIED_BY_POLICY, sideEffect none, the tool never runs', async () => {
  const f = await liveTurn();
  assert.deepEqual(f.tools.call(f.c, 'explorer.open_known_folder', { folder: 'downloads' }, { actionId: undefined }), DENIED);
  const r = f.c.authorizeToolCall({ toolId: 'explorer.open_known_folder', modelArgs: { folder: 'downloads' } } as never);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'DENIED_BY_POLICY');
    assert.equal(r.error.retryable, false);
    assert.equal(r.sideEffect, 'none');
  }
  assert.equal(f.tools.calls.length, 0);
  await finish(f);
});

for (const [why, bad] of [
  ['uppercase hex', hexId('x').toUpperCase()],
  ['63 chars', hexId('x').slice(1)],
  ['65 chars', `${hexId('x')}0`],
  ['legacy act_ id', 'act_1'],
  ['empty string', ''],
  ['null', null],
  ['number', 42],
  ['object', { actionId: hexId('x') }],
  ['hex with whitespace', ` ${hexId('x')}`],
] as const) {
  test(`ruling 1d: a malformed actionId (${why}) → DENIED_BY_POLICY, sideEffect none, the tool never runs`, async () => {
    const f = await liveTurn();
    assert.deepEqual(f.tools.call(f.c, 'files.search', { query: 'q' }, { actionId: bad }), DENIED);
    assert.equal(f.tools.calls.length, 0);
    const warn = f.log.find('coordinator.tool_call.action_id_rejected');
    assert.equal(warn.length, 1);
    assert.equal(warn[0]!.fields['reason'], 'malformed');
    await finish(f);
  });
}

test('ruling 1d: the rejection log carries ids and key names only, never the actionId value or arg values', async () => {
  const f = await liveTurn();
  const forged = `${hexId('SECRET_ID')}ff`;
  f.tools.call(f.c, 'files.search', { query: 'ARG_VALUE_987' }, { actionId: forged });
  const line = JSON.stringify(f.log.lines);
  assert.ok(!line.includes(forged) && !line.includes(hexId('SECRET_ID')), 'no actionId value');
  assert.ok(!line.includes('ARG_VALUE_987'), 'no arg value');
  const w = f.log.find('coordinator.tool_call.action_id_rejected')[0]!;
  assert.equal(w.fields['toolId'], 'files.search');
  assert.equal(w.fields['taskId'], f.c.toolCallContext()!.taskId);
  await finish(f);
});

test('ruling 1d order: a reserved key wins over a bad actionId (INVALID_ARGUMENT), with or without a live turn', async () => {
  const idle = await fixture();
  assert.deepEqual(idle.tools.call(idle.c, 'files.read', { taskId: 'x' }, { actionId: 'nope' }), { ok: false, code: 'INVALID_ARGUMENT', sideEffect: 'none' });
  const f = await liveTurn();
  assert.deepEqual(f.tools.call(f.c, 'files.read', { hwnd: '1' }, { actionId: undefined }), { ok: false, code: 'INVALID_ARGUMENT', sideEffect: 'none' });
  assert.equal(f.log.find('coordinator.tool_call.action_id_rejected').length, 0, 'the actionId check never ran');
  await finish(f);
});

test('ruling 1d order: no active turn wins over a bad or missing actionId (PRECONDITION_FAILED), idle and after a stop', async () => {
  const idle = await fixture();
  assert.deepEqual(idle.tools.call(idle.c, 'files.read', {}), { ok: false, code: 'PRECONDITION_FAILED', sideEffect: 'none' }, 'idle host has no context, so it sends no actionId');
  assert.deepEqual(idle.tools.call(idle.c, 'files.read', {}, { actionId: 'bad' }), { ok: false, code: 'PRECONDITION_FAILED', sideEffect: 'none' });
  const f = await liveTurn();
  const ctx = f.c.toolCallContext()!;
  f.c.cancelTask();
  assert.deepEqual(f.tools.call(f.c, 'files.read', {}, { actionId: hostActionId('files.read', {}, ctx) }), { ok: false, code: 'PRECONDITION_FAILED', sideEffect: 'none' }, 'a well-formed id never revives a stopped turn');
  assert.equal(f.log.find('coordinator.tool_call.action_id_rejected').length, 0);
  await f.drain();
});

test('ruling 1g: an approval-gated call sends the approval\'s own actionId; the coordinator accepts it by format (K8 recomputes with targets)', async () => {
  const f = await fixture();
  let seen: unknown;
  f.codex.scripts.push(async ({ hooks }) => {
    const d = await hooks.requestApproval({ actionId: hexId('gated_del'), summary: 'Delete old.log', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() });
    assert.equal(d.approved, true);
    seen = f.tools.call(f.c, 'files.delete', { path: 'old.log' }, { actionId: hexId('gated_del') });
    return { status: 'completed', summary: 'done' };
  });
  f.say('delete old.log');
  await flush();
  const { approval: appr } = await import('./helpers.js');
  f.c.resolveApproval(appr(hexId('gated_del'), true, f), 'secure_ui');
  await f.drain();
  assert.equal((seen as { ok: boolean }).ok, true);
  assert.equal(f.tools.sentActionIds[0], hexId('gated_del'));
});
