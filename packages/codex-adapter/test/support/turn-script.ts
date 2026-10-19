/**
 * Building blocks for thread/turn transcripts. Server messages come from the redacted 0.163.0 evidence in
 * test/fixtures/turn-wire-0.163.0.json (V-run L17-38) where the wire was observed; the rest (agent messages, plan,
 * tool items) are hand-written from the pinned schema and marked UNVERIFIED-ON-WIRE. Interrupt, resume and JSON-RPC
 * errors come from E09's verified pre-auth run (test/fixtures/turn-wire-e09-0.163.0.json). The fake validates
 * every one of them against the generated JSON schema.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRANSCRIPT_DIR } from './fake-app-server.js';

type J = Record<string, unknown>;
const W = JSON.parse(readFileSync(join(TRANSCRIPT_DIR, '..', 'turn-wire-0.163.0.json'), 'utf8')) as Record<string, J>;
export const E09 = JSON.parse(readFileSync(join(TRANSCRIPT_DIR, '..', 'turn-wire-e09-0.163.0.json'), 'utf8')) as Record<string, J>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const CWD = '/work/ws';
export const THREAD_ID = (W['threadStart']!['thread'] as J)['id'] as string;
export const TURN_ID = (W['turnStart']!['turn'] as J)['id'] as string;

const expect = (o: J) => `>> ${JSON.stringify(o)}`;
const emit = (o: J) => `<< ${JSON.stringify(o)}`;
const lines = (...l: string[]) => l.join('\n');

const SIGNED_IN_RESULT = { account: { type: 'chatgpt', email: 'person@example.com', planType: 'pro' }, requiresOpenaiAuth: true };
const SIGNED_OUT_RESULT = { account: null, requiresOpenaiAuth: true, workspaceRouting: null };

export const READ_SIGNED_IN = lines(expect({ method: 'account/read', params: { refreshToken: false } }), emit({ id: '$', result: SIGNED_IN_RESULT }));
export const READ_SIGNED_OUT = lines(expect({ method: 'account/read', params: { refreshToken: false } }), emit({ id: '$', result: SIGNED_OUT_RESULT }));

/** initialize → initialized → account/read (signed in, hand-written read shape as in signed-in-logout.jsonl). */
export const HANDSHAKE_SIGNED_IN = lines(
  expect({ method: 'initialize', params: { clientInfo: { name: 'dottie' }, capabilities: { experimentalApi: false, requestAttestation: false } } }),
  emit({ id: '$', result: { userAgent: 'dottie/0.163.0', codexHome: '/redacted/codex-home', platformFamily: 'unix', platformOs: 'linux' } }),
  expect({ method: 'initialized' }),
  READ_SIGNED_IN,
);

/** Real thread/start result (V-run L17), optionally with the sandbox / policy the server echoes changed. */
export function threadStartResult(change: { sandbox?: J; approvalPolicy?: string } = {}): J {
  const r = clone(W['threadStart']!);
  if (change.sandbox) r['sandbox'] = change.sandbox;
  if (change.approvalPolicy) r['approvalPolicy'] = change.approvalPolicy;
  return r;
}

export function threadStart(result: J = threadStartResult()): string {
  return lines(
    expect({ method: 'thread/start', params: { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'read-only' } }),
    emit({ id: '$', result }),
  );
}

/**
 * thread/resume after an App Server restart. The adapter sends excludeTurns:true (E09 v0.3.0). VERIFIED (E09 runs,
 * process p2): deprecationNotice and thread/status/changed{idle} before the result, thread/goal/cleared, and the
 * result's extra keys (collaborationMode, initialTurnsPage, turnsBackwardsCursor, itemsBackwardsCursor,
 * activePermissionProfile:null). Those runs resumed WITHOUT excludeTurns, so `thread.turns: []` here is
 * UNVERIFIED-ON-WIRE (schema: "without populating thread.turns"); the notices are kept to prove they are harmless.
 */
export function threadResume(change: { sandbox?: J; approvalPolicy?: string; echoThreadId?: string } = {}): string {
  const result = clone(E09['resumeResult']!);
  (result['thread'] as J)['turns'] = [];
  if (change.echoThreadId) (result['thread'] as J)['id'] = change.echoThreadId;
  if (change.sandbox) result['sandbox'] = change.sandbox;
  if (change.approvalPolicy) result['approvalPolicy'] = change.approvalPolicy;
  return lines(
    expect({ method: 'thread/resume', params: { threadId: THREAD_ID, cwd: CWD, approvalPolicy: 'on-request', sandbox: 'read-only', excludeTurns: true } }),
    ...(E09['resumeNotificationsBeforeResult'] as unknown as J[]).map(emit),
    emit(E09['goalCleared']!),
    emit({ id: '$', result }),
  );
}

/**
 * thread/turns/list (restart reconcile). Result shape VERIFIED (E09 v0.3.0, resume scenario); each entry's id, status
 * and userMessage clientId are set per test. `rpcErrorInstead` answers with the E09 -32600 shape instead.
 */
