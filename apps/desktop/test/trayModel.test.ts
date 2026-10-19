import { describe, expect, it } from 'vitest';
import { deriveTrayState, deriveTrayView } from '../src/main/state/trayModel';
import { deriveMenu } from '../src/main/state/menuModel';
import { SHARED_TASK_REASONS } from '../src/shared/contracts.draft';
import { RUNTIME_STATUSES, type RuntimeStatus } from '../src/shared/runtime';
import {
  AuthStatusSchema,
  COORDINATOR_STATES,
  FailedAfterChangesSchema,
  LastTaskNoteSchema,
  TaskBlockSchema,
  TRAY_STATES,
  type AuthStatus,
  type DesktopSnapshot,
  type NetworkStatus,
  type TaskBlock,
} from '../src/shared/states';
import { snap } from './helpers';

describe('deriveTrayState — direct mapping of coordinator states', () => {
  it.each([
    ['BOOTING', 'standby'],
    ['STANDBY', 'standby'],
    ['WAKE_DETECTED', 'listening'],
    ['LISTENING', 'listening'],
    ['TRANSCRIBING', 'listening'],
    ['CONFIRMING', 'executing'],
    ['EXECUTING', 'executing'],
    ['VERIFYING', 'executing'],
    ['SPEAKING', 'executing'],
    ['PERMISSION_REQUIRED', 'executing'],
    ['CANCELLING', 'executing'],
    ['MUTED', 'muted'],
    ['AUTH_REQUIRED', 'auth_required'],
    ['RECOVERING', 'standby'],
    ['ERROR', 'standby'],
    ['SHUTDOWN', 'standby'],
  ] as const)('%s -> %s', (coordinator, expected) => {
    expect(deriveTrayState(snap({ coordinator }))).toBe(expected);
  });
});

describe('deriveTrayState — precedence', () => {
  it('muted overrides listening (and flags the inconsistency)', () => {
    const v = deriveTrayView(snap({ coordinator: 'LISTENING', muted: true }));
    expect(v.state).toBe('muted');
    expect(v.inconsistent).toBe(true);
    expect(v.wakeAvailable).toBe(false);
  });
  it('pause renders as muted', () => {
    const v = deriveTrayView(snap({ paused: true }));
    expect(v.state).toBe('muted');
    expect(v.tooltip).toContain('paused');
  });
  it('an active task is never hidden by mute', () => {
    const v = deriveTrayView(snap({ coordinator: 'EXECUTING', taskActive: true, muted: true }));
    expect(v.state).toBe('executing');
    expect(v.tooltip).toContain('mic muted');
  });
  it('taskActive alone means executing', () => {
    expect(deriveTrayState(snap({ taskActive: true }))).toBe('executing');
  });
  it('muted overrides offline and auth required', () => {
    expect(deriveTrayState(snap({ muted: true, network: 'offline', auth: 'expired' }))).toBe('muted');
  });
  it('offline wins over auth required', () => {
    expect(deriveTrayState(snap({ network: 'offline', auth: 'expired' }))).toBe('offline');
  });
  it('listening wins over offline/auth (local capture is happening)', () => {
    expect(deriveTrayState(snap({ coordinator: 'LISTENING', network: 'offline', auth: 'expired' }))).toBe('listening');
  });
  it.each<AuthStatus>(['expired', 'signed_out'])('auth %s -> auth_required', (auth) => {
    expect(deriveTrayState(snap({ auth }))).toBe('auth_required');
  });
  it.each<AuthStatus>(['unknown', 'unavailable', 'signed_in'])('auth %s alone does not show auth_required', (auth) => {
    expect(deriveTrayState(snap({ auth }))).toBe('standby');
  });
});

