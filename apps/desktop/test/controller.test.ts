import { describe, expect, it, vi } from 'vitest';
import { DesktopController, isFilesystemRoot, normalizeGrantPath, type PlatformHooks } from '../src/main/controller';
import { readFlags } from '../src/main/flags';
import { createIpcRouter } from '../src/main/ipc/router';
import { AutoStartManager, type LoginItemApi } from '../src/main/lifecycle/autostart';
import { StubAuthAdapter, StubCoordinator, StubRuntimeStatus, StubVoiceService } from '../src/main/services/stubs';
import type { RuntimeStatusEvent } from '../src/shared/runtime';
import type { AuthAdapter, LoginStart } from '../src/main/services/types';
import { SettingsStore } from '../src/main/settings/store';
import { INVOKE_CHANNELS, type IpcResult } from '../src/shared/ipc';
import type { Settings } from '../src/shared/settings';
import { TRUSTED, withTempDir } from './helpers';

async function setup(dir: string, opts: { auth?: AuthAdapter; picks?: (string | null)[]; runtime?: StubRuntimeStatus } = {}) {
  const store = new SettingsStore({ dir });
  await store.load();
  let login = { openAtLogin: false, executableWillLaunchAtLogin: false };
  const loginApi: LoginItemApi = {
    getLoginItemSettings: () => login,
    setLoginItemSettings: (s) => (login = { openAtLogin: s.openAtLogin, executableWillLaunchAtLogin: s.openAtLogin }),
  };
  const autostart = new AutoStartManager(loginApi, { platform: 'win32', isPackaged: true, isMsix: false, execPath: 'C:\\Dottie\\Dottie.exe' });
  const voice = new StubVoiceService();
  const coordinator = new StubCoordinator();
  const auth = opts.auth ?? new StubAuthAdapter('signed_in');
  const runtime = opts.runtime ?? new StubRuntimeStatus('running');
  const picks = [...(opts.picks ?? [])];
  const hooks: PlatformHooks & { opened: string[]; shown: string[]; quits: number } = {
    platform: 'linux',
    version: '0.1.0',
    opened: [],
    shown: [],
    quits: 0,
    openExternal: (url) => {
      hooks.opened.push(url);
      return Promise.resolve();
    },
    pickFolder: () => Promise.resolve(picks.shift() ?? null),
    showWindow: (v) => hooks.shown.push(v),
    quit: () => {
      hooks.quits++;
    },
  };
  const controller = new DesktopController({ store, autostart, auth, voice, coordinator, runtime, flags: readFlags({}), hooks });
  await controller.init();
  coordinator.set('STANDBY', false);
  controller.setNetwork('online');
  const router = createIpcRouter(controller.handlers());
  const call = async <T>(channel: string, arg?: unknown): Promise<IpcResult<T>> =>
    (await router.handle(channel, TRUSTED, arg === undefined ? [] : [arg])) as IpcResult<T>;
  return { store, controller, voice, coordinator, hooks, call, loginApi, runtime };
}

