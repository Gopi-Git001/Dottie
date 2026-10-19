/**
 * Port delta D14 / test C-25 (tool-host-control.md DRAFT 8 §4.4, §4.6; E08 ruling 4 addition (2); E01-approved D14).
 *
 * "Any retry the user asks for is a brand-new action needing a fresh secure_ui approval. For non-read categories the
 * dialog must state 'this action may already have happened' before Approve is enabled ... Codex or the model can't
 * trigger the retry silently."
 *
 * Contract shape (E01, revised 2026-10-19): ApprovalRequested.possibleRepeat?: { priorTaskId; priorSideEffect:
 * 'possible' | 'unknown' }, taken from the prior task's ledger / ToolResult.sideEffect (never from an outcome or a
 * ToolError code). A user retry is identified by UtteranceReady.retryOfTaskId (ACCEPTED by E01 2026-10-19).
 * E01 follow-up rulings: priorSideEffect also 'committed' (precedence committed > unknown > possible, E01 2026-10-19); only side effects of
 * tools whose catalog category is not read/navigate count (ToolCatalogPort; a tool missing from the catalog counts);
 * the forced category is the prior's last approval category other than read/navigate, else local_change/high (1f b);
 * possibleRepeat.priorTaskId === the task's retryOfTaskId is a coordinator invariant (1f a), not a validator rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, type ApprovalCategory } from '../src/contracts.js';
import { createHash } from 'node:crypto';
import type { CodexApprovalRequest, PolicyPort } from '../src/ports.js';
import { PinnedToolCatalog } from '../src/toolCatalog.js';
import { allowAllChannels, approval, codexDisp, envelope, fixture, flush, hexId, obs, type Fixture, type Script, fileParams } from './helpers.js';

type F = Fixture;
let rs = 0;
/** A user-originated retry command ("try that again"), as E05/E06 would deliver it. */
function sayRetry(f: F, text: string, retryOfTaskId: string, requestId = `req_retry_${++rs}`) {
  f.c.handleWake(envelope('WakeDetected', { timestamp: '2026-10-18T13:00:00.000Z', deviceId: 'mic-1', confidence: 0.9 }));
  f.c.handleListeningStarted();
  f.c.handleCaptureEnded();
  return f.c.submitUtterance(envelope('UtteranceReady', { requestId, text, locale: 'en-US', endReason: 'vad_silence', retryOfTaskId }));
}

const del = (label = 'del'): CodexApprovalRequest => ({ actionId: hexId(label), summary: 'Delete old.log', risk: 'high', category: 'delete', toolId: 'files.delete', display: fileParams() });

/** Prior attempt: approved delete, tool result sideEffect 'unknown' (POSTCONDITION_UNKNOWN), turn fails. */
const priorUnknown: Script = async ({ hooks }) => {
  const d = await hooks.requestApproval(del('prior_del'));
  assert.equal(d.approved, true);
  hooks.toolStarted({ toolId: 'files.delete', mayHaveSideEffects: true });
  hooks.toolResult({ toolId: 'files.delete', observedState: obs('restart past send', 'unknown', false), verified: false, sideEffect: 'unknown', error: { code: 'POSTCONDITION_UNKNOWN', message: 'app server restarted after send', retryable: false } });
  return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'app server restarted' } };
};
/** Prior attempt: approved delete started (side-effecting) and never reported; turn fails → ledger 'possible'. */
const priorPossible: Script = async ({ hooks }) => {
  const d = await hooks.requestApproval(del('prior_del'));
  assert.equal(d.approved, true);
  hooks.toolStarted({ toolId: 'files.delete', mayHaveSideEffects: true });
  return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'transport lost' } };
};
/** Prior attempt: clean failure, nothing side-effecting started (ledger 'none'). */
const priorClean: Script = async () => ({ status: 'failed', error: { kind: 'fatal', origin: 'turn_failed', message: 'model error' } });

/** Run the prior task to its end, approving its Codex approval on secure_ui. Returns its taskId. */
async function runPrior(f: F, script: Script, text = 'delete old.log in downloads'): Promise<string> {
  f.codex.scripts.push(script);
  const r = f.say(text, `req_prior_${++rs}`);
  assert.equal(r.kind, 'started');
  await flush();
  const pending = f.sink.of('ApprovalRequested').filter(e => !f.sink.of('ApprovalResolved').some(x => x.payload.actionId === e.payload.actionId));
  for (const p of pending) f.c.resolveApproval(approval(p.payload.actionId, true, f), 'secure_ui');
  await f.drain();
  const fin = f.sink.of('TaskFinished').find(e => e.payload.taskId === (r as { taskId: string }).taskId) ?? f.sink.of('TaskCancelled').at(-1);
  assert.ok(fin, 'prior task ended');
  return (r as { taskId: string }).taskId;
}
const requestsFor = (f: F, taskId: string) => f.sink.of('ApprovalRequested').filter(e => e.payload.taskId === taskId).map(e => e.payload);
const allValid = (f: F) => {
  for (const e of f.sink.events) {
    const v = validateEvent(JSON.parse(JSON.stringify(e)));
    assert.ok(v.ok, `${e.type}: ${v.ok ? '' : v.errors.join(', ')}`);
  }
};

test('C-25 (D14): a non-read retry after a sideEffect:unknown attempt opens a fresh approval with possibleRepeat {priorTaskId, unknown} before anything is dispatched', async () => {
  const f = await fixture({ policy: allowAllChannels }); // policy would auto-dispatch (no pre-dispatch confirmation)
  const prior = await runPrior(f, priorUnknown);
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'failed_after_side_effects');
  const runsBefore = f.codex.runs.length;
  const priorReq = requestsFor(f, prior)[0]!;
  assert.equal(priorReq.possibleRepeat, undefined, 'the first attempt is not a repeat');

  f.codex.scripts.push(async ({ hooks }) => {
    const d = await hooks.requestApproval(del('retry_del'));
    assert.equal(d.approved, true);
    return { status: 'completed', summary: 'Deleted old.log.' };
  });
  const r = sayRetry(f, 'try that again', prior);
  assert.equal(r.kind, 'started');
  const retryTaskId = (r as { taskId: string }).taskId;
  assert.notEqual(retryTaskId, prior, 'the retry is a NEW taskId');
  await flush();
  assert.equal(f.c.state, 'CONFIRMING', 'forced pre-dispatch approval even though policy would auto-dispatch');
  assert.equal(f.codex.runs.length, runsBefore, 'nothing dispatched before the fresh approval');
  const gate = requestsFor(f, retryTaskId)[0]!;
  assert.deepEqual(gate.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'unknown' });
  assert.equal(gate.category, 'delete', 'category comes from the prior attempt\'s non-read approval');
  assert.notEqual(gate.actionId, priorReq.actionId, 'new actionId (CR2): the earlier approval never re-mints');

  f.c.resolveApproval(approval(gate.actionId, true, f), 'secure_ui');
  await flush();
  assert.equal(f.codex.runs.length, runsBefore + 1);
  assert.equal(f.codex.runs.at(-1)!.taskId, retryTaskId);
  assert.equal(f.codex.runs.at(-1)!.resume, false, 'a brand-new task, not a resume of the prior one');
  const inTurn = requestsFor(f, retryTaskId)[1]!;
  assert.deepEqual(inTurn.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'unknown' }, 'the Codex approval inside the retry is flagged too');
  f.c.resolveApproval(approval(inTurn.actionId, true, f), 'secure_ui');
  await f.drain();
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.taskId, retryTaskId);
  allValid(f);
});

