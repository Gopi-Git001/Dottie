/**
 * Pure tray state model: DesktopSnapshot -> one of the seven tray states (spec §13.4's six plus
 * Error for a Codex runtime breaker, CONTRACTS §2.4 / ADR-0013 item 3).
 *
 * PRECEDENCE (first match wins; documented in docs/contracts/desktop-ipc.DRAFT.md §4):
 *
 *  1. EXECUTING     — a task is in flight (taskActive, or coordinator in CONFIRMING / EXECUTING /
 *                     VERIFYING / PERMISSION_REQUIRED / CANCELLING / SPEAKING). A running task is
 *                     never hidden: muting the mic does not stop a task, so the user must still see
 *                     it and be able to "Stop task". Tooltip adds "mic muted" when relevant.
 *  2. MUTED         — user mute or pause, or coordinator reports MUTED. Overrides LISTENING /
 *                     WAKE_DETECTED / TRANSCRIBING: if the coordinator claims to be capturing while
 *                     the user muted, we show Muted and flag `inconsistent` (release blocker per
 *                     spec §14 "wake listening despite mute" — main must force the mic closed).
 *  3. LISTENING     — coordinator WAKE_DETECTED / LISTENING / TRANSCRIBING (mic capturing a command).
 *  4. OFFLINE       — network offline, or runtime `stopped` (user Quit). Wake detection keeps
 *                     running locally; dispatch blocked. Beats Error (E01 2026-10-19): nothing can
 *                     succeed offline, so Retry Codex is hidden/disabled until the network returns.
 *  5. ERROR         — runtime `breaker_open` while online (CONTRACTS §2.4, ADR-0013 item 3): the
 *                     Codex runtime stopped restarting after repeated crashes. Retry Codex asks the
 *                     supervisor to try again.
 *  6. STANDBY (runtime waiting_for_env, or last task blocked_unavailable/codex_unavailable) —
 *                     Codex is unreachable; NOT a coordinator state. Never Auth required, no sign-in
 *                     prompt; Reconnect re-probes (CONTRACTS §2.1: its own outcome so it can never
 *                     map to a sign-in prompt).
 *  7. STANDBY (runtime unknown / starting / backoff / half_open) — tooltip "Starting…" or
 *                     "Reconnecting…". Auth cannot be probed until the runtime is up, so these also
 *                     beat Auth required (CONTRACTS §2.1: unknown/unavailable auth -> codex_unavailable,
 *                     no AUTH_REQUIRED).
 *  8. AUTH_REQUIRED — coordinator AUTH_REQUIRED, auth expired / signed_out / signing_in /
 *                     unsupported, or last task blocked_auth (auth_required / sign_in_in_progress /
 *                     account_unsupported), with the runtime `running`. Tooltip by cause; for an
 *                     unsupported account: "this ChatGPT account can't run Codex" (menu offers Sign out
 *                     / Switch account, never Reconnect). Wake keeps running (spec §5); dispatch
 *                     blocked. Auth `unknown` / `unavailable` alone NEVER produce Auth required.
 *  9. STANDBY       — everything else (STANDBY, BOOTING, RECOVERING, ERROR, SHUTDOWN), with the
 *                     detail in the tooltip.
 *
 * `recovering` (TaskProgress RECOVERING during a Codex retry burst) is tooltip detail only: the
 * Executing tooltip reads "Reconnecting…"; it never changes the state, wake or dispatch.
 *
 * `failedAfterChanges` (TaskFinished failed_after_side_effects, any reason) is tooltip detail only:
 * never Auth required, never Standby on its own, never the persistent `blocked` reason.
 *
 * New tasks may be dispatched only when the runtime is `running` (plus the existing conditions).
 */
import type { RuntimeStatus } from '../../shared/runtime';
import { LAST_TASK_NOTE_TOOLTIP, REASON_DETAIL } from './taskOutcomeCopy';
import {
  TRAY_STATE_LABEL,
  type CoordinatorState,
  type DesktopSnapshot,
  type TrayState,
  type TrayView,
} from '../../shared/states';

export const TASK_ACTIVE_STATES: ReadonlySet<CoordinatorState> = new Set<CoordinatorState>([
  'CONFIRMING',
  'EXECUTING',
  'VERIFYING',
  'PERMISSION_REQUIRED',
  'CANCELLING',
  'SPEAKING',
]);

