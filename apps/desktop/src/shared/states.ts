/**
 * Coordinator + tray state vocabulary.
 *
 * DRAFT — mirrors spec §4 ("State machine" + "Additional events"). The coordinator is owned by
 * E03 and the shared vocabulary by E01 (packages/contracts). Until E01 signs off, this is the
 * desktop app's local copy; do not treat it as the canonical contract.
 */
import { z } from 'zod';
import { RuntimeStatusSchema } from './runtime';

export const COORDINATOR_STATES = [
  'BOOTING',
  'STANDBY',
  'WAKE_DETECTED',
  'LISTENING',
  'TRANSCRIBING',
  'CONFIRMING',
  'EXECUTING',
  'VERIFYING',
  'SPEAKING',
  // "Additional events" in spec §4, modelled as states the coordinator can report.
  'MUTED',
  'AUTH_REQUIRED',
  'PERMISSION_REQUIRED',
  'CANCELLING',
  'RECOVERING',
  'ERROR',
  'SHUTDOWN',
] as const;
export const CoordinatorStateSchema = z.enum(COORDINATOR_STATES);
export type CoordinatorState = z.infer<typeof CoordinatorStateSchema>;

/** The six tray states required by spec §13.4, plus Error for a Codex runtime breaker (CONTRACTS §2.4). */
export const TRAY_STATES = ['standby', 'listening', 'executing', 'auth_required', 'muted', 'offline', 'error'] as const;
export const TrayStateSchema = z.enum(TRAY_STATES);
export type TrayState = z.infer<typeof TrayStateSchema>;

export const TRAY_STATE_LABEL: Readonly<Record<TrayState, string>> = {
  standby: 'Standby',
  listening: 'Listening',
  executing: 'Executing',
  auth_required: 'Auth required',
  muted: 'Muted',
  offline: 'Offline',
  error: 'Error',
};

/** CONTRACTS §2.1 AuthState. */
export const AuthStatusSchema = z.enum(['unknown', 'unavailable', 'signed_out', 'signing_in', 'signed_in', 'expired', 'unsupported']);
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const NetworkStatusSchema = z.enum(['online', 'offline', 'unknown']);
export type NetworkStatus = z.infer<typeof NetworkStatusSchema>;

/**
 * Why the most recent task finished blocked (CONTRACTS §2.1/§3 TaskFinished `blocked_auth` /
 * `blocked_unavailable` reasons), or 'none'. Main clears it when a new task starts, and on a fresh
 * definitive auth status (see controller.ts).
 */
export const TaskBlockSchema = z.enum(['none', 'auth_required', 'sign_in_in_progress', 'account_unsupported', 'codex_unavailable']);
export type TaskBlock = z.infer<typeof TaskBlockSchema>;

/**
 * Last task ended `failed_after_side_effects` (CONTRACTS §2.1 "Mid-run and after-commit"): 'none',
 * 'unspecified' (no reason), or its TaskFinished reason. Tooltip/activity detail ONLY — never an
 * Auth required prompt, never a tray state on its own, and never the persistent `blocked` reason.
 * Same values as contracts.draft SHARED_TASK_REASONS (test-enforced; no import to avoid a cycle).
 */
export const FailedAfterChangesSchema = z.enum([
  'none',
  'unspecified',
  'auth_required',
  'sign_in_in_progress',
  'account_unsupported',
  'codex_unavailable',
  'clarification_timeout',
  'clarification_cancelled',
  'approval_unavailable',
]);
export type FailedAfterChanges = z.infer<typeof FailedAfterChangesSchema>;

/**
 * Detail for the last task's notable non-blocking ending (tooltip/activity only, cleared on the next
 * task): `declined` + `approval_unavailable`, `failed` + `clarification_timeout|clarification_cancelled`.
 */
export const LastTaskNoteSchema = z.enum(['none', 'approval_unavailable', 'clarification_timeout', 'clarification_cancelled', 'retry_not_allowed']);
export type LastTaskNote = z.infer<typeof LastTaskNoteSchema>;

/** Everything the tray model needs; produced by main from coordinator + settings + adapters. */
export const DesktopSnapshotSchema = z.object({
  coordinator: CoordinatorStateSchema,
  /** User mute (mic closed; wake detection off). Persisted. */
  muted: z.boolean(),
  /** User pause (mic closed and no new tasks) — session-only. */
  paused: z.boolean(),
  auth: AuthStatusSchema,
  network: NetworkStatusSchema,
  /** A Codex task is in flight (coordinator owns the truth; this is its projection). */
  taskActive: z.boolean(),
  /**
   * Codex runtime supervisor status (CONTRACTS §2.4, ADR-0013). Deliberately NOT a coordinator state.
   */
  runtime: RuntimeStatusSchema,
  /** Reason the last task finished blocked (TaskFinished.reason), or 'none'. */
  blocked: TaskBlockSchema,
  /**
   * Codex retry burst in progress for the running task (TaskProgress{state: RECOVERING}, CONTRACTS
   * §2.1 port deltas). Tooltip/detail text only: never changes the tray state, never spoken.
   */
  recovering: z.boolean(),
  /** Last task failed after making changes (+ reason). Tooltip detail only. */
  failedAfterChanges: FailedAfterChangesSchema,
  /** Last task declined because approval was unavailable, or failed on a clarification. Detail only. */
  lastTaskNote: LastTaskNoteSchema,
  /**
   * The last task failed after side effects or its result could not be confirmed, so the tray
   * offers "Retry last task" (D14). Main keeps the taskId; the view only carries this flag.
   */
  retryTaskAvailable: z.boolean(),
});
export type DesktopSnapshot = z.infer<typeof DesktopSnapshotSchema>;

export const MenuItemIdSchema = z.enum([
  'wake_test',
  'toggle_mute',
  'toggle_pause',
  'settings',
  'show_activity',
  'reconnect',
  'retry',
  'retry_task',
  'sign_out',
  'switch_account',
  'stop_task',
  'quit',
]);
export type MenuItemId = z.infer<typeof MenuItemIdSchema>;

export const TrayViewSchema = z.object({
  state: TrayStateSchema,
  label: z.string(),
  tooltip: z.string(),
  /** True when local wake-word detection should be running (spec §5: works while auth expired/offline). */
  wakeAvailable: z.boolean(),
  /** True when a new Codex task may be dispatched. */
  canDispatch: z.boolean(),
  /** Diagnostic: the coordinator reported a state that conflicts with the user's mute/pause. */
  inconsistent: z.boolean(),
  snapshot: DesktopSnapshotSchema,
});
export type TrayView = z.infer<typeof TrayViewSchema>;

export const MenuItemViewSchema = z.object({
  id: MenuItemIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  /** Contextual items (Retry, Sign out, Switch account) are hidden when they do not apply. */
  visible: z.boolean(),
});
export type MenuItemView = z.infer<typeof MenuItemViewSchema>;
