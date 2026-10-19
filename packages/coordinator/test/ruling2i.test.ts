/**
 * E01 ruling 2i (CONTRACTS §2.1): every internal Dottie event is closed, envelope and payload alike (nested payload
 * objects too, as E02's validateEvent). Unknown keys (prototype names included), getters, symbol keys and sparse
 * arrays get a clean rejection, never a throw. The Codex App Server wire stays tolerant at E02's adapter boundary
 * (E02's "wire with an extra field still parses" test); the coordinator never copies an unknown port field into an event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/contracts.js';
import type { AnyEvent } from '../src/contracts.js';
import type { PolicyPort } from '../src/ports.js';
import { allowAllChannels, envelope, fileParams, fixture, flush, hexId, obs, type Fixture } from './helpers.js';

type Json = Record<string, unknown>;
const fin = (): Json => ({ ...envelope('TaskFinished', { taskId: 't1', outcome: 'failed', verified: false, summary: 's' }), taskId: 't1', causationId: 'evt_0' });
function rejects(input: unknown, label: string) {
  let r: ReturnType<typeof validateEvent> | undefined;
  assert.doesNotThrow(() => { r = validateEvent(input); }, `${label}: no throw`);
  assert.equal(r!.ok, false, `${label}: rejected`);
}
/** Prepend an OWN key to an object via JSON (works for __proto__ too). */
const withOwnKey = (o: Json, k: string, v: unknown = 'x'): Json => {
  const r = JSON.parse(JSON.stringify(o).replace(/^\{/, `{${JSON.stringify(k)}:${JSON.stringify(v)},`)) as Json;
  assert.ok(Object.hasOwn(r, k));
  return r;
};

test('2i envelope: baseline with every optional envelope key is valid', () => {
  assert.equal(validateEvent(fin()).ok, true);
});

test('2i envelope: an unknown OWN envelope key is rejected, prototype names included; no throw', () => {
  for (const k of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'extra', 'source', 'channel']) rejects(withOwnKey(fin(), k), `envelope.${k}`);
  rejects(withOwnKey(fin(), 'meta', { a: 1 }), 'envelope object-valued extra');
});

test('2i envelope: a getter (even a throwing one), a symbol key, a non-plain envelope or inherited envelope fields are rejected; no throw', () => {
  for (const throwing of [false, true]) {
    const e = fin();
    const v = e['eventId'];
    delete e['eventId'];
    Object.defineProperty(e, 'eventId', { enumerable: true, get: () => { if (throwing) throw new Error('boom'); return v; } });
    rejects(e, `eventId getter${throwing ? ' (throwing)' : ''}`);
    const p = fin();
    Object.defineProperty(p, 'payload', { enumerable: true, get: () => { if (throwing) throw new Error('boom'); return fin()['payload']; } });
    rejects(p, `payload getter${throwing ? ' (throwing)' : ''}`);
  }
  rejects({ ...fin(), [Symbol('s')]: 1 }, 'symbol key');
  rejects(Object.create(fin()), 'inherited envelope');
  class Ev { constructor(o: Json) { Object.assign(this, o); } }
  rejects(new Ev(fin()), 'class instance');
});

test('2i payload (kept): an unknown payload key, also nested (toolError, workspaceScope, committedActions, candidates, observedState non-scalar), is rejected; observedState keeps tool-specific SCALARS', () => {
  const f0 = fin();
  rejects({ ...f0, payload: withOwnKey(f0['payload'] as Json, 'constructor') }, 'payload.constructor');
  const tr = (p: Json): Json => ({ ...envelope('ToolResult', { taskId: 't1', toolId: 'files.delete', observedState: obs('ok', 'none', false), verified: false, sideEffect: 'none', error: { code: 'NOT_FOUND', message: 'm', retryable: false }, ...p } as never), taskId: 't1' });
  assert.equal(validateEvent(tr({})).ok, true, 'ToolResult baseline (incl. a scalar tool-specific observedState key)');
  rejects(tr({ error: { code: 'NOT_FOUND', message: 'm', retryable: false, stack: 'x' } }), 'error.stack');
  rejects(tr({ error: withOwnKey({ code: 'NOT_FOUND', message: 'm', retryable: false }, '__proto__') }), 'error.__proto__');
  rejects(tr({ observedState: { ...obs('ok', 'none', false), raw: { wire: true } } }), 'observedState object-valued extra');
  rejects(tr({ observedState: { ...obs('ok', 'none', false), decision: 'ask_user', question: 'q', candidates: [{ id: 'a', label: 'A', path: 'C:\\x' }] } }), 'candidates[0].path');
  const treq = (scope: unknown): Json => ({ ...envelope('TaskRequested', { taskId: 't1', requestId: 'r', text: 'x', workspaceScope: scope } as never), taskId: 't1' });
  assert.equal(validateEvent(treq({ scopes: ['files.read'], paths: ['C:\\A'] })).ok, true, 'TaskRequested baseline');
  rejects(treq({ scopes: ['files.read'], paths: ['C:\\A'], token: 'x' }), 'workspaceScope.token');
  rejects(treq({ scopes: ['files.read'] }), 'workspaceScope.paths missing');
  rejects(treq({ scopes: ['not.a.scope'], paths: [] }), 'workspaceScope unknown scope');
  const tc = (actions: unknown): Json => ({ ...envelope('TaskCancelled', { taskId: 't1', stopStatus: 'stopped_after_side_effects', sideEffects: 'committed', sideEffectsCommitted: true, committedActions: actions, report: 'r' } as never), taskId: 't1' });
  assert.equal(validateEvent(tc([{ toolId: 'files.delete', observedState: obs('d', 'committed'), certainty: 'committed' }, { toolId: 'mail.send', observedState: null, certainty: 'possible' }])).ok, true, 'TaskCancelled baseline (in-flight observedState null)');
  rejects(tc([{ toolId: 'files.delete', observedState: obs('d', 'committed'), certainty: 'committed', args: 'x' }]), 'committedActions[0].args');
  rejects(tc([{ toolId: 'files.delete', observedState: obs('d', 'committed'), certainty: 'sure' }]), 'committedActions[0].certainty');
});

