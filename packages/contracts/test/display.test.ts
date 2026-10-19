// DOT-095 / CONTRACTS e41d1ca (rulings 1o, 1r, 1t, 1u) + ruling 1v (E03 3029c7b key names, f3672da cut rule): bound display builders, limits, renderer helpers, kind/source guard.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson, codexDisplay, codexDisplayParams, fileChangePaths, preDispatchDisplay, sha256Hex, uiActionDisplay, COMMAND_MAX_BYTES, computeActionId, computeDisplayHash,
  DISPLAY_HARD_LIMITS, DISPLAY_KEYS, DISPLAY_KIND_SOURCE, DISPLAY_KINDS, DISPLAY_MAX, hiddenCharEscape, PATH_LIST_MAX, renderBoundText, renderCodexCommand, renderUntrustedText,
  hasUiActionPrefix, isUiActionMethod, REQUEST_SOURCES, toolDisplay, validateApprovalDisplay, validateEvent,
  type ActionBinding, type ApprovalCategory, type ApprovalDisplay, type CodexCommandDisplay, type CodexCommandParams, type CodexFileChangeDisplay, type DisplayBuild, type RequestSource,
} from '../src/index.js';

const CMD = { kind: 'codex_command', commandLine: 'Remove-Item C:\\TMP\\a.txt', workingDirectory: 'C:\\TMP', networkAccess: false } as const;
type CodexD = CodexCommandDisplay | CodexFileChangeDisplay;
const ok = (r: DisplayBuild<CodexD>): CodexD => {
  if (!r.ok) throw new Error(`expected a display, got ${r.why}`);
  return r.display;
};
const cmd = (p: Partial<CodexCommandParams> = {}) => ok(codexDisplay('local_change', { ...CMD, ...p })) as CodexCommandDisplay;
const files = (paths: string[], reason?: string, category: ApprovalCategory = 'overwrite') => ok(codexDisplay(category, { kind: 'codex_file_change', paths, ...(reason === undefined ? {} : { reason }) })) as CodexFileChangeDisplay;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

test('ruling 1v: wire keys come from the one table (E03 3029c7b DISPLAY_KEYS, verbatim)', () => {
  assert.deepEqual(DISPLAY_KEYS, {
    kind: 'kind', category: 'category', risk: 'risk', possibleRepeat: 'possibleRepeat', retryOfTaskId: 'retryOfTaskId', summary: 'summaryUntrusted',
    method: 'method', targetLabel: 'targetLabel', app: 'app', appName: 'appName', windowTitle: 'windowTitle', processImage: 'processImage',
    commandLine: 'commandLine', workingDirectory: 'workingDirectory', networkAccess: 'networkAccess', escalation: 'escalation', paths: 'paths', fileCount: 'fileCount', reason: 'reasonUntrusted',
  });
  assert.deepEqual(Object.keys(cmd()).sort(), ['category', 'commandLine', 'escalation', 'kind', 'networkAccess', 'reasonUntrusted', 'workingDirectory']);
  assert.deepEqual(Object.keys(files(['C:\\A'])).sort(), ['category', 'fileCount', 'kind', 'paths', 'reasonUntrusted']);
  const ui = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'Notepad', windowTitle: 't', processImage: 'notepad.exe' })!;
  assert.deepEqual(Object.keys(ui).sort(), ['app', 'category', 'kind', 'method'], 'no targetLabel on ui_action');
  assert.deepEqual(Object.keys(ui.app).sort(), ['appName', 'processImage', 'windowTitle']);
  const pd = preDispatchDisplay({ summary: 'x', risk: 'high', category: 'delete', possibleRepeat: null, retryOfTaskId: null });
  assert.deepEqual(Object.keys(pd).sort(), ['category', 'kind', 'possibleRepeat', 'retryOfTaskId', 'risk', 'summaryUntrusted']);
  assert.equal(validateApprovalDisplay({ ...ui, targetLabel: 'x' }).ok, false);
  assert.equal(uiActionDisplay({ category: 'local_change', method: 'files.delete_item', appName: 'a', windowTitle: 't', processImage: 'a.exe' }), null, 'ui_action needs a UI-action method');
});

