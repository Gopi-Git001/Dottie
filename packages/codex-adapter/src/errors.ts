/** CodexErrorInfo → CodexErrorKind (CONTRACTS §1.5, all 21 alternatives of the pinned schema). Pure. */
import type { CodexErrorKind } from '@dottie/contracts';

export interface ClassifiedError {
  readonly kind: CodexErrorKind;
  /** Wire variant name, or 'unknown' / 'null'. Safe to log. */
  readonly variant: string;
  readonly httpStatusCode: number | null;
  /** true when the ChatGPT session is no longer valid (AuthState → expired). */
  readonly authExpired: boolean;
}

const STRING_VARIANTS: Readonly<Record<string, CodexErrorKind>> = {
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

const HTTP_VARIANTS = new Set(['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected']);

function byStatus(status: number | null, otherwise: CodexErrorKind): CodexErrorKind {
  if (status === 401) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === null || (status >= 500 && status <= 599)) return 'transient';
  return otherwise;
}

const result = (kind: CodexErrorKind, variant: string, httpStatusCode: number | null = null): ClassifiedError => ({
  kind,
  variant,
  httpStatusCode,
  authExpired: kind === 'auth',
});

export function classifyCodexErrorInfo(info: unknown): ClassifiedError {
  if (info === null || info === undefined) return result('fatal', 'null');
  if (typeof info === 'string') {
    const kind = Object.prototype.hasOwnProperty.call(STRING_VARIANTS, info) ? STRING_VARIANTS[info] : undefined;
    return kind ? result(kind, info) : result('fatal', 'unknown');
  }
  if (typeof info !== 'object' || Array.isArray(info)) return result('fatal', 'unknown');
  const keys = Object.keys(info);
  if (keys.length !== 1) return result('fatal', 'unknown');
  const variant = keys[0] as string;
  const body = (info as Record<string, unknown>)[variant];
  const rawStatus = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['httpStatusCode'] : undefined;
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) ? rawStatus : null;
  // Other 4xx (and any non-5xx code) on a connection failure is fatal.
  if (HTTP_VARIANTS.has(variant)) return result(byStatus(status, 'fatal'), variant, status);
  // Codex already exhausted its own retries; still bounded by the coordinator's maxAttempts.
  if (variant === 'responseTooManyFailedAttempts') return result(byStatus(status, 'transient'), variant, status);
  if (variant === 'activeTurnNotSteerable') return result('fatal', variant);
  return result('fatal', 'unknown');
}

/** `error` notification: while Codex retries itself (willRetry:true) Dottie only reports RECOVERING. */
export function interpretErrorNotification(
  params: unknown,
): { readonly recovering: true } | { readonly recovering: false; readonly error: ClassifiedError } {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  if (p['willRetry'] === true) return { recovering: true };
  const err = (typeof p['error'] === 'object' && p['error'] !== null ? p['error'] : {}) as Record<string, unknown>;
  return { recovering: false, error: classifyCodexErrorInfo(err['codexErrorInfo']) };
}

/**
 * A JSON-RPC error response from the App Server. On 0.163.0 these are always -32600 with no `data` member
 * (not-initialized, already-initialized, unknown method, invalid params, thread not found…; E09 pre-auth run), so
 * they never carry codexErrorInfo: protocol or programming error → `fatal`, never retried (E01 2026-10-19, CONTRACTS
 * §1.5 "Where errors come from"). `data`, if a future server sends one, is deliberately ignored.
 */
export function classifyRpcError(): ClassifiedError {
  return result('fatal', 'rpc_error');
}
