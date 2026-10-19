/** Pure tray-menu model: which items exist, their labels and enablement for a given view. */
import type { CoordinatorState, MenuItemView, TrayView } from '../../shared/states';
import { isAccountUnsupported, isRuntimeBreakerOpen, isRuntimeWaitingForEnv, isTaskActive } from './trayModel';

/**
 * States where "Stop task" (cancel the underlying Codex task) is meaningful. SPEAKING is excluded:
 * stopping speech is a different command (spec §4 speaking policy) owned by the voice pipeline,
 * and a stopped voice response must never be reported as a stopped task.
 */
const STOPPABLE: ReadonlySet<CoordinatorState> = new Set<CoordinatorState>(['CONFIRMING', 'EXECUTING', 'VERIFYING', 'PERMISSION_REQUIRED']);

export function deriveMenu(view: TrayView): MenuItemView[] {
  const s = view.snapshot;
  const shuttingDown = s.coordinator === 'SHUTDOWN';
  const taskActive = isTaskActive(s);
  const stoppable = (s.taskActive || STOPPABLE.has(s.coordinator)) && s.coordinator !== 'CANCELLING';
  // An unsupported account is not fixed by reconnecting: offer Sign out / Switch account instead and
  // never a Reconnect loop (CONTRACTS §2.1, E01 2026-10-19).
  const unsupported = isAccountUnsupported(s);
  const reconnectNeeded =
    !unsupported &&
    (view.state === 'auth_required' ||
      view.state === 'offline' ||
      s.auth === 'expired' ||
      s.auth === 'signed_out' ||
      s.coordinator === 'AUTH_REQUIRED' ||
      s.network === 'offline' ||
      s.blocked !== 'none' ||
      // Reconnect = re-probe the runtime (no sign-in prompt) while it waits for its environment.
      isRuntimeWaitingForEnv(s));
  // Retry Codex only while the breaker is open AND the network is not down (Offline beats Error,
  // CONTRACTS §2.4): retrying offline would just trip the breaker again.
  const retryable = isRuntimeBreakerOpen(s) && s.network !== 'offline';

  return [
    // Wake test needs an open mic and no task in flight.
    { id: 'wake_test', label: 'Wake test', enabled: view.wakeAvailable && !taskActive && !shuttingDown, visible: true },
    { id: 'toggle_mute', label: s.muted ? 'Unmute' : 'Mute', enabled: !shuttingDown, visible: true },
    { id: 'toggle_pause', label: s.paused ? 'Resume' : 'Pause', enabled: !shuttingDown, visible: true },
    { id: 'settings', label: 'Settings…', enabled: true, visible: true },
    { id: 'show_activity', label: 'Show activity', enabled: true, visible: true },
    { id: 'reconnect', label: 'Reconnect', enabled: reconnectNeeded && !shuttingDown, visible: !unsupported },
    // Retry: ask the supervisor to restart the Codex runtime after its breaker opened (ADR-0013 item 3).
    { id: 'retry', label: 'Retry Codex', enabled: retryable && !shuttingDown, visible: retryable },
    // Retry last task (CONTRACTS §5 D14 L468 @ 0d53abc, E01 ruling 1m): always visible; enabled
    // from the retryable outcomes only (failed, failed_after_side_effects, unverified, partial,
    // blocked_unavailable; main sets retryTaskAvailable). It ignores the readiness block that
    // blocked_unavailable sets (s.blocked; the coordinator re-checks Codex), and nothing else
    // from canDispatch is consulted; it stays disabled while a task is active (ADR-0010) or while
    // auth isn't signed_in. Main emits UtteranceReady{retryOfTaskId, endReason:'tray'}.
    {
      id: 'retry_task',
      label: 'Retry last task',
      enabled: s.retryTaskAvailable && !taskActive && !s.taskActive && s.auth === 'signed_in' && !shuttingDown,
      visible: true,
    },
    // Unsupported account: both go through the auth adapter; the renderer never handles credentials.
    { id: 'sign_out', label: 'Sign out', enabled: unsupported && !shuttingDown, visible: unsupported },
    { id: 'switch_account', label: 'Switch account…', enabled: unsupported && !shuttingDown, visible: unsupported },
    // Stop task only while a task is active and not already cancelling.
    { id: 'stop_task', label: 'Stop task', enabled: stoppable && !shuttingDown, visible: true },
    { id: 'quit', label: 'Quit Dottie', enabled: true, visible: true },
  ];
}

export function isMenuItemEnabled(view: TrayView, id: MenuItemView['id']): boolean {
  return deriveMenu(view).find((m) => m.id === id)?.enabled ?? false;
}
