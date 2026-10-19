/** Child supervision: integrity, env allowlist, forced login flag, handshake, crash → restart with backoff, breaker, stop. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_RESTART_POLICY, EnvError, IntegrityError } from '../src/index.js';
import { concat, loadTranscript } from './support/fake-app-server.js';
import { setup, until } from './support/harness.js';

const HANDSHAKE = loadTranscript('handshake-signed-out.jsonl');
const CRASH = concat(HANDSHAKE, '## exit 1');

test('env allowlist: OPENAI_*, AZURE_OPENAI_*, other CODEX_* and FOO never reach the child; CODEX_HOME is Dottie\'s; names only logged', async () => {
  const parentEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    HTTPS_PROXY: 'http://proxy:3128',
    http_proxy: 'http://proxy:3128',
    NO_PROXY: 'localhost',
    no_proxy: '127.0.0.1',
    OPENAI_API_KEY: 'sk-live-1',
    openai_api_key: 'sk-live-2',
    OPENAI_BASE_URL: 'https://evil.example/v1',
    AZURE_OPENAI_API_KEY: 'az-6',
    azure_openai_endpoint: 'https://az.example',
    Codex_Api_Key: 'ck-3',
    CODEX_ACCESS_TOKEN: 'tok-4',
    CODEX_SANDBOX: 'off',
    CODEX_HOME: '/somewhere/else',
    FOO: 'foo-7',
  };
  const h = setup({ scripts: [HANDSHAKE], overrides: { parentEnv, platform: 'linux' } });
  await h.adapter.start();
  const env = h.spawns[0]!.env;
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'HTTPS_PROXY', 'LANG', 'NO_PROXY', 'PATH', 'http_proxy', 'no_proxy']);
  assert.equal(env['CODEX_HOME'], join(h.bin.dir, 'codex-home'));
  for (const v of ['sk-live-1', 'sk-live-2', 'ck-3', 'tok-4', 'az-6', 'evil.example', 'az.example', 'off', '/somewhere/else', 'foo-7']) {
    assert.ok(!Object.values(env).some((x) => x.includes(v)), `${v} reached the child`);
  }
  const logs = JSON.stringify(h.logger.entries);
  for (const v of ['sk-live-1', 'sk-live-2', 'ck-3', 'tok-4', 'az-6', 'evil.example']) assert.ok(!logs.includes(v));
  const scrub = h.logger.entries.filter((e) => e.event === 'security.env.scrub');
  assert.equal(scrub.length, 1);
  // CONTRACTS §3.2 env shape: sensitive removed names are listed, any other removed name (FOO) is only counted.
  assert.deepEqual(scrub[0]!.fields, {
    keptNames: 'CODEX_HOME,HOME,HTTPS_PROXY,LANG,NO_PROXY,PATH,http_proxy,no_proxy',
    removedSensitiveNames: 'AZURE_OPENAI_API_KEY,CODEX_ACCESS_TOKEN,CODEX_HOME,CODEX_SANDBOX,Codex_Api_Key,OPENAI_API_KEY,OPENAI_BASE_URL,azure_openai_endpoint,openai_api_key',
    removedOtherCount: 1,
    keptCount: 8,
    removedCount: 10,
    canary: 'not_run',
    outcome: 'ok',
  });
  assert.ok(!JSON.stringify(scrub).includes('FOO'), 'a non-sensitive removed name may be personal: counted, never listed');
});

test('proxy values are never logged: credentials in a proxy URL appear in no log or audit record; only names may', async () => {
  const secret = `pw-${randomUUID()}`;
  const proxy = `http://alice:${secret}@proxy.corp.example:3128`;
  const parentEnv = { PATH: '/usr/bin', HTTPS_PROXY: proxy, http_proxy: proxy, ALL_PROXY: `socks5://bob:${secret}@socks.corp.example:1080`, NO_PROXY: 'internal.corp.example', FOO: 'x' };
  const h = setup({ scripts: [concat(HANDSHAKE, '## exit 1'), HANDSHAKE], overrides: { parentEnv, platform: 'linux' } });
  await h.adapter.start();
  await until(() => h.adapter.status === 'backoff', 'crash');
  h.scheduler.advance(30_000);
  await until(() => h.spawns.length === 2 && h.adapter.status === 'running', 'restarted');
  await h.fakes[1]!.done();
  assert.equal(h.spawns[0]!.env['HTTPS_PROXY'], proxy, 'the child still gets the proxy');
  const logs = JSON.stringify(h.logger.entries);
  for (const v of [secret, 'alice', 'bob', 'proxy.corp.example', 'socks.corp.example', 'internal.corp.example', proxy]) assert.ok(!logs.includes(v), `${v} logged`);
  const scrub = h.logger.entries.filter((e) => e.event === 'security.env.scrub');
  assert.equal(scrub.length, 2);
  for (const e of scrub) {
    assert.deepEqual(e.fields, {
      keptNames: 'ALL_PROXY,CODEX_HOME,HTTPS_PROXY,NO_PROXY,PATH,http_proxy',
      removedSensitiveNames: '',
      removedOtherCount: 1,
      keptCount: 6,
      removedCount: 1,
      canary: 'not_run',
      outcome: 'ok',
    });
  }
});

test('CANARY (CONTRACTS §1.1, DOT-089): OPENAI_API_KEY=CANARY-<uuid> never reaches the child env, and the value is in no log', async () => {
  const canary = `CANARY-${randomUUID()}`;
  for (const platform of ['linux', 'win32'] as const) {
    const h = setup({ scripts: [HANDSHAKE], overrides: { parentEnv: { PATH: '/usr/bin', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: canary }, platform } });
    await h.adapter.start();
    await h.fakes[0]!.done();
    const env = h.spawns[0]!.env;
    assert.ok(!Object.keys(env).some((k) => k.toUpperCase() === 'OPENAI_API_KEY'), platform);
    assert.ok(!Object.values(env).some((v) => v.includes(canary)), platform);
    assert.ok(!JSON.stringify(h.logger.entries).includes(canary), `${platform}: canary value in a log`);
    assert.ok(!JSON.stringify(h.spawns[0]!.args).includes(canary));
  }
});

test("refuses to run against the user's own ~/.codex (ADR-0004): no spawn", async () => {
  const h = setup({ scripts: [HANDSHAKE] });
  const h2 = setup({ scripts: [HANDSHAKE], overrides: { codexHome: join(h.bin.dir, 'home', '.codex'), userHome: join(h.bin.dir, 'home') } });
  await assert.rejects(h2.adapter.start(), EnvError);
  assert.equal(h2.spawns.length, 0);
  assert.equal(h2.adapter.status, 'breaker_open');
  assert.equal(h2.adapter.health.halt, 'env_config');
});

test('bad sha256 refuses to launch: no spawn, breaker_open with halt integrity (§2.4), security log, no restart', async () => {
  const h = setup({ scripts: [HANDSHAKE], overrides: { expectedSha256: 'f'.repeat(64) } });
  await assert.rejects(h.adapter.start(), IntegrityError);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.adapter.status, 'breaker_open');
  assert.equal(h.adapter.health.halt, 'integrity');
  assert.ok(h.logger.entries.some((e) => e.event === 'security.codex.integrity_failed'));
  h.scheduler.advance(3_600_000);
  assert.equal(h.spawns.length, 0);
  assert.equal((await h.adapter.auth.getStatus()).status, 'unavailable');
});

test('ADR-0013: full-jitter backoff (base 500 ms), the 5th crash in 10 min opens the breaker, HALF-OPEN after 15 min, cool-off doubles to 2 h', async () => {
  const h = setup({ scripts: Array.from({ length: 12 }, () => CRASH) });
  await h.adapter.start();
  const delays: number[] = [];
  for (let n = 1; n <= 4; n++) {
    await until(() => h.adapter.status === 'backoff', `restarting #${n}`);
    const [d] = h.scheduler.pendingDelays();
    delays.push(d!);
    h.scheduler.advance(d!);
    await until(() => h.spawns.length === n + 1, `spawn #${n + 1}`);
    await until(() => h.fakes[n]!.received.some((m) => m['method'] === 'account/read'), `re-read after restart #${n}`);
  }
  // random()=0.5 → half of min(cap, 500·2^(n-1))
  assert.deepEqual(delays, [250, 500, 1_000, 2_000]);
  await until(() => h.adapter.status === 'breaker_open', 'breaker_open');
  assert.equal(h.spawns.length, 5);
  assert.equal(h.adapter.health.breaker, 'open');
  assert.equal((await h.adapter.auth.getStatus()).status, 'unavailable');
  const coolOffs: number[] = [];
  for (let trip = 1; trip <= 5; trip++) {
    await until(() => h.adapter.status === 'breaker_open', `open #${trip}`);
    const [c] = h.scheduler.pendingDelays();
    coolOffs.push(c!);
    const before: number = h.spawns.length;
    h.scheduler.advance(c! - 1);
    assert.equal(h.spawns.length, before, 'nothing before the cool-off ends');
    h.scheduler.advance(1);
    await until(() => h.spawns.length === before + 1, `half-open probe #${trip}`);
    assert.equal(h.adapter.health.breaker, 'half_open');
  }
  const MIN = 60_000;
  assert.deepEqual(coolOffs, [15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN, 120 * MIN]);
  for (const f of h.fakes) assert.ok(f.received.filter((m) => m['method'] === 'initialize').length <= 1);
  assert.deepEqual(h.problems(), []);
});

test('backoff cap is 30 s on AC and 120 s on battery (power source is an injected input)', async () => {
  for (const [power, expected] of [['ac', 15_000], ['battery', 60_000]] as const) {
    const h = setup({
      scripts: [CRASH, HANDSHAKE],
      overrides: { powerSource: () => power, restartPolicy: { ...DEFAULT_RESTART_POLICY, baseMs: 1_000_000 } },
    });
    await h.adapter.start();
    await until(() => h.adapter.status === 'backoff', 'restarting');
    assert.deepEqual(h.scheduler.pendingDelays(), [expected], power);
  }
});

test('a HALF-OPEN probe that stays healthy closes the breaker and resets the cool-off doubling', async () => {
  const h = setup({ scripts: [...Array.from({ length: 5 }, () => CRASH), HANDSHAKE], overrides: { stableMs: 60_000 } });
  await h.adapter.start();
  for (let n = 1; n <= 4; n++) {
    await until(() => h.adapter.status === 'backoff', 'restarting');
    h.scheduler.advance(h.scheduler.pendingDelays()[0]!);
    await until(() => h.spawns.length === n + 1, 'spawn');
  }
  await until(() => h.adapter.status === 'breaker_open', 'open');
  h.scheduler.advance(15 * 60_000);
  await until(() => h.adapter.status === 'running', 'half-open probe ready');
  assert.ok(h.logger.entries.some((e) => e.event === 'codex.runtime.status' && e.fields['status'] === 'half_open'), 'the trial launch publishes half_open (§2.4)');
  assert.equal(h.adapter.health.breaker, 'half_open');
  h.scheduler.advance(60_000);
  assert.equal(h.adapter.health.breaker, 'closed');
  assert.equal(h.adapter.health.trips, 0);
});

test('env_unavailable (spawn failure) → waiting_for_env: no backoff timer, not counted; envAvailable() relaunches', async () => {
  const h = setup({ scripts: ['## spawnfail ENOENT', '## spawnfail EACCES', HANDSHAKE] });
  await h.adapter.start();
  await until(() => h.adapter.status === 'waiting_for_env', 'waiting_for_env');
  assert.deepEqual(h.scheduler.pendingDelays(), []);
  assert.equal(h.adapter.health.recentFailures, 0);
  assert.equal(h.adapter.health.lastExit, 'env_unavailable');
  h.scheduler.advance(24 * 3_600_000);
  assert.equal(h.spawns.length, 1, 'no spinning while the environment is missing');
  h.adapter.envAvailable();
  await until(() => h.adapter.status === 'waiting_for_env' && h.spawns.length === 2, 'still waiting');
  h.adapter.envAvailable();
  await until(() => h.adapter.status === 'running', 'ready');
  assert.equal(h.adapter.health.recentFailures, 0);
});

test('retry() leaves the open breaker immediately and resets the history', async () => {
  const h = setup({ scripts: [...Array.from({ length: 5 }, () => CRASH), HANDSHAKE] });
  await h.adapter.start();
  for (let n = 1; n <= 4; n++) {
    await until(() => h.adapter.status === 'backoff', 'restarting');
    h.scheduler.advance(h.scheduler.pendingDelays()[0]!);
    await until(() => h.spawns.length === n + 1, 'spawn');
  }
  await until(() => h.adapter.status === 'breaker_open', 'breaker_open');
  h.adapter.retry();
  await until(() => h.adapter.status === 'running', 'ready after retry');
  assert.equal(h.spawns.length, 6);
  assert.equal(h.adapter.health.recentFailures, 0);
});

test('hang detection while ready: missed heartbeats kill the child and count as a hang exit', async () => {
  const h = setup({
    scripts: [
      concat(
        HANDSHAKE,
        '>> {"method":"thread/loaded/list","params":{"limit":1}}',
        '<< {"id":"$","result":{"data":[],"nextCursor":null}}',
        '>> {"method":"thread/loaded/list"}',
        '>> {"method":"thread/loaded/list"}',
        '## hang',
      ),
      HANDSHAKE,
    ],
    overrides: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000, heartbeatMisses: 2, stableMs: 1e12 },
  });
  await h.adapter.start();
  await until(() => h.statuses.at(-1)?.status === 'signed_out', 'ready and read answered');
  const flush = () => new Promise((r) => setImmediate(r));
  h.scheduler.advance(30_000); // beat 1 → answered
  await until(() => h.scheduler.pendingDelays().includes(30_000), 'next beat scheduled');
  h.scheduler.advance(30_000); // beat 2 → silent
  await flush();
  h.scheduler.advance(10_000); // miss 1
  await until(() => h.scheduler.pendingDelays().includes(30_000), 'beat 3 scheduled after a miss');
  assert.equal(h.adapter.status, 'running');
  h.scheduler.advance(30_000); // beat 3 → silent
  await flush();
  h.scheduler.advance(10_000); // miss 2 → hang
  await until(() => h.adapter.status === 'backoff', 'restarting after hang');
  assert.equal(h.adapter.health.lastExit, 'hang');
  assert.equal(h.adapter.health.recentFailures, 1);
  assert.ok(h.logger.entries.some((e) => e.event === 'codex.runtime.hang_detected'));
});

test('the sha256 is re-verified on restart: a swapped binary stops supervision', async () => {
  const h = setup({ scripts: [CRASH, HANDSHAKE] });
  await h.adapter.start();
  await until(() => h.adapter.status === 'backoff', 'restarting');
  writeFileSync(h.bin.path, 'tampered');
  h.scheduler.advance(1_000);
  await until(() => h.adapter.status === 'breaker_open' && h.adapter.health.halt === 'integrity', 'halted on integrity');
  assert.equal(h.spawns.length, 1);
  h.scheduler.advance(3_600_000);
  assert.equal(h.spawns.length, 1);
});

for (const message of ['Not initialized', 'Already initialized']) {
  test(`a failed handshake (initialize → -32600 '${message}', no data, as on the 0.163.0 wire) kills the child and restarts with backoff`, async () => {
    const bad = concat('>> {"method":"initialize"}', `<< {"id":"$","error":{"code":-32600,"message":"${message}"}}`, '## hang');
    const h = setup({ scripts: [bad, HANDSHAKE], fake: { validateEmitted: false } });
    await h.adapter.start();
    await until(() => h.adapter.status === 'backoff', 'restarting');
    assert.ok(h.fakes[0]!.hasExited, 'killed');
    assert.equal(h.fakes[0]!.received.filter((m) => m['method'] === 'initialized').length, 0, 'initialized is never sent after a failed initialize');
    h.scheduler.advance(1_000);
    await until(() => h.adapter.status === 'running', 'ready');
    assert.equal(h.spawns.length, 2);
  });
}

test('a hung initialize times out, the child is killed and restarted', async () => {
  const h = setup({ scripts: [concat('>> {"method":"initialize"}', '## hang'), HANDSHAKE], overrides: { initializeTimeoutMs: 5_000 } });
  const starting = h.adapter.start(); // resolves only once the first attempt is over
  await until(() => h.fakes[0]?.received.length === 1, 'initialize sent');
  h.scheduler.advance(5_000);
  await starting;
  await until(() => h.adapter.status === 'backoff', 'restarting');
  h.scheduler.advance(1_000);
  await until(() => h.adapter.status === 'running', 'ready');
});

test('a crash during account/read never leaves the state signed_in', async () => {
  const h = setup({
    scripts: [
      concat(
        '>> {"method":"initialize"}',
        '<< {"id":"$","result":{"userAgent":"x","codexHome":"/r","platformFamily":"unix","platformOs":"linux"}}',
        '>> {"method":"initialized"}',
        '>> {"method":"account/read"}',
        '## exit 9',
      ),
    ],
  });
  await h.adapter.start();
  await until(() => h.adapter.status === 'backoff', 'restarting');
  assert.ok(h.statuses.every((s) => s.status !== 'signed_in'));
  assert.equal((await h.adapter.auth.getStatus()).status, 'unknown');
});

test('stop(): stdin is closed, the child exits, no restart is scheduled', async () => {
  const h = setup({ scripts: [HANDSHAKE] });
  await h.adapter.start();
  await h.fakes[0]!.done();
  await h.adapter.stop();
  assert.equal(h.adapter.status, 'stopped');
  assert.ok(h.fakes[0]!.stdinClosed);
  h.scheduler.advance(3_600_000);
  assert.equal(h.spawns.length, 1);
});

test('forced login method: every spawn passes -c forced_login_method="chatgpt" after caller flags; stdio only', async () => {
  const h = setup({ scripts: [HANDSHAKE], overrides: { extraArgs: ['-c', 'cli_auth_credentials_store="file"'] } });
  await h.adapter.start();
  assert.deepEqual(h.spawns[0]!.args, ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'app-server', '--listen', 'stdio://']);
});

test('forced login method: a caller flag that tries to override it is refused before any spawn', async () => {
  const h = setup({ scripts: [HANDSHAKE], overrides: { extraArgs: ['-c', 'forced_login_method="api"'] } });
  await assert.rejects(h.adapter.start(), EnvError);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.adapter.status, 'breaker_open');
  assert.equal(h.adapter.health.halt, 'env_config');
});
