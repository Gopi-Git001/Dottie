/** Holds the current DesktopSnapshot and notifies when the derived tray view/menu changes. */
import type { DesktopSnapshot, MenuItemView, TrayView } from '../../shared/states';
import { deriveMenu } from './menuModel';
import { deriveTrayView } from './trayModel';

export interface DerivedView {
  tray: TrayView;
  menu: MenuItemView[];
}

export class StateHub {
  private snapshot: DesktopSnapshot;
  private listeners = new Set<(v: DerivedView) => void>();
  private lastKey = '';

  constructor(initial: DesktopSnapshot) {
    this.snapshot = { ...initial };
  }

  get(): DesktopSnapshot {
    return { ...this.snapshot };
  }

  view(): DerivedView {
    const tray = deriveTrayView(this.snapshot);
    return { tray, menu: deriveMenu(tray) };
  }

  update(patch: Partial<DesktopSnapshot>): DerivedView {
    this.snapshot = { ...this.snapshot, ...patch };
    const v = this.view();
    const key = JSON.stringify(v);
    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const l of this.listeners) l(v);
    }
    return v;
  }

  onChange(listener: (v: DerivedView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
