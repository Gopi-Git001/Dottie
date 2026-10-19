import { describe, expect, it } from 'vitest';
import { deriveMenu, isMenuItemEnabled } from '../src/main/state/menuModel';
import { deriveTrayView } from '../src/main/state/trayModel';
import type { DesktopSnapshot, MenuItemId } from '../src/shared/states';
import { snap } from './helpers';

const menu = (p: Partial<DesktopSnapshot>) => deriveMenu(deriveTrayView(snap(p)));
const enabled = (p: Partial<DesktopSnapshot>, id: MenuItemId) => isMenuItemEnabled(deriveTrayView(snap(p)), id);

describe('tray menu', () => {
  it('has the eight spec §13.4 items in order, plus contextual Retry / Sign out / Switch account', () => {
    expect(menu({}).map((m) => m.id)).toEqual(['wake_test', 'toggle_mute', 'toggle_pause', 'settings', 'show_activity', 'reconnect', 'retry', 'retry_task', 'sign_out', 'switch_account', 'stop_task', 'quit']);
    expect(menu({}).filter((m) => m.visible).map((m) => m.id)).toEqual(['wake_test', 'toggle_mute', 'toggle_pause', 'settings', 'show_activity', 'reconnect', 'retry_task', 'stop_task', 'quit']);
  });

  it('Retry is shown and enabled only while the runtime breaker is open and the network is not down', () => {
    for (const runtime of ['unknown', 'starting', 'running', 'backoff', 'half_open', 'waiting_for_env', 'stopped'] as const) {
      expect(enabled({ runtime }, 'retry')).toBe(false);
      expect(menu({ runtime }).find((m) => m.id === 'retry')?.visible).toBe(false);
    }
    expect(enabled({ runtime: 'breaker_open' }, 'retry')).toBe(true);
    expect(enabled({ runtime: 'breaker_open', muted: true }, 'retry')).toBe(true);
    expect(enabled({ runtime: 'breaker_open', coordinator: 'EXECUTING', taskActive: true }, 'retry')).toBe(true);
    expect(enabled({ runtime: 'breaker_open', coordinator: 'SHUTDOWN' }, 'retry')).toBe(false);
    // Offline beats Error: no Retry Codex while the network is down (CONTRACTS §2.4).
    expect(enabled({ runtime: 'breaker_open', network: 'offline' }, 'retry')).toBe(false);
    expect(menu({ runtime: 'breaker_open', network: 'offline' }).find((m) => m.id === 'retry')?.visible).toBe(false);
    expect(enabled({ runtime: 'breaker_open', network: 'offline' }, 'reconnect')).toBe(true);
  });

  it('runtime starting/backoff/half_open do not offer Reconnect or Retry (the supervisor is already retrying)', () => {
    for (const runtime of ['unknown', 'starting', 'backoff', 'half_open'] as const) {
      expect(enabled({ runtime }, 'reconnect')).toBe(false);
      expect(enabled({ runtime }, 'retry')).toBe(false);
    }
  });

  it('runtime stopped shows Offline with Reconnect available', () => {
    expect(enabled({ runtime: 'stopped' }, 'reconnect')).toBe(true);
  });

  it('blocked_unavailable (codex_unavailable): Reconnect enabled, no account actions', () => {
    expect(enabled({ blocked: 'codex_unavailable' }, 'reconnect')).toBe(true);
    expect(enabled({ blocked: 'codex_unavailable', auth: 'unknown' }, 'reconnect')).toBe(true);
    expect(enabled({ blocked: 'codex_unavailable' }, 'sign_out')).toBe(false);
  });

  it('account unsupported: Sign out + Switch account, never Reconnect', () => {
    for (const p of [{ auth: 'unsupported' as const }, { blocked: 'account_unsupported' as const }, { auth: 'unsupported' as const, network: 'offline' as const }]) {
      expect(enabled(p, 'sign_out')).toBe(true);
      expect(enabled(p, 'switch_account')).toBe(true);
      expect(enabled(p, 'reconnect')).toBe(false);
      expect(menu(p).find((m) => m.id === 'reconnect')?.visible).toBe(false);
    }
    expect(enabled({ auth: 'unsupported', coordinator: 'SHUTDOWN' }, 'sign_out')).toBe(false);
  });

  it('sign_in_in_progress / blocked auth_required keep Reconnect', () => {
    expect(enabled({ blocked: 'sign_in_in_progress' }, 'reconnect')).toBe(true);
    expect(enabled({ auth: 'signing_in' }, 'reconnect')).toBe(true);
    expect(enabled({ blocked: 'auth_required' }, 'reconnect')).toBe(true);
    expect(enabled({ blocked: 'auth_required' }, 'sign_out')).toBe(false);
  });

  it('Stop task only while a task is active', () => {
    expect(enabled({}, 'stop_task')).toBe(false);
    expect(enabled({ coordinator: 'EXECUTING', taskActive: true }, 'stop_task')).toBe(true);
    expect(enabled({ coordinator: 'PERMISSION_REQUIRED' }, 'stop_task')).toBe(true);
    expect(enabled({ taskActive: true }, 'stop_task')).toBe(true);
  });

  it('Stop task disabled while already cancelling, and for speech-only SPEAKING', () => {
    expect(enabled({ coordinator: 'CANCELLING', taskActive: true }, 'stop_task')).toBe(false);
    expect(enabled({ coordinator: 'SPEAKING' }, 'stop_task')).toBe(false);
  });

  it('Reconnect only when auth required or offline', () => {
    expect(enabled({}, 'reconnect')).toBe(false);
    expect(enabled({ auth: 'expired' }, 'reconnect')).toBe(true);
    expect(enabled({ auth: 'signed_out' }, 'reconnect')).toBe(true);
    expect(enabled({ coordinator: 'AUTH_REQUIRED' }, 'reconnect')).toBe(true);
    expect(enabled({ network: 'offline' }, 'reconnect')).toBe(true);
    // still offered while muted, even though the tray shows Muted
    expect(enabled({ muted: true, auth: 'expired' }, 'reconnect')).toBe(true);
  });

  it('Reconnect stays enabled while the runtime waits for its environment (re-probe, no sign-in)', () => {
    expect(enabled({ runtime: 'waiting_for_env' }, 'reconnect')).toBe(true);
    expect(enabled({ runtime: 'waiting_for_env', network: 'offline' }, 'reconnect')).toBe(true);
    expect(enabled({ runtime: 'waiting_for_env', muted: true }, 'reconnect')).toBe(true);
    expect(enabled({ runtime: 'waiting_for_env', coordinator: 'SHUTDOWN' }, 'reconnect')).toBe(false);
    expect(enabled({ runtime: 'backoff' }, 'reconnect')).toBe(false);
  });

  it('waiting_for_env keeps Stop task tied to an active task', () => {
    expect(enabled({ runtime: 'waiting_for_env' }, 'stop_task')).toBe(false);
    expect(enabled({ runtime: 'waiting_for_env', coordinator: 'EXECUTING', taskActive: true }, 'stop_task')).toBe(true);
  });

  it('Wake test requires an open mic and no task', () => {
    expect(enabled({}, 'wake_test')).toBe(true);
    expect(enabled({ auth: 'expired' }, 'wake_test')).toBe(true);
    expect(enabled({ network: 'offline' }, 'wake_test')).toBe(true);
    expect(enabled({ muted: true }, 'wake_test')).toBe(false);
    expect(enabled({ paused: true }, 'wake_test')).toBe(false);
    expect(enabled({ coordinator: 'EXECUTING', taskActive: true }, 'wake_test')).toBe(false);
    expect(enabled({ coordinator: 'BOOTING' }, 'wake_test')).toBe(false);
  });

  it('Mute/Pause labels toggle', () => {
    expect(menu({ muted: true }).find((m) => m.id === 'toggle_mute')?.label).toBe('Unmute');
    expect(menu({}).find((m) => m.id === 'toggle_mute')?.label).toBe('Mute');
    expect(menu({ paused: true }).find((m) => m.id === 'toggle_pause')?.label).toBe('Resume');
  });

  it('Settings, Show activity and Quit are always enabled (even shutting down)', () => {
    for (const id of ['settings', 'show_activity', 'quit'] as const) {
      expect(enabled({ coordinator: 'SHUTDOWN' }, id)).toBe(true);
      expect(enabled({ muted: true, network: 'offline' }, id)).toBe(true);
    }
  });

  it('during SHUTDOWN everything but settings/activity/quit is disabled', () => {
    const items = menu({ coordinator: 'SHUTDOWN', taskActive: true, auth: 'expired' });
    expect(items.filter((m) => m.enabled).map((m) => m.id)).toEqual(['settings', 'show_activity', 'quit']);
  });
});
