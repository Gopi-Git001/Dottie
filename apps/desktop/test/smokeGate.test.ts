import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {
    isDestroyed(): boolean {
      return false;
    }
  },
  app: {},
  ipcMain: {},
  session: {},
}));

type AnyFn = Record<string, (...args: unknown[]) => unknown>;

function call(obj: AnyFn, name: string): unknown {
  const fn = obj[name];
  if (typeof fn !== 'function') throw new Error(`missing ${name}`);
  return fn.call(obj);
}
async function load(flag: boolean) {
  vi.resetModules();
  vi.stubGlobal('__DOTTIE_SMOKE__', flag);
  const aw = await import('../src/main/electron/approvalWindow');
  const mw = await import('../src/main/electron/window');
  const launch = await import('../src/main/smoke/launch');
  return { aw, mw, launch };
}
afterEach(() => vi.unstubAllGlobals());

/** Minimal BrowserWindow double with a scriptable focus state (DOT-102). */
function fakeWin() {
  const handlers = new Map<string, Array<() => void>>();
  const w = {
    focused: false,
    visible: true,
    focusCalls: 0,
    isDestroyed: () => false,
    isVisible: () => w.visible,
    isMinimized: () => false,
    isFocused: () => w.focused,
    show: () => { w.visible = true; },
    moveTop: () => undefined,
    focus: () => { w.focusCalls += 1; w.focused = true; },
    on: (evt: string, fn: () => void) => { handlers.set(evt, [...(handlers.get(evt) ?? []), fn]); },
    removeListener: (evt: string, fn: () => void) => { handlers.set(evt, (handlers.get(evt) ?? []).filter((f) => f !== fn)); },
    emit: (evt: string) => { for (const fn of handlers.get(evt) ?? []) fn(); },
    count: (evt: string) => (handlers.get(evt) ?? []).length,
  };
  return w;
}

describe('DOT-102: holdFocusForSmokeTest (smoke-only focus hold)', () => {
  it('re-focuses the approval window on blur while held, and stops after release', async () => {
    vi.useFakeTimers();
    const { aw, launch } = await load(true);
    launch.markSmokeActive();
    const a = new aw.ApprovalWindow('p', 'i', false) as unknown as AnyFn & { win: unknown };
    const w = fakeWin();
    a.win = w;
    const hold = a['holdFocusForSmokeTest'] as (on: boolean) => void;
    hold.call(a, true);
    expect(w.focused).toBe(true);
    hold.call(a, true); // idempotent: one listener per window
    expect(w.count('blur')).toBe(1);
    w.focused = false;
    w.emit('blur');
    vi.advanceTimersByTime(50);
    expect(w.focused).toBe(true);
    hold.call(a, false);
    expect(w.count('blur')).toBe(0);
    w.focused = false;
    w.emit('blur');
    vi.advanceTimersByTime(50);
    expect(w.focused).toBe(false);
    vi.useRealTimers();
  });
});

describe('E07: *ForSmokeTest gating', () => {
  it('smoke bundle, smoke not entered: every helper throws', async () => {
    const { aw, mw } = await load(true);
    const a = new aw.ApprovalWindow('p', 'i', false) as unknown as AnyFn;
    const m = new mw.MainWindow('p', 'i', {} as never, false) as unknown as AnyFn;
    expect(() => call(a, 'nudgeForSmokeTest')).toThrow('smoke mode is not active');
    expect(() => call(a, 'hideForSmokeTest')).toThrow('smoke mode is not active');
    expect(() => call(a, 'smokeWindowState')).toThrow('smoke mode is not active');
    expect(() => call(a, 'holdFocusForSmokeTest')).toThrow('smoke mode is not active');
    expect(() => call(m, 'hideForSmokeTest')).toThrow('smoke mode is not active');
  });

  it('smoke bundle, smoke entered: helpers run', async () => {
    const { aw, mw, launch } = await load(true);
    launch.markSmokeActive();
    const a = new aw.ApprovalWindow('p', 'i', false) as unknown as AnyFn;
    const m = new mw.MainWindow('p', 'i', {} as never, false) as unknown as AnyFn;
    expect(() => call(a, 'nudgeForSmokeTest')).not.toThrow();
    expect(call(a, 'smokeWindowState')).toEqual({ visible: false, focused: false, isAttentive: false });
    expect(() => call(m, 'hideForSmokeTest')).not.toThrow();
  });

  it('production define: helpers are not installed and assertSmokeMode throws even after markSmokeActive', async () => {
    const { aw, mw, launch } = await load(false);
    expect('nudgeForSmokeTest' in aw.ApprovalWindow.prototype).toBe(false);
    expect('hideForSmokeTest' in aw.ApprovalWindow.prototype).toBe(false);
    expect('smokeWindowState' in aw.ApprovalWindow.prototype).toBe(false);
    expect(Object.hasOwn(aw.ApprovalWindow.prototype, 'holdFocusForSmokeTest')).toBe(false);
    expect('hideForSmokeTest' in mw.MainWindow.prototype).toBe(false);
    launch.markSmokeActive();
    expect(() => launch.assertSmokeMode()).toThrow('smoke mode is not active');
  });
});