test('C-25 (D14): the same after a ledger:possible attempt (catalogued side-effecting tool started, never reported) → priorSideEffect possible', async () => {
  const f = await fixture({ policy: allowAllChannels, toolCatalog: CATALOG });
  const prior = await runPrior(f, priorPossible);
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'failed_after_side_effects');
  const r = sayRetry(f, 'do it again', prior);
  await flush();
  const gate = requestsFor(f, (r as { taskId: string }).taskId)[0]!;
  assert.deepEqual(gate.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'possible' });
  allValid(f);
});

test('ruling 1j (c): a CANCELLED prior is not retryable: nothing starts, TaskFinished{failed, retry_not_allowed}, silent', async () => {
  const f = await fixture({ policy: allowAllChannels });
  f.codex.scripts.push(async ({ hooks, aborted }) => {
    hooks.toolStarted({ toolId: 'mail.send', mayHaveSideEffects: true });
    await aborted;
    return { status: 'aborted' };
  });
  const p = f.say('send the report to Sam', 'req_prior_cancel');
  const prior = (p as { taskId: string }).taskId;
  await flush();
  f.c.cancelTask();
  await f.drain();
  assert.equal(f.sink.of('TaskCancelled').at(-1)!.payload.sideEffects, 'possible');
  const runs = f.codex.runs.length, spoken = f.speech.spoken.length, requested = f.sink.of('TaskRequested').length;
  const r = sayRetry(f, 'try again', prior);
  await f.drain();
  const fin = f.sink.of('TaskFinished').at(-1)!.payload;
  assert.equal(fin.taskId, (r as { taskId: string }).taskId);
  assert.notEqual(fin.taskId, prior);
  assert.deepEqual([fin.outcome, fin.reason, fin.verified], ['failed', 'retry_not_allowed', false]);
  assert.equal(f.codex.runs.length, runs, 'no dispatch');
  assert.equal(f.speech.spoken.length, spoken, 'no speech');
  assert.equal(f.sink.of('TaskRequested').length, requested, 'no task started');
  assert.equal(f.sink.of('ApprovalRequested').length, 0);
  assert.equal(f.c.state, 'STANDBY');
  allValid(f);
});

test('C-25 (D14): a read-category retry gets no possibleRepeat (no warning), but still goes through approval', async () => {
  const readPolicy: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: (text: string) => (text.startsWith('show') ? { summary: 'Show old.log', risk: 'low', category: 'read' } : null) };
  const f = await fixture({ policy: readPolicy });
  const prior = await runPrior(f, priorUnknown);
  f.codex.scripts.push(async ({ hooks }) => {
    const d = await hooks.requestApproval({ actionId: hexId('retry_read'), summary: 'Open old.log', risk: 'low', category: 'read', display: fileParams() });
    assert.equal(d.approved, true);
    return { status: 'completed', summary: 'Shown.' };
  });
  const r = sayRetry(f, 'show it again', prior);
  const retryTaskId = (r as { taskId: string }).taskId;
  await flush();
  const gate = requestsFor(f, retryTaskId)[0]!;
  assert.equal(gate.category, 'read');
  assert.equal(gate.possibleRepeat, undefined);
  assert.ok(!('possibleRepeat' in gate));
  f.c.resolveApproval(approval(gate.actionId, true, f), 'secure_ui');
  await flush();
  const inTurn = requestsFor(f, retryTaskId)[1]!;
  assert.equal(inTurn.category, 'read');
  assert.ok(!('possibleRepeat' in inTurn), 'read approvals inside the retry carry no warning either');
  f.c.resolveApproval(approval(inTurn.actionId, true, f), 'secure_ui');
  await f.drain();
  allValid(f);
});

test('C-25 (D14): a retry after a clean failure (ledger none) has no possibleRepeat and keeps the normal policy path', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, priorClean);
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'failed');
  f.codex.scripts.push(async ({ hooks }) => {
    const d = await hooks.requestApproval(del('clean_retry_del'));
    assert.equal(d.approved, true);
    return { status: 'completed', summary: 'Deleted.' };
  });
  const r = sayRetry(f, 'try again', prior);
  const retryTaskId = (r as { taskId: string }).taskId;
  await flush();
  assert.equal(f.c.state, 'PERMISSION_REQUIRED', 'no forced CONFIRMING: dispatched under normal policy');
  const reqs = requestsFor(f, retryTaskId);
  assert.equal(reqs.length, 1);
  assert.ok(!('possibleRepeat' in reqs[0]!));
  f.c.resolveApproval(approval(reqs[0]!.actionId, true, f), 'secure_ui');
  await f.drain();
});

test('C-25 (D14, E01 ruling 4): a prior with only committed side effects now gets possibleRepeat {committed} and a forced approval', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'files.delete', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'files.delete', observedState: obs('deleted', 'committed', true), verified: true, sideEffect: 'committed' });
    return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'later step failed' } };
  });
  const runs = f.codex.runs.length;
  const r = sayRetry(f, 'again', prior);
  await flush();
  const reqs = requestsFor(f, (r as { taskId: string }).taskId);
  assert.equal(reqs.length, 1, 'forced pre-dispatch approval');
  assert.deepEqual(reqs[0]!.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'committed' });
  assert.equal(f.codex.runs.length, runs);
  f.c.resolveApproval(approval(reqs[0]!.actionId, false, f), 'secure_ui');
  await f.drain();
  allValid(f);
});