export const CAPTURE_STATES: ReadonlySet<CoordinatorState> = new Set<CoordinatorState>([
  'WAKE_DETECTED',
  'LISTENING',
  'TRANSCRIBING',
]);

const STANDBY_DETAIL: Partial<Record<CoordinatorState, string>> = {
  BOOTING: 'starting up',
  RECOVERING: 'recovering',
  ERROR: 'error — see activity',
  SHUTDOWN: 'shutting down',
};

export function isTaskActive(s: DesktopSnapshot): boolean {
  return s.taskActive || TASK_ACTIVE_STATES.has(s.coordinator);
}

export function isMicSuppressed(s: DesktopSnapshot): boolean {
  return s.muted || s.paused || s.coordinator === 'MUTED';
}

/** Auth states that mean "the user must sign in". `unknown`/`unavailable` are deliberately absent. */
const SIGN_IN_NEEDED: ReadonlySet<DesktopSnapshot['auth']> = new Set<DesktopSnapshot['auth']>(['expired', 'signed_out']);

/** Account signed in but not allowed to run Codex (AuthState unsupported / reason account_unsupported). */
export function isAccountUnsupported(s: DesktopSnapshot): boolean {
  return s.auth === 'unsupported' || s.blocked === 'account_unsupported';
}

/** A sign-in is already in progress (AuthState signing_in / reason sign_in_in_progress). */
export function isSignInInProgress(s: DesktopSnapshot): boolean {
  return s.auth === 'signing_in' || s.blocked === 'sign_in_in_progress';
}

/** Last task finished blocked_unavailable (reason codex_unavailable). Never a sign-in prompt. */
export function isCodexUnavailable(s: DesktopSnapshot): boolean {
  return s.blocked === 'codex_unavailable';
}

function isAuthBlocked(s: DesktopSnapshot): boolean {
  return (
    s.coordinator === 'AUTH_REQUIRED' ||
    SIGN_IN_NEEDED.has(s.auth) ||
    s.blocked === 'auth_required' ||
    isSignInInProgress(s) ||
    isAccountUnsupported(s)
  );
}

/** Runtime supervisor is waiting for its environment (ADR-0013). */
export function isRuntimeWaitingForEnv(s: DesktopSnapshot): boolean {
  return s.runtime === 'waiting_for_env';
}

/** Runtime statuses shown as Standby with a "Starting…"/"Reconnecting…" tooltip (CONTRACTS §2.4). */
const RUNTIME_STANDBY_DETAIL: Partial<Record<RuntimeStatus, string>> = {
  unknown: 'Starting…',
  starting: 'Starting…',
  backoff: 'Reconnecting…',
  half_open: 'Reconnecting…',
};

/** Reason detail for a `failed_after_side_effects` task (activity + tooltip text). */
export const FAILED_AFTER_CHANGES_DETAIL = REASON_DETAIL;

export function isRuntimeBreakerOpen(s: DesktopSnapshot): boolean {
  return s.runtime === 'breaker_open';
}

export function deriveTrayState(s: DesktopSnapshot): TrayState {
  if (isTaskActive(s)) return 'executing';
  if (isMicSuppressed(s)) return 'muted';
  if (CAPTURE_STATES.has(s.coordinator)) return 'listening';
  if (s.network === 'offline' || s.runtime === 'stopped') return 'offline';
  if (isRuntimeBreakerOpen(s)) return 'error';
  if (isRuntimeWaitingForEnv(s) || isCodexUnavailable(s)) return 'standby';
  if (RUNTIME_STANDBY_DETAIL[s.runtime] !== undefined) return 'standby';
  if (isAuthBlocked(s)) return 'auth_required';
  return 'standby';
}

