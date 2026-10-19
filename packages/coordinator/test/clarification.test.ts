/**
 * Ruling 2 (CONTRACTS §5 "Tool-host context", E01 2026-10-19): an answer to a clarification (AMBIGUOUS + question)
 * continues the SAME taskId as a new turn on the same thread. Per-task targetIds stay valid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunCtx } from './helpers.js';
import { fixture, flush, obs, utterance } from './helpers.js';
import type { CodexRunResult } from '../src/ports.js';

type F = Awaited<ReturnType<typeof fixture>>;

/** Turn 1: the tool finds two candidates and reports AMBIGUOUS with a question; Codex relays it. */
function ambiguousTurn(f: F, captured: { targets: string[] }) {
  return async ({ hooks }: RunCtx): Promise<CodexRunResult> => {
    hooks.threadAssigned('thr_42');
    const r = f.tools.call(f.c, 'files.find_newest_pdf', { folder: 'downloads' });
    assert.ok(r.ok);
    captured.targets = r.targetIds;
    hooks.toolResult({
      toolId: 'files.find_newest_pdf',
      observedState: obs('two candidates', 'none', false, { decision: 'ask_user', question: 'Which one: report.pdf or invoice.pdf?', candidates: r.targetIds.map((id, i) => ({ id, label: i ? 'invoice.pdf' : 'report.pdf' })) }),
      verified: false,
      error: { code: 'AMBIGUOUS', message: 'Two files tie for newest.', retryable: false },
      sideEffect: 'none',
    });
    return { status: 'completed', summary: 'Which one: report.pdf or invoice.pdf?' };
  };
}

/** Turn 2: open the candidate chosen by the user, by the targetId issued in turn 1. */
function openChosenTurn(f: F, captured: { targets: string[] }, results: { code?: string }[]) {
  return async ({ hooks }: RunCtx): Promise<CodexRunResult> => {
    const r = f.tools.call(f.c, 'files.open', { targetId: captured.targets[1] });
    results.push(r.ok ? {} : { code: r.code });
    if (r.ok) hooks.toolResult({ toolId: 'files.open', observedState: obs('viewer shows invoice.pdf', 'committed'), verified: true, sideEffect: 'committed' });
    return { status: 'completed', summary: 'Opened invoice.pdf.' };
  };
}

async function askAndAnswer(f: F, answer: string, requestId: string) {
  await flush();
  assert.equal(f.c.state, 'LISTENING', 'follow-up window opened after the question');
  f.c.handleCaptureEnded();
  return f.c.submitUtterance(utterance(answer, requestId));
}

test('Ruling 2: the answer continues the same taskId as a new turn on the same thread; targetIds survive', async () => {
  const f = await fixture();
  const captured = { targets: [] as string[] };
  const opened: { code?: string }[] = [];
  f.codex.scripts.push(ambiguousTurn(f, captured), openChosenTurn(f, captured, opened));
  const started = f.say('open the newest pdf in downloads', 'req_cmd');
  assert.equal(started.kind, 'started');
  const r = await askAndAnswer(f, 'the invoice', 'req_answer');
  assert.deepEqual(r, { kind: 'continued', taskId: started.kind === 'started' ? started.taskId : '' });
  await f.drain();

  const [t1, t2] = f.codex.runs;
  assert.equal(f.codex.runs.length, 2);
  assert.equal(t2!.taskId, t1!.taskId, 'same taskId');
  assert.equal(t2!.threadId, 'thr_42', 'same thread');
  assert.equal(t2!.resume, true);
  assert.equal(t2!.turnKind, 'clarification_answer');
  assert.equal(t2!.text, 'the invoice');
  assert.equal(t2!.attempt, 1, 'retry budget is per user turn');
  assert.notEqual(t2!.turnId, t1!.turnId);
  assert.deepEqual([t1!.turnId, t2!.turnId], [`${t1!.taskId}.t1`, `${t1!.taskId}.t2`]);
  assert.deepEqual(f.codex.runs.map(r => r.clientUserMessageId), [t1!.turnId, t2!.turnId], 'turn/start clientUserMessageId = turnId');
  assert.deepEqual(f.codex.runs.map(r => r.idempotencyKey), [t1!.taskId, t1!.taskId], 'idempotencyKey stays the taskId');
  assert.deepEqual(opened, [{}], 'targetId issued in turn 1 accepted in turn 2');
  assert.deepEqual(f.tools.calls.map(c => c.context), [{ taskId: t1!.taskId, turnId: t1!.turnId }, { taskId: t1!.taskId, turnId: t2!.turnId }]);
  assert.equal(f.sink.of('TaskRequested').length, 1, 'no new task');
  const fin = f.sink.of('TaskFinished');
  assert.equal(fin.length, 1);
  assert.equal(fin[0]!.payload.outcome, 'succeeded', 'resolved AMBIGUOUS step is not counted as a failed action');
  assert.ok(f.speech.spoken.some(s => s.kind === 'prompt' && s.text === 'Which one: report.pdf or invoice.pdf?'));
  assert.ok(f.sink.of('TaskProgress').some(e => e.payload.redactedMetadata['awaitingClarification'] === true));
  assert.equal(f.c.state, 'STANDBY');
});

