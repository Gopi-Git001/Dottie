/**
 * E01 ruling 2j (CONTRACTS §3, TaskCancelled.committedActions[]): `observedState: ObservedState | null`, no sentinel.
 * (a) null only on an entry that claims no effect and no verification: certainty 'possible' (the ledger's unknown /
 *     possible side effect; a null entry carries no outcome, so it can never be verified); null with 'committed' → rejected.
 * (b) any null entry → stopStatus is not stopped_no_side_effects / completed_before_stop, and sideEffects ≥ possible.
 * (c) the report (spoken and the event's report, which the tray shows) says that tool's state is unknown, never done.
 * (d) a missing observedState key is rejected: null must be explicit.
 * Coordinator side, per the cancel truth table (skill e03-agent-arch-cancel-truth-table): stop requested while a
 * side-effecting tool is still running, for every stop path (ack 0 ms / just under the timeout / stopped:false / never,
 * completed run while the tool never reported, and a Codex approval pending). Snapshot entries are copies, not aliases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/contracts.js';
import { SideEffectLedger, cancelReport, decideStopStatus } from '../src/cancellation.js';
import type { VerifierPort } from '../src/ports.js';
import { envelope, fixture, flush, obs, type Fixture } from './helpers.js';

type Json = Record<string, unknown>;
const tc = (p: Json): Json => ({
  ...envelope('TaskCancelled', { taskId: 't1', stopStatus: 'stop_unconfirmed', sideEffects: 'possible', sideEffectsCommitted: false, committedActions: [{ toolId: 'mail.send', observedState: null, certainty: 'possible' }], report: 'r', ...p } as never), taskId: 't1',
});
const ok = (e: Json, label: string) => { const r = validateEvent(e); assert.ok(r.ok, `${label}: ${r.ok ? '' : r.errors.join('; ')}`); };
const no = (e: Json, label: string) => { let r: ReturnType<typeof validateEvent> | undefined; assert.doesNotThrow(() => { r = validateEvent(e); }); assert.equal(r!.ok, false, label); };
const RUNNING = { toolId: 'mail.send', observedState: null, certainty: 'possible' };
const DONE_WORDS = /\bdone\b|finished|completed|succeeded|cleanly|before it changed anything|didn't start/i;

test('2j (a): null observedState only with certainty possible; null with committed is rejected; non-null entries unchanged', () => {
  ok(tc({}), 'null + possible');
  ok(tc({ stopStatus: 'stopped_after_side_effects' }), 'null + possible, stopped_after_side_effects');
  no(tc({ committedActions: [{ toolId: 'mail.send', observedState: null, certainty: 'committed' }], sideEffects: 'committed', sideEffectsCommitted: true }), 'null + committed');
  ok(tc({ committedActions: [{ toolId: 'files.delete', observedState: obs('gone', 'committed'), certainty: 'committed' }], sideEffects: 'committed', sideEffectsCommitted: true, stopStatus: 'stopped_after_side_effects' }), 'observed committed');
  ok(tc({ committedActions: [{ toolId: 'files.delete', observedState: obs('?', 'unknown', false), certainty: 'possible' }, RUNNING] }), 'observed possible + running');
});

test('2j (b): a TaskCancelled with a null entry cannot be stopped_no_side_effects or completed_before_stop, and sideEffects must be possible or committed', () => {
  no(tc({ stopStatus: 'stopped_no_side_effects' }), 'stopped_no_side_effects');
  no(tc({ stopStatus: 'completed_before_stop' }), 'completed_before_stop');
  no(tc({ sideEffects: 'none' }), 'sideEffects none');
  no(tc({ stopStatus: 'stopped_no_side_effects', sideEffects: 'none' }), 'both');
  ok(tc({ committedActions: [{ toolId: 'files.delete', observedState: obs('gone', 'committed'), certainty: 'committed' }, RUNNING], sideEffects: 'committed', sideEffectsCommitted: true, stopStatus: 'stopped_after_side_effects' }), 'committed + running');
  ok(tc({ committedActions: [{ toolId: 'files.delete', observedState: obs('gone', 'committed'), certainty: 'committed' }], sideEffects: 'committed', sideEffectsCommitted: true, stopStatus: 'completed_before_stop' }), 'completed_before_stop without a null entry is still fine');
});

test('2j (d): a missing observedState key (or undefined) is rejected; null must be explicit', () => {
  no(tc({ committedActions: [{ toolId: 'mail.send', certainty: 'possible' }] }), 'missing key');
  no(tc({ committedActions: [{ toolId: 'mail.send', observedState: undefined, certainty: 'possible' }] }), 'undefined');
});

test('2j (c): cancelReport names a still-running tool as unknown and never as done, for every stop status it can get', () => {
  for (const status of ['stopped_after_side_effects', 'stop_unconfirmed'] as const) {
    const r = cancelReport(status, 'possible', [RUNNING as never]);
    assert.match(r, /mail\.send \(still running when the stop was requested; its result is unknown\)/, status);
    assert.doesNotMatch(r, DONE_WORDS, status);
  }
  const both = cancelReport('stopped_after_side_effects', 'committed', [{ toolId: 'files.delete', observedState: obs('gone', 'committed'), certainty: 'committed' }, RUNNING as never]);
  assert.match(both, /files\.delete/);
  assert.match(both, /mail\.send \([^)]*unknown\)/);
});

test('2j truth table: decideStopStatus never gives completed_before_stop or stopped_no_side_effects while a side-effecting tool is still in flight', () => {
  for (const ack of [{ stopped: true }, { stopped: false }, undefined]) {
    for (const completedBeforeStop of [true, false]) {
      const s = decideStopStatus({ dispatched: true, ack, completedBeforeStop, sideEffects: 'possible', toolsInFlight: true });
      assert.ok(s !== 'completed_before_stop' && s !== 'stopped_no_side_effects', `${JSON.stringify(ack)} completed=${completedBeforeStop}: ${s}`);
    }
  }
  assert.equal(decideStopStatus({ dispatched: true, ack: { stopped: true }, completedBeforeStop: true, sideEffects: 'possible', toolsInFlight: true }), 'stop_unconfirmed', 'a completed run with an unreported tool: the stop is unconfirmed for that tool');
  assert.equal(decideStopStatus({ dispatched: true, ack: { stopped: true }, completedBeforeStop: true, sideEffects: 'committed', toolsInFlight: false }), 'completed_before_stop', 'unchanged without a running tool');
});

// ------------------------------------------------------------------ coordinator: stop requested while a tool is still running
async function stopWhileRunning(setup: (f: Fixture) => void, script: 'abort' | 'complete', cancelIn: 'EXECUTING' | 'VERIFYING' = 'EXECUTING', verifier?: VerifierPort) {
  const f = await fixture(verifier ? { verifier } : {});
  setup(f);
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    hooks.toolStarted({ toolId: 'mail.send', mayHaveSideEffects: true }); // never reports a result
    if (script === 'complete') return { status: 'completed', summary: 'Sent.' };
    await aborted;
    return { status: 'aborted' };
  });
  f.say('send the report to Sam', `req_2j_${Math.random()}`);
  await flush();
  assert.equal(f.c.state, cancelIn);
  f.c.cancelTask();
  await f.drain();
  return f;
}
function assertHonest(f: Fixture, label: string) {
  const ev = f.sink.of('TaskCancelled');
  assert.equal(ev.length, 1, `${label}: one TaskCancelled`);
  const r = validateEvent(ev[0]);
  assert.ok(r.ok, `${label}: ${r.ok ? '' : r.errors.join('; ')}`);
  const p = ev[0]!.payload;
  const entry = p.committedActions.find(a => a.toolId === 'mail.send');
  assert.ok(entry, `${label}: the running tool is listed`);
  assert.deepEqual([entry!.observedState, entry!.certainty], [null, 'possible'], `${label}: explicit null, possible`);
  assert.ok(Object.hasOwn(entry!, 'observedState'), `${label}: key present`);
  assert.ok(p.sideEffects === 'possible' || p.sideEffects === 'committed', `${label}: sideEffects ${p.sideEffects}`);
  assert.ok(p.stopStatus !== 'stopped_no_side_effects' && p.stopStatus !== 'completed_before_stop', `${label}: stopStatus ${p.stopStatus}`);
  for (const [where, text] of [['report', p.report], ['spoken', f.speech.spoken.map(s => s.text).join(' | ')]] as const) {
    assert.match(text, /mail\.send \([^)]*unknown\)/, `${label}: ${where} says the state is unknown`);
    assert.doesNotMatch(text, DONE_WORDS, `${label}: ${where} never calls it done`);
  }
  return p.stopStatus;
}

test('2j coordinator: stop while a tool is still running, every ack timing (0 ms, just under the timeout, stopped:false, never) meets (a)-(d)', async () => {
  const seen: Record<string, string> = {};
  for (const [label, setup] of [
    ['ack 0 ms', (f: Fixture) => { f.codex.cancelAck = { stopped: true }; }],
    ['ack 2999 ms', (f: Fixture) => { f.codex.cancelAck = { stopped: true }; f.codex.cancelAckDelayMs = 2_999; }],
    ['ack stopped:false', (f: Fixture) => { f.codex.cancelAck = { stopped: false }; }],
    ['ack never', (f: Fixture) => { f.codex.cancelAck = 'never'; }],
  ] as const) {
    const f = await stopWhileRunning(setup, 'abort');
    seen[label] = assertHonest(f, label);
  }
  assert.deepEqual(seen, { 'ack 0 ms': 'stopped_after_side_effects', 'ack 2999 ms': 'stopped_after_side_effects', 'ack stopped:false': 'stop_unconfirmed', 'ack never': 'stop_unconfirmed' });
});

test('2j coordinator: the run completed but the tool never reported (cancel during VERIFYING) is NOT completed_before_stop: stop_unconfirmed, unknown, never "finished"', async () => {
  let release!: () => void;
  const verifier: VerifierPort = { verify: (_i, signal) => new Promise(r => { release = () => r({ outcome: 'verified', verified: true, observedState: obs('ok') }); signal.addEventListener('abort', () => r({ outcome: 'unverified', verified: false, observedState: obs('aborted', 'none', false) })); }) };
  const f = await stopWhileRunning(() => {}, 'complete', 'VERIFYING', verifier);
  void release;
  assert.equal(assertHonest(f, 'completed run, tool unreported'), 'stop_unconfirmed');
});

test('2j coordinator: stop while a tool is still running AND a Codex approval is pending (PERMISSION_REQUIRED) meets (a)-(d); the approval is not approved', async () => {
  const { allowAllChannels, fileParams, hexId } = await import('./helpers.js');
  const f = await fixture({ policy: allowAllChannels });
  const answers: unknown[] = [];
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    hooks.toolStarted({ toolId: 'mail.send', mayHaveSideEffects: true });
    answers.push(await hooks.requestApproval({ actionId: hexId('2j_conf'), summary: 'Delete', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() }));
    await aborted;
    return { status: 'aborted' };
  });
  f.say('send it and clean up', 'req_2j_conf');
  await flush();
  await flush();
  assert.equal(f.c.state, 'PERMISSION_REQUIRED');
  f.c.cancelTask();
  await f.drain();
  assertHonest(f, 'PERMISSION_REQUIRED');
  assert.equal(answers.length, 1);
  assert.equal((answers[0] as { approved: boolean }).approved, false);
});

test('2j ledger: snapshot() hands out copies; changing an entry it returned never changes the next snapshot or the report', () => {
  const l = new SideEffectLedger();
  l.started({ toolId: 'mail.send', mayHaveSideEffects: true });
  l.started({ toolId: 'files.write', mayHaveSideEffects: true });
  l.result({ toolId: 'files.write', sideEffect: 'committed', observedState: obs('wrote notes.txt', 'committed') } as Parameters<SideEffectLedger['result']>[0]);
  const first = l.snapshot();
  for (const e of first) (e as { certainty: string }).certainty = 'possible';
  for (const e of first) (e as { observedState: unknown }).observedState = null;
  const second = l.snapshot();
  const w = second.find(e => e.toolId === 'files.write');
  const m = second.find(e => e.toolId === 'mail.send');
  assert.equal(w?.certainty, 'committed');
  assert.notEqual(w?.observedState, null);
  assert.equal(m?.observedState, null);
  assert.equal(m?.certainty, 'possible');
  assert.equal(l.summary(), 'committed');
});
