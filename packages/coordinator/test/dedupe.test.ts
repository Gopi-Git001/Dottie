import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DedupeGuard, normalizeUtterance } from '../src/dedupe.js';
import { FakeClock, fixture, utterance } from './helpers.js';

test('normalisation ignores case, punctuation, spacing and a leading wake word', () => {
  assert.equal(normalizeUtterance('  Dottie, OPEN   Downloads!! '), 'open downloads');
  assert.equal(normalizeUtterance('Hey Dottie open downloads'), 'open downloads');
  assert.equal(normalizeUtterance('...'), '');
});

test('guard: same requestId always duplicate; same text only within the window; allowRepeat bypasses text only', async () => {
  const clock = new FakeClock();
  const g = new DedupeGuard(clock, 10_000);
  const v1 = g.check('r1', 'Open Downloads');
  assert.equal(v1.duplicate, false);
  g.record('r1', v1.key, 't1');
  assert.deepEqual(g.check('r1', 'something else'), { duplicate: true, key: 'something else', reason: 'same_request_id', originalTaskId: 't1' });
  assert.equal(g.check('r2', 'open downloads.').duplicate, true);
  assert.equal(g.check('r2', 'open downloads', true).duplicate, false);
  assert.equal(g.check('r1', 'open downloads', true).duplicate, true, 'requestId idempotency is never bypassed');
  await clock.advance(9_999);
  assert.equal(g.check('r3', 'open downloads').duplicate, true);
  await clock.advance(1);
  assert.equal(g.check('r3', 'open downloads').duplicate, false, 'window expired');
  assert.equal(g.check('r1', 'x').duplicate, true, 'requestId still remembered after text window');
});

test('coordinator: replayed UtteranceReady and double-wake resubmission produce exactly one Codex run', async () => {
  const f = await fixture();
  f.codex.defaultScript = async ({ aborted }) => { await Promise.race([aborted, new Promise(r => setTimeout(r, 5))]); return { status: 'completed', summary: 'Done.' }; };
  const first = f.say('open downloads', 'req_A');
  assert.equal(first.kind, 'started');
  const replay = f.c.submitUtterance(utterance('open downloads', 'req_A'));
  assert.deepEqual(replay, { kind: 'duplicate', originalTaskId: first.kind === 'started' ? first.taskId : '', reason: 'same_request_id' });
  const echo = f.c.submitUtterance(utterance('Dottie, open Downloads.', 'req_B'));
  assert.equal(echo.kind, 'duplicate');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.sink.of('TaskRequested').length, 1);
  assert.equal(f.log.find('coordinator.utterance.duplicate').length, 2);
  // after the window the same words are a new command
  await f.clock.advance(10_000);
  assert.equal(f.say('open downloads', 'req_C').kind, 'started');
  await f.drain();
  assert.equal(f.codex.runs.length, 2);
});
