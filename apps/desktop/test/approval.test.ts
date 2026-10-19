/**
 * D14 / C-25: possible-repeat warning in the main-owned secure approval dialog
 * (tool-host-control DRAFT 8 §4.4, D14, C-25; CONTRACTS §3 ApprovalRequested.possibleRepeat).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRefused, ApprovalService, CATEGORY_LABELS, isCodexRequest, sameDisplayedRecord, stripUnsafe, windowAttentive } from '../src/main/approval/approvalService';
import { DesktopController, type PlatformHooks } from '../src/main/controller';
import { readFlags } from '../src/main/flags';
import { createIpcRouter } from '../src/main/ipc/router';
import type { SenderLike } from '../src/main/ipc/trust';
import { AutoStartManager } from '../src/main/lifecycle/autostart';
import { StubAuthAdapter, StubCoordinator, StubRuntimeStatus, StubVoiceService } from '../src/main/services/stubs';
import { SettingsStore } from '../src/main/settings/store';
import { approveEnabled, isWarningVisible } from '../src/renderer/approvalGate';
import { APPROVAL_PAGE, ApprovalViewSchema, POSSIBLE_REPEAT_WARNINGS, UNTRUSTED_CODEX_REASON_LABEL, UNTRUSTED_SUMMARY_LABEL, type ApprovalView } from '../src/shared/approval';
import { ControlActionSchema } from '../src/shared/ipc';
import { MenuItemIdSchema } from '../src/shared/states';
import { deriveMenu } from '../src/main/state/menuModel';
import { deriveTrayView } from '../src/main/state/trayModel';
import { snap } from './helpers';
import { APPROVAL_CATEGORIES, ApprovalRequestedSchema, ApprovalResolvedSchema, EventEnvelopeSchema, PRIOR_SIDE_EFFECTS, type ApprovalResolved } from '../src/shared/contracts.draft';
import { INVOKE_CHANNELS, INVOKE_KEYS, type IpcResult } from '../src/shared/ipc';
import { displayFor, sourceFor, withTempDir } from './helpers';
import { commandFromRender, renderBoundText, renderCodexCommand, textFromBound } from '../src/shared/commandRender';

const NOW = Date.parse('2026-10-19T07:00:00Z');
const NON_READ = APPROVAL_CATEGORIES.filter((c) => c !== 'read' && c !== 'navigate' && c !== 'credential_access');
const req = (patch: Record<string, unknown> = {}) => {
  const m: Record<string, unknown> = { taskId: 't2', actionId: 'a'.repeat(64), summary: 'Send the weekly report to Sam', risk: 'high', expiry: '2026-10-19T07:01:00Z', category: 'external_send', ...patch };
  const display = m['display'] ?? displayFor(m);
  return { display, requestSource: sourceFor(display), ...m };
};
const repeat = (priorSideEffect: 'committed' | 'possible' | 'unknown' = 'unknown') => ({ priorTaskId: 't1', priorSideEffect });

function service(opts: { attentive?: boolean; active?: string | null } = {}) {
  // Ruling 2e: the coordinator's single active task (ADR-0010); 't2' unless a test changes it.
  let active: string | null = opts.active === undefined ? 't2' : opts.active;
  const resolved: { taskId: string; payload: ApprovalResolved }[] = [];
  const log: string[] = [];
  let shows = 0;
  let closes = 0;
  let n = 0;
  let now = NOW;
  const timers: (() => void)[] = [];
  const gates: { dialogId: string; approveAfterMs: number | null }[] = [];
  const svc = new ApprovalService({
    resolve: (taskId, payload) => resolved.push({ taskId, payload }),
    show: () => shows++,
    close: () => closes++,
    log: (_l, m) => log.push(m),
    activeTaskId: () => active,
    now: () => now,
    newId: () => (++n).toString(16).padStart(64, '0'),
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
    gate: (dialogId, approveAfterMs) => gates.push({ dialogId, approveAfterMs }),
  });
  // Default: main reports the approval window visible and focused (window events).
  if (opts.attentive ?? true) svc.setWindowAttention(true);
  return {
    svc,
    gates,
    resolved,
    log,
    shows: () => shows,
    closes: () => closes,
    advance: (ms: number) => (now += ms),
    setActive: (taskId: string | null) => (active = taskId),
    fireTimers: () => timers.forEach((t) => t()),
  };
}

describe('ApprovalRequested.possibleRepeat schema (final E01 shape)', () => {
  it('priorSideEffect is exactly committed|possible|unknown (E01/E08 final)', () => {
    expect(PRIOR_SIDE_EFFECTS).toEqual(['committed', 'possible', 'unknown']);
  });
  it('accepts {priorTaskId, priorSideEffect} on every non-read category', () => {
    for (const category of NON_READ) for (const se of PRIOR_SIDE_EFFECTS) expect(ApprovalRequestedSchema.safeParse(req({ category, possibleRepeat: repeat(se) })).success).toBe(true);
  });
  it.each(PRIOR_SIDE_EFFECTS.flatMap((se) => [['read', se], ['navigate', se]] as const))('rejects possibleRepeat with category %s (%s) (CONTRACTS L214 @ 0d53abc)', (category, se) => {
    const r = ApprovalRequestedSchema.safeParse(req({ category, possibleRepeat: repeat(se) }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['possibleRepeat']);
  });
  it('mirror matches CONTRACTS L214: categories, priorSideEffect values and exact warning strings', () => {
    expect(APPROVAL_CATEGORIES).toEqual(['read', 'navigate', 'local_change', 'delete', 'overwrite', 'external_send', 'external_upload', 'purchase', 'install_or_elevate', 'security_setting', 'credential_access']);
    expect(PRIOR_SIDE_EFFECTS).toEqual(['committed', 'possible', 'unknown']);
    expect(POSSIBLE_REPEAT_WARNINGS).toEqual({
      committed: 'This action already happened; approving will do it again.',
      possible: 'This action may already have happened.',
      unknown: 'This action may already have happened.',
    });
  });
  it('category is required', () => {
    const noCategory: Record<string, unknown> = req();
    delete noCategory['category'];
    expect(ApprovalRequestedSchema.safeParse(noCategory).success).toBe(false);
  });
  it.each([
    ['old priorOutcome field', { priorTaskId: 't1', priorOutcome: 'postcondition_unknown' }],
    ['priorOutcome alongside', { priorTaskId: 't1', priorSideEffect: 'unknown', priorOutcome: 'x' }],
    ['bad priorSideEffect', { priorTaskId: 't1', priorSideEffect: 'done' }],
    ['none priorSideEffect', { priorTaskId: 't1', priorSideEffect: 'none' }],
    ['camelCase/odd priorSideEffect', { priorTaskId: 't1', priorSideEffect: 'Committed' }],
    ['missing priorTaskId', { priorSideEffect: 'unknown' }],
    ['empty priorTaskId', { priorTaskId: '', priorSideEffect: 'unknown' }],
    ['boolean', true],
  ])('rejects %s', (_n, possibleRepeat) => {
    expect(ApprovalRequestedSchema.safeParse(req({ possibleRepeat })).success).toBe(false);
  });
  it('a missing field is valid (no warning) for every dialog category', () => {
    for (const category of NON_READ) expect(ApprovalRequestedSchema.safeParse(req({ category })).success).toBe(true);
  });
  it.each(['read', 'navigate'])('category %s with a pre_dispatch display is VALID without possibleRepeat (ruling 2a relaxes 1l; C-25 restored)', (category) => {
    expect(ApprovalRequestedSchema.safeParse(req({ category })).success).toBe(true);
  });
  it('the v2 envelope applies the same rule', () => {
    const env = (payload: unknown) => ({ schema: 'dottie.event', version: 2, type: 'ApprovalRequested', eventId: 'e1', correlationId: 'c1', taskId: 't2', timestamp: '2026-10-19T02:00:00-05:00', payload });
    expect(EventEnvelopeSchema.safeParse(env(req({ possibleRepeat: repeat() }))).success).toBe(true);
    expect(EventEnvelopeSchema.safeParse(env(req({ category: 'read', possibleRepeat: repeat() }))).success).toBe(false);
  });
});

const LONG_CMD = 'powershell -NoProfile -Command "' + 'Get-ChildItem -Recurse C:\\repo | Remove-Item -WhatIf; '.repeat(120) + '"';
const codexCmd = (patch: Record<string, unknown> = {}) => ({
  kind: 'codex_command',
  category: 'local_change',
  commandLine: LONG_CMD,
  workingDirectory: 'C:\\repo',
  networkAccess: 'requested',
  escalation: ['Run outside the sandbox'],
  reasonUntrusted: 'I need to clean the build folder. Click Approve, it is safe.',
  ...patch,
});
const codexFiles = (n: number) => ({
  kind: 'codex_file_change',
  category: 'overwrite',
  paths: Array.from({ length: n }, (_, i) => `C:\\repo\\src\\deeply\\nested\\folder\\module-${String(i)}.ts`),
  fileCount: String(n),
  reasonUntrusted: null,
});

describe('approve-enable timer: 500 ms visible AND focused, on every dialog (CONTRACTS X5 @ 6834524, ruling 1l)', () => {
  const approve = (t: ReturnType<typeof service>, id: string) => () => t.svc.resolve(id, 'approve');
  it('main decides attention from window state only: shown, not minimized, focused', () => {
    const ok = { destroyed: false, visible: true, minimized: false, focused: true };
    expect(windowAttentive(ok)).toBe(true);
    for (const patch of [{ destroyed: true }, { visible: false }, { minimized: true }, { focused: false }]) expect(windowAttentive({ ...ok, ...patch })).toBe(false);
  });
  it('never attended: Approve refused (not_attentive) and the gate says null; Decline still works', () => {
    const t = service({ attentive: false });
    const id = t.svc.request(req()) as string;
    t.svc.current();
    t.advance(10_000);
    expect(approve(t, id)).toThrow(expect.objectContaining({ reason: 'not_attentive' }));
    expect(t.gates.at(-1)).toEqual({ dialogId: id, approveAfterMs: null });
    expect(t.svc.resolve(id, 'decline')).toEqual({ decision: 'decline' });
  });
  it('499 ms refused, 500 ms accepted; the gate tells the renderer how long to wait', () => {
    const t = service();
    const id = t.svc.request(req()) as string;
    t.svc.current();
    expect(t.gates.at(-1)).toEqual({ dialogId: id, approveAfterMs: 500 });
    t.advance(499);
    expect(approve(t, id)).toThrow(expect.objectContaining({ reason: 'not_attentive' }));
    t.advance(1);
    expect(t.svc.resolve(id, 'approve')).toEqual({ decision: 'approve' });
  });
  it.each(['blur', 'hide', 'minimize'])('%s resets the timer: it restarts from the next focus/show/restore', () => {
    const t = service();
    const id = t.svc.request(req()) as string;
    t.svc.current();
    t.advance(400);
    t.svc.setWindowAttention(false);
    expect(t.gates.at(-1)).toEqual({ dialogId: id, approveAfterMs: null });
    t.advance(1_000);
    expect(approve(t, id)).toThrow(expect.objectContaining({ reason: 'not_attentive' }));
    t.svc.setWindowAttention(true);
    expect(t.gates.at(-1)).toEqual({ dialogId: id, approveAfterMs: 500 });
    t.advance(499);
    expect(approve(t, id)).toThrow(expect.objectContaining({ reason: 'not_attentive' }));
    t.advance(1);
    expect(t.svc.resolve(id, 'approve')).toEqual({ decision: 'approve' });
  });
  it('the timer starts only once the view is on screen (focus before delivery does not count)', () => {
    const t = service();
    const id = t.svc.request(req()) as string;
    t.advance(5_000);
    t.svc.current();
    t.advance(499);
    expect(approve(t, id)).toThrow(expect.objectContaining({ reason: 'not_attentive' }));
  });
  it('a join neither resets nor extends the timer', () => {
    const t = service();
    const id = t.svc.request(req()) as string;
    t.svc.current();
    t.advance(300);
    t.svc.request(req());
    t.svc.current(); // reload after a join: same dialog, timer kept
    t.advance(200);
    expect(t.svc.resolve(id, 'approve')).toEqual({ decision: 'approve' });
  });
  it('the next dialog on screen gets its own fresh 500 ms', () => {
    const t = service();
    const a = t.svc.request(req()) as string;
    const b = t.svc.request(req({ actionId: 'b'.repeat(64) })) as string;
    t.svc.current();
    t.advance(2_000);
    t.svc.resolve(a, 'approve');
    expect((t.svc.current() as ApprovalView).dialogId).toBe(b);
    t.advance(499);
    expect(approve(t, b)).toThrow(expect.objectContaining({ reason: 'not_attentive' }));
    t.advance(1);
    expect(t.svc.resolve(b, 'approve')).toEqual({ decision: 'approve' });
  });
  it('warning dialogs need BOTH: the warning-shown confirmation + 500 ms, and 500 ms attended', () => {
    const t = service({ attentive: false });
    const id = t.svc.request(req({ possibleRepeat: repeat() })) as string;
    t.svc.current();
    t.svc.warningShown(id);
    t.advance(600);
    expect(approve(t, id)).toThrow(expect.objectContaining({ reason: 'not_attentive' })); // warning ok, never focused
    t.svc.setWindowAttention(true);
    t.advance(500);
    expect(t.svc.resolve(id, 'approve')).toEqual({ decision: 'approve' });

    const u = service();
    const id2 = u.svc.request(req({ possibleRepeat: repeat() })) as string;
    u.svc.current();
    u.advance(5_000); // attended long enough, but no warning confirmation yet
    expect(approve(u, id2)).toThrow(expect.objectContaining({ reason: 'warning_not_shown' }));
  });
  it('the renderer has no channel to report focus or attention', () => {
    expect(INVOKE_KEYS.some((k) => /focus|attent|visib|gate/i.test(k))).toBe(false);
  });
});

describe('pre_dispatch dialog shows the bound summaryUntrusted (ruling 1v)', () => {
  it('the untrusted slot comes from display.summaryUntrusted, not the event summary', () => {
    const t = service();
    const r = req({ category: 'local_change' });
    t.svc.request({ ...r, display: { ...(r.display as Record<string, unknown>), summaryUntrusted: 'Bound summary' } });
    const v = t.svc.current() as ApprovalView;
    expect(v.untrustedSummary).toBe('Bound summary');
    expect(v.untrustedLabel).toBe(UNTRUSTED_SUMMARY_LABEL);
  });
});

describe('Codex approval display in the dialog (CONTRACTS L221/L231 @ 1f3ac60, rulings 1o/1t)', () => {
  it('L231: a command with ESC, a lone CR, U+202E, tab and CRLF is accepted, nothing stripped; the stored display keeps the raw bytes', () => {
    const raw = 'echo \u001b[31mred\r\nline2\rX\u202Etxt.exe\tTAB  ';
    const t = service();
    const display = codexCmd({ commandLine: raw });
    t.svc.request(req({ category: 'local_change', display }));
    const v = t.svc.current() as ApprovalView;
    expect(v.codex?.command?.hiddenCharacters).toBe(true);
    expect(v.codex?.command?.lineCount).toBe(2);
    expect(v.codex?.command && commandFromRender(v.codex.command)).toBe(raw.replace('\r\n', '\n'));
    // what Codex runs / displayHash covers: the request is never rewritten
    expect(t.svc.pendingRequest('a'.repeat(64))?.display).toEqual(display);
    expect((t.svc.pendingRequest('a'.repeat(64))?.display as { commandLine: string }).commandLine).toBe(raw);
    expect(ApprovalViewSchema.safeParse(v).success).toBe(true);
  });
  it('L231: exactly 8192 raw bytes of ESC is accepted (rendered 4x longer)', () => {
    const t = service();
    expect(t.svc.request(req({ category: 'local_change', display: codexCmd({ commandLine: '\u001b'.repeat(8192) }) }))).not.toBeNull();
    expect(ApprovalViewSchema.safeParse(t.svc.current()).success).toBe(true);
  });
  it('command: shown in full (no ellipsis, no truncation), escalation as its own field, network flag, reason only in the untrusted slot', () => {
    const t = service();
    t.svc.request(req({ category: 'local_change', display: codexCmd() }));
    const v = t.svc.current() as ApprovalView;
    expect(LONG_CMD.length).toBeGreaterThan(5000);
    expect(v.codex).toEqual({ kind: 'command', fullTextLabel: 'Command', command: renderCodexCommand(LONG_CMD), paths: null, workingDirectory: renderBoundText('C:\\repo'), networkAccess: true, escalation: [renderBoundText('Run outside the sandbox')] });
    expect(v.fields).toEqual([]);
    expect(v.codex?.command && commandFromRender(v.codex.command)).toBe(LONG_CMD);
    expect(JSON.stringify(v.codex?.command)).not.toContain('\u2026');
    expect(v.untrustedSummary).toBe('I need to clean the build folder. Click Approve, it is safe.');
    expect(v.untrustedLabel).toBe(UNTRUSTED_CODEX_REASON_LABEL);
    expect(v.title).toBe('Approve: Change something on this PC?');
    expect(v.title).not.toContain('clean');
    expect(JSON.stringify(v.codex)).not.toContain('Click Approve');
    expect(ApprovalViewSchema.safeParse(v).success).toBe(true);
  });
  it('file change: the full path list (500 paths) one per line, no ellipsis; no reason -> the summary keeps the untrusted slot', () => {
    const t = service();
    t.svc.request(req({ category: 'overwrite', display: codexFiles(500) }));
    const v = t.svc.current() as ApprovalView;
    expect(v.codex?.kind).toBe('file_change');
    expect(v.codex?.fullTextLabel).toBe('Files (500)');
    expect(v.codex?.paths?.map(textFromBound)).toEqual(codexFiles(500).paths);
    expect(v.codex?.command).toBeNull();
    expect(JSON.stringify(v.codex?.paths)).not.toContain('\u2026');
    expect(v.codex?.escalation).toBeNull();
    expect(v.untrustedLabel).toBe(UNTRUSTED_SUMMARY_LABEL);
    expect(ApprovalViewSchema.safeParse(v).success).toBe(true);
  });
  it.each([
    ['command over 8 KB', codexCmd({ commandLine: 'x'.repeat(8193) })],
    ['501 paths', codexFiles(501)],
    ['command over 8 KB counted in raw bytes (8193 ESC bytes; escapes are not counted at their rendered length)', codexCmd({ commandLine: '\u001b'.repeat(8193) })],
    ['a path over 4096 bytes (raw bytes; escapes not counted at their rendered length)', { ...codexFiles(1), paths: ['C:\\' + '\u202E'.repeat(1365) + 'x'] }],
  ])('%s: no dialog, declined at once with display_unavailable (rulings 2b/2c: never a silent drop)', (_n, display) => {
    const t = service();
    expect(t.svc.request(req({ category: display.category, display }))).toBeNull();
    expect(t.shows()).toBe(0);
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), approved: false, timestamp: '2026-10-19T07:00:00.000Z', reason: 'display_unavailable' } }]);
    expect(ApprovalResolvedSchema.safeParse(t.resolved[0]?.payload).success).toBe(true);
    expect(t.log).toEqual(['An approval request could not be shown safely, so it was declined.']);
  });
  it('stripUnsafe removes control and bidi characters (defence in depth before the renderer)', () => {
    expect(stripUnsafe('a\u202Eb\u0000c\u2066d\u0085e\nf')).toBe('abcdef');
  });
  it('a non-Codex display has no Codex block', () => {
    const t = service();
    t.svc.request(req());
    expect(t.svc.current()?.codex).toBeNull();
  });
});

describe('rulings 2a/2b: Codex and pre_dispatch read/navigate open a dialog; a Codex approval is never silently dropped', () => {
  const DECLINED = { approved: false, timestamp: '2026-10-19T07:00:00.000Z', reason: 'display_unavailable' };
  const DECLINE_LOG = 'An approval request could not be shown safely, so it was declined.';
  it.each([
    ['codex_command', 'read', () => codexCmd({ category: 'read' })],
    ['codex_command', 'navigate', () => codexCmd({ category: 'navigate' })],
    ['codex_file_change', 'read', () => ({ ...codexFiles(2), category: 'read' })],
    ['codex_file_change', 'navigate', () => ({ ...codexFiles(2), category: 'navigate' })],
    ['pre_dispatch', 'read', () => undefined],
    ['pre_dispatch', 'navigate', () => undefined],
  ])('%s with category %s opens a dialog (ruling 2a; category passed through, no raise to local_change)', (kind, category, mk) => {
    const t = service();
    const display = mk();
    const id = t.svc.request(req({ category, ...(display ? { display } : {}) }));
    expect(id).not.toBeNull();
    expect(t.shows()).toBe(1);
    const v = t.svc.current() as ApprovalView;
    expect(ApprovalViewSchema.safeParse(v).success).toBe(true);
    expect(v.category).toBe(category);
    expect(v.title).toBe(`Approve: ${CATEGORY_LABELS[category as 'read' | 'navigate']}?`);
    expect(v.warning).toBeNull();
    expect(v.codex === null).toBe(kind === 'pre_dispatch');
    expect(t.svc.pendingRequest('a'.repeat(64))?.display.category).toBe(category);
    // still an ordinary dialog: Approve after the attention timer, one ApprovalResolved
    t.advance(500);
    expect(t.svc.resolve(v.dialogId, 'approve')).toEqual({ decision: 'approve' });
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), approved: true, timestamp: '2026-10-19T07:00:00.500Z' } }]);
  });
  it.each([
    ['display.category differs from the event (2b)', () => req({ category: 'local_change', display: codexCmd({ category: 'read' }) })],
    ['event category differs from display (2b, other direction)', () => req({ category: 'read', display: codexCmd() })],
    ['credential_access (2b: rejected for every kind)', () => req({ category: 'credential_access', display: codexCmd({ category: 'credential_access' }) })],
    ['an extra display key', () => req({ category: 'local_change', display: codexCmd({ title: 'Approve?' }) })],
    ['a codex display from the wrong source', () => ({ ...req({ category: 'local_change', display: codexCmd() }), requestSource: 'tool_host' })],
    ['requestSource codex with a tool display', () => ({ ...req(), requestSource: 'codex' })],
    ['writeStdin-like: no display', () => ({ ...req({ category: 'local_change', display: codexCmd() }), display: undefined, requestSource: 'codex' })],
    ['an unknown top-level field', () => ({ ...req({ category: 'local_change', display: codexCmd() }), threadId: 'th1' })],
  ])('Codex request with %s: no dialog, declined at once with display_unavailable', (_n, mk) => {
    const t = service();
    expect(t.svc.request(mk())).toBeNull();
    expect(t.shows()).toBe(0);
    expect(t.svc.size).toBe(0);
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    expect(t.log).toEqual([DECLINE_LOG]);
    // answered once: a re-delivery sends nothing more
    expect(t.svc.request(mk())).toBeNull();
    expect(t.resolved).toHaveLength(1);
  });
  it('the decline log carries no field values', () => {
    const t = service();
    t.svc.request(req({ category: 'local_change', display: codexCmd({ commandLine: 'rm -rf C:\\secret', title: 'x' }) }));
    expect(t.log.join(' ')).not.toMatch(/secret|rm -rf|t2|aaaa/);
  });
  it('a malformed Codex copy for an open dialog declines the whole joined set (join (f) fail closed)', () => {
    const t = service();
    const id = t.svc.request(req({ category: 'local_change', display: codexCmd() })) as string;
    t.svc.current();
    expect(t.svc.request(req({ category: 'local_change', display: codexCmd({ commandLine: '' }) }))).toBeNull();
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    expect(t.svc.size).toBe(0);
    expect(t.closes()).toBe(1);
    t.advance(500);
    expect(() => t.svc.resolve(id, 'approve')).toThrow(expect.objectContaining({ reason: 'unknown_or_used' }));
    expect(t.resolved).toHaveLength(1);
  });
  it('unidentifiable Codex request (no valid actionId/taskId): nothing can be answered, logged; the coordinator expiry ends it', () => {
    const t = service();
    expect(t.svc.request({ ...req({ category: 'local_change', display: codexCmd() }), actionId: 'nope', category: 'bogus' })).toBeNull();
    expect(t.svc.request({ requestSource: 'codex' })).toBeNull();
    expect(t.resolved).toEqual([]);
    expect(t.log).toEqual([
      'Ignored a malformed approval request that cannot be answered (no valid action id); the coordinator will let it expire.',
      'Ignored a malformed approval request that cannot be answered (no valid action id); the coordinator will let it expire.',
    ]);
  });
  it('a malformed Codex copy after the action was answered or locally expired sends nothing more (one answer per actionId)', () => {
    const t = service();
    const id = t.svc.request(req({ category: 'local_change', display: codexCmd() })) as string;
    t.svc.current();
    t.svc.resolve(id, 'decline');
    t.svc.request(req({ category: 'local_change', display: codexCmd({ commandLine: '' }) }));
    expect(t.resolved).toHaveLength(1);
    const t2 = service();
    t2.svc.request(req({ category: 'local_change', display: codexCmd() }));
    t2.advance(60_000);
    t2.svc.current(); // local expiry: shown disabled
    t2.svc.request(req({ category: 'local_change', display: codexCmd({ commandLine: '' }) }));
    expect(t2.resolved).toEqual([]);
  });
  it('a valid Codex request that arrives already expired: nothing sent (ruling 7: the coordinator C-08 expiry declines it to Codex)', () => {
    const t = service();
    expect(t.svc.request(req({ category: 'read', display: codexCmd({ category: 'read' }), expiry: '2026-10-19T06:59:59Z' }))).toBeNull();
    expect(t.resolved).toEqual([]);
    expect(t.log).toEqual(['An approval request arrived already expired, so nothing was done.']);
  });
  it('isCodexRequest: by requestSource or codex_* display kind only', () => {
    expect(isCodexRequest({ requestSource: 'codex' })).toBe(true);
    expect(isCodexRequest({ display: { kind: 'codex_command' } })).toBe(true);
    expect(isCodexRequest({ display: { kind: 'codex_file_change' } })).toBe(true);
    expect(isCodexRequest({ requestSource: 'tool_host', display: { kind: 'tool' } })).toBe(false);
    expect(isCodexRequest(null)).toBe(false);
    expect(isCodexRequest('codex')).toBe(false);
  });
  it('Codex read + possibleRepeat: declined with the rule named in the log (2c)', () => {
    const t = service();
    expect(t.svc.request(req({ category: 'read', display: codexCmd({ category: 'read' }), possibleRepeat: repeat() }))).toBeNull();
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    expect(t.log).toEqual(['An approval request was declined: a read or navigate action cannot carry a possible-repeat warning.']);
  });
  it('ruling 2b through the service: a 65-code-point tool method is refused (never cut), 64 opens a dialog', () => {
    const t = service();
    const tool = (method: string) => ({ kind: 'tool', category: 'delete', method, targetLabel: 'a.txt', paths: ['C:\\a.txt'], fileCount: '1' });
    expect(t.svc.request(req({ category: 'delete', display: tool('f'.repeat(65)) }))).toBeNull();
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    expect(t.svc.request(req({ actionId: 'b'.repeat(64), category: 'delete', display: tool('f'.repeat(64)) }))).not.toBeNull();
  });
});

describe('ruling 2c (dottie-e01 a147dbe): any unshowable ApprovalRequested is declined with display_unavailable, from every source', () => {
  const DECLINED = { approved: false, timestamp: '2026-10-19T07:00:00.000Z', reason: 'display_unavailable' };
  const LOG = 'An approval request could not be shown safely, so it was declined.';
  const toolDelete = { kind: 'tool', category: 'delete', method: 'files.delete', targetLabel: 'a.txt', paths: ['C:\\a.txt'], fileCount: '1' };
  const uiClick = { kind: 'ui_action', category: 'local_change', method: 'ui.click', app: { appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } };
  it.each([
    ['codex (codex_command with an extra key)', () => req({ category: 'local_change', display: codexCmd({ title: 'x' }) })],
    ['codex (codex_file_change, fileCount wrong)', () => req({ category: 'overwrite', display: { ...codexFiles(2), fileCount: '3' } })],
    ['tool_host (tool display, 65-code-point method)', () => req({ category: 'delete', display: { ...toolDelete, method: 'f'.repeat(65) } })],
    ['tool_host (ui_action, process image is a path)', () => req({ category: 'local_change', display: { ...uiClick, app: { ...uiClick.app, processImage: 'C:\\x\\notepad.exe' } } })],
    ['coordinator (pre_dispatch, risk mismatch)', () => req({ category: 'local_change', risk: 'low', display: { ...displayFor({ category: 'local_change', risk: 'high', summary: 's' }) } })],
    ['coordinator (pre_dispatch, category mismatch)', () => req({ category: 'delete', display: { ...displayFor({ category: 'local_change', risk: 'high', summary: 's' }) } })],
    ['unknown requestSource', () => ({ ...req(), requestSource: 'renderer' })],
    ['no requestSource at all', () => ({ ...req(), requestSource: undefined })],
    ['no display (any source)', () => ({ ...req(), display: undefined })],
    ['tool display from the coordinator (kind/source guard)', () => ({ ...req({ category: 'delete', display: toolDelete }), requestSource: 'coordinator' })],
    ['credential_access from the tool host', () => req({ category: 'credential_access', display: { ...toolDelete, category: 'credential_access' }, requestSource: 'tool_host' })],
  ])('%s: no dialog; ApprovalResolved{approved:false, reason:display_unavailable}; warning log without values', (_n, mk) => {
    const t = service();
    expect(t.svc.request(mk())).toBeNull();
    expect(t.shows()).toBe(0);
    expect(t.svc.size).toBe(0);
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    expect(ApprovalResolvedSchema.safeParse(t.resolved[0]?.payload).success).toBe(true);
    expect(t.log).toEqual([LOG]);
    expect(t.log.join(' ')).not.toMatch(/t2|aaaa|files\.delete|notepad|Send the weekly/i);
    // answered once per actionId: a re-delivery sends nothing more
    expect(t.svc.request(mk())).toBeNull();
    expect(t.resolved).toHaveLength(1);
  });
  it.each([
    ['tool_host', { category: 'delete', display: toolDelete }],
    ['coordinator', {}],
    ['codex', { category: 'local_change', display: codexCmd() }],
  ])('%s: a malformed copy for an open dialog declines the whole joined set', (_src, patch) => {
    const t = service();
    const id = t.svc.request(req(patch)) as string;
    t.svc.request(req(patch)); // a valid join
    expect(t.svc.joinedCount('a'.repeat(64))).toBe(2);
    t.svc.current();
    expect(t.svc.request({ ...req(patch), display: { kind: 'nope' } })).toBeNull();
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    expect(t.svc.size).toBe(0);
    t.advance(500);
    expect(() => t.svc.resolve(id, 'approve')).toThrow(expect.objectContaining({ reason: 'unknown_or_used' }));
  });
  it('a request whose view model cannot cross IPC (cannot be shown) is declined, never opened empty', () => {
    const t = service();
    const spy = vi.spyOn(ApprovalViewSchema, 'safeParse').mockReturnValueOnce({ success: false } as ReturnType<typeof ApprovalViewSchema.safeParse>);
    try {
      expect(t.svc.request(req())).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(t.shows()).toBe(0);
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    expect(t.log).toEqual([LOG]);
  });
  it('a valid Codex display with 32 escalations (the display maximum) is shown, not declined', () => {
    const t = service();
    expect(t.svc.request(req({ category: 'local_change', display: codexCmd({ escalation: Array.from({ length: 32 }, (_, i) => `e${String(i)}`) }) }))).not.toBeNull();
    expect(t.resolved).toEqual([]);
  });
  describe('the exceptions stand: nothing is sent', () => {
    it('no valid actionId (any source)', () => {
      const t = service();
      for (const src of ['tool_host', 'coordinator', 'codex']) expect(t.svc.request({ ...req(), actionId: 'A'.repeat(64), requestSource: src })).toBeNull();
      expect(t.svc.request({ ...req(), actionId: undefined })).toBeNull();
      expect(t.svc.request('garbage')).toBeNull();
      expect(t.resolved).toEqual([]);
      expect(new Set(t.log)).toEqual(new Set(['Ignored a malformed approval request that cannot be answered (no valid action id); the coordinator will let it expire.']));
    });
    it('already answered', () => {
      const t = service();
      const id = t.svc.request(req()) as string;
      t.svc.current();
      t.svc.resolve(id, 'decline');
      t.svc.request({ ...req(), display: undefined });
      expect(t.resolved).toHaveLength(1);
    });
    it('already expired (locally, or the coordinator settled it)', () => {
      const t = service();
      t.svc.request(req());
      t.advance(60_000);
      t.svc.current();
      t.svc.request({ ...req(), display: undefined });
      t.svc.settleExpired('b'.repeat(64));
      t.svc.request({ ...req({ actionId: 'b'.repeat(64) }), display: undefined });
      expect(t.resolved).toEqual([]);
    });
    it('the task has ended (TaskFinished): invalid AND valid requests for it send nothing and open nothing', () => {
      const t = service();
      t.setActive(null); // E03 @ 0714286: the active task is cleared before TaskFinished is emitted
      t.svc.dropTask('t2');
      expect(t.svc.request({ ...req(), display: undefined })).toBeNull();
      expect(t.svc.request(req({ actionId: 'b'.repeat(64) }))).toBeNull();
      expect(t.resolved).toEqual([]);
      expect(t.shows()).toBe(0);
      expect(t.log).toEqual([NOT_ACTIVE, NOT_ACTIVE]);
      // the next active task is unaffected
      t.setActive('t3');
      expect(t.svc.request({ ...req({ taskId: 't3' }), display: undefined })).toBeNull();
      expect(t.resolved).toEqual([{ taskId: 't3', payload: { actionId: 'a'.repeat(64), ...DECLINED } }]);
    });
  });
});

const NOT_ACTIVE = "Ignored an approval request that is not for the active task; the coordinator's expiry will close it.";

describe('active-task check (E01 ruling 2e, dottie-e01 23553dc; ADR-0010): no finished-task cache', () => {
  const DECLINED = { approved: false, timestamp: '2026-10-19T07:00:00.000Z', reason: 'display_unavailable' };
  const old = () => {
    // t1 ran, its approval was answered, and it finished; t2 is now the single active task.
    const t = service({ active: 't1' });
    const id = t.svc.request(req({ taskId: 't1', actionId: '1'.repeat(64) })) as string;
    t.svc.current();
    t.svc.resolve(id, 'decline');
    t.svc.dropTask('t1');
    t.setActive('t2');
    t.resolved.length = 0;
    t.log.length = 0;
    return t;
  };
  const shows = (t: ReturnType<typeof service>) => t.shows();

  it('old (finished) taskId: valid request opens nothing, sends nothing, logs without values', () => {
    const t = old();
    const before = shows(t);
    expect(t.svc.request(req({ taskId: 't1', actionId: '2'.repeat(64) }))).toBeNull();
    expect(t.svc.size).toBe(0);
    expect(shows(t)).toBe(before);
    expect(t.resolved).toEqual([]);
    expect(t.log).toEqual([NOT_ACTIVE]);
  });

  it('old (finished) taskId: an invalid/unshowable request is NOT declined either (2c exception)', () => {
    const t = old();
    expect(t.svc.request({ ...req({ taskId: 't1', actionId: '2'.repeat(64) }), display: undefined })).toBeNull();
    expect(t.resolved).toEqual([]);
    expect(t.log).toEqual([NOT_ACTIVE]);
  });

  it('old taskId stays inactive however many tasks finished since (no eviction: there is no cache)', () => {
    const t = service({ active: 't1' });
    t.svc.dropTask('t1');
    for (let i = 0; i < 1_000; i++) {
      t.setActive(`n${String(i)}`);
      t.svc.dropTask(`n${String(i)}`);
    }
    t.setActive('t2');
    expect(t.svc.request(req({ taskId: 't1' }))).toBeNull();
    expect(t.svc.request(req({ taskId: 'n0', actionId: '3'.repeat(64) }))).toBeNull();
    expect(t.resolved).toEqual([]);
    expect(t.shows()).toBe(0);
  });

  it('unknown taskId (never seen): opens nothing, sends nothing; also with no active task at all', () => {
    const t = service();
    expect(t.svc.request(req({ taskId: 'never-seen' }))).toBeNull();
    expect(t.svc.request({ ...req({ taskId: 'never-seen', actionId: '4'.repeat(64) }), display: undefined })).toBeNull();
    const idle = service({ active: null });
    expect(idle.svc.request(req())).toBeNull();
    expect(idle.svc.request({ ...req(), display: undefined })).toBeNull();
    for (const s of [t, idle]) {
      expect(s.resolved).toEqual([]);
      expect(s.shows()).toBe(0);
      expect(s.svc.size).toBe(0);
      expect(s.log).toEqual([NOT_ACTIVE, NOT_ACTIVE]);
      for (const v of ['never-seen', 't2', 'Send the weekly report', '4'.repeat(64), 'a'.repeat(64)]) expect(s.log.join(' ')).not.toContain(v);
    }
  });

  it('active taskId: opens normally; invalid requests for it are still declined (2c)', () => {
    const t = old();
    const id = t.svc.request(req({ taskId: 't2' }));
    expect(id).not.toBeNull();
    expect(t.svc.size).toBe(1);
    expect(t.svc.request({ ...req({ taskId: 't2', actionId: '5'.repeat(64) }), display: undefined })).toBeNull();
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: '5'.repeat(64), ...DECLINED } }]);
  });

  it('join and one-click rules are unchanged within the active task (answered actionId never reopens)', () => {
    const t = service();
    for (let i = 0; i < 300; i++) {
      const actionId = i.toString(16).padStart(64, '0');
      const id = t.svc.request(req({ actionId })) as string;
      t.svc.current();
      t.svc.resolve(id, 'decline');
    }
    // the first one is still remembered after 300 answers in the same task (no 256 eviction)
    expect(t.svc.request(req({ actionId: '0'.repeat(64) }))).toBeNull();
    expect(t.resolved).toHaveLength(300);
    expect(t.svc.size).toBe(0);
  });

  it('the coordinator expiry for a request that never opened closes nothing and sends nothing', () => {
    const t = old();
    expect(t.svc.settleExpired('2'.repeat(64), 't1')).toBe(false);
    expect(t.resolved).toEqual([]);
  });
});

describe('untrusted free-text slots: every hidden character of the pinned E02 set is stripped before the view (ruling 1t)', () => {
  const CHARS: [string, string][] = [
    ['zero-width space', '\u200B'],
    ['U+202E', '\u202E'],
    ['ESC', '\u001b'],
  ];
  const ui = { kind: 'ui_action', category: 'local_change', method: 'ui.click', app: { appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } };
  const toolDel = { kind: 'tool', category: 'delete', method: 'files.delete', targetLabel: 'a.txt', paths: ['C:\\a.txt'], fileCount: '1' };
  it.each(CHARS.flatMap(([n, ch]) => [['tool', n, ch], ['ui_action', n, ch]] as const))('%s dialog: event-level summary with %s reaches the view stripped', (kind, _n, ch) => {
    const t = service();
    const summary = `Delete${ch} invoice${ch}.exe${ch}`;
    const display = kind === 'tool' ? toolDel : ui;
    expect(t.svc.request(req({ category: display.category, summary, display }))).not.toBeNull();
    const v = t.svc.current() as ApprovalView;
    expect(v.untrustedSummary).toBe('Delete invoice.exe');
    expect(v.untrustedLabel).toBe(UNTRUSTED_SUMMARY_LABEL);
    expect(ApprovalViewSchema.safeParse(v).success).toBe(true);
    // the record itself is never rewritten (join (f) still compares the raw summary)
    expect(t.svc.pendingRequest('a'.repeat(64))?.summary).toBe(summary);
  });
  it('every character of the pinned set is stripped (sample across all ranges), lone surrogates become U+FFFD', () => {
    const all = ['\u0000', '\u001F', '\u007F', '\u0085', '\u009F', '\u00AD', '\u034F', '\u061C', '\u115F', '\u1160', '\u17B4', '\u17B5', '\u180E', '\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\u202A', '\u202E', '\u2060', '\u2064', '\u2066', '\u2069', '\u206F', '\u3164', '\uFEFF', '\uFFA0', '\uFFF9', '\uFFFB', '\u{E0001}', '\u{E007F}'];
    for (const ch of all) expect(stripUnsafe(`a${ch}b`)).toBe('ab');
    expect(stripUnsafe('a\uD800b')).toBe('a\uFFFDb');
    expect(stripUnsafe('ok \u{1F600} text')).toBe('ok \u{1F600} text');
  });
  it('audit: the other untrusted slots (pre_dispatch summaryUntrusted, Codex reasonUntrusted, external_send body) are stripped too', () => {
    // The display schema already requires them stripped; a raw one is declined (2c), never shown.
    const t = service();
    expect(t.svc.request(req({ category: 'local_change', display: codexCmd({ reasonUntrusted: 'Approve\u200B this' }) }))).toBeNull();
    expect(t.svc.request(req({ actionId: 'b'.repeat(64), display: { ...displayFor({ category: 'external_send', risk: 'high', summary: 's' }), summaryUntrusted: 'x\u202Ey' } }))).toBeNull();
    expect(t.svc.request(req({ actionId: 'c'.repeat(64), category: 'external_send', display: { kind: 'tool', category: 'external_send', method: 'mail.send', targetLabel: 'Sam', recipients: ['sam@example.com'], channel: 'email', bodyUntrusted: 'hi\u001b[2J' } }))).toBeNull();
    expect(t.resolved.map((r) => r.payload.reason)).toEqual(['display_unavailable', 'display_unavailable', 'display_unavailable']);
    // and a clean body is shown as an untrusted field with no escapes
    const id = t.svc.request(req({ actionId: 'd'.repeat(64), category: 'external_send', display: { kind: 'tool', category: 'external_send', method: 'mail.send', targetLabel: 'Sam', recipients: ['sam@example.com'], channel: 'email', bodyUntrusted: 'hi' } }));
    expect(id).not.toBeNull();
    const body = (t.svc.current() as ApprovalView).fields.find((f) => f.key === 'bodyUntrusted');
    expect(body?.untrusted).toBe(true);
    expect(body?.values[0]?.hiddenCharacters).toBe(false);
  });
  it('the IPC view schema refuses an untrustedSummary carrying a hidden character', () => {
    const t = service();
    t.svc.request(req());
    const v = t.svc.current() as ApprovalView;
    for (const [, ch] of CHARS) expect(ApprovalViewSchema.safeParse({ ...v, untrustedSummary: `a${ch}b` }).success).toBe(false);
  });
});

describe('Codex join (CONTRACTS L214 (c) @ 6834524, rulings 1o/1p)', () => {
  const codexReq = (patch: Record<string, unknown> = {}) => req({ category: 'local_change', display: codexCmd(), ...patch });
  it('two joined Codex requests + Approve: the desktop sends ONE approved ApprovalResolved for the actionId (the coordinator approves only the first requestId and declines the joined one)', () => {
    const t = service();
    const id = t.svc.request(codexReq()) as string;
    expect(t.svc.request(codexReq())).toBe(id);
    expect(t.svc.joinedCount('a'.repeat(64))).toBe(2);
    t.svc.current();
    t.advance(500);
    for (let i = 0; i < 3; i++) t.svc.resolve(id, 'approve');
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), approved: true, timestamp: '2026-10-19T07:00:00.500Z' } }]);
  });
  it('a redelivered Codex request after approved is dropped: no reopen, no second resolution', () => {
    const t = service();
    const id = t.svc.request(codexReq()) as string;
    t.svc.current();
    t.advance(500);
    t.svc.resolve(id, 'approve');
    expect(t.svc.request(codexReq())).toBeNull();
    expect(t.svc.size).toBe(0);
    expect(t.shows()).toBe(1);
    expect(t.resolved).toHaveLength(1);
  });
  it('copy canary: nothing the desktop logs for a joined Codex request says the user declined', () => {
    const t = service();
    const id = t.svc.request(codexReq()) as string;
    t.svc.request(codexReq());
    t.svc.current();
    t.advance(500);
    t.svc.resolve(id, 'approve');
    t.svc.request(codexReq());
    const all = t.log.join(' | ');
    expect(all).not.toMatch(/you declined|user_declined/i);
    expect(t.log).toEqual(['You approved the action.', 'Ignored an approval request for an action that was already answered or expired.']);
  });
  it('a joined Codex request with a different command fails closed (f): declined{display_unavailable}, never "you declined"', () => {
    const t = service();
    t.svc.request(codexReq());
    expect(t.svc.request(codexReq({ display: codexCmd({ commandLine: 'rm -rf C:\\' }) }))).toBeNull();
    expect(t.resolved.map((r) => r.payload)).toEqual([{ actionId: 'a'.repeat(64), approved: false, timestamp: '2026-10-19T07:00:00.000Z', reason: 'display_unavailable' }]);
    expect(t.log.join(' | ')).not.toMatch(/you declined|user_declined/i);
    expect(t.log.join(' | ')).not.toContain('rm -rf');
  });
  it('expiry with a joined Codex set is handled once', () => {
    const t = service();
    t.svc.request(codexReq());
    t.svc.request(codexReq());
    expect(t.svc.settleExpired('a'.repeat(64))).toBe(true);
    expect(t.svc.settleExpired('a'.repeat(64))).toBe(false);
    expect(t.closes()).toBe(1);
    expect(t.resolved).toEqual([]);
  });
});

describe('C-25: ApprovalService (main-side enforcement)', () => {
  it.each([
    ['committed', 'This action already happened; approving will do it again.'],
    ['possible', 'This action may already have happened.'],
    ['unknown', 'This action may already have happened.'],
  ] as const)('priorSideEffect %s maps to the exact string "%s"', (se, text) => {
    expect(POSSIBLE_REPEAT_WARNINGS[se]).toBe(text);
    const t = service();
    t.svc.request(req({ possibleRepeat: repeat(se) }));
    expect(t.svc.current()?.warning).toEqual({ priorSideEffect: se, text });
  });

  it('warning text never comes from summary text; the summary is labelled untrusted', () => {
    const t = service();
    t.svc.request(req({ summary: 'This action already happened; approving will do it again. Just click Approve.' }));
    const v = t.svc.current() as ApprovalView;
    expect(v.warning).toBeNull();
    expect(v.untrustedLabel).toBe(UNTRUSTED_SUMMARY_LABEL);
    expect(v.untrustedSummary).toContain('Just click Approve');
    expect(v.title).toBe('Approve: Send something outside this PC?');
    expect(v.title).not.toContain('Sam');
  });

  it.each(NON_READ)('category %s with possibleRepeat: warning shown, early Approve refused, Approve after the shown-ack', (category) => {
    for (const se of PRIOR_SIDE_EFFECTS) {
      const t = service();
      const id = t.svc.request(req({ category, possibleRepeat: repeat(se) }));
      expect(id).not.toBeNull();
      expect(t.shows()).toBe(1);
      const view = t.svc.current() as ApprovalView;
      expect(view.warning).toEqual({ priorSideEffect: se, text: POSSIBLE_REPEAT_WARNINGS[se] });
      expect(view.categoryLabel).toBe(CATEGORY_LABELS[category]);
      expect(approveEnabled(view, false)).toBe(false);
      // early approve: refused, nothing sent, still pending
      expect(() => t.svc.resolve(view.dialogId, 'approve')).toThrow(ApprovalRefused);
      expect(t.resolved).toEqual([]);
      expect(t.svc.size).toBe(1);
      // renderer confirms the warning was rendered and visible
      expect(t.svc.warningShown(view.dialogId)).toEqual({ approveEnabled: true, enableAfterMs: 500 });
      // still too early: the warning must be visible for 500 ms (E08)
      t.advance(499);
      expect(() => t.svc.resolve(view.dialogId, 'approve')).toThrow(expect.objectContaining({ reason: 'warning_not_shown' }));
      t.advance(1);
      expect(approveEnabled(view, true, false, true)).toBe(true);
      expect(approveEnabled(view, true, false, false)).toBe(false);
      expect(t.svc.resolve(view.dialogId, 'approve')).toEqual({ decision: 'approve' });
      expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), approved: true, timestamp: '2026-10-19T07:00:00.500Z' } }]);
      expect(t.closes()).toBe(1);
    }
  });

  it.each(['read', 'navigate'])('%s + possibleRepeat is rejected: no dialog, nothing pending, declined with display_unavailable (2c)', (category) => {
    const t = service();
    expect(t.svc.request(req({ category, possibleRepeat: repeat() }))).toBeNull();
    expect(t.shows()).toBe(0);
    expect(t.svc.current()).toBeNull();
    expect(t.resolved).toEqual([{ taskId: 't2', payload: { actionId: 'a'.repeat(64), approved: false, timestamp: '2026-10-19T07:00:00.000Z', reason: 'display_unavailable' } }]);
    expect(t.log).toEqual(['An approval request was declined: a read or navigate action cannot carry a possible-repeat warning.']);
  });

  it.each(NON_READ)('missing possibleRepeat (%s): no warning, Approve allowed without a shown-ack', (category) => {
    const t = service();
    t.svc.request(req({ category }));
    const view = t.svc.current() as ApprovalView;
    expect(view.warning).toBeNull();
    expect(approveEnabled(view, false, false, true)).toBe(true);
    // Every dialog: 500 ms visible + focused first (CONTRACTS X5 timer)
    expect(() => t.svc.resolve(view.dialogId, 'approve')).toThrow(expect.objectContaining({ reason: 'not_attentive' }));
    t.advance(500);
    expect(t.svc.resolve(view.dialogId, 'approve')).toEqual({ decision: 'approve' });
    expect(t.resolved[0]?.payload.approved).toBe(true);
  });

  it('Approve before the view was delivered is refused (even without a warning)', () => {
    const t = service();
    const id = t.svc.request(req()) as string;
    expect(() => t.svc.resolve(id, 'approve')).toThrow(expect.objectContaining({ reason: 'view_not_delivered' }));
    expect(() => t.svc.warningShown(id)).toThrow(expect.objectContaining({ reason: 'view_not_delivered' }));
  });

  it('Decline is always accepted for a live id, even before the warning was shown', () => {
    const t = service();
    t.svc.request(req({ possibleRepeat: repeat() }));
    const view = t.svc.current() as ApprovalView;
    expect(t.svc.resolve(view.dialogId, 'decline')).toEqual({ decision: 'decline' });
    expect(t.resolved[0]?.payload.approved).toBe(false);
  });

  it('dialog ids are single use and unforgeable: reuse, unknown and actionId-as-id are refused', () => {
    const t = service();
    t.svc.request(req());
    const view = t.svc.current() as ApprovalView;
    expect(view.dialogId).not.toBe('a'.repeat(64));
    expect(JSON.stringify(view)).not.toContain('a'.repeat(64));
    t.advance(500);
    t.svc.resolve(view.dialogId, 'approve');
    // a repeated identical click is idempotent; a different decision on a used id is refused
    expect(t.svc.resolve(view.dialogId, 'approve')).toEqual({ decision: 'approve' });
    expect(() => t.svc.resolve(view.dialogId, 'decline')).toThrow(expect.objectContaining({ reason: 'unknown_or_used' }));
    expect(() => t.svc.resolve('a'.repeat(64), 'approve')).toThrow(expect.objectContaining({ reason: 'unknown_or_used' }));
    expect(() => t.svc.resolve('f'.repeat(64), 'decline')).toThrow(expect.objectContaining({ reason: 'unknown_or_used' }));
    expect(t.resolved).toHaveLength(1);
  });

  it('a warning-shown ack for one dialog does not unlock another', () => {
    const t = service();
    t.svc.request(req({ possibleRepeat: repeat() }));
    t.svc.request(req({ actionId: 'b'.repeat(64), possibleRepeat: repeat() }));
    const first = t.svc.current() as ApprovalView;
    t.svc.warningShown(first.dialogId);
    t.advance(500);
    t.svc.resolve(first.dialogId, 'approve');
    const second = t.svc.current() as ApprovalView;
    expect(second.dialogId).not.toBe(first.dialogId);
    expect(() => t.svc.resolve(second.dialogId, 'approve')).toThrow(expect.objectContaining({ reason: 'warning_not_shown' }));
  });

  it('local expiry: Approve and Decline refused, dialog stays open (expired view), nothing sent; closes on the coordinator outcome', () => {
    const t = service();
    t.svc.request(req({ possibleRepeat: repeat() }));
    const view = t.svc.current() as ApprovalView;
    t.svc.warningShown(view.dialogId);
    t.advance(61_000);
    expect(() => t.svc.resolve(view.dialogId, 'approve')).toThrow(expect.objectContaining({ reason: 'expired' }));
    expect(() => t.svc.resolve(view.dialogId, 'decline')).toThrow(expect.objectContaining({ reason: 'expired' }));
    expect(() => t.svc.warningShown(view.dialogId)).toThrow(expect.objectContaining({ reason: 'expired' }));
    expect(t.resolved).toEqual([]);
    expect(t.svc.size).toBe(1);
    expect(t.closes()).toBe(0);
    const expiredView = t.svc.current() as ApprovalView;
    expect(expiredView).toMatchObject({ dialogId: view.dialogId, expired: true });
    expect(approveEnabled(expiredView, true)).toBe(false);
    expect(t.svc.settleExpired('a'.repeat(64))).toBe(true);
    expect(t.svc.size).toBe(0);
    expect(t.closes()).toBe(1);
    expect(t.resolved).toEqual([]);
    // timer path: re-renders (show), never sends
    const u = service();
    u.svc.request(req());
    u.fireTimers();
    expect(u.svc.size).toBe(1);
    expect(u.shows()).toBe(2);
    expect(u.resolved).toEqual([]);
    u.svc.dropTask('t2');
    expect(u.closes()).toBe(1);
    // an already-expired request never opens
    const w = service();
    expect(w.svc.request(req({ expiry: '2026-10-19T06:59:59Z' }))).toBeNull();
  });

  it('malformed requests are refused', () => {
    const t = service();
    expect(t.svc.request(req({ category: 'credential_access' }))).toBeNull();
    expect(t.svc.request(req({ extra: 1 }))).toBeNull();
    expect(t.svc.size).toBe(0);
  });

  it.each([
    ['identical re-send', req({ possibleRepeat: repeat('possible') })],
    ['same record, different key order', Object.fromEntries(Object.entries(req({ possibleRepeat: repeat('possible') })).reverse())],
  ])('same actionId JOINS the open dialog (%s): same id, display unchanged, no reload', (_n, second) => {
    const t = service();
    const id = t.svc.request(req({ possibleRepeat: repeat('possible') }));
    const shown = t.svc.current() as ApprovalView;
    expect(t.svc.request(second)).toBe(id);
    expect(t.svc.size).toBe(1);
    expect(t.svc.joinedCount('a'.repeat(64))).toBe(2);
    expect(t.shows()).toBe(1);
    expect(t.svc.current()).toEqual(shown);
  });

  it('a different actionId gets a different dialog', () => {
    const t = service();
    const a = t.svc.request(req());
    const b = t.svc.request(req({ actionId: 'b'.repeat(64) }));
    expect(b).not.toBe(a);
    expect(t.svc.size).toBe(2);
  });

  it('E08 (a): a join keeps the original expiry and the original 500 ms warning timer', () => {
    const t = service();
    t.svc.request(req({ possibleRepeat: repeat() }));
    const v = t.svc.current() as ApprovalView;
    t.svc.warningShown(v.dialogId);
    t.advance(300);
    expect(t.svc.request(req({ possibleRepeat: repeat() }))).toBe(v.dialogId);
    // warning timer not reset: re-ack reports the original remaining time
    expect(t.svc.warningShown(v.dialogId)).toEqual({ approveEnabled: true, enableAfterMs: 200 });
    t.advance(200);
    expect(t.svc.current()?.expiresAt).toBe('2026-10-19T07:01:00Z');
    // expiry not extended: still expires at the original 07:01:00
    t.advance(59_500);
    expect(() => t.svc.resolve(v.dialogId, 'approve')).toThrow(expect.objectContaining({ reason: 'expired' }));
  });

  describe("ruling 1t (4): a joined copy's own expiry is ignored, not declined (CONTRACTS L214 (b)/(f) @ 1f3ac60)", () => {
    it.each([
      ['later', '2026-10-19T07:05:00Z'],
      ['earlier', '2026-10-19T07:00:30Z'],
    ])('a %s expiry joins the same dialog; the first expiresAt is kept; nothing is sent', (_n, expiry) => {
      const u = service();
      const id = u.svc.request(req({ possibleRepeat: repeat() })) as string;
      expect(u.svc.request(req({ possibleRepeat: repeat(), expiry }))).toBe(id);
      expect(u.svc.joinedCount('a'.repeat(64))).toBe(2);
      expect(u.resolved).toEqual([]);
      expect(u.closes()).toBe(0);
      expect(u.svc.current()?.expiresAt).toBe('2026-10-19T07:01:00Z');
      expect(u.log).toEqual([]);
    });
    it('a later joined expiry can never extend the dialog: it still expires at the first expiresAt', () => {
      const u = service();
      const id = u.svc.request(req()) as string;
      u.svc.request(req({ expiry: '2026-10-19T07:05:00Z' }));
      u.advance(60_000);
      expect(() => u.svc.resolve(id, 'approve')).toThrow(expect.objectContaining({ reason: 'expired' }));
      expect(u.resolved).toEqual([]);
    });
    it('an earlier joined expiry does not shorten it either: Approve still works before the first expiresAt', () => {
      const u = service();
      const id = u.svc.request(req()) as string;
      u.svc.request(req({ expiry: '2026-10-19T07:00:10Z' }));
      u.svc.current(); // view delivered
      u.advance(20_000);
      expect(u.svc.resolve(id, 'approve')).toEqual({ decision: 'approve' });
      expect(u.resolved.map((r) => r.payload.approved)).toEqual([true]);
    });
  });

  describe('join condition (f) FAIL CLOSED: a joined request with different displayed content or CR2 inputs (CONTRACTS @ f4784ee, rulings 1m/1n/1t/1w)', () => {
    const variants: [string, Record<string, unknown>][] = [
      ['summary', { summary: 'Send it to everyone' }],
      ['category', { category: 'delete' }],
      ['risk', { risk: 'critical' }],
      ['possibleRepeat added', { possibleRepeat: repeat('committed') }],
      ['possibleRepeat removed', { possibleRepeat: undefined }],
      ['possibleRepeat priorSideEffect', { possibleRepeat: repeat('possible') }],
      ['possibleRepeat priorTaskId', { possibleRepeat: { priorTaskId: 't0', priorSideEffect: 'unknown' } }],
      ['display only', { display: { ...displayFor(req({ possibleRepeat: repeat() })), summaryUntrusted: 'Something else' } }],
      // Ruling 1w: CR2 inputs. Same actionId with a different taskId or requestSource fails closed.
      ['taskId (CR2 input, ruling 1w)', { taskId: 't9' }],
      ['display.kind only (same keys otherwise impossible: tool display)', { display: { kind: 'tool', category: 'external_send', method: 'mail.send', targetLabel: 'Sam', recipients: ['sam@example.com'], channel: 'email', bodyUntrusted: 'Weekly report' }, requestSource: 'tool_host' }],
    ];
    it.each(variants)('differing %s: whole set declined once with reason display_unavailable (no decision), dialog closed, Approve refused', (_n, patch) => {
      const t = service();
      const id = t.svc.request(req({ possibleRepeat: repeat() })) as string;
      t.svc.request(req({ possibleRepeat: repeat() })); // an identical join first: the set has 2
      const v = t.svc.current() as ApprovalView;
      t.svc.warningShown(v.dialogId);
      t.advance(500); // Approve would otherwise be allowed now
      const second: Record<string, unknown> = { ...req({ possibleRepeat: repeat() }), ...patch };
      if (patch['possibleRepeat'] === undefined && Object.hasOwn(patch, 'possibleRepeat')) delete second['possibleRepeat'];
      expect(t.svc.request({ ...second, display: patch['display'] ?? displayFor(second) })).toBeNull();
      expect(t.resolved).toHaveLength(1);
      expect(t.resolved[0]).toEqual({ taskId: 't2', payload: { actionId: 'a'.repeat(64), approved: false, timestamp: '2026-10-19T07:00:00.500Z', reason: 'display_unavailable' } });
      expect(t.resolved[0]?.payload).not.toHaveProperty('decision');
      expect(t.svc.size).toBe(0);
      expect(t.closes()).toBe(1);
      expect(t.svc.current()).toBeNull();
      expect(() => t.svc.resolve(id, 'approve')).toThrow(expect.objectContaining({ reason: 'unknown_or_used' }));
      expect(t.svc.resolve(id, 'decline')).toEqual({ decision: 'decline' }); // idempotent with the auto-decline; nothing more sent
      expect(t.svc.request(req({ possibleRepeat: repeat() }))).toBeNull(); // later joins dropped, no reopen
      expect(t.resolved).toHaveLength(1);
      expect(t.log[0]).toBe('A repeated approval request did not match the one on screen, so the action was declined for safety.');
      for (const value of ['Send it to everyone', 'Send the weekly report to Sam', 't9', 't0', 'Something else', 'critical', '07:00:30']) expect(t.log.join(' ')).not.toContain(value);
    });
    it('requestSource (CR2 input, ruling 1w): a joined copy of the same actionId from another requestSource -> whole set declined, no values logged', () => {
      // The kind/source guard (L226) ties requestSource to display.kind, so a schema-valid copy with a
      // different requestSource always carries a different display kind too. The isolated field check is
      // the sameDisplayedRecord test below.
      const t = service();
      const r = req({ category: 'local_change', display: codexCmd({ reasonUntrusted: null }) }) as Record<string, unknown>;
      expect(r['requestSource']).toBe('codex');
      const id = t.svc.request(r) as string;
      t.svc.request(r); // identical join first
      t.svc.current();
      t.advance(500);
      const joined = { ...r, requestSource: 'tool_host', display: { kind: 'tool', category: 'local_change', method: 'files.write', targetLabel: 'repo', targets: ['C:\\repo'], itemCount: '1' } };
      // a guard-valid copy (tool + tool_host) of the same actionId: display AND requestSource differ
      expect(t.svc.request(joined)).toBeNull();
      expect(t.resolved.map((x) => x.payload)).toEqual([{ actionId: 'a'.repeat(64), approved: false, timestamp: '2026-10-19T07:00:00.500Z', reason: 'display_unavailable' }]);
      expect(() => t.svc.resolve(id, 'approve')).toThrow(expect.objectContaining({ reason: 'unknown_or_used' }));
      expect(t.log.join(' ')).not.toMatch(/tool_host|codex|files\.write/);
    });
    it('requestSource alone (display identical): fails closed via sameDisplayedRecord', () => {
      const a = req({ category: 'local_change' }) as unknown as Parameters<typeof sameDisplayedRecord>[0];
      expect(sameDisplayedRecord(a, { ...a })).toBe(true);
      expect(sameDisplayedRecord(a, { ...a, requestSource: 'tool_host' })).toBe(false);
      expect(sameDisplayedRecord(a, { ...a, taskId: 't9' })).toBe(false);
      expect(sameDisplayedRecord(a, { ...a, expiry: '2026-10-19T07:05:00Z' })).toBe(true);
    });
    it('another open dialog (different actionId) is not affected', () => {
      const t = service();
      t.svc.request(req());
      const b = t.svc.request(req({ actionId: 'b'.repeat(64) }));
      t.svc.request(req({ summary: 'changed' }));
      expect(t.svc.size).toBe(1);
      expect(t.closes()).toBe(0);
      expect((t.svc.current() as ApprovalView).dialogId).toBe(b);
    });
  });

  it('E08 (b): a join after the dialog was resolved, expired or settled never reopens it', () => {
    const t = service();
    t.svc.request(req());
    const v = t.svc.current() as ApprovalView;
    t.svc.resolve(v.dialogId, 'decline');
    expect(t.svc.request(req())).toBeNull();
    expect(t.svc.size).toBe(0);
    expect(t.shows()).toBe(1);

    const u = service();
    u.svc.request(req());
    u.advance(61_000);
    u.svc.current(); // notices expiry
    expect(u.svc.request(req({ expiry: '2026-10-19T07:10:00Z' }))).toBeNull();
    expect(u.svc.joinedCount('a'.repeat(64))).toBe(1);
    u.svc.settleExpired('a'.repeat(64));
    expect(u.svc.request(req({ expiry: '2026-10-19T07:10:00Z' }))).toBeNull();
    expect(u.svc.size).toBe(0);

    const w = service();
    w.svc.request(req());
    w.setActive(null);
    w.svc.dropTask('t2');
    expect(w.svc.request(req())).toBeNull();
  });

  it('E08 (c): one Approve resolves the joined set exactly once; double clicks are idempotent', () => {
    const t = service();
    t.svc.request(req({ possibleRepeat: repeat() }));
    t.svc.request(req({ possibleRepeat: repeat() }));
    t.svc.request(req({ possibleRepeat: repeat() }));
    const v = t.svc.current() as ApprovalView;
    t.svc.warningShown(v.dialogId);
    t.advance(500);
    for (let i = 0; i < 5; i++) expect(t.svc.resolve(v.dialogId, 'approve')).toEqual({ decision: 'approve' });
    expect(t.resolved).toHaveLength(1);
    expect(t.resolved[0]?.payload).toMatchObject({ actionId: 'a'.repeat(64), approved: true });
    // a late duplicate after the answer cannot create a second approval
    expect(t.svc.request(req({ possibleRepeat: repeat() }))).toBeNull();
    expect(t.resolved).toHaveLength(1);
  });

  it('dropTask clears pending approvals for an ended task without sending a decision', () => {
    const t = service();
    t.svc.request(req());
    t.svc.dropTask('t2');
    expect(t.svc.size).toBe(0);
    expect(t.resolved).toEqual([]);
  });
});

describe('approval dialog gate (renderer, DOM-free rules)', () => {
  const base = { documentVisible: true, intersectionRatio: 1, width: 300, height: 60, display: 'block', visibility: 'visible', opacity: 1 };
  it('warning counts as visible only when fully on screen and not hidden', () => {
    expect(isWarningVisible(base)).toBe(true);
    for (const patch of [{ documentVisible: false }, { intersectionRatio: 0.5 }, { width: 0 }, { height: 0 }, { display: 'none' }, { visibility: 'hidden' }, { opacity: 0 }]) {
      expect(isWarningVisible({ ...base, ...patch })).toBe(false);
    }
  });
  it('Approve disabled with no view', () => {
    expect(approveEnabled(null, true)).toBe(false);
  });
});

describe('C-25 end to end through the controller and IPC router', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const APPROVAL: SenderLike = { senderFrame: { url: `app://dottie${APPROVAL_PAGE}`, parent: null } };
  const MAIN: SenderLike = { senderFrame: { url: 'app://dottie/index.html#settings', parent: null } };

  async function setup(dir: string) {
    const store = new SettingsStore({ dir });
    await store.load();
    const autostart = new AutoStartManager(
      { getLoginItemSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }), setLoginItemSettings: () => undefined },
      { platform: 'win32', isPackaged: true, isMsix: false, execPath: 'C:\\Dottie\\Dottie.exe' },
    );
    const coordinator = new StubCoordinator();
    const hooks: PlatformHooks & { approvalShown: number; approvalClosed: number } = {
      platform: 'linux',
      version: '0.1.0',
      approvalShown: 0,
      approvalClosed: 0,
      openExternal: () => Promise.resolve(),
      pickFolder: () => Promise.resolve(null),
      showWindow: () => undefined,
      showApproval: () => hooks.approvalShown++,
      closeApproval: () => hooks.approvalClosed++,
      quit: () => undefined,
    };
    const controller = new DesktopController({
      store,
      autostart,
      auth: new StubAuthAdapter('signed_in'),
      voice: new StubVoiceService(),
      coordinator,
      runtime: new StubRuntimeStatus('running'),
      flags: readFlags({}),
      hooks,
    });
    await controller.init();
    controller.approvals.setWindowAttention(true); // main's window events: visible + focused
    coordinator.set('EXECUTING', true, 't2'); // ruling 2e: t2 is the single active task
    const router = createIpcRouter(controller.handlers());
    const call = async <T>(channel: string, sender: SenderLike, arg?: unknown) => (await router.handle(channel, sender, arg === undefined ? [] : [arg])) as IpcResult<T>;
    return { controller, coordinator, hooks, call };
  }
  const future = () => new Date(Date.now() + 60_000).toISOString();

  describe('terminal events (ruling 2g, CONTRACTS 90ceed5): TaskFinished and TaskCancelled end only the active task', () => {
    const cancelled = (taskId: string) => ({ taskId, stopStatus: 'stopped_no_side_effects', sideEffects: 'none', sideEffectsCommitted: false, committedActions: [], report: 'Stopped before anything changed.' });
    const finished = (taskId: string) => ({ taskId, outcome: 'answered', verified: false, summary: 'Done.' });

    it('TaskCancelled for the active task ends it: its dialog closes, nothing is sent, a later request opens nothing', async () => {
      await withTempDir(async (dir) => {
        const t = await setup(dir);
        t.coordinator.requestApproval(req({ expiry: future() }));
        expect(t.controller.approvals.size).toBe(1);
        t.coordinator.cancel(cancelled('t2')); // like E03 0714286: active cleared before the emit
        expect(t.coordinator.getState().activeTaskId).toBeNull();
        expect(t.controller.approvals.size).toBe(0);
        expect(t.hooks.approvalClosed).toBe(1);
        const shown = t.hooks.approvalShown;
        t.coordinator.requestApproval(req({ actionId: 'b'.repeat(64), expiry: future() }));
        t.coordinator.requestApproval({ ...req({ actionId: 'c'.repeat(64), expiry: future() }), display: undefined });
        expect(t.controller.approvals.size).toBe(0);
        expect(t.hooks.approvalShown).toBe(shown);
        expect(t.coordinator.resolutions).toEqual([]);
      });
    });

    it.each([
      ['TaskCancelled', (c: StubCoordinator) => c.cancel(cancelled('t1'))],
      ['TaskFinished', (c: StubCoordinator) => c.finish(finished('t1'))],
    ] as const)('%s for an old taskId leaves the newer active task alone', async (_name, emit) => {
      await withTempDir(async (dir) => {
        const t = await setup(dir); // t2 is active; t1 is an older task
        t.coordinator.requestApproval(req({ expiry: future() }));
        emit(t.coordinator);
        expect(t.controller.approvals.size).toBe(1); // t2's dialog stays open
        expect(t.hooks.approvalClosed).toBe(0);
        expect(t.controller.approvals.dropTask('t9')).toBe(0); // unknown id: also a no-op
        expect(t.coordinator.getState().activeTaskId).toBe('t2');
        t.coordinator.requestApproval(req({ actionId: 'b'.repeat(64), expiry: future() }));
        expect(t.controller.approvals.size).toBe(2); // t2 still active: a new request opens
        expect(t.coordinator.resolutions).toEqual([]);
      });
    });

    it('TaskFinished for the active task ends it the same way; the late old event afterwards changes nothing', async () => {
      await withTempDir(async (dir) => {
        const t = await setup(dir);
        t.coordinator.finish(finished('t2'));
        t.coordinator.requestApproval(req({ expiry: future() }));
        expect(t.controller.approvals.size).toBe(0);
        t.coordinator.set('EXECUTING', true, 't3'); // the coordinator moves on to t3
        t.coordinator.cancel(cancelled('t2')); // late terminal event for the old task
        t.coordinator.finish(finished('t2'));
        t.coordinator.requestApproval(req({ taskId: 't3', expiry: future() }));
        expect(t.controller.approvals.size).toBe(1);
        expect(t.coordinator.resolutions).toEqual([]);
      });
    });

    it('a malformed TaskCancelled is logged without values and ends nothing', async () => {
      await withTempDir(async (dir) => {
        const t = await setup(dir);
        t.coordinator.requestApproval(req({ expiry: future() }));
        t.coordinator.cancel({ taskId: 't2', stopStatus: 'nope' });
        expect(t.controller.approvals.size).toBe(1);
        expect(t.controller.activity.list()[0]?.message).toBe('Ignored a malformed TaskCancelled event from the coordinator.');
      });
    });
  });

  it.each(NON_READ)('%s retry: warning view, early Approve FORBIDDEN, Approve after warning-shown sends ApprovalResolved', async (category) => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.requestApproval(req({ category, expiry: future(), possibleRepeat: repeat() }));
      expect(t.hooks.approvalShown).toBe(1);
      const got = await t.call<{ approval: ApprovalView }>(INVOKE_CHANNELS.getApproval, APPROVAL);
      if (!got.ok) throw new Error('getApproval failed');
      const { dialogId, warning } = got.data.approval;
      expect(warning).toEqual({ priorSideEffect: 'unknown', text: 'This action may already have happened.' });
      expect(dialogId).toMatch(/^[0-9a-f]{64}$/);
      expect(dialogId).not.toBe('a'.repeat(64));
      const early = await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId, decision: 'approve' });
      expect(early).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Approve is not available until the warning has been shown.' } });
      expect((await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId, decision: 'approve' })).ok).toBe(false);
      expect(t.coordinator.resolutions).toEqual([]);
      // main window can never ack or resolve
      expect((await t.call(INVOKE_CHANNELS.approvalWarningShown, MAIN, { dialogId })).ok).toBe(false);
      expect((await t.call(INVOKE_CHANNELS.resolveApproval, MAIN, { dialogId, decision: 'approve' })).ok).toBe(false);
      expect(await t.call(INVOKE_CHANNELS.approvalWarningShown, APPROVAL, { dialogId })).toEqual({ ok: true, data: { approveEnabled: true, enableAfterMs: 500 } });
      expect((await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId, decision: 'approve' })).ok).toBe(false); // < 500 ms
      vi.setSystemTime(Date.now() + 500);
      expect(await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId, decision: 'approve' })).toEqual({ ok: true, data: { decision: 'approve' } });
      expect(t.coordinator.resolutions).toHaveLength(1);
      expect(t.coordinator.resolutions[0]).toMatchObject({ taskId: 't2', resolved: { actionId: 'a'.repeat(64), approved: true } });
      expect(t.hooks.approvalClosed).toBe(1);
      // repeated click: idempotent, nothing more sent; a flip to decline is refused
      expect((await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId, decision: 'approve' })).ok).toBe(true);
      expect((await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId, decision: 'decline' })).ok).toBe(false);
      expect(t.coordinator.resolutions).toHaveLength(1);
    });
  });

  it('read + possibleRepeat is rejected (no dialog); a read retry without it opens a fresh dialog with no warning (C-25, ruling 2a)', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.requestApproval(req({ category: 'read', expiry: future(), possibleRepeat: repeat('possible') }));
      expect(t.hooks.approvalShown).toBe(0);
      expect(await t.call(INVOKE_CHANNELS.getApproval, APPROVAL)).toEqual({ ok: true, data: { approval: null } });
      expect(t.controller.activity.list()[0]?.message).toBe('An approval request was declined: a read or navigate action cannot carry a possible-repeat warning.');
      // Ruling 2c: declined to the coordinator, not dropped
      expect(t.coordinator.resolutions.map((r) => [r.taskId, r.resolved.actionId, r.resolved.approved, r.resolved.reason])).toEqual([['t2', 'a'.repeat(64), false, 'display_unavailable']]);
      t.coordinator.requestApproval(req({ actionId: 'c'.repeat(64), category: 'read', expiry: future() }));
      expect(t.hooks.approvalShown).toBe(1);
      const got = await t.call<{ approval: ApprovalView | null }>(INVOKE_CHANNELS.getApproval, APPROVAL);
      expect(got.ok && got.data.approval?.category).toBe('read');
      expect(got.ok && got.data.approval?.warning).toBeNull();
    });
  });

  it('voice and tray can never approve: no ControlAction/menu item approves, and none of them resolves a pending approval', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      expect(ControlActionSchema.options.some((a) => /approv|confirm|yes/i.test(a))).toBe(false);
      expect(MenuItemIdSchema.options.some((a) => /approv|confirm|yes/i.test(a))).toBe(false);
      expect(deriveMenu(deriveTrayView(snap())).some((m) => /approv/i.test(m.label))).toBe(false);
      expect(ControlActionSchema.safeParse('approve').success).toBe(false);
      t.coordinator.requestApproval(req({ expiry: future() }));
      const got = await t.call<{ approval: ApprovalView }>(INVOKE_CHANNELS.getApproval, APPROVAL);
      if (!got.ok) throw new Error('getApproval failed');
      for (const action of ControlActionSchema.options) {
        if (action === 'stop_task') continue; // stop ends the task (covered by dropTask)
        await t.call(INVOKE_CHANNELS.control, MAIN, { action });
      }
      for (const id of MenuItemIdSchema.options) if (!['quit', 'stop_task'].includes(id)) await t.controller.trayAction(id);
      expect(t.coordinator.resolutions).toEqual([]);
      expect(t.controller.approvals.size).toBe(1);
      // main window (tray/voice-driven UI) cannot call the secure channels
      expect(await t.call(INVOKE_CHANNELS.resolveApproval, MAIN, { dialogId: got.data.approval.dialogId, decision: 'approve' })).toEqual({ ok: false, error: { code: 'INVALID_SENDER', message: 'Untrusted sender' } });
      expect(t.coordinator.resolutions).toEqual([]);
    });
  });

  it('join end to end: duplicate request keeps the same dialog; one Approve -> one ApprovalResolved', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.requestApproval(req({ expiry: future(), possibleRepeat: repeat('possible') }));
      const got = await t.call<{ approval: ApprovalView }>(INVOKE_CHANNELS.getApproval, APPROVAL);
      if (!got.ok) throw new Error('getApproval failed');
      const { dialogId } = got.data.approval;
      await t.call(INVOKE_CHANNELS.approvalWarningShown, APPROVAL, { dialogId });
      t.coordinator.requestApproval(req({ expiry: future(), possibleRepeat: repeat('possible') }));
      expect(t.hooks.approvalShown).toBe(1); // no reload, no new dialog
      vi.setSystemTime(Date.now() + 500);
      expect(await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId, decision: 'approve' })).toEqual({ ok: true, data: { decision: 'approve' } });
      expect(t.coordinator.resolutions).toHaveLength(1);
    });
  });

  it('join mismatch end to end (f): declined{display_unavailable} once to the coordinator, dialog closed, Approve over IPC refused', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.requestApproval(req({ expiry: future() }));
      const got = await t.call<{ approval: ApprovalView }>(INVOKE_CHANNELS.getApproval, APPROVAL);
      if (!got.ok) throw new Error('getApproval failed');
      t.coordinator.requestApproval(req({ expiry: future(), summary: 'Send it to everyone' }));
      expect(t.coordinator.resolutions).toHaveLength(1);
      expect(t.coordinator.resolutions[0]).toMatchObject({ taskId: 't2', resolved: { actionId: 'a'.repeat(64), approved: false, reason: 'display_unavailable' } });
      expect(t.coordinator.resolutions[0]?.resolved).not.toHaveProperty('decision');
      expect(t.hooks.approvalClosed).toBe(1);
      expect((await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId: got.data.approval.dialogId, decision: 'approve' })).ok).toBe(false);
      expect(t.coordinator.resolutions).toHaveLength(1);
      const msg = t.controller.activity.list()[0]?.message ?? '';
      expect(msg).toBe('A repeated approval request did not match the one on screen, so the action was declined for safety.');
    });
  });

  it("local expiry end to end: dialog stays, Approve refused, nothing sent; the coordinator's outcome closes it", async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      t.coordinator.requestApproval(req({ expiry: future() }));
      const got = await t.call<{ approval: ApprovalView }>(INVOKE_CHANNELS.getApproval, APPROVAL);
      if (!got.ok) throw new Error('getApproval failed');
      vi.setSystemTime(Date.now() + 61_000);
      expect(await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId: got.data.approval.dialogId, decision: 'approve' })).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'This request expired, so nothing was done.' },
      });
      const again = await t.call<{ approval: ApprovalView }>(INVOKE_CHANNELS.getApproval, APPROVAL);
      expect(again.ok && again.data.approval.expired).toBe(true);
      expect(t.hooks.approvalClosed).toBe(0);
      t.coordinator.settleApproval({ taskId: 't2', actionId: 'a'.repeat(64), approved: false, decision: 'expired', timestamp: new Date().toISOString() });
      expect(t.hooks.approvalClosed).toBe(1);
      expect(t.coordinator.resolutions).toEqual([]);
      t.coordinator.settleApproval({ actionId: 'x' });
      expect(t.controller.activity.list()[0]?.message).toBe('Ignored a malformed approval outcome from the coordinator.');
    });
  });

  describe("coordinator ApprovalResolved{approved:false, decision:'expired'} (C-08; CONTRACTS @ 6834524, rulings 1m/1o)", () => {
    const expired = (patch: Record<string, unknown> = {}) => ({ taskId: 't2', actionId: 'a'.repeat(64), approved: false, decision: 'expired', timestamp: new Date().toISOString(), ...patch });
    it('closes the open (not yet locally expired) dialog; a late Approve is refused; the desktop sends nothing', async () => {
      await withTempDir(async (dir) => {
        const t = await setup(dir);
        t.coordinator.requestApproval(req({ expiry: future() }));
        const got = await t.call<{ approval: ApprovalView }>(INVOKE_CHANNELS.getApproval, APPROVAL);
        if (!got.ok) throw new Error('getApproval failed');
        t.coordinator.settleApproval(expired());
        expect(t.hooks.approvalClosed).toBe(1);
        expect(t.controller.approvals.size).toBe(0);
        expect((await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId: got.data.approval.dialogId, decision: 'approve' })).ok).toBe(false);
        expect((await t.call(INVOKE_CHANNELS.resolveApproval, APPROVAL, { dialogId: got.data.approval.dialogId, decision: 'decline' })).ok).toBe(false);
        expect(t.coordinator.resolutions).toEqual([]);
        expect(t.controller.activity.list()[0]?.message).toBe('The approval request expired, so nothing was done.');
      });
    });
    it('one per dialog: a joined set is handled once; repeats (e.g. one per joined request) change nothing and log nothing more', async () => {
      await withTempDir(async (dir) => {
        const t = await setup(dir);
        t.coordinator.requestApproval(req({ expiry: future() }));
        t.coordinator.requestApproval(req({ expiry: t.controller.approvals.current()?.expiresAt }));
        t.coordinator.requestApproval(req({ expiry: t.controller.approvals.current()?.expiresAt }));
        expect(t.controller.approvals.joinedCount('a'.repeat(64))).toBe(3);
        const before = t.controller.activity.list().length;
        for (let i = 0; i < 3; i++) t.coordinator.settleApproval(expired());
        expect(t.hooks.approvalClosed).toBe(1);
        expect(t.controller.activity.list().length).toBe(before + 1);
        expect(t.coordinator.resolutions).toEqual([]);
        // a redelivered request after the expiry never reopens the dialog
        t.coordinator.requestApproval(req({ expiry: future() }));
        expect(t.controller.approvals.size).toBe(0);
        expect(t.hooks.approvalShown).toBe(1);
      });
    });
    it('other dialogs stay open; an expiry for an unknown actionId does nothing', async () => {
      await withTempDir(async (dir) => {
        const t = await setup(dir);
        t.coordinator.requestApproval(req({ expiry: future() }));
        t.coordinator.requestApproval(req({ expiry: future(), actionId: 'b'.repeat(64) }));
        t.coordinator.settleApproval(expired({ actionId: 'c'.repeat(64) }));
        expect(t.controller.approvals.size).toBe(2);
        t.coordinator.settleApproval(expired());
        expect(t.controller.approvals.size).toBe(1);
        expect(t.hooks.approvalClosed).toBe(0);
      });
    });
    it.each([
      ['no decision (not a coordinator outcome)', { decision: undefined }, 'Ignored an unexpected approval outcome from the coordinator.'],
      ['desktop-only reason', { decision: undefined, reason: 'display_unavailable' }, 'Ignored an unexpected approval outcome from the coordinator.'],
      ['expired with approved:true', { approved: true }, 'Ignored a malformed approval outcome from the coordinator.'],
      ['decision and reason together', { reason: 'display_unavailable' }, 'Ignored a malformed approval outcome from the coordinator.'],
      ['unknown decision', { decision: 'declined' }, 'Ignored a malformed approval outcome from the coordinator.'],
    ])('%s: ignored, the dialog stays open', async (_n, patch, message) => {
      await withTempDir(async (dir) => {
        const t = await setup(dir);
        t.coordinator.requestApproval(req({ expiry: future() }));
        t.coordinator.settleApproval(expired(patch));
        expect(t.controller.approvals.size).toBe(1);
        expect(t.hooks.approvalClosed).toBe(0);
        expect(t.controller.activity.list()[0]?.message).toBe(message);
      });
    });
  });

  it('a TaskFinished for the task drops its pending approval and closes the dialog', async () => {
    await withTempDir(async (dir) => {
      const t = await setup(dir);
      const close = vi.fn();
      t.hooks.closeApproval = close;
      t.coordinator.requestApproval(req({ expiry: future() }));
      t.coordinator.finish({ taskId: 't2', outcome: 'failed', verified: false, summary: 'x' });
      expect(t.controller.approvals.size).toBe(0);
      expect(close).toHaveBeenCalled();
    });
  });
});
