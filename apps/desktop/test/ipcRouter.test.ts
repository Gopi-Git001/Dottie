import { describe, expect, it, vi } from 'vitest';
import { IpcHandlerError, createIpcRouter, type IpcHandlers } from '../src/main/ipc/router';
import { deriveMenu } from '../src/main/state/menuModel';
import { deriveTrayView } from '../src/main/state/trayModel';
import { EVENT_CHANNELS, INVOKE_CHANNELS, IPC_INVOKE, INVOKE_KEYS, allChannels, validatePush, type AppView } from '../src/shared/ipc';
import { RUNTIME_STATUSES } from '../src/shared/runtime';
import { defaultSettings } from '../src/shared/settings';
import { TRUSTED, snap } from './helpers';
import type { SenderLike } from '../src/main/ipc/trust';

function view(patch: Parameters<typeof snap>[0] = {}): AppView {
  const tray = deriveTrayView(snap(patch));
  return { tray, menu: deriveMenu(tray), flags: { voice: 'stub', auth: 'stub' }, platform: 'win32', version: '0.1.0' };
}

function handlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  const base: IpcHandlers = {
    getView: () => view(),
    control: () => view(),
    getSettings: () => defaultSettings(),
    updateSettings: () => defaultSettings(),
    getAutoStart: () => ({ enabled: false, supported: true, mechanism: 'login-item' }),
    setAutoStart: ({ enabled }) => ({ enabled, supported: true, mechanism: 'login-item' }),
    completeOnboardingStep: () => defaultSettings(),
    listMicDevices: () => ({ devices: [], simulated: true }),
    testMic: () => ({ ok: true, peakLevel: 0.5, simulated: true, message: 'sim' }),
    testWake: () => ({ detected: true, confidence: 0.9, simulated: true, message: 'sim' }),
    getAuth: () => ({ status: 'unavailable', accountLabel: null, adapter: 'stub', message: 'x' }),
    startLogin: () => ({ started: false, method: 'unavailable', message: 'x' }),
    logout: () => ({ status: 'signed_out', accountLabel: null, adapter: 'stub', message: 'x' }),
    pickFolder: () => ({ picked: null }),
    setFolderGrants: () => defaultSettings(),
    listActivity: () => ({ entries: [] }),
    getApproval: () => ({ approval: null }),
    approvalWarningShown: () => ({ approveEnabled: true, enableAfterMs: 0 }),
    resolveApproval: ({ decision }) => ({ decision }),
  };
  return { ...base, ...overrides };
}

describe('IPC contract shape', () => {
  it('every channel is namespaced, versioned and unique', () => {
    const channels = allChannels();
    expect(new Set(channels).size).toBe(channels.length);
    for (const c of channels) expect(c).toMatch(/^dottie:v1:[a-z-]+:[a-z-]+$/);
    expect(INVOKE_KEYS.length).toBe(Object.keys(INVOKE_CHANNELS).length);
    expect(channels.length).toBe(Object.keys(INVOKE_CHANNELS).length + Object.keys(EVENT_CHANNELS).length);
  });
  it('startLogin accepts no payload at all (renderer cannot pass credentials or URLs)', () => {
    expect(IPC_INVOKE.startLogin.request.safeParse(undefined).success).toBe(true);
    expect(IPC_INVOKE.startLogin.request.safeParse({ password: 'x' }).success).toBe(false);
    expect(IPC_INVOKE.startLogin.request.safeParse('https://evil.example').success).toBe(false);
  });
});

