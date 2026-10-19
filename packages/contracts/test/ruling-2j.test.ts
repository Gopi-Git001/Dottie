/** E01 ruling 2j: TaskCancelled.committedActions[].observedState may be null ONLY with certainty 'possible'. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEvent } from '../src/index.js';

const cancelled = (certainty: unknown, observedState: unknown = null) => ({
  schema: 'dottie.event', version: 2, type: 'TaskCancelled', eventId: 'evt-2j', correlationId: 'corr-1',
  timestamp: '2026-10-19T11:55:00.000-05:00', taskId: 'task-1',
  payload: {
    taskId: 'task-1', stopStatus: 'stop_unconfirmed', sideEffects: 'possible', sideEffectsCommitted: false,
    committedActions: [{ toolId: 'files.write', observedState, certainty }], report: 'Stopped.',
  },
});
const AT = 'payload.committedActions[0].observedState';

test("ruling 2j: observedState null is ACCEPTED when certainty is 'possible'", () => {
  const r = validateEvent(cancelled('possible'));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("ruling 2j: observedState null is REJECTED when certainty is 'committed' (same event otherwise), by the 2j rule", () => {
  const r = validateEvent(cancelled('committed'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.issues, [{ path: AT, message: "may be null only for an unverified entry with certainty 'possible' (ruling 2j)" }]);
});

test('ruling 2j: null with a certainty outside the enum is rejected (enum issue), never accepted', () => {
  for (const c of ['unknown', 'verified', null, undefined]) {
    const r = validateEvent(cancelled(c));
    assert.equal(r.ok, false, String(c));
    assert.ok(!r.ok && r.issues.some((i) => i.path === 'payload.committedActions[0].certainty'), String(c));
  }
});

test("ruling 2j: a non-null observedState with certainty 'committed' is unaffected (the null rule only)", () => {
  const os = { outcome: 'verified', decision: 'done', checks: { exists: 'pass' }, sideEffect: 'committed' };
  const ev = cancelled('committed', os);
  (ev.payload as Record<string, unknown>)['sideEffects'] = 'committed';
  (ev.payload as Record<string, unknown>)['sideEffectsCommitted'] = true;
  assert.equal(validateEvent(ev).ok, true);
});