test('C-25 (D14, E01) precedence committed > unknown > possible: anything that definitely happened wins', async () => {
  const cases: [string, Script, string][] = [
    ['committed + unknown', async ({ hooks }) => {
      hooks.toolResult({ toolId: 'files.delete', observedState: obs('d', 'committed'), verified: true, sideEffect: 'committed' });
      hooks.toolResult({ toolId: 'mail.send', observedState: obs('?', 'unknown', false), verified: false, sideEffect: 'unknown', error: { code: 'POSTCONDITION_UNKNOWN', message: 'x', retryable: false } });
      return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
    }, 'committed'],
    ['committed + in-flight', async ({ hooks }) => {
      hooks.toolResult({ toolId: 'files.delete', observedState: obs('d', 'committed'), verified: true, sideEffect: 'committed' });
      hooks.toolStarted({ toolId: 'mail.send', mayHaveSideEffects: true });
      return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
    }, 'committed'],
    ['in-flight + unknown + committed', async ({ hooks }) => {
      hooks.toolStarted({ toolId: 'files.move', mayHaveSideEffects: true });
      hooks.toolResult({ toolId: 'files.delete', observedState: obs('d', 'committed'), verified: true, sideEffect: 'committed' });
      hooks.toolResult({ toolId: 'mail.send', observedState: obs('?', 'unknown', false), verified: false, sideEffect: 'unknown', error: { code: 'POSTCONDITION_UNKNOWN', message: 'x', retryable: false } });
      return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
    }, 'committed'],
    ['unknown + in-flight', async ({ hooks }) => {
      hooks.toolStarted({ toolId: 'files.move', mayHaveSideEffects: true });
      hooks.toolResult({ toolId: 'mail.send', observedState: obs('?', 'unknown', false), verified: false, sideEffect: 'unknown', error: { code: 'POSTCONDITION_UNKNOWN', message: 'x', retryable: false } });
      return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
    }, 'unknown'],
  ];
  for (const [why, script, want] of cases) {
    const f = await fixture({ policy: allowAllChannels });
    const prior = await runPrior(f, script);
    const r = sayRetry(f, 'again', prior);
    await flush();
    assert.equal(requestsFor(f, (r as { taskId: string }).taskId)[0]?.possibleRepeat?.priorSideEffect, want, why);
    f.c.resolveApproval(approval(requestsFor(f, (r as { taskId: string }).taskId)[0]!.actionId, false, f), 'secure_ui');
    await f.drain();
  }
});

test('validator (D14): possibleRepeat is accepted on a non-read ApprovalRequested and rejected on read, malformed, or the old priorOutcome shape', () => {
  const base = { taskId: 'task_2', actionId: hexId('v'), summary: 'Delete old.log', risk: 'high', expiry: '2026-10-19T07:01:00.000Z', category: 'delete' as ApprovalCategory, ...codexDisp('delete') };
  const ev = (payload: Record<string, unknown>) => validateEvent(JSON.parse(JSON.stringify({ ...envelope('ApprovalRequested', base as never), payload })));
  assert.ok(ev(base).ok, 'absent possibleRepeat is fine');
  assert.ok(ev({ ...base, possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'unknown' } }).ok);
  assert.ok(ev({ ...base, possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'possible' } }).ok);
  assert.ok(ev({ ...base, possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'committed' } }).ok, 'committed is accepted (E01 ruling 4)');
  const bad: [string, Record<string, unknown>][] = [
    ['on read', { ...base, category: 'read', ...codexDisp('read'), possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'unknown' } }],
    ['on navigate (E01 1g)', { ...base, category: 'navigate', ...codexDisp('navigate'), possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'unknown' } }],
    ['on navigate, committed (E01 1g)', { ...base, category: 'navigate', ...codexDisp('navigate'), possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'committed' } }],
    ['not an object', { ...base, possibleRepeat: true }],
    ['array', { ...base, possibleRepeat: [] }],
    ['null', { ...base, possibleRepeat: null }],
    ['missing priorTaskId', { ...base, possibleRepeat: { priorSideEffect: 'unknown' } }],
    ['empty priorTaskId', { ...base, possibleRepeat: { priorTaskId: '', priorSideEffect: 'unknown' } }],
    ['missing priorSideEffect', { ...base, possibleRepeat: { priorTaskId: 'task_1' } }],
    ['priorSideEffect none', { ...base, possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'none' } }],
    ['old priorOutcome shape', { ...base, possibleRepeat: { priorTaskId: 'task_1', priorOutcome: 'postcondition_unknown' } }],
    ['priorOutcome alongside', { ...base, possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'unknown', priorOutcome: 'failed_after_side_effects' } }],
    ['unknown key', { ...base, possibleRepeat: { priorTaskId: 'task_1', priorSideEffect: 'unknown', extra: 'x' } }],
    ['priorTaskId is the same task', { ...base, possibleRepeat: { priorTaskId: 'task_2', priorSideEffect: 'unknown' } }],
  ];
  for (const [why, payload] of bad) assert.equal(ev(payload).ok, false, why);
});

test('validator (D14, accepted): UtteranceReady.retryOfTaskId is an optional non-empty string', () => {
  const u = { requestId: 'r1', text: 'again', locale: 'en-US', endReason: 'vad_silence' };
  const ev = (payload: Record<string, unknown>) => validateEvent(JSON.parse(JSON.stringify({ ...envelope('UtteranceReady', u as never), payload })));
  assert.ok(ev(u).ok);
  assert.ok(ev({ ...u, retryOfTaskId: 'task_1' }).ok);
  for (const v of [42, '', null, {}, true]) assert.equal(ev({ ...u, retryOfTaskId: v }).ok, false, String(v));
});

test('C-25 (D14): a Codex/model auto-retry never happens: a side effect then a retryable turn failure → exactly one run, no approval, no possibleRepeat', async () => {
  const f = await fixture({ policy: allowAllChannels });
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'files.delete', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'files.delete', observedState: obs('?', 'unknown', false), verified: false, sideEffect: 'unknown', error: { code: 'POSTCONDITION_UNKNOWN', message: 'unknown', retryable: false } });
    return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'stream dropped' } };
  });
  f.say('delete old.log', 'req_auto');
  await f.drain();
  await f.clock.advance(120_000);
  await f.drain();
  assert.equal(f.codex.runs.length, 1, '§1.5: no automatic retry once the turn ledger is non-empty');
  assert.ok(!f.c.transitions.some(t => t.to === 'RECOVERING'));
  assert.equal(f.sink.of('ApprovalRequested').length, 0, 'no approval opened silently');
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'failed_after_side_effects');
  assert.equal(f.sink.of('TaskRequested').length, 1, 'no second task was started');
});

