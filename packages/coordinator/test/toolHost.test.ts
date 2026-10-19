/**
 * Ruling 1 (CONTRACTS §5 "Tool-host context", E01 2026-10-19; ADR-0010 single active task):
 * the tool host gets taskId and turnId for every call from the coordinator, never from model-supplied arguments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolResult } from '../src/contracts.js';
import { fixture, flush, hexId, obs, untilAborted } from './helpers.js';

const RESERVED = ['taskId', 'turnId', 'threadId', 'hwnd', 'pid', 'task_id', 'TURN-ID', 'ThreadID', 'HWND', 'PID'];

for (const key of RESERVED) {
  test(`Ruling 1 (E01 r6 + E04): a top-level reserved key '${key}' in model args is REJECTED with INVALID_ARGUMENT; the tool never runs`, async () => {
    const f = await fixture();
    let seen: unknown;
    f.codex.scripts.push(async () => {
      seen = f.tools.call(f.c, 'explorer.open_known_folder', { folder: 'downloads', [key]: 'FORGED_VALUE_123' });
      return { status: 'completed', summary: 'done' };
    });
    f.say('open downloads');
    await f.drain();
    assert.deepEqual(seen, { ok: false, code: 'INVALID_ARGUMENT', sideEffect: 'none' });
    assert.equal(f.tools.calls.length, 0, 'tool never invoked');
    const warn = f.log.find('coordinator.tool_call.reserved_keys_rejected');
    assert.equal(warn.length, 1);
    assert.equal(warn[0]!.fields['keys'], key, 'key names are logged');
    assert.ok(!JSON.stringify(f.log.lines).includes('FORGED_VALUE_123'), 'values are never logged');
  });
}

test('Ruling 1: all reserved keys are listed together, and the rejection is a valid ToolError (not retryable)', async () => {
  const f = await fixture();
  f.codex.scripts.push(async () => {
    const r = f.c.authorizeToolCall({ toolId: 'explorer.open_known_folder', modelArgs: { folder: 'downloads', taskId: 'a', turnId: 'b', hwnd: '1', pid: '2', threadId: 'c' }, actionId: hexId('reserved') });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'INVALID_ARGUMENT');
      assert.equal(r.error.retryable, false);
      assert.equal(r.sideEffect, 'none');
      assert.doesNotMatch(r.error.message, /\b[abc12]\b/, 'message carries no values');
    }
    return { status: 'completed', summary: 'done' };
  });
  f.say('open downloads');
  await f.drain();
  assert.equal(f.log.find('coordinator.tool_call.reserved_keys_rejected')[0]!.fields['keys'], 'taskId,turnId,hwnd,pid,threadId');
});

test('Ruling 1: clean args pass through unchanged with the coordinator-sourced context; nested lookalikes are not reserved', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ req, hooks }) => {
    const r = f.c.authorizeToolCall({ toolId: 'files.search', modelArgs: { query: 'pid file', filter: { taskId: 'x' }, taskIdentifier: 'y' }, actionId: hexId('search') });
    assert.ok(r.ok);
    assert.deepEqual(r.context, { taskId: req.taskId, turnId: req.turnId });
    assert.deepEqual(r.args, { query: 'pid file', filter: { taskId: 'x' }, taskIdentifier: 'y' });
    hooks.toolResult({ toolId: 'files.search', observedState: obs('found'), verified: true, sideEffect: 'none' });
    return { status: 'completed', summary: 'ok' };
  });
  f.say('search');
  await f.drain();
  assert.equal(f.sink.of('ToolResult')[0]!.payload.taskId, f.codex.runs[0]!.taskId);
});

test('Ruling 1: a forged taskId inside an adapter tool result is overwritten by the coordinator', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks }) => {
    const forged = { taskId: 'task_EVIL', turnId: 'turn_EVIL', toolId: 'files.read', observedState: obs('read'), verified: true, sideEffect: 'none' } as unknown as Omit<ToolResult, 'taskId'>;
    hooks.toolResult(forged);
    return { status: 'completed', summary: 'ok' };
  });
  f.say('read the file');
  await f.drain();
  const p = f.sink.of('ToolResult')[0]!.payload as unknown as Record<string, unknown>;
  assert.equal(p['taskId'], f.codex.runs[0]!.taskId);
  assert.equal('turnId' in p, false, 'unknown fields are not forwarded');
});

test('Ruling 1: the host is told the active turn at every turn start (incl. retries) and cleared between turns', async () => {
  const f = await fixture();
  f.codex.scripts.push(async () => ({ status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'socket' } }), async () => ({ status: 'completed', summary: 'ok' }));
  f.say('open downloads');
  await f.drain();
  const id = f.codex.runs[0]!.taskId;
  assert.deepEqual(f.codex.runs.map(r => r.turnId), [`${id}.t1`, `${id}.t2`]);
  assert.deepEqual(f.codex.runs.map(r => r.turnKind), ['initial', 'retry']);
  assert.deepEqual(f.codex.runs.map(r => r.clientUserMessageId), [`${id}.t1`, `${id}.t2`], 'each retry gets its own clientUserMessageId (= turnId)');
  assert.deepEqual(f.codex.runs.map(r => r.idempotencyKey), [id, id]);
  assert.deepEqual(f.tools.turns, [{ taskId: id, turnId: `${id}.t1` }, null, { taskId: id, turnId: `${id}.t2` }, null]);
  assert.deepEqual(f.tools.ended, [id]);
});

test('Ruling 1: no tool call is authorised without an active turn, or once a stop was requested', async () => {
  const f = await fixture();
  assert.deepEqual(f.tools.call(f.c, 'files.read', {}), { ok: false, code: 'PRECONDITION_FAILED', sideEffect: 'none' }, 'idle: no active turn');
  assert.deepEqual(f.tools.call(f.c, 'files.read', { taskId: 'task_1' }), { ok: false, code: 'INVALID_ARGUMENT', sideEffect: 'none' }, 'idle + forged taskId: still rejected, never opens a context');
  f.codex.scripts.push(untilAborted);
  f.say('long task');
  await flush();
  assert.equal(f.tools.call(f.c, 'files.read', {}).ok, true);
  f.c.cancelTask();
  assert.deepEqual(f.tools.call(f.c, 'files.delete', {}), { ok: false, code: 'PRECONDITION_FAILED', sideEffect: 'none' }, 'after cancel request');
  await f.drain();
  assert.equal(f.c.toolCallContext(), null);
});
