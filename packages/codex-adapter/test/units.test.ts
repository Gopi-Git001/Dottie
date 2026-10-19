/** Pure pieces: framing, connection routing, restart policy, URL rule, account mapping, env allowlist, forced flags. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapAccountRead, MalformedAccountRead } from '../src/auth-mapping.js';
import { checkAuthUrl, isAllowedAuthUrl } from '../src/auth-url.js';
import { AppServerConnection, RpcError, RpcTimeoutError, ConnectionClosedError } from '../src/connection.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildArgs,
  buildChildEnv,
  EnvError,
  EXCLUDED_ENV_NAMES,
  POSIX_ENV_ALLOWLIST,
  PROXY_ENV_ALLOWLIST,
  TLS_ENV_ALLOWLIST,
  WINDOWS_ENV_ALLOWLIST,
} from '../src/env.js';
import { LineSplitter, parseWireLine } from '../src/jsonrpc.js';
import { DEFAULT_RESTART_POLICY, FRESH_MEMORY, coolOffFor, decideRestart, markHealthy, type ExitClass, type PowerSource, type SupervisorMemory } from '../src/restart-policy.js';
import { createSecurityAudit, minimalRedactor, type Redactor } from '../src/logger.js';
import type { ExitInfo, Transport } from '../src/transport.js';
import { memoryLogger } from './support/harness.js';
import { ManualScheduler } from './support/manual-scheduler.js';

test('LineSplitter: chunk boundaries, CRLF, blank lines', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":1}\r\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(':2}\n\n{"c":3}\n'), ['{"b":2}', '{"c":3}']);
});

test('LineSplitter drops an oversized line and recovers at the next newline', () => {
  let dropped = 0;
  const s = new LineSplitter(10, () => dropped++);
  assert.deepEqual(s.push('x'.repeat(20)), []);
  assert.deepEqual(s.push('yyy\n{"ok":1}\n'), ['{"ok":1}']);
  assert.equal(dropped, 1);
});

test('parseWireLine classifies messages and tolerates unknown top-level fields (emittedAtMs)', () => {
  assert.equal(parseWireLine('{"id":1,"result":{},"emittedAtMs":5}').kind, 'response');
  assert.equal(parseWireLine('{"method":"warning","params":{}}').kind, 'notification');
  assert.equal(parseWireLine('{"id":"s1","method":"x","params":{}}').kind, 'request');
  assert.deepEqual(parseWireLine('{"error":{"code":-32600,"message":"Not initialized"},"id":99}'), {
    kind: 'error',
    id: 99,
    code: -32600,
    message: 'Not initialized',
  });
  for (const bad of ['nope', '[]', '{"id":{},"method":"x"}', '{"foo":1}']) assert.equal(parseWireLine(bad).kind, 'invalid');
});

function pipe() {
  const written: string[] = [];
  let lineCb: (l: string) => void = () => undefined;
  let exitCb: (i: ExitInfo) => void = () => undefined;
  const t: Transport = {
    write: (d) => void written.push(d),
    onLine: (cb) => void (lineCb = cb),
    onStderrLine: () => undefined,
    onExit: (cb) => void (exitCb = cb),
    close: () => undefined,
    kill: () => undefined,
  };
  return { t, written, send: (o: unknown) => lineCb(JSON.stringify(o)), exit: (i: ExitInfo) => exitCb(i) };
}

test('connection: correlates out-of-order responses, maps errors, times out, rejects pending on exit', async () => {
  const p = pipe();
  const scheduler = new ManualScheduler();
  const logger = memoryLogger();
  const c = new AppServerConnection(p.t, { logger, scheduler, requestTimeoutMs: 1_000 });
  const a = c.request('a', {});
  const b = c.request('b', {});
  const ids = p.written.map((w) => (JSON.parse(w) as { id: number }).id);
  p.send({ id: ids[1], result: 'B' });
  p.send({ id: ids[0], error: { code: -32600, message: 'Not initialized' } });
  assert.equal(await b, 'B');
  await assert.rejects(a, (e: unknown) => e instanceof RpcError && e.code === -32600);
  p.send({ id: 12345, result: 'stray' });
  assert.ok(logger.entries.some((e) => e.event === 'codex.rpc.unmatched_response'));
  const slow = c.request('slow');
  scheduler.advance(1_000);
  await assert.rejects(slow, RpcTimeoutError);
  const pending = c.request('pending');
  p.exit({ code: 1, signal: null });
  await assert.rejects(pending, ConnectionClosedError);
  await assert.rejects(c.request('after'), ConnectionClosedError);
});

test('connection: a throwing server-request handler still yields exactly one (error) reply', async () => {
  const p = pipe();
  const c = new AppServerConnection(p.t, { logger: memoryLogger(), scheduler: new ManualScheduler() });
  c.setServerRequestHandler(() => {
    throw new Error('boom');
  });
  p.send({ id: 's1', method: 'item/fileChange/requestApproval', params: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.written.map((w) => JSON.parse(w)), [{ id: 's1', error: { code: -32603, message: 'Internal error' } }]);
});

test('restart policy (ADR-0013): exit classes, full jitter, AC/battery cap, breaker threshold, cool-off doubling', () => {
  const P = DEFAULT_RESTART_POLICY;
  const now = 10_000_000;
  const input = (exit: ExitClass, power: PowerSource = 'ac', r = 0.999999) => ({ exit, now, power, random: () => r });
  assert.deepEqual(decideRestart(P, FRESH_MEMORY, input('clean')).decision, { action: 'none' });
  const env = decideRestart(P, FRESH_MEMORY, input('env_unavailable'));
  assert.deepEqual(env.decision, { action: 'wait_for_env' });
  assert.deepEqual(env.memory.failures, [], 'env_unavailable never counts');
  // n-th failure: ceiling = min(cap, 500·2^(n-1)); random()≈1 → just under the ceiling, random()=0 → 0
  let m = FRESH_MEMORY;
  const ceilings: number[] = [];
  for (let n = 1; n <= 4; n++) {
    const r = decideRestart(P, m, { ...input(n % 2 ? 'crash' : 'hang'), now: now + n });
    assert.equal(r.decision.action, 'restart');
    if (r.decision.action === 'restart') ceilings.push(r.decision.delayMs + 1);
    m = r.memory;
  }
  assert.deepEqual(ceilings, [500, 1_000, 2_000, 4_000]);
  assert.deepEqual(decideRestart(P, FRESH_MEMORY, input('crash', 'ac', 0)).decision, { action: 'restart', delayMs: 0, attempt: 1 });
  const big = { ...P, baseMs: 1e9 };
  assert.equal((decideRestart(big, FRESH_MEMORY, input('crash', 'ac')).decision as { delayMs: number }).delayMs, 29_999);
  assert.equal((decideRestart(big, FRESH_MEMORY, input('crash', 'battery')).decision as { delayMs: number }).delayMs, 119_999);
  // 5th crash/hang within 10 min opens; failures older than the window do not count
  const fifth = decideRestart(P, m, { ...input('crash'), now: now + 5 });
  assert.deepEqual(fifth.decision, { action: 'breaker_open', coolOffMs: 15 * 60_000, trips: 1 });
  const stale = decideRestart(P, { ...m, failures: m.failures.map((t) => t - 600_000) }, { ...input('crash'), now: now + 5 });
  assert.equal(stale.decision.action, 'restart');
  // a failure while HALF-OPEN re-opens with a doubled cool-off, capped at 2 h
  const opens: number[] = [];
  let mm: SupervisorMemory = fifth.memory;
  for (let i = 0; i < 5; i++) {
    const r = decideRestart(P, { ...mm, halfOpen: true }, { ...input('hang'), now: now + 100 + i });
    if (r.decision.action === 'breaker_open') opens.push(r.decision.coolOffMs);
    mm = r.memory;
  }
  assert.deepEqual(opens, [30, 60, 120, 120, 120].map((x) => x * 60_000));
  assert.equal(markHealthy(mm).trips, 0);
  assert.equal(coolOffFor(P, 1), 15 * 60_000);
});

test('ADR-0015 URL rule', () => {
  const ok = ['https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=x'];
  const bad = [
    'http://auth.openai.com/oauth',
    'https://auth.openai.com.evil.example/',
    'https://auth.openai.com@evil.example/',
    'https://user:pw@auth.openai.com/',
    'https://auth.openai.com:8443/',
    'https://evil.example/?u=https://auth.openai.com/',
    'https://AUTH.openai.com/',
    'https://auth.openai.com',
    ' https://auth.openai.com/',
    'https://auth.openai.com/\nx',
    'https://auth.openai.com/\\evil',
    'javascript:alert(1)//https://auth.openai.com/',
    42,
    null,
  ];
  for (const u of ok) assert.equal(isAllowedAuthUrl(u), true, String(u));
  assert.equal(isAllowedAuthUrl('https://auth.openai.com/codex/device', 'device_code'), true);
  for (const u of bad) assert.equal(isAllowedAuthUrl(u), false, String(u));
});

test('auth.url_check reason codes (CONTRACTS §3.2): only a code, never the URL', () => {
  const cases: [unknown, string][] = [
    [42, 'parse_error'],
    ['not a url', 'parse_error'],
    ['http://auth.openai.com/', 'scheme'],
    ['javascript:alert(1)//https://auth.openai.com/', 'scheme'],
    ['https://user:pw@auth.openai.com/', 'userinfo'],
    ['https://auth.openai.com.evil.example/', 'host'],
    ['https://evil.example/https://auth.openai.com/', 'host'],
    ['https://auth.openai.com:8443/', 'port'],
    ['https://AUTH.openai.com/', 'prefix'],
    ['https://auth.openai.com/\\evil', 'prefix'],
  ];
  for (const [u, reason] of cases) assert.deepEqual(checkAuthUrl(u), { ok: false, reason }, String(u));
  const good = 'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=x';
  assert.deepEqual(checkAuthUrl(good), { ok: true, url: good });
});

test('redirect_uri (browser): only http://127.0.0.1|localhost:<port>/auth/callback; anything else is reason redirect_uri', () => {
  const base = 'https://auth.openai.com/oauth/authorize?response_type=code&state=x';
  const withRedirect = (r: string) => `${base}&redirect_uri=${encodeURIComponent(r)}`;
  for (const r of ['http://127.0.0.1:1455/auth/callback', 'http://localhost:1455/auth/callback', 'http://127.0.0.1:1457/auth/callback']) {
    assert.equal(checkAuthUrl(withRedirect(r)).ok, true, r);
  }
  const bad = [
    'https://127.0.0.1:1455/auth/callback',
    'http://127.0.0.1/auth/callback',
    'http://127.0.0.1:0/auth/callback',
    'http://127.0.0.1:65536/auth/callback',
    'http://127.0.0.2:1455/auth/callback',
    'http://[::1]:1455/auth/callback',
    'http://localhost.evil.example:1455/auth/callback',
    'http://evil.example:1455/auth/callback',
    'http://user@127.0.0.1:1455/auth/callback',
    'http://127.0.0.1:1455/auth/callback/',
    'http://127.0.0.1:1455/other',
    'http://127.0.0.1:1455/auth/callback?next=https://evil.example',
    'http://127.0.0.1:1455/auth/callback#x',
    'http://LOCALHOST:1455/auth/callback',
    'http://127.0.0.1:1455/auth/callback ',
    'javascript:alert(1)',
    '',
  ];
  for (const r of bad) assert.deepEqual(checkAuthUrl(withRedirect(r)), { ok: false, reason: 'redirect_uri' }, r);
  assert.deepEqual(checkAuthUrl(base), { ok: false, reason: 'redirect_uri' }, 'missing redirect_uri (browser)');
  const twice = `${withRedirect('http://127.0.0.1:1455/auth/callback')}&redirect_uri=${encodeURIComponent('http://127.0.0.1:1455/auth/callback')}`;
  assert.deepEqual(checkAuthUrl(twice), { ok: false, reason: 'redirect_uri' }, 'duplicated redirect_uri');
  // Device code: none on the wire; if one appears it must pass the same rule.
  assert.equal(checkAuthUrl('https://auth.openai.com/codex/device', 'device_code').ok, true);
  assert.deepEqual(checkAuthUrl('https://auth.openai.com/codex/device?redirect_uri=https%3A%2F%2Fevil.example%2F', 'device_code'), { ok: false, reason: 'redirect_uri' });
});

test('account/read mapping: only a ChatGPT account is signed_in; e-mail never becomes the label', () => {
  assert.deepEqual(mapAccountRead({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }), {
    status: 'signed_out',
    accountLabel: null,
    accountType: 'none',
  });
  const s = mapAccountRead({ account: { type: 'chatgpt', email: 'p@example.com', planType: 'enterprise_cbp_usage_based' }, requiresOpenaiAuth: true });
  assert.deepEqual(s, { status: 'signed_in', accountLabel: 'ChatGPT Enterprise', accountType: 'chatgpt' });
  assert.equal(mapAccountRead({ account: { type: 'chatgpt', email: null, planType: 'unknown' } }).accountLabel, 'ChatGPT');
  assert.equal(mapAccountRead({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }).status, 'unsupported');
  assert.equal(mapAccountRead({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: true } }).status, 'unsupported');
  assert.equal(mapAccountRead({ account: { type: 'somethingNew' } }).status, 'unsupported');
  assert.equal(mapAccountRead({ account: null, requiresOpenaiAuth: false }).status, 'unsupported');
  for (const bad of [null, 'x', {}, { account: 'chatgpt' }, { account: [] }]) assert.throws(() => mapAccountRead(bad), MalformedAccountRead);
});

const HOSTILE_ENV = {
  OPENAI_API_KEY: 'x1',
  OpenAI_Api_Key: 'x2',
  OPENAI_BASE_URL: 'x3',
  OPENAI: 'x4',
  AZURE_OPENAI_ENDPOINT: 'x5',
  Azure_OpenAI_Api_Key: 'x6',
  AZURE_CLIENT_ID: 'x7',
  CODEX_ACCESS_TOKEN: 'x8',
  CODEX_API_KEY: 'x9',
  codex_home: 'x10',
  CODEX_SANDBOX_NETWORK_DISABLED: 'x11',
  MY_CODEX_THING: 'x12',
  FOO: 'x13',
  NODE_OPTIONS: 'x14',
  LD_PRELOAD: 'x15',
  COMPUTERNAME: 'x16',
  USERDOMAIN: 'x17',
  USERNAME: 'x18',
  PUBLIC: 'x19',
  DISPLAY: 'x20',
  XDG_RUNTIME_DIR: 'x21',
  XDG_CONFIG_HOME: 'x22',
  SHELL: 'x23',
  TERM: 'x24',
  NUMBER_OF_PROCESSORS: 'x25',
  PROCESSOR_ARCHITECTURE: 'x26',
  CommonProgramFiles: 'x27',
  'CommonProgramFiles(x86)': 'x28',
  CommonProgramW6432: 'x29',
  ProgramW6432: 'x30',
  OS: 'x31',
  KEEP: undefined,
} as const;

test('env allowlist (POSIX): only OS essentials, LC_*, proxies (any case) and Dottie CODEX_HOME reach the child', () => {
  const env = buildChildEnv(
    {
      ...HOSTILE_ENV,
      PATH: 'p', HOME: '/h', TMPDIR: '/t', LANG: 'en_US.UTF-8', LANGUAGE: 'en', TZ: 'UTC', USER: 'u', LOGNAME: 'u', LC_ALL: 'C', LC_CTYPE: 'C',
      HTTP_PROXY: 'h', https_proxy: 'hs', No_Proxy: 'n', ALL_PROXY: 'a', all_proxy: 'a2', SSL_CERT_FILE: '/ca.pem', SSL_CERT_DIR: '/ca',
      ssl_cert_file: 'wrong-case', Path: 'wrong-case', SystemRoot: 'C:\\Windows', PSModulePath: 'windows-only',
    },
    { codexHome: '/d/codex', userHome: '/u', platform: 'linux' },
  );
  assert.deepEqual(env, {
    PATH: 'p', HOME: '/h', TMPDIR: '/t', LANG: 'en_US.UTF-8', LANGUAGE: 'en', TZ: 'UTC', USER: 'u', LOGNAME: 'u', LC_ALL: 'C', LC_CTYPE: 'C',
    HTTP_PROXY: 'h', https_proxy: 'hs', No_Proxy: 'n', ALL_PROXY: 'a', all_proxy: 'a2', SSL_CERT_FILE: '/ca.pem', SSL_CERT_DIR: '/ca',
    CODEX_HOME: '/d/codex',
  });
  for (const v of Object.values(HOSTILE_ENV)) if (v !== undefined) assert.ok(!Object.values(env).includes(v), `${v} leaked`);
});

test('env allowlist (Windows): OS essentials match case-insensitively; nothing unlisted passes', () => {
  const env = buildChildEnv(
    {
      ...HOSTILE_ENV,
      Path: 'p', SYSTEMROOT: 'C:\\Windows', SystemDrive: 'C:', windir: 'C:\\Windows', ComSpec: 'cmd', PATHEXT: '.EXE', TEMP: 't', TMP: 't2',
      USERPROFILE: 'C:\\Users\\u', APPDATA: 'a', LOCALAPPDATA: 'l', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', ProgramData: 'pd',
      ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', PSModulePath: 'psm', ssl_cert_file: 'ca', All_Proxy: 'ap', HTTPS_PROXY: 'hs',
      HOME: 'not-windows', LC_ALL: 'not-windows', TZ: 'not-windows',
    },
    { codexHome: 'C:\\d\\codex', userHome: 'C:\\Users\\u', platform: 'win32' },
  );
  const { CODEX_HOME, ...rest } = env;
  assert.ok(CODEX_HOME !== undefined && CODEX_HOME.endsWith('codex'));
  assert.deepEqual(rest, {
    Path: 'p', SYSTEMROOT: 'C:\\Windows', SystemDrive: 'C:', windir: 'C:\\Windows', ComSpec: 'cmd', PATHEXT: '.EXE', TEMP: 't', TMP: 't2',
    USERPROFILE: 'C:\\Users\\u', APPDATA: 'a', LOCALAPPDATA: 'l', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', ProgramData: 'pd',
    ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', PSModulePath: 'psm', ssl_cert_file: 'ca', All_Proxy: 'ap', HTTPS_PROXY: 'hs',
  });
});

test('env exclusions (E01 2026-10-19): identity, desktop-session and removed CPU/OS variables never reach the child on either platform', () => {
  const names = [...EXCLUDED_ENV_NAMES, 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramW6432', 'OS'];
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const n of names) {
      for (const name of [n, n.toLowerCase()]) {
        const env = buildChildEnv({ PATH: 'p', [name]: 'leak' }, { codexHome: '/d/codex', userHome: '/u', platform });
        assert.ok(!Object.values(env).includes('leak'), `${platform}: ${name} reached the child`);
      }
    }
  }
  for (const n of EXCLUDED_ENV_NAMES) {
    assert.ok(![...WINDOWS_ENV_ALLOWLIST, ...POSIX_ENV_ALLOWLIST].some((a) => a.toUpperCase() === n.toUpperCase()), `${n} is on an allowlist`);
  }
});

test('ENV_ALLOWLIST.md (DOT-089 artifact) lists exactly the variables in env.ts', () => {
  const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ENV_ALLOWLIST.md'), 'utf8');
  const documented = new Set([...md.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
  const code = new Set<string>([...WINDOWS_ENV_ALLOWLIST, ...POSIX_ENV_ALLOWLIST, ...TLS_ENV_ALLOWLIST, ...PROXY_ENV_ALLOWLIST, 'LC_*', 'CODEX_HOME']);
  assert.deepEqual([...documented].filter((n) => !code.has(n as string)).sort(), [], 'documented but not allowed');
  assert.deepEqual([...code].filter((n) => !documented.has(n)).sort(), [], 'allowed but not documented');
});

test('env: the parent env is never copied wholesale; ~/.codex refused', () => {
  const parent = { PATH: 'p', FOO: 'bar' };
  const env = buildChildEnv(parent, { codexHome: '/d/codex', userHome: '/u', platform: 'linux' });
  assert.notEqual(env, parent);
  assert.deepEqual(parent, { PATH: 'p', FOO: 'bar' }, 'parent untouched');
  assert.throws(() => buildChildEnv({}, { codexHome: '/u/.codex', userHome: '/u', platform: 'linux' }), EnvError);
  assert.throws(() => buildChildEnv({}, { codexHome: '/u/x/../.codex', userHome: '/u', platform: 'linux' }), EnvError);
});

test('args: forced_login_method="chatgpt" always comes after caller flags and cannot be overridden', () => {
  assert.deepEqual(buildArgs([]), ['-c', 'forced_login_method="chatgpt"', 'app-server', '--listen', 'stdio://']);
  assert.deepEqual(buildArgs(['-c', 'a=1']), ['-c', 'a=1', '-c', 'forced_login_method="chatgpt"', 'app-server', '--listen', 'stdio://']);
  assert.throws(() => buildArgs(['-c', 'forced_login_method="api"']), EnvError);
  assert.throws(() => buildArgs(['-c', 'forced_chatgpt_workspace_id="w"']), EnvError);
});

test('security audit: every field goes through the injected Redactor; the fallback drops URLs, e-mails, JWTs and long tokens', () => {
  const calls: unknown[] = [];
  const double: Redactor = { redact: (f) => (calls.push(f), { ...f, redactedBy: 'double' }) };
  const logger = memoryLogger();
  createSecurityAudit(logger, double).emit('x.y', { a: 1 });
  assert.deepEqual(calls, [{ a: 1 }]);
  assert.deepEqual(logger.entries, [{ level: 'warn', event: 'security.x.y', fields: { a: 1, redactedBy: 'double' } }]);
  const r = minimalRedactor.redact({
    url: 'https://auth.openai.com/oauth?state=abc',
    mail: 'me@example.com',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
    tok: 'a'.repeat(48),
    ok: 'authUrl',
    n: 3,
  });
  assert.deepEqual(r, { url: '[redacted]', mail: '[redacted]', jwt: '[redacted]', tok: '[redacted]', ok: 'authUrl', n: 3 });
});

test('classifyRpcError: a JSON-RPC error response is fatal / rpc_error and never marks auth expired (CONTRACTS §1.5)', async () => {
  const { classifyRpcError } = await import('../src/errors.js');
  assert.deepEqual(classifyRpcError(), { kind: 'fatal', variant: 'rpc_error', httpStatusCode: null, authExpired: false });
});