describe('DesktopController via IPC router', () => {
  it('mute persists, closes the mic gate and shows Muted', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const r = await t.call<{ tray: { state: string } }>(INVOKE_CHANNELS.control, { action: 'mute' });
      expect(r.ok && r.data.tray.state).toBe('muted');
      expect(t.voice.suppressed).toBe(true);
      expect(t.store.get().audio.muted).toBe(true);
      await t.call(INVOKE_CHANNELS.control, { action: 'unmute' });
      expect(t.voice.suppressed).toBe(false);
    });
  });

  it('pause is session-only but also closes the mic', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      await t.call(INVOKE_CHANNELS.control, { action: 'pause' });
      expect(t.voice.suppressed).toBe(true);
      expect(t.store.get().audio.muted).toBe(false);
      // unmuting while paused must not reopen the mic
      await t.call(INVOKE_CHANNELS.control, { action: 'mute' });
      await t.call(INVOKE_CHANNELS.control, { action: 'unmute' });
      expect(t.voice.suppressed).toBe(true);
    });
  });

  it('wake test is refused while muted', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      await t.call(INVOKE_CHANNELS.control, { action: 'mute' });
      const r = await t.call<{ detected: boolean }>(INVOKE_CHANNELS.testWake);
      expect(r.ok && r.data.detected).toBe(false);
    });
  });

  it('stub results are labelled simulated', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const mic = await t.call<{ simulated: boolean }>(INVOKE_CHANNELS.testMic, { deviceId: null });
      const wake = await t.call<{ simulated: boolean }>(INVOKE_CHANNELS.testWake);
      expect(mic.ok && mic.data.simulated).toBe(true);
      expect(wake.ok && wake.data.simulated).toBe(true);
    });
  });

  it('auto-start toggles the per-user login item and persists the preference', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      expect(t.store.get().startup.openAtLogin).toBe(false);
      const r = await t.call<{ enabled: boolean }>(INVOKE_CHANNELS.setAutoStart, { enabled: true });
      expect(r.ok && r.data.enabled).toBe(true);
      expect(t.store.get().startup.openAtLogin).toBe(true);
      expect(t.loginApi.getLoginItemSettings().openAtLogin).toBe(true);
    });
  });

  it('onboarding must start with privacy and records the acknowledgement time', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const bad = await t.call(INVOKE_CHANNELS.completeOnboardingStep, { step: 'signin' });
      expect(bad.ok).toBe(false);
      for (const step of ['privacy', 'mic', 'signin', 'grants', 'wake', 'autostart']) {
        const r = await t.call<Settings>(INVOKE_CHANNELS.completeOnboardingStep, { step });
        expect(r.ok).toBe(true);
      }
      const s = t.store.get();
      expect(s.onboarding.completed).toBe(true);
      expect(s.onboarding.privacyAcknowledgedAt).not.toBeNull();
      // completing onboarding does NOT turn on auto-start by itself
      expect(s.startup.openAtLogin).toBe(false);
    });
  });

  it('folder grants accept only picker-returned paths', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir, { picks: ['/home/u/Documents'] });
      const forged = await t.call(INVOKE_CHANNELS.setFolderGrants, { folders: [{ path: '/etc', scopes: ['files.read'] }] });
      expect(forged).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      await t.call(INVOKE_CHANNELS.pickFolder);
      const ok = await t.call<Settings>(INVOKE_CHANNELS.setFolderGrants, { folders: [{ path: '/home/u/Documents', scopes: ['files.read', 'files.read'] }] });
      expect(ok.ok && ok.data.grants.folders).toEqual([{ path: '/home/u/Documents', scopes: ['files.read'] }]);
      // removal is always allowed
      const removed = await t.call<Settings>(INVOKE_CHANNELS.setFolderGrants, { folders: [] });
      expect(removed.ok && removed.data.grants.folders).toEqual([]);
    });
  });

  it('refuses whole-drive grants and relative paths', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir, { picks: ['/'] });
      await t.call(INVOKE_CHANNELS.pickFolder);
      expect(await t.call(INVOKE_CHANNELS.setFolderGrants, { folders: [{ path: '/', scopes: ['files.read'] }] })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await t.call(INVOKE_CHANNELS.setFolderGrants, { folders: [{ path: 'relative/dir', scopes: ['files.read'] }] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });

  it('sign-in with the stub adapter reports unavailable and opens nothing', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir, { auth: new StubAuthAdapter('unavailable') });
      const r = await t.call<{ started: boolean; method: string }>(INVOKE_CHANNELS.startLogin);
      expect(r.ok && r.data).toMatchObject({ started: false, method: 'unavailable' });
      expect(t.hooks.opened).toEqual([]);
    });
  });

  it('sign-in opens only allowlisted official URLs in the system browser', async () => {
    const make = (start: LoginStart): AuthAdapter & { cancelled: string[] } => {
      const a = Object.assign(new StubAuthAdapter('signed_out') as AuthAdapter, { cancelled: [] as string[] });
      a.startLogin = () => Promise.resolve(start);
      a.cancelLogin = (id: string) => {
        a.cancelled.push(id);
        return Promise.resolve();
      };
      return a;
    };
    await withTempDir(async (dir) => {
      const good = make({ kind: 'system_browser', loginId: 'l1', authUrl: 'https://auth.openai.com/authorize?x' });
      const t = await setup(dir, { auth: good });
      const r = await t.call<{ started: boolean }>(INVOKE_CHANNELS.startLogin);
      expect(r.ok && r.data.started).toBe(true);
      expect(t.hooks.opened).toEqual(['https://auth.openai.com/authorize?x']);
    });
    await withTempDir(async (dir) => {
      const evil = make({ kind: 'system_browser', loginId: 'l2', authUrl: 'https://phish.example/login' });
      const t = await setup(dir, { auth: evil });
      const r = await t.call(INVOKE_CHANNELS.startLogin);
      expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(t.hooks.opened).toEqual([]);
      expect(evil.cancelled).toEqual(['l2']);
    });
    await withTempDir(async (dir) => {
      const dc = make({ kind: 'device_code', loginId: 'l3', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
      const t = await setup(dir, { auth: dc });
      const r = await t.call<{ userCode: string }>(INVOKE_CHANNELS.startLogin);
      expect(r.ok && r.data.userCode).toBe('ABCD-1234');
    });
  });

  it('tray: disabled items are no-ops; Quit calls the quit hook; Settings opens the window', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const stop = vi.spyOn(t.coordinator, 'stopTask');
      await t.controller.trayAction('stop_task'); // no task -> disabled
      expect(stop).not.toHaveBeenCalled();
      await t.controller.trayAction('settings');
      await t.controller.trayAction('show_activity');
      expect(t.hooks.shown).toEqual(['settings', 'activity']);
      await t.controller.trayAction('quit');
      expect(t.hooks.quits).toBe(1);
    });
  });

  it('tray: Stop task during a task reports the truthful stop status', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.set('EXECUTING', true);
      expect(t.controller.hub.view().tray.state).toBe('executing');
      await t.controller.trayAction('stop_task');
      expect(t.controller.hub.view().tray.state).toBe('standby');
      expect(t.controller.activity.list()[0]?.message).toBe('Task stopped before it changed anything.');
    });
  });

  it.each([
    [{ stopStatus: 'stopped_before_dispatch' }, 'info', 'Task stopped before it was sent to Codex.'],
    [{ stopStatus: 'stopped_no_side_effects' }, 'info', 'Task stopped before it changed anything.'],
    [{ stopStatus: 'stopped_after_side_effects' }, 'warning', 'Task stopped, but some actions had already happened — see activity.'],
    [{ stopStatus: 'stop_unconfirmed' }, 'warning', 'Stop requested; Dottie could not confirm the task stopped.'],
    [{ stopStatus: 'completed_before_stop' }, 'warning', 'The task finished before it could be stopped — see activity.'],
    [{ noActiveTask: true }, 'info', 'No task was running.'],
    // invalid / v1 answers are never trusted as a stop: reported as unconfirmed
    [{ stopStatus: 'stopped_before_effects' }, 'warning', 'Stop requested; Dottie could not confirm the task stopped.'],
    [{ stopStatus: 'no_task' }, 'warning', 'Stop requested; Dottie could not confirm the task stopped.'],
  ])('Stop task reports v2 stop result %j truthfully', async (result, level, message) => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.set('EXECUTING', true);
      vi.spyOn(t.coordinator, 'stopTask').mockResolvedValue(result as never);
      await t.controller.trayAction('stop_task');
      expect(t.controller.activity.list()[0]).toMatchObject({ level, message });
    });
  });

  it('expired auth shows Auth required and Reconnect starts the official flow', async () => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('signed_in');
      const t = await setup(dir, { auth });
      await auth.simulateStatus('expired');
      const v = t.controller.hub.view();
      expect(v.tray.state).toBe('auth_required');
      expect(v.tray.wakeAvailable).toBe(true);
      expect(v.menu.find((m) => m.id === 'reconnect')?.enabled).toBe(true);
      await t.controller.trayAction('reconnect');
      expect(t.controller.activity.list()[0]?.level).toBe('warning'); // stub: adapter unavailable
    });
  });

  it('runtime waiting_for_env: pushes a validated event, shows Standby, Reconnect re-probes without sign-in', async () => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('expired');
      const startLogin = vi.spyOn(auth, 'startLogin');
      const t = await setup(dir, { auth });
      expect(t.controller.hub.view().tray.state).toBe('auth_required');
      const pushed: RuntimeStatusEvent[] = [];
      t.controller.onRuntimeStatus((e) => pushed.push(e));
      t.runtime.simulate('waiting_for_env');
      expect(pushed.map((e) => [e.role, e.status])).toEqual([['codex_app_server', 'waiting_for_env']]);
      const v = t.controller.hub.view();
      expect(v.tray.state).toBe('standby');
      expect(v.menu.find((m) => m.id === 'reconnect')?.enabled).toBe(true);
      await t.controller.trayAction('reconnect');
      expect(t.runtime.rechecks).toBe(1);
      expect(startLogin).not.toHaveBeenCalled();
      expect(t.hooks.opened).toEqual([]);
      // duplicate reports are not re-pushed; leaving the state is
      t.runtime.simulate('waiting_for_env');
      t.runtime.simulate('running');
      expect(pushed.map((e) => e.status)).toEqual(['waiting_for_env', 'running']);
      expect(t.controller.hub.view().tray.state).toBe('auth_required');
    });
  });

  it('runtime waiting_for_env + offline shows Offline', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir, { runtime: new StubRuntimeStatus('waiting_for_env') });
      t.controller.setNetwork('offline');
      expect(t.controller.hub.view().tray.state).toBe('offline');
      expect(t.controller.runtimeEvent().status).toBe('waiting_for_env');
    });
  });

  it('runtime breaker_open: Error state, Retry asks the supervisor to retry; Retry is a no-op otherwise', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      await t.controller.trayAction('retry'); // running -> disabled
      expect(t.runtime.retries).toBe(0);
      t.runtime.simulate('breaker_open');
      const v = t.controller.hub.view();
      expect(v.tray.state).toBe('error');
      expect(v.tray.canDispatch).toBe(false);
      expect(v.menu.find((m) => m.id === 'retry')).toMatchObject({ enabled: true, visible: true });
      await t.controller.trayAction('retry');
      expect(t.runtime.retries).toBe(1);
      expect((await t.call(INVOKE_CHANNELS.control, { action: 'retry' })).ok).toBe(true);
      expect(t.runtime.retries).toBe(2);
      t.controller.setNetwork('offline');
      expect(t.controller.hub.view().tray.state).toBe('offline');
      expect(t.controller.hub.view().menu.find((m) => m.id === 'retry')).toMatchObject({ enabled: false, visible: false });
      await t.controller.trayAction('retry'); // hidden/disabled offline -> no-op
      expect((await t.call(INVOKE_CHANNELS.control, { action: 'retry' })).ok).toBe(true); // channel accepted, but controller refuses offline
      expect(t.runtime.retries).toBe(2);
      t.controller.setNetwork('online');
      expect(t.controller.hub.view().tray.state).toBe('error');
      t.runtime.simulate('half_open');
      expect(t.controller.hub.view().tray.tooltip).toBe('Dottie — Standby · Reconnecting…');
    });
  });

  it('runtime starting/backoff/stopped: Standby Starting… / Reconnecting…, Offline; tasks blocked', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir, { runtime: new StubRuntimeStatus('starting') });
      expect(t.controller.hub.view().tray).toMatchObject({ state: 'standby', tooltip: 'Dottie — Standby · Starting…', canDispatch: false });
      t.runtime.simulate('backoff');
      expect(t.controller.hub.view().tray).toMatchObject({ state: 'standby', tooltip: 'Dottie — Standby · Reconnecting…', canDispatch: false });
      t.runtime.simulate('stopped');
      expect(t.controller.hub.view().tray.state).toBe('offline');
      t.runtime.simulate('running');
      expect(t.controller.hub.view().tray.canDispatch).toBe(true);
    });
  });

  it('TaskFinished blocked_unavailable: Standby (never Auth required), Reconnect re-probes without sign-in; cleared by the next task', async () => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('unknown');
      const startLogin = vi.spyOn(auth, 'startLogin');
      const t = await setup(dir, { auth });
      t.coordinator.completeTask({ taskId: 't1', outcome: 'blocked_unavailable', reason: 'codex_unavailable', verified: false, summary: 'Codex unavailable' });
      let v = t.controller.hub.view();
      expect(v.tray.snapshot.blocked).toBe('codex_unavailable');
      expect(v.tray.state).toBe('standby');
      expect(v.tray.tooltip).toContain('Codex unavailable');
      t.coordinator.set('AUTH_REQUIRED', false); // even a stray AUTH_REQUIRED report does not prompt sign-in
      expect(t.controller.hub.view().tray.state).toBe('standby');
      t.coordinator.set('STANDBY', false);
      t.controller.setNetwork('offline');
      expect(t.controller.hub.view().tray.state).toBe('offline');
      t.controller.setNetwork('online');
      await t.controller.trayAction('reconnect');
      expect(t.runtime.rechecks).toBe(1);
      expect(startLogin).not.toHaveBeenCalled();
      expect(t.hooks.opened).toEqual([]);
      t.coordinator.set('EXECUTING', true);
      v = t.controller.hub.view();
      expect(v.tray.snapshot.blocked).toBe('none');
    });
  });

  it('a definitive auth status clears a stale codex_unavailable block; malformed TaskFinished is ignored', async () => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('unknown');
      const t = await setup(dir, { auth });
      t.coordinator.completeTask({ taskId: 't1', outcome: 'blocked_auth', reason: 'codex_unavailable', verified: false, summary: 'x' });
      expect(t.controller.hub.get().blocked).toBe('none');
      expect(t.controller.activity.list()[0]?.level).toBe('error');
      t.coordinator.completeTask({ taskId: 't1', outcome: 'blocked_unavailable', reason: 'codex_unavailable', verified: false, summary: 'x' });
      await auth.simulateStatus('expired');
      expect(t.controller.hub.get().blocked).toBe('none');
      expect(t.controller.hub.view().tray.state).toBe('auth_required');
    });
  });

  it('account_unsupported: "can\'t run Codex" message, Sign out / Switch account via the adapter, never Reconnect', async () => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('signed_in');
      const startLogin = vi.spyOn(auth, 'startLogin');
      const t = await setup(dir, { auth });
      t.coordinator.completeTask({ taskId: 't1', outcome: 'blocked_auth', reason: 'account_unsupported', verified: false, summary: 'unsupported' });
      let v = t.controller.hub.view();
      expect(v.tray.state).toBe('auth_required');
      expect(v.tray.tooltip).toContain("this ChatGPT account can't run Codex");
      expect(v.menu.find((m) => m.id === 'reconnect')).toMatchObject({ enabled: false, visible: false });
      expect(v.menu.find((m) => m.id === 'sign_out')).toMatchObject({ enabled: true, visible: true });
      await t.controller.trayAction('reconnect'); // disabled -> no-op, no login
      expect(startLogin).not.toHaveBeenCalled();
      await t.controller.trayAction('switch_account');
      expect(auth.logouts).toBe(1);
      expect(startLogin).toHaveBeenCalledTimes(1); // official flow; stub reports unavailable and opens nothing
      expect(t.hooks.opened).toEqual([]);
      v = t.controller.hub.view();
      expect(v.tray.snapshot).toMatchObject({ auth: 'signed_out', blocked: 'none' });
      expect(v.menu.find((m) => m.id === 'reconnect')?.enabled).toBe(true);
      expect(v.menu.find((m) => m.id === 'sign_out')?.visible).toBe(false);
    });
  });

  it('AuthState unsupported: Sign out through the control channel', async () => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('unsupported');
      const t = await setup(dir, { auth });
      expect(t.controller.hub.view().menu.find((m) => m.id === 'sign_out')?.enabled).toBe(true);
      expect((await t.call(INVOKE_CHANNELS.control, { action: 'sign_out' })).ok).toBe(true);
      expect(auth.logouts).toBe(1);
      expect(t.controller.hub.get().auth).toBe('signed_out');
    });
  });

  it('TaskProgress RECOVERING: stays Executing with "Reconnecting…" detail, nothing spoken; cleared by next progress / finish / end of task', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const voiceCalls = (['listDevices', 'testMic', 'runWakeTest', 'setMicSuppressed', 'stop'] as const).map((m) => vi.spyOn(t.voice, m));
      const progress = (state: string, taskId = 't1') => ({ taskId, state, message: 'Reconnecting…', redactedMetadata: { attempt: 2 } });
      t.coordinator.set('EXECUTING', true, 't1'); // ruling 2h.1: progress counts only for the current active task
      const activityBefore = t.controller.activity.list().length;
      const states: string[] = [];
      t.controller.hub.onChange((v) => states.push(v.tray.state));

      t.coordinator.progress(progress('RECOVERING'));
      let v = t.controller.hub.view();
      expect(v.tray).toMatchObject({ state: 'executing', tooltip: 'Dottie — Executing · Reconnecting…' });
      expect(t.controller.hub.get().coordinator).toBe('EXECUTING'); // RECOVERING never becomes the coordinator/tray state
      t.coordinator.progress(progress('RECOVERING')); // a second event in the same burst changes nothing
      t.coordinator.progress(progress('EXECUTING'));
      expect(t.controller.hub.view().tray.tooltip).toBe('Dottie — Executing · task running');

      t.coordinator.progress(progress('RECOVERING'));
      t.coordinator.completeTask({ taskId: 't1', outcome: 'failed', verified: false, summary: 'Codex gave up' });
      expect(t.controller.hub.get().recovering).toBe(false);

      t.coordinator.set('EXECUTING', true, 't3');
      t.coordinator.progress(progress('RECOVERING', 't3'));
      expect(t.controller.hub.get().recovering).toBe(true);
      t.coordinator.set('STANDBY', false); // task ended (e.g. cancelled) without a further progress event
      v = t.controller.hub.view();
      expect(v.tray.snapshot.recovering).toBe(false);
      expect(v.tray.state).toBe('standby');

      t.coordinator.set('EXECUTING', true, 't4');
      t.coordinator.progress({ ...progress('RECOVERING', 't4'), extra: 'x' }); // malformed: ignored
      expect(t.controller.hub.get().recovering).toBe(false);

      expect(states.every((s) => s === 'executing' || s === 'standby')).toBe(true);
      expect(states).not.toContain('error');
      for (const spy of voiceCalls) expect(spy).not.toHaveBeenCalled();
      expect(t.hooks.opened).toEqual([]);
      // nothing about the retry burst is written to activity (activity can be read aloud later; detail is tooltip-only)
      expect(t.controller.activity.list().slice(0, t.controller.activity.list().length - activityBefore).some((e) => /reconnect/i.test(e.message))).toBe(false);
    });
  });

  it('the desktop has no speech path: VoiceService and the coordinator stub expose no speak/TTS method', () => {
    const names = (o: object) => Object.getOwnPropertyNames(Object.getPrototypeOf(o)).concat(Object.keys(o));
    // submitUtterance/utterances are user INPUT (UtteranceReady, D14 tray retry), not speech output.
    const INPUT_SIDE = new Set(['submitUtterance', 'utterances']);
    for (const o of [new StubVoiceService(), new StubCoordinator()]) expect(names(o).filter((n) => /speak|tts|say|utter/i.test(n) && !INPUT_SIDE.has(n))).toEqual([]);
  });

  it.each([
    [undefined, 'The task failed after making changes. Check what changed.', 'last task failed after making changes'],
    ['auth_required', 'The task failed after making changes (ChatGPT sign-in expired). Check what changed.', '(ChatGPT sign-in expired)'],
    ['sign_in_in_progress', 'The task failed after making changes (sign-in was in progress). Check what changed.', '(sign-in was in progress)'],
    ['account_unsupported', "The task failed after making changes (this ChatGPT account can't run Codex). Check what changed.", "(this ChatGPT account can't run Codex)"],
    ['codex_unavailable', 'The task failed after making changes (Codex became unavailable). Check what changed.', '(Codex became unavailable)'],
    ['clarification_timeout', 'The task failed after making changes (no answer to a question). Check what changed.', '(no answer to a question)'],
    ['clarification_cancelled', 'The task failed after making changes (question cancelled). Check what changed.', '(question cancelled)'],
    ['approval_unavailable', "Some changes were made, then I couldn't ask for approval safely, so I stopped.", "(couldn't ask for approval safely)"],
  ])('failed_after_side_effects reason %s: activity + tooltip detail; no Auth required, no sign-in, no blocked, no state change', async (reason, message, tip) => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('signed_in');
      const startLogin = vi.spyOn(auth, 'startLogin');
      const t = await setup(dir, { auth });
      t.coordinator.set('EXECUTING', true);
      t.coordinator.set('STANDBY', false);
      const before = t.controller.hub.view().tray.state;
      t.coordinator.completeTask({ taskId: 't1', outcome: 'failed_after_side_effects', verified: false, summary: 'Partly done', ...(reason ? { reason } : {}) });
      const v = t.controller.hub.view();
      expect(v.tray.state).toBe(before);
      expect(v.tray.state).not.toBe('auth_required');
      expect(v.tray.snapshot.blocked).toBe('none');
      expect(v.tray.snapshot.auth).toBe('signed_in');
      expect(v.tray.tooltip).toContain(tip);
      expect(v.tray.canDispatch).toBe(true);
      expect(v.menu.find((m) => m.id === 'reconnect')?.enabled).toBe(false);
      expect(t.controller.activity.list()[0]).toMatchObject({ level: 'warning', message });
      expect(startLogin).not.toHaveBeenCalled();
      expect(t.hooks.opened).toEqual([]);
      // Cleared when the next task starts.
      t.coordinator.set('EXECUTING', true);
      expect(t.controller.hub.get().failedAfterChanges).toBe('none');
    });
  });

  it.each([
    ['declined', 'approval_unavailable', 'warning', "Couldn't ask for approval safely, so nothing was done.", "last task not started: couldn't ask for approval safely"],
    ['failed', 'clarification_timeout', 'warning', 'Stopped: Dottie asked a question and got no answer in time, so nothing was changed.', 'last task stopped: no answer to a question'],
    ['failed', 'clarification_cancelled', 'warning', "Stopped: Dottie's question was cancelled before you answered, so nothing was changed.", 'last task stopped: question cancelled'],
    ['declined', undefined, 'info', 'You declined, so nothing was done.', undefined],
    ['failed', undefined, 'warning', 'The task failed; nothing was changed.', undefined],
    ['succeeded', undefined, 'info', 'Done, and Dottie checked the result.', undefined],
  ] as const)('TaskFinished %s + %s: activity copy + tooltip detail, no block, no sign-in, no state change', async (outcome, reason, level, message, tip) => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('signed_in');
      const startLogin = vi.spyOn(auth, 'startLogin');
      const t = await setup(dir, { auth });
      t.coordinator.set('EXECUTING', true);
      t.coordinator.set('STANDBY', false);
      t.coordinator.completeTask({ taskId: 't1', outcome, verified: outcome === 'succeeded', summary: 's', ...(reason ? { reason } : {}) });
      const v = t.controller.hub.view();
      expect(v.tray.state).toBe('standby');
      expect(v.tray.snapshot.blocked).toBe('none');
      expect(v.tray.canDispatch).toBe(true);
      expect(t.controller.activity.list()[0]).toMatchObject({ level, message });
      if (tip) expect(v.tray.tooltip).toContain(tip);
      else expect(v.tray.snapshot.lastTaskNote).toBe('none');
      if (reason === 'approval_unavailable') {
        expect(t.controller.activity.list()[0]?.message).not.toMatch(/declined/i);
        expect(v.tray.tooltip).not.toMatch(/declined/i);
      }
      expect(startLogin).not.toHaveBeenCalled();
      expect(t.hooks.opened).toEqual([]);
      t.coordinator.set('EXECUTING', true);
      expect(t.controller.hub.get().lastTaskNote).toBe('none');
    });
  });

  it('rejects TaskFinished pairs outside the E03 table (declined+clarification, failed+approval_unavailable)', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask({ taskId: 't1', outcome: 'declined', reason: 'clarification_timeout', verified: false, summary: 's' });
      t.coordinator.completeTask({ taskId: 't1', outcome: 'failed', reason: 'approval_unavailable', verified: false, summary: 's' });
      expect(t.controller.activity.list().slice(0, 2).map((e) => e.message)).toEqual(['Ignored a malformed TaskFinished event from the coordinator.', 'Ignored a malformed TaskFinished event from the coordinator.']);
      expect(t.controller.hub.get().lastTaskNote).toBe('none');
    });
  });

  it('re-verify: blocked codex_unavailable never prompts sign-in; account_unsupported never shows Reconnect', async () => {
    await withTempDir(async (dir) => {
      const auth = new StubAuthAdapter('signed_in');
      const startLogin = vi.spyOn(auth, 'startLogin');
      const t = await setup(dir, { auth });
      t.coordinator.completeTask({ taskId: 't1', outcome: 'blocked_unavailable', reason: 'codex_unavailable', verified: false, summary: 's' });
      let v = t.controller.hub.view();
      expect(v.tray.state).not.toBe('auth_required');
      expect(t.controller.activity.list()[0]?.message).toMatch(/No sign-in is needed/);
      // Reconnect here is a re-probe only (§4b): it never starts a sign-in or opens a browser.
      await t.controller.reconnect();
      expect(t.controller.activity.list()[0]?.message).toBe('Checking whether Codex is reachable again; no sign-in needed.');
      expect(startLogin).not.toHaveBeenCalled();
      expect(t.hooks.opened).toEqual([]);
      t.coordinator.completeTask({ taskId: 't2', outcome: 'blocked_auth', reason: 'account_unsupported', verified: false, summary: 's' });
      v = t.controller.hub.view();
      const reconnect = v.menu.find((m) => m.id === 'reconnect');
      expect(reconnect?.visible).toBe(false);
      expect(reconnect?.enabled).toBe(false);
      expect(t.controller.activity.list()[0]?.message).not.toMatch(/reconnect/i);
      expect(v.tray.tooltip).not.toMatch(/reconnect/i);
    });
  });

  it('failed_after_side_effects while offline keeps Offline and a prior block is not re-armed', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.controller.setNetwork('offline');
      t.coordinator.completeTask({ taskId: 't1', outcome: 'failed_after_side_effects', reason: 'codex_unavailable', verified: false, summary: 'x' });
      expect(t.controller.hub.view().tray.state).toBe('offline');
      expect(t.controller.hub.get().blocked).toBe('none');
    });
  });

  it('respects a Windows-side disable of start-at-sign-in on startup', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore({ dir });
      await store.load();
      await store.update((d) => {
        d.startup.openAtLogin = true;
      });
      const t = await setup(dir); // fake OS reports disabled
      expect(t.store.get().startup.openAtLogin).toBe(false);
    });
  });
});