test('value conventions (E03): strings only; escalation [] when none; fileCount = String(paths.length); a move lists both paths', () => {
  const d = cmd();
  assert.equal(d.networkAccess, 'not_requested');
  assert.equal(cmd({ networkAccess: true }).networkAccess, 'requested');
  assert.deepEqual(d.escalation, []);
  assert.equal(d.reasonUntrusted, null);
  const mv = fileChangePaths([{ path: 'C:\\A', movePath: 'C:\\B' }, { path: 'C:\\C', movePath: null }]);
  assert.deepEqual(mv, ['C:\\A', 'C:\\B', 'C:\\C']);
  assert.equal(files(mv).fileCount, '3');
  assert.equal(validateApprovalDisplay({ ...files(mv), fileCount: 3 }).ok, false, 'a number count is rejected');
  assert.equal(validateApprovalDisplay({ ...d, escalation: null }).ok, false, 'null escalation is rejected');
});

test('ruling 1o/1r: the 8 KB command limit is raw UTF-8 bytes (8191/8192 ok, 8193 display_unavailable), never an ellipsis', () => {
  // Multibyte: U+00E9 is 2 bytes, U+20AC is 3 bytes.
  const c8191 = '\u00e9'.repeat(4095) + 'x';
  const c8192 = '\u00e9'.repeat(4096);
  const c8193 = '\u20ac'.repeat(2731); // 8193 bytes
  assert.deepEqual([bytes(c8191), bytes(c8192), bytes(c8193)], [8191, 8192, 8193]);
  assert.equal(COMMAND_MAX_BYTES, 8192);
  for (const c of [c8191, c8192]) assert.equal(cmd({ commandLine: c }).commandLine, c, 'shown in full');
  const r = codexDisplay('local_change', { ...CMD, commandLine: c8193 });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'display_unavailable');
  assert.equal(codexDisplay('local_change', { ...CMD, commandLine: 'x'.repeat(8193) }).ok, false);
  // Hidden characters count at their raw byte length (ruling 1t (4)): 8191 x 'x' + U+202E (3 bytes) = 8194.
  assert.equal(codexDisplay('local_change', { ...CMD, commandLine: 'x'.repeat(8191) + '\u202e' }).ok, false);
  assert.equal(codexDisplay('local_change', { ...CMD, commandLine: 'x'.repeat(8189) + '\u202e' }).ok, true);
  assert.equal(validateApprovalDisplay({ ...cmd({ commandLine: c8192 }), commandLine: c8193 }).ok, false, 'validator agrees');
});

test('never cut: workingDirectory and each path ≤ 4096 bytes; escalation ≤ 32 entries of ≤ 256 code points', () => {
  assert.deepEqual(DISPLAY_HARD_LIMITS, { commandLine: { maxBytes: 8192 }, workingDirectory: { maxBytes: 4096 }, paths: { maxEntries: 500, maxEntryBytes: 4096 }, escalation: { maxEntries: 32, maxEntryCodePoints: 256 }, method: { maxCodePoints: 64 } });
  const p4096 = 'C:\\' + '\u00e9'.repeat(2046) + 'x', p4097 = p4096 + 'x';
  assert.deepEqual([bytes(p4096), bytes(p4097)], [4096, 4097]);
  assert.equal(cmd({ workingDirectory: p4096 }).workingDirectory, p4096);
  assert.equal(codexDisplay('local_change', { ...CMD, workingDirectory: p4097 }).ok, false);
  assert.equal(files([p4096]).paths[0], p4096);
  assert.equal(codexDisplay('overwrite', { kind: 'codex_file_change', paths: [p4097] }).ok, false);
  const e = (n: number, len: number) => Array.from({ length: n }, () => 'e'.repeat(len));
  assert.deepEqual(cmd({ escalation: e(32, 256) }).escalation, e(32, 256), 'kept in full');
  assert.equal(codexDisplay('local_change', { ...CMD, escalation: e(33, 1) }).ok, false);
  assert.equal(codexDisplay('local_change', { ...CMD, escalation: e(1, 257) }).ok, false);
  assert.equal(validateApprovalDisplay({ ...cmd(), escalation: e(1, 257) }).ok, false);
});