test('Ruling 2: per-task targetIds are not valid in a different task', async () => {
  const f = await fixture();
  const captured = { targets: [] as string[] };
  const opened: { code?: string }[] = [];
  f.codex.scripts.push(ambiguousTurn(f, captured), openChosenTurn(f, captured, opened));
  f.say('open the newest pdf', 'req_1');
  await askAndAnswer(f, 'the invoice', 'req_2');
  await f.drain();
  const second: { code?: string }[] = [];
  f.codex.scripts.push(openChosenTurn(f, captured, second));
  await f.clock.advance(20_000);
  f.say('open that invoice again', 'req_3');
  await f.drain();
  assert.deepEqual(second, [{ code: 'NOT_FOUND' }], 'cross-task / ended-task targetId is NOT_FOUND, never guessed');
});

test('Ruling 2: dedupe never swallows a clarification answer (repeated words), but a replayed requestId is still a duplicate', async () => {
  const f = await fixture();
  const captured = { targets: [] as string[] };
  // Two clarification rounds answered with the same words inside the 10 s dedupe window.
  f.codex.scripts.push(ambiguousTurn(f, captured), ambiguousTurn(f, captured), async () => ({ status: 'completed', summary: 'Done.' }));
  f.say('open the newest pdf', 'req_c');
  assert.equal((await askAndAnswer(f, 'the first one', 'req_a1')).kind, 'continued');
  assert.equal((await askAndAnswer(f, 'the first one', 'req_a2')).kind, 'continued', 'same words, new requestId: a real answer');
  await f.drain();
  assert.equal(f.codex.runs.length, 3);
  assert.deepEqual(f.codex.runs.map(r => r.turnKind), ['initial', 'clarification_answer', 'clarification_answer']);
  assert.equal(new Set(f.codex.runs.map(r => r.taskId)).size, 1);

  // Replay of an answer's requestId while a question is pending creates no extra turn.
  const g = await fixture();
  g.codex.scripts.push(ambiguousTurn(g, captured), ambiguousTurn(g, captured));
  g.say('open the newest pdf', 'req_x');
  assert.equal((await askAndAnswer(g, 'the first one', 'req_ans')).kind, 'continued');
  await flush();
  g.c.handleCaptureEnded();
  assert.equal(g.c.submitUtterance(utterance('the first one', 'req_ans')).kind, 'duplicate');
  assert.equal(g.codex.runs.length, 2);
  g.c.cancelTask();
  await g.drain();
});

test('Ruling 2: an answer does not poison the text-dedupe window for a later new command', async () => {
  const f = await fixture();
  const captured = { targets: [] as string[] };
  f.codex.scripts.push(ambiguousTurn(f, captured), async () => ({ status: 'completed', summary: 'Done.' }));
  f.say('open the newest pdf', 'req_1');
  await askAndAnswer(f, 'open downloads', 'req_2');
  await f.drain();
  assert.equal(f.say('open downloads', 'req_3').kind, 'started', 'same words as the earlier answer start a new task');
  await f.drain();
});

