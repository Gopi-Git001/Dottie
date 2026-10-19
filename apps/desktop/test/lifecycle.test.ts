import { describe, expect, it, vi } from 'vitest';
import { AUTOSTART_ARG, AutoStartManager, launchedAtLogin, type AutoStartEnv, type LoginItemApi } from '../src/main/lifecycle/autostart';
import { QuitController } from '../src/main/lifecycle/quit';
import { HIDDEN_SPAWN_OPTIONS, WorkerSupervisor, backoffDelay, type ChildHandle } from '../src/main/lifecycle/supervisor';

function fakeLoginApi(initial = { openAtLogin: false, executableWillLaunchAtLogin: false }) {
  let state = { ...initial };
  const api: LoginItemApi & { calls: unknown[]; userDisable(): void } = {
    calls: [],
    getLoginItemSettings: () => ({ ...state }),
    setLoginItemSettings: (s) => {
      api.calls.push(s);
      state = { openAtLogin: s.openAtLogin, executableWillLaunchAtLogin: s.openAtLogin && s.enabled !== false };
    },
    userDisable: () => {
      state = { openAtLogin: true, executableWillLaunchAtLogin: false };
    },
  };
  return api;
}
const WIN: AutoStartEnv = { platform: 'win32', isPackaged: true, isMsix: false, execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Dottie\\Dottie.exe' };

describe('AutoStartManager', () => {
  it('registers a per-user login item with the autostart arg (no service)', () => {
    const api = fakeLoginApi();
    const m = new AutoStartManager(api, WIN);
    expect(m.get()).toEqual({ enabled: false, supported: true, mechanism: 'login-item' });
    expect(m.set(true).enabled).toBe(true);
    expect(api.calls[0]).toEqual({ openAtLogin: true, enabled: true, name: 'Dottie', path: WIN.execPath, args: [AUTOSTART_ARG] });
    expect(m.set(false).enabled).toBe(false);
  });
  it('honours a disable made in Windows Settings (StartupApproved)', () => {
    const api = fakeLoginApi();
    const m = new AutoStartManager(api, WIN);
    m.set(true);
    api.userDisable();
    expect(m.get().enabled).toBe(false);
  });
  it('reconcile: preference on but OS disabled -> preference becomes off, OS untouched', () => {
    const api = fakeLoginApi();
    const m = new AutoStartManager(api, WIN);
    const r = m.reconcile(true);
    expect(r).toMatchObject({ preference: false, changed: true });
    expect(api.calls).toEqual([]);
  });
  it('reconcile: preference off but OS on -> remove the OS entry', () => {
    const api = fakeLoginApi({ openAtLogin: true, executableWillLaunchAtLogin: true });
    const m = new AutoStartManager(api, WIN);
    const r = m.reconcile(false);
    expect(r.changed).toBe(true);
    expect(r.state.enabled).toBe(false);
  });
  it('reconcile: in sync -> no change', () => {
    const m = new AutoStartManager(fakeLoginApi(), WIN);
    expect(m.reconcile(false).changed).toBe(false);
  });
  it('MSIX builds report unsupported instead of writing a Run key', () => {
    const api = fakeLoginApi();
    const m = new AutoStartManager(api, { ...WIN, isMsix: true });
    expect(m.set(true)).toMatchObject({ enabled: false, supported: false, mechanism: 'msix-startup-task' });
    expect(api.calls).toEqual([]);
  });
  it('development builds do not register unless explicitly allowed', () => {
    const api = fakeLoginApi();
    expect(new AutoStartManager(api, { ...WIN, isPackaged: false }).set(true).supported).toBe(false);
    expect(api.calls).toEqual([]);
    expect(new AutoStartManager(api, { ...WIN, isPackaged: false, allowDev: true }).set(true).enabled).toBe(true);
  });
  it('linux is unsupported', () => {
    expect(new AutoStartManager(fakeLoginApi(), { ...WIN, platform: 'linux' }).get().supported).toBe(false);
  });
  it('detects login launches', () => {
    expect(launchedAtLogin(['Dottie.exe', AUTOSTART_ARG])).toBe(true);
    expect(launchedAtLogin(['Dottie.exe'])).toBe(false);
    expect(launchedAtLogin(['Dottie.exe'], true)).toBe(true);
  });
});

function fakeChild() {
  let exit: ((c: number | null, s: string | null) => void) | null = null;
  const child: ChildHandle & { crash(): void; killed: boolean } = {
    killed: false,
    onExit: (l) => {
      exit = l;
    },
    kill: () => {
      child.killed = true;
      exit?.(null, 'SIGTERM');
    },
    crash: () => exit?.(1, null),
  };
  return child;
}

function harness() {
  const children: ReturnType<typeof fakeChild>[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let now = 0;
  const sup = new WorkerSupervisor(
    {
      spawn: () => {
        const c = fakeChild();
        children.push(c);
        return c;
      },
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => (t.cancelled = true);
      },
      now: () => now,
    },
    { initialMs: 1000, maxMs: 8000, maxCrashes: 4, windowMs: 60_000 },
  );
  const fire = () => {
    const t = timers.at(-1);
    if (t && !t.cancelled) t.fn();
  };
  return { sup, children, timers, fire, advance: (ms: number) => (now += ms) };
}

describe('WorkerSupervisor', () => {
  it('spawns hidden, without a shell', () => {
    expect(HIDDEN_SPAWN_OPTIONS).toMatchObject({ windowsHide: true, shell: false, detached: false });
  });
  it('restarts crashed workers with exponential backoff', () => {
    const h = harness();
    h.sup.start();
    h.children[0]?.crash();
    expect(h.sup.status).toBe('backoff');
    expect(h.timers.map((t) => t.ms)).toEqual([1000]);
    h.fire();
    expect(h.children.length).toBe(2);
    h.children[1]?.crash();
    h.fire();
    h.children[2]?.crash();
    expect(h.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000]);
  });
  it('gives up on a crash loop instead of spinning', () => {
    const h = harness();
    h.sup.start();
    for (let i = 0; i < 4; i++) {
      h.children.at(-1)?.crash();
      if (h.sup.status === 'backoff') h.fire();
    }
    expect(h.sup.status).toBe('gave_up');
    expect(h.children.length).toBe(4);
  });
  it('forgets old crashes outside the window', () => {
    const h = harness();
    h.sup.start();
    for (let i = 0; i < 10; i++) {
      h.children.at(-1)?.crash();
      h.advance(61_000);
      h.fire();
    }
    expect(h.sup.status).toBe('running');
  });
  it('never restarts after stop() (user Quit), including a pending backoff', () => {
    const h = harness();
    h.sup.start();
    h.children[0]?.crash();
    h.sup.stop();
    expect(h.timers[0]?.cancelled).toBe(true);
    h.timers[0]?.fn(); // even if a timer fired late
    h.sup.start();
    expect(h.children.length).toBe(1);
    expect(h.sup.status).toBe('stopped');
  });
  it('stop() kills the running child and its exit is not treated as a crash', () => {
    const h = harness();
    h.sup.start();
    h.sup.stop();
    expect(h.children[0]?.killed).toBe(true);
    expect(h.timers).toEqual([]);
  });
  it('backoff is capped', () => {
    expect(backoffDelay({ initialMs: 1000, maxMs: 8000, maxCrashes: 9, windowMs: 1 }, 10)).toBe(8000);
  });
});

describe('QuitController', () => {
  it('hides windows on close until quit is requested', () => {
    const q = new QuitController();
    expect(q.shouldHideInsteadOfClose()).toBe(true);
    q.requestQuit();
    expect(q.shouldHideInsteadOfClose()).toBe(false);
  });
  it('stops everything exactly once, even if one stoppable throws', () => {
    const q = new QuitController();
    const a = { stop: vi.fn(() => { throw new Error('boom'); }) };
    const b = { stop: vi.fn() };
    q.register(a);
    q.register(b);
    expect(q.requestQuit()).toBe(true);
    expect(q.requestQuit()).toBe(false);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });
  it('a worker registered after quit is stopped immediately', () => {
    const q = new QuitController();
    q.requestQuit();
    const c = { stop: vi.fn() };
    q.register(c);
    expect(c.stop).toHaveBeenCalledTimes(1);
  });
});