test('C-25 (D14): only the user retry field marks a repeat: an adapter-supplied possibleRepeat is dropped, and a new task without retryOfTaskId is not flagged', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, priorUnknown);
  f.codex.scripts.push(async ({ hooks }) => {
    const forged = { ...del('forged'), possibleRepeat: { priorTaskId: prior, priorSideEffect: 'unknown' } } as unknown as CodexApprovalRequest;
    await hooks.requestApproval(forged);
    return { status: 'completed', summary: 'Done.' };
  });
  await f.clock.advance(60_000);
  const r = f.say('delete old.log in downloads', 'req_fresh');
  assert.equal(r.kind, 'started');
  await flush();
  const reqs = requestsFor(f, (r as { taskId: string }).taskId);
  assert.equal(reqs.length, 1, 'no forced confirmation: not a user retry');
  assert.ok(!('possibleRepeat' in reqs[0]!), 'Codex can never set possibleRepeat');
  const strip = f.log.find('coordinator.input.field_stripped');
  assert.equal(strip.length, 1, 'the injected field is noticed (E01 1g/1h)');
  assert.deepEqual({ ...strip[0]!.fields }, { field: 'possibleRepeat', sourceChannel: 'codex', reason: 'untrusted_origin', taskId: reqs[0]!.taskId });
  assert.ok(!JSON.stringify(f.log.lines).includes(`"priorTaskId":"${prior}"`), 'the injected value is never logged'); 
  f.c.resolveApproval(approval(reqs[0]!.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('C-25 (D14): the possible-repeat approval is never auto-approved: deny → declined, expiry → declined, non-secure_ui channel rejected; nothing dispatched', async () => {
  for (const mode of ['deny', 'expire', 'voice', 'tray'] as const) {
    const f = await fixture({ policy: allowAllChannels }); // allowAllChannels accepts every channel: D14 still requires secure_ui
    const prior = await runPrior(f, priorUnknown);
    const runs = f.codex.runs.length;
    const r = sayRetry(f, 'again', prior);
    const retryTaskId = (r as { taskId: string }).taskId;
    await flush();
    const gate = requestsFor(f, retryTaskId)[0]!;
    assert.ok(gate.possibleRepeat, mode);
    if (mode === 'deny') assert.equal(f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui').kind, 'accepted');
    if (mode === 'voice' || mode === 'tray') {
      const res = f.c.resolveApproval(approval(gate.actionId, true, f), mode);
      assert.deepEqual(res, { kind: 'rejected', reason: 'channel_not_allowed' }, mode);
    }
    await f.drain(); // runs the 60 s expiry for expire/voice/tray
    assert.equal(f.codex.runs.length, runs, `${mode}: nothing dispatched`);
    const fin = f.sink.of('TaskFinished').at(-1)!.payload;
    assert.equal(fin.taskId, retryTaskId);
    assert.equal(fin.outcome, 'declined', mode);
  }
});

test('C-25 (D14): a non-secure_ui channel cannot approve a possible-repeat Codex approval inside the retry either', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, priorUnknown);
  f.codex.scripts.push(async ({ hooks }) => {
    const d = await hooks.requestApproval(del('retry_in_turn'));
    return d.approved ? { status: 'completed', summary: 'Deleted.' } : { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'declined' } };
  });
  const r = sayRetry(f, 'again', prior);
  const retryTaskId = (r as { taskId: string }).taskId;
  await flush();
  f.c.resolveApproval(approval(requestsFor(f, retryTaskId)[0]!.actionId, true, f), 'secure_ui');
  await flush();
  const inTurn = requestsFor(f, retryTaskId)[1]!;
  assert.ok(inTurn.possibleRepeat);
  assert.deepEqual(f.c.resolveApproval(approval(inTurn.actionId, true, f), 'voice'), { kind: 'rejected', reason: 'channel_not_allowed' });
  f.c.resolveApproval(approval(inTurn.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('C-25 (D14): dedupe/idempotency: a retry with the same text inside the dedupe window is NOT deduped against the prior task; a replayed retry requestId is', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, priorUnknown, 'delete old.log');
  // Same normalised text, well inside the 10 s window (the prior ran on the fake clock without advancing past it).
  const r = sayRetry(f, 'delete old.log', prior, 'req_retry_same');
  assert.equal(r.kind, 'started', 'explicit user retry bypasses the same-text window');
  const retryTaskId = (r as { taskId: string }).taskId;
  assert.notEqual(retryTaskId, prior);
  await flush();
  const gate = requestsFor(f, retryTaskId)[0]!;
  f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
  await f.drain();
  const replay = sayRetry(f, 'delete old.log', prior, 'req_retry_same');
  assert.deepEqual(replay, { kind: 'duplicate', originalTaskId: retryTaskId, reason: 'same_request_id' });
  const plain = f.say('delete old.log', 'req_plain_same');
  assert.equal(plain.kind, 'duplicate', 'a non-retry repeat of the same text inside the window is still deduped');
  assert.equal(f.sink.of('TaskRequested').filter(e => e.payload.taskId === retryTaskId).length, 1);
});

test('C-25 (D14): a retry naming a task the coordinator has no record of fails closed: treated as unknown, forced approval with the warning', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const r = sayRetry(f, 'retry that', 'task_from_before_restart');
  await flush();
  const gate = requestsFor(f, (r as { taskId: string }).taskId)[0]!;
  assert.deepEqual(gate.possibleRepeat, { priorTaskId: 'task_from_before_restart', priorSideEffect: 'unknown' });
  assert.equal(f.codex.runs.length, 0);
  f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
  await f.drain();
});

// ---------------------------------------------------------------- E01 follow-up rulings (4, 1f, trigger categories)
const CATALOG_JSON = JSON.stringify([
  { toolId: 'explorer.open_known_folder', category: 'navigate', scope: 'files.navigate' },
  { toolId: 'files.search', category: 'read', scope: 'files.read' },
  { toolId: 'files.delete', category: 'delete', scope: 'files.write' },
  { toolId: 'mail.send', category: 'external_send', scope: 'network.send' },
]);
const CATALOG_SHA = createHash('sha256').update(CATALOG_JSON, 'utf8').digest('hex');
const CATALOG = PinnedToolCatalog.fromPinned(CATALOG_JSON, CATALOG_SHA);
const navEffect = (sideEffect: 'unknown' | 'committed'): Script => async ({ hooks }) => {
  hooks.toolStarted({ toolId: 'explorer.open_known_folder', mayHaveSideEffects: true });
  hooks.toolResult({ toolId: 'explorer.open_known_folder', observedState: obs('nav', sideEffect, sideEffect === 'committed'), verified: sideEffect === 'committed', sideEffect, ...(sideEffect === 'unknown' ? { error: { code: 'POSTCONDITION_UNKNOWN' as const, message: 'x', retryable: false } } : {}) });
  hooks.toolStarted({ toolId: 'files.search', mayHaveSideEffects: true }); // read tool still in flight
  return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
};

test('C-25 (D14, E01 trigger categories): a prior whose side effects were only navigate/read gets no possibleRepeat and no forced approval', async () => {
  for (const se of ['unknown', 'committed'] as const) {
    const f = await fixture({ policy: allowAllChannels, toolCatalog: CATALOG });
    const prior = await runPrior(f, navEffect(se));
    assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'failed_after_side_effects', 'the ledger itself still reports the effects');
    const runs = f.codex.runs.length;
    const r = sayRetry(f, 'open it again', prior);
    await flush();
    assert.equal(requestsFor(f, (r as { taskId: string }).taskId).length, 0, `${se}: no forced approval`);
    assert.equal(f.codex.runs.length, runs + 1, `${se}: dispatched under normal policy`);
    await f.drain();
  }
});

