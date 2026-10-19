/**
 * DOT-011 slice 2: threads and turns behind CodexPort, transcript-driven against the scripted fake App Server.
 * Every adapter message and every scripted server message is validated against the pinned 0.163.0 JSON schema.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexRunHooks, CodexTaskRequest, ToolStart } from '@dottie/contracts';
import { MemoryTurnStore, shouldRetryTurn } from '../src/index.js';
import { loadTranscript } from './support/fake-app-server.js';
import { setup, until } from './support/harness.js';
import {
  agentMessage,
  commandStarted,
  CWD,
  emit,
  errorNote,
  expect,
  HANDSHAKE_SIGNED_IN,
  interrupt,
  lines,
  planUpdated,
  READ_SIGNED_IN,
  READ_SIGNED_OUT,
  THREAD_ID,
  threadResume,
  threadStart,
  threadStartResult,
  TURN_ID,
  turnCompleted,
  turnStart,
  interruptCompleted,
  rpcError,
  E09,
  turnsList,
} from './support/turn-script.js';

const HANDSHAKE_SIGNED_OUT = loadTranscript('handshake-signed-out.jsonl');
const TEXT = 'Reply with the word OK.';
const flush = () => new Promise((r) => setImmediate(r));

/** A coordinator request (E03 ports.ts): turnId `<taskId>.t<attempt>` unless given; clientUserMessageId = turnId. */
function req(o: Partial<CodexTaskRequest> = {}): CodexTaskRequest {
  const taskId = o.taskId ?? 't1';
  const attempt = o.attempt ?? 1;
  const turnId = o.turnId ?? `${taskId}.t${attempt}`;
  return {
    taskId,
    idempotencyKey: taskId === 't1' ? 'k1' : `k-${taskId}`,
    turnId,
    clientUserMessageId: turnId,
    turnKind: attempt > 1 ? 'retry' : 'initial',
    attempt,
    text: TEXT,
    workspaceScope: { scopes: ['files.read'], paths: [CWD] },
    resume: attempt > 1,
    ...o,
  };
}

function recorder() {
  const rec = { threads: [] as string[], progress: [] as string[], tools: [] as ToolStart[], approvals: 0, toolResults: 0, retrying: 0 };
  const hooks: CodexRunHooks = {
    threadAssigned: (t) => void rec.threads.push(t),
    progress: (m) => void rec.progress.push(m),
    codexRetrying: (...args: unknown[]) => {
      assert.equal(args.length, 0, 'codexRetrying() takes no arguments');
      rec.retrying++;
    },
    toolStarted: (s) => void rec.tools.push(s),
    toolResult: () => void rec.toolResults++,
    requestApproval: async () => {
      rec.approvals++;
      return { approved: false, reason: 'denied' };
    },
  };
  return { rec, hooks };
}

async function ready(scripts: string[], overrides: Parameters<typeof setup>[0]['overrides'] = {}) {
  const store = new MemoryTurnStore();
  const h = setup({ scripts, overrides: { turnStore: store, ...overrides } });
  await h.adapter.start();
  await until(() => h.statuses.length > 0, 'first auth status');
  return { ...h, store };
}

function assertClean(h: { problems(): string[]; fakes: { finished: boolean; remaining(): string }[] }) {
  assert.deepEqual(h.problems(), []);
  for (const f of h.fakes) assert.ok(f.finished, `script not finished:\n${f.remaining()}`);
}

const sent = (h: { fakes: { received: Record<string, unknown>[] }[] }, method: string) =>
  h.fakes.flatMap((f) => f.received).filter((m) => m['method'] === method).length;

test('success: gate read → thread/start (on-request, read-only) → turn/start; deltas, plan and final message stream as progress', async () => {
  const h = await ready([
    lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), agentMessage('msg-1', ['O', 'K']), planUpdated(['completed', 'pending']), turnCompleted('completed')),
  ]);
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: 'OK' });
  assert.deepEqual(rec.threads, [THREAD_ID]);
  assert.deepEqual(rec.progress, ['OK', 'Plan: 1 of 2 steps done.']);
  assert.equal(rec.approvals + rec.toolResults, 0);
  const start = h.fakes[0]!.received.find((m) => m['method'] === 'thread/start') as { params: Record<string, unknown> };
  assert.deepEqual(start.params, { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'read-only' });
  assert.equal((await h.store.get('t1'))?.state, 'completed');
  assert.equal((await h.store.get('t1'))?.turnId, TURN_ID);
  assert.deepEqual(await h.adapter.codex.cancel('t1'), { stopped: false, detail: 'completed_before_stop' });
  await h.fakes[0]!.done();
  assertClean(h);
});