function tooltipFor(state: TrayState, s: DesktopSnapshot): string {
  const parts: string[] = [`Dottie — ${TRAY_STATE_LABEL[state]}`];
  switch (state) {
    case 'executing':
      parts.push(
        s.coordinator === 'CANCELLING'
          ? 'stopping task'
          : s.coordinator === 'SPEAKING'
            ? 'speaking result'
            : // Codex retry burst (TaskProgress RECOVERING): detail text only, the state stays Executing.
              s.recovering
              ? 'Reconnecting…'
              : 'task running',
      );
      if (isMicSuppressed(s)) parts.push(s.paused ? 'paused' : 'mic muted');
      break;
    case 'muted':
      parts.push(s.paused ? 'paused, mic off' : 'mic off');
      break;
    case 'listening':
      parts.push(s.coordinator === 'TRANSCRIBING' ? 'transcribing' : 'mic on, capturing command');
      break;
    case 'error':
      parts.push('Codex stopped after repeated failures; choose Retry');
      break;
    case 'offline':
      if (s.network === 'offline') {
        parts.push('wake word still works; tasks wait for network');
        if (isRuntimeBreakerOpen(s)) parts.push('Codex stopped after repeated failures');
        else if (isRuntimeWaitingForEnv(s)) parts.push('Codex waiting for environment');
        else if (isCodexUnavailable(s)) parts.push('Codex unavailable');
      } else {
        parts.push('Codex runtime stopped');
      }
      break;
    case 'auth_required':
      if (isAccountUnsupported(s)) parts.push("this ChatGPT account can't run Codex; sign out or switch account");
      else if (isSignInInProgress(s)) parts.push('finish signing in in your browser');
      else parts.push('wake word still works; reconnect ChatGPT to run tasks');
      break;
    case 'standby': {
      if (s.coordinator === 'SHUTDOWN') {
        parts.push('shutting down');
        break;
      }
      if (isRuntimeWaitingForEnv(s)) {
        parts.push('Codex unavailable, waiting for environment; wake word still works');
        break;
      }
      if (isCodexUnavailable(s)) {
        parts.push('Codex unavailable; wake word still works');
        break;
      }
      const runtimeDetail = RUNTIME_STANDBY_DETAIL[s.runtime];
      if (runtimeDetail !== undefined) {
        parts.push(runtimeDetail);
        break;
      }
      const detail = STANDBY_DETAIL[s.coordinator];
      parts.push(detail ?? 'say "Dottie"');
      break;
    }
  }
  // Last task failed after making changes (detail only; never changes the state). Not shown while a
  // new task runs (it is cleared then anyway).
  if (state !== 'executing' && s.failedAfterChanges !== 'none') {
    const f = s.failedAfterChanges;
    parts.push(f === 'unspecified' ? 'last task failed after making changes' : `last task failed after making changes (${FAILED_AFTER_CHANGES_DETAIL[f]})`);
  }
  if (state !== 'executing' && s.lastTaskNote !== 'none') parts.push(LAST_TASK_NOTE_TOOLTIP[s.lastTaskNote]);
  // Windows tray tooltips are truncated at 127 chars.
  return parts.join(' · ').slice(0, 127);
}

export function deriveTrayView(s: DesktopSnapshot): TrayView {
  const state = deriveTrayState(s);
  const suppressed = isMicSuppressed(s);
  const shuttingDown = s.coordinator === 'SHUTDOWN';
  return {
    state,
    label: TRAY_STATE_LABEL[state],
    tooltip: tooltipFor(state, s),
    // Local wake keeps working while offline / auth required; never while muted/paused.
    wakeAvailable: !suppressed && !shuttingDown && s.coordinator !== 'BOOTING',
    canDispatch:
      !suppressed &&
      !shuttingDown &&
      !isTaskActive(s) &&
      s.network !== 'offline' &&
      s.auth === 'signed_in' &&
      s.coordinator !== 'AUTH_REQUIRED' &&
      s.blocked === 'none' &&
      // Only a running Codex runtime accepts tasks (CONTRACTS §2.4).
      s.runtime === 'running',
    inconsistent: (suppressed && CAPTURE_STATES.has(s.coordinator)) || (s.muted && s.coordinator === 'LISTENING'),
    snapshot: s,
  };
}

/** Icon file stem per tray state (assets/icons/tray-<stem>.png|.ico). */
export const TRAY_ICON_STEM: Readonly<Record<TrayState, string>> = {
  standby: 'standby',
  listening: 'listening',
  executing: 'executing',
  auth_required: 'auth-required',
  muted: 'muted',
  offline: 'offline',
  error: 'error',
};