test('C-25 (D14, E01 trigger categories): mixed navigate + delete counts only the delete (signal and category from the delete)', async () => {
  const f = await fixture({ policy: allowAllChannels, toolCatalog: CATALOG });
  const prior = await runPrior(f, async ({ hooks }) => {
    const d = await hooks.requestApproval(del('mixed_del'));
    assert.equal(d.approved, true);
    hooks.toolResult({ toolId: 'explorer.open_known_folder', observedState: obs('?', 'unknown', false), verified: false, sideEffect: 'unknown', error: { code: 'POSTCONDITION_UNKNOWN', message: 'x', retryable: false } });
    hooks.toolResult({ toolId: 'files.delete', observedState: obs('deleted', 'committed'), verified: true, sideEffect: 'committed' });
    return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
  });
  const r = sayRetry(f, 'again', prior);
  await flush();
  const gate = requestsFor(f, (r as { taskId: string }).taskId)[0]!;
  assert.deepEqual(gate.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'committed' }, 'the navigate unknown does not raise it to unknown');
  assert.equal(gate.category, 'delete');
  f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('C-25 (D14, E01 1j h): a tool missing from the catalog counts, as class unknown (fail closed)', async () => {
  const f = await fixture({ policy: allowAllChannels, toolCatalog: CATALOG });
  const prior = await runPrior(f, async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'mystery.tool', mayHaveSideEffects: true });
    return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
  });
  const r = sayRetry(f, 'again', prior);
  await flush();
  assert.deepEqual(requestsFor(f, (r as { taskId: string }).taskId)[0]?.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'unknown' }, 'an in-flight uncatalogued tool is raised from possible to unknown');
  f.c.resolveApproval(approval(requestsFor(f, (r as { taskId: string }).taskId)[0]!.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('C-25 (D14, E01 1f b): the forced category skips navigate and read: last approval navigate → the earlier delete; only navigate/read → local_change/high', async () => {
  const navApproval: CodexApprovalRequest = { actionId: hexId('nav_appr'), summary: 'Open Downloads', risk: 'low', category: 'navigate', toolId: 'explorer.open_known_folder', display: fileParams() };
  const readApproval: CodexApprovalRequest = { actionId: hexId('read_appr'), summary: 'Read old.log', risk: 'low', category: 'read', toolId: 'files.search', display: fileParams() };
  const mk = (approvals: CodexApprovalRequest[]): Script => async ({ hooks }) => {
    for (const a of approvals) assert.equal((await hooks.requestApproval(a)).approved, true);
    hooks.toolStarted({ toolId: 'files.delete', mayHaveSideEffects: true });
    return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
  };
  const approveAll = async (f: F) => {
    for (let i = 0; i < 5; i++) {
      await flush();
      for (const p of f.sink.of('ApprovalRequested').filter(e => !f.sink.of('ApprovalResolved').some(x => x.payload.actionId === e.payload.actionId))) {
        f.c.resolveApproval(approval(p.payload.actionId, true, f), 'secure_ui');
      }
    }
  };
  const cases: [string, CodexApprovalRequest[], { category: ApprovalCategory; risk: string }][] = [
    ['delete then navigate', [del('cat_del'), navApproval], { category: 'delete', risk: 'high' }],
    ['navigate only', [navApproval], { category: 'local_change', risk: 'high' }],
    ['read then navigate', [readApproval, navApproval], { category: 'local_change', risk: 'high' }],
  ];
  for (const [why, approvals, want] of cases) {
    const f = await fixture({ policy: allowAllChannels, toolCatalog: CATALOG });
    f.codex.scripts.push(mk(approvals));
    const p = f.say('tidy downloads', `req_cat_${++rs}`);
    await approveAll(f);
    await f.drain();
    const prior = (p as { taskId: string }).taskId;
    const r = sayRetry(f, 'again', prior);
    await flush();
    const gate = requestsFor(f, (r as { taskId: string }).taskId)[0]!;
    assert.equal(gate.category, want.category, why);
    assert.equal(gate.risk, want.risk, why);
    assert.deepEqual(gate.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'possible' }, why);
    f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
    await f.drain();
  }
});

test('C-25 (D14, E01 1f a): possibleRepeat.priorTaskId is the task the user named, not the most recent one (coordinator invariant)', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const older = await runPrior(f, priorUnknown, 'delete old.log');
  await f.clock.advance(60_000);
  const newer = await runPrior(f, priorPossible, 'delete new.log');
  const r = sayRetry(f, 'retry the first one', older);
  await flush();
  const gate = requestsFor(f, (r as { taskId: string }).taskId)[0]!;
  assert.notEqual(older, newer);
  assert.deepEqual(gate.possibleRepeat, { priorTaskId: older, priorSideEffect: 'unknown' });
  f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('C-25 (D14, E01 rule 1): a clean-failure retry gets no forced approval; a policy-produced approval for it carries no possibleRepeat', async () => {
  const confirmPolicy: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log', risk: 'high', category: 'delete' }) };
  const f = await fixture({ policy: confirmPolicy });
  f.codex.scripts.push(priorClean);
  const p = f.say('delete old.log', 'req_clean_prior');
  await flush();
  f.c.resolveApproval(approval(f.sink.of('ApprovalRequested')[0]!.payload.actionId, true, f), 'secure_ui');
  await f.drain();
  const prior = (p as { taskId: string }).taskId;
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'failed');
  const r = sayRetry(f, 'again', prior);
  await flush();
  const reqs = requestsFor(f, (r as { taskId: string }).taskId);
  assert.equal(reqs.length, 1, 'only the policy approval');
  assert.equal(reqs[0]!.category, 'delete');
  assert.ok(!('possibleRepeat' in reqs[0]!));
  f.c.resolveApproval(approval(reqs[0]!.actionId, false, f), 'secure_ui');
  await f.drain();
  allValid(f);
});

test('C-25 (D14, E01 1g): a navigate approval inside a possible-repeat retry carries no possibleRepeat (like read)', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, priorUnknown);
  f.codex.scripts.push(async ({ hooks }) => {
    await hooks.requestApproval({ actionId: hexId('retry_nav'), summary: 'Open Downloads', risk: 'low', category: 'navigate', toolId: 'explorer.open_known_folder', display: fileParams() });
    return { status: 'completed', summary: 'Opened.' };
  });
  const r = sayRetry(f, 'again', prior);
  const retryTaskId = (r as { taskId: string }).taskId;
  await flush();
  const gate = requestsFor(f, retryTaskId)[0]!;
  assert.ok(gate.possibleRepeat);
  f.c.resolveApproval(approval(gate.actionId, true, f), 'secure_ui');
  await flush();
  const nav = requestsFor(f, retryTaskId)[1]!;
  assert.equal(nav.category, 'navigate');
  assert.ok(!('possibleRepeat' in nav));
  f.c.resolveApproval(approval(nav.actionId, true, f), 'secure_ui');
  await f.drain();
  allValid(f);
});

