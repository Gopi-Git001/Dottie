/** Server→Dottie requests are answered exactly once and default to deny (CONTRACTS §1.4). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SERVER_REQUEST_REPLIES } from '../src/server-requests.js';
import { concat, loadTranscript } from './support/fake-app-server.js';
import { setup, until } from './support/harness.js';
import { pinnedServerRequestMethods, schemaError, SERVER_REQUEST_RESPONSE_SCHEMAS } from './support/schema.js';

const HANDSHAKE = loadTranscript('handshake-signed-out.jsonl');

/** Expected default answers, transcribed from CONTRACTS §1.4 (with the schema-valid legacy denial, see report). */
const EXPECTED: Record<string, { result: unknown } | { errorCode: number }> = {
  'item/commandExecution/requestApproval': { result: { decision: 'decline' } },
  'item/fileChange/requestApproval': { result: { decision: 'decline' } },
  'item/permissions/requestApproval': { result: { permissions: {}, scope: 'turn' } },
  'mcpServer/elicitation/request': { result: { action: 'decline', content: null, _meta: null } },
  'item/tool/requestUserInput': { errorCode: -32601 },
  'item/tool/call': { errorCode: -32601 },
  applyPatchApproval: { result: { decision: { denied: { rejection: 'Dottie does not use the legacy approval APIs' } } } },
  execCommandApproval: { result: { decision: { denied: { rejection: 'Dottie does not use the legacy approval APIs' } } } },
  'account/chatgptAuthTokens/refresh': { errorCode: -32601 },
  'attestation/generate': { errorCode: -32601 },
};

test('every server request in the pinned ServerRequest.json has an explicit default answer, and nothing else does', () => {
  const pinned = pinnedServerRequestMethods().sort();
  assert.equal(pinned.length, 10);
  assert.deepEqual(Object.keys(DEFAULT_SERVER_REQUEST_REPLIES).sort(), pinned);
  assert.deepEqual(Object.keys(EXPECTED).sort(), pinned);
  assert.deepEqual(Object.keys(SERVER_REQUEST_RESPONSE_SCHEMAS).sort(), pinned);
});

test('each pinned server request gets exactly one schema-valid deny/-32601 reply over the wire, never an approval', async () => {
  const methods = pinnedServerRequestMethods();
  const lines = methods.flatMap((m, i) => {
    const e = EXPECTED[m]!;
    const reply = 'result' in e ? { id: `srv-${i}`, result: e.result } : { id: `srv-${i}`, error: { code: e.errorCode, message: 'Method not found' } };
    return [`<< ${JSON.stringify({ id: `srv-${i}`, method: m, params: {} })}`, `>> ${JSON.stringify(reply)}`];
  });
  // Synthetic params ({}) are not schema-valid for most methods, so only the adapter's replies are schema-checked here;
  // legacy-approvals.jsonl covers schema-valid params.
  const h = setup({ scripts: [concat(HANDSHAKE, ...lines)], fake: { validateEmitted: false } });
  await h.adapter.start();
  await h.fakes[0]!.done();
  await until(() => h.fakes[0]!.received.filter((m) => !('method' in m)).length === methods.length, 'all replies');
  assert.deepEqual(h.problems(), []);
  const replies = h.fakes[0]!.received.filter((m) => !('method' in m));
  assert.equal(new Set(replies.map((r) => r['id'])).size, methods.length, 'one reply per id');
  const text = JSON.stringify(replies);
  for (const yes of ['"accept"', 'acceptForSession', '"approved"', 'approved_for_session']) assert.ok(!text.includes(yes), `never ${yes}`);
});

test('legacy applyPatchApproval / execCommandApproval are denied (anomaly logged); token refresh and attestation get -32601 + security log', async () => {
  const h = setup({ scripts: [concat(HANDSHAKE, loadTranscript('legacy-approvals.jsonl'))] });
  await h.adapter.start();
  await h.fakes[0]!.done();
  await until(() => h.fakes[0]!.received.filter((m) => !('method' in m)).length === 4, '4 replies');
  assert.deepEqual(h.problems(), []);
  const events = h.logger.entries.map((e) => e.event);
  assert.equal(events.filter((e) => e === 'codex.server_request.anomaly').length, 2);
  assert.ok(events.includes('security.codex.tokens_refresh_refused'));
  assert.ok(events.includes('security.codex.attestation_refused'));
});

test('the legacy denial body is valid against the pinned ReviewDecision schema; the CONTRACTS string "denied" is not', () => {
  const ours = (EXPECTED['execCommandApproval'] as { result: unknown }).result;
  assert.equal(schemaError('ExecCommandApprovalResponse.json', ours), null);
  assert.equal(schemaError('ApplyPatchApprovalResponse.json', ours), null);
  assert.notEqual(schemaError('ExecCommandApprovalResponse.json', { decision: 'denied' }), null);
});

test('an unknown server request gets -32601 and is logged', async () => {
  const h = setup({
    scripts: [
      concat(
        HANDSHAKE,
        '<< {"id":"srv-x","method":"item/brandNew/requestApproval","params":{"anything":true}}',
        '>> {"id":"srv-x","error":{"code":-32601,"message":"Method not found"}}',
      ),
    ],
    fake: { validateEmitted: false },
  });
  await h.adapter.start();
  await h.fakes[0]!.done();
  await until(() => h.fakes[0]!.received.some((m) => m['id'] === 'srv-x'), 'reply');
  assert.deepEqual(h.problems(), []);
  assert.ok(h.logger.entries.some((e) => e.event === 'codex.server_request.unknown' && e.fields['method'] === 'item/brandNew/requestApproval'));
});