test('agent-message deltas are throttled into progress (one update per period, the latest text)', async () => {
  const h = await ready([
    lines(
      HANDSHAKE_SIGNED_IN,
      READ_SIGNED_IN,
      threadStart(),
      turnStart(TEXT, 't1'),
      emit({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'm', delta: 'Hel' } }),
      emit({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'm', delta: 'lo' } }),
      '## wait tick',
      turnCompleted('completed'),
    ),
  ]);
  const { rec, hooks } = recorder();
  const run = h.adapter.codex.run(req(), hooks, new AbortController().signal);
  await h.fakes[0]!.reached('tick');
  assert.deepEqual(rec.progress, []);
  h.scheduler.advance(250);
  assert.deepEqual(rec.progress, ['Hello']);
  h.fakes[0]!.release('tick');
  assert.deepEqual(await run, { status: 'completed', summary: '' });
  assertClean(h);
});

test('gate: signed out → no thread/start, no turn/start; authState() is a fresh read', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_OUT, READ_SIGNED_OUT, READ_SIGNED_OUT)]);
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.error.kind, 'auth');
  assert.equal(await h.adapter.codex.authState(), 'signed_out');
  assert.equal(sent(h, 'thread/start') + sent(h, 'turn/start'), 0);
  assert.deepEqual(rec.threads, []);
  assert.deepEqual(await h.adapter.codex.cancel('t1'), { stopped: false, detail: 'no_active_turn' });
  await h.fakes[0]!.done();
  assertClean(h);
});

test('gate at the last moment: signed out while thread/start is in flight → turn/start is never written', async () => {
  const h = await ready([
    lines(
      HANDSHAKE_SIGNED_IN,
      READ_SIGNED_IN,
      expect({ method: 'thread/start', id: '$ts', params: { approvalPolicy: 'on-request', sandbox: 'read-only' } }),
      emit({ method: 'account/updated', params: { authMode: null, planType: null } }),
      READ_SIGNED_OUT,
      emit({ id: '$ts', result: threadStartResult() }),
    ),
  ]);
  const { hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.equal(r.status === 'failed' && r.error.kind, 'auth');
  assert.equal(sent(h, 'turn/start'), 0);
  assert.equal((await h.store.get('t1'))?.state, 'thread_ready');
  await h.fakes[0]!.done();
  assertClean(h);
});

test('the runtime not ready → transient failure, nothing written', async () => {
  const h = setup({ scripts: [] });
  const { hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.equal(r.status === 'failed' && r.error.kind, 'transient');
  assert.equal(h.spawns.length, 0);
});

test('tools: item/started → toolStarted (mayHaveSideEffects); approvals stay default-deny during a turn (bridge HELD)', async () => {
  const h = await ready([
    lines(
      HANDSHAKE_SIGNED_IN,
      READ_SIGNED_IN,
      threadStart(),
      turnStart(TEXT, 't1'),
      commandStarted('cmd-1'),
      emit({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { itemId: 'cmd-1', threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1792330224200 } }),
      expect({ id: 'srv-1', result: { decision: 'decline' } }),
      turnCompleted('completed'),
    ),
  ]);
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: '' });
  assert.deepEqual(rec.tools, [{ toolId: 'cmd-1', mayHaveSideEffects: true }]);
  assert.deepEqual(rec.progress, ['Running a command.']);
  assert.equal(rec.approvals, 0, 'requestApproval hook is never called while the bridge is held');
  assertClean(h);
});