// ---------------------------------------------------------------- E01: pinned catalog with P27 SHA-256 check; ruling 1j
test('catalog (E01): the coordinator catalog reads the pinned tool-catalog.json bytes and verifies the P27 SHA-256', () => {
  assert.equal(CATALOG.verified, true);
  assert.equal(CATALOG.categoryOf('explorer.open_known_folder'), 'navigate');
  assert.equal(CATALOG.categoryOf('files.delete'), 'delete');
  assert.equal(CATALOG.categoryOf('not.in.catalog'), undefined);
  assert.equal(PinnedToolCatalog.fromPinned(new TextEncoder().encode(CATALOG_JSON), CATALOG_SHA).categoryOf('files.search'), 'read', 'raw bytes work too');
  const bad: [string, string, string][] = [
    ['hash mismatch', CATALOG_JSON, CATALOG_SHA.replace(/^./, c => (c === '0' ? '1' : '0'))],
    ['pinned hash uppercase', CATALOG_JSON, CATALOG_SHA.toUpperCase()],
    ['pinned hash empty', CATALOG_JSON, ''],
    ['bytes edited, old pin', CATALOG_JSON.replace('navigate"', 'delete"'), CATALOG_SHA],
  ];
  const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
  for (const t of ['not json', '{"files.delete":{"category":"delete","scope":"files.write"}}', '[{"toolId":"a","category":"read"}]', '[{"toolId":"a","category":"read","scope":"s","extra":"x"}]', '[{"toolId":"a","category":"read","scope":"s"},{"toolId":"a","category":"delete","scope":"s"}]']) bad.push([`malformed: ${t.slice(0, 20)}`, t, sha(t)]);
  for (const [why, text, pin] of bad) {
    const c = PinnedToolCatalog.fromPinned(text, pin);
    assert.equal(c.verified, false, why);
    for (const id of ['explorer.open_known_folder', 'files.search', 'files.delete', 'a']) assert.equal(c.categoryOf(id), undefined, `${why}: fail closed`);
  }
  const odd = '[{"toolId":"x.tool","category":"teleport","scope":"s"}]';
  assert.equal(PinnedToolCatalog.fromPinned(odd, sha(odd)).categoryOf('x.tool'), undefined, 'a category outside the §3 enum → mutating');
});

test('catalog (E01): a hash mismatch makes every tool count for D14 (navigate-only prior now triggers), like no catalog', async () => {
  const tampered = PinnedToolCatalog.fromPinned(CATALOG_JSON, '0'.repeat(64));
  for (const catalog of [tampered, undefined]) {
    const f = await fixture({ policy: allowAllChannels, ...(catalog ? { toolCatalog: catalog } : {}) });
    const prior = await runPrior(f, navEffect('unknown'));
    const r = sayRetry(f, 'open it again', prior);
    await flush();
    const gate = requestsFor(f, (r as { taskId: string }).taskId)[0];
    assert.deepEqual(gate?.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'unknown' }, catalog ? 'mismatch: fail closed' : 'no catalog: fail closed');
    f.c.resolveApproval(approval(gate!.actionId, false, f), 'secure_ui');
    await f.drain();
  }
});

test('ruling 1j (a): a tray retry ("Retry the last task." + retryOfTaskId) starts the new task on the prior task\'s threadId', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, async (ctx) => { ctx.hooks.threadAssigned('thr_prior'); return priorClean(ctx); }, 'rename the report');
  const r = f.c.submitUtterance((() => {
    f.c.handleWake(envelope('WakeDetected', { timestamp: '2026-10-18T13:00:00.000Z', deviceId: 'tray', confidence: 1 }));
    f.c.handleListeningStarted();
    f.c.handleCaptureEnded();
    return envelope('UtteranceReady', { requestId: 'req_tray_retry', text: 'Retry the last task.', locale: 'en-US', endReason: 'tray', retryOfTaskId: prior });
  })());
  assert.equal(r.kind, 'started');
  await f.drain();
  const run = f.codex.runs.at(-1)!;
  assert.equal(run.taskId, (r as { taskId: string }).taskId);
  assert.notEqual(run.taskId, prior);
  assert.equal(run.threadId, 'thr_prior', 'Codex sees the original request on the prior thread');
  assert.equal(run.text, 'Retry the last task.');
  assert.equal(run.turnKind, 'initial');
  assert.ok(!JSON.stringify(f.log.lines).includes('rename the report'), 'no utterance text is stored or logged');
  allValid(f);
});

test('ruling 1j (a): a retry of a prior that never got a thread starts without threadId', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await runPrior(f, priorClean);
  sayRetry(f, 'Retry the last task.', prior);
  await f.drain();
  assert.equal(f.codex.runs.at(-1)!.threadId, undefined);
});

