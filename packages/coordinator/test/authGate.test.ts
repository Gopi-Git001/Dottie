/**
 * DOT-061: the auth gate is an allow-list (ADR-0010, ADR-0012 §3, CONTRACTS v2 §2.1/§3, RISKS R19).
 * Only an explicit `signed_in` from a fresh, bounded auth read may reach CodexPort.run().
 * E01 rulings (CONTRACTS §2.1 "Auth gate outcomes", ADR-0010, ADR-0012 §6):
 *   signed_out | expired → AUTH_REQUIRED, blocked_auth, reason auth_required ("reconnect ChatGPT")
 *   signing_in           → AUTH_REQUIRED, blocked_auth, reason sign_in_in_progress ("finish signing in")
 *   unsupported          → AUTH_REQUIRED, blocked_auth, reason account_unsupported ("can't run Codex"; sign out / switch; never reconnect)
 *   unavailable | unknown | throw | reject | timeout → blocked_unavailable, reason codex_unavailable, STANDBY, no sign-in copy.
 * waiting_for_env is the supervisor's RuntimeStatus (CONTRACTS §2.4, ADR-0013), not a coordinator state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthState, PolicyPort } from '../src/ports.js';
import { allowAllChannels, approval, fixture, flush, obs, utterance } from './helpers.js';
import { validateEvent } from '../src/contracts.js';

const SIGN_IN: AuthState[] = ['signed_out', 'expired', 'signing_in', 'unsupported'];
/** Expected reason and spoken copy per account state (CONTRACTS §2.1). */
const ACCOUNT: Record<string, { reason: string; copy: RegExp; never?: RegExp }> = {
  signed_out: { reason: 'auth_required', copy: /reconnect ChatGPT/i },
  expired: { reason: 'auth_required', copy: /reconnect ChatGPT/i },
  signing_in: { reason: 'sign_in_in_progress', copy: /finish signing in/i, never: /reconnect/i },
  unsupported: { reason: 'account_unsupported', copy: /can't run Codex[\s\S]*(sign out|switch)/i, never: /reconnect/i },
};
const UNAVAILABLE: AuthState[] = ['unavailable', 'unknown'];
const accepted = (f: { c: { transitions: readonly { to: string; accepted: boolean }[] } }) => f.c.transitions.filter(t => t.accepted).map(t => t.to);
type F = Awaited<ReturnType<typeof fixture>>;

function assertNotDispatched(f: F, label: string) {
  assert.equal(f.codex.runs.length, 0, `${label}: run() must not be called`);
  assert.equal(f.sink.of('TaskRequested').length, 0, `${label}: TaskRequested is never sent (CONTRACTS §3)`);
  const fin = f.sink.of('TaskFinished');
  assert.equal(fin.length, 1, `${label}: exactly one TaskFinished`);
  assert.equal(fin[0]!.payload.verified, false, label);
  return fin[0]!.payload;
}

async function assertBlocked(f: F, label: string, state: AuthState = 'signed_out'): Promise<void> {
  const exp = ACCOUNT[state]!;
  const fin = assertNotDispatched(f, label);
  assert.equal(fin.outcome, 'blocked_auth', label);
  assert.equal(fin.reason, exp.reason, `${label}: reason`);
  assert.ok(accepted(f).includes('AUTH_REQUIRED'), `${label}: routed through AUTH_REQUIRED`);
  assert.equal(f.c.state, 'AUTH_REQUIRED', `${label}: rests in AUTH_REQUIRED`);
  assert.match(f.speech.spoken.at(-1)!.text, exp.copy, `${label}: copy`);
  if (exp.never) {
    for (const s of f.speech.spoken) assert.doesNotMatch(s.text, exp.never, `${label}: never a reconnect prompt`);
    assert.doesNotMatch(fin.summary, exp.never, `${label}: summary`);
  }
}

async function assertUnavailable(f: F, label: string): Promise<void> {
  const fin = assertNotDispatched(f, label);
  assert.equal(fin.outcome, 'blocked_unavailable', `${label}: own outcome, never blocked_auth`);
  assert.equal(fin.reason, 'codex_unavailable', `${label}: reason`);
  assert.ok(!accepted(f).includes('AUTH_REQUIRED'), `${label}: never AUTH_REQUIRED`);
  assert.equal(f.c.state, 'STANDBY', `${label}: back to idle`);
  for (const s of f.speech.spoken) assert.doesNotMatch(s.text, /sign[ -]?in|reconnect|log ?in/i, `${label}: no sign-in prompt`);
  assert.doesNotMatch(fin.summary, /sign[ -]?in|reconnect|log ?in/i, `${label}: summary has no sign-in prompt`);
  assert.match(f.speech.spoken.at(-1)!.text, /can't reach Codex/i, label);
}

test('DOT-061: signed_in dispatches exactly once', async () => {
  const f = await fixture();
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.sink.of('TaskRequested').length, 1);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'answered');
});

