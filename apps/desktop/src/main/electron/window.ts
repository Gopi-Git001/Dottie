import { BrowserWindow, type WebContents } from 'electron';
import type { NavigateTarget } from '../../shared/ipc';
import { IPC_EVENTS, validatePush } from '../../shared/ipc';
import { RENDERER_ENTRY_URL, isTrustedRendererUrl } from '../ipc/trust';
import type { QuitController } from '../lifecycle/quit';
import { SECURE_WEB_PREFERENCES } from '../security';
import { assertSmokeMode } from '../smoke/launch';

export class MainWindow {
  private win: BrowserWindow | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly iconPath: string,
    private readonly quit: QuitController,
    private readonly devTools: boolean,
  ) {}

  get webContents(): WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  show(view: NavigateTarget): void {
    if (this.win && !this.win.isDestroyed()) {
      this.send('navigate', { view });
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 920,
      height: 700,
      minWidth: 640,
      minHeight: 480,
      show: false,
      title: 'Dottie',
      icon: this.iconPath,
      autoHideMenuBar: true,
      backgroundColor: '#f6f7f9',
      webPreferences: { ...SECURE_WEB_PREFERENCES, preload: this.preloadPath, devTools: this.devTools },
    });
    win.removeMenu();
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    win.on('close', (e) => {
      if (this.quit.shouldHideInsteadOfClose()) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    this.win = win;
    void win.loadURL(`${RENDERER_ENTRY_URL}#${view}`);
  }

  send(key: keyof typeof IPC_EVENTS, payload: unknown): void {
    const wc = this.webContents;
    if (!wc || wc.isLoading() || !isTrustedRendererUrl(wc.getURL())) return;
    const parsed = validatePush(key, payload);
    if (parsed.ok) wc.send(IPC_EVENTS[key].channel, parsed.data);
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

type SmokeMainWindow = MainWindow & { hideForSmokeTest(): void };

/** Dev/smoke bundle only. Throws unless this process entered smoke mode. Eliminated from production. */
if (__DOTTIE_SMOKE__) {
  const proto = MainWindow.prototype as SmokeMainWindow;
  proto.hideForSmokeTest = function (this: MainWindow): void {
    assertSmokeMode();
    const w = (this as unknown as { win: BrowserWindow | null }).win;
    if (w && !w.isDestroyed() && w.isVisible()) w.hide();
  };
}
