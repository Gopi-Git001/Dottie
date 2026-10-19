/**
 * Per-user start at Windows sign-in (spec §13.3) — never a Windows service.
 *
 *  - NSIS / unpackaged-store build: Electron app.setLoginItemSettings, which writes the per-user
 *    HKCU\...\Run entry (+ StartupApproved, so the user can disable it in Task Manager /
 *    Settings > Apps > Startup).
 *  - MSIX build (process.windowsStore): Run-key registration does not apply to packaged apps; the
 *    supported path is the manifest StartupTask extension + WinRT StartupTask API. Not implemented
 *    yet -> reported as unsupported (truthfully) instead of pretending. See ADR-desktop-001.
 *  - Development (unpackaged) builds never register themselves unless DOTTIE_ALLOW_DEV_AUTOSTART=1,
 *    so a dev machine doesn't end up launching node_modules/electron at sign-in.
 *
 * Pure apart from the injected LoginItemApi, so it is unit-testable without Electron.
 */
import type { AutoStartState } from '../../shared/ipc';

export const AUTOSTART_ARG = '--dottie-autostart' as const;

export interface LoginItemQuery {
  path?: string;
  args?: string[];
}
export interface LoginItemSettingsLike {
  openAtLogin: boolean;
  executableWillLaunchAtLogin?: boolean;
}
export interface LoginItemApi {
  getLoginItemSettings(options?: LoginItemQuery): LoginItemSettingsLike;
  setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[]; enabled?: boolean; name?: string }): void;
}

export interface AutoStartEnv {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isMsix: boolean;
  execPath: string;
  allowDev?: boolean;
}

export class AutoStartManager {
  constructor(
    private readonly api: LoginItemApi,
    private readonly env: AutoStartEnv,
  ) {}

  private mechanism(): AutoStartState['mechanism'] {
    if (this.env.platform === 'win32' && this.env.isMsix) return 'msix-startup-task';
    if (this.env.platform === 'win32' || this.env.platform === 'darwin') return 'login-item';
    return 'unsupported';
  }

  private unsupportedNote(): string | undefined {
    const m = this.mechanism();
    if (m === 'msix-startup-task') return 'MSIX build: start-at-sign-in needs the StartupTask extension (not implemented yet).';
    if (m === 'unsupported') return `Start at sign-in is not supported on ${this.env.platform}.`;
    if (!this.env.isPackaged && !this.env.allowDev) return 'Disabled in development builds (set DOTTIE_ALLOW_DEV_AUTOSTART=1 to test).';
    return undefined;
  }

  isSupported(): boolean {
    return this.unsupportedNote() === undefined;
  }

  private query(): LoginItemQuery {
    return this.env.platform === 'win32' ? { path: this.env.execPath, args: [AUTOSTART_ARG] } : {};
  }

  /** Effective OS state; on Windows honours a user disable in Task Manager/Settings. */
  get(): AutoStartState {
    const note = this.unsupportedNote();
    if (note !== undefined) return { enabled: false, supported: false, mechanism: this.mechanism(), note };
    const s = this.api.getLoginItemSettings(this.query());
    const enabled = this.env.platform === 'win32' ? (s.executableWillLaunchAtLogin ?? s.openAtLogin) : s.openAtLogin;
    return { enabled, supported: true, mechanism: this.mechanism() };
  }

  set(enabled: boolean): AutoStartState {
    if (!this.isSupported()) return this.get();
    if (this.env.platform === 'win32') {
      this.api.setLoginItemSettings({ openAtLogin: enabled, enabled, name: 'Dottie', ...this.query() });
    } else {
      this.api.setLoginItemSettings({ openAtLogin: enabled });
    }
    return this.get();
  }

  /**
   * Startup reconciliation between persisted preference and OS state:
   *  - preference off, OS on  -> remove the OS entry (default off until opt-in).
   *  - preference on,  OS off -> the user disabled it in Windows; respect that and report
   *                              `preference: false` so settings are updated. Never silently re-enable.
   */
  reconcile(preference: boolean): { preference: boolean; state: AutoStartState; changed: boolean } {
    const state = this.get();
    if (!state.supported) return { preference, state, changed: false };
    if (!preference && state.enabled) return { preference: false, state: this.set(false), changed: true };
    if (preference && !state.enabled) return { preference: false, state, changed: true };
    return { preference, state, changed: false };
  }
}

export function launchedAtLogin(argv: readonly string[], wasOpenedAtLogin = false): boolean {
  return wasOpenedAtLogin || argv.includes(AUTOSTART_ARG);
}
