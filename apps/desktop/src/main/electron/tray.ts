import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { join } from 'node:path';
import type { MenuItemId, MenuItemView, TrayState } from '../../shared/states';
import type { DerivedView } from '../state/hub';
import { TRAY_ICON_STEM } from '../state/trayModel';

export class DottieTray {
  private tray: Tray | null = null;
  private readonly icons = new Map<TrayState, NativeImage>();

  constructor(
    private readonly assetsDir: string,
    private readonly onAction: (id: MenuItemId) => void,
    private readonly onClick: () => void,
  ) {}

  private icon(state: TrayState): NativeImage {
    let img = this.icons.get(state);
    if (!img) {
      const ext = process.platform === 'win32' ? 'ico' : 'png';
      img = nativeImage.createFromPath(join(this.assetsDir, 'icons', `tray-${TRAY_ICON_STEM[state]}.${ext}`));
      this.icons.set(state, img);
    }
    return img;
  }

  create(view: DerivedView): void {
    this.tray = new Tray(this.icon(view.tray.state));
    this.tray.on('click', () => this.onClick());
    this.render(view);
  }

  render(view: DerivedView): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    this.tray.setImage(this.icon(view.tray.state));
    this.tray.setToolTip(view.tray.tooltip);
    this.tray.setContextMenu(this.buildMenu(view.menu));
  }

  private buildMenu(items: MenuItemView[]): Menu {
    const sepAfter = new Set<MenuItemId>(['wake_test', 'toggle_pause', 'show_activity', 'stop_task']);
    const template: Electron.MenuItemConstructorOptions[] = [];
    for (const item of items) {
      if (!item.visible) continue; // contextual items (Retry, Sign out, Switch account)
      template.push({ id: item.id, label: item.label, enabled: item.enabled, click: () => this.onAction(item.id) });
      if (sepAfter.has(item.id)) template.push({ type: 'separator' });
    }
    return Menu.buildFromTemplate(template);
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
