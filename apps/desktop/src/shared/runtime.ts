/**
 * Supervised-runtime status (Codex app-server child), pushed main -> renderer and fed to the tray model.
 *
 * Mirrors the frozen `RuntimeStatus` in arch/CONTRACTS.md §2.4 and ADR-0013 (E01, 2026-10-19).
 * `waiting_for_env` is NOT a coordinator state: a task attempted while the runtime waits for its
 * environment finishes blocked (reason `codex_unavailable`) and the coordinator stays idle.
 * When packages/contracts lands, import the enum from there instead.
 */
import { z } from 'zod';

export const RUNTIME_STATUSES = [
  /** No report from the supervisor yet (desktop default at boot). */
  'unknown',
  'starting',
  'running',
  /** Crash/hang exit; restart scheduled with full-jitter backoff (ADR-0013 §1-2). */
  'backoff',
  /** Circuit breaker OPEN; restartable by user Retry or HALF-OPEN (ADR-0013 §3). */
  'breaker_open',
  'half_open',
  /** env_unavailable exit class: waiting for the matching OS event; not a crash (ADR-0013 §2). */
  'waiting_for_env',
  /** User Quit — no restart (ADR-0013 §4). */
  'stopped',
] as const;
export const RuntimeStatusSchema = z.enum(RUNTIME_STATUSES);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

/** Which supervised runtime the status describes. Only the Codex app-server feeds the tray today. */
export const RuntimeRoleSchema = z.enum(['codex_app_server']);
export type RuntimeRole = z.infer<typeof RuntimeRoleSchema>;

/** Push payload for EVENT_CHANNELS.runtimeStatus. No exit codes, paths or env details (CONTRACTS §4). */
export const RuntimeStatusEventSchema = z.strictObject({
  role: RuntimeRoleSchema,
  status: RuntimeStatusSchema,
  since: z.iso.datetime({ offset: true }),
});
export type RuntimeStatusEvent = z.infer<typeof RuntimeStatusEventSchema>;