describe('deriveTrayState — runtime waiting_for_env (ADR-0013; not a coordinator state)', () => {
  it('shows Standby with an honest tooltip and no sign-in prompt', () => {
    const v = deriveTrayView(snap({ runtime: 'waiting_for_env' }));
    expect(v.state).toBe('standby');
    expect(v.tooltip).toContain('waiting for environment');
    expect(v.tooltip).not.toMatch(/sign|reconnect chatgpt/i);
    expect(v.wakeAvailable).toBe(true);
    expect(v.canDispatch).toBe(false);
  });
  it('shows Offline when the network is down', () => {
    const v = deriveTrayView(snap({ runtime: 'waiting_for_env', network: 'offline' }));
    expect(v.state).toBe('offline');
    expect(v.tooltip).toContain('Codex waiting for environment');
  });
  it.each<AuthStatus>(['expired', 'signed_out', 'unknown', 'unavailable'])('beats auth %s (no Auth required)', (auth) => {
    expect(deriveTrayState(snap({ runtime: 'waiting_for_env', auth }))).toBe('standby');
  });
  it('beats a coordinator AUTH_REQUIRED report', () => {
    expect(deriveTrayState(snap({ runtime: 'waiting_for_env', coordinator: 'AUTH_REQUIRED' }))).toBe('standby');
  });
  it('mute still wins', () => {
    expect(deriveTrayState(snap({ runtime: 'waiting_for_env', muted: true }))).toBe('muted');
  });
  it('an active task still shows Executing', () => {
    expect(deriveTrayState(snap({ runtime: 'waiting_for_env', coordinator: 'EXECUTING', taskActive: true }))).toBe('executing');
    expect(deriveTrayState(snap({ runtime: 'waiting_for_env', coordinator: 'EXECUTING', taskActive: true, muted: true }))).toBe('executing');
  });
  it('listening (local capture) still shows Listening', () => {
    expect(deriveTrayState(snap({ runtime: 'waiting_for_env', coordinator: 'LISTENING' }))).toBe('listening');
  });
  it('SPEAKING tooltip is unchanged', () => {
    expect(deriveTrayView(snap({ coordinator: 'SPEAKING' })).tooltip).toBe('Dottie — Executing · speaking result');
    expect(deriveTrayView(snap({ coordinator: 'SPEAKING', runtime: 'waiting_for_env' })).tooltip).toBe('Dottie — Executing · speaking result');
  });
});

describe('deriveTrayView — TaskProgress RECOVERING (Codex retry burst, CONTRACTS §2.1)', () => {
  it.each([
    [{ coordinator: 'EXECUTING', taskActive: true, recovering: true }, 'executing', 'Dottie — Executing · Reconnecting…'],
    [{ coordinator: 'EXECUTING', taskActive: true, recovering: false }, 'executing', 'Dottie — Executing · task running'],
    [{ coordinator: 'EXECUTING', taskActive: true, recovering: true, muted: true }, 'executing', 'Dottie — Executing · Reconnecting… · mic muted'],
    [{ coordinator: 'VERIFYING', taskActive: true, recovering: true, network: 'offline' }, 'executing', 'Dottie — Executing · Reconnecting…'],
    [{ coordinator: 'EXECUTING', taskActive: true, recovering: true, runtime: 'breaker_open' }, 'executing', 'Dottie — Executing · Reconnecting…'],
    [{ coordinator: 'SPEAKING', recovering: true }, 'executing', 'Dottie — Executing · speaking result'],
    [{ coordinator: 'CANCELLING', taskActive: true, recovering: true }, 'executing', 'Dottie — Executing · stopping task'],
    [{ coordinator: 'STANDBY', recovering: true }, 'standby', 'Dottie — Standby · say "Dottie"'],
  ] as [Partial<DesktopSnapshot>, string, string][])('%j -> %s, tooltip %s', (p, state, tooltip) => {
    const v = deriveTrayView(snap(p));
    expect(v.state).toBe(state);
    expect(v.tooltip).toBe(tooltip);
  });
});

