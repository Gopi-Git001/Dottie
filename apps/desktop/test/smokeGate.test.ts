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

describe('E07: *ForSmokeTest gating', () => {
  it('smoke bundle, smoke not entered: every helper throws', async () => {
    const { aw, mw } = await load(true);
    const a = new aw.ApprovalWindow('p', 'i', false) as unknown as AnyFn;
    const m = new mw.MainWindow('p', 'i', {} as never, false) as unknown as AnyFn;
    expect(() => call(a, 'nudgeForSmokeTest')).toThrow('smoke mode is not active');
    expect(() => call(a, 'hideForSmokeTest')).toThrow('smoke mode is not active');
    expect(() => call(a, 'smokeWindowState')).toThrow('smoke mode is not active');
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
    expect('hideForSmokeTest' in mw.MainWindow.prototype).toBe(false);
    launch.markSmokeActive();
    expect(() => launch.assertSmokeMode()).toThrow('smoke mode is not active');
  });
});
