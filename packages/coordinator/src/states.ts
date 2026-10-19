/**
 * Coordinator states and the explicit transition table (spec §4 "State machine").
 * Anything not listed here is an invalid transition and is rejected + logged by StateMachine.
 */
export const STATES = [
  'BOOTING',
  'STANDBY',
  'WAKE_DETECTED',
  'LISTENING',
  'TRANSCRIBING',
  'CONFIRMING',
  'EXECUTING',
  'VERIFYING',
  'SPEAKING',
  'MUTED',
  'AUTH_REQUIRED',
  'PERMISSION_REQUIRED',
  'CANCELLING',
  'RECOVERING',
  'ERROR',
  'SHUTDOWN',
] as const;

export type CoordinatorState = (typeof STATES)[number];

/** States in which a task is owned by the coordinator and may hold external side effects. */
export const TASK_ACTIVE_STATES: ReadonlySet<CoordinatorState> = new Set<CoordinatorState>([
  'CONFIRMING',
  'EXECUTING',
  'PERMISSION_REQUIRED',
  'VERIFYING',
  'RECOVERING',
  'CANCELLING',
]);

/** Resting states: nothing in flight, wake word may be armed (except MUTED). */
export const REST_STATES: ReadonlySet<CoordinatorState> = new Set<CoordinatorState>(['STANDBY', 'MUTED', 'AUTH_REQUIRED']);

export const TRANSITIONS: Readonly<Record<CoordinatorState, readonly CoordinatorState[]>> = {
  // Boot ends in a rest state that reflects mute/auth, or fails.
  BOOTING: ['STANDBY', 'MUTED', 'AUTH_REQUIRED', 'ERROR', 'SHUTDOWN'],
  STANDBY: ['WAKE_DETECTED', 'MUTED', 'AUTH_REQUIRED', 'RECOVERING', 'ERROR', 'SHUTDOWN'],
  // false wake / no speech returns to the rest state (STANDBY or AUTH_REQUIRED).
  WAKE_DETECTED: ['LISTENING', 'STANDBY', 'AUTH_REQUIRED', 'MUTED', 'RECOVERING', 'ERROR', 'SHUTDOWN'],
  // LISTENING -> SPEAKING: report while a clarification answer is awaited (cancel/no-answer, Ruling 2).
  LISTENING: ['TRANSCRIBING', 'SPEAKING', 'STANDBY', 'AUTH_REQUIRED', 'MUTED', 'RECOVERING', 'ERROR', 'SHUTDOWN'],
  // TRANSCRIBING -> SPEAKING is the "didn't catch that" prompt; -> AUTH_REQUIRED when dispatch is blocked on sign-in.
  TRANSCRIBING: ['CONFIRMING', 'EXECUTING', 'SPEAKING', 'STANDBY', 'AUTH_REQUIRED', 'MUTED', 'RECOVERING', 'ERROR', 'SHUTDOWN'],
  // CONFIRMING -> SPEAKING when the user declines / confirmation expires.
  CONFIRMING: ['EXECUTING', 'SPEAKING', 'CANCELLING', 'AUTH_REQUIRED', 'ERROR'],
  // No direct EXECUTING -> SHUTDOWN/STANDBY: a running task must go through CANCELLING or a reported outcome.
  EXECUTING: ['VERIFYING', 'PERMISSION_REQUIRED', 'CANCELLING', 'RECOVERING', 'AUTH_REQUIRED', 'SPEAKING', 'ERROR'],
  PERMISSION_REQUIRED: ['EXECUTING', 'CANCELLING', 'ERROR'],
  VERIFYING: ['SPEAKING', 'CANCELLING', 'ERROR'],
  // SPEAKING -> WAKE_DETECTED/LISTENING = barge-in or follow-up window; -> EXECUTING/CONFIRMING = start queued task.
  SPEAKING: ['STANDBY', 'MUTED', 'AUTH_REQUIRED', 'WAKE_DETECTED', 'LISTENING', 'EXECUTING', 'CONFIRMING', 'ERROR', 'SHUTDOWN'],
  CANCELLING: ['SPEAKING', 'STANDBY', 'MUTED', 'AUTH_REQUIRED', 'ERROR', 'SHUTDOWN'],
  // RECOVERING -> EXECUTING only for a bounded, side-effect-free retry.
  RECOVERING: ['EXECUTING', 'STANDBY', 'MUTED', 'AUTH_REQUIRED', 'SPEAKING', 'CANCELLING', 'ERROR', 'SHUTDOWN'],
  // AUTH_REQUIRED keeps local wake working (spec §5) and returns to STANDBY on reconnect.
  AUTH_REQUIRED: ['STANDBY', 'WAKE_DETECTED', 'SPEAKING', 'MUTED', 'RECOVERING', 'ERROR', 'SHUTDOWN'],
  MUTED: ['STANDBY', 'AUTH_REQUIRED', 'ERROR', 'SHUTDOWN'],
  ERROR: ['RECOVERING', 'SHUTDOWN'],
  SHUTDOWN: [],
};

export function isValidTransition(from: CoordinatorState, to: CoordinatorState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isCoordinatorState(value: unknown): value is CoordinatorState {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}
