import { describe, expect, it } from 'vitest';
import {
  CONTRACT_STATUS,
  EVENT_SCHEMA,
  EVENT_TYPES,
  EVENT_VERSION,
  APPROVAL_RESOLVED_DECISIONS,
  TRAY_IPC_CHANNEL,
  VOICE_WORKER_CHANNEL,
  APPROVAL_RESOLVED_REASONS,
  ApprovalResolvedSchema,
  DIALOG_CATEGORIES,
  DISPLAY_HARD_LIMITS,
  DISPLAY_MAX,
  UI_ACTION_METHOD,
  isUiActionMethod,
  DISPLAY_KINDS,
  KIND_COMPLETE_CATEGORIES,
  KIND_COMPLETE_KINDS,
  METHOD_MAX,
  displayCategories,
  APPROVAL_CATEGORIES,
  REQUEST_SOURCES,
  EventEnvelopeSchema,
  STOP_STATUSES,
  StopTaskResultSchema,
  TASK_OUTCOMES,
  TaskCancelledSchema,
  TaskFinishedSchema,
} from '../src/shared/contracts.draft';
import { addCompletedStep, canCompleteStep, isOnboardingComplete, nextStep } from '../src/shared/onboarding';
import { ONBOARDING_STEPS } from '../src/shared/settings';

describe('onboarding model (spec §13.2 order)', () => {
  it('runs privacy -> mic -> signin -> grants -> wake -> autostart', () => {
    expect(ONBOARDING_STEPS).toEqual(['privacy', 'mic', 'signin', 'grants', 'wake', 'autostart']);
    expect(nextStep([])).toBe('privacy');
    expect(nextStep(['privacy', 'mic'])).toBe('signin');
    expect(nextStep([...ONBOARDING_STEPS])).toBeNull();
  });
  it('cannot skip ahead of the privacy disclosure', () => {
    expect(canCompleteStep('mic', [])).toBe(false);
    expect(() => addCompletedStep('autostart', ['privacy'])).toThrow();
    expect(addCompletedStep('mic', ['privacy'])).toEqual(['privacy', 'mic']);
  });
  it('is idempotent and keeps canonical order', () => {
    expect(addCompletedStep('privacy', ['privacy'])).toEqual(['privacy']);
  });
  it('is complete only when every step is done', () => {
    expect(isOnboardingComplete(['privacy', 'mic', 'signin', 'grants', 'wake'])).toBe(false);
    expect(isOnboardingComplete([...ONBOARDING_STEPS])).toBe(true);
  });
});

const HASH = 'a'.repeat(64);
const OBS = { outcome: 'verified', decision: 'done', checks: { folder_open: 'pass' }, sideEffect: 'none', folder: 'downloads' };
const EXAMPLES = {
  WakeDetected: { timestamp: '2026-10-18T13:00:00Z', deviceId: 'mic-1', confidence: 0.91 },
  UtteranceReady: { requestId: 'r1', text: 'open Downloads', locale: 'en-US', endReason: 'vad_silence' },
  TaskRequested: { taskId: 't1', requestId: 'r1', text: 'open Downloads', workspaceScope: { scopes: ['files.read', 'files.navigate'], paths: ['C:\\Users\\u\\Downloads'] } },
  TaskProgress: { taskId: 't1', state: 'EXECUTING', message: 'Opening Explorer', toolId: 'explorer', redactedMetadata: { step: 1, note: null } },
  ApprovalRequested: {
    taskId: 't1',
    actionId: HASH,
    summary: 'Delete 3 files',
    risk: 'high',
    expiry: '2026-10-18T13:01:00Z',
    category: 'delete',
    display: { kind: 'tool', category: 'delete', method: 'files.delete', targetLabel: 'report-old.txt and 2 more', paths: ['C:\\Users\\u\\Documents\\report-old.txt', 'C:\\Users\\u\\Documents\\a.txt', 'C:\\Users\\u\\Documents\\b.txt'], fileCount: '3' },
    requestSource: 'tool_host',
  },
  ApprovalResolved: { actionId: HASH, approved: false, timestamp: '2026-10-18T13:00:30Z' },
  ToolResult: { taskId: 't1', toolId: 'explorer.open_known_folder', observedState: OBS, verified: true, sideEffect: 'committed', evidenceRef: 'ev-1' },
  TaskFinished: { taskId: 't1', outcome: 'succeeded', verified: true, summary: 'Downloads is open' },
  TaskCancelled: { taskId: 't1', stopStatus: 'stopped_after_side_effects', sideEffects: 'committed', sideEffectsCommitted: true, committedActions: [{ toolId: 'explorer.open_known_folder', observedState: OBS, certainty: 'committed' }], report: 'Explorer was opened before the stop.' },
} as const;

const env = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  schema: EVENT_SCHEMA,
  version: EVENT_VERSION,
  type,
  eventId: 'e1',
  correlationId: 'c1',
  timestamp: '2026-10-18T08:00:00-05:00',
  ...(type === 'ApprovalResolved' ? { taskId: 't1' } : {}),
  ...extra,
  payload,
});