// ------------------------------------------------------------------ the coordinator side: emitted events, port results
const allValid = (f: Fixture) => {
  for (const e of f.sink.events) {
    const r = validateEvent(e);
    assert.ok(r.ok, `${e.type}: ${r.ok ? '' : r.errors.join('; ')}`);
  }
};
const EXTRA = 'portOnlyField';
const noExtra = (e: AnyEvent) => assert.doesNotMatch(JSON.stringify(e), new RegExp(`${EXTRA}|wireOnly|stack`), `${e.type}: no port-only field`);

test('2i port results: extra fields on a Codex tool result (top level, error, observedState object-valued) are dropped and never reach ToolResult / TaskCancelled; scalar tool-specific keys stay', async () => {
  const f = await fixture({ policy: allowAllChannels });
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    hooks.toolStarted({ toolId: 'files.delete', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'files.delete', observedState: { ...obs('deleted', 'committed'), wireOnly: { raw: 1 } }, verified: true, sideEffect: 'committed', [EXTRA]: 'leak' } as never);
    hooks.toolResult({ toolId: 'files.read', observedState: obs('?', 'none', false), verified: false, sideEffect: 'none', error: { code: 'NOT_FOUND', message: 'no', retryable: false, stack: 'at x' } } as never);
    await aborted;
    return { status: 'aborted' };
  });
  f.say('delete old.log', 'req_2i_tool');
  await flush();
  f.c.cancelTask();
  await f.drain();
  const tr = f.sink.of('ToolResult');
  assert.equal(tr.length, 2);
  for (const e of [...f.sink.events]) noExtra(e);
  assert.equal((tr[0]!.payload.observedState as Json)['note'], 'deleted', 'a scalar tool-specific key is kept');
  assert.deepEqual(Object.keys(tr[1]!.payload.error!).sort(), ['code', 'message', 'retryable']);
  assert.equal(f.sink.of('TaskCancelled').length, 1);
  allValid(f);
});

test('2i port results: an extra field on the policy workspaceScope, a Codex approval request or a Codex run result never reaches TaskRequested / ApprovalRequested / TaskFinished', async () => {
  const policy: PolicyPort = { ...allowAllChannels, workspaceScopeFor: () => ({ scopes: ['files.read'], paths: ['C:/Users/test'], [EXTRA]: 'leak' }) as never };
  const f = await fixture({ policy });
  f.codex.scripts.push(async ({ hooks }) => {
    await hooks.requestApproval({ actionId: hexId('2i'), summary: 'Delete', risk: 'high', category: 'delete', toolId: 'files.delete', display: { ...fileParams(), [EXTRA]: 'leak' } as never, [EXTRA]: 'leak' } as never);
    return { status: 'completed', summary: 'done', [EXTRA]: 'leak' } as never;
  });
  f.say('delete old.log', 'req_2i_misc');
  await flush();
  const ar = f.sink.of('ApprovalRequested');
  assert.equal(ar.length, 1);
  f.c.resolveApproval({ ...envelope('ApprovalResolved', { actionId: ar[0]!.payload.actionId, approved: false, timestamp: '2026-10-19T00:00:00Z' }), taskId: ar[0]!.taskId! }, 'secure_ui');
  await f.drain();
  assert.deepEqual(Object.keys(f.sink.of('TaskRequested')[0]!.payload.workspaceScope).sort(), ['paths', 'scopes']);
  assert.equal(f.sink.of('TaskFinished').length, 1);
  for (const e of f.sink.events) noExtra(e);
  allValid(f);
});
