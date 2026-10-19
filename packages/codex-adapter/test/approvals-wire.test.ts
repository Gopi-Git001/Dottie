/**
 * DOT-090 bridge end to end through createCodexAdapter and the scripted 0.163.0 fake (schema-checked both ways):
 * CONTRACTS §1.4 replies with the bridge installed, task-cancel revocation, serverRequest/resolved, runtime loss.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexApprovalRequest, CodexRunHooks, CodexTaskRequest } from '@dottie/contracts';
import { parseWireLine } from '../src/jsonrpc.js';
import { setup, until } from './support/harness.js';
import { CWD, HANDSHAKE_SIGNED_IN, interrupt, interruptCompleted, lines, READ_SIGNED_IN, THREAD_ID, threadStart, TURN_ID, turnCompleted, turnStart } from './support/turn-script.js';

const TEXT = 'Tidy the folder.';
const CMD = 'item/commandExecution/requestApproval';
const emit = (o: unknown) => `<< ${JSON.stringify(o)}`;
const expect = (o: unknown) => `>> ${JSON.stringify(o)}`;
const cmd = (id: string, o: Record<string, unknown> = {}) =>
  emit({ id, method: CMD, params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'item-9', startedAtMs: 1792392060000, kind: 'command', command: 'rm -rf build', cwd: CWD, reason: 'cleanup', ...o } });

function req(): CodexTaskRequest {
  return { taskId: 't1', idempotencyKey: 'k1', turnId: 't1.t1', clientUserMessageId: 't1.t1', turnKind: 'initial', attempt: 1, text: TEXT, workspaceScope: { scopes: ['files.read'], paths: [CWD] }, resume: false };
}
function hooks(answer?: () => Promise<{ approved: boolean; reason: 'approved' | 'denied' | 'expired' | 'cancelled' }>) {
  const asked: CodexApprovalRequest[] = [];
  const h: CodexRunHooks = {
    threadAssigned: () => undefined, progress: () => undefined, codexRetrying: () => undefined, toolStarted: () => undefined, toolResult: () => undefined,
    requestApproval: (r) => {
      asked.push(r);
      return answer ? answer() : new Promise(() => undefined);
    },
  };
  return { asked, hooks: h };
}
async function ready(script: string, locked = false) {
  const h = setup({ scripts: [script], overrides: { approvals: { isDesktopLocked: () => locked, pathPlatform: 'posix' } } });
  await h.adapter.start();
  await until(() => h.statuses.length > 0, 'auth');
  return h;
}
function clean(h: { problems(): string[]; fakes: { finished: boolean; remaining(): string }[] }) {
  assert.deepEqual(h.problems(), []);
  for (const f of h.fakes) assert.ok(f.finished, f.remaining());
}

test('A9-I5 / CONTRACTS §1.4 with the bridge installed: decline; permissions empty grant; elicitation URL → decline and nothing opened; tool/call and unknown → -32601', async () => {
  const h = await ready(lines(
    HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'),
    cmd('srv-1', { proposedExecpolicyAmendment: ['rm'] }),
    expect({ id: 'srv-1', result: { decision: 'decline' } }),
    emit({ id: 'srv-2', method: 'item/permissions/requestApproval', params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'item-10', startedAtMs: 1, cwd: CWD, reason: 'need network', permissions: { network: { enabled: true } } } }),
    expect({ id: 'srv-2', result: { permissions: {}, scope: 'turn' } }),
    emit({ id: 'srv-3', method: 'mcpServer/elicitation/request', params: { threadId: THREAD_ID, turnId: TURN_ID, serverName: 'docs', mode: 'url', message: 'Sign in here', url: 'https://evil.example/login', elicitationId: 'el-1' } }),
    expect({ id: 'srv-3', result: { action: 'decline', content: null, _meta: null } }),
    emit({ id: 'srv-4', method: 'item/tool/call', params: { threadId: THREAD_ID, turnId: TURN_ID, callId: 'c1', tool: 'x', arguments: {} } }),
    expect({ id: 'srv-4', error: { code: -32601, message: 'Method not found' } }),
    turnCompleted('completed'),
  ));
  const { asked, hooks: hk } = hooks(async () => ({ approved: false, reason: 'denied' }));
  const r = await h.adapter.codex.run(req(), hk, new AbortController().signal);
  assert.equal(r.status, 'completed');
  assert.equal(asked.length, 1, 'only the command approval reaches the dialog');
  assert.equal(asked[0]!.category, 'local_change');
  assert.doesNotMatch(asked[0]!.summary, /cleanup/, "Codex's reason is not shown (item 9)");
  assert.deepEqual(h.opened, [], 'no URL opened');
  clean(h);
});

test('A9-I2 end to end: an approve without a K8 token (default port) is declined on the wire', async () => {
  const h = await ready(lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), cmd('srv-1'), expect({ id: 'srv-1', result: { decision: 'decline' } }), turnCompleted('completed')));
  const { hooks: hk } = hooks(async () => ({ approved: true, reason: 'approved' }));
  assert.equal((await h.adapter.codex.run(req(), hk, new AbortController().signal)).status, 'completed');
  assert.ok(h.logger.entries.some((e) => e.event === 'security.approval.resolved' && e.fields['reason'] === 'no_token'));
  clean(h);
});

test('A9-I3 task cancel revokes the pending approval (cancel on the wire) alongside the interrupt', async () => {
  // The revoke is synchronous; its reply is written a few microtasks after the turn/interrupt request (both safe).
  const [interruptReq, ...interruptRest] = interrupt().split('\n');
  const h = await ready(lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), cmd('srv-1'), '## wait asked', interruptReq!, expect({ id: 'srv-1', result: { decision: 'cancel' } }), ...interruptRest, interruptCompleted()));
  const { asked, hooks: hk } = hooks();
  const run = h.adapter.codex.run(req(), hk, new AbortController().signal);
  await h.fakes[0]!.reached('asked');
  await until(() => asked.length === 1, 'dialog asked');
  h.fakes[0]!.release('asked');
  const dismissed: string[] = [];
  h.adapter.approvals!.onDismiss((d) => void dismissed.push(d.reason));
  assert.deepEqual(await h.adapter.codex.cancel('t1'), { stopped: true, detail: 'interrupted' });
  assert.equal((await run).status, 'aborted');
  assert.deepEqual(dismissed, ['task_cancel']);
  clean(h);
});

test('A9-I3 panic-stop through the control surface; serverRequest/resolved → no reply; unknown turn → decline', async () => {
  const h = await ready(lines(
    HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'),
    cmd('srv-1'), '## wait one', expect({ id: 'srv-1', result: { decision: 'cancel' } }),
    cmd('srv-2'), emit({ method: 'serverRequest/resolved', params: { threadId: THREAD_ID, requestId: 'srv-2' } }),
    cmd('srv-3', { turnId: 'someone-elses-turn' }), expect({ id: 'srv-3', result: { decision: 'decline' } }),
    turnCompleted('completed'),
  ));
  const { asked, hooks: hk } = hooks();
  const run = h.adapter.codex.run(req(), hk, new AbortController().signal);
  await h.fakes[0]!.reached('one');
  await until(() => asked.length === 1, 'asked');
  h.fakes[0]!.release('one');
  h.adapter.approvals!.revokeAll('panic_stop');
  assert.equal((await run).status, 'completed');
  assert.equal(asked.length, 2, 'srv-2 asked, then resolved by the server; srv-3 never asked');
  assert.equal(h.fakes[0]!.received.filter((m) => m['id'] === 'srv-2').length, 0, 'no reply for a request the server resolved');
  assert.ok(h.logger.entries.some((e) => e.event === 'security.approval.resolved' && e.fields['reason'] === 'resolved_by_server' && e.fields['wireReply'] === 'none'), 'bridge saw serverRequest/resolved');
  clean(h);
});

test('A9-I3 app-server crash while pending: revoked, nothing written to the dead connection', async () => {
  const h = await ready(lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), cmd('srv-1'), '## wait asked', '## exit 1'));
  const { asked, hooks: hk } = hooks();
  const run = h.adapter.codex.run(req(), hk, new AbortController().signal);
  await h.fakes[0]!.reached('asked');
  await until(() => asked.length === 1, 'asked');
  h.fakes[0]!.release('asked');
  const r = await run;
  assert.equal(r.status, 'failed');
  await until(() => h.logger.entries.some((e) => e.event === 'security.approval.revoked'), 'revoked');
  const rev = h.logger.entries.find((e) => e.event === 'security.approval.revoked')!;
  assert.deepEqual([rev.fields['reason'], rev.fields['wireReply'], rev.fields['outcome']], ['app_server_restart', 'none', 'reply_failed']);
  assert.equal(h.fakes[0]!.received.filter((m) => m['id'] === 'srv-1').length, 0);
});

test('A9-I4 locked desktop end to end: decline, no dialog', async () => {
  const h = await ready(lines(HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'), cmd('srv-1'), expect({ id: 'srv-1', result: { decision: 'decline' } }), turnCompleted('completed')), true);
  const { asked, hooks: hk } = hooks(async () => ({ approved: true, reason: 'approved' }));
  assert.equal((await h.adapter.codex.run(req(), hk, new AbortController().signal)).status, 'completed');
  assert.equal(asked.length, 0);
  clean(h);
});

test('CR2 duplicate JSON keys anywhere in a server request line are flagged for the bridge', () => {
  const m = parseWireLine('{"id":1,"method":"item/commandExecution/requestApproval","params":{"command":"ls","command":"rm -rf /"}}');
  assert.ok(m.kind === 'request' && m.duplicateKeys);
  const ok = parseWireLine('{"id":1,"method":"x","params":{"a":{"k":1},"b":{"k":2}}}');
  assert.ok(ok.kind === 'request' && !ok.duplicateKeys);
});

test('E01 ruling 1x: a writeStdin approval gets exactly one decline per requestId; no dialog, no coordinator approval request', async () => {
  const h = await ready(lines(
    HANDSHAKE_SIGNED_IN, READ_SIGNED_IN, threadStart(), turnStart(TEXT, 't1'),
    cmd('srv-w1', { kind: 'writeStdin', approvalId: 'stdin-1' }),
    expect({ id: 'srv-w1', result: { decision: 'decline' } }),
    cmd('srv-w2', { kind: 'writeStdin', approvalId: 'stdin-2', command: null, cwd: null }),
    expect({ id: 'srv-w2', result: { decision: 'decline' } }),
    turnCompleted('completed'),
  ));
  const { asked, hooks: hk } = hooks(async () => ({ approved: true, reason: 'approved' }));
  const dismissed: string[] = [];
  h.adapter.approvals!.onDismiss((d) => void dismissed.push(d.reason));
  assert.equal((await h.adapter.codex.run(req(), hk, new AbortController().signal)).status, 'completed');
  assert.equal(asked.length, 0, 'no coordinator approval request, so no dialog');
  assert.deepEqual(dismissed, [], 'nothing was shown, so nothing to dismiss');
  for (const id of ['srv-w1', 'srv-w2']) assert.equal(h.fakes[0]!.received.filter((m) => m['id'] === id).length, 1, `${id}: exactly one response`);
  const resolved = h.logger.entries.filter((e) => e.event === 'security.approval.resolved');
  assert.deepEqual(resolved.map((e) => [e.fields['decision'], e.fields['reason'], e.fields['wireReply']]), [['declined', 'display_unavailable', 'decline'], ['declined', 'display_unavailable', 'decline']]);
  assert.equal(h.logger.entries.filter((e) => e.event === 'security.approval.requested' && e.fields['outcome'] === 'displayed').length, 0);
  clean(h);
});