test('ruling 1o/1r: 500 paths ok in full, 501 display_unavailable; 250 moves = 500 paths ok, 251 moves not', () => {
  const ps = (n: number) => Array.from({ length: n }, (_, i) => `C:\\TMP\\F${i}.TXT`);
  assert.equal(PATH_LIST_MAX, 500);
  const d = files(ps(500), undefined, 'local_change');
  assert.equal(d.paths.length, 500);
  assert.equal(d.fileCount, '500');
  assert.ok(d.paths.every((p, i) => p === `C:\\TMP\\F${i}.TXT`));
  const r = codexDisplay('local_change', { kind: 'codex_file_change', paths: ps(501) });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'display_unavailable');
  const mv = (n: number) => fileChangePaths(Array.from({ length: n }, (_, i) => ({ path: `C:\\A${i}`, movePath: `C:\\B${i}` })));
  assert.equal(codexDisplay('overwrite', { kind: 'codex_file_change', paths: mv(250) }).ok, true);
  assert.equal(codexDisplay('overwrite', { kind: 'codex_file_change', paths: mv(251) }).ok, false);
  const long = 'C:\\' + 'D'.repeat(2000);
  assert.equal(files([long]).paths[0], long, 'no ellipsis on a long path');
});

test('cut rule = E03 f3672da: strip if untrusted, then max−1 code points + U+2026 (exactly max)', () => {
  assert.deepEqual(
    { s: DISPLAY_MAX.summaryUntrusted, r: DISPLAY_MAX.reasonUntrusted, w: DISPLAY_MAX.windowTitle, m: DISPLAY_HARD_LIMITS.method.maxCodePoints, t: DISPLAY_MAX.targetLabel, a: DISPLAY_MAX.appName, p: DISPLAY_MAX.processImage },
    { s: 500, r: 500, w: 256, m: 64, t: 256, a: 128, p: 260 },
  );
  const pd = (summary: string) => preDispatchDisplay({ summary, risk: 'high', category: 'delete', possibleRepeat: null, retryOfTaskId: null }).summaryUntrusted;
  assert.equal(pd('s'.repeat(499)), 's'.repeat(499));
  assert.equal(pd('s'.repeat(500)), 's'.repeat(500));
  assert.equal(pd('s'.repeat(501)), 's'.repeat(499) + '\u2026');
  assert.equal([...pd('s'.repeat(501))].length, 500);
  assert.equal(pd('s'.repeat(250) + '\u202e' + 's'.repeat(250)), 's'.repeat(500), 'strip before cut');
  assert.equal(pd('\u{1F600}'.repeat(501)), '\u{1F600}'.repeat(499) + '\u2026', 'code points, not UTF-16 units');
  const ui = (windowTitle: string) => uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'Notepad', windowTitle, processImage: 'notepad.exe' })!.app.windowTitle;
  assert.equal(ui('w'.repeat(256)), 'w'.repeat(256));
  assert.equal(ui('w'.repeat(257)), 'w'.repeat(255) + '\u2026');
  assert.equal(ui('\u202e' + 'w'.repeat(256)), '\u202e' + 'w'.repeat(254) + '\u2026', 'bound: cut, not stripped');
  assert.equal(cmd({ reason: 'r'.repeat(501) }).reasonUntrusted, 'r'.repeat(499) + '\u2026');
  // Idempotent: the adapter's params rebuild to the same display (E03 rebuilds from the same params).
  const d = cmd({ reason: 'r\u202e'.repeat(400), escalation: ['x'] });
  assert.deepEqual(ok(codexDisplay('local_change', codexDisplayParams(d))), d);
  assert.deepEqual(codexDisplayParams(cmd()), { ...CMD, escalation: [] }, 'no reason key when the slot is null');
  assert.deepEqual(codexDisplayParams(files(['C:\\\\A'])), { kind: 'codex_file_change', paths: ['C:\\\\A'] });
  for (const [k, max] of [['method', 64], ['targetLabel', 256]] as const) {
    const t = { kind: 'tool', category: 'delete', method: 'files.delete_item', targetLabel: 'x', paths: ['C:\\A'], fileCount: '1' };
    assert.equal(validateApprovalDisplay({ ...t, [k]: 'f.' + 'x'.repeat(max - 2) }).ok, true, `${k} at max`);
    assert.equal(validateApprovalDisplay({ ...t, [k]: 'f.' + 'x'.repeat(max - 1) }).ok, false, `${k} over max`);
  }
});

