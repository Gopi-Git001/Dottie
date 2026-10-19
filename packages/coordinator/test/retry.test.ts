/**
 * Retry rule (CONTRACTS §1.5, E01 2026-10-19, from E09's live wire run on Codex 0.163.0):
 * - JSON-RPC errors are always -32600 with no data → fatal, never retried (origin 'rpc_error'); a rejected turn/start
 *   is therefore never retried. Adapter-internal failures (thrown run(), abort without cancel) are not wire turn
 *   failures either and are never retried.
 * - Retry ONLY a turn/completed{failed} (origin 'turn_failed') classified rate_limited|transient, when THAT turn
 *   started no side-effecting item, and attempt < maxAttempts. Each retry gets a new turnId/clientUserMessageId.
 * - 401 (httpConnectionFailed{401} after ~14 s of willRetry) arrives as kind 'auth': never retried.
 * - plan_limit: never retried.
 * - error{willRetry:true} → hooks.codexRetrying() → TaskProgress{state:RECOVERING, "Reconnecting…"} only.
 * - Codex does NOT dedupe clientUserMessageId: idempotency is local (one run() at a time, requestId/text dedupe).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetry, DEFAULT_RETRY_POLICY } from '../src/retry.js';
import { validateEvent } from '../src/contracts.js';
import type { CodexRunResult } from '../src/ports.js';
import { fixture, flush, obs, utterance } from './helpers.js';
import type { RunCtx } from './helpers.js';

const accepted = (f: Awaited<ReturnType<typeof fixture>>) => f.c.transitions.filter(t => t.accepted).map(t => t.to);
const fail = (kind: 'transient' | 'rate_limited' | 'plan_limit' | 'auth' | 'fatal', origin: 'turn_failed' | 'rpc_error' | 'adapter' = 'turn_failed') =>
  async (): Promise<CodexRunResult> => ({ status: 'failed', error: { kind, origin, message: `${kind} via ${origin}` } });

test('§1.5 shouldRetry: only turn_failed rate_limited/transient with an empty turn ledger and attempt < max', () => {
  const p = DEFAULT_RETRY_POLICY; // maxAttempts 3
  assert.equal(shouldRetry(p, 1, { kind: 'transient', origin: 'turn_failed' }, true), true);
  assert.equal(shouldRetry(p, 2, { kind: 'rate_limited', origin: 'turn_failed' }, true), true);
  assert.equal(shouldRetry(p, 3, { kind: 'transient', origin: 'turn_failed' }, true), false, 'capped');
  assert.equal(shouldRetry(p, 1, { kind: 'transient', origin: 'turn_failed' }, false), false, 'turn started a side-effecting item');
  for (const origin of ['rpc_error', 'adapter'] as const) {
    for (const kind of ['transient', 'rate_limited'] as const) assert.equal(shouldRetry(p, 1, { kind, origin }, true), false, `${kind} via ${origin}`);
  }
  for (const kind of ['auth', 'plan_limit', 'fatal'] as const) assert.equal(shouldRetry(p, 1, { kind, origin: 'turn_failed' }, true), false, kind);
});

test('§1.5: a rejected turn/start (JSON-RPC -32600, no data) is fatal and never retried, even if mislabelled transient', async () => {
  for (const kind of ['transient', 'rate_limited', 'fatal'] as const) {
    const f = await fixture();
    f.codex.defaultScript = fail(kind, 'rpc_error');
    f.say(`open downloads ${kind}`);
    await f.drain();
    assert.equal(f.codex.runs.length, 1, `${kind}: one turn/start, no retry`);
    assert.ok(!accepted(f).includes('RECOVERING'), kind);
    const fin = f.sink.of('TaskFinished')[0]!.payload;
    assert.equal(fin.outcome, 'failed');
    assert.match(fin.summary, /Reason: fatal/, `${kind}: rpc errors are reported as fatal`);
  }
});

test('§1.5: adapter-side failures (run() throws, run aborted without a cancel) are not wire turn failures: no retry', async () => {
  const f = await fixture();
  f.codex.defaultScript = async () => { throw new Error('adapter crashed'); };
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'failed');

  const g = await fixture();
  g.codex.defaultScript = async () => ({ status: 'aborted' });
  g.say('open downloads');
  await g.drain();
  assert.equal(g.codex.runs.length, 1);
  assert.equal(g.sink.of('TaskFinished')[0]!.payload.outcome, 'failed');
});

test('§1.5: a failed turn whose ledger is not empty is never retried (committed, unknown, or a side-effecting item merely started)', async () => {
  const cases: [string, (ctx: RunCtx) => void, string][] = [
    ['committed', ({ hooks }) => hooks.toolResult({ toolId: 'files.move', observedState: obs('moved', 'committed'), verified: true, sideEffect: 'committed' }), 'failed_after_side_effects'],
    ['unknown', ({ hooks }) => hooks.toolResult({ toolId: 'mail.send', observedState: obs('?', 'unknown', false), verified: false, error: { code: 'POSTCONDITION_UNKNOWN', message: 'm', retryable: false }, sideEffect: 'unknown' }), 'failed_after_side_effects'],
    ['started only', ({ hooks }) => { hooks.toolStarted({ toolId: 'files.move', mayHaveSideEffects: true }); hooks.toolResult({ toolId: 'files.move', observedState: obs('nothing moved'), verified: true, sideEffect: 'none' }); }, 'failed'],
  ];
  for (const [label, act, outcome] of cases) {
    const f = await fixture();
    f.codex.defaultScript = async ctx => { act(ctx); return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'socket closed' } }; };
    f.say(`do it ${label}`);
    await f.drain();
    assert.equal(f.codex.runs.length, 1, `${label}: no retry`);
    assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, outcome, label);
  }
});

test('§1.5: a read-only tool in the failed turn does not block the retry (ledger empty)', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'files.read', mayHaveSideEffects: false });
    hooks.toolResult({ toolId: 'files.read', observedState: obs('read'), verified: true, sideEffect: 'none' });
    return { status: 'failed', error: { kind: 'rate_limited', origin: 'turn_failed', message: 'rateLimitExceeded' } };
  });
  f.say('read it');
  await f.drain();
  assert.equal(f.codex.runs.length, 2);
  assert.equal(f.codex.runs[1]!.turnKind, 'retry');
});

test('§1.5: attempts are capped at maxAttempts; every retry has its own turnId and clientUserMessageId', async () => {
  const f = await fixture({ config: { retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 400, jitterRatio: 0 } } });
  f.codex.defaultScript = fail('transient');
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 3);
  const id = f.codex.runs[0]!.taskId;
  assert.deepEqual(f.codex.runs.map(r => r.turnId), [`${id}.t1`, `${id}.t2`, `${id}.t3`]);
  assert.deepEqual(f.codex.runs.map(r => r.clientUserMessageId), [`${id}.t1`, `${id}.t2`, `${id}.t3`]);
  assert.deepEqual(f.codex.runs.map(r => r.attempt), [1, 2, 3]);
  assert.deepEqual(f.codex.runs.map(r => r.idempotencyKey), [id, id, id]);
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.equal(fin.outcome, 'failed');
  assert.match(fin.summary, /tried 3 times/);
});

test('§1.5: a 401 (willRetry notifications, then turn/completed failed → auth) is never retried; only "Reconnecting…" is shown', async () => {
  const f = await fixture();
  f.codex.defaultScript = async ({ hooks }) => {
    for (let i = 0; i < 5; i++) hooks.codexRetrying(); // ~14 s of error{willRetry:true, httpConnectionFailed{401}}
    return { status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: 'httpConnectionFailed 401 unauthorized' } };
  };
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1, 'auth never retried by Dottie');
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['blocked_auth', 'auth_required']);
  const reconnecting = f.sink.of('TaskProgress').filter(e => e.payload.redactedMetadata['codexRetrying'] === true);
  assert.equal(reconnecting.length, 1, 'one "Reconnecting…" per burst, not one per notification');
  assert.equal(reconnecting[0]!.payload.state, 'RECOVERING');
  assert.equal(reconnecting[0]!.payload.message, 'Reconnecting…');
  for (const e of f.sink.of('TaskProgress')) assert.doesNotMatch(e.payload.message, /401|unauthori[sz]ed|httpConnection/i, 'no raw error detail in progress');
  assert.equal(f.c.state, 'AUTH_REQUIRED');
});

test('§1.5: a 401 after a committed action ends failed_after_side_effects with reason auth_required, no retry', async () => {
  const f = await fixture();
  f.codex.defaultScript = async ({ hooks }) => {
    hooks.toolResult({ toolId: 'files.move', observedState: obs('moved', 'committed'), verified: true, sideEffect: 'committed' });
    hooks.codexRetrying();
    return { status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: '401' } };
  };
  f.say('move it');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed_after_side_effects', 'auth_required']);
});

test('§1.5: plan_limit is never retried, whatever the origin', async () => {
  for (const origin of ['turn_failed', 'rpc_error'] as const) {
    const f = await fixture();
    f.codex.defaultScript = fail('plan_limit', origin);
    f.say(`open downloads ${origin}`);
    await f.drain();
    assert.equal(f.codex.runs.length, 1, origin);
    assert.ok(!accepted(f).includes('RECOVERING'), origin);
  }
});

test('§1.5: willRetry shows only "Reconnecting…" (state RECOVERING), once per burst; the task keeps running in EXECUTING and nothing is spoken', async () => {
  const f = await fixture({ config: { acknowledgeOnDispatch: false } });
  let release!: () => void;
  f.codex.defaultScript = async ({ hooks }) => {
    hooks.codexRetrying();
    hooks.codexRetrying();
    hooks.progress('Opening Explorer');
    hooks.codexRetrying(); // a second burst after real progress
    await new Promise<void>(r => (release = r));
    return { status: 'completed', summary: 'Downloads is open.' };
  };
  f.say('open downloads');
  await flush();
  assert.equal(f.c.state, 'EXECUTING', 'Codex retrying internally is not a coordinator retry');
  const msgs = f.sink.of('TaskProgress').map(e => [e.payload.state, e.payload.message]);
  assert.deepEqual(msgs.filter(m => m[1] === 'Reconnecting…'), [['RECOVERING', 'Reconnecting…'], ['RECOVERING', 'Reconnecting…']]);
  assert.equal(f.speech.spoken.length, 0, 'reconnecting is never spoken');
  release();
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'answered');
  for (const e of f.sink.events) assert.ok(validateEvent(JSON.parse(JSON.stringify(e))).ok, e.type);
});

test('§1.3/§1.5: no server dedupe is assumed: at most one run() in flight across retries, queueing and duplicate submits', async () => {
  const f = await fixture({ config: { retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 } } });
  let release!: () => void;
  f.codex.scripts.push(
    fail('transient'),
    async () => { await new Promise<void>(r => (release = r)); return { status: 'completed', summary: 'first done' }; },
    async () => ({ status: 'completed', summary: 'second done' }),
  );
  const first = f.say('first task', 'req_a');
  assert.equal(first.kind, 'started');
  await flush(); // failed run settles, backoff sleep starts
  await f.clock.advance(100);
  await flush();
  assert.equal(f.codex.runs.length, 2, 'retry dispatched only after the failed run settled');
  assert.equal(f.c.submitUtterance(utterance('first task', 'req_a')).kind, 'duplicate', 'replayed requestId');
  assert.equal(f.c.submitUtterance(utterance('second task', 'req_b')).kind, 'queued');
  assert.equal(f.codex.maxInFlight, 1);
  release();
  await f.drain();
  assert.equal(f.codex.runs.length, 3);
  assert.equal(f.codex.maxInFlight, 1, 'never two Codex turns at once');
  assert.equal(new Set(f.codex.runs.map(r => r.clientUserMessageId)).size, 3, 'distinct clientUserMessageIds');
});

// E01 ruling (3), 2026-10-19: retry eligibility uses the PER-TURN ledger; the task OUTCOME uses the PER-TASK ledger.
/** Turn 1: commits a side effect, then a tool reports AMBIGUOUS with a question (Ruling 2 clarification). */
function commitThenAsk(f: Awaited<ReturnType<typeof fixture>>) {
  return async ({ hooks }: RunCtx): Promise<CodexRunResult> => {
    hooks.threadAssigned('thr_7');
    hooks.toolStarted({ toolId: 'files.move', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'files.move', observedState: obs('moved report.pdf', 'committed'), verified: true, sideEffect: 'committed' });
    hooks.toolResult({
      toolId: 'files.find', observedState: obs('two folders', 'none', false, { decision: 'ask_user', question: 'Which folder: Archive or Old?' }),
      verified: false, error: { code: 'AMBIGUOUS', message: 'two matches', retryable: false }, sideEffect: 'none',
    });
    return { status: 'completed', summary: 'Which folder: Archive or Old?' };
  };
}
async function answer(f: Awaited<ReturnType<typeof fixture>>, text: string, requestId: string) {
  await flush();
  assert.equal(f.c.state, 'LISTENING');
  f.c.handleCaptureEnded();
  assert.equal(f.c.submitUtterance(utterance(text, requestId)).kind, 'continued');
}