for (const state of SIGN_IN) {
  test(`DOT-061: auth state '${state}' blocks dispatch → AUTH_REQUIRED (0 run() calls, blocked_auth, sign-in prompt)`, async () => {
    const f = await fixture();
    f.codex.auth = state; // flips after boot, so only the dispatch-time read decides
    f.say(`open downloads (${state})`);
    await f.drain();
    await assertBlocked(f, state, state);
  });
}

for (const state of UNAVAILABLE) {
  test(`DOT-061: auth state '${state}' blocks dispatch as codex_unavailable (STANDBY, no sign-in prompt)`, async () => {
    const f = await fixture();
    f.codex.auth = state;
    f.say(`open downloads (${state})`);
    await f.drain();
    await assertUnavailable(f, state);
  });
}

test('DOT-061: an auth read that throws synchronously blocks dispatch as codex_unavailable', async () => {
  const f = await fixture();
  f.codex.authImpl = () => { throw new Error('adapter crashed'); };
  f.say('open downloads');
  await f.drain();
  await assertUnavailable(f, 'sync throw');
});

test('DOT-061: an auth read that rejects blocks dispatch as codex_unavailable', async () => {
  const f = await fixture();
  f.codex.authImpl = () => Promise.reject(new Error('app-server not running'));
  f.say('open downloads');
  await f.drain();
  await assertUnavailable(f, 'rejected');
});

test('DOT-061: a hung auth read blocks as codex_unavailable after authReadTimeoutMs, and a late signed_in does not dispatch', async () => {
  const f = await fixture({ config: { authReadTimeoutMs: 2_000 } });
  let resolveLate!: (s: AuthState) => void;
  f.codex.authImpl = () => new Promise<AuthState>(r => (resolveLate = r));
  f.say('open downloads');
  await flush();
  assert.equal(f.codex.runs.length, 0);
  await f.clock.advance(1_999);
  assert.equal(f.sink.of('TaskFinished').length, 0, 'still waiting inside the bound');
  await f.clock.advance(1);
  await f.drain();
  await assertUnavailable(f, 'timeout');
  resolveLate('signed_in');
  await f.drain();
  assert.equal(f.codex.runs.length, 0, 'late answer never dispatches');
});

test('DOT-061: a slow read that answers signed_in inside the bound dispatches', async () => {
  const f = await fixture({ config: { authReadTimeoutMs: 2_000 } });
  f.codex.authImpl = () => new Promise<AuthState>(r => void f.clock.sleep(1_500).then(() => r('signed_in')));
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
});

test('DOT-061: auth flipping during CONFIRMING (between check and dispatch) blocks dispatch', async () => {
  const policy: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log', risk: 'high', category: 'delete' }) };
  const f = await fixture({ policy });
  f.say('delete old.log');
  await flush();
  assert.equal(f.c.state, 'CONFIRMING');
  f.codex.auth = 'expired';
  const actionId = f.sink.of('ApprovalRequested')[0]!.payload.actionId;
  f.c.resolveApproval(approval(actionId, true, f), 'secure_ui');
  await f.drain();
  assert.equal(f.codex.runs.length, 0, 'approval does not bypass a fresh auth read');
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'blocked_auth');
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.reason, 'auth_required');
  assert.equal(f.c.state, 'AUTH_REQUIRED');
});

test('DOT-061: a sign-out notification that lands while the auth read is in flight wins', async () => {
  const f = await fixture();
  let resolveRead!: (s: AuthState) => void;
  f.codex.authImpl = () => new Promise<AuthState>(r => (resolveRead = r));
  f.say('open downloads');
  await flush();
  f.c.handleAuthChanged('signed_out');
  resolveRead('signed_in'); // stale read started before the sign-out
  await f.drain();
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'blocked_auth');
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.reason, 'auth_required');
});

test('DOT-061: every retry re-checks auth; expiry during backoff stops the retry', async () => {
  const f = await fixture();
  f.codex.scripts.push(async () => {
    f.codex.auth = 'expired';
    return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'socket closed' } };
  });
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1, 'no second run without a fresh signed_in');
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.outcome, 'blocked_auth');
  assert.equal(f.sink.of('TaskFinished')[0]!.payload.reason, 'auth_required');
  assert.equal(f.c.state, 'AUTH_REQUIRED');
});