describe('path helpers', () => {
  it('normalises grant paths', () => {
    expect(normalizeGrantPath('/a/b/../c/', 'linux')).toBe('/a/c');
    expect(normalizeGrantPath('/A/B', 'win32')).toBe('/a/b');
  });
  it('detects filesystem roots', () => {
    expect(isFilesystemRoot('/')).toBe(true);
    expect(isFilesystemRoot('/home')).toBe(false);
  });
});

describe('feature flags', () => {
  it('default to stub and parse env', () => {
    expect(readFlags({})).toEqual({ voice: 'stub', auth: 'stub', stubAuthStatus: 'unavailable', stubRuntimeStatus: 'unknown' });
    expect(readFlags({ DOTTIE_STUB_RUNTIME_STATUS: 'waiting_for_env' }).stubRuntimeStatus).toBe('waiting_for_env');
    expect(readFlags({ DOTTIE_STUB_RUNTIME_STATUS: 'waitingForEnv' }).stubRuntimeStatus).toBe('unknown');
    expect(readFlags({ DOTTIE_FEATURE_VOICE: 'real', DOTTIE_STUB_AUTH_STATUS: 'expired' })).toMatchObject({ voice: 'real', stubAuthStatus: 'expired' });
    expect(readFlags({ DOTTIE_STUB_AUTH_STATUS: 'hacker' }).stubAuthStatus).toBe('unavailable');
  });
});