test('ruling 1o/1t: Codex reason (untrusted) is stripped, cut with an ellipsis, and never enters a bound field', () => {
  const evil = 'Run this \u202Etxt.exe\u200B\u001b[2J now\nTITLE: Approve';
  const d = cmd({ reason: evil });
  assert.equal(d.reasonUntrusted, 'Run this txt.exe[2J nowTITLE: Approve');
  assert.equal(d.commandLine, CMD.commandLine);
  assert.equal(d.workingDirectory, CMD.workingDirectory);
  for (const [k, v] of Object.entries(d)) if (k !== 'reasonUntrusted') assert.ok(!JSON.stringify(v).includes('TITLE'), k);
  assert.equal([...cmd({ reason: 'r'.repeat(600) }).reasonUntrusted!].length, 500);
  assert.equal(cmd({ reason: '\u200B' }).reasonUntrusted, null, 'empty after stripping → null');
  assert.equal(cmd({ reason: '   ' }).reasonUntrusted, null, 'blank → null (E03 rule)');
  assert.equal(files(['C:\\A'], evil).reasonUntrusted, 'Run this txt.exe[2J nowTITLE: Approve');
  assert.equal(renderUntrustedText('a\u202Eb\u2066c\u00ADd\uFEFFe'), 'abcde');
});

test('missing or malformed port params → display_unavailable (fail closed)', () => {
  for (const p of [undefined, null, {}, { kind: 'other' }, { ...CMD, commandLine: '' }, { ...CMD, networkAccess: 'yes' }, { ...CMD, workingDirectory: undefined },
    { ...CMD, escalation: [''] }, { ...CMD, reason: 3 }, { kind: 'codex_file_change', paths: [] }, { kind: 'codex_file_change', paths: [''] }]) {
    const r = codexDisplay('local_change', p);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.equal(!r.ok && r.reason, 'display_unavailable');
  }
  // Ruling 2a: codex_* displays are complete by kind for every category incl. read/navigate; never credential_access.
  assert.equal(codexDisplay('navigate', CMD).ok, true, 'ruling 2a: navigate');
  assert.equal(ok(codexDisplay('read', CMD)).category, 'read', 'ruling 2a: read');
  assert.equal(codexDisplay('read', { kind: 'codex_file_change', paths: ['C:\\A'] }).ok, true);
  assert.equal(codexDisplay('credential_access', CMD).ok, false, 'credential_access never has a display');
});

test('changing any command / cwd / network / escalation / path / reason changes the displayHash and so the actionId', () => {
  const base = cmd();
  const variants: ApprovalDisplay[] = [
    cmd({ commandLine: CMD.commandLine + ' ' }),
    cmd({ workingDirectory: 'C:\\TMP2' }),
    cmd({ networkAccess: true }),
    cmd({ escalation: ['Network access to example.com (https)'] }),
    cmd({ escalation: ['Network access to example.org (https)'] }),
    cmd({ reason: 'because' }),
    files(['C:\\A']),
    files(['C:\\B']),
    files(['C:\\A', 'C:\\B']),
    ok(codexDisplay('delete', { kind: 'codex_file_change', paths: ['C:\\A'] })),
  ];
  const hashes = [base, ...variants].map((d) => computeDisplayHash(d));
  assert.equal(new Set(hashes).size, hashes.length);
  const binding = (displayHash: string): ActionBinding => ({ method: 'item/commandExecution/requestApproval', args: {}, targets: null, taskId: 't', threadId: 'th', turnId: 'tu', itemId: 'i', requestId: '0', displayHash, requestSource: 'codex' });
  const ids = hashes.map((h) => computeActionId(binding(h)));
  assert.equal(new Set(ids).size, ids.length);
});

const HIDDEN = [
  ...Array.from({ length: 0x20 }, (_, i) => i).filter((c) => c !== 0x0a && c !== 0x09),
  0x7f, 0x80, 0x85, 0x9f, 0x00ad, 0x034f, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0xe0001, 0xe007f,
];
test('ruling 1t: every bidi, zero-width and control character in a bound field is escaped and flags the badge', () => {
  for (const cp of [...HIDDEN, 0x09, 0x0a]) {
    const ch = String.fromCodePoint(cp);
    const r = renderBoundText(`a${ch}b`);
    assert.equal(r.hiddenCharacters, true, cp.toString(16));
    assert.deepEqual(r.segments, [{ kind: 'text', text: 'a' }, { kind: 'escape', text: hiddenCharEscape(cp), codePoint: cp }, { kind: 'text', text: 'b' }], cp.toString(16));
  }
  assert.equal(hiddenCharEscape(0x1b), '\\x1b');
  assert.equal(hiddenCharEscape(0x202e), '<U+202E>');
  assert.equal(hiddenCharEscape(0xe0001), '<U+E0001>');
  assert.deepEqual(renderBoundText('C:\\TMP\\notes.txt'), { segments: [{ kind: 'text', text: 'C:\\TMP\\notes.txt' }], hiddenCharacters: false });
  // A bound field keeps them raw (validator accepts, hash covers the raw bytes); untrusted free text may not.
  const withBidi = files(['C:\\TMP\\\u202Etxt.exe'], undefined, 'delete');
  assert.equal(withBidi.paths[0], 'C:\\TMP\\\u202Etxt.exe');
  assert.equal(validateApprovalDisplay({ ...withBidi, reasonUntrusted: 'x\u202E' }).ok, false);
});

