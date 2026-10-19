/**
 * DOT-095 criterion 10, UI side (CONTRACTS X5 L230, ruling 1t; E02 2581593 `renderBoundText`):
 * bound fields keep hidden characters and render them as visible highlighted escapes with the
 * "contains hidden characters" badge; untrusted free text stays stripped; limits count raw values.
 */
import { describe, expect, it } from 'vitest';
import { boundFields, codexView } from '../src/main/approval/approvalService';
import { ApprovalViewSchema, BoundFieldViewSchema, type BoundFieldView } from '../src/shared/approval';
import { BoundTextRenderSchema, renderBoundText, renderCodexCommand, textFromBound, type BoundTextRender } from '../src/shared/commandRender';
import { ApprovalDisplaySchema, ApprovalRequestedSchema, HIDDEN_CHAR, type ApprovalDisplay, type ApprovalRequested } from '../src/shared/contracts.draft';
import { sourceFor } from './helpers';

const escapes = (r: BoundTextRender) => r.segments.filter((s) => s.kind === 'escape').map((s) => (s as { text: string }).text);

/** The four characters the task names, plus their E02 escape text. */
const CHARS: [string, string, string][] = [
  ['ESC', '\u001b', '\\x1b'],
  ['lone CR', '\r', '\\x0d'],
  ['U+202E', '\u202E', '<U+202E>'],
  ['zero-width space', '\u200B', '<U+200B>'],
];

describe('renderBoundText: same semantics as E02 2581593 display.ts renderBoundText', () => {
  it('HIDDEN_CHAR is E02 2581593 display.ts HIDDEN_CHAR exactly', () => {
    expect(HIDDEN_CHAR.source).toBe(String.raw`[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]`);
    expect(HIDDEN_CHAR.flags).toBe('u');
  });
  it.each(CHARS)('%s: one highlighted escape, the badge flag, nothing stripped', (_n, ch, shown) => {
    const v = `C:\\in${ch}voice.exe`;
    const r = renderBoundText(v);
    expect(r).toEqual({ segments: [{ kind: 'text', text: 'C:\\in' }, { kind: 'escape', text: shown, codePoint: ch.codePointAt(0) }, { kind: 'text', text: 'voice.exe' }], hiddenCharacters: true });
    expect(textFromBound(r)).toBe(v);
    expect(BoundTextRenderSchema.safeParse(r).success).toBe(true);
  });
  it('one line: tab, LF and CRLF are escapes too (no tab marker, no line break), unlike the command box', () => {
    const r = renderBoundText('a\tb\nc\r\nd');
    expect(escapes(r)).toEqual(['\\x09', '\\x0a', '\\x0d', '\\x0a']);
    expect(r.segments.some((s) => s.kind === 'tab')).toBe(false);
    expect(textFromBound(r)).toBe('a\tb\nc\r\nd');
    // the command box keeps its L231 layout rules
    expect(renderCodexCommand('a\tb').lines[0]?.some((s) => s.kind === 'tab')).toBe(true);
  });
  it('trailing spaces are visible; plain text has no badge', () => {
    expect(renderBoundText('Report  ')).toEqual({ segments: [{ kind: 'text', text: 'Report' }, { kind: 'trailing_whitespace', text: '  ' }], hiddenCharacters: false });
    expect(renderBoundText('C:\\a.txt')).toEqual({ segments: [{ kind: 'text', text: 'C:\\a.txt' }], hiddenCharacters: false });
  });
  it('the view schema refuses a raw hidden character in a text run, a tab segment, an empty value and a wrong badge flag', () => {
    expect(BoundTextRenderSchema.safeParse({ segments: [{ kind: 'text', text: 'a\u202Eb' }], hiddenCharacters: false }).success).toBe(false);
    expect(BoundTextRenderSchema.safeParse({ segments: [{ kind: 'tab' }], hiddenCharacters: false }).success).toBe(false);
    expect(BoundTextRenderSchema.safeParse({ segments: [], hiddenCharacters: false }).success).toBe(false);
    expect(BoundTextRenderSchema.safeParse({ ...renderBoundText('a\u202Eb'), hiddenCharacters: false }).success).toBe(false);
    expect(BoundTextRenderSchema.safeParse({ segments: [{ kind: 'escape', text: '<U+202D>', codePoint: 0x202e }], hiddenCharacters: true }).success).toBe(false);
  });
});