describe('deriveTrayView — TaskFinished failed_after_side_effects (CONTRACTS §2.1 mid-run / after-commit)', () => {
  it.each([
    ['unspecified', 'Dottie — Standby · say "Dottie" · last task failed after making changes'],
    ['auth_required', 'Dottie — Standby · say "Dottie" · last task failed after making changes (ChatGPT sign-in expired)'],
    ['sign_in_in_progress', 'Dottie — Standby · say "Dottie" · last task failed after making changes (sign-in was in progress)'],
    ['account_unsupported', 'Dottie — Standby · say "Dottie" · last task failed after making changes (this ChatGPT account can\'t run Codex)'],
    ['codex_unavailable', 'Dottie — Standby · say "Dottie" · last task failed after making changes (Codex became unavailable)'],
    ['clarification_timeout', 'Dottie — Standby · say "Dottie" · last task failed after making changes (no answer to a question)'],
    ['clarification_cancelled', 'Dottie — Standby · say "Dottie" · last task failed after making changes (question cancelled)'],
    ['approval_unavailable', 'Dottie — Standby · say "Dottie" · last task failed after making changes (couldn\'t ask for approval safely)'],
  ] as [DesktopSnapshot['failedAfterChanges'], string][])('%s: stays Standby (signed in, runtime running), tooltip detail, dispatch allowed', (failedAfterChanges, tooltip) => {
    const v = deriveTrayView(snap({ failedAfterChanges }));
    expect(v.state).toBe('standby');
    expect(v.tooltip).toBe(tooltip);
    expect(v.canDispatch).toBe(true);
    expect(deriveMenu(v).find((m) => m.id === 'reconnect')?.enabled).toBe(false);
    expect(deriveMenu(v).find((m) => m.id === 'sign_out')?.visible).toBe(false);
  });
  it('does not put the tray in Standby on its own: other states keep winning', () => {
    expect(deriveTrayState(snap({ failedAfterChanges: 'auth_required', network: 'offline' }))).toBe('offline');
    expect(deriveTrayState(snap({ failedAfterChanges: 'codex_unavailable', runtime: 'breaker_open' }))).toBe('error');
    expect(deriveTrayState(snap({ failedAfterChanges: 'auth_required', muted: true }))).toBe('muted');
    expect(deriveTrayState(snap({ failedAfterChanges: 'auth_required', auth: 'expired' }))).toBe('auth_required'); // from auth, not from the event
    expect(deriveTrayView(snap({ failedAfterChanges: 'auth_required', coordinator: 'EXECUTING', taskActive: true })).tooltip).toBe('Dottie — Executing · task running');
  });
});

describe('deriveTrayView — wake & dispatch availability', () => {
  it('auth required still allows standby wake but blocks dispatch', () => {
    const v = deriveTrayView(snap({ auth: 'expired' }));
    expect(v.wakeAvailable).toBe(true);
    expect(v.canDispatch).toBe(false);
  });
  it('offline still allows wake but blocks dispatch', () => {
    const v = deriveTrayView(snap({ network: 'offline' }));
    expect(v.wakeAvailable).toBe(true);
    expect(v.canDispatch).toBe(false);
  });
  it('standby + signed in + online can dispatch', () => {
    expect(deriveTrayView(snap()).canDispatch).toBe(true);
  });
  it('booting and shutdown disable wake', () => {
    expect(deriveTrayView(snap({ coordinator: 'BOOTING' })).wakeAvailable).toBe(false);
    expect(deriveTrayView(snap({ coordinator: 'SHUTDOWN' })).wakeAvailable).toBe(false);
  });
});