test('401 during a turn: retries show as reconnecting; the final failure is auth and marks the session expired (sticky)', async () => {
  const h = await ready([
    lines(
      HANDSHAKE_SIGNED_IN,
      READ_SIGNED_IN,
      threadStart(),
      turnStart(TEXT, 't1'),
      // E09 run: ~10 willRetry notifications carrying responseStreamDisconnected{401}, then the final one.
      ...Array.from({ length: 10 }, () => errorNote({ responseStreamDisconnected: { httpStatusCode: 401 } }, true)),
      '## wait retrying',
      errorNote({ httpConnectionFailed: { httpStatusCode: 401 } }, false),
      turnCompleted('failed', TURN_ID, { httpConnectionFailed: { httpStatusCode: 401 } }),
      // markExpired → refresh: a stale auth.json still reads as signed in, which must not clear `expired`.
      READ_SIGNED_IN,
      // Next attempt: the fresh gate read also says signed in, but expired is sticky → blocked before any thread call.
      READ_SIGNED_IN,
    ),
  ]);
  const { rec, hooks } = recorder();
  const run = h.adapter.codex.run(req(), hooks, new AbortController().signal);
  await h.fakes[0]!.reached('retrying');
  await until(() => rec.retrying === 10, 'codexRetrying() on every willRetry:true');
  // While Codex retries: no kind applied, no expiry, no progress text (the coordinator shows "Reconnecting…").
  assert.equal(h.statuses.at(-1)?.status, 'signed_in');
  assert.deepEqual(rec.progress, []);
  h.fakes[0]!.release('retrying');
  const r = await run;
  assert.deepEqual(r, { status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: 'Your ChatGPT sign-in has expired. Please sign in again.' } });
  assert.equal(rec.retrying, 10);
  await until(() => h.statuses.at(-1)?.status === 'expired', 'expired');
  const again = await h.adapter.codex.run(req({ attempt: 2, resume: true }), recorder().hooks, new AbortController().signal);
  assert.deepEqual(again.status === 'failed' && [again.error.kind, again.error.origin], ['auth', 'adapter']);
  assert.equal(sent(h, 'turn/start'), 1);
  assert.equal(sent(h, 'thread/resume'), 0);
  await h.fakes[0]!.done();
  assertClean(h);
});

test('plan_limit (usageLimitExceeded) is terminal: failed plan_limit, no retry, no auth change', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), turnCompleted('failed', TURN_ID, 'usageLimitExceeded'))]);
  const r = await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'failed', error: { kind: 'plan_limit', origin: 'turn_failed', message: "You've reached your ChatGPT plan's Codex usage limit." } });
  for (let i = 0; i < 5; i++) await flush();
  h.scheduler.advance(60_000);
  assert.equal(sent(h, 'turn/start'), 1);
  assert.equal(h.statuses.at(-1)?.status, 'signed_in');
  assertClean(h);
});

const TURN_START_ONLY = expect({ method: 'turn/start', params: { threadId: THREAD_ID } });

test('a rejected turn/start (-32600, no data) is fatal, origin rpc_error, never retried; data is ignored even if present', async () => {
  for (const reply of [rpcError('Invalid request: missing field `input`'), emit({ id: '$', error: { code: -32600, message: 'x', data: { codexErrorInfo: 'rateLimitExceeded' } } })]) {
    const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), TURN_START_ONLY, reply)]);
    const r = await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
    assert.deepEqual(r, { status: 'failed', error: { kind: 'fatal', origin: 'rpc_error', message: 'Codex could not complete this task.' } });
    for (let i = 0; i < 5; i++) await flush();
    h.scheduler.advance(60_000);
    assert.equal(sent(h, 'turn/start'), 1);
    assert.equal((await h.store.get('t1'))?.state, 'thread_ready', 'the server created no turn');
    assertClean(h);
  }
});

test('retry rule: turn/completed{failed} rate_limited with an empty ledger stays rate_limited/turn_failed; the coordinator retry is a NEW turn (new turnId) on the same thread', async () => {
  const h = await ready([
    lines(
      HANDSHAKE_SIGNED_IN,
      READ_SIGNED_IN,
      threadStart(),
      turnStart(TEXT, 't1'),
      errorNote('rateLimitExceeded', true),
      turnCompleted('failed', TURN_ID, 'rateLimitExceeded'),
      READ_SIGNED_IN,
      turnStart(TEXT, 't1', 'turn-2', 2),
      turnCompleted('completed', 'turn-2'),
    ),
  ]);
  const { rec, hooks } = recorder();
  const r1 = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.deepEqual(r1, { status: 'failed', error: { kind: 'rate_limited', origin: 'turn_failed', message: 'Codex is busy right now. Please try again in a moment.' } });
  assert.equal(rec.retrying, 1);
  assert.equal(shouldRetryTurn('rate_limited', true, 1, 3), true);
  const r2 = await h.adapter.codex.run(req({ attempt: 2 }), recorder().hooks, new AbortController().signal);
  assert.deepEqual(r2, { status: 'completed', summary: '' });
  assert.equal(sent(h, 'thread/start'), 1);
  assert.equal(sent(h, 'thread/resume'), 0, 'the thread is still loaded');
  assert.deepEqual((await h.store.get('t1'))?.dispatchedTurnIds, ['t1.t1', 't1.t2']);
  assertClean(h);
});

test('retry rule: a transient failure after a side-effecting item started (ledger not empty) is reported fatal, never retryable', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), commandStarted('cmd-1'), turnCompleted('failed', TURN_ID, 'serverOverloaded'))]);
  const r = await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.status === 'failed' && [r.error.kind, r.error.origin], ['fatal', 'turn_failed']);
  assert.ok(h.logger.entries.some((e) => e.event === 'codex.turn.failed' && e.fields['kind'] === 'transient' && e.fields['ledgerEmpty'] === false));
  assertClean(h);
});