const tool = { kind: 'tool', method: 'files.write', targetLabel: 'report' };
const ui = { kind: 'ui_action', category: 'local_change', method: 'ui.click', app: { appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } };
const cmd = { kind: 'codex_command', category: 'local_change', commandLine: 'git status', workingDirectory: 'C:\\repo', networkAccess: 'not_requested', escalation: ['Run outside the sandbox'], reasonUntrusted: null };
const files = { kind: 'codex_file_change', category: 'overwrite', paths: ['C:\\repo\\a.ts'], fileCount: '1', reasonUntrusted: null };
const pre = { kind: 'pre_dispatch', category: 'local_change', risk: 'high', possibleRepeat: 'unknown', retryOfTaskId: 't0', summaryUntrusted: 'Retry' };

/** [field name, display with the value `v` placed in that bound field, how to read the rendered value(s) back]. */
type Case = [string, (v: string) => Record<string, unknown>, (d: ApprovalDisplay) => BoundTextRender];
const field = (key: string) => (d: ApprovalDisplay) => {
  const f = boundFields(d).find((x: BoundFieldView) => x.key === key);
  if (!f?.values[0]) throw new Error(`no bound field ${key}`);
  expect(BoundFieldViewSchema.safeParse(f).success).toBe(true);
  return f.values[f.values.length - 1] as BoundTextRender;
};
const codexPart = (part: 'workingDirectory' | 'escalation' | 'paths') => (d: ApprovalDisplay) => {
  const r = { taskId: 't', actionId: 'a'.repeat(64), summary: 's', risk: 'high', expiry: '2026-10-19T08:00:00Z', category: d.category, display: d, requestSource: 'codex' } as ApprovalRequested;
  const c = codexView(r)?.codex;
  const v = part === 'workingDirectory' ? c?.workingDirectory : c?.[part]?.[c[part].length - 1];
  if (!v) throw new Error(`no codex ${part}`);
  return v;
};
const CASES: Case[] = [
  ['paths (tool delete)', (v) => ({ ...tool, category: 'delete', paths: ['C:\\ok.txt', v], fileCount: '2' }), field('paths')],
  ['targets (tool local_change)', (v) => ({ ...tool, category: 'local_change', targets: [v], itemCount: '1' }), field('targets')],
  ['paths (codex_file_change)', (v) => ({ ...files, paths: [v], fileCount: '1' }), codexPart('paths')],
  ['workingDirectory (codex_command)', (v) => ({ ...cmd, workingDirectory: v }), codexPart('workingDirectory')],
  ['escalation (codex_command)', (v) => ({ ...cmd, escalation: ['Network access', v] }), codexPart('escalation')],
  ['windowTitle (ui_action)', (v) => ({ ...ui, app: { ...ui.app, windowTitle: v } }), field('windowTitle')],
  ['appName (ui_action)', (v) => ({ ...ui, app: { ...ui.app, appName: v } }), field('appName')],
  ['processImage (ui_action)', (v) => ({ ...ui, app: { ...ui.app, processImage: v } }), field('processImage')],
  ['method (tool)', (v) => ({ ...tool, method: v, category: 'delete', paths: ['C:\\a'], fileCount: '1' }), field('method')],
  ['targetLabel (tool)', (v) => ({ ...tool, targetLabel: v, category: 'delete', paths: ['C:\\a'], fileCount: '1' }), field('targetLabel')],
  ['recipients (external_send)', (v) => ({ ...tool, category: 'external_send', recipients: [v], channel: 'email', bodyUntrusted: 'hi' }), field('recipients')],
  ['channel (external_send)', (v) => ({ ...tool, category: 'external_send', recipients: ['sam@example.com'], channel: v, bodyUntrusted: 'hi' }), field('channel')],
  ['path (external_upload)', (v) => ({ ...tool, category: 'external_upload', path: v, destinationHost: 'files.example.com' }), field('path')],
  ['merchant (purchase)', (v) => ({ ...tool, category: 'purchase', merchant: v, amount: '1.00', currency: 'USD' }), field('merchant')],
  ['package (install_or_elevate)', (v) => ({ ...tool, category: 'install_or_elevate', package: v, publisher: 'p', version: '1', source: 'winget' }), field('package')],
  ['publisher (install_or_elevate)', (v) => ({ ...tool, category: 'install_or_elevate', package: 'p', publisher: v, version: '1', source: 'winget' }), field('publisher')],
  ['version (install_or_elevate)', (v) => ({ ...tool, category: 'install_or_elevate', package: 'p', publisher: 'q', version: v, source: 'winget' }), field('version')],
  ['source (install_or_elevate)', (v) => ({ ...tool, category: 'install_or_elevate', package: 'p', publisher: 'q', version: '1', source: v }), field('source')],
  ['setting (security_setting)', (v) => ({ ...tool, category: 'security_setting', setting: v, currentValue: 'on', newValue: 'off' }), field('setting')],
  ['currentValue (security_setting)', (v) => ({ ...tool, category: 'security_setting', setting: 's', currentValue: v, newValue: 'off' }), field('currentValue')],
  ['newValue (security_setting)', (v) => ({ ...tool, category: 'security_setting', setting: 's', currentValue: 'on', newValue: v }), field('newValue')],
  ['retryOfTaskId (pre_dispatch)', (v) => ({ ...pre, retryOfTaskId: v }), field('retryOfTaskId')],
];