// 215k snapshots per sweep: allow more than vitest's 5 s default so slow CI boxes don't flake.
describe('deriveTrayView — exhaustive invariants', { timeout: 60_000 }, () => {
  const all: DesktopSnapshot[] = [];
  const auths: AuthStatus[] = [...AuthStatusSchema.options];
  const blocks: TaskBlock[] = [...TaskBlockSchema.options];
  const nets: NetworkStatus[] = ['online', 'offline', 'unknown'];
  for (const coordinator of COORDINATOR_STATES)
    for (const muted of [false, true])
      for (const paused of [false, true])
        for (const auth of auths)
          for (const network of nets)
            for (const taskActive of [false, true])
              for (const runtime of RUNTIME_STATUSES)
                for (const blocked of blocks)
                  for (const recovering of [false, true]) all.push({ coordinator, muted, paused, auth, network, taskActive, runtime, blocked, recovering, failedAfterChanges: 'none', lastTaskNote: 'none', retryTaskAvailable: false });

  it(`covers ${String(16 * 2 * 2 * 7 * 3 * 2 * 8 * 5 * 2)} combinations (coordinator × mute × pause × auth × network × task × runtime × TaskFinished block × RECOVERING progress)`, () => {
    expect(RUNTIME_STATUSES.length).toBe(8);
    expect(auths.length).toBe(7);
    expect(blocks).toEqual(['none', 'auth_required', 'sign_in_in_progress', 'account_unsupported', 'codex_unavailable']);
    expect(all.length).toBe(16 * 2 * 2 * 7 * 3 * 2 * 8 * 5 * 2);
  });

  it('always yields one of the seven tray states with a bounded tooltip', () => {
    for (const s of all) {
      const v = deriveTrayView(s);
      expect(TRAY_STATES).toContain(v.state);
      expect(v.tooltip.length).toBeLessThanOrEqual(127);
      expect(v.tooltip.startsWith('Dottie — ')).toBe(true);
    }
  });

  it('never shows listening, and never allows wake or dispatch, while muted or paused', () => {
    for (const s of all.filter((x) => x.muted || x.paused)) {
      const v = deriveTrayView(s);
      expect(v.state).not.toBe('listening');
      expect(v.wakeAvailable).toBe(false);
      expect(v.canDispatch).toBe(false);
    }
  });

  it('never allows dispatch unless signed in, online and the runtime is running', () => {
    for (const s of all) {
      if (deriveTrayView(s).canDispatch) {
        expect(s.auth).toBe('signed_in');
        expect(s.network).not.toBe('offline');
        expect(s.runtime).toBe('running');
      }
    }
  });

  it('auth unknown/unavailable never produces Auth required (any runtime status) without an auth block', () => {
    for (const s of all.filter((x) => (x.auth === 'unknown' || x.auth === 'unavailable') && x.coordinator !== 'AUTH_REQUIRED' && (x.blocked === 'none' || x.blocked === 'codex_unavailable'))) {
      expect(deriveTrayState(s)).not.toBe('auth_required');
    }
  });

  it('runtime waiting_for_env never produces Auth required, never dispatches, keeps Reconnect enabled', () => {
    for (const s of all.filter((x) => x.runtime === 'waiting_for_env')) {
      const v = deriveTrayView(s);
      expect(v.state).not.toBe('auth_required');
      expect(v.canDispatch).toBe(false);
      const unsupported = s.auth === 'unsupported' || s.blocked === 'account_unsupported';
      if (s.coordinator !== 'SHUTDOWN' && !unsupported) expect(deriveMenu(v).find((m) => m.id === 'reconnect')?.enabled).toBe(true);
    }
  });

  it('runtime waiting_for_env (no task, not muted, not capturing): Standby, or Offline when network is down', () => {
    const quiet = all.filter(
      (x) =>
        x.runtime === 'waiting_for_env' &&
        !x.taskActive &&
        !x.muted &&
        !x.paused &&
        !['CONFIRMING', 'EXECUTING', 'VERIFYING', 'PERMISSION_REQUIRED', 'CANCELLING', 'SPEAKING', 'MUTED', 'WAKE_DETECTED', 'LISTENING', 'TRANSCRIBING'].includes(x.coordinator),
    );
    expect(quiet.length).toBeGreaterThan(0);
    for (const s of quiet) expect(deriveTrayState(s)).toBe(s.network === 'offline' ? 'offline' : 'standby');
  });

  const TASK_OR_CAPTURE = ['CONFIRMING', 'EXECUTING', 'VERIFYING', 'PERMISSION_REQUIRED', 'CANCELLING', 'SPEAKING', 'MUTED', 'WAKE_DETECTED', 'LISTENING', 'TRANSCRIBING'];
  const isQuiet = (x: DesktopSnapshot) => !x.taskActive && !x.muted && !x.paused && !TASK_OR_CAPTURE.includes(x.coordinator);

  const quietOf = (runtime: RuntimeStatus) =>
    all.filter((x) => x.runtime === runtime && x.blocked === 'none' && !x.taskActive && !x.muted && !x.paused && !TASK_OR_CAPTURE.includes(x.coordinator));

  it('runtime status never overrides an active task, mute or local capture (existing precedence)', () => {
    for (const s of all) {
      const base = deriveTrayState({ ...s, runtime: 'running' });
      if (base === 'executing' || base === 'muted' || base === 'listening') expect(deriveTrayState(s)).toBe(base);
    }
  });

  it('only a running runtime allows dispatch', () => {
    for (const s of all) if (deriveTrayView(s).canDispatch) expect(s.runtime).toBe('running');
    // ...and running alone does not change anything relative to the pre-runtime model.
    expect(deriveTrayView(snap({ runtime: 'running' })).canDispatch).toBe(true);
  });

  // Table: runtime status -> tray state when nothing higher-precedence applies (CONTRACTS §2.4).
  const RUNTIME_TABLE: [RuntimeStatus, NetworkStatus, string, string][] = [
    ['unknown', 'online', 'standby', 'Starting…'],
    ['starting', 'online', 'standby', 'Starting…'],
    ['backoff', 'online', 'standby', 'Reconnecting…'],
    ['half_open', 'online', 'standby', 'Reconnecting…'],
    ['breaker_open', 'online', 'error', 'choose Retry'],
    ['breaker_open', 'offline', 'offline', 'Codex stopped after repeated failures'],
    ['breaker_open', 'unknown', 'error', 'choose Retry'],
    ['waiting_for_env', 'online', 'standby', 'waiting for environment'],
    ['waiting_for_env', 'offline', 'offline', 'waiting for environment'],
    ['stopped', 'online', 'offline', 'Codex runtime stopped'],
    ['stopped', 'offline', 'offline', 'tasks wait for network'],
    ['unknown', 'offline', 'offline', 'tasks wait for network'],
    ['backoff', 'offline', 'offline', 'tasks wait for network'],
  ];
  it.each(RUNTIME_TABLE)('runtime %s, network %s -> %s (tooltip mentions "%s"), for every quiet coordinator/auth combo', (runtime, network, state, tip) => {
    const rows = quietOf(runtime).filter((x) => x.network === network && x.coordinator !== 'SHUTDOWN');
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) {
      const v = deriveTrayView(s);
      expect(v.state).toBe(state);
      expect(v.tooltip).toContain(tip);
      expect(v.canDispatch).toBe(false);
    }
  });

  it('non-running runtime statuses never produce Auth required, even with expired auth or coordinator AUTH_REQUIRED', () => {
    for (const s of all.filter((x) => x.runtime !== 'running')) expect(deriveTrayState(s)).not.toBe('auth_required');
  });

  it('Error appears exactly for breaker_open while not offline, without a task, mute or capture', () => {
    for (const s of all) {
      const v = deriveTrayView(s);
      const quiet = !s.taskActive && !s.muted && !s.paused && !TASK_OR_CAPTURE.includes(s.coordinator);
      expect(v.state === 'error').toBe(s.runtime === 'breaker_open' && s.network !== 'offline' && quiet);
    }
  });

  it('Offline beats Error: breaker_open + network offline shows Offline (when quiet) and Retry Codex is hidden and disabled', () => {
    const rows = all.filter((x) => x.runtime === 'breaker_open' && x.network === 'offline');
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) {
      const v = deriveTrayView(s);
      expect(v.state).not.toBe('error');
      if (isQuiet(s)) expect(v.state).toBe('offline');
      expect(deriveMenu(v).find((m) => m.id === 'retry')).toMatchObject({ enabled: false, visible: false });
    }
  });

  it('Retry Codex is enabled (and visible) exactly for breaker_open, not offline, not shutting down', () => {
    for (const s of all) {
      const item = deriveMenu(deriveTrayView(s)).find((m) => m.id === 'retry');
      expect(item?.enabled).toBe(s.runtime === 'breaker_open' && s.network !== 'offline' && s.coordinator !== 'SHUTDOWN');
      expect(item?.visible).toBe(s.runtime === 'breaker_open' && s.network !== 'offline');
    }
  });

  it('precedence order matches CONTRACTS §2.4 (one representative row per rung)', () => {
    const rung = (p: Partial<DesktopSnapshot>) => deriveTrayView(snap(p));
    // Each row satisfies every lower rung too, so the first match must win.
    const all8 = { runtime: 'breaker_open' as const, network: 'offline' as const, auth: 'expired' as const };
    expect(rung({ ...all8, coordinator: 'EXECUTING', taskActive: true, muted: true }).state).toBe('executing');
    expect(rung({ ...all8, coordinator: 'LISTENING', muted: true }).state).toBe('muted');
    expect(rung({ ...all8, coordinator: 'LISTENING' }).state).toBe('listening');
    expect(rung(all8).state).toBe('offline');
    expect(rung({ ...all8, network: 'online', blocked: 'codex_unavailable' }).state).toBe('error');
    expect(rung({ runtime: 'waiting_for_env', auth: 'expired', blocked: 'codex_unavailable' }).tooltip).toContain('waiting for environment');
    expect(rung({ runtime: 'starting', auth: 'expired', blocked: 'codex_unavailable' }).tooltip).toContain('Codex unavailable');
    expect(rung({ runtime: 'backoff', auth: 'expired' }).tooltip).toBe('Dottie — Standby · Reconnecting…');
    expect(rung({ auth: 'expired' }).state).toBe('auth_required');
    expect(rung({}).state).toBe('standby');
  });

  it('breaker_open under mute / active task keeps Muted / Executing (Retry still offered when online)', () => {
    expect(deriveTrayState(snap({ runtime: 'breaker_open', muted: true }))).toBe('muted');
    expect(deriveTrayState(snap({ runtime: 'breaker_open', coordinator: 'EXECUTING', taskActive: true, muted: true }))).toBe('executing');
    expect(deriveTrayView(snap({ runtime: 'breaker_open', coordinator: 'SPEAKING' })).tooltip).toBe('Dottie — Executing · speaking result');
  });

  it('wake availability is independent of the runtime status (local wake keeps working)', () => {
    for (const s of all) expect(deriveTrayView(s).wakeAvailable).toBe(deriveTrayView({ ...s, runtime: 'running' }).wakeAvailable);
  });

  it('blocked_unavailable (codex_unavailable) is mapped like waiting_for_env: Standby, or Offline when the network is down', () => {
    const rows = all.filter((x) => x.blocked === 'codex_unavailable' && isQuiet(x) && x.runtime !== 'breaker_open' && x.runtime !== 'stopped');
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) {
      const v = deriveTrayView(s);
      expect(v.state).toBe(s.network === 'offline' ? 'offline' : 'standby');
      expect(v.canDispatch).toBe(false);
    }
  });

  it('blocked_unavailable never produces Auth required, never dispatches, and keeps Reconnect (re-probe) enabled', () => {
    for (const s of all.filter((x) => x.blocked === 'codex_unavailable')) {
      const v = deriveTrayView(s);
      expect(v.state).not.toBe('auth_required');
      expect(v.canDispatch).toBe(false);
      if (s.coordinator !== 'SHUTDOWN' && s.auth !== 'unsupported') expect(deriveMenu(v).find((m) => m.id === 'reconnect')?.enabled).toBe(true);
    }
  });

  it('blocked_auth reasons show Auth required when nothing higher applies (runtime running, online)', () => {
    const rows = all.filter(
      (x) => ['auth_required', 'sign_in_in_progress', 'account_unsupported'].includes(x.blocked) && isQuiet(x) && x.runtime === 'running' && x.network !== 'offline',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) {
      const v = deriveTrayView(s);
      expect(v.state).toBe('auth_required');
      expect(v.canDispatch).toBe(false);
      if (s.blocked === 'account_unsupported' || s.auth === 'unsupported') expect(v.tooltip).toContain("this ChatGPT account can't run Codex");
      else if (s.blocked === 'sign_in_in_progress' || s.auth === 'signing_in') expect(v.tooltip).toContain('finish signing in');
    }
  });

  it('account unsupported: Sign out / Switch account offered (and visible) exactly then, Reconnect never', () => {
    for (const s of all) {
      const menu = deriveMenu(deriveTrayView(s));
      const item = (id: string) => menu.find((m) => m.id === id);
      const unsupported = s.auth === 'unsupported' || s.blocked === 'account_unsupported';
      const live = unsupported && s.coordinator !== 'SHUTDOWN';
      expect(item('sign_out')?.enabled).toBe(live);
      expect(item('switch_account')?.enabled).toBe(live);
      expect(item('sign_out')?.visible).toBe(unsupported);
      expect(item('switch_account')?.visible).toBe(unsupported);
      if (unsupported) {
        expect(item('reconnect')?.enabled).toBe(false);
        expect(item('reconnect')?.visible).toBe(false);
      }
    }
  });

  it('auth signing_in / unsupported (AuthState) map like their blocked_auth reasons', () => {
    for (const s of all.filter((x) => x.blocked === 'none' && (x.auth === 'signing_in' || x.auth === 'unsupported'))) {
      const reason = s.auth === 'signing_in' ? 'sign_in_in_progress' : 'account_unsupported';
      const a = deriveTrayView(s);
      const b = deriveTrayView({ ...s, auth: 'signed_in', blocked: reason });
      expect(a.state).toBe(b.state);
      expect(a.tooltip).toBe(b.tooltip);
      expect(a.canDispatch).toBe(false);
    }
  });

  it('any TaskFinished block prevents dispatch', () => {
    for (const s of all.filter((x) => x.blocked !== 'none')) expect(deriveTrayView(s).canDispatch).toBe(false);
  });

  it('RECOVERING progress never changes the tray state, wake, dispatch or menu — tooltip detail only', () => {
    for (const s of all.filter((x) => x.recovering)) {
      const a = deriveTrayView(s);
      const b = deriveTrayView({ ...s, recovering: false });
      expect(a.state).toBe(b.state);
      expect(a.wakeAvailable).toBe(b.wakeAvailable);
      expect(a.canDispatch).toBe(b.canDispatch);
      expect(a.inconsistent).toBe(b.inconsistent);
      expect(deriveMenu(a).map((m) => [m.id, m.enabled, m.visible])).toEqual(deriveMenu(b).map((m) => [m.id, m.enabled, m.visible]));
      if (a.state !== 'executing') expect(a.tooltip).toBe(b.tooltip); // detail only shows for a running task
    }
  });

  it('a running task in a retry burst stays Executing with "Reconnecting…" (SPEAKING / CANCELLING text unchanged)', () => {
    for (const s of all.filter((x) => x.recovering && (x.taskActive || ['CONFIRMING', 'EXECUTING', 'VERIFYING', 'PERMISSION_REQUIRED'].includes(x.coordinator)))) {
      const v = deriveTrayView(s);
      expect(v.state).toBe('executing');
      if (s.coordinator === 'SPEAKING') expect(v.tooltip).toContain('speaking result');
      else if (s.coordinator === 'CANCELLING') expect(v.tooltip).toContain('stopping task');
      else expect(v.tooltip).toContain('Reconnecting…');
    }
  });

  it('lastTaskNote (declined+approval_unavailable, failed+clarification_*) never changes state, wake, dispatch or menu; tooltip never says "declined"', () => {
    const notes = LastTaskNoteSchema.options.filter((n) => n !== 'none');
    const mismatches: string[] = [];
    for (const s of all) {
      if (s.recovering) continue;
      const base = deriveTrayView(s);
      for (const lastTaskNote of notes) {
        const v = deriveTrayView({ ...s, lastTaskNote });
        if (v.state !== base.state || v.wakeAvailable !== base.wakeAvailable || v.canDispatch !== base.canDispatch) mismatches.push(`${JSON.stringify(s)} ${lastTaskNote}`);
        else if (/declined/i.test(v.tooltip) || v.tooltip.length > 127) mismatches.push(`tooltip ${v.tooltip}`);
        if (mismatches.length > 5) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('failed_after_side_effects (every reason) never changes state, wake, dispatch or menu, never Auth required — on every snapshot', () => {
    const values = FailedAfterChangesSchema.options.filter((f) => f !== 'none');
    expect(values).toEqual(['unspecified', ...SHARED_TASK_REASONS]);
    const mismatches: string[] = [];
    let checked = 0;
    for (const s of all) {
      const base = deriveTrayView(s);
      const baseMenu = JSON.stringify(deriveMenu(base).map((m) => [m.id, m.enabled, m.visible]));
      for (const failedAfterChanges of values) {
        const v = deriveTrayView({ ...s, failedAfterChanges });
        checked++;
        if (v.state !== base.state || v.wakeAvailable !== base.wakeAvailable || v.canDispatch !== base.canDispatch) mismatches.push(`${JSON.stringify(s)} ${failedAfterChanges}`);
        else if (v.state === 'auth_required' && base.state !== 'auth_required') mismatches.push(`auth ${failedAfterChanges}`);
        else if (v.tooltip.length > 127 || !v.tooltip.startsWith('Dottie — ')) mismatches.push(`tooltip ${v.tooltip}`);
        else if (JSON.stringify(deriveMenu(v).map((m) => [m.id, m.enabled, m.visible])) !== baseMenu) mismatches.push(`menu ${failedAfterChanges}`);
        if (mismatches.length > 5) break;
      }
    }
    expect(checked).toBe(all.length * values.length);
    expect(mismatches).toEqual([]);
  });

  it('is pure (same input, same output)', () => {
    for (const s of all.slice(0, 200)) expect(deriveTrayView(s)).toEqual(deriveTrayView({ ...s }));
  });
});