test('Ruling 2: the clarification turn is auth-gated too (DOT-061)', async () => {
  const f = await fixture();
  f.codex.scripts.push(ambiguousTurn(f, { targets: [] }));
  f.say('open the newest pdf', 'req_1');
  f.codex.auth = 'expired';
  await askAndAnswer(f, 'the invoice', 'req_2');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'blocked_auth');
  assert.equal(f.c.state, 'AUTH_REQUIRED');
});

test('Ruling 2: no answer within clarificationTimeoutMs ends the task honestly (no TaskCancelled, no extra turn)', async () => {
  const f = await fixture({ config: { clarificationTimeoutMs: 5_000 } });
  f.codex.scripts.push(ambiguousTurn(f, { targets: [] }));
  f.say('open the newest pdf', 'req_1');
  await flush();
  assert.equal(f.c.state, 'LISTENING');
  await f.clock.advance(5_000);
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed', 'clarification_timeout']);
  assert.equal(f.sink.of('TaskCancelled').length, 0);
  assert.deepEqual(f.tools.ended, [f.codex.runs[0]!.taskId]);
  assert.equal(f.c.state, 'STANDBY');
});

test('Ruling 2: an unanswered clarification after a committed action ends failed_after_side_effects, reason clarification_timeout', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'app.launch', observedState: obs('viewer opened', 'committed'), verified: true, sideEffect: 'committed' });
    return ambiguousTurn(f, { targets: [] })({ hooks } as RunCtx);
  });
  f.say('open the newest pdf', 'req_1');
  await flush();
  await f.clock.advance(30_000);
  await f.drain();
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed_after_side_effects', 'clarification_timeout']);
});

test('Ruling 2: a capture abort while waiting for the answer: failed, reason clarification_cancelled (timeout is for silence only)', async () => {
  const f = await fixture();
  f.codex.scripts.push(ambiguousTurn(f, { targets: [] }));
  f.say('open the newest pdf', 'req_1');
  await flush();
  f.c.handleCaptureAborted('user cancelled capture');
  await f.drain();
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed', 'clarification_cancelled']);
});

test('Ruling 2: "stop the task" while waiting for the answer reports a truthful stop (dispatched, ledger-based)', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'app.launch', observedState: obs('viewer opened', 'committed'), verified: true, sideEffect: 'committed' });
    return ambiguousTurn(f, { targets: [] })({ hooks } as RunCtx);
  });
  f.say('open the newest pdf', 'req_1');
  await flush();
  assert.equal(f.c.state, 'LISTENING');
  assert.equal(f.c.cancelTask().kind, 'cancelling');
  await f.drain();
  const p = f.sink.of('TaskCancelled')[0]!.payload;
  assert.equal(p.stopStatus, 'stopped_after_side_effects', 'not stopped_before_dispatch: turn 1 already ran');
  assert.equal(p.sideEffectsCommitted, true);
  assert.equal(f.speech.spoken.at(-1)!.text, p.report);
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.c.state, 'STANDBY');
});

test('Ruling 2: clarification rounds are bounded by maxClarificationTurns', async () => {
  const f = await fixture({ config: { maxClarificationTurns: 1 } });
  f.codex.scripts.push(ambiguousTurn(f, { targets: [] }), ambiguousTurn(f, { targets: [] }));
  f.say('open the newest pdf', 'req_1');
  await askAndAnswer(f, 'the first one', 'req_2');
  await f.drain();
  assert.equal(f.codex.runs.length, 2);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'failed');
  assert.match(f.speech.spoken.at(-1)!.text, /couldn't tell which one/);
});

test('Ruling 2: a capture abort after a committed action: failed_after_side_effects, reason clarification_cancelled', async () => {
  const f = await fixture();
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'app.launch', observedState: obs('viewer opened', 'committed'), verified: true, sideEffect: 'committed' });
    return ambiguousTurn(f, { targets: [] })({ hooks } as RunCtx);
  });
  f.say('open the newest pdf', 'req_1');
  await flush();
  f.c.handleCaptureAborted('user cancelled capture');
  await f.drain();
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed_after_side_effects', 'clarification_cancelled']);
});
