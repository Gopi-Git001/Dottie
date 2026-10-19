/** D14 tray "Retry last task": UtteranceReady.retryOfTaskId (E01 ACCEPTED 2026-10-19), source tray_ipc via main only. */
import { describe, expect, it } from 'vitest';
import { DesktopController, RETRY_UTTERANCE_TEXT, type PlatformHooks } from '../src/main/controller';
import { readFlags } from '../src/main/flags';
import { createIpcRouter } from '../src/main/ipc/router';
import { AutoStartManager } from '../src/main/lifecycle/autostart';
import { StubAuthAdapter, StubCoordinator, StubRuntimeStatus, StubVoiceService } from '../src/main/services/stubs';
import { SettingsStore } from '../src/main/settings/store';
import { deriveMenu } from '../src/main/state/menuModel';
import { deriveTrayView } from '../src/main/state/trayModel';
import { END_REASONS, EventEnvelopeSchema, TaskFinishedSchema, TASK_OUTCOMES, UTTERANCE_SOURCES, UtteranceReadySchema, type TaskOutcome } from '../src/shared/contracts.draft';
import { AuthStatusSchema } from '../src/shared/states';
import { ControlActionSchema, INVOKE_CHANNELS, IPC_INVOKE, INVOKE_KEYS } from '../src/shared/ipc';
import { TRUSTED, snap, withTempDir } from './helpers';

const utt = { requestId: 'r1', text: 'delete old.log', locale: 'en-US', endReason: 'vad_silence' };

describe('UtteranceReady.retryOfTaskId schema', () => {
  it('accepts it optionally (non-empty), rejects empty / non-string / unknown keys', () => {
    expect(UtteranceReadySchema.safeParse(utt).success).toBe(true);
    expect(UtteranceReadySchema.safeParse({ ...utt, retryOfTaskId: 't1' }).success).toBe(true);
    expect(UtteranceReadySchema.safeParse({ ...utt, retryOfTaskId: '' }).success).toBe(false);
    expect(UtteranceReadySchema.safeParse({ ...utt, retryOfTaskId: 5 }).success).toBe(false);
    expect(UtteranceReadySchema.safeParse({ ...utt, source: 'tray' }).success).toBe(false);
    const env = { schema: 'dottie.event', version: 2, type: 'UtteranceReady', eventId: 'e1', correlationId: 'c1', timestamp: '2026-10-19T02:00:00-05:00', payload: { ...utt, retryOfTaskId: 't1' } };
    expect(EventEnvelopeSchema.safeParse(env).success).toBe(true);
  });
  it("endReason 'tray' exists (main-built tray utterances only)", () => {
    expect(END_REASONS).toEqual(['vad_silence', 'timeout', 'max_duration', 'user_stop', 'tray']);
    expect(UtteranceReadySchema.safeParse({ ...utt, endReason: 'tray', retryOfTaskId: 't1' }).success).toBe(true);
  });
  it('sources are exactly voice|tray', () => {
    expect(UTTERANCE_SOURCES).toEqual(['voice_worker', 'tray_ipc']); // CONTRACTS L211 @ 6834524 (ruling 1o)
  });
});