test('ruling 3: turn 1 committed, turn 2 fails transient with an empty TURN ledger → retried to the cap, then failed_after_side_effects reporting the turn-1 action', async () => {
  const f = await fixture({ config: { retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 400, jitterRatio: 0 } } });
  f.codex.scripts.push(commitThenAsk(f));
  f.codex.defaultScript = fail('transient'); // every turn-2 attempt: turn/completed failed, no tool started
  f.say('move the report then file it', 'req_1');
  await answer(f, 'Archive', 'req_2');
  await f.drain();
  const id = f.codex.runs[0]!.taskId;
  assert.equal(f.codex.runs.length, 4, 'turn 1 + turn 2 with 3 attempts: the retry WAS allowed (per-turn ledger empty)');
  assert.deepEqual(f.codex.runs.map(r => [r.turnKind, r.attempt]), [['initial', 1], ['clarification_answer', 1], ['retry', 2], ['retry', 3]]);
  assert.deepEqual(f.codex.runs.map(r => r.turnId), [`${id}.t1`, `${id}.t2`, `${id}.t3`, `${id}.t4`]);
  assert.ok(f.codex.runs.slice(1).every(r => r.threadId === 'thr_7' && r.resume), 'same thread');
  const fin = f.sink.of('TaskFinished');
  assert.equal(fin.length, 1);
  assert.equal(fin[0]!.payload.outcome, 'failed_after_side_effects', 'outcome uses the PER-TASK ledger');
  assert.equal(fin[0]!.payload.verified, false);
  assert.match(fin[0]!.payload.summary, /files\.move/, 'turn-1 committed action is reported');
  assert.match(fin[0]!.payload.summary, /did not retry or undo/);
  assert.match(fin[0]!.payload.summary, /tried 3 times/);
  assert.match(f.speech.spoken.at(-1)!.text, /files\.move/, 'and spoken');
});