test('ruling 1t: codex_command renders lines and a line count; CRLF displays like LF but hashes differently; escapes in the box', () => {
  const lf = renderCodexCommand('Get-ChildItem\n| Remove-Item');
  const crlf = renderCodexCommand('Get-ChildItem\r\n| Remove-Item');
  assert.deepEqual(crlf, lf);
  assert.equal(lf.lineCount, 2);
  assert.equal(lf.hiddenCharacters, false);
  const dl = cmd({ commandLine: 'Get-ChildItem\n| Remove-Item' });
  const dc = cmd({ commandLine: 'Get-ChildItem\r\n| Remove-Item' });
  assert.notEqual(computeDisplayHash(dl), computeDisplayHash(dc), 'displayHash covers the raw bytes');
  assert.equal(dc.commandLine, 'Get-ChildItem\r\n| Remove-Item', 'executed bytes = hashed bytes');
  const r = renderCodexCommand('echo \u001b[2J\rx\t\u202Etxt  ');
  assert.equal(r.lineCount, 1, 'a lone CR is not a line break');
  assert.equal(r.hiddenCharacters, true);
  assert.deepEqual(r.lines[0], [
    { kind: 'text', text: 'echo ' }, { kind: 'escape', text: '\\x1b', codePoint: 0x1b }, { kind: 'text', text: '[2J' },
    { kind: 'escape', text: '\\x0d', codePoint: 0x0d }, { kind: 'text', text: 'x' }, { kind: 'tab' },
    { kind: 'escape', text: '<U+202E>', codePoint: 0x202e }, { kind: 'text', text: 'txt' }, { kind: 'trailing_whitespace', text: '  ' },
  ]);
  assert.equal(renderCodexCommand('a\n\nb\n').lineCount, 4);
});

test('ruling 1r: kind/source guard: every allowed pair accepted, every disallowed pair rejected', () => {
  const dir = fileURLToPath(new URL('../../fixtures/events/valid/', import.meta.url));
  const byKind: Record<string, string> = {
    tool: 'approval-requested.json', ui_action: 'approval-requested-ui-action.json', codex_command: 'approval-requested-codex-command.json',
    codex_file_change: 'approval-requested-codex-file-change.json', pre_dispatch: 'approval-requested-pre-dispatch.json',
  };
  assert.deepEqual(Object.keys(byKind).sort(), [...DISPLAY_KINDS].sort());
  for (const kind of DISPLAY_KINDS) {
    const ev = JSON.parse(readFileSync(dir + byKind[kind], 'utf8')) as { payload: { display: { kind: string }; requestSource: RequestSource } };
    assert.equal(ev.payload.display.kind, kind);
    for (const src of REQUEST_SOURCES) {
      const r = validateEvent({ ...ev, payload: { ...ev.payload, requestSource: src } });
      const allowed = DISPLAY_KIND_SOURCE[kind] === src;
      assert.equal(r.ok, allowed, `${kind} + ${src}: ${JSON.stringify(r.ok ? [] : r.issues)}`);
      if (!r.ok) assert.ok(r.issues.some((i) => i.path === 'payload.requestSource'));
    }
  }
  assert.deepEqual(DISPLAY_KIND_SOURCE, { tool: 'tool_host', ui_action: 'tool_host', codex_command: 'codex', codex_file_change: 'codex', pre_dispatch: 'coordinator' });
});