describe('menu: Retry last task', () => {
  const item = (patch: Parameters<typeof snap>[0]) => deriveMenu(deriveTrayView(snap(patch))).find((m) => m.id === 'retry_task');
  it('always visible; disabled without a retryable outcome, enabled with one', () => {
    expect(item({})).toMatchObject({ label: 'Retry last task', visible: true, enabled: false });
    expect(item({ retryTaskAvailable: true })).toMatchObject({ label: 'Retry last task', visible: true, enabled: true });
  });
  it.each([
    ['task active', { taskActive: true, coordinator: 'EXECUTING' as const }],
    ['shutting down', { coordinator: 'SHUTDOWN' as const }],
  ])('disabled (still visible) when %s', (_n, patch) => {
    expect(item({ retryTaskAvailable: true, ...patch })).toMatchObject({ visible: true, enabled: false });
  });
  it('enabled after blocked_unavailable even though dispatch is blocked (the retry re-checks Codex)', () => {
    expect(item({ retryTaskAvailable: true, blocked: 'codex_unavailable' })?.enabled).toBe(true);
    expect(deriveTrayView(snap({ blocked: 'codex_unavailable' })).canDispatch).toBe(false);
  });
  // CONTRACTS §5 D14 L468 @ 0d53abc (E01 ruling 1m): the only readiness ignored is blocked_unavailable's.
  it.each(AuthStatusSchema.options.filter((a) => a !== 'signed_in'))('disabled while auth is %s, even with blocked_unavailable', (auth) => {
    expect(item({ retryTaskAvailable: true, auth })).toMatchObject({ visible: true, enabled: false });
    expect(item({ retryTaskAvailable: true, auth, blocked: 'codex_unavailable' })).toMatchObject({ visible: true, enabled: false });
    expect(item({ retryTaskAvailable: true, auth: 'signed_in', blocked: 'codex_unavailable' })?.enabled).toBe(true);
  });
  it.each(['CONFIRMING', 'EXECUTING', 'VERIFYING', 'PERMISSION_REQUIRED', 'CANCELLING', 'SPEAKING'] as const)(
    'disabled while a task is active (ADR-0010): coordinator %s, with or without the taskActive flag, even with blocked_unavailable',
    (coordinator) => {
      for (const taskActive of [false, true]) {
        expect(item({ retryTaskAvailable: true, coordinator, taskActive })?.enabled).toBe(false);
        expect(item({ retryTaskAvailable: true, coordinator, taskActive, blocked: 'codex_unavailable' })?.enabled).toBe(false);
      }
      expect(item({ retryTaskAvailable: true, taskActive: true })?.enabled).toBe(false);
    },
  );
  it('retryTaskAvailable never changes tray state, wake or dispatch', () => {
    for (const patch of [{}, { network: 'offline' as const }, { muted: true }, { auth: 'expired' as const }, { runtime: 'breaker_open' as const }]) {
      const a = deriveTrayView(snap(patch));
      const b = deriveTrayView(snap({ ...patch, retryTaskAvailable: true }));
      expect([b.state, b.tooltip, b.wakeAvailable, b.canDispatch]).toEqual([a.state, a.tooltip, a.wakeAvailable, a.canDispatch]);
    }
  });
});

describe('TaskFinished{failed, retry_not_allowed}', () => {
  it('pairs only with failed', () => {
    const p = (outcome: TaskOutcome) => TaskFinishedSchema.safeParse({ taskId: 't1', outcome, verified: outcome === 'succeeded', summary: 's', reason: 'retry_not_allowed' }).success;
    for (const o of TASK_OUTCOMES) expect(p(o), o).toBe(o === 'failed');
  });
});

