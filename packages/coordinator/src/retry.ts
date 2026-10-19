import type { CodexError, CodexErrorKind } from './ports.js';

export interface RetryPolicy {
  /** Total attempts including the first (>= 1). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** 0..1, fraction of the delay randomised (full delay * (1 - jitter .. 1)). */
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.2 };

/** Exponential backoff for retry number `retryIndex` (1 = first retry). */
export function backoffDelay(policy: RetryPolicy, retryIndex: number, random: () => number = Math.random): number {
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retryIndex - 1));
  const jitter = Math.min(1, Math.max(0, policy.jitterRatio));
  return Math.round(raw * (1 - jitter * random()));
}

const RETRYABLE: ReadonlySet<CodexErrorKind> = new Set<CodexErrorKind>(['transient', 'rate_limited']);

/**
 * Spec §9.9 "Retry only when safe and bounded", restated by CONTRACTS §1.5 (E01 2026-10-19). Retry only when all hold:
 * - the failure is a `turn/completed{status:'failed'}` (origin `turn_failed`); JSON-RPC errors (`rpc_error`, always
 *   -32600 with no data, e.g. a rejected turn/start) and adapter-side failures are never retried;
 * - its kind is `rate_limited` or `transient` (never `auth`, `plan_limit` or `fatal`);
 * - THAT turn's ledger is empty: no side-effecting item started in it;
 * - attempt < maxAttempts.
 * Codex does not dedupe clientUserMessageId, so each retry is a new turn with a new turnId, dispatched only after
 * the failed run() settled (one turn in flight; idempotency is local, never the server's).
 */
export function shouldRetry(policy: RetryPolicy, attempt: number, error: Pick<CodexError, 'kind' | 'origin'>, turnLedgerEmpty: boolean): boolean {
  return error.origin === 'turn_failed' && RETRYABLE.has(error.kind) && turnLedgerEmpty && attempt < policy.maxAttempts;
}