test('retry rule: a web search does not touch the ledger, so a transient failure stays transient', async () => {
  const web = emit({ method: 'item/started', params: { item: { type: 'webSearch', id: 'ws-1', query: 'q', action: null }, threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1 } });
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), web, turnCompleted('failed', TURN_ID, 'serverOverloaded'))]);
  const r = await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  assert.deepEqual(r.status === 'failed' && [r.error.kind, r.error.origin], ['transient', 'turn_failed']);
  assertClean(h);
});

test('shouldRetryTurn: only rate_limited/transient, only with an empty ledger, only while attempt < maxAttempts', () => {
  assert.equal(shouldRetryTurn('transient', true, 1, 3), true);
  assert.equal(shouldRetryTurn('rate_limited', true, 2, 3), true);
  assert.equal(shouldRetryTurn('transient', true, 3, 3), false);
  assert.equal(shouldRetryTurn('transient', false, 1, 3), false);
  for (const k of ['auth', 'plan_limit', 'fatal'] as const) assert.equal(shouldRetryTurn(k, true, 1, 3), false, k);
});

test('idempotency: a second turn/start NEVER reaches the wire (same thread, same task, same key, same turnId, or mismatched clientUserMessageId)', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), '## wait end', turnCompleted('completed'), READ_SIGNED_IN)]);
  const run = h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  await h.fakes[0]!.reached('end');
  for (let i = 0; i < 5; i++) await flush();
  const refusals = [
    req({ taskId: 't2', threadId: THREAD_ID, resume: true }), // another task on the busy thread (Codex would append it)
    req(), // same taskId
    req({ taskId: 't3', idempotencyKey: 'k1' }), // same idempotencyKey
  ];
  for (const r of refusals) {
    const out = await h.adapter.codex.run(r, recorder().hooks, new AbortController().signal);
    assert.deepEqual(out.status === 'failed' && [out.error.kind, out.error.origin], ['fatal', 'adapter'], JSON.stringify(r));
  }
  assert.equal(sent(h, 'turn/start'), 1, 'only the first turn/start was written');
  h.fakes[0]!.release('end');
  assert.deepEqual(await run, { status: 'completed', summary: '' });
  // After it settled: the same turnId again is still refused (the server would not dedupe it) …
  const dupTurn = await h.adapter.codex.run(req({ attempt: 1 }), recorder().hooks, new AbortController().signal);
  assert.deepEqual(dupTurn.status === 'failed' && dupTurn.error.origin, 'adapter');
  // … and so is a request whose clientUserMessageId is not its turnId (no READ is consumed for it either).
  const bad = await h.adapter.codex.run(req({ taskId: 't4', clientUserMessageId: 't4' }), recorder().hooks, new AbortController().signal);
  assert.deepEqual(bad.status === 'failed' && [bad.error.kind, bad.error.origin], ['fatal', 'adapter']);
  assert.equal(sent(h, 'turn/start'), 1);
  assert.equal(h.fakes[0]!.received.filter((m) => m['method'] === 'turn/start').length, 1);
  // Neither refusal read account/read: the script's last READ is consumed only by this explicit authState().
  await h.adapter.codex.authState();
  assertClean(h);
});

test('idempotency: two runs racing for the same thread in one tick: the loser writes nothing (not even account/read); one thread/resume, one turn/start', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadResume(), turnStart(TEXT, 'ta'), turnCompleted('completed'))]);
  const a = h.adapter.codex.run(req({ taskId: 'ta', threadId: THREAD_ID, resume: true }), recorder().hooks, new AbortController().signal);
  const b = h.adapter.codex.run(req({ taskId: 'tb', threadId: THREAD_ID, resume: true }), recorder().hooks, new AbortController().signal);
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { status: 'completed', summary: '' });
  assert.deepEqual(rb.status === 'failed' && [rb.error.kind, rb.error.origin], ['fatal', 'adapter']);
  assert.equal(sent(h, 'thread/resume'), 1);
  assert.equal(sent(h, 'turn/start'), 1);
  assertClean(h);
});