describe('ruling 2h (E01 b634c3f): terminal-event UI effects apply only to the desktop latest task', () => {
  const blockedFinish = (taskId: string) => ({ taskId, outcome: 'blocked_unavailable', reason: 'codex_unavailable', verified: false, summary: 'Codex unavailable' });
  const cancelled = (taskId: string) => ({ taskId, stopStatus: 'stopped_no_side_effects', sideEffects: 'none', sideEffectsCommitted: false, committedActions: [], report: 'Stopped.' });
  const recovering = (taskId: string) => ({ taskId, state: 'RECOVERING', message: 'Reconnecting…', redactedMetadata: { attempt: 2 } });

  it('late TaskFinished{blocked_unavailable} for an old task while a newer task runs: tooltip ("Reconnecting…"), block and retry unchanged; only its own activity entry', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.set('EXECUTING', true, 't2'); // t2 is the newer task; t1 is older
      t.coordinator.progress(recovering('t2'));
      const before = { tooltip: t.controller.hub.view().tray.tooltip, snap: t.controller.hub.get() };
      expect(before.tooltip).toBe('Dottie — Executing · Reconnecting…');
      const activity = t.controller.activity.list().length;
      t.coordinator.finish(blockedFinish('t1'));
      expect(t.controller.hub.view().tray.tooltip).toBe(before.tooltip);
      expect(t.controller.hub.get()).toEqual(before.snap); // blocked, recovering, retryTaskAvailable, notes: all unchanged
      expect(t.controller.activity.list().length).toBe(activity + 1);
      expect(t.controller.activity.list()[0]?.message).toMatch(/No sign-in is needed/);
    });
  });

  it('late TaskFinished{blocked_unavailable} for an old task after the newer task finished: the newer retry candidate and tooltip stay', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask({ taskId: 't2', outcome: 'failed', verified: false, summary: 'x' }); // retry candidate t2
      const before = { tooltip: t.controller.hub.view().tray.tooltip, snap: t.controller.hub.get() };
      expect(before.snap.retryTaskAvailable).toBe(true);
      t.coordinator.finish(blockedFinish('t1'));
      expect(t.controller.hub.get()).toEqual(before.snap);
      expect(t.controller.hub.get().blocked).toBe('none');
      expect(t.controller.hub.view().tray.tooltip).toBe(before.tooltip);
      await t.controller.trayAction('retry_task');
      expect(t.coordinator.utterances.map((u) => u.utterance.retryOfTaskId)).toEqual(['t2']);
    });
  });

  it('a matching TaskFinished{blocked_unavailable} (the latest task, after E03 cleared it) still sets the block, tooltip and retry candidate', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.set('EXECUTING', true, 't2');
      t.coordinator.progress(recovering('t2'));
      t.coordinator.finish(blockedFinish('t2')); // the stub clears activeTaskId first, like E03
      expect(t.coordinator.getState().activeTaskId).toBeNull();
      expect(t.controller.hub.get()).toMatchObject({ blocked: 'codex_unavailable', recovering: false, retryTaskAvailable: true });
      expect(t.controller.hub.view().tray.tooltip).not.toMatch(/Reconnecting/);
      await t.controller.trayAction('retry_task');
      expect(t.coordinator.utterances.map((u) => u.utterance.retryOfTaskId)).toEqual(['t2']);
    });
  });

  it('late TaskFinished{failed, retry_not_allowed} for an old task stays silent: no activity entry, no note', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask({ taskId: 't2', outcome: 'failed', verified: false, summary: 'x' });
      const snap = t.controller.hub.get();
      const activity = t.controller.activity.list().length;
      t.coordinator.finish({ taskId: 't1', outcome: 'failed', reason: 'retry_not_allowed', verified: false, summary: 'x' });
      expect(t.controller.activity.list().length).toBe(activity);
      expect(t.controller.hub.get()).toEqual(snap);
    });
  });

  it('late TaskCancelled for an old task leaves the newer task alone ("Reconnecting…" stays, retry candidate unchanged); a matching one ends the retry burst', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask({ taskId: 't1', outcome: 'failed', verified: false, summary: 'x' });
      t.coordinator.set('EXECUTING', true, 't2');
      t.coordinator.progress(recovering('t2'));
      const before = { tooltip: t.controller.hub.view().tray.tooltip, snap: t.controller.hub.get() };
      const activity = t.controller.activity.list().length;
      t.coordinator.cancel(cancelled('t1'));
      expect(t.controller.hub.get()).toEqual(before.snap);
      expect(t.controller.hub.view().tray.tooltip).toBe(before.tooltip);
      expect(t.controller.activity.list().length).toBe(activity);
      t.coordinator.cancel(cancelled('t2'));
      expect(t.controller.hub.get().recovering).toBe(false);
      expect(t.controller.hub.view().tray.tooltip).not.toMatch(/Reconnecting/);
    });
  });

  it('a matching TaskCancelled clears "Reconnecting…" even if the snapshot did not change first (desktop latest task, not the live snapshot)', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.set('EXECUTING', true, 't2');
      t.coordinator.progress(recovering('t2'));
      t.controller.onTaskCancelled(cancelled('t2')); // delivered straight to main, state untouched
      expect(t.controller.hub.get().recovering).toBe(false);
    });
  });
});