describe('controller: tray retry emits UtteranceReady{retryOfTaskId} with source tray_ipc', () => {
  async function setup(dir: string) {
    const store = new SettingsStore({ dir });
    await store.load();
    const autostart = new AutoStartManager(
      { getLoginItemSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }), setLoginItemSettings: () => undefined },
      { platform: 'win32', isPackaged: true, isMsix: false, execPath: 'C:\\Dottie\\Dottie.exe' },
    );
    const coordinator = new StubCoordinator();
    const hooks: PlatformHooks = { platform: 'linux', version: '0.1.0', locale: 'en-GB', openExternal: () => Promise.resolve(), pickFolder: () => Promise.resolve(null), showWindow: () => undefined, quit: () => undefined };
    const auth = new StubAuthAdapter('signed_in');
    const controller = new DesktopController({ store, autostart, auth, voice: new StubVoiceService(), coordinator, runtime: new StubRuntimeStatus('running'), flags: readFlags({}), hooks });
    await controller.init();
    coordinator.set('STANDBY', false);
    controller.setNetwork('online');
    return { controller, coordinator, auth, router: createIpcRouter(controller.handlers()) };
  }
  const finish = (outcome: TaskOutcome, extra: Record<string, unknown> = {}) => ({ taskId: 't1', outcome, verified: outcome === 'succeeded', summary: 's', ...extra });

  it.each(['failed', 'failed_after_side_effects', 'unverified', 'partial', 'blocked_unavailable'] as const)('after %s: Retry last task is enabled, submits once, then is disabled', async (outcome) => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask(finish(outcome, outcome === 'blocked_unavailable' ? { reason: 'codex_unavailable' } : {}));
      expect(t.controller.hub.view().menu.find((m) => m.id === 'retry_task')).toMatchObject({ visible: true, enabled: true });
      expect(t.controller.hub.get().retryTaskAvailable).toBe(true);
      await t.controller.trayAction('retry_task');
      expect(t.coordinator.utterances).toHaveLength(1);
      const [sent] = t.coordinator.utterances;
      expect(sent?.source).toBe('tray_ipc');
      expect(sent?.utterance).toMatchObject({ text: 'Retry the last task.', locale: 'en-GB', endReason: 'tray', retryOfTaskId: 't1' });
      expect(RETRY_UTTERANCE_TEXT).toBe('Retry the last task.');
      expect(UtteranceReadySchema.safeParse(sent?.utterance).success).toBe(true);
      expect(t.controller.hub.get().retryTaskAvailable).toBe(false);
      await t.controller.trayAction('retry_task');
      expect(t.coordinator.utterances).toHaveLength(1);
    });
  });

  it.each(TASK_OUTCOMES.filter((o) => !['failed', 'failed_after_side_effects', 'unverified', 'partial', 'blocked_unavailable'].includes(o)))('retry disabled (still visible) after %s', async (outcome) => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const reason = outcome === 'blocked_auth' ? 'auth_required' : undefined;
      t.coordinator.completeTask(finish(outcome, reason ? { reason } : {}));
      expect(t.controller.hub.get().retryTaskAvailable).toBe(false);
      expect(t.controller.hub.view().menu.find((m) => m.id === 'retry_task')).toMatchObject({ visible: true, enabled: false });
      await t.controller.trayAction('retry_task');
      expect(t.coordinator.utterances).toEqual([]);
    });
  });

  it('auth leaving signed_in disables the offered retry; the tray action then does nothing; signing back in re-enables it', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask(finish('blocked_unavailable', { reason: 'codex_unavailable' }));
      expect(t.controller.hub.view().menu.find((m) => m.id === 'retry_task')?.enabled).toBe(true);
      await t.auth.simulateStatus('expired');
      expect(t.controller.hub.view().menu.find((m) => m.id === 'retry_task')).toMatchObject({ visible: true, enabled: false });
      await t.controller.trayAction('retry_task');
      expect(t.coordinator.utterances).toEqual([]);
      await t.auth.simulateStatus('signed_in');
      expect(t.controller.hub.view().menu.find((m) => m.id === 'retry_task')?.enabled).toBe(true);
    });
  });

  it('a task becoming active disables the offered retry and the tray action does nothing (ADR-0010)', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask(finish('failed'));
      t.coordinator.set('EXECUTING', false);
      expect(t.controller.hub.view().menu.find((m) => m.id === 'retry_task')?.enabled).toBe(false);
      await t.controller.trayAction('retry_task');
      expect(t.coordinator.utterances).toEqual([]);
    });
  });

  it('failed + retry_not_allowed: tooltip "Couldn\'t retry that task" only; no activity entry, nothing spoken, retry not re-offered', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const before = t.controller.activity.list().length;
      t.coordinator.completeTask(finish('failed', { reason: 'retry_not_allowed' }));
      const v = t.controller.hub.view();
      expect(v.tray.tooltip).toBe('Dottie — Standby · say "Dottie" · Couldn\'t retry that task');
      expect(v.tray.state).toBe('standby');
      expect(t.controller.activity.list().length).toBe(before);
      expect(t.controller.hub.get().retryTaskAvailable).toBe(false);
      expect(v.menu.find((m) => m.id === 'retry_task')).toMatchObject({ visible: true, enabled: false });
      t.coordinator.set('EXECUTING', true);
      expect(t.controller.hub.view().tray.tooltip).not.toContain("Couldn't retry");
    });
  });

  it('a new task clears the retry offer; a later success clears it too', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask(finish('failed_after_side_effects'));
      t.coordinator.set('EXECUTING', true);
      expect(t.controller.hub.get().retryTaskAvailable).toBe(false);
      t.coordinator.set('STANDBY', false);
      t.coordinator.completeTask(finish('unverified'));
      t.coordinator.completeTask({ ...finish('succeeded'), taskId: 't2' });
      expect(t.controller.hub.get().retryTaskAvailable).toBe(false);
    });
  });

  it('the renderer cannot trigger a retry or choose a source: no IPC request schema accepts retryOfTaskId/source/text', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.completeTask(finish('failed_after_side_effects'));
      expect(ControlActionSchema.options).not.toContain('retry_task');
      for (const action of ['retry_task', 'retry_last_task', 'submit_utterance']) {
        const r = await t.router.handle(INVOKE_CHANNELS.control, TRUSTED, [{ action }]);
        expect(r.ok).toBe(false);
      }
      expect((await t.router.handle(INVOKE_CHANNELS.control, TRUSTED, [{ action: 'retry', retryOfTaskId: 't1', source: 'voice' }])).ok).toBe(false);
      expect((await t.router.handle(INVOKE_CHANNELS.control, TRUSTED, [{ action: 'retry', endReason: 'tray' }])).ok).toBe(false);
      for (const key of INVOKE_KEYS) {
        for (const payload of [{ retryOfTaskId: 't1' }, { source: 'tray' }, { endReason: 'tray' }, { text: 'x', retryOfTaskId: 't1', source: 'voice', endReason: 'tray' }]) {
          expect(IPC_INVOKE[key].request.safeParse(payload).success, key).toBe(false);
        }
      }
      // Runtime "Retry Codex" via IPC never submits an utterance.
      await t.router.handle(INVOKE_CHANNELS.control, TRUSTED, [{ action: 'retry' }]);
      expect(t.coordinator.utterances).toEqual([]);
    });
  });
});