test('a clarification answer (attempt reset to 1, new turnId) is a new turn on the same thread, not a duplicate', async () => {
  const h = await ready([
    lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), turnCompleted('completed'), READ_SIGNED_IN,
      expect({ method: 'turn/start', params: { threadId: THREAD_ID, input: [{ type: 'text', text: 'the second one', text_elements: [] }], clientUserMessageId: 't1.t2' } }),
      emit({ id: '$', result: { turn: { ...(E09['interruptTurnCompleted']!['params'] as Record<string, Record<string, unknown>>)['turn'], id: 'turn-2', rootTurnId: 'turn-2', status: 'inProgress', completedAt: null, durationMs: null } } }),
      turnCompleted('completed', 'turn-2')),
  ]);
  assert.deepEqual(await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal), { status: 'completed', summary: '' });
  const answer = req({ turnId: 't1.t2', clientUserMessageId: 't1.t2', turnKind: 'clarification_answer', attempt: 1, text: 'the second one', resume: true });
  assert.deepEqual(await h.adapter.codex.run(answer, recorder().hooks, new AbortController().signal), { status: 'completed', summary: '' });
  assert.equal(sent(h, 'turn/start'), 2);
  assertClean(h);
});

test('cancel: turn/interrupt, then stopped:true only once turn/completed{interrupted} is observed; run resolves aborted', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), '## wait cancel', interrupt(), '## wait confirm', interruptCompleted())]);
  const run = h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  await h.fakes[0]!.reached('cancel');
  h.fakes[0]!.release('cancel');
  let ack: unknown;
  const ackP = h.adapter.codex.cancel('t1').then((a) => (ack = a));
  await h.fakes[0]!.reached('confirm');
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(ack, undefined, 'not reported stopped before turn/completed');
  h.fakes[0]!.release('confirm');
  await ackP;
  assert.deepEqual(ack, { stopped: true, detail: 'interrupted' });
  assert.deepEqual(await run, { status: 'aborted' });
  assert.equal((await h.store.get('t1'))?.state, 'interrupted');
  assertClean(h);
});

test('cancel that is not confirmed in time → stopped:false stop_unconfirmed; the run keeps waiting for the real end', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), '## wait cancel', interrupt(), '## wait end', turnCompleted('completed'))]);
  let done = false;
  const run = h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal).finally(() => (done = true));
  await h.fakes[0]!.reached('cancel');
  h.fakes[0]!.release('cancel');
  const ackP = h.adapter.codex.cancel('t1');
  await h.fakes[0]!.reached('end');
  await flush();
  h.scheduler.advance(10_000);
  assert.deepEqual(await ackP, { stopped: false, detail: 'stop_unconfirmed' });
  assert.equal(done, false);
  h.fakes[0]!.release('end');
  assert.deepEqual(await run, { status: 'completed', summary: '' });
  assert.deepEqual(await h.adapter.codex.cancel('t1'), { stopped: false, detail: 'completed_before_stop' });
  assertClean(h);
});

test('cancel before dispatch (during thread/start) → stopped_before_dispatch; turn/start never written', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, expect({ method: 'thread/start' }), '## wait hold', emit({ id: '$', result: threadStartResult() }))]);
  const run = h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  await h.fakes[0]!.reached('hold');
  const ackP = h.adapter.codex.cancel('t1');
  h.fakes[0]!.release('hold');
  assert.deepEqual(await ackP, { stopped: true, detail: 'stopped_before_dispatch' });
  assert.deepEqual(await run, { status: 'aborted' });
  assert.equal(sent(h, 'turn/start'), 0);
  assert.equal((await h.store.get('t1'))?.state, 'stopped_before_dispatch');
  assertClean(h);
});

test('AbortSignal: aborted before run → nothing written; aborted mid-turn → interrupt and aborted', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), '## wait abort', interrupt(), interruptCompleted())]);
  const pre = new AbortController();
  pre.abort();
  assert.deepEqual(await h.adapter.codex.run(req({ taskId: 't0' }), recorder().hooks, pre.signal), { status: 'aborted' });
  const ac = new AbortController();
  const run = h.adapter.codex.run(req(), recorder().hooks, ac.signal);
  await h.fakes[0]!.reached('abort');
  h.fakes[0]!.release('abort');
  ac.abort();
  assert.deepEqual(await run, { status: 'aborted' });
  assertClean(h);
});