test('ruling 1j (b): a partial prior (verifier partially_verified after a committed effect) is retryable and gets possibleRepeat committed', async () => {
  const verifier = { verify: async () => ({ outcome: 'partially_verified' as const, verified: false, observedState: obs('half', 'committed', false) }) };
  const f = await fixture({ policy: allowAllChannels, verifier });
  const prior = await runPrior(f, async ({ hooks }) => {
    hooks.toolResult({ toolId: 'files.delete', observedState: obs('d', 'committed'), verified: true, sideEffect: 'committed' });
    return { status: 'completed', summary: 'Deleted some.' };
  });
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'partial');
  const r = sayRetry(f, 'Retry the last task.', prior);
  await flush();
  assert.deepEqual(requestsFor(f, (r as { taskId: string }).taskId)[0]?.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'committed' });
  f.c.resolveApproval(approval(requestsFor(f, (r as { taskId: string }).taskId)[0]!.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('ruling 1j (c)(d): endReason tray validates; failed_after_side_effects + approval_unavailable is a valid TaskFinished pair', () => {
  assert.ok(validateEvent(envelope('UtteranceReady', { requestId: 'r', text: 'Retry the last task.', locale: 'en-US', endReason: 'tray', retryOfTaskId: 'task_1' } as never)).ok);
  assert.equal(validateEvent({ ...envelope('UtteranceReady', { requestId: 'r', text: 'x', locale: 'en-US', endReason: 'vad_silence' }), payload: { requestId: 'r', text: 'x', locale: 'en-US', endReason: 'clicked' } }).ok, false);
  assert.ok(validateEvent(envelope('TaskFinished', { taskId: 't', outcome: 'failed_after_side_effects', verified: false, summary: 's', reason: 'approval_unavailable' })).ok);
});

// ---------------------------------------------------------------- E01 final retry set (supersedes 1j b)
type Outcome = 'succeeded' | 'answered' | 'declined' | 'blocked_auth' | 'clarification' | 'failed' | 'failed_after_side_effects' | 'unverified' | 'partial' | 'blocked_unavailable';
async function priorWith(outcome: Outcome): Promise<{ f: F; prior: string }> {
  const confirm: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: (t: string) => (t === 'declined task' ? { summary: 'Do it', risk: 'high', category: 'delete' } : null) };
  const verifier = outcome === 'partial' ? { verify: async () => ({ outcome: 'partially_verified' as const, verified: false, observedState: obs('half', 'none', false) }) } : undefined;
  const f = await fixture({ policy: confirm, toolCatalog: CATALOG, ...(verifier ? { verifier } : {}) });
  let text = 'some task';
  switch (outcome) {
    case 'succeeded': f.codex.scripts.push(async ({ hooks }) => { hooks.toolResult({ toolId: 'files.search', observedState: obs('ok'), verified: true, sideEffect: 'none' }); return { status: 'completed', summary: 'ok' }; }); break;
    case 'answered': f.codex.scripts.push(async () => ({ status: 'completed', summary: 'It is 3pm.' })); break;
    case 'declined': text = 'declined task'; break;
    case 'blocked_auth': f.codex.auth = 'signed_out'; break;
    case 'blocked_unavailable': f.codex.auth = 'unavailable'; break;
    case 'clarification': f.codex.scripts.push(async ({ hooks }) => { hooks.toolResult({ toolId: 'files.search', observedState: obs('two', 'none', false, { decision: 'ask_user', question: 'Which one?' }), verified: false, sideEffect: 'none', error: { code: 'AMBIGUOUS', message: 'two', retryable: false } }); return { status: 'completed', summary: 'Which one?' }; }); break;
    case 'failed': f.codex.scripts.push(priorClean); break;
    case 'failed_after_side_effects': f.codex.scripts.push(priorUnknown); break;
    case 'unverified': f.codex.scripts.push(async ({ hooks }) => { hooks.toolResult({ toolId: 'files.delete', observedState: obs('?', 'committed', false), verified: false, sideEffect: 'committed', error: { code: 'POSTCONDITION_FAILED', message: 'x', retryable: false } }); return { status: 'completed', summary: 'done?' }; }); break;
    case 'partial': f.codex.scripts.push(async () => ({ status: 'completed', summary: 'partly' })); break;
  }
  const p = f.say(text, `req_set_${++rs}`);
  await flush();
  for (const e of f.sink.of('ApprovalRequested')) f.c.resolveApproval(approval(e.payload.actionId, outcome !== 'declined', f), 'secure_ui');
  await f.drain();
  f.codex.auth = 'signed_in';
  f.c.handleAuthChanged('signed_in');
  const prior = (p as { taskId: string }).taskId;
  const last = f.sink.of('TaskFinished').filter(e => e.payload.taskId === prior).at(-1)!.payload;
  const want = outcome === 'clarification' ? 'failed' : outcome === 'partial' && !verifier ? 'answered' : outcome;
  assert.equal(last.outcome, want, `fixture produced ${outcome}`);
  if (outcome === 'clarification') assert.equal(last.reason, 'clarification_timeout');
  return { f, prior };
}

for (const outcome of ['succeeded', 'answered', 'declined', 'blocked_auth', 'clarification'] as const) {
  test(`E01 retry set: a '${outcome}' prior is not retryable → TaskFinished{failed, retry_not_allowed}, no dispatch, no speech`, async () => {
    const { f, prior } = await priorWith(outcome);
    const runs = f.codex.runs.length, spoken = f.speech.spoken.length;
    const r = sayRetry(f, 'Retry the last task.', prior);
    await f.drain();
    const fin = f.sink.of('TaskFinished').at(-1)!.payload;
    assert.equal(fin.taskId, (r as { taskId: string }).taskId);
    assert.deepEqual([fin.outcome, fin.reason], ['failed', 'retry_not_allowed']);
    assert.equal(f.codex.runs.length, runs);
    assert.equal(f.speech.spoken.length, spoken);
    allValid(f);
  });
}

for (const outcome of ['failed', 'failed_after_side_effects', 'unverified', 'partial', 'blocked_unavailable'] as const) {
  test(`E01 retry set: a '${outcome}' prior is retryable (a task starts)`, async () => {
    const { f, prior } = await priorWith(outcome);
    const r = sayRetry(f, 'Retry the last task.', prior);
    await flush();
    const id = (r as { taskId: string }).taskId;
    assert.equal(f.sink.of('TaskRequested').filter(e => e.payload.taskId === id).length, 1);
    assert.ok(!f.sink.of('TaskFinished').some(e => e.payload.taskId === id && e.payload.reason === 'retry_not_allowed'));
    const gate = requestsFor(f, id)[0];
    if (outcome === 'failed' || outcome === 'blocked_unavailable' || outcome === 'partial') assert.equal(gate, undefined, `${outcome}: clean prior → normal policy, no forced approval`);
    else assert.ok(gate?.possibleRepeat, `${outcome}: side effects → forced approval`);
    if (gate) f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
    await f.drain();
  });
}

test('E01 retry set: retry_not_allowed pairs only with failed in validateEvent', () => {
  assert.ok(validateEvent(envelope('TaskFinished', { taskId: 't', outcome: 'failed', verified: false, summary: 's', reason: 'retry_not_allowed' })).ok);
  for (const outcome of ['declined', 'failed_after_side_effects', 'blocked_auth', 'succeeded'] as const) {
    assert.equal(validateEvent(envelope('TaskFinished', { taskId: 't', outcome, verified: false, summary: 's', reason: 'retry_not_allowed' })).ok, false, outcome);
  }
});

test('E01 retry set: a ToolCatalogPort lookup that throws counts as unknown', async () => {
  const throwing = PinnedToolCatalog.fromPinned(CATALOG_JSON, CATALOG_SHA);
  (throwing as unknown as { categoryOf: (id: string) => never }).categoryOf = () => { throw new Error('catalog read failed'); };
  const f = await fixture({ policy: allowAllChannels, toolCatalog: throwing });
  const prior = await runPrior(f, navEffect('committed'));
  const r = sayRetry(f, 'again', prior);
  await flush();
  const gate = requestsFor(f, (r as { taskId: string }).taskId)[0];
  assert.deepEqual(gate?.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'committed' }, 'committed still wins (committed > unknown)');
  f.c.resolveApproval(approval(gate!.actionId, false, f), 'secure_ui');
  await f.drain();
  const g = await fixture({ policy: allowAllChannels, toolCatalog: throwing });
  const prior2 = await runPrior(g, async ({ hooks }) => { hooks.toolStarted({ toolId: 'explorer.open_known_folder', mayHaveSideEffects: true }); return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } }; });
  const r2 = sayRetry(g, 'again', prior2);
  await flush();
  assert.deepEqual(requestsFor(g, (r2 as { taskId: string }).taskId)[0]?.possibleRepeat, { priorTaskId: prior2, priorSideEffect: 'unknown' }, 'a navigate tool whose lookup threw counts, as unknown');
  g.c.resolveApproval(approval(requestsFor(g, (r2 as { taskId: string }).taskId)[0]!.actionId, false, g), 'secure_ui');
  await g.drain();
});