test('DOT-061: a queued task is gated at its own dispatch time', async () => {
  const f = await fixture();
  let release!: () => void;
  f.codex.scripts.push(async () => { await new Promise<void>(r => (release = r)); return { status: 'completed', summary: 'First done.' }; });
  f.say('first task');
  await flush();
  assert.equal(f.c.submitUtterance(utterance('second task', 'req_q2')).kind, 'queued');
  f.codex.auth = 'unknown';
  release();
  await f.drain();
  assert.equal(f.codex.runs.length, 1, 'queued task not dispatched on unknown auth');
  assert.deepEqual(f.sink.of('TaskFinished').map(e => [e.payload.outcome, e.payload.reason]), [['answered', undefined], ['blocked_unavailable', 'codex_unavailable']]);
  assert.equal(f.c.state, 'STANDBY');
});

test('DOT-061: completing sign-in afterwards resumes nothing (user re-issues the command)', async () => {
  const f = await fixture();
  f.codex.auth = 'expired';
  f.say('open downloads');
  await f.drain();
  f.codex.auth = 'signed_in';
  f.c.handleAuthChanged('signed_in');
  await f.drain();
  assert.equal(f.c.state, 'STANDBY');
  assert.equal(f.codex.runs.length, 0);
});

test('DOT-061: boot follows the split: sign-in states rest in AUTH_REQUIRED, Codex-down states rest in STANDBY (idle)', async () => {
  for (const state of SIGN_IN) {
    const f = await fixture({ boot: false });
    f.codex.auth = state;
    await f.c.boot();
    assert.equal(f.c.state, 'AUTH_REQUIRED', state);
  }
  for (const state of [...UNAVAILABLE, 'throw', 'reject', 'hang'] as const) {
    const f = await fixture({ boot: false, config: { authReadTimeoutMs: 5_000 } });
    if (state === 'throw') f.codex.authImpl = () => { throw new Error('down'); };
    else if (state === 'reject') f.codex.authImpl = () => Promise.reject(new Error('down'));
    else if (state === 'hang') f.codex.authImpl = () => new Promise<AuthState>(() => undefined);
    else f.codex.auth = state;
    const booted = f.c.boot();
    if (state === 'hang') await f.clock.advance(5_000);
    await booted;
    assert.equal(f.c.state, 'STANDBY', state);
    assert.ok(!accepted(f).includes('AUTH_REQUIRED'), state);
    assert.equal(f.speech.spoken.length, 0, `${state}: no sign-in prompt at boot`);
  }
  const ok = await fixture();
  assert.equal(ok.c.state, 'STANDBY');
});

test('DOT-061: booting idle on Codex-down still never dispatches; the next task is gated and blocked as codex_unavailable', async () => {
  const f = await fixture({ boot: false });
  f.codex.auth = 'unavailable';
  await f.c.boot();
  f.say('open downloads');
  await f.drain();
  await assertUnavailable(f, 'after unavailable boot');
});

test('DOT-061: Codex recovering (a later signed_in read) admits the NEXT command only; the blocked task is not resumed', async () => {
  const f = await fixture();
  f.codex.auth = 'unavailable';
  f.say('open downloads', 'req_1');
  await f.drain();
  f.codex.auth = 'signed_in';
  f.c.handleAuthChanged('signed_in');
  await f.drain();
  assert.equal(f.codex.runs.length, 0, 'nothing auto-resumed');
  assert.equal(f.c.state, 'STANDBY');
  await f.clock.advance(20_000);
  f.say('open downloads', 'req_2');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.deepEqual(f.sink.of('TaskFinished').map(e => [e.payload.outcome, e.payload.reason]), [['blocked_unavailable', 'codex_unavailable'], ['answered', undefined]]);
});

test('DOT-061: auth notifications follow the split (unavailable never moves to AUTH_REQUIRED; signed_out does)', async () => {
  const f = await fixture();
  f.c.handleAuthChanged('unavailable');
  assert.equal(f.c.state, 'STANDBY');
  f.c.handleAuthChanged('signed_out');
  assert.equal(f.c.state, 'AUTH_REQUIRED');
  f.c.handleAuthChanged('signed_in');
  assert.equal(f.c.state, 'STANDBY');
  assert.equal(f.speech.spoken.length, 0);
});