describe('ruling 2h.1 (E01 8af3cc7): non-terminal task events change UI only for the CURRENT active task', () => {
  const recovering = (taskId: string) => ({ taskId, state: 'RECOVERING', message: 'Reconnecting…', redactedMetadata: { attempt: 2 } });

  it('a late RECOVERING for an old task leaves the newer task tooltip unchanged', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask({ taskId: 't1', outcome: 'failed', verified: false, summary: 'x' });
      t.coordinator.set('EXECUTING', true, 't2');
      const before = { tooltip: t.controller.hub.view().tray.tooltip, snap: t.controller.hub.get() };
      t.coordinator.progress(recovering('t1'));
      expect(t.controller.hub.view().tray.tooltip).toBe(before.tooltip);
      expect(t.controller.hub.view().tray.tooltip).not.toMatch(/Reconnecting/);
      expect(t.controller.hub.get()).toEqual(before.snap);
    });
  });

  it('a RECOVERING for the latest task after it finished (activeTaskId now null) changes nothing', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask({ taskId: 't2', outcome: 'failed', verified: false, summary: 'x' });
      expect(t.coordinator.getState().activeTaskId).toBeNull();
      const before = { tooltip: t.controller.hub.view().tray.tooltip, snap: t.controller.hub.get() };
      t.coordinator.progress(recovering('t2'));
      expect(t.controller.hub.view().tray.tooltip).toBe(before.tooltip);
      expect(t.controller.hub.get()).toEqual(before.snap);
    });
  });

  it('a late non-RECOVERING progress for an old task does not clear the current task "Reconnecting…"', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.set('EXECUTING', true, 't2');
      t.coordinator.progress(recovering('t2'));
      t.coordinator.progress({ ...recovering('t1'), state: 'EXECUTING' });
      expect(t.controller.hub.view().tray.tooltip).toBe('Dottie — Executing · Reconnecting…');
    });
  });

  it('a matching RECOVERING (the current active task) still sets "Reconnecting…"', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.set('EXECUTING', true, 't2');
      t.coordinator.progress(recovering('t2'));
      expect(t.controller.hub.get().recovering).toBe(true);
      expect(t.controller.hub.view().tray.tooltip).toBe('Dottie — Executing · Reconnecting…');
    });
  });
});