test('E01 (1j/1o): a joined (duplicate) Codex approval keeps the FIRST expiry and one ApprovalRequested; the joined request itself is declined duplicate_request (1o c)', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const decisions: string[] = [];
  f.codex.scripts.push(async ({ hooks }) => {
    const first = hooks.requestApproval(del('join'));
    await f.clock.advance(30_000);
    const second = hooks.requestApproval(del('join'));
    decisions.push(...(await Promise.all([first, second])).map(d => d.reason));
    return { status: 'completed', summary: 'ok' };
  });
  f.say('delete old.log', 'req_join');
  await flush();
  await flush();
  const reqs = f.sink.of('ApprovalRequested');
  assert.equal(reqs.length, 1, 'the duplicate joins; no second dialog');
  const expiry = Date.parse(reqs[0]!.payload.expiry);
  await f.clock.advance(30_000); // 60 s after the FIRST request
  await flush();
  assert.deepEqual(decisions, ['expired', 'duplicate_request'], 'the first expired at its own expiry, not 60 s after the join; the join was declined');
  assert.ok(f.clock.now() >= expiry);
  assert.equal(f.sink.of('ApprovalResolved').length, 1);
  await f.drain();
});

test('E01 (old "partial" semantics must not leak): side effects then a failure classifies as failed_after_side_effects, never partial, signal committed/possible', async () => {
  for (const [script, want] of [[priorPossible, 'possible'], [async ({ hooks }: Parameters<Script>[0]) => {
    hooks.toolResult({ toolId: 'files.delete', observedState: obs('d', 'committed'), verified: true, sideEffect: 'committed' });
    return { status: 'failed' as const, error: { kind: 'fatal' as const, origin: 'adapter' as const, message: 'x' } };
  }, 'committed']] as const) {
    const f = await fixture({ policy: allowAllChannels, toolCatalog: CATALOG });
    const prior = await runPrior(f, script as Script);
    const fin = f.sink.of('TaskFinished').at(-1)!.payload;
    assert.equal(fin.outcome, 'failed_after_side_effects');
    assert.notEqual(fin.outcome, 'partial');
    const r = sayRetry(f, 'again', prior);
    await flush();
    const gate = requestsFor(f, (r as { taskId: string }).taskId)[0]!;
    assert.equal(gate.possibleRepeat?.priorSideEffect, want);
    f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
    await f.drain();
  }
});

// ---------------------------------------------------------------- E01 1l
test('E01 1l (2): retry of an UNVERIFIED prior with an empty ledger follows normal policy (no possibleRepeat, no forced approval)', async () => {
  const verifier = { verify: async () => ({ outcome: 'unverified' as const, verified: false, observedState: obs('?', 'none', false) }) };
  const f = await fixture({ policy: allowAllChannels, toolCatalog: CATALOG, verifier });
  const prior = await runPrior(f, async () => ({ status: 'completed', summary: 'done?' }));
  assert.equal(f.sink.of('TaskFinished').at(-1)!.payload.outcome, 'unverified');
  const r = sayRetry(f, 'Retry the last task.', prior);
  await f.drain();
  const id = (r as { taskId: string }).taskId;
  assert.equal(requestsFor(f, id).length, 0, 'no forced approval');
  assert.equal(f.sink.of('TaskRequested').filter(e => e.payload.taskId === id).length, 1, 'the retry ran');
  assert.ok(!f.sink.of('ApprovalRequested').some(e => e.payload.possibleRepeat !== undefined));
  allValid(f);
});

test('E01 1l (1): a failed categoryOf lookup never supplies the forced category → local_change / high', async () => {
  const throwing = PinnedToolCatalog.fromPinned(CATALOG_JSON, CATALOG_SHA);
  (throwing as unknown as { categoryOf: (id: string) => never }).categoryOf = () => { throw new Error('catalog read failed'); };
  for (const cat of [throwing, PinnedToolCatalog.fromPinned(CATALOG_JSON, '0'.repeat(64))]) {
    const f = await fixture({ policy: allowAllChannels, toolCatalog: cat });
    const prior = await runPrior(f, async ({ hooks }) => {
      hooks.toolStarted({ toolId: 'explorer.open_known_folder', mayHaveSideEffects: true });
      return { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'x' } };
    });
    const r = sayRetry(f, 'again', prior);
    await flush();
    const gate = requestsFor(f, (r as { taskId: string }).taskId)[0]!;
    assert.deepEqual([gate.category, gate.risk, gate.possibleRepeat?.priorSideEffect], ['local_change', 'high', 'unknown']);
    f.c.resolveApproval(approval(gate.actionId, false, f), 'secure_ui');
    await f.drain();
  }
});

test('E01 1o (c) (supersedes 1k c for Codex): a join after an approved or expired answer is declined duplicate_request (never replayed) and never reopens the dialog', async () => {
  for (const [label, settle, want] of [['approved', true, ['duplicate_request', false]], ['expired', null, ['duplicate_request', false]]] as const) {
    const f = await fixture({ policy: allowAllChannels });
    const late: Array<[string, boolean]> = [];
    f.codex.scripts.push(async ({ hooks }) => {
      await hooks.requestApproval(del(`late_${label}`));
      const d = await hooks.requestApproval(del(`late_${label}`));
      late.push([d.reason, d.approved]);
      return { status: 'completed', summary: 'ok' };
    });
    f.say('delete old.log', `req_late_${label}`);
    await flush();
    await flush();
    const first = f.sink.of('ApprovalRequested')[0]!;
    if (settle) f.c.resolveApproval(approval(first.payload.actionId, true, f), 'secure_ui');
    else await f.clock.advance(60_000);
    await f.drain();
    assert.equal(f.sink.of('ApprovalRequested').length, 1, `${label}: no second dialog`);
    assert.deepEqual(late, [want], label);
    assert.equal(f.codex.runs.length, 1);
  }
});

// ---------------------------------------------------------------- E01 1m (2) (announced; not yet in CONTRACTS HEAD e93907c)
test('E01 1m (2): the C-08 timeout emits ApprovalResolved{approved:false} exactly once, before TaskFinished; a late approve has no effect', async () => {
  const confirm: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log', risk: 'high', category: 'delete' }) };
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_expire_once');
  await flush();
  const req = f.sink.of('ApprovalRequested')[0]!;
  await f.clock.advance(60_000);
  await f.drain();
  const resolved = f.sink.events.filter(e => e.type === 'ApprovalResolved');
  assert.equal(resolved.length, 1);
  assert.deepEqual([resolved[0]!.payload.actionId, resolved[0]!.payload.approved], [req.payload.actionId, false]);
  const order = f.sink.events.map(e => e.type);
  assert.ok(order.indexOf('ApprovalResolved') < order.indexOf('TaskFinished'), 'expired before TaskFinished');
  const late = f.c.resolveApproval(approval(req.payload.actionId, true, f), 'secure_ui');
  assert.equal(late.kind, 'rejected');
  await f.drain();
  assert.equal(f.codex.runs.length, 0, 'nothing dispatched');
  assert.equal(f.sink.events.filter(e => e.type === 'ApprovalResolved').length, 1, 'no second ApprovalResolved');
  allValid(f);
});