describe('every bound field: hidden characters accepted, never stripped, rendered as visible escapes with the badge', () => {
  const grid = CASES.flatMap(([name, mk, read]) => CHARS.map(([cn, ch, shown]) => [name, cn, mk, read, ch, shown] as const));
  it.each(grid)('%s with %s', (_name, _cn, mk, read, ch, shown) => {
    const value = `ab${ch}cd`;
    const raw = mk(value);
    const parsed = ApprovalDisplaySchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const snapshot = JSON.stringify(parsed.data);
    const r = read(parsed.data);
    expect(escapes(r)).toEqual([shown]);
    expect(r.hiddenCharacters).toBe(true);
    expect(textFromBound(r)).toBe(value); // never stripped or altered
    expect(JSON.stringify(parsed.data)).toBe(snapshot); // the display (displayHash input) is untouched
    expect(r.segments.filter((s) => s.kind === 'text').some((s) => HIDDEN_CHAR.test((s as { text: string }).text))).toBe(false);
  });
  it('a full ApprovalView with an escaped path passes the IPC view schema', () => {
    const d = ApprovalDisplaySchema.parse({ ...tool, category: 'delete', paths: ['C:\\invoice\u202Efdp.exe'], fileCount: '1' });
    const f = boundFields(d);
    expect(f.map((x) => x.key)).toEqual(['method', 'targetLabel', 'paths']);
    expect(f[2]?.values[0]?.hiddenCharacters).toBe(true);
    expect(
      ApprovalViewSchema.safeParse({ dialogId: 'a'.repeat(64), title: 'Approve: Delete?', categoryLabel: 'Delete', risk: 'high', category: 'delete', expiresAt: '2026-10-19T07:00:00Z', expired: false, untrustedSummary: 's', untrustedLabel: 'Description from the task (untrusted, not checked by Dottie)', codex: null, fields: f, warning: null }).success,
    ).toBe(true);
  });
  it('fields per kind: fixed labels, untrusted marks window title and message body, [] for Codex', () => {
    const ev = ApprovalDisplaySchema.parse(ui);
    expect(boundFields(ev).map((f) => [f.key, f.label, f.untrusted])).toEqual([
      ['method', 'Action', false],
      ['appName', 'App', false],
      ['windowTitle', 'Window title (untrusted)', true],
      ['processImage', 'Program', false],
    ]);
    const send = ApprovalDisplaySchema.parse({ ...tool, category: 'external_send', recipients: ['a@x', 'b@x'], channel: 'email', bodyUntrusted: 'hi' });
    expect(boundFields(send).map((f) => [f.key, f.label, f.untrusted])).toEqual([
      ['method', 'Action', false],
      ['targetLabel', 'Target', false],
      ['recipients', 'Recipients (2)', false],
      ['channel', 'Channel', false],
      ['bodyUntrusted', 'Message (untrusted, not checked by Dottie)', true],
    ]);
    expect(boundFields(ApprovalDisplaySchema.parse(cmd))).toEqual([]);
    expect(boundFields(ApprovalDisplaySchema.parse(files))).toEqual([]);
    expect(boundFields(ApprovalDisplaySchema.parse({ ...pre, possibleRepeat: null, retryOfTaskId: null }))).toEqual([]);
  });
});

