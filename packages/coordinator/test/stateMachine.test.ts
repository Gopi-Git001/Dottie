import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, TRANSITIONS, isValidTransition, type CoordinatorState } from '../src/states.js';
import { StateMachine } from '../src/stateMachine.js';
import { MemLogger } from './helpers.js';

const HAPPY: CoordinatorState[] = ['BOOTING', 'STANDBY', 'WAKE_DETECTED', 'LISTENING', 'TRANSCRIBING', 'CONFIRMING', 'EXECUTING', 'VERIFYING', 'SPEAKING', 'STANDBY'];

test('transition table covers every state and only targets known states', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATES].sort());
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) assert.ok((STATES as readonly string[]).includes(to), `${from} -> ${to}`);
    assert.ok(!tos.includes(from as CoordinatorState), `no self-transition on ${from}`);
  }
  assert.deepEqual(TRANSITIONS.SHUTDOWN, [], 'SHUTDOWN is terminal');
});

test('spec happy path (with and without CONFIRMING) is valid', () => {
  for (let i = 1; i < HAPPY.length; i++) assert.ok(isValidTransition(HAPPY[i - 1]!, HAPPY[i]!), `${HAPPY[i - 1]} -> ${HAPPY[i]}`);
  assert.ok(isValidTransition('TRANSCRIBING', 'EXECUTING'), 'CONFIRMING is optional');
});

test('every additional state is reachable from the main loop and can leave (except SHUTDOWN)', () => {
  const reachable = new Set<CoordinatorState>(['BOOTING']);
  const frontier: CoordinatorState[] = ['BOOTING'];
  while (frontier.length) for (const to of TRANSITIONS[frontier.pop()!]) if (!reachable.has(to)) { reachable.add(to); frontier.push(to); }
  assert.deepEqual([...reachable].sort(), [...STATES].sort());
  for (const s of STATES) if (s !== 'SHUTDOWN') assert.ok(TRANSITIONS[s].length > 0, s);
});

test('a running task can never be silently abandoned', () => {
  for (const s of ['EXECUTING', 'PERMISSION_REQUIRED', 'VERIFYING'] as const) {
    assert.ok(!isValidTransition(s, 'STANDBY'), `${s} -> STANDBY`);
    assert.ok(!isValidTransition(s, 'SHUTDOWN'), `${s} -> SHUTDOWN`);
    assert.ok(isValidTransition(s, 'CANCELLING'), `${s} -> CANCELLING`);
  }
  assert.ok(!isValidTransition('STANDBY', 'EXECUTING'), 'no dispatch without a transcribed command');
  assert.ok(!isValidTransition('MUTED', 'WAKE_DETECTED'), 'no wake while muted');
});

test('StateMachine applies exactly the table: exhaustive pairwise check', () => {
  for (const from of STATES) for (const to of STATES) {
    const log = new MemLogger();
    const m = new StateMachine(log, () => 0, () => {}, from);
    const r = m.transition(to, 'probe');
    assert.equal(r.ok, TRANSITIONS[from].includes(to), `${from} -> ${to}`);
    assert.equal(m.state, r.ok ? to : from);
  }
});

test('invalid transitions are rejected, logged, recorded and not applied', () => {
  const log = new MemLogger();
  const changes: string[] = [];
  const m = new StateMachine(log, () => 42, (f, t) => changes.push(`${f}>${t}`));
  assert.equal(m.transition('STANDBY', 'boot').ok, true);
  const r = m.transition('EXECUTING', 'sneaky dispatch');
  assert.equal(r.ok, false);
  assert.equal(m.state, 'STANDBY');
  assert.equal(m.rejected, 1);
  assert.deepEqual(changes, ['BOOTING>STANDBY'], 'onChange not fired for rejected transition');
  const warn = log.find('coordinator.transition.rejected');
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!.level, 'warn');
  assert.deepEqual(warn[0]!.fields, { from: 'STANDBY', to: 'EXECUTING', reason: 'sneaky dispatch' });
  assert.deepEqual(m.history.at(-1), { from: 'STANDBY', to: 'EXECUTING', reason: 'sneaky dispatch', at: 42, accepted: false });
});