test('DOT-061: Codex going down during retry backoff blocks the retry as codex_unavailable (ledger empty)', async () => {
  const f = await fixture();
  f.codex.scripts.push(async () => {
    f.codex.authImpl = () => Promise.reject(new Error('app-server exited'));
    return { status: 'failed', error: { kind: 'transient', origin: 'turn_failed', message: 'socket closed' } };
  });
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['blocked_unavailable', 'codex_unavailable']);
  assert.equal(f.c.state, 'STANDBY');
});

test('DOT-061: plan_limit is never retried: one run, no RECOVERING, outcome failed, no API-key fallback', async () => {
  const f = await fixture();
  f.codex.defaultScript = async () => ({ status: 'failed', error: { kind: 'plan_limit', origin: 'turn_failed', message: 'usageLimitExceeded' } });
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  assert.ok(!accepted(f).includes('RECOVERING'));
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.equal(fin.outcome, 'failed');
  assert.match(fin.summary, /usage limit/i);
  assert.match(fin.summary, /won't retry/i);
});

test('DOT-061: account_unsupported never becomes a reconnect loop (repeat notifications and commands stay calm and honest)', async () => {
  const f = await fixture();
  f.codex.auth = 'unsupported';
  f.say('open downloads', 'req_1');
  await f.drain();
  f.c.handleAuthChanged('unsupported');
  f.c.handleAuthChanged('unsupported');
  assert.equal(f.c.state, 'AUTH_REQUIRED');
  const spokenAfterNotices = f.speech.spoken.length;
  assert.equal(spokenAfterNotices, 1, 'notifications alone never prompt');
  await f.clock.advance(20_000);
  f.say('open downloads again', 'req_2'); // wake still works from AUTH_REQUIRED
  await f.drain();
  assert.equal(f.codex.runs.length, 0);
  assert.deepEqual(f.sink.of('TaskFinished').map(e => [e.payload.outcome, e.payload.reason]), [['blocked_auth', 'account_unsupported'], ['blocked_auth', 'account_unsupported']]);
  for (const s of f.speech.spoken) assert.doesNotMatch(s.text, /reconnect/i);
  assert.ok(!f.c.transitions.some(t => t.reason.includes('login') || t.reason.includes('reconnect')), 'coordinator never starts a sign-in itself');
});

// CONTRACTS §2.1 "Mid-run and after-commit" (E01 2026-10-19).
test('§2.1 mid-run: a Codex auth error with nothing committed ends blocked_auth, reason auth_required (no retry)', async () => {
  const f = await fixture();
  f.codex.defaultScript = async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'files.read', mayHaveSideEffects: false });
    hooks.toolResult({ toolId: 'files.read', observedState: obs('read'), verified: true, sideEffect: 'none' });
    return { status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: '401' } };
  };
  f.say('open downloads');
  await f.drain();
  assert.equal(f.codex.runs.length, 1, 'auth errors are never retried');
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason, fin.verified], ['blocked_auth', 'auth_required', false]);
  assert.equal(f.sink.of('TaskFinished').length, 1);
  assert.ok(accepted(f).includes('AUTH_REQUIRED'));
  assert.equal(f.c.state, 'AUTH_REQUIRED');
  assert.match(f.speech.spoken.at(-1)!.text, /Reconnect/);
});

test('§2.1 after-commit: a Codex auth error after a committed action ends failed_after_side_effects, reason auth_required', async () => {
  const f = await fixture();
  f.codex.defaultScript = async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'files.move', mayHaveSideEffects: true });
    hooks.toolResult({ toolId: 'files.move', observedState: obs('moved', 'committed'), verified: true, sideEffect: 'committed' });
    return { status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: '401' } };
  };
  f.say('move the report');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason, fin.verified], ['failed_after_side_effects', 'auth_required', false]);
  assert.match(fin.summary, /files\.move/, 'the committed action is reported, not hidden');
  assert.equal(f.c.state, 'AUTH_REQUIRED', 'still routed to AUTH_REQUIRED');
  for (const e of f.sink.events) assert.ok(validateEvent(JSON.parse(JSON.stringify(e))).ok, e.type);
});

test('§2.1 after-commit: a possible (in-flight, unconfirmed) side effect also counts as committed for the outcome', async () => {
  const f = await fixture();
  f.codex.defaultScript = async ({ hooks }) => {
    hooks.toolStarted({ toolId: 'mail.send', mayHaveSideEffects: true }); // no result before the auth failure
    return { status: 'failed', error: { kind: 'auth', origin: 'turn_failed', message: '401' } };
  };
  f.say('send the mail');
  await f.drain();
  const fin = f.sink.of('TaskFinished')[0]!.payload;
  assert.deepEqual([fin.outcome, fin.reason], ['failed_after_side_effects', 'auth_required']);
});
