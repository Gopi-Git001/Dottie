/** CodexErrorInfo → CodexErrorKind over every alternative in the pinned schema (CONTRACTS §1.5). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RETRYABLE_ERROR_KINDS, type CodexErrorKind } from '@dottie/contracts';
import { classifyCodexErrorInfo, interpretErrorNotification } from '../src/errors.js';
import { loadSchema } from './support/schema.js';

/** CONTRACTS §1.5 rows 1-15 (string variants). */
const STRING_TABLE: Record<string, CodexErrorKind> = {
  contextWindowExceeded: 'fatal',
  sessionBudgetExceeded: 'plan_limit',
  usageLimitExceeded: 'plan_limit',
  rateLimitExceeded: 'rate_limited',
  flexUnavailable: 'fatal',
  serverOverloaded: 'transient',
  cyberPolicy: 'fatal',
  misalignmentPolicyViolation: 'fatal',
  tooManyDenials: 'fatal',
  internalServerError: 'transient',
  unauthorized: 'auth',
  badRequest: 'fatal',
  threadRollbackFailed: 'fatal',
  sandboxError: 'fatal',
  other: 'fatal',
};
const HTTP = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected'];

function pinnedVariants(): { strings: string[]; objects: string[]; catchAll: number } {
  const s = loadSchema('codex_app_server_protocol.v2.schemas.json') as {
    definitions: { CodexErrorInfo: { anyOf?: Record<string, unknown>[]; oneOf?: Record<string, unknown>[] } };
  };
  const alts = s.definitions.CodexErrorInfo.anyOf ?? s.definitions.CodexErrorInfo.oneOf ?? [];
  const strings: string[] = [];
  const objects: string[] = [];
  let catchAll = 0;
  for (const a of alts) {
    if (Array.isArray(a['enum'])) strings.push(...(a['enum'] as string[]));
    else if (a['properties'] && typeof a['properties'] === 'object') objects.push(...Object.keys(a['properties'] as object));
    else catchAll++;
  }
  return { strings, objects, catchAll };
}

test('the pinned schema has 21 CodexErrorInfo alternatives (15 strings, 5 objects, 1 catch-all) and all are mapped', () => {
  const { strings, objects, catchAll } = pinnedVariants();
  assert.deepEqual([...strings].sort(), Object.keys(STRING_TABLE).sort());
  assert.deepEqual([...objects].sort(), [...HTTP, 'activeTurnNotSteerable', 'responseTooManyFailedAttempts'].sort());
  assert.equal(strings.length + objects.length + catchAll, 21);
  for (const v of strings) assert.equal(classifyCodexErrorInfo(v).kind, STRING_TABLE[v], v);
  for (const v of objects) assert.notEqual(classifyCodexErrorInfo({ [v]: { httpStatusCode: null } }).variant, 'unknown', v);
});

test('HTTP-carrying variants: 401→auth, 429→rate_limited, 5xx/null→transient, other 4xx→fatal', () => {
  for (const v of HTTP) {
    assert.equal(classifyCodexErrorInfo({ [v]: { httpStatusCode: 401 } }).kind, 'auth');
    assert.equal(classifyCodexErrorInfo({ [v]: { httpStatusCode: 429 } }).kind, 'rate_limited');
    assert.equal(classifyCodexErrorInfo({ [v]: { httpStatusCode: 503 } }).kind, 'transient');
    assert.equal(classifyCodexErrorInfo({ [v]: { httpStatusCode: null } }).kind, 'transient');
    assert.equal(classifyCodexErrorInfo({ [v]: {} }).kind, 'transient');
    assert.equal(classifyCodexErrorInfo({ [v]: { httpStatusCode: 403 } }).kind, 'fatal');
    assert.equal(classifyCodexErrorInfo({ [v]: { httpStatusCode: 400 } }).kind, 'fatal');
  }
  const t = 'responseTooManyFailedAttempts';
  assert.equal(classifyCodexErrorInfo({ [t]: { httpStatusCode: 401 } }).kind, 'auth');
  assert.equal(classifyCodexErrorInfo({ [t]: { httpStatusCode: 429 } }).kind, 'rate_limited');
  assert.equal(classifyCodexErrorInfo({ [t]: { httpStatusCode: 403 } }).kind, 'transient');
  assert.equal(classifyCodexErrorInfo({ [t]: { httpStatusCode: null } }).kind, 'transient');
  assert.equal(classifyCodexErrorInfo({ activeTurnNotSteerable: { turnKind: 'review' } }).kind, 'fatal');
});

test('unauthorized and any 401 mark the session expired', () => {
  assert.equal(classifyCodexErrorInfo('unauthorized').authExpired, true);
  assert.equal(classifyCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 401 } }).authExpired, true);
  assert.equal(classifyCodexErrorInfo('usageLimitExceeded').authExpired, false);
});

test('plan_limit and auth are never retryable; only transient and rate_limited are', () => {
  assert.equal(classifyCodexErrorInfo('usageLimitExceeded').kind, 'plan_limit');
  assert.equal(classifyCodexErrorInfo('sessionBudgetExceeded').kind, 'plan_limit');
  assert.equal(RETRYABLE_ERROR_KINDS.has('plan_limit'), false);
  assert.equal(RETRYABLE_ERROR_KINDS.has('auth'), false);
  assert.equal(RETRYABLE_ERROR_KINDS.has('fatal'), false);
  assert.deepEqual([...RETRYABLE_ERROR_KINDS].sort(), ['rate_limited', 'transient']);
});

test('unknown, malformed or null codexErrorInfo is fatal (no silent retry)', () => {
  for (const v of ['bioPolicy', 'invalidPrompt', '', 42, [], { a: 1, b: 2 }, { bioPolicy: {} }, null, undefined]) {
    assert.equal(classifyCodexErrorInfo(v).kind, 'fatal', JSON.stringify(v));
  }
});

test('error notifications: willRetry:true is only RECOVERING; the final one is classified (V-run L26-37)', () => {
  const retrying = { error: { message: 'Reconnecting... 2/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }, willRetry: true };
  assert.deepEqual(interpretErrorNotification(retrying), { recovering: true });
  const final = { error: { message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, willRetry: false };
  const r = interpretErrorNotification(final);
  assert.equal(r.recovering, false);
  if (!r.recovering) assert.equal(r.error.kind, 'auth');
});