test('ruling 1r: displayHash covers kind; unknown kinds and extra fields are rejected', () => {
  const d = cmd();
  assert.equal(validateApprovalDisplay({ ...d, kind: 'tool' }).ok, false);
  assert.equal(validateApprovalDisplay({ ...d, kind: 'codex' }).ok, false);
  assert.equal(validateApprovalDisplay({ ...d, extra: null }).ok, false);
  const { kind: _k, ...noKind } = d;
  assert.equal(validateApprovalDisplay(noKind).ok, false);
  // The hash is over the canonical object, kind included.
  assert.ok(canonicalJson(d).includes('"kind":"codex_command"'));
  assert.equal(computeDisplayHash(d), sha256Hex(canonicalJson(d)));
  assert.notEqual(sha256Hex(canonicalJson(d)), sha256Hex(canonicalJson(noKind)));
});

test('ruling 1z (dottie-e01 492c01c): isUiActionMethod is exactly ^(ui|window)\\.[a-z][a-z0-9_]*$', () => {
  const app = { category: 'local_change', appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } as const;
  for (const m of ['ui.click', 'window.close', 'ui.a', 'window.set_focus', 'ui.click2', 'ui.type_text_9', 'window.' + 'x'.repeat(57)]) {
    assert.equal(isUiActionMethod(m), true, m);
    assert.notEqual(uiActionDisplay({ ...app, method: m }), null, `builds: ${m}`);
    assert.equal(validateApprovalDisplay({ kind: 'ui_action', category: 'local_change', method: m, app: { appName: app.appName, windowTitle: app.windowTitle, processImage: app.processImage } }).ok, true, `validates: ${m}`);
  }
  for (const m of ['ui.', 'window.', 'ui.Click', 'ui.1x', 'uix.click', 'ui.click.extra', 'UI.click', 'ui._x', 'ui.click ', ' ui.click', 'ui.click\n', 'ui.cl-ick', 'xui.click', 'windows.close', 'uixclick', 'window_close', 'ui', '', 'ui.clíck']) {
    assert.equal(isUiActionMethod(m), false, JSON.stringify(m));
    assert.equal(uiActionDisplay({ ...app, method: m }), null, `no build: ${JSON.stringify(m)}`);
    assert.equal(validateApprovalDisplay({ kind: 'ui_action', category: 'local_change', method: m, app: { appName: app.appName, windowTitle: app.windowTitle, processImage: app.processImage } }).ok, false, `rejects: ${JSON.stringify(m)}`);
  }
  for (const m of [null, undefined, 1, ['ui.click'], { toString: () => 'ui.click' }]) assert.equal(isUiActionMethod(m), false);
  // The vectors carry the six named negatives from the ruling.
  const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/action-id/vectors.json', import.meta.url)), 'utf8')) as { displaysInvalid: { name: string; display: { method?: string } }[] };
  const vm = v.displaysInvalid.filter((x) => x.name.startsWith('ruling 1z:')).map((x) => x.display.method);
  assert.deepEqual(vm, ['ui.', 'window.', 'ui.Click', 'ui.1x', 'uix.click', 'ui.click.extra']);
});

test('ruling 1z: a single-file delete / overwrite still carries paths[] (one entry) and fileCount "1"', () => {
  for (const category of ['delete', 'overwrite'] as const) {
    const tool = { kind: 'tool', category, method: 'files.' + (category === 'delete' ? 'delete_item' : 'write_file'), targetLabel: 'NOTES.TXT', paths: ['C:\\USERS\\GOPI\\NOTES.TXT'], fileCount: '1' };
    assert.equal(validateApprovalDisplay(tool).ok, true, `tool ${category}, one path`);
    assert.equal(validateApprovalDisplay({ ...tool, paths: 'C:\\USERS\\GOPI\\NOTES.TXT' }).ok, false, `tool ${category}: a bare string is not paths[]`);
    assert.equal(validateApprovalDisplay({ ...tool, fileCount: 1 }).ok, false, `tool ${category}: fileCount is the string "1"`);
    assert.equal(validateApprovalDisplay({ ...tool, fileCount: '0' }).ok, false, `tool ${category}: fileCount matches paths`);
    const { paths: _p, ...noPaths } = tool;
    assert.equal(validateApprovalDisplay(noPaths).ok, false, `tool ${category}: paths required even for one file`);
    const { fileCount: _c, ...noCount } = tool;
    assert.equal(validateApprovalDisplay(noCount).ok, false, `tool ${category}: fileCount required even for one file`);
    const c = files(['C:\\TMP\\ONE.TXT'], undefined, category);
    assert.deepEqual(c.paths, ['C:\\TMP\\ONE.TXT']);
    assert.equal(c.fileCount, '1');
  }
  const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/action-id/vectors.json', import.meta.url)), 'utf8')) as { displays: { name: string; display: { paths?: string[]; fileCount?: string } }[] };
  const one = v.displays.find((x) => x.name === 'tool delete, one path')!.display;
  assert.deepEqual([one.paths, one.fileCount], [['C:\\USERS\\GOPI\\NOTES.TXT'], '1']);
});

