/**
 * E01 ruling 2i: the Codex App Server wire is tolerant at the adapter: unknown wire fields (ordinary names and the
 * prototype names `__proto__` / `constructor`, injected at the JSON level so they arrive as OWN keys) are dropped and
 * NEVER forwarded into Dottie events, approval displays or port objects (hooks, CodexRunResult, CodexApprovalRequest,
 * the turn store, audit/log records). Approval REQUESTS are the one fail-closed exception (WIRE_PARAMS.md, RB02):
 * an unknown top-level key is tolerated as "decline, exactly one reply, no dialog", never approved unseen.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexApprovalRequest, CodexRunHooks, CodexTaskRequest, ToolStart } from '@dottie/contracts';
import { MemoryTurnStore } from '../src/index.js';
import { parseWireLine } from '../src/jsonrpc.js';
import { setup, until } from './support/harness.js';
import { CWD, HANDSHAKE_SIGNED_IN, lines, READ_SIGNED_IN, THREAD_ID, threadStartResult, TURN_ID } from './support/turn-script.js';

const TEXT = 'Tidy the folder.';
const SENTINEL = 'ZZ-SENTINEL';
const CMD = 'item/commandExecution/requestApproval';
const FILE = 'item/fileChange/requestApproval';
type J = Record<string, unknown>;

/** Unknown members added to a wire object: an ordinary name, `constructor`, and (via the marker) a JSON `__proto__`. */
const x = <T extends J>(o: T): T => ({ ...o, zzExtra: SENTINEL, constructor: { polluted: SENTINEL }, zzProtoMarker: { polluted: SENTINEL } });
/** JSON.stringify can't write an own "__proto__" key from a literal, so rename the marker in the line text. */
const wire = (o: unknown) => JSON.stringify(o).replaceAll('"zzProtoMarker"', '"__proto__"');
const emit = (o: unknown) => `<< ${wire(o)}`;
const expect = (o: unknown) => `>> ${JSON.stringify(o)}`;
const ids = { threadId: THREAD_ID, turnId: TURN_ID };

test('ruling 2i harness: the injected "__proto__" really arrives as an own key on the parsed wire object', () => {
  const m = parseWireLine(wire({ method: 'item/started', params: x({ ...ids }) }));
  assert.equal(m.kind, 'notification');
  const p = (m as { params: J }).params;
  assert.ok(Object.hasOwn(p, '__proto__') && Object.hasOwn(p, 'constructor') && Object.hasOwn(p, 'zzExtra'));
  assert.equal(Object.getPrototypeOf(p), Object.prototype, 'JSON.parse never sets the prototype');
});

/** Walks a downstream value: no foreign key, no sentinel value, no function, no exotic prototype. */
function assertNoForeign(v: unknown, where: string, seen = new Set<unknown>()): void {
  if (typeof v === 'function') assert.fail(`${where}: a function reached downstream`);
  if (typeof v === 'string') return assert.ok(!v.includes(SENTINEL) && !v.includes('polluted'), `${where}: wire value leaked: ${v}`);
  if (typeof v !== 'object' || v === null || seen.has(v)) return;
  seen.add(v);
  if (v instanceof Error) return;
  const proto = Object.getPrototypeOf(v);
  assert.ok(proto === Object.prototype || proto === Array.prototype || proto === null, `${where}: exotic prototype`);
  for (const k of Reflect.ownKeys(v)) {
    assert.equal(typeof k, 'string', `${where}: symbol key`);
    assert.ok(!['zzExtra', '__proto__', 'constructor', 'zzProtoMarker'].includes(k as string), `${where}.${String(k)}: unknown wire field forwarded`);
    assertNoForeign((v as J)[k as string], `${where}.${String(k)}`, seen);
  }
}