export function turnsList(entries: readonly { id: string; clientId: string; status?: string }[], o: { cursor?: string; nextCursor?: string; rpcErrorInstead?: boolean } = {}): string {
  const req = expect({ method: 'thread/turns/list', params: { threadId: THREAD_ID, ...(o.cursor !== undefined ? { cursor: o.cursor } : {}) } });
  if (o.rpcErrorInstead) return lines(req, emit({ id: '$', error: { code: -32600, message: 'thread not found' } }));
  const result = clone(E09['turnsListResult']!);
  const template = (result['data'] as J[])[0]!;
  result['data'] = entries.map((e) => {
    const t = clone(template);
    t['id'] = e.id;
    t['rootTurnId'] = e.id;
    t['status'] = e.status ?? 'failed';
    (t['items'] as J[])[0]!['clientId'] = e.clientId;
    return t;
  });
  result['nextCursor'] = o.nextCursor ?? null;
  return lines(req, emit({ id: '$', result }));
}

function turn(turnId: string, status: string, error: unknown = null): J {
  const t = clone((W['turnStart']!['turn'] as J));
  return { ...t, id: turnId, rootTurnId: turnId, status, error };
}

/** turn/start and the server's opening messages, in the observed order (V-run L18-25). */
export function turnStart(text: string, taskId: string, turnId = TURN_ID, attempt = 1): string {
  const started = clone(W['turn/started']!);
  (started['params'] as J)['turn'] = { ...turn(turnId, 'inProgress'), startedAt: 1792330223 };
  const user = (k: string) => {
    const m = clone(W[k]!);
    (m['params'] as J)['turnId'] = turnId;
    return emit(m);
  };
  return lines(
    expect({ method: 'turn/start', params: { threadId: THREAD_ID, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: `${taskId}.t${attempt}` } }),
    emit(W['thread/started']!),
    emit({ id: '$', result: { turn: turn(turnId, 'inProgress') } }),
    emit(W['statusActive']!),
    emit(started),
    user('itemStartedUser'),
    user('itemCompletedUser'),
  );
}

const ids = (turnId: string) => ({ threadId: THREAD_ID, turnId });

/** UNVERIFIED-ON-WIRE: agentMessage item with streamed deltas. */
export function agentMessage(itemId: string, deltas: string[], turnId = TURN_ID): string {
  const item = (text: string) => ({ type: 'agentMessage', id: itemId, text, phase: null, memoryCitation: null, delivery: null, questions: null });
  return lines(
    emit({ method: 'item/started', params: { item: item(''), ...ids(turnId), startedAtMs: 1792330224000 } }),
    ...deltas.map((delta) => emit({ method: 'item/agentMessage/delta', params: { ...ids(turnId), itemId, delta } })),
    emit({ method: 'item/completed', params: { item: item(deltas.join('')), ...ids(turnId), completedAtMs: 1792330225000 } }),
  );
}

/** UNVERIFIED-ON-WIRE: a commandExecution item starting. */
export function commandStarted(itemId: string, turnId = TURN_ID): string {
  return emit({
    method: 'item/started',
    params: {
      item: { type: 'commandExecution', id: itemId, command: 'ls', commandActions: [], cwd: CWD, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null, processId: null },
      ...ids(turnId),
      startedAtMs: 1792330224100,
    },
  });
}

export function planUpdated(statuses: string[], turnId = TURN_ID): string {
  return emit({ method: 'turn/plan/updated', params: { ...ids(turnId), explanation: null, plan: statuses.map((status, i) => ({ step: `step ${i + 1}`, status })) } });
}

/** error notification; `willRetry:true` mirrors V-run L26, the final one L37. */
export function errorNote(codexErrorInfo: unknown, willRetry: boolean, turnId = TURN_ID): string {
  return emit({ method: 'error', params: { error: { message: 'redacted', codexErrorInfo, additionalDetails: null, misalignment: null }, willRetry, ...ids(turnId) } });
}

/** turn/completed (shape V-run L38). */
export function turnCompleted(status: 'completed' | 'interrupted' | 'failed', turnId = TURN_ID, codexErrorInfo?: unknown): string {
  const error = status === 'failed' ? { message: 'redacted', codexErrorInfo: codexErrorInfo ?? null, additionalDetails: null, misalignment: null } : null;
  return emit({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { ...turn(turnId, status, error), startedAt: 1792330223, completedAt: 1792330237, durationMs: 13755 } } });
}

/** turn/interrupt → {} then thread/status/changed{idle}, VERIFIED (E09 run). Follow with interruptCompleted(). */
export function interrupt(turnId = TURN_ID): string {
  const idle = clone(E09['interruptStatusIdle']!);
  return lines(expect({ method: 'turn/interrupt', params: { threadId: THREAD_ID, turnId } }), emit({ id: '$', result: E09['interruptResult']! }), emit(idle));
}

/** turn/completed{status:'interrupted', error:null}, VERIFIED (E09 run). */
export function interruptCompleted(turnId = TURN_ID): string {
  const m = clone(E09['interruptTurnCompleted']!);
  const t = (m['params'] as J)['turn'] as J;
  t['id'] = turnId;
  t['rootTurnId'] = turnId;
  return emit(m);
}

/** A JSON-RPC error response exactly as 0.163.0 sends it: code -32600, NO data member (E09 run). */
export function rpcError(message: string): string {
  return emit({ id: '$', error: { code: -32600, message } });
}

export { expect, emit, lines };