describe('untrusted free text keeps stripping; format rules and raw length limits still apply', () => {
  it.each(CHARS)('summaryUntrusted / reasonUntrusted / bodyUntrusted with %s are rejected (must arrive stripped)', (_n, ch) => {
    expect(ApprovalDisplaySchema.safeParse({ ...pre, summaryUntrusted: `a${ch}b` }).success).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...cmd, reasonUntrusted: `a${ch}b` }).success).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...files, reasonUntrusted: `a${ch}b` }).success).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...tool, category: 'external_send', recipients: ['a'], channel: 'email', bodyUntrusted: `a${ch}b` }).success).toBe(false);
  });
  it('format rules are unchanged: ui_action method regex, lowercase host, decimal amount, process-image basename', () => {
    expect(ApprovalDisplaySchema.safeParse({ ...ui, method: 'ui.cl\u202Eick' }).success).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...tool, category: 'external_upload', path: 'C:\\a', destinationHost: 'ex\u200Bample.com' }).success).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...tool, category: 'purchase', merchant: 'm', amount: '1\u200B0', currency: 'USD' }).success).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...ui, app: { ...ui.app, processImage: 'C:\\x\u202E\\a.exe' } }).success).toBe(false);
  });
  it('limits count the raw value: 256 x U+202E in targetLabel ok, 257 rejected; a path of 4096 raw bytes ok, 4097 rejected; escalation entry 256 code points', () => {
    const del = (patch: Record<string, unknown>) => ApprovalDisplaySchema.safeParse({ ...tool, category: 'delete', paths: ['C:\\a'], fileCount: '1', ...patch }).success;
    expect(del({ targetLabel: '\u202E'.repeat(256) })).toBe(true);
    expect(del({ targetLabel: '\u202E'.repeat(257) })).toBe(false);
    expect(del({ paths: ['C:\\' + '\u202E'.repeat(1364) + 'x'], fileCount: '1' })).toBe(true); // 3 + 4092 + 1 = 4096 bytes
    expect(del({ paths: ['C:\\' + '\u202E'.repeat(1364) + 'xy'], fileCount: '1' })).toBe(false); // 4097 bytes
    expect(del({ method: '\u001b'.repeat(64) })).toBe(true);
    expect(del({ method: '\u001b'.repeat(65) })).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...cmd, escalation: ['\u200B'.repeat(256)] }).success).toBe(true);
    expect(ApprovalDisplaySchema.safeParse({ ...cmd, escalation: ['\u200B'.repeat(257)] }).success).toBe(false);
    expect(ApprovalDisplaySchema.safeParse({ ...cmd, workingDirectory: 'C:\\' + '\u001b'.repeat(4093) }).success).toBe(true);
    expect(ApprovalDisplaySchema.safeParse({ ...cmd, workingDirectory: 'C:\\' + '\u001b'.repeat(4094) }).success).toBe(false);
  });
  it('a whole ApprovalRequested with a hidden character in a bound field is valid', () => {
    const display = { ...tool, category: 'delete', paths: ['C:\\invoice\u202Efdp.exe'], fileCount: '1' };
    expect(ApprovalRequestedSchema.safeParse({ taskId: 't', actionId: 'a'.repeat(64), summary: 's', risk: 'high', expiry: '2026-10-19T08:00:00Z', category: 'delete', display, requestSource: sourceFor(display) }).success).toBe(true);
  });
});