function req(): CodexTaskRequest {
  return { taskId: 't1', idempotencyKey: 'k1', turnId: 't1.t1', clientUserMessageId: 't1.t1', turnKind: 'initial', attempt: 1, text: TEXT, workspaceScope: { scopes: ['files.read'], paths: [CWD] }, resume: false };
}
function recorder(answer: () => Promise<{ approved: boolean; reason: 'approved' | 'denied' }> = async () => ({ approved: false, reason: 'denied' })) {
  const rec = { threads: [] as unknown[], progress: [] as unknown[], tools: [] as ToolStart[], asked: [] as CodexApprovalRequest[], retrying: [] as unknown[][], results: [] as unknown[] };
  const hooks: CodexRunHooks = {
    threadAssigned: (t) => void rec.threads.push(t),
    progress: (m) => void rec.progress.push(m),
    codexRetrying: (...a: unknown[]) => void rec.retrying.push(a),
    toolStarted: (s) => void rec.tools.push(s),
    toolResult: (r: unknown) => void rec.results.push(r),
    requestApproval: (r) => {
      rec.asked.push(r);
      return answer();
    },
  };
  return { rec, hooks };
}
async function ready(script: string) {
  const store = new MemoryTurnStore();
  // Injected fields are outside the pinned schema on purpose; the fake still checks every ADAPTER message.
  const h = setup({ scripts: [script], fake: { validateEmitted: false }, overrides: { turnStore: store, approvals: { isDesktopLocked: () => false, pathPlatform: 'posix' } } });
  await h.adapter.start();
  await until(() => h.statuses.length > 0, 'auth');
  return { ...h, store };
}
function clean(h: { problems(): string[]; fakes: { finished: boolean; remaining(): string }[] }) {
  assert.deepEqual(h.problems(), []);
  for (const f of h.fakes) assert.ok(f.finished, f.remaining());
}
async function downstream(h: Awaited<ReturnType<typeof ready>>, rec: unknown, result: unknown) {
  assertNoForeign(result, 'CodexRunResult');
  assertNoForeign(rec, 'hooks');
  assertNoForeign(await h.store.get('t1'), 'turn store');
  assertNoForeign(h.statuses, 'auth statuses');
  assertNoForeign(h.logger.entries, 'log/audit');
}

// --------------------------------------------------------------------------------------------- responses
const handshakeX = lines(
  expect({ method: 'initialize', params: { clientInfo: { name: 'dottie' }, capabilities: { experimentalApi: false, requestAttestation: false } } }),
  emit({ id: '$', result: x({ userAgent: 'dottie/0.163.0', codexHome: '/redacted/codex-home', platformFamily: 'unix', platformOs: 'linux' }) }),
  expect({ method: 'initialized' }),
);
const readX = lines(expect({ method: 'account/read', params: { refreshToken: false } }), emit({ id: '$', result: x({ account: x({ type: 'chatgpt', email: 'person@example.com', planType: 'pro' }), requiresOpenaiAuth: true }) }));
function threadStartX(): string {
  const r = threadStartResult();
  return lines(expect({ method: 'thread/start', params: { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'read-only' } }), emit({ id: '$', result: x({ ...r, thread: x(r['thread'] as J) }) }));
}
const turnObj = (status: string, error: unknown = null) => x({ id: TURN_ID, items: [], status, error, startedAt: 1792330223, completedAt: null, durationMs: null });
const turnStartX = lines(
  expect({ method: 'turn/start', params: { threadId: THREAD_ID, input: [{ type: 'text', text: TEXT, text_elements: [] }], clientUserMessageId: 't1.t1' } }),
  emit({ id: '$', result: x({ turn: turnObj('inProgress') }) }),
  emit({ method: 'turn/started', params: x({ threadId: THREAD_ID, turn: turnObj('inProgress') }) }),
);
const completedX = (status: string, error: unknown = null) => emit({ method: 'turn/completed', params: x({ threadId: THREAD_ID, turn: turnObj(status, error) }) });

