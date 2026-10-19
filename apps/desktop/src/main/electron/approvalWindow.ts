import { BrowserWindow, type WebContents } from 'electron';
import { APPROVAL_PAGE } from '../../shared/approval';
import { IPC_EVENTS, validatePush } from '../../shared/ipc';
import { windowAttentive } from '../approval/approvalService';
import { APP_ORIGIN } from '../ipc/trust';
import { SECURE_WEB_PREFERENCES } from '../security';
import { assertSmokeMode } from '../smoke/launch';

export const APPROVAL_URL = `${APP_ORIGIN}${APPROVAL_PAGE}` as const;

/**
 * Main-owned secure approval window (tool-host-control §4.4). Same sandbox/CSP/preload as the main
 * window; only this page may call the approval channels (router `page` check). Content comes from
 * main's view model; the renderer can only return a decision for main's single-use dialogId.
 */
export class ApprovalWindow {
  private win: BrowserWindow | null = null;

  /**
   * @param onAttention main's own view of whether this window is visible (shown, not minimized)
   *   AND focused, re-evaluated on every focus/blur/show/hide/minimize/restore/closed event
   *   (CONTRACTS X5 approve-enable timer). The renderer is never asked.
   */
  constructor(
    private readonly preloadPath: string,
    private readonly iconPath: string,
    private readonly devTools: boolean,
    private readonly onAttention: (attentive: boolean) => void = () => undefined,
  ) {}

  /** Visible and focused, from BrowserWindow state only. */
  isAttentive(): boolean {
    const w = this.win;
    return !!w && windowAttentive({ destroyed: w.isDestroyed(), visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() });
  }

  private report = (): void => this.onAttention(this.isAttentive());

  /** Push a validated event to approval.html only (never to another page). */
  sendGate(payload: unknown): void {
    const wc = this.webContents;
    // Not gated on isLoading(): the page asks for its view while still loading, and the gate push
    // that answers it must not be dropped. The URL check keeps it to approval.html.
    if (!wc || wc.getURL() !== APPROVAL_URL) return;
    const parsed = validatePush('approvalGate', payload);
    if (parsed.ok) wc.send(IPC_EVENTS.approvalGate.channel, parsed.data);
  }

  get webContents(): WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      // Reload so the page fetches the current pending approval (never cached content).
      void this.win.loadURL(APPROVAL_URL);
      this.win.show();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 480,
      height: 420,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      show: false,
      title: 'Dottie — Approval needed',
      icon: this.iconPath,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { ...SECURE_WEB_PREFERENCES, preload: this.preloadPath, devTools: this.devTools },
    });
    win.removeMenu();
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    for (const evt of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const) win.on(evt as 'focus', this.report);
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.onAttention(false);
    });
    this.win = win;
    void win.loadURL(APPROVAL_URL);
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.onAttention(false);
  }
}

type SmokeApprovalWindow = ApprovalWindow & {
  nudgeForSmokeTest(): void;
  hideForSmokeTest(): void;
};

/**
 * Installed only when the dev/smoke bundle keeps `__DOTTIE_SMOKE__`. The production
 * bundle drops this block, so the names are not in the packaged app. Calling either
 * helper before smoke mode is entered throws.
 */
if (__DOTTIE_SMOKE__) {
  const proto = ApprovalWindow.prototype as SmokeApprovalWindow;
  proto.nudgeForSmokeTest = function (this: ApprovalWindow): void {
    assertSmokeMode();
    const w = (this as unknown as { win: BrowserWindow | null }).win;
    if (!w || w.isDestroyed()) return;
    if (!w.isVisible()) w.show();
    if (!w.isFocused()) w.focus();
  };
  proto.hideForSmokeTest = function (this: ApprovalWindow): void {
    assertSmokeMode();
    const w = (this as unknown as { win: BrowserWindow | null }).win;
    if (w && !w.isDestroyed()) w.hide();
  };
}