test('ruling 3: turn 1 committed, then the clarification goes unanswered → failed_after_side_effects, reason clarification_timeout, action reported', async () => {
  const f = await fixture();
  f.codex.scripts.push(commitThenAsk(f));
  f.say('move the report then file it', 'req_1');
  await flush();
  await f.clock.advance(30_000);
  await f.drain();
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed_after_side_effects', 'clarification_timeout']);
  assert.match(fin.summary, /files\.move/);
  assert.equal(f.codex.runs.length, 1);
});

test('ruling 3: turn 1 committed, turn 2 hits a Codex auth error (401) with an empty turn ledger → failed_after_side_effects, reason auth_required, no retry', async () => {
  const f = await fixture();
  f.codex.scripts.push(commitThenAsk(f), async ({ hooks }) => {
    hooks.codexRetrying();
    return { status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: '401' } };
  });
  f.say('move the report then file it', 'req_1');
  await answer(f, 'Archive', 'req_2');
  await f.drain();
  assert.equal(f.codex.runs.length, 2, 'auth is never retried');
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed_after_side_effects', 'auth_required']);
  assert.match(fin.summary, /files\.move/);
  assert.equal(f.c.state, 'AUTH_REQUIRED');
});

test('ruling 2 (strict ledger): a started, possibly side-effecting tool blocks the retry even when it later reports sideEffect none; one with no result also makes the outcome failed_after_side_effects', async () => {
  // (a) started + result none: no retry (strict per-turn ledger). The task ledger holds no committed/possible action,
  //     so the outcome stays `failed` (the tool itself reported that nothing happened).
  const a = await fixture();
  a.codex.defaultScript = async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'files.move', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'files.move', observedState: obs('nothing moved'), verified: true, sideEffect: 'none' });
    return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'socket closed' } };
  };
  a.say('move it');
  await a.drain();
  assert.equal(a.codex.runs.length, 1, 'strict: started side-effecting tool → no retry');
  assert.ok(!accepted(a).includes('RECOVERING'));
  // (b) started with no result before the failure: no retry, and it counts as (possibly) committed for the outcome.
  const b = await fixture();
  b.codex.defaultScript = async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'mail.send', mayHaveSideEffects: true });
    return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'socket closed' } };
  };
  b.say('send it');
  await b.drain();
  assert.equal(b.codex.runs.length, 1, 'strict: no retry');
  const fin = b.sink.of('TaskFinished')[0]!.payload;
  assert.equal(fin.outcome, 'failed_after_side_effects');
  assert.match(fin.summary, /may have taken effect: mail\.send/);
});