// --------------------------------------------------------------------------------------------- notifications
test('ruling 2i: unknown fields on every response and notification are tolerated and never reach a port object', async () => {
  const agent = (text: string) => x({ type: 'agentMessage', id: 'msg-1', text, phase: null, memoryCitation: null, delivery: null, questions: null });
  const h = await ready(lines(
    handshakeX, readX, readX, threadStartX(), turnStartX,
    emit({ method: 'item/started', params: x({ ...ids, startedAtMs: 1, item: x({ type: 'commandExecution', id: 'cmd-1', command: 'ls', commandActions: [x({ type: 'unknown', command: 'ls' })], cwd: CWD, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null, processId: null }) }) }),
    emit({ method: 'item/started', params: x({ ...ids, startedAtMs: 2, item: agent('') }) }),
    emit({ method: 'item/agentMessage/delta', params: x({ ...ids, itemId: 'msg-1', delta: 'O' }) }),
    emit({ method: 'item/agentMessage/delta', params: x({ ...ids, itemId: 'msg-1', delta: 'K' }) }),
    emit({ method: 'item/completed', params: x({ ...ids, completedAtMs: 3, item: agent('OK') }) }),
    emit({ method: 'turn/plan/updated', params: x({ ...ids, explanation: null, plan: [x({ step: 'a', status: 'completed' }), x({ step: 'b', status: 'pending' })] }) }),
    emit({ method: 'error', params: x({ ...ids, willRetry: true, error: x({ message: 'redacted', codexErrorInfo: null, additionalDetails: null }) }) }),
    emit({ method: 'serverRequest/resolved', params: x({ threadId: THREAD_ID, requestId: 'nobody' }) }),
    completedX('completed'),
  ));
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: 'OK' });
  assert.deepEqual(rec.threads, [THREAD_ID]);
  assert.deepEqual(rec.tools, [{ toolId: 'cmd-1', mayHaveSideEffects: true }]);
  assert.deepEqual(rec.progress, ['Running a command.', 'OK', 'Plan: 1 of 2 steps done.']);
  assert.deepEqual(rec.retrying, [[]]);
  assert.equal(h.statuses.at(-1)?.status, 'signed_in');
  assert.equal(h.statuses.at(-1)?.accountLabel, 'ChatGPT Pro');
  await downstream(h, rec, r);
  clean(h);
});

test('ruling 2i: a failed turn whose error carries unknown fields maps to a fixed kind; nothing from the wire is forwarded', async () => {
  const h = await ready(lines(handshakeX, readX, readX, threadStartX(), turnStartX, completedX('failed', x({ message: `secret ${SENTINEL}`, codexErrorInfo: 'usageLimitExceeded', additionalDetails: SENTINEL }))));
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.equal(r.status, 'failed');
  assert.equal((r as { error: { kind: string } }).error.kind, 'plan_limit');
  await downstream(h, rec, r);
  clean(h);
});

test('ruling 2i: codexErrorInfo whose only key is a prototype name is "unknown" (fatal), never a lookup into a prototype', async () => {
  for (const info of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const h = await ready(lines(handshakeX, readX, readX, threadStartX(), turnStartX, completedX('failed', { message: 'm', codexErrorInfo: info, additionalDetails: null })));
    const { rec, hooks } = recorder();
    const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
    assert.equal((r as { error: { kind: string } }).error.kind, 'fatal', info);
    await downstream(h, rec, r);
    clean(h);
  }
});

test('ruling 2i (leak fix): item/started whose item.type is a prototype member name is an unknown item: no toolStarted, no progress, ledger untouched', async () => {
  for (const type of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'zzUnknownItem']) {
    // A retryable failure after the item proves the ledger stayed empty (a touched ledger turns it fatal).
    const h = await ready(lines(
      handshakeX, readX, readX, threadStartX(), turnStartX,
      emit({ method: 'item/started', params: x({ ...ids, startedAtMs: 1, item: x({ type, id: 'odd-1' }) }) }),
      completedX('failed', { message: 'm', codexErrorInfo: 'serverOverloaded', additionalDetails: null }),
    ));
    const { rec, hooks } = recorder();
    const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
    assert.deepEqual(rec.tools, [], `${type}: no toolStarted`);
    assert.deepEqual(rec.progress, [], `${type}: no progress`);
    assert.equal((r as { error: { kind: string } }).error.kind, 'transient', `${type}: ledger untouched, still retryable`);
    await downstream(h, rec, r);
    clean(h);
  }
});