test('ruling 2a (dottie-e01 972d5f4): pre_dispatch read/navigate build and validate; tool and ui_action read/navigate do not', () => {
  for (const category of ['read', 'navigate'] as const) {
    const pd = preDispatchDisplay({ summary: 'Show Downloads', risk: 'low', category, possibleRepeat: null, retryOfTaskId: 'task_0' });
    assert.equal(pd.category, category);
    assert.equal(validateApprovalDisplay(pd).ok, true, `pre_dispatch ${category}`);
    assert.match(computeDisplayHash(pd), /^[0-9a-f]{64}$/);
    assert.equal(validateApprovalDisplay({ ...cmd(), category }).ok, true, `codex_command ${category}`);
    assert.equal(validateApprovalDisplay({ ...files(['C:\\A']), category }).ok, true, `codex_file_change ${category}`);
    const ui = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'Notepad', windowTitle: 't', processImage: 'notepad.exe' })!;
    assert.equal(validateApprovalDisplay({ ...ui, category }).ok, false, `ui_action ${category}`);
    assert.equal(uiActionDisplay({ category, method: 'window.close', appName: 'Notepad', windowTitle: 't', processImage: 'notepad.exe' }), null);
    assert.equal(validateApprovalDisplay({ kind: 'tool', category, method: 'files.read', targetLabel: 'x' }).ok, false, `tool ${category}`);
  }
  assert.throws(() => preDispatchDisplay({ summary: 'x', risk: 'low', category: 'credential_access', possibleRepeat: null, retryOfTaskId: null }));
  for (const d of [{ ...cmd(), category: 'credential_access' }, { ...files(['C:\\A']), category: 'credential_access' }]) assert.equal(validateApprovalDisplay(d).ok, false);
});

test('2a addition (with E03): method is NEVER cut; 64 code points accepted, 65 → display_unavailable / rejected (ui_action and tool)', () => {
  assert.equal(Object.hasOwn(DISPLAY_MAX, 'method'), false, 'method is not a cut field');
  const app = { category: 'local_change', appName: 'Notepad', windowTitle: 't', processImage: 'notepad.exe' } as const;
  const ui64 = 'window.' + 'x'.repeat(57), ui65 = ui64 + 'x';
  assert.deepEqual([[...ui64].length, [...ui65].length], [64, 65]);
  assert.equal(uiActionDisplay({ ...app, method: ui64 })!.method, ui64, 'kept whole at 64');
  assert.equal(uiActionDisplay({ ...app, method: ui65 }), null, 'never cut: 65 → display_unavailable (not window.xxx…)');
  const ui = uiActionDisplay({ ...app, method: 'window.close' })!;
  assert.equal(validateApprovalDisplay({ ...ui, method: ui64 }).ok, true);
  const r = validateApprovalDisplay({ ...ui, method: ui65 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === 'display.method' && /never cut/.test(i.message)), JSON.stringify(r.issues));
  assert.equal(validateApprovalDisplay({ ...ui, method: 'window.' + 'x'.repeat(56) + '\u2026' }).ok, false, 'a cut method breaks the 1z regex');
  const t64 = 'files.' + 'x'.repeat(58), t65 = t64 + 'x';
  const tool = { kind: 'tool', category: 'delete', method: t64, targetLabel: 'x', paths: ['C:\\A'], fileCount: '1' };
  assert.equal(validateApprovalDisplay(tool).ok, true, 'tool method 64');
  const rt = validateApprovalDisplay({ ...tool, method: t65 });
  assert.equal(rt.ok, false, 'tool method 65');
  assert.ok(rt.issues.some((i) => i.path === 'display.method' && /never cut/.test(i.message)));
  // The 64 vectors are accepted; the 65 vectors are rejected.
  const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/action-id/vectors.json', import.meta.url)), 'utf8')) as { displays: { name: string; display: { method?: string } }[]; displaysInvalid: { name: string; display: { method?: string } }[] };
  assert.deepEqual(v.displays.filter((x) => /method 64 code points/.test(x.name)).map((x) => [...x.display.method!].length), [64, 64]);
  assert.deepEqual(v.displaysInvalid.filter((x) => /method 65 code points/.test(x.name)).map((x) => [...x.display.method!].length), [65, 65]);
});