describe('IPC router — sender validation', () => {
  const router = createIpcRouter(handlers());
  const ch = INVOKE_CHANNELS.getView;

  it('accepts the top-level app://dottie frame', async () => {
    expect((await router.handle(ch, TRUSTED, [])).ok).toBe(true);
  });
  it.each([
    ['file URL', 'file:///C:/evil/index.html'],
    ['remote https', 'https://dottie.example/index.html'],
    ['other app host', 'app://evil/index.html'],
    ['userinfo trick', 'app://user@dottie/index.html'],
    ['port', 'app://dottie:8080/index.html'],
    ['garbage', 'not a url'],
    ['empty', ''],
  ])('rejects %s', async (_name, url) => {
    const r = await router.handle(ch, { senderFrame: { url, parent: null } }, []);
    expect(r).toEqual({ ok: false, error: { code: 'INVALID_SENDER', message: 'Untrusted sender' } });
  });
  it('rejects sub-frames even on the app origin', async () => {
    const r = await router.handle(ch, { senderFrame: { url: 'app://dottie/index.html', parent: {} } }, []);
    expect(r.ok).toBe(false);
  });
  it('rejects a destroyed/missing frame', async () => {
    expect((await router.handle(ch, { senderFrame: null }, [])).ok).toBe(false);
  });
  it('does not run the handler for untrusted senders', async () => {
    const spy = vi.fn(() => view());
    const r2 = createIpcRouter(handlers({ getView: spy }));
    await r2.handle(ch, { senderFrame: { url: 'https://x.test', parent: null } }, []);
    expect(spy).not.toHaveBeenCalled();
  });
  it('refuses unknown channels', async () => {
    const r = await router.handle('dottie:v1:shell:exec', TRUSTED, ['rm -rf /']);
    expect(r).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Unknown channel' } });
  });
});