// --------------------------------------------------------------------------------------------- approval requests
const cmdParams = (o: J = {}) => ({ ...ids, itemId: 'item-9', startedAtMs: 1792392060000, kind: 'command', command: 'rm -rf build', cwd: CWD, reason: 'cleanup', ...o });

test('ruling 2i: unknown fields NESTED in known approval members are dropped: the dialog request, display and audit carry known fields only', async () => {
  const h = await ready(lines(
    HANDSHAKE_SIGNED_IN, READ_SIGNED_IN,
    expect({ method: 'thread/start', params: { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'read-only' } }), emit({ id: '$', result: threadStartResult() }),
    turnStartX,
    emit({ id: 'srv-1', method: CMD, params: cmdParams({ networkApprovalContext: x({ host: 'pypi.org', protocol: 'https' }), proposedNetworkPolicyAmendments: [x({ host: 'pypi.org', action: 'allow' })], commandActions: [x({ type: 'unknown', command: 'rm -rf build' })] }) }),
    expect({ id: 'srv-1', result: { decision: 'decline' } }),
    emit({ method: 'item/started', params: x({ ...ids, startedAtMs: 1, item: x({ type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [x({ path: `${CWD}/a.txt`, kind: x({ type: 'update', move_path: null }), diff: '@@ -1 +1 @@\n-a\n+b\n' })] }) }) }),
    emit({ id: 'srv-2', method: FILE, params: { ...ids, itemId: 'fc-1', startedAtMs: 1792392060001, reason: null } }),
    expect({ id: 'srv-2', result: { decision: 'decline' } }),
    completedX('completed'),
  ));
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.equal(r.status, 'completed');
  assert.equal(rec.asked.length, 2, 'both requests opened a dialog');
  assert.equal(rec.asked[0]!.display?.kind, 'codex_command');
  assert.equal(rec.asked[1]!.display?.kind, 'codex_file_change');
  for (const a of rec.asked) assert.deepEqual(Object.keys(a).sort(), ['actionId', 'category', 'display', 'risk', 'summary', 'toolId']);
  assert.deepEqual(rec.asked.map((a) => a.toolId), ['item-9', 'fc-1'], 'toolId is the known wire itemId');
  assert.deepEqual(Object.keys(rec.asked[0]!.display!).sort(), ['commandLine', 'escalation', 'kind', 'networkAccess', 'reason', 'workingDirectory']);
  assert.deepEqual(rec.asked[0]!.display, { kind: 'codex_command', commandLine: 'rm -rf build', workingDirectory: CWD, networkAccess: true, escalation: ['Network access to pypi.org (https)', 'Network rule: allow pypi.org'], reason: 'cleanup' });
  assert.deepEqual(rec.asked[1]!.display, { kind: 'codex_file_change', paths: [`${CWD}/a.txt`] });
  await downstream(h, rec, r);
  clean(h);
});

test('ruling 2i: an unknown TOP-LEVEL approval key (ordinary, constructor, __proto__) is tolerated fail-closed: one decline, no dialog, nothing forwarded', async () => {
  const variants: [string, J][] = [['zzExtra', { zzExtra: SENTINEL }], ['constructor', { constructor: SENTINEL }], ['__proto__', { zzProtoMarker: { polluted: SENTINEL } }]];
  for (const [name, extra] of variants) {
    const h = await ready(lines(
      HANDSHAKE_SIGNED_IN, READ_SIGNED_IN,
      expect({ method: 'thread/start', params: { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'read-only' } }), emit({ id: '$', result: threadStartResult() }),
      turnStartX,
      emit({ id: 'srv-1', method: CMD, params: cmdParams(extra) }),
      expect({ id: 'srv-1', result: { decision: 'decline' } }),
      completedX('completed'),
    ));
    const { rec, hooks } = recorder(async () => ({ approved: true, reason: 'approved' }));
    const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
    assert.equal(r.status, 'completed', name);
    assert.equal(rec.asked.length, 0, `${name}: no dialog`);
    assert.equal(h.fakes[0]!.received.filter((m) => m['id'] === 'srv-1').length, 1, `${name}: exactly one reply`);
    assert.ok(h.logger.entries.some((e) => e.event === 'security.approval.resolved' && e.fields['reason'] === 'schema_invalid'), name);
    await downstream(h, rec, r);
    clean(h);
  }
});