test('E01 1y follow-up: kind tool rejects any ui./window. method (any case), in the validator and the toolDisplay builder', () => {
  const del = (method: string) => ({ category: 'delete' as const, method, targetLabel: 'Delete NOTES.TXT', fields: { paths: ['C:\\USERS\\GOPI\\NOTES.TXT'] } });
  const shape = (method: string) => ({ kind: 'tool', category: 'delete', method, targetLabel: 'Delete NOTES.TXT', paths: ['C:\\USERS\\GOPI\\NOTES.TXT'], fileCount: '1' });
  const rejected = ['ui.Click', 'window.', 'UI.x', 'Window.close', 'ui.click', 'window.close', 'ui.', 'UI.', 'WINDOW.CLOSE', 'wInDoW.x', 'ui.click.extra', 'ui.1x', 'ui.cl-ick'];
  for (const m of rejected) {
    assert.equal(hasUiActionPrefix(m), true, m);
    assert.equal(toolDisplay(del(m)), null, `builder → display_unavailable: ${m}`);
    const r = validateApprovalDisplay(shape(m));
    assert.equal(r.ok, false, `validator rejects: ${m}`);
    assert.ok(r.issues.some((i) => i.path === 'display.method' && /prefix/.test(i.message)), `${m}: ${JSON.stringify(r.issues)}`);
  }
  const accepted = ['uix.click', 'file.read', 'files.delete_item', 'xui.click', 'windows.close', 'ui_click', 'window_close', 'uiclick', 'u.i', 'app.launch'];
  for (const m of accepted) {
    assert.equal(hasUiActionPrefix(m), false, m);
    const d = toolDisplay(del(m));
    assert.ok(d !== null, `builder accepts: ${m}`);
    assert.deepEqual(d, shape(m), `${m}: builder output = the validated shape (fileCount filled in)`);
    assert.equal(validateApprovalDisplay(shape(m)).ok, true, `validator accepts: ${m}`);
  }
  for (const m of [null, undefined, 1, ['ui.click']]) assert.equal(hasUiActionPrefix(m), false);
  // ui_action still takes exactly the 1z methods (the prefix rule is tool-only).
  assert.equal(isUiActionMethod('ui.click'), true);
  assert.equal(isUiActionMethod('Window.close'), false);
  // The builder's other refusals.
  assert.equal(toolDisplay({ ...del('files.delete_item'), category: 'read' }), null, 'tool read: no display rule (2a)');
  assert.equal(toolDisplay({ ...del('files.delete_item'), fields: { paths: ['C:\\A'], fileCount: '9' } }), null, 'count is never supplied');
  assert.equal(toolDisplay({ ...del('files.delete_item'), fields: { paths: ['C:\\A'], method: 'x' } }), null, 'no base keys in fields');
  assert.equal(toolDisplay({ ...del('files.delete_item'), fields: {} }), null, 'delete without paths');
  for (const c of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) assert.equal(toolDisplay({ ...del('files.delete_item'), category: c as never }), null, `prototype key ${c} is not a category`);
  assert.equal(toolDisplay({ ...del('files.delete_item'), method: 'files.' + 'x'.repeat(59) }), null, 'method over 64 never cut');
  assert.equal((toolDisplay({ category: 'external_send', method: 'mail.send_message', targetLabel: 'Send', fields: { recipients: ['a@example.com'], channel: 'email', bodyUntrusted: 'hi \u202Ethere' } }) as unknown as Record<string, unknown>)['bodyUntrusted'], 'hi there', 'body stripped');
  // Vectors: the five named negatives and the two positives.
  const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/action-id/vectors.json', import.meta.url)), 'utf8')) as { displays: { name: string; display: { method?: string } }[]; displaysInvalid: { name: string; display: { method?: string } }[] };
  assert.deepEqual(v.displaysInvalid.filter((x) => x.name.startsWith('1y follow-up:')).map((x) => x.display.method), ['ui.Click', 'window.', 'UI.x', 'Window.close', 'ui.click']);
  assert.deepEqual(v.displays.filter((x) => x.name.startsWith('1y follow-up:')).map((x) => x.display.method), ['uix.click', 'file.read']);
});
