/** Transcript-driven AuthPort behaviour against the scripted fake App Server. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authStateAdmitsTasks } from '@dottie/contracts';
import { concat, loadTranscript } from './support/fake-app-server.js';
import { setup, until } from './support/harness.js';

const HANDSHAKE = loadTranscript('handshake-signed-out.jsonl');

async function started(scripts: string[]) {
  const h = setup({ scripts });
  await h.adapter.start();
  await until(() => h.statuses.length > 0, 'first auth status');
  return h;
}

function assertClean(h: { problems(): string[]; fakes: { finished: boolean; remaining(): string }[] }) {
  assert.deepEqual(h.problems(), []);
  for (const f of h.fakes) assert.ok(f.finished, `script not finished:\n${f.remaining()}`);
}

test('handshake: initialize (experimentalApi:false) → initialized → account/read; signed out is reported', async () => {
  const h = await started([HANDSHAKE]);
  await h.fakes[0]!.done();
  assert.equal(h.adapter.status, 'running');
  assert.deepEqual(h.spawns[0]!.args, ['-c', 'forced_login_method="chatgpt"', 'app-server', '--listen', 'stdio://']);
  const init = h.fakes[0]!.received[0] as { params: { capabilities: Record<string, unknown> } };
  assert.deepEqual(init.params.capabilities, { experimentalApi: false, requestAttestation: false });
  assert.deepEqual(h.statuses.at(-1), { status: 'signed_out', accountLabel: null, message: 'Sign in with ChatGPT to use Dottie.' });
  assert.equal(authStateAdmitsTasks(h.statuses.at(-1)!.status), false);
  assertClean(h);
});

test('auth state is unknown/unavailable, never signed_in, before the runtime is ready', async () => {
  const h = setup({ scripts: [HANDSHAKE] });
  assert.equal((await h.adapter.auth.getStatus()).status, 'unavailable');
  assert.deepEqual(await h.adapter.auth.beginLogin('browser'), { mode: 'unavailable', reason: 'codex_unavailable' });
  assert.equal(h.spawns.length, 0);
});

test('browser sign-in success: adapter opens the auth.openai.com URL itself; no URL, token or e-mail crosses the port', async () => {
  const h = await started([concat(HANDSHAKE, loadTranscript('login-browser-success.jsonl'))]);
  const started_ = await h.adapter.auth.beginLogin('browser');
  assert.deepEqual(started_, { mode: 'browser', loginId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(h.opened.length, 1);
  assert.ok(h.opened[0]!.startsWith('https://auth.openai.com/oauth/authorize?'));
  assert.equal(h.statuses.at(-1)!.status, 'signing_in');

  await h.fakes[0]!.reached('user-signs-in');
  h.fakes[0]!.release('user-signs-in');
  await h.fakes[0]!.done();
  await until(() => h.statuses.at(-1)!.status === 'signed_in', 'signed_in');
  assert.deepEqual(h.statuses.at(-1), { status: 'signed_in', accountLabel: 'ChatGPT Plus', message: 'Signed in with ChatGPT.' });
  assert.equal(authStateAdmitsTasks('signed_in'), true);

  const crossed = JSON.stringify([started_, h.statuses]);
  for (const secret of ['example.com', 'person@', 'authorize', 'state=', 'client_id']) assert.ok(!crossed.includes(secret), `leaked ${secret}`);
  const logs = JSON.stringify(h.logger.entries);
  for (const secret of ['example.com', 'authorize', 'state=']) assert.ok(!logs.includes(secret), `log leaked ${secret}`);
  assertClean(h);
});

test('browser sign-in failure: back to signed_out with a retry message', async () => {
  const h = await started([concat(HANDSHAKE, loadTranscript('login-browser-failure.jsonl'))]);
  await h.adapter.auth.beginLogin('browser');
  assert.equal(h.statuses.at(-1)!.status, 'signing_in');
  h.fakes[0]!.release('user-gives-up');
  await h.fakes[0]!.done();
  await until(() => h.statuses.at(-1)!.status === 'signed_out', 'signed_out');
  assert.deepEqual(h.statuses.at(-1), { status: 'signed_out', accountLabel: null, message: "Sign-in didn't complete. Try again." });
  assertClean(h);
});

test('device code: verification URL and user code are returned for display; adapter opens the URL; cancel ends it', async () => {
  const h = await started([concat(HANDSHAKE, loadTranscript('login-device-code.jsonl'))]);
  const r = await h.adapter.auth.beginLogin('device_code');
  assert.deepEqual(r, {
    mode: 'device_code',
    loginId: '33333333-3333-4333-8333-333333333333',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
  });
  assert.deepEqual(h.opened, ['https://auth.openai.com/codex/device']);
  assert.equal(h.statuses.at(-1)!.status, 'signing_in');
  await h.fakes[0]!.reached('user-cancels');
  h.fakes[0]!.release('user-cancels');
  assert.equal(await h.adapter.auth.cancelLogin('33333333-3333-4333-8333-333333333333'), 'canceled');
  await h.fakes[0]!.done();
  await until(() => h.statuses.at(-1)!.status === 'signed_out', 'signed_out');
  assertClean(h);
});

test('cancel: canceled, then not_found for the same id; state ends signed_out', async () => {
  const h = await started([concat(HANDSHAKE, loadTranscript('login-cancel-browser.jsonl'))]);
  const r = await h.adapter.auth.beginLogin('browser');
  assert.equal(r.mode, 'browser');
  h.fakes[0]!.release('user-cancels');
  assert.equal(await h.adapter.auth.cancelLogin('44444444-4444-4444-8444-444444444444'), 'canceled');
  await until(() => h.fakes[0]!.received.filter((m) => m['method'] === 'account/read').length === 3, 'two reads after cancel');
  await until(() => h.statuses.at(-1)!.status === 'signed_out', 'signed_out after cancel');
  assert.equal(await h.adapter.auth.cancelLogin('44444444-4444-4444-8444-444444444444'), 'not_found');
  await h.fakes[0]!.done();
  assertClean(h);
});

test('logout: account/logout, then a fresh account/read reports signed_out', async () => {
  const h = await started([loadTranscript('signed-in-logout.jsonl')]);
  await until(() => h.statuses.at(-1)!.status === 'signed_in', 'signed_in');
  assert.equal(h.statuses.at(-1)!.accountLabel, 'ChatGPT Pro');
  h.fakes[0]!.release('user-logs-out');
  await h.adapter.auth.logout();
  await h.fakes[0]!.done();
  await until(() => h.statuses.at(-1)!.status === 'signed_out', 'signed_out');
  assert.equal(h.statuses.at(-1)!.accountLabel, null);
  assertClean(h);
});

test('a non-auth.openai.com authUrl is refused: never opened, login cancelled, security log, still signed_out', async () => {
  const h = await started([concat(HANDSHAKE, loadTranscript('login-untrusted-url.jsonl'))]);
  const r = await h.adapter.auth.beginLogin('browser');
  assert.deepEqual(r, { mode: 'unavailable', reason: 'untrusted_sign_in_url' });
  assert.deepEqual(h.opened, []);
  await h.fakes[0]!.done();
  assert.ok(h.statuses.every((s) => s.status !== 'signing_in' && s.status !== 'signed_in'));
  const sec = h.logger.entries.filter((e) => e.event === 'security.auth.url_check');
  assert.equal(sec.length, 1);
  assert.equal(sec[0]!.fields['outcome'], 'rejected');
  assert.equal(sec[0]!.fields['reason'], 'host');
  assert.deepEqual(Object.keys(sec[0]!.fields).sort(), ['loginId', 'outcome', 'reason'], 'reason code and loginId only');
  assert.ok(!JSON.stringify(sec).includes('evil'), 'the URL itself is not logged');
  assertClean(h);
});

test('an auth.openai.com authUrl whose redirect_uri is not loopback /auth/callback is refused: reason redirect_uri, never opened', async () => {
  const h = await started([concat(HANDSHAKE, loadTranscript('login-bad-redirect.jsonl'))]);
  const r = await h.adapter.auth.beginLogin('browser');
  assert.deepEqual(r, { mode: 'unavailable', reason: 'untrusted_sign_in_url' });
  assert.deepEqual(h.opened, []);
  await h.fakes[0]!.done();
  assert.ok(h.statuses.every((s) => s.status !== 'signing_in' && s.status !== 'signed_in'));
  const sec = h.logger.entries.filter((e) => e.event === 'security.auth.url_check');
  assert.deepEqual(sec.map((e) => e.fields), [{ outcome: 'rejected', reason: 'redirect_uri', loginId: '66666666-6666-4666-8666-666666666666' }]);
  assert.ok(!JSON.stringify(h.logger.entries).includes('evil'), 'no part of the URL is logged');
  assertClean(h);
});

test('only browser and device_code logins exist: any other mode is refused without touching the wire', async () => {
  const h = await started([HANDSHAKE]);
  await h.fakes[0]!.done();
  for (const mode of ['apiKey', 'chatgptAuthTokens', 'api_key']) {
    // @ts-expect-error deliberately outside LoginMode
    assert.deepEqual(await h.adapter.auth.beginLogin(mode), { mode: 'unavailable', reason: 'unsupported_login_mode' });
  }
  assert.equal(h.fakes[0]!.received.filter((m) => m['method'] === 'account/login/start').length, 0);
  assertClean(h);
});