// --------------------------------------------------------------------------------------------- own keys only
test('ruling 2i: wire framing and account/read look at OWN keys only (an inherited member from a polluted Object.prototype is not on the wire)', async () => {
  const { mapAccountRead } = await import('../src/auth-mapping.js');
  const proto = Object.prototype as J;
  const pollute = (k: string, v: unknown, f: () => void) => {
    Object.defineProperty(proto, k, { value: v, configurable: true, writable: true, enumerable: false });
    try { f(); } finally { delete proto[k]; }
  };
  pollute('result', { hijacked: true }, () => assert.deepEqual(parseWireLine('{"id":1}'), { kind: 'invalid', reason: 'unrecognized' }));
  pollute('error', { code: 1, message: 'x' }, () => assert.deepEqual(parseWireLine('{"id":1}'), { kind: 'invalid', reason: 'unrecognized' }));
  pollute('id', 7, () => assert.equal(parseWireLine('{"method":"turn/started","params":{}}').kind, 'notification', 'inherited id does not make a request'));
  pollute('data', SENTINEL, () => assert.ok(!Object.hasOwn(parseWireLine('{"id":1,"error":{"code":-32600,"message":"m"}}'), 'data')));
  pollute('account', { type: 'chatgpt', planType: 'pro' }, () => assert.throws(() => mapAccountRead({ requiresOpenaiAuth: true }), /no account field/));
});

test('ruling 2i: nested unknown fields never reach the bound args: the actionId is identical with and without them', async () => {
  const run = async (dress: <T extends J>(o: T) => T) => {
    const h = await ready(lines(
      HANDSHAKE_SIGNED_IN, READ_SIGNED_IN,
      expect({ method: 'thread/start', params: { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'read-only' } }), emit({ id: '$', result: threadStartResult() }),
      turnStartX,
      emit({ id: 'srv-1', method: CMD, params: cmdParams({ networkApprovalContext: dress({ host: 'pypi.org', protocol: 'https' }), proposedNetworkPolicyAmendments: [dress({ host: 'pypi.org', action: 'allow' })] }) }),
      expect({ id: 'srv-1', result: { decision: 'decline' } }),
      emit({ method: 'item/started', params: { ...ids, startedAtMs: 1, item: dress({ type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [dress({ path: `${CWD}/a.txt`, kind: dress({ type: 'update', move_path: null }), diff: '@@ -1 +1 @@\n-a\n+b\n' })] }) } }),
      emit({ id: 'srv-2', method: FILE, params: { ...ids, itemId: 'fc-1', startedAtMs: 1792392060001, reason: null } }),
      expect({ id: 'srv-2', result: { decision: 'decline' } }),
      completedX('completed'),
    ));
    const { rec, hooks } = recorder();
    await h.adapter.codex.run(req(), hooks, new AbortController().signal);
    clean(h);
    return rec.asked.map((a) => [a.actionId, a.summary]);
  };
  const plain = await run((o) => o);
  assert.equal(plain.length, 2);
  assert.deepEqual(await run(x), plain);
});

test('ruling 2i: a completed turn carrying an (off-schema) error object forwards nothing from it', async () => {
  const h = await ready(lines(handshakeX, readX, readX, threadStartX(), turnStartX, completedX('completed', x({ message: `leak ${SENTINEL}`, codexErrorInfo: 'other' }))));
  const { rec, hooks } = recorder();
  const r = await h.adapter.codex.run(req(), hooks, new AbortController().signal);
  assert.deepEqual(r, { status: 'completed', summary: '' });
  await downstream(h, rec, r);
  clean(h);
});