test('crash mid-turn → unknown outcome (never success, never re-sent); after restart the retry uses thread/resume', async () => {
  const h = await ready([
    lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), '## exit 1'),
    lines(HANDSHAKE_SIGNED_IN, turnsList([{ id: TURN_ID, clientId: 't1.t1' }]), READ_SIGNED_IN, threadResume(), turnStart(TEXT, 't1', 'turn-2', 2), turnCompleted('completed', 'turn-2')),
  ]);
  const r1 = await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  assert.equal(r1.status === 'failed' && r1.error.kind, 'fatal');
  assert.match(r1.status === 'failed' ? r1.error.message : '', /can't tell how far it got/);
  assert.deepEqual(await h.store.get('t1'), { taskId: 't1', idempotencyKey: 'k1', attempt: 1, threadId: THREAD_ID, turnId: TURN_ID, dottieTurnId: 't1.t1', dispatchedTurnIds: ['t1.t1'], state: 'unknown', updatedAt: h.scheduler.now() });
  assert.deepEqual(await h.adapter.codex.cancel('t1'), { stopped: false, detail: 'stop_unconfirmed' });
  // Same idempotencyKey + attempt is never dispatched twice.
  const dup = await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
  assert.equal(dup.status === 'failed' && dup.error.kind, 'fatal');
  h.scheduler.advance(30_000);
  await until(() => h.adapter.status === 'running' && h.fakes.length === 2 && h.fakes[1]!.received.length >= 3, 'restarted');
  await until(() => h.statuses.at(-1)?.status === 'signed_in', 'signed in again');
  const { rec, hooks } = recorder();
  const r2 = await h.adapter.codex.run(req({ attempt: 2, resume: true }), hooks, new AbortController().signal);
  assert.deepEqual(r2, { status: 'completed', summary: '' });
  assert.deepEqual(rec.threads, [THREAD_ID]);
  assert.equal(sent(h, 'thread/start'), 1);
  assert.equal((await h.store.get('t1'))?.turnId, 'turn-2');
  assertClean(h);
});

test('restart recovery: records a previous process left dispatching/in flight become unknown; cancel says stop_unconfirmed', async () => {
  const store = new MemoryTurnStore();
  await store.put({ taskId: 't9', idempotencyKey: 'k9', attempt: 1, threadId: THREAD_ID, turnId: TURN_ID, state: 'in_flight', updatedAt: 0 });
  await store.put({ taskId: 't8', idempotencyKey: 'k8', attempt: 1, threadId: THREAD_ID, state: 'completed', updatedAt: 0 });
  const h = await ready([HANDSHAKE_SIGNED_IN], { turnStore: store });
  assert.deepEqual(await h.adapter.codex.cancel('t9'), { stopped: false, detail: 'stop_unconfirmed' });
  assert.equal((await store.get('t9'))?.state, 'unknown');
  assert.equal((await store.get('t8'))?.state, 'completed');
  assert.ok(h.logger.entries.some((e) => e.event === 'codex.turn.recovered_unknown' && e.fields['taskId'] === 't9'));
  assertClean(h);
});

test('fail closed: a thread/start echo with a different sandbox or approval policy refuses the task before any turn', async () => {
  for (const change of [{ sandbox: { type: 'dangerFullAccess' } }, { approvalPolicy: 'never' }]) {
    const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(threadStartResult(change)))]);
    const r = await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal);
    assert.equal(r.status === 'failed' && r.error.kind, 'fatal');
    assert.equal(sent(h, 'turn/start'), 0);
    assert.ok(h.logger.entries.some((e) => e.event === 'security.codex.thread_policy_mismatch'));
    assertClean(h);
  }
});

test('no workspace path and no defaultCwd → refused before any thread call', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN)]);
  const r = await h.adapter.codex.run(req({ workspaceScope: { scopes: [], paths: [] } }), recorder().hooks, new AbortController().signal);
  assert.equal(r.status === 'failed' && r.error.kind, 'fatal');
  assert.equal(sent(h, 'thread/start'), 0);
  assertClean(h);
});

// ---------------------------------------------------------------- E09 v0.3.0: resume hygiene and restart reconcile
test('resume sends excludeTurns:true; deprecationNotice and thread/goal/cleared are ignored harmlessly', async () => {
  const store = new MemoryTurnStore();
  await store.put({ taskId: 't1', idempotencyKey: 'k1', attempt: 1, threadId: THREAD_ID, turnId: TURN_ID, dottieTurnId: 't1.t1', dispatchedTurnIds: ['t1.t1'], state: 'completed', updatedAt: 0 });
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadResume(), turnStart(TEXT, 't1', 'turn-2', 2), turnCompleted('completed', 'turn-2'))], { turnStore: store });
  const r = await h.adapter.codex.run(req({ attempt: 2, resume: true }), recorder().hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: '' });
  const wire = (h.fakes[0]!.received as { method?: string; params?: Record<string, unknown> }[]).find((m) => m.method === 'thread/resume');
  assert.equal(wire?.params?.['excludeTurns'], true);
  assert.equal(h.adapter.status, 'running');
  const noisy = h.logger.entries.filter((e) => (e.level === 'error' || e.level === 'warn') && !e.event.startsWith('security.'));
  assert.deepEqual(noisy, [], 'no warn/error for the notices');
  assertClean(h);
});