describe('IPC router — input validation', () => {
  const router = createIpcRouter(handlers());
  it.each([
    ['control: unknown action', INVOKE_CHANNELS.control, [{ action: 'format_disk' }]],
    ['control: extra key', INVOKE_CHANNELS.control, [{ action: 'mute', cmd: 'x' }]],
    ['setAutoStart: wrong type', INVOKE_CHANNELS.setAutoStart, [{ enabled: 'yes' }]],
    ['updateSettings: forbidden field (startup)', INVOKE_CHANNELS.updateSettings, [{ startup: { openAtLogin: true } }]],
    ['updateSettings: forbidden field (onboarding)', INVOKE_CHANNELS.updateSettings, [{ onboarding: { completed: true } }]],
    ['updateSettings: sensitivity out of range', INVOKE_CHANNELS.updateSettings, [{ audio: { wakeSensitivity: 7 } }]],
    ['updateSettings: non-grantable scope', INVOKE_CHANNELS.updateSettings, [{ capabilities: { purchases: true } }]],
    ['updateSettings: credentials scope', INVOKE_CHANNELS.updateSettings, [{ capabilities: { 'credentials.access': true } }]],
    ['onboarding: unknown step', INVOKE_CHANNELS.completeOnboardingStep, [{ step: 'skip_all' }]],
    ['no-arg channel given an arg', INVOKE_CHANNELS.getSettings, [{}]],
    ['two args', INVOKE_CHANNELS.control, [{ action: 'mute' }, { action: 'mute' }]],
    ['folder grant: bad scope', INVOKE_CHANNELS.setFolderGrants, [{ folders: [{ path: '/x', scopes: ['shell.execute'] }] }]],
    ['folder grant: empty scopes', INVOKE_CHANNELS.setFolderGrants, [{ folders: [{ path: '/x', scopes: [] }] }]],
    ['control: credentials smuggled into switch_account', INVOKE_CHANNELS.control, [{ action: 'switch_account', password: 'hunter2' }]],
    ['control: camelCase action', INVOKE_CHANNELS.control, [{ action: 'signOut' }]],
    ['prototype pollution attempt', INVOKE_CHANNELS.updateSettings, [JSON.parse('{"__proto__":{"admin":true}}') as unknown]],
  ])('rejects %s', async (_name, channel, args) => {
    const r = await router.handle(channel, TRUSTED, args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('error messages contain paths/codes, never the rejected values', async () => {
    const r = await router.handle(INVOKE_CHANNELS.control, TRUSTED, [{ action: 'SECRET-VALUE-123' }]);
    expect(JSON.stringify(r)).not.toContain('SECRET-VALUE-123');
  });

  it('accepts valid payloads', async () => {
    expect((await router.handle(INVOKE_CHANNELS.control, TRUSTED, [{ action: 'mute' }])).ok).toBe(true);
    for (const action of ['retry', 'sign_out', 'switch_account']) expect((await router.handle(INVOKE_CHANNELS.control, TRUSTED, [{ action }])).ok).toBe(true);
    expect((await router.handle(INVOKE_CHANNELS.updateSettings, TRUSTED, [{ audio: { wakeSensitivity: 0.7 }, capabilities: { 'files.read': true } }])).ok).toBe(true);
    expect((await router.handle(INVOKE_CHANNELS.testMic, TRUSTED, [{ deviceId: null }])).ok).toBe(true);
  });
});

describe('IPC router — output validation & errors', () => {
  it('strips unknown fields from responses (e.g. an accidental token)', async () => {
    const router = createIpcRouter(
      handlers({ getAuth: () => ({ status: 'signed_in', accountLabel: 'ok', adapter: 'real', message: 'm', accessToken: 'tok' }) as never }),
    );
    const r = await router.handle(INVOKE_CHANNELS.getAuth, TRUSTED, []);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('tok');
  });
  it('rejects malformed handler output as INTERNAL', async () => {
    const router = createIpcRouter(handlers({ getAutoStart: () => ({ enabled: 'maybe' }) as never }));
    const r = await router.handle(INVOKE_CHANNELS.getAutoStart, TRUSTED, []);
    expect(r).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Response failed validation' } });
  });
  it('maps IpcHandlerError to its code and hides other exception details', async () => {
    const onError = vi.fn();
    const router = createIpcRouter(
      handlers({
        pickFolder: () => {
          throw new IpcHandlerError('FORBIDDEN', 'nope');
        },
        listActivity: () => {
          throw new Error('C:\\Users\\secret\\stack');
        },
      }),
      { onError },
    );
    expect(await router.handle(INVOKE_CHANNELS.pickFolder, TRUSTED, [])).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'nope' } });
    const r = await router.handle(INVOKE_CHANNELS.listActivity, TRUSTED, []);
    expect(r).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Internal error' } });
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('push channel: activity carries only v2 envelopes', () => {
  const entry = (event: unknown) => ({ id: 'a1', at: '2026-10-19T06:00:00Z', level: 'info', message: 'Task finished', event });
  const v2 = { schema: 'dottie.event', version: 2, type: 'TaskFinished', eventId: 'e1', correlationId: 'c1', timestamp: '2026-10-19T01:00:00-05:00', payload: { taskId: 't1', outcome: 'blocked_unavailable', reason: 'codex_unavailable', verified: false, summary: 'Codex unavailable' } };
  it('accepts a v2 TaskFinished envelope', () => {
    expect(validatePush('activity', entry(v2)).ok).toBe(true);
  });
  it('rejects the old v1 desktop envelope', () => {
    const v1 = { schemaVersion: 1, eventId: 'e1', correlationId: 'c1', emittedAt: '2026-10-19T06:00:00Z', type: 'TaskFinished', payload: v2.payload };
    expect(validatePush('activity', entry(v1)).ok).toBe(false);
    expect(validatePush('activity', entry({ ...v2, version: 1 })).ok).toBe(false);
  });
});

describe('push channel: runtime-status (main -> renderer, CONTRACTS §2.4)', () => {
  const ok = { role: 'codex_app_server', status: 'waiting_for_env', since: '2026-10-19T06:00:00Z' };

  it('is namespaced and carries exactly the frozen CONTRACTS §2.4 enum', () => {
    expect(EVENT_CHANNELS.runtimeStatus).toBe('dottie:v1:event:runtime-status');
    expect(RUNTIME_STATUSES).toEqual(['unknown', 'starting', 'running', 'backoff', 'breaker_open', 'half_open', 'waiting_for_env', 'stopped']);
    for (const s of RUNTIME_STATUSES) expect(s).toMatch(/^[a-z]+(_[a-z]+)*$/); // CONTRACTS v2 snake_case rule
  });
  it('accepts every status', () => {
    for (const status of RUNTIME_STATUSES) expect(validatePush('runtimeStatus', { ...ok, status }).ok).toBe(true);
  });
  it.each([
    ['extra field (exit code / env detail)', { ...ok, exitCode: 3 }],
    ['extra field (path)', { ...ok, detail: 'C:\\Users\\gopi\\.codex' }],
    ['missing status', { role: ok.role, since: ok.since }],
    ['unknown status', { ...ok, status: 'gave_up' }],
    ['camelCase status', { ...ok, status: 'waitingForEnv' }],
    ['unknown role', { ...ok, role: 'audio_worker' }],
    ['bad timestamp', { ...ok, since: 'yesterday' }],
    ['not an object', 'waiting_for_env'],
  ])('rejects %s', (_n, payload) => {
    expect(validatePush('runtimeStatus', payload).ok).toBe(false);
  });
  it('rejects unknown push keys', () => {
    expect(validatePush('shellExec' as never, {}).ok).toBe(false);
  });
  it('approvalGate push (CONTRACTS X5 timer): strict {dialogId, approveAfterMs: 0..500 | null}', () => {
    const id = 'd'.repeat(64);
    for (const approveAfterMs of [0, 250, 500, null]) expect(validatePush('approvalGate', { dialogId: id, approveAfterMs }).ok).toBe(true);
    for (const bad of [
      { dialogId: id, approveAfterMs: 501 },
      { dialogId: id, approveAfterMs: -1 },
      { dialogId: id, approveAfterMs: 1.5 },
      { dialogId: 'a'.repeat(64).slice(1), approveAfterMs: 0 },
      { dialogId: id },
      { dialogId: id, approveAfterMs: 0, focused: true },
      { dialogId: id, approveAfterMs: 0, actionId: 'a'.repeat(64) },
    ])
      expect(validatePush('approvalGate', bad).ok).toBe(false);
    expect(EVENT_CHANNELS.approvalGate).toBe('dottie:v1:event:approval-gate');
  });
  it('approvalGate is push-only: the router has no handler for it', () => {
    const router = createIpcRouter(handlers());
    expect(router.channels.has(EVENT_CHANNELS.approvalGate)).toBe(false);
  });
  it('is not an invoke channel (renderer cannot call it)', async () => {
    const router = createIpcRouter(handlers());
    const r = await router.handle(EVENT_CHANNELS.runtimeStatus, TRUSTED, []);
    expect(r).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Unknown channel' } });
  });
  it('view pushes accept the Error tray state, Retry and the account items, and require menu visibility', () => {
    const v = view({ runtime: 'breaker_open', auth: 'unsupported', blocked: 'account_unsupported' });
    expect(v.tray.state).toBe('error');
    expect(validatePush('view', v).ok).toBe(true);
    const ids = v.menu.filter((m) => m.visible).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['retry', 'sign_out', 'switch_account']));
    expect(ids).not.toContain('reconnect');
    const noVisible = view() as unknown as { menu: Record<string, unknown>[] };
    delete noVisible.menu[0]?.visible;
    expect(validatePush('view', noVisible).ok).toBe(false);
    const badBlock = view() as unknown as { tray: { snapshot: { blocked: string } } };
    badBlock.tray.snapshot.blocked = 'blocked_auth';
    expect(validatePush('view', badBlock).ok).toBe(false);
  });
  it('view pushes carry the runtime status in the snapshot', () => {
    expect(validatePush('view', view()).ok).toBe(true);
    const bad = view() as unknown as { tray: { snapshot: { runtime: string } } };
    bad.tray.snapshot.runtime = 'waitingForEnv';
    expect(validatePush('view', bad).ok).toBe(false);
  });
});

describe('approval channels (approval.html only; tool-host-control §4.4, D14)', () => {
  const APPROVAL: SenderLike = { senderFrame: { url: 'app://dottie/approval.html', parent: null } };
  const id = 'd'.repeat(64);
  const approvalView = {
    dialogId: id,
    title: 'Approve: Delete?',
    categoryLabel: 'Delete',
    risk: 'high',
    category: 'delete',
    expiresAt: '2026-10-19T07:00:00Z',
    expired: false,
    untrustedSummary: 'Delete a.txt',
    untrustedLabel: 'Description from the task (untrusted, not checked by Dottie)',
    codex: null,
    fields: [{ key: 'paths', label: 'Files', values: [{ segments: [{ kind: 'text', text: 'C:\\a' }, { kind: 'escape', text: '<U+202E>', codePoint: 0x202e }, { kind: 'text', text: 'txt.exe' }], hiddenCharacters: true }], untrusted: false }],
    warning: { priorSideEffect: 'unknown', text: 'This action may already have happened.' },
  };
  const cases = [
    ['getApproval', INVOKE_CHANNELS.getApproval, [], [{}]],
    ['approvalWarningShown', INVOKE_CHANNELS.approvalWarningShown, [{ dialogId: id }], [{ dialogId: id, shown: true }]],
    ['resolveApproval', INVOKE_CHANNELS.resolveApproval, [{ dialogId: id, decision: 'approve' }], [{ dialogId: id }]],
  ] as const;

  it('channel names are namespaced', () => {
    expect([INVOKE_CHANNELS.getApproval, INVOKE_CHANNELS.approvalWarningShown, INVOKE_CHANNELS.resolveApproval]).toEqual([
      'dottie:v1:approval:get',
      'dottie:v1:approval:warning-shown',
      'dottie:v1:approval:resolve',
    ]);
  });

  it.each(cases)('%s: wrong sender (main window, other page, remote, sub-frame) -> INVALID_SENDER, handler not run', async (key, channel, args) => {
    const spy = vi.fn(() => ({ approval: null, approveEnabled: true, decision: 'approve' }));
    const router = createIpcRouter(handlers({ [key]: spy }));
    for (const sender of [
      TRUSTED,
      { senderFrame: { url: 'app://dottie/approval.html', parent: {} } },
      { senderFrame: { url: 'app://dottie/approval.html.evil', parent: null } },
      { senderFrame: { url: 'https://dottie.example/approval.html', parent: null } },
      { senderFrame: null },
    ]) {
      const r = await router.handle(channel, sender, args);
      expect(r).toEqual({ ok: false, error: { code: 'INVALID_SENDER', message: 'Untrusted sender' } });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(cases)('%s: extra/missing field -> INVALID_INPUT', async (_key, channel, _ok, bad) => {
    const router = createIpcRouter(handlers());
    for (const args of [bad, channel === INVOKE_CHANNELS.getApproval ? [{ actionId: 'a'.repeat(64) }] : [{}], channel === INVOKE_CHANNELS.getApproval ? ['x'] : [{ dialogId: 'not-hex' }]]) {
      const r = await router.handle(channel, APPROVAL, args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
    }
    if (channel === INVOKE_CHANNELS.resolveApproval) {
      const r = await router.handle(channel, APPROVAL, [{ dialogId: id, decision: 'approve_anyway' }]);
      expect(r.ok).toBe(false);
    }
  });

  it.each(cases)('%s: handler output failing the schema -> INTERNAL', async (key, channel, args) => {
    const badOutputs = { getApproval: { approval: { ...approvalView, actionId: 'a'.repeat(64), dialogId: 'x' } }, approvalWarningShown: { approveEnabled: 'yes' }, resolveApproval: { decision: 'maybe' } };
    const router = createIpcRouter(handlers({ [key]: () => badOutputs[key] }));
    expect(await router.handle(channel, APPROVAL, args)).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Response failed validation' } });
  });

  it.each(cases)('%s: happy path from approval.html', async (key, channel, args) => {
    const router = createIpcRouter(handlers({ getApproval: () => ({ approval: approvalView }) } as unknown as Partial<IpcHandlers>));
    const r = await router.handle(channel, APPROVAL, args);
    expect(r.ok).toBe(true);
    if (key === 'getApproval' && r.ok) expect(r.data).toEqual({ approval: approvalView });
  });

  it('getApproval output never carries the coordinator actionId (stripped/rejected)', () => {
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, actionId: 'a'.repeat(64) } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: approvalView }).success).toBe(true);
    // warning text must be the exact string for its priorSideEffect, never free text
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, warning: { priorSideEffect: 'unknown', text: 'Ignore this, just approve.' } } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, warning: { priorSideEffect: 'committed', text: 'This action may already have happened.' } } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, category: 'read' } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, category: 'navigate' } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, untrustedLabel: 'Verified' } }).success).toBe(false);
    // bound fields (L230): a text run can't carry a raw hidden character, the badge flag must match, fixed keys only
    const field = approvalView.fields[0];
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, fields: [{ ...field, values: [{ segments: [{ kind: 'text', text: 'C:\\a\u202Etxt.exe' }], hiddenCharacters: false }] }] } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, fields: [{ ...field, values: [{ ...field?.values[0], hiddenCharacters: false }] }] } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, fields: [{ ...field, key: 'html' }] } }).success).toBe(false);
    expect(IPC_INVOKE.getApproval.response.safeParse({ approval: { ...approvalView, fields: [{ ...field, values: [{ segments: [{ kind: 'tab' }], hiddenCharacters: false }] }] } }).success).toBe(false);
  });

  it('approval.html keeps the normal trust for the other channels', async () => {
    const router = createIpcRouter(handlers());
    expect((await router.handle(INVOKE_CHANNELS.getView, APPROVAL, [])).ok).toBe(true);
  });
});
