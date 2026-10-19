/**
 * ADR-0013 restart policy (pure). Shape Accepted 2026-10-19; every number PROVISIONAL until the E09 soak (DOT-042),
 * so the policy is a parameter.
 *
 * - Exit classes: clean | crash | hang | env_unavailable (CONTRACTS §2.4). Only crash and hang count toward backoff and the breaker.
 * - Backoff: full jitter, delay = random(0, min(cap, base·2^(n-1))) for the n-th failure in the window; cap depends on
 *   the power source (AC / battery).
 * - Breaker: the `breakerFailures`-th crash/hang inside `breakerWindowMs` opens it. OPEN → HALF-OPEN after the cool-off
 *   (halfOpenAfterMs, doubling on every consecutive trip up to coolOffMaxMs). A failure while HALF-OPEN re-opens it.
 *   No terminal state: user Retry resets everything.
 * - env_unavailable → waiting_for_env: no backoff, not counted; the supervisor waits for the matching OS event.
 */
import type { ExitClass } from '@dottie/contracts';
/** CONTRACTS §2.4 ExitClass (used directly). Only crash and hang count toward backoff and the breaker. */
export type { ExitClass };
export type PowerSource = 'ac' | 'battery';

export interface RestartPolicy {
  readonly baseMs: number;
  readonly capAcMs: number;
  readonly capBatteryMs: number;
  readonly breakerFailures: number;
  readonly breakerWindowMs: number;
  readonly halfOpenAfterMs: number;
  readonly coolOffMaxMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseMs: 500,
  capAcMs: 30_000,
  capBatteryMs: 120_000,
  breakerFailures: 5,
  breakerWindowMs: 10 * 60_000,
  halfOpenAfterMs: 15 * 60_000,
  coolOffMaxMs: 2 * 60 * 60_000,
};

export interface SupervisorMemory {
  /** Times of crash/hang exits (pruned to the window). */
  readonly failures: readonly number[];
  /** Consecutive breaker trips (drives the cool-off doubling). */
  readonly trips: number;
  /** The current child is the HALF-OPEN probe. */
  readonly halfOpen: boolean;
}

export const FRESH_MEMORY: SupervisorMemory = { failures: [], trips: 0, halfOpen: false };

export type RestartDecision =
  | { readonly action: 'none' }
  | { readonly action: 'restart'; readonly delayMs: number; readonly attempt: number }
  | { readonly action: 'breaker_open'; readonly coolOffMs: number; readonly trips: number }
  | { readonly action: 'wait_for_env' };

export interface DecideInput {
  readonly exit: ExitClass;
  readonly now: number;
  readonly power: PowerSource;
  readonly random: () => number;
}

export function coolOffFor(policy: RestartPolicy, trips: number): number {
  return Math.min(policy.coolOffMaxMs, policy.halfOpenAfterMs * 2 ** Math.max(0, trips - 1));
}

export function decideRestart(
  policy: RestartPolicy,
  memory: SupervisorMemory,
  input: DecideInput,
): { readonly decision: RestartDecision; readonly memory: SupervisorMemory } {
  if (input.exit === 'clean') return { decision: { action: 'none' }, memory };
  if (input.exit === 'env_unavailable') return { decision: { action: 'wait_for_env' }, memory: { ...memory, halfOpen: false } };
  const failures = [...memory.failures.filter((t) => t > input.now - policy.breakerWindowMs), input.now];
  if (memory.halfOpen || failures.length >= policy.breakerFailures) {
    const trips = memory.trips + 1;
    return { decision: { action: 'breaker_open', coolOffMs: coolOffFor(policy, trips), trips }, memory: { failures, trips, halfOpen: false } };
  }
  const cap = input.power === 'battery' ? policy.capBatteryMs : policy.capAcMs;
  const ceiling = Math.min(cap, policy.baseMs * 2 ** (failures.length - 1));
  const r = Math.min(Math.max(input.random(), 0), 1 - Number.EPSILON);
  return { decision: { action: 'restart', delayMs: Math.floor(r * ceiling), attempt: failures.length }, memory: { ...memory, failures } };
}

/** The HALF-OPEN probe (or any child) stayed healthy: close the breaker and reset the cool-off doubling. */
export function markHealthy(memory: SupervisorMemory): SupervisorMemory {
  return { failures: memory.failures, trips: 0, halfOpen: false };
}