test('restart reconcile (E09 v0.3.0): unknown records are cross-checked via thread/turns/list clientId; store first, never resent', async () => {
  const base = { idempotencyKey: 'k', attempt: 1, threadId: THREAD_ID, state: 'unknown' as const, updatedAt: 0 };
  const cases = [
    { name: 'match', rec: { taskId: 'a', turnId: TURN_ID, dottieTurnId: 'a.t1' }, server: [{ id: TURN_ID, clientId: 'a.t1', status: 'completed' }], want: { result: 'match', serverTurnId: TURN_ID, serverStatus: 'completed' } },
    { name: 'match, no stored codex id', rec: { taskId: 'a', dottieTurnId: 'a.t1' }, server: [{ id: TURN_ID, clientId: 'a.t1', status: 'failed' }], want: { result: 'match', serverTurnId: TURN_ID, serverStatus: 'failed' } },
    { name: 'mismatch: other codex id', rec: { taskId: 'a', turnId: TURN_ID, dottieTurnId: 'a.t1' }, server: [{ id: 'other', clientId: 'a.t1' }], want: { result: 'mismatch', serverTurnId: 'other', serverStatus: 'failed' } },
    { name: 'mismatch: clientId twice (no server dedupe, E09)', rec: { taskId: 'a', turnId: TURN_ID, dottieTurnId: 'a.t1' }, server: [{ id: TURN_ID, clientId: 'a.t1' }, { id: 'dup', clientId: 'a.t1' }], want: { result: 'mismatch', serverTurnId: TURN_ID, serverStatus: 'failed' } },
    { name: 'absent', rec: { taskId: 'a', turnId: TURN_ID, dottieTurnId: 'a.t1' }, server: [{ id: 'x', clientId: 'b.t1' }], want: { result: 'absent' } },
  ];
  for (const c of cases) {
    const store = new MemoryTurnStore();
    await store.put({ ...base, ...c.rec });
    const h = await ready([lines(HANDSHAKE_SIGNED_IN, turnsList(c.server), READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't2'), turnCompleted('completed'))], { turnStore: store });
    const r = await h.adapter.codex.run(req({ taskId: 't2', idempotencyKey: 'k2' }), recorder().hooks, new AbortController().signal);
    assert.equal(r.status, 'completed', c.name);
    const after = await store.get('a');
    assert.equal(after?.state, 'unknown', `${c.name}: store stays authoritative`);
    assert.deepEqual(after?.serverCheck, c.want, c.name);
    assert.equal(h.logger.entries.some((e) => e.event === 'security.codex.turn_reconcile_mismatch'), c.want.result === 'mismatch', c.name);
    // Never resent: the same request is refused without touching the wire.
    const before = h.fakes[0]!.received.length;
    const again = await h.adapter.codex.run(req({ taskId: 'a', idempotencyKey: 'k', turnId: 'a.t1' }), recorder().hooks, new AbortController().signal);
    assert.equal(again.status, 'failed', c.name);
    assert.equal(h.fakes[0]!.received.length, before, `${c.name}: nothing written`);
    assertClean(h);
  }
});

test('restart reconcile: turns/list error or a truncated history → unavailable; checked once per child; legacy records skipped', async () => {
  const store = new MemoryTurnStore();
  await store.put({ taskId: 'a', idempotencyKey: 'k', attempt: 1, threadId: THREAD_ID, turnId: TURN_ID, dottieTurnId: 'a.t1', state: 'unknown', updatedAt: 0 });
  await store.put({ taskId: 'legacy', idempotencyKey: 'kl', attempt: 1, threadId: THREAD_ID, turnId: TURN_ID, state: 'unknown', updatedAt: 0 });
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, turnsList([], { rpcErrorInstead: true }), READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't2'), turnCompleted('completed'), READ_SIGNED_IN, turnStart(TEXT, 't3'), turnCompleted('completed'))], { turnStore: store });
  assert.equal((await h.adapter.codex.run(req({ taskId: 't2', idempotencyKey: 'k2' }), recorder().hooks, new AbortController().signal)).status, 'completed');
  assert.deepEqual((await store.get('a'))?.serverCheck, { result: 'unavailable' });
  assert.equal((await store.get('legacy'))?.serverCheck, undefined, 'no dottieTurnId: nothing to match on');
  // Second run on the same child: `unavailable` is not re-asked until the next child (the script would fail on it).
  assert.equal((await h.adapter.codex.run(req({ taskId: 't3', idempotencyKey: 'k3', threadId: THREAD_ID }), recorder().hooks, new AbortController().signal)).status, 'completed');
  assertClean(h);

  const store2 = new MemoryTurnStore();
  await store2.put({ taskId: 'a', idempotencyKey: 'k', attempt: 1, threadId: THREAD_ID, turnId: TURN_ID, dottieTurnId: 'a.t1', state: 'unknown', updatedAt: 0 });
  const pages = [1, 2, 3, 4].map((n) => turnsList([{ id: `p${n}`, clientId: `z.t${n}` }], { ...(n > 1 ? { cursor: `c${n - 1}` } : {}), nextCursor: `c${n}` }));
  const h2 = await ready([lines(HANDSHAKE_SIGNED_IN, ...pages, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't2'), turnCompleted('completed'))], { turnStore: store2 });
  assert.equal((await h2.adapter.codex.run(req({ taskId: 't2', idempotencyKey: 'k2' }), recorder().hooks, new AbortController().signal)).status, 'completed');
  assert.deepEqual((await store2.get('a'))?.serverCheck, { result: 'unavailable' }, 'older turns unseen: not "absent"');
  assertClean(h2);
});