describe('event contract v2 mirror (CONTRACTS §3 / ADR-0012)', () => {
  it('mirrors CONTRACTS v2 with the ADR-0012 envelope identity', () => {
    expect(CONTRACT_STATUS).toBe('MIRROR_OF_CONTRACTS_V2');
    expect([EVENT_SCHEMA, EVENT_VERSION]).toEqual(['dottie.event', 2]);
  });
  it('covers all nine spec §7 events', () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(EXAMPLES).sort());
  });
  it.each(Object.entries(EXAMPLES))('%s example parses inside a v2 envelope (with optional causationId/taskId)', (type, payload) => {
    expect(EventEnvelopeSchema.safeParse(env(type, payload)).success).toBe(true);
    expect(EventEnvelopeSchema.safeParse(env(type, payload, { causationId: 'e0', taskId: 't1' })).success).toBe(true);
  });
  it.each([
    ['v1 desktop envelope (schemaVersion/emittedAt)', { schemaVersion: 1, eventId: 'e', correlationId: 'c', emittedAt: '2026-10-18T13:00:00Z', type: 'WakeDetected', payload: EXAMPLES.WakeDetected }],
    ['version 1', env('WakeDetected', EXAMPLES.WakeDetected, { version: 1 })],
    ['version 3', env('WakeDetected', EXAMPLES.WakeDetected, { version: 3 })],
    ['wrong schema', env('WakeDetected', EXAMPLES.WakeDetected, { schema: 'dottie.audit' })],
    ['CONTRACTS v1 source field', env('WakeDetected', EXAMPLES.WakeDetected, { source: 'audio' })],
    ['timestamp without offset', env('WakeDetected', EXAMPLES.WakeDetected, { timestamp: '2026-10-18T13:00:00' })],
    ['missing correlationId', { ...env('WakeDetected', EXAMPLES.WakeDetected), correlationId: undefined }],
    ['type/payload mismatch', env('TaskFinished', EXAMPLES.WakeDetected)],
    ['ApprovalResolved without envelope taskId', { ...env('ApprovalResolved', EXAMPLES.ApprovalResolved), taskId: undefined }],
  ])('rejects %s', (_n, e) => {
    expect(EventEnvelopeSchema.safeParse(e).success).toBe(false);
  });
  it.each([
    ['WakeDetected raw audio', 'WakeDetected', { ...EXAMPLES.WakeDetected, audio: 'base64...' }],
    ['WakeDetected confidence > 1', 'WakeDetected', { ...EXAMPLES.WakeDetected, confidence: 1.5 }],
    ['v1 endReason silence', 'UtteranceReady', { ...EXAMPLES.UtteranceReady, endReason: 'silence' }],
    ['v1 endReason error', 'UtteranceReady', { ...EXAMPLES.UtteranceReady, endReason: 'error' }],
    ['v1 workspaceScope.folders', 'TaskRequested', { ...EXAMPLES.TaskRequested, workspaceScope: { scopes: ['files.read'], folders: [] } }],
    ['unknown scope', 'TaskRequested', { ...EXAMPLES.TaskRequested, workspaceScope: { scopes: ['files.delete'], paths: [] } }],
    ['nested redactedMetadata', 'TaskProgress', { ...EXAMPLES.TaskProgress, redactedMetadata: { nested: { a: 1 } } }],
    ['> 32 redactedMetadata keys', 'TaskProgress', { ...EXAMPLES.TaskProgress, redactedMetadata: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${String(i)}`, i])) }],
    ['unknown coordinator state', 'TaskProgress', { ...EXAMPLES.TaskProgress, state: 'RUNNING' }],
    ['approval without category', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, category: undefined }],
    ['credential_access approval', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, category: 'credential_access' }],
    ['v1 risk sensitive', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, risk: 'sensitive' }],
    ['non-hash actionId', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, actionId: 'a1' }],
    ['approval without display (X5, ruling 1k)', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, display: undefined }],
    ['navigate approval with a tool display: no display rule (rulings 1l/2a)', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, category: 'navigate' }],
    ['read approval with a tool display: no display rule (rulings 1l/2a)', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, category: 'read' }],
    ['display.category differs', 'ApprovalRequested', { ...EXAMPLES.ApprovalRequested, category: 'overwrite' }],
    ['expired with approved:true (ruling 1n)', 'ApprovalResolved', { ...EXAMPLES.ApprovalResolved, approved: true, decision: 'expired' }],
    ['reason with approved:true (ruling 1n)', 'ApprovalResolved', { ...EXAMPLES.ApprovalResolved, approved: true, reason: 'display_unavailable' }],
    ['decision and reason together (ruling 1n)', 'ApprovalResolved', { ...EXAMPLES.ApprovalResolved, decision: 'expired', reason: 'display_unavailable' }],
    ['unknown ApprovalResolved decision', 'ApprovalResolved', { ...EXAMPLES.ApprovalResolved, decision: 'declined' }],
    ['unknown ApprovalResolved reason', 'ApprovalResolved', { ...EXAMPLES.ApprovalResolved, reason: 'user_declined' }],
    ['string observedState', 'ToolResult', { ...EXAMPLES.ToolResult, observedState: 'Explorer shows Downloads' }],
    ['observedState decision cancelled', 'ToolResult', { ...EXAMPLES.ToolResult, observedState: { ...OBS, decision: 'cancelled' } }],
    ['observedState nested tool key', 'ToolResult', { ...EXAMPLES.ToolResult, observedState: { ...OBS, window: { title: 'secret' } } }],
    ['verified with error', 'ToolResult', { ...EXAMPLES.ToolResult, error: { code: 'INTERNAL', message: 'x', retryable: false } }],
    ['unverified without error', 'ToolResult', { ...EXAMPLES.ToolResult, verified: false }],
    ['retryable after side effect', 'ToolResult', { ...EXAMPLES.ToolResult, verified: false, error: { code: 'TIMEOUT', message: 'x', retryable: true } }],
    ['v1 NEEDS_APPROVAL', 'ToolResult', { ...EXAMPLES.ToolResult, verified: false, sideEffect: 'none', error: { code: 'NEEDS_APPROVAL', message: 'x', retryable: false } }],
    ['E04 sideEffect attempted', 'ToolResult', { ...EXAMPLES.ToolResult, sideEffect: 'attempted' }],
    ['succeeded but unverified', 'TaskFinished', { ...EXAMPLES.TaskFinished, verified: false }],
    ['plain cancelled stop status', 'TaskCancelled', { ...EXAMPLES.TaskCancelled, stopStatus: 'cancelled' }],
    ['v1 desktop stop status', 'TaskCancelled', { ...EXAMPLES.TaskCancelled, stopStatus: 'stopped_before_effects' }],
    ['no_task as stop status', 'TaskCancelled', { ...EXAMPLES.TaskCancelled, stopStatus: 'no_task' }],
    ['sideEffectsCommitted mismatch', 'TaskCancelled', { ...EXAMPLES.TaskCancelled, sideEffectsCommitted: false }],
    ['string observedState in committedActions', 'TaskCancelled', { ...EXAMPLES.TaskCancelled, committedActions: [{ toolId: 'x', observedState: 'done', certainty: 'committed' }] }],
  ])('rejects payload: %s', (_n, type, payload) => {
    expect(EventEnvelopeSchema.safeParse(env(type, payload)).success).toBe(false);
  });
  it('accepts the v2 additions: INVALID_ARGUMENT / USER_DECLINED codes, all stop statuses', () => {
    for (const code of ['INVALID_ARGUMENT', 'USER_DECLINED']) {
      const tr = { ...EXAMPLES.ToolResult, verified: false, sideEffect: 'none', error: { code, message: 'x', retryable: false } };
      expect(EventEnvelopeSchema.safeParse(env('ToolResult', tr)).success).toBe(true);
    }
    for (const stopStatus of STOP_STATUSES) {
      const tc = { ...EXAMPLES.TaskCancelled, stopStatus, sideEffects: 'none', sideEffectsCommitted: false, committedActions: [] };
      expect(TaskCancelledSchema.safeParse(tc).success).toBe(true);
    }
  });
  it('stop names match ADR-0012 §7 exactly; the port result is {stopStatus} | {noActiveTask: true}', () => {
    expect(STOP_STATUSES).toEqual(['stopped_before_dispatch', 'stopped_no_side_effects', 'stopped_after_side_effects', 'stop_unconfirmed', 'completed_before_stop']);
    expect(StopTaskResultSchema.safeParse({ noActiveTask: true }).success).toBe(true);
    expect(StopTaskResultSchema.safeParse({ stopStatus: 'stop_unconfirmed' }).success).toBe(true);
    for (const bad of [{ stopStatus: 'no_task' }, { noActiveTask: false }, { stopStatus: 'stopped_before_effects' }, { stopped: true }, {}]) {
      expect(StopTaskResultSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('TaskFinished — CONTRACTS v2 §3 outcome/reason (E01 2026-10-19)', () => {
  const base = { taskId: 't1', verified: false, summary: 'blocked' };
  it('has the v2 outcomes including blocked_unavailable', () => {
    expect(TASK_OUTCOMES).toEqual(['succeeded', 'answered', 'partial', 'unverified', 'failed', 'failed_after_side_effects', 'declined', 'blocked_auth', 'blocked_unavailable']);
  });
  it.each([
    ['blocked_auth', 'auth_required'],
    ['blocked_auth', 'sign_in_in_progress'],
    ['blocked_auth', 'account_unsupported'],
    ['blocked_unavailable', 'codex_unavailable'],
    ['declined', 'approval_unavailable'],
    ['failed', 'clarification_timeout'],
    ['failed_after_side_effects', 'approval_unavailable'],
    ['failed', undefined],
    // CONTRACTS §2.1 mid-run / after-commit: failed_after_side_effects accepts ANY shared reason.
    ['failed_after_side_effects', undefined],
    ['failed_after_side_effects', 'auth_required'],
    ['failed_after_side_effects', 'sign_in_in_progress'],
    ['failed_after_side_effects', 'account_unsupported'],
    ['failed_after_side_effects', 'codex_unavailable'],
    ['failed_after_side_effects', 'clarification_timeout'],
    ['failed_after_side_effects', 'clarification_cancelled'],
  ])('accepts %s with reason %s', (outcome, reason) => {
    expect(TaskFinishedSchema.safeParse({ ...base, outcome, ...(reason ? { reason } : {}) }).success).toBe(true);
  });
  it.each([
    ['blocked_auth without reason', { outcome: 'blocked_auth' }],
    ['blocked_auth with codex_unavailable (old v2 draft)', { outcome: 'blocked_auth', reason: 'codex_unavailable' }],
    ['blocked_unavailable with an auth reason', { outcome: 'blocked_unavailable', reason: 'auth_required' }],
    ['blocked_unavailable without reason', { outcome: 'blocked_unavailable' }],
    ['auth reason on a non-blocked outcome', { outcome: 'failed', reason: 'account_unsupported' }],
    ['codex_unavailable on failed', { outcome: 'failed', reason: 'codex_unavailable' }],
    ['auth reason on partial', { outcome: 'partial', reason: 'auth_required' }],
    ['clarification reason on declined', { outcome: 'declined', reason: 'clarification_timeout' }],
    ['approval_unavailable on failed', { outcome: 'failed', reason: 'approval_unavailable' }],
    ['reason on succeeded', { outcome: 'succeeded', verified: true, reason: 'clarification_timeout' }],
    ['failed_after_side_effects with an unknown reason', { outcome: 'failed_after_side_effects', reason: 'network_down' }],
    ['failed_after_side_effects verified', { outcome: 'failed_after_side_effects', reason: 'auth_required', verified: true }],
    ['unknown reason', { outcome: 'blocked_auth', reason: 'password_wrong' }],
    ['verified without succeeded', { outcome: 'partial', verified: true }],
    ['succeeded without verified', { outcome: 'succeeded', verified: false }],
    ['extra field', { outcome: 'failed', token: 'x' }],
  ])('rejects %s', (_n, patch) => {
    expect(TaskFinishedSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('CONTRACTS @ 97e7bc0: X5 bound display kind union (1r), key names and values (1v), coverage (2a/2b)', () => {
  const base = EXAMPLES.ApprovalRequested;
  const ok = (p: unknown) => EventEnvelopeSchema.safeParse(env('ApprovalRequested', p)).success;
  const src = (d: { kind: string }) => ({ tool: 'tool_host', ui_action: 'tool_host', codex_command: 'codex', codex_file_change: 'codex', pre_dispatch: 'coordinator' })[d.kind];
  const okDisplay = (display: { kind: string; category: string } & Record<string, unknown>) => ok({ ...base, category: display.category, display, requestSource: src(display) });
  const tool = { kind: 'tool', method: 'm', targetLabel: 't' };
  const ui = { kind: 'ui_action', category: 'local_change', method: 'ui.click', app: { appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } };
  const pre = { kind: 'pre_dispatch', category: 'local_change', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summaryUntrusted: 'Rename the files.' };
  const cmd = { kind: 'codex_command', category: 'local_change', commandLine: 'git clean -fdx', workingDirectory: 'C:\\repo', networkAccess: 'not_requested', escalation: [], reasonUntrusted: null };
  const files = { kind: 'codex_file_change', category: 'overwrite', paths: ['C:\\repo\\a.ts', 'C:\\repo\\b.ts'], fileCount: '2', reasonUntrusted: 'Update imports' };
  it('dialog categories, display kinds and request sources are the CONTRACTS lists', () => {
    expect(DIALOG_CATEGORIES).toEqual(['local_change', 'delete', 'overwrite', 'external_send', 'external_upload', 'purchase', 'install_or_elevate', 'security_setting']);
    expect(DISPLAY_KINDS).toEqual(['tool', 'ui_action', 'codex_command', 'codex_file_change', 'pre_dispatch']);
    expect(REQUEST_SOURCES).toEqual(['codex', 'tool_host', 'coordinator']);
  });
  it('limits are an exact copy of E02 packages/contracts/src/display.ts @ 2581593 (method moved to the never-cut limits, ruling 2b)', () => {
    expect(DISPLAY_HARD_LIMITS).toEqual({
      commandLine: { maxBytes: 8192 },
      workingDirectory: { maxBytes: 4096 },
      paths: { maxEntries: 500, maxEntryBytes: 4096 },
      escalation: { maxEntries: 32, maxEntryCodePoints: 256 },
      method: { maxCodePoints: 64 },
    });
    expect(DISPLAY_MAX).toEqual({
      summaryUntrusted: 500,
      reasonUntrusted: 500,
      windowTitle: 256,
      targetLabel: 256,
      appName: 128,
      processImage: 260,
      retryOfTaskId: 128,
      path: 1024,
      recipients: 254,
      recipientCount: 20,
      channel: 64,
      bodyUntrusted: 200,
      package: 128,
      publisher: 128,
      version: 64,
      source: 256,
      merchant: 128,
      amount: 32,
      destinationHost: 253,
      setting: 128,
      currentValue: 256,
      newValue: 256,
    });
  });
  describe('ruling 1z: delete/overwrite always carry paths[] and fileCount', () => {
    it.each(['delete', 'overwrite'])('%s: a single item still carries paths[1] and fileCount "1"', (category) => {
      expect(okDisplay({ ...tool, category, paths: ['C:\\a.txt'], fileCount: '1' })).toBe(true);
    });
    it.each([
      ['delete', 'no paths', { fileCount: '1' }],
      ['delete', 'no fileCount', { paths: ['C:\\a.txt'] }],
      ['delete', 'paths null', { paths: null, fileCount: '1' }],
      ['delete', 'fileCount null', { paths: ['C:\\a.txt'], fileCount: null }],
      ['delete', 'empty paths', { paths: [], fileCount: '0' }],
      ['delete', 'a single path instead of a list', { path: 'C:\\a.txt', fileCount: '1' }],
      ['overwrite', 'no paths', { fileCount: '1' }],
      ['overwrite', 'no fileCount', { paths: ['C:\\a.txt'] }],
      ['overwrite', 'paths null', { paths: null, fileCount: '1' }],
      ['overwrite', 'fileCount null', { paths: ['C:\\a.txt'], fileCount: null }],
      ['overwrite', 'empty paths', { paths: [], fileCount: '0' }],
      ['overwrite', 'a single path instead of a list', { path: 'C:\\a.txt', fileCount: '1' }],
    ])('%s rejects: %s', (category, _n, patch) => {
      expect(okDisplay({ ...tool, category, ...patch })).toBe(false);
    });
  });
  describe('ruling 1z: UI-action method regex ^(ui|window)\\.[a-z][a-z0-9_]*$', () => {
    it('UI_ACTION_METHOD is exactly the CONTRACTS regex', () => {
      expect(UI_ACTION_METHOD.source).toBe('^(ui|window)\\.[a-z][a-z0-9_]*$');
      expect(UI_ACTION_METHOD.flags).toBe('');
    });
    it.each(['ui.click', 'ui.type_text', 'ui.key2', 'window.focus', 'window.move_to_monitor', 'ui.a'])('accepts %s as a ui_action method', (method) => {
      expect(isUiActionMethod(method)).toBe(true);
      expect(okDisplay({ ...ui, method })).toBe(true);
    });
    it.each(['ui.', 'window.', 'ui', 'ui.Click', 'ui.1click', 'ui._x', 'ui.click.now', 'ui.click-now', 'ui.click ', ' ui.click', 'UI.click', 'window.Focus', 'app.launch', 'uix.click', 'ui.click\n', 'ui.cl\u0131ck'])('rejects %j as a ui_action method', (method) => {
      expect(isUiActionMethod(method)).toBe(false);
      expect(okDisplay({ ...ui, method })).toBe(false);
    });
    it.each(['ui.click', 'window.focus', 'ui.', 'ui.Click', 'window.x-y'])('a tool display may not use the ui./window. prefix at all (1y): %j', (method) => {
      expect(okDisplay({ ...tool, method, category: 'overwrite', paths: ['C:\\a'], fileCount: '1' })).toBe(false);
    });
    it('app.* stays a tool method (1y)', () => {
      expect(okDisplay({ ...tool, method: 'app.launch', category: 'local_change', targets: ['C:\\a.exe'], itemCount: '1' })).toBe(true);
    });
  });
  describe('ruling 2a: the coverage rule applies to kind tool ONLY (E02 2581593 displayCategories)', () => {
    it('kind-complete categories/kinds and displayCategories match E02', () => {
      expect(KIND_COMPLETE_CATEGORIES).toEqual([...DIALOG_CATEGORIES, 'read', 'navigate']);
      expect(KIND_COMPLETE_KINDS).toEqual(['pre_dispatch', 'codex_command', 'codex_file_change']);
      expect(displayCategories('tool')).toEqual(DIALOG_CATEGORIES);
      expect(displayCategories('ui_action')).toEqual(DIALOG_CATEGORIES);
      for (const k of KIND_COMPLETE_KINDS) expect(displayCategories(k)).toEqual(KIND_COMPLETE_CATEGORIES);
      for (const k of DISPLAY_KINDS) expect(displayCategories(k)).not.toContain('credential_access');
    });
    // Relaxes the earlier (1l) rejection of read/navigate for these kinds.
    it.each([
      ['pre_dispatch', 'read', pre],
      ['pre_dispatch', 'navigate', pre],
      ['codex_command', 'read', cmd],
      ['codex_command', 'navigate', cmd],
      ['codex_file_change', 'read', files],
      ['codex_file_change', 'navigate', files],
    ])('%s with category %s is valid', (_k, category, d) => {
      expect(okDisplay({ ...d, category })).toBe(true);
    });
    it.each([
      ['tool', 'read'],
      ['tool', 'navigate'],
      ['ui_action', 'read'],
      ['ui_action', 'navigate'],
    ])('%s with category %s is still rejected (tool-kind coverage; ui_action dialog categories only)', (kind, category) => {
      const d = kind === 'tool' ? { ...tool, category, targets: ['C:\\a'], itemCount: '1' } : { ...ui, category };
      expect(okDisplay(d)).toBe(false);
    });
    it.each([['tool'], ['ui_action'], ['pre_dispatch'], ['codex_command'], ['codex_file_change']])('%s with credential_access is rejected (ruling 2b: 1l overrides 2a)', (kind) => {
      const d = { tool: { ...tool, targets: ['C:\\a'], itemCount: '1' }, ui_action: ui, pre_dispatch: pre, codex_command: cmd, codex_file_change: files }[kind] as Record<string, unknown>;
      expect(okDisplay({ ...d, kind, category: 'credential_access' })).toBe(false);
    });
    it.each([['read'], ['navigate']])('possibleRepeat stays rejected on %s for every kind-complete kind (CONTRACTS L214 / C-25; same as E02 validate.ts)', (category) => {
      const rep = { priorTaskId: 't0', priorSideEffect: 'unknown' };
      // pre_dispatch with a consistent display (possibleRepeat/retryOfTaskId set) is still rejected on the event field
      expect(ok({ ...base, category, risk: 'high', display: { ...pre, category, possibleRepeat: 'unknown', retryOfTaskId: 't0' }, requestSource: 'coordinator', possibleRepeat: rep })).toBe(false);
      // and a pre_dispatch display carrying possibleRepeat without the event field fails the consistency check
      expect(ok({ ...base, category, risk: 'high', display: { ...pre, category, possibleRepeat: 'unknown', retryOfTaskId: 't0' }, requestSource: 'coordinator' })).toBe(false);
      expect(ok({ ...base, category, display: { ...cmd, category }, requestSource: 'codex', possibleRepeat: rep })).toBe(false);
      expect(ok({ ...base, category, display: { ...files, category }, requestSource: 'codex', possibleRepeat: rep })).toBe(false);
      // without it: valid (fresh approval, no repeat warning)
      expect(ok({ ...base, category, risk: 'high', display: { ...pre, category }, requestSource: 'coordinator' })).toBe(true);
    });
  });
  describe('ruling 2b: display.category equals the event category for every kind; method never cut', () => {
    const displays: [string, Record<string, unknown>][] = [
      ['tool', { ...tool, category: 'delete', paths: ['C:\\a'], fileCount: '1' }],
      ['ui_action', ui],
      ['codex_command', cmd],
      ['codex_file_change', files],
      ['pre_dispatch', pre],
    ];
    it.each(displays)('%s: the same category is accepted, any other event category is rejected (both directions)', (_k, d) => {
      const src2 = src(d as { kind: string });
      expect(ok({ ...base, category: d['category'], display: d, requestSource: src2 })).toBe(true);
      for (const category of APPROVAL_CATEGORIES) {
        if (category === d['category']) continue;
        expect(ok({ ...base, category, display: d, requestSource: src2 })).toBe(false);
        // the other direction: event category fixed, display category changed
        expect(ok({ ...base, category: d['category'], display: { ...d, category }, requestSource: src2 })).toBe(false);
      }
    });
    it('METHOD_MAX is 64 code points, a never-cut limit', () => {
      expect(METHOD_MAX).toBe(64);
      expect('method' in DISPLAY_MAX).toBe(false);
    });
    it.each([
      ['tool', (m: string) => ({ ...tool, method: m, category: 'delete', paths: ['C:\\a'], fileCount: '1' }), 'files.' + 'd'.repeat(58)],
      ['ui_action', (m: string) => ({ ...ui, method: m }), 'ui.' + 'c'.repeat(61)],
    ])('%s: a 64-code-point method is accepted, 65 is display_unavailable (rejected, never cut)', (_k, mk, m64) => {
      expect(Array.from(m64).length).toBe(64);
      expect(okDisplay(mk(m64))).toBe(true);
      expect(okDisplay(mk(m64 + 'x'))).toBe(false);
      // a cut method (ellipsis) breaks the 1z regex for ui_action
      if (_k === 'ui_action') expect(okDisplay(mk(m64.slice(0, 63) + '\u2026'))).toBe(false);
    });
    it('a 65-code-point method is reported as never cut (display_unavailable), not "truncate"', () => {
      const r = EventEnvelopeSchema.safeParse(env('ApprovalRequested', { ...base, display: { ...base.display, method: 'f'.repeat(65) } }));
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.message).join(' ')).toContain('never cut: display_unavailable');
    });
  });
  it.each([
    ['local_change', { ...tool, category: 'local_change', targets: ['C:\\a.txt'], itemCount: '1' }],
    ['delete of many paths (full list + count, ruling 1r)', { ...tool, category: 'delete', paths: Array.from({ length: 500 }, (_, i) => `C:\\d\\f${String(i)}`), fileCount: '500' }],
    ['overwrite', { ...tool, category: 'overwrite', paths: ['C:\\a.txt'], fileCount: '1' }],
    ['external_send', { ...tool, category: 'external_send', recipients: ['sam@example.com'], channel: 'email', bodyUntrusted: 'hi' }],
    ['external_upload', { ...tool, category: 'external_upload', path: 'C:\\a.txt', destinationHost: 'files.example.com' }],
    ['purchase', { ...tool, category: 'purchase', merchant: 'Shop', amount: '19.99', currency: 'USD' }],
    ['install_or_elevate', { ...tool, category: 'install_or_elevate', package: 'p', publisher: 'q', version: '1.0', source: 'winget' }],
    ['security_setting', { ...tool, category: 'security_setting', setting: 'Firewall', currentValue: 'on', newValue: 'off' }],
    ['ui_action (app nested, no targetLabel, 1v)', ui],
    ['ui_action window.* method', { ...ui, method: 'window.focus' }],
    ['pre_dispatch (summaryUntrusted, 1v)', pre],
    ['pre_dispatch with an empty summaryUntrusted (stripped to nothing)', { ...pre, summaryUntrusted: '' }],
    ['codex_command', cmd],
    ['codex_command with escalation and network', { ...cmd, networkAccess: 'requested', escalation: ['Network access to pypi.org (https)', 'Allow similar commands without asking: pip install'] }],
    ['codex_command of exactly 8 KB', { ...cmd, commandLine: 'x'.repeat(8192) }],
    ['codex_command with 32 escalations', { ...cmd, escalation: Array.from({ length: 32 }, (_, i) => `e${String(i)}`) }],
    ['codex_file_change', files],
    ['codex_file_change of 500 paths', { ...files, paths: Array.from({ length: 500 }, (_, i) => `C:\\repo\\f${String(i)}.ts`), fileCount: '500' }],
    ['a 4096-byte path (never truncated)', { ...files, paths: ['C:\\' + 'd'.repeat(4093)], fileCount: '1' }],
    ['bidi override in a path (bound field, escaped when rendered: DOT-095 criterion 10)', { ...tool, category: 'delete', paths: ['C:\\a\u202Etxt.exe'], fileCount: '1' }],
    ['control char in a path (bound field)', { ...tool, category: 'delete', paths: ['C:\\a\n'], fileCount: '1' }],
    ['codex_file_change bidi in a path (bound field)', { ...files, paths: ['C:\\a\u202Egpj.exe'], fileCount: '1' }],
  ])('accepts a %s display', (_n, display) => {
    expect(okDisplay(display)).toBe(true);
  });
  it.each([
    ['no kind', { ...pre, kind: undefined }],
    ['unknown kind', { ...pre, kind: 'dialog' }],
    ['pre_dispatch with the old key summary (1v)', { ...pre, summaryUntrusted: undefined, summary: 'x' }],
    ['ui_action with targetLabel (1v)', { ...ui, targetLabel: 'Save button' }],
    ['ui_action with flat app fields (1v)', { kind: 'ui_action', category: 'local_change', method: 'ui.click', appName: 'Notepad', windowTitle: 'x', processImage: 'notepad.exe' }],
    ['ui_action missing app.processImage (ruling 1m)', { ...ui, app: { appName: 'Notepad', windowTitle: 'x' } }],
    ['ui_action extra app key', { ...ui, app: { ...ui.app, pid: '42' } }],
    ['ui_action processImage is a path', { ...ui, app: { ...ui.app, processImage: 'C:\\Windows\\notepad.exe' } }],
    ['ui_action with a non-UI method', { ...ui, method: 'files.delete' }],
    ['tool with a UI-action method', { ...tool, method: 'ui.click', category: 'overwrite', paths: ['C:\\a'], fileCount: '1' }],
    ['tool with a detail key (removed, 1v)', { ...tool, category: 'overwrite', paths: ['C:\\a'], fileCount: '1', detail: null }],
    ['omitted key', { kind: 'tool', category: 'delete', method: 'm', paths: ['C:\\a'], fileCount: '1' }],
    ['extra key', { ...tool, category: 'delete', paths: ['C:\\a'], fileCount: '1', title: 'Approve?' }],
    ["another kind's keys (pre_dispatch with method)", { ...pre, method: 'm' }],
    ['a path shortened with an ellipsis', { ...tool, category: 'delete', paths: ['C:\\a\u2026'], fileCount: '1' }],
    ['a path over 4096 bytes', { ...files, paths: ['C:\\' + 'd'.repeat(4094)], fileCount: '1' }],
    ['501 paths in a delete', { ...tool, category: 'delete', paths: Array.from({ length: 501 }, (_, i) => `p${String(i)}`), fileCount: '501' }],
    ['delete fileCount not the list length', { ...tool, category: 'delete', paths: ['a', 'b'], fileCount: '3' }],
    ['delete fileCount as a number (1v: strings)', { ...tool, category: 'delete', paths: ['a', 'b'], fileCount: 2 }],
    ['local_change itemCount null', { ...tool, category: 'local_change', targets: ['C:\\a'], itemCount: null }],
    ['over-long bodyUntrusted (200 code points)', { ...tool, category: 'external_send', recipients: ['a'], channel: 'email', bodyUntrusted: 'x'.repeat(201) }],
    ['external_send with the old key body', { ...tool, category: 'external_send', recipients: ['a'], channel: 'email', body: 'hi' }],
    ['untrusted summaryUntrusted not stripped (ruling 1t)', { ...pre, summaryUntrusted: 'ok\u202Ecod.exe' }],
    ['over-long summaryUntrusted', { ...pre, summaryUntrusted: 's'.repeat(501) }],
    ['codex_command over 8 KB', { ...cmd, commandLine: 'x'.repeat(8193) }],
    ['codex_command over 8 KB in UTF-8 bytes', { ...cmd, commandLine: '\u00e9'.repeat(4097) }],
    ['codex_command escalation null (1v: [] when none)', { ...cmd, escalation: null }],
    ['codex_command 33 escalations', { ...cmd, escalation: Array.from({ length: 33 }, (_, i) => `e${String(i)}`) }],
    ['codex_command escalation entry over 256 code points', { ...cmd, escalation: ['e'.repeat(257)] }],
    ['codex_command networkAccess as boolean (1v: strings)', { ...cmd, networkAccess: true }],
    ['codex_command old keys (command/cwd/network)', { kind: 'codex_command', category: 'local_change', command: 'x', cwd: 'C:\\repo', network: 'not_requested', escalation: [], reasonUntrusted: null }],
    ['codex_command with a method key', { ...cmd, method: 'item/commandExecution/requestApproval' }],
    ['codex_command workingDirectory over 4096 bytes', { ...cmd, workingDirectory: 'C:\\' + 'd'.repeat(4094) }],
    ['codex_command blank reasonUntrusted (null when blank)', { ...cmd, reasonUntrusted: '   ' }],
    ['codex_command over-long reasonUntrusted', { ...cmd, reasonUntrusted: 'r'.repeat(501) }],
    ['codex_file_change fileCount not the paths length', { ...files, fileCount: '3' }],
    ['codex_file_change old key count', { ...files, fileCount: undefined, count: 2 }],
    ['codex_file_change 501 paths', { ...files, paths: Array.from({ length: 501 }, (_, i) => `p${String(i)}`), fileCount: '501' }],
  ])('rejects a display: %s', (_n, display) => {
    expect(okDisplay(JSON.parse(JSON.stringify(display)) as { kind: string; category: string })).toBe(false);
  });
  it('requestSource is required and must fit display.kind (L226)', () => {
    expect(ok({ ...base, requestSource: undefined })).toBe(false);
    expect(ok({ ...base, requestSource: 'renderer' })).toBe(false);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...tool, category: 'delete', paths: ['C:\\a'], fileCount: '1' }, 'tool_host'],
      [ui, 'tool_host'],
      [cmd, 'codex'],
      [files, 'codex'],
      [pre, 'coordinator'],
    ];
    for (const [display, good] of cases) {
      for (const source of REQUEST_SOURCES) expect(ok({ ...base, category: display['category'], display, requestSource: source })).toBe(source === good);
    }
  });
  describe('pre_dispatch consistency (ruling 1r, L225)', () => {
    const ev = (d: Record<string, unknown>, e: Record<string, unknown> = {}) => ok({ ...base, category: 'local_change', risk: 'high', display: { ...pre, ...d }, requestSource: 'coordinator', ...e });
    const rep = { priorTaskId: 't0', priorSideEffect: 'unknown' };
    it('accepts matching category, risk, possibleRepeat and retryOfTaskId', () => {
      expect(ev({})).toBe(true);
      expect(ev({ possibleRepeat: 'unknown', retryOfTaskId: 't0' }, { possibleRepeat: rep })).toBe(true);
    });
    it.each([
      ['category differs', { category: 'delete' }, {}],
      ['risk differs', { risk: 'critical' }, {}],
      ['display.possibleRepeat without the event field', { possibleRepeat: 'unknown' }, {}],
      ['display.possibleRepeat null with the event field', { retryOfTaskId: 't0' }, { possibleRepeat: rep }],
      ['priorSideEffect differs', { possibleRepeat: 'committed', retryOfTaskId: 't0' }, { possibleRepeat: rep }],
      ['retryOfTaskId differs from priorTaskId', { possibleRepeat: 'unknown', retryOfTaskId: 't9' }, { possibleRepeat: rep }],
      ['retryOfTaskId null with possibleRepeat', { possibleRepeat: 'unknown', retryOfTaskId: null }, { possibleRepeat: rep }],
    ])('rejects: %s', (_n, d, e) => {
      expect(ev(d, e)).toBe(false);
    });
  });
  it('ApprovalResolved: decision expired (coordinator) and reason display_unavailable (desktop) are accepted with approved:false', () => {
    expect(ApprovalResolvedSchema.safeParse({ ...EXAMPLES.ApprovalResolved, decision: 'expired' }).success).toBe(true);
    expect(ApprovalResolvedSchema.safeParse({ ...EXAMPLES.ApprovalResolved, reason: 'display_unavailable' }).success).toBe(true);
    expect(APPROVAL_RESOLVED_DECISIONS).toEqual(['expired']);
    expect(APPROVAL_RESOLVED_REASONS).toEqual(['display_unavailable']);
  });
});

describe('CONTRACTS @ 6834524/1f3ac60 (rulings 1o/1p/1q): TaskProgress advisory keys, origin channel ids', () => {
  it('TaskProgress.redactedMetadata accepts awaitingClarification:boolean / turnsSoFar:number and rejects other types', () => {
    const tp = (m: Record<string, unknown>) => EventEnvelopeSchema.safeParse(env('TaskProgress', { ...EXAMPLES.TaskProgress, state: 'LISTENING', redactedMetadata: m })).success;
    expect(tp({ awaitingClarification: true, turnsSoFar: 2 })).toBe(true);
    expect(tp({ awaitingClarification: 'yes' })).toBe(false);
    expect(tp({ turnsSoFar: '2' })).toBe(false);
    expect(tp({ awaitingClarification: null })).toBe(false);
  });
  it('awaitingClarification:true is valid only with state LISTENING (ruling 1q)', () => {
    const tp = (state: string, m: Record<string, unknown>) => EventEnvelopeSchema.safeParse(env('TaskProgress', { ...EXAMPLES.TaskProgress, state, redactedMetadata: m })).success;
    expect(tp('LISTENING', { awaitingClarification: true })).toBe(true);
    for (const state of ['EXECUTING', 'CONFIRMING', 'STANDBY']) expect(tp(state, { awaitingClarification: true })).toBe(false);
    expect(tp('EXECUTING', { awaitingClarification: false })).toBe(true);
  });
  it('origin channel ids are the CONTRACTS L211 strings', () => {
    expect([VOICE_WORKER_CHANNEL, TRAY_IPC_CHANNEL]).toEqual(['voice_worker', 'tray_ipc']);
  });
});