// ---------------------------------------------------------------- E01 ruling 1s (DOT-090 item 14): thread loading
test('1s: an unloaded threadId is resumed (excludeTurns:true) even with resume:false, then the turn runs on it', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadResume(), turnStart(TEXT, 't2'), turnCompleted('completed'))]);
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req({ taskId: 't2', threadId: THREAD_ID, resume: false }), hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: '' });
  assert.equal(sent(h, 'thread/resume'), 1);
  assert.equal(sent(h, 'thread/start'), 0);
  const wire = (h.fakes[0]!.received as { method?: string; params?: Record<string, unknown> }[]).find((m) => m.method === 'thread/resume');
  assert.equal(wire?.params?.['excludeTurns'], true);
  assert.equal(wire?.params?.['threadId'], THREAD_ID);
  assert.deepEqual(rec.threads, [THREAD_ID]);
  assertClean(h);
});

test('1s: a thread/resume echo with a different threadId fails closed (blocked_unavailable), 0 turn/start', async () => {
  const h = await ready([lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadResume({ echoThreadId: 'thr_someone_else' }))]);
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req({ taskId: 't2', threadId: THREAD_ID, resume: false }), hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'failed', error: { kind: 'transient', origin: 'adapter', message: "Codex isn't available right now." } });
  assert.equal(sent(h, 'turn/start'), 0);
  assert.deepEqual(rec.threads, [], 'no thread assigned');
  assert.ok(h.logger.entries.some((e) => e.event === 'security.codex.thread_echo_mismatch'));
  assert.ok(!h.logger.entries.some((e) => e.event.endsWith('codex.thread.unavailable')), 'mapped as an echo mismatch, not as a runtime outage');
  assert.notEqual((await h.store.get('t2'))?.state, 'dispatching');
  assertClean(h);
});

test('1s: a threadId already loaded in this process is not resumed again, whatever the resume flag', async () => {
  const h = await ready([
    lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), turnCompleted('completed'), READ_SIGNED_IN, turnStart(TEXT, 't2', 'turn-2'), turnCompleted('completed', 'turn-2')),
  ]);
  assert.deepEqual(await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal), { status: 'completed', summary: '' });
  const r = await h.adapter.codex.run(req({ taskId: 't2', threadId: THREAD_ID, resume: false }), recorder().hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: '' });
  assert.equal(sent(h, 'thread/resume'), 0);
  assert.equal(sent(h, 'thread/start'), 1);
  assertClean(h);
});

test('1s: after an App Server restart the same threadId is resumed again (the loaded set is per process)', async () => {
  const h = await ready([
    lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), turnCompleted('completed'), '## exit 1'),
    lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadResume(), turnStart(TEXT, 't2', 'turn-2'), turnCompleted('completed', 'turn-2')),
  ]);
  assert.deepEqual(await h.adapter.codex.run(req(), recorder().hooks, new AbortController().signal), { status: 'completed', summary: '' });
  await until(() => h.adapter.status !== 'running', 'child exited');
  h.scheduler.advance(30_000);
  await until(() => h.adapter.status === 'running' && h.fakes.length === 2, 'restarted');
  await until(() => h.statuses.at(-1)?.status === 'signed_in', 'signed in again');
  const r = await h.adapter.codex.run(req({ taskId: 't2', threadId: THREAD_ID, resume: false }), recorder().hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: '' });
  assert.equal(sent(h, 'thread/resume'), 1);
  assertClean(h);
});
