// Generates fixtures/action-id/vectors.json from the definitions below using the BUILT canonicaliser
// (dist/src/canonical.js). `--check` fails if the committed file differs. Run after `npm run build`.
// The fixture is the cross-language source for E03 (IdSource), E04/E11 (Python): see its "_readme".
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CanonicalError, canonicalJson, canonicalPath, computeActionId, actionIdObject, preDispatchBinding, toolCallBinding } from '../dist/src/canonical.js';
import { computeDisplayHash, DISPLAY_MAX, preDispatchDisplay, uiActionDisplay, validateApprovalDisplay } from '../dist/src/display.js';

const OUT = fileURLToPath(new URL('../fixtures/action-id/vectors.json', import.meta.url));
const SPECIAL = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
export function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const k = Object.keys(v);
    if (k.length === 1 && k[0] === '$number') return SPECIAL[v.$number];
    if (k.length === 1 && k[0] === '$bigint') return BigInt(v.$bigint);
    return Object.fromEntries(Object.entries(v).map(([a, b]) => [a, decode(b)]));
  }
  return v;
}


// Sample bound displays (CONTRACTS e41d1ca: X5 rulings 1k/1l/1o/1r/1t; key names ruling 1v). Every dialog call binds its display's hash (CR2
// displayHash, top level); `kind` is part of every display (ruling 1r).
// Key names: E03 3029c7b DISPLAY_KEYS (ruling 1v). Values: strings, null, string lists, nested objects; counts are strings.
const T = (category, method, targetLabel, extra) => ({ kind: 'tool', category, method, targetLabel, ...extra });
const codexCmd = { kind: 'codex_command', category: 'local_change', commandLine: 'Remove-Item C:\\Users\\gopi\\notes.txt', workingDirectory: 'C:\\USERS\\GOPI', networkAccess: 'not_requested', escalation: [], reasonUntrusted: null };
const uiAction = { kind: 'ui_action', category: 'local_change', method: 'window.close', app: { appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } };
const fc = (category, paths) => ({ kind: 'codex_file_change', category, paths, fileCount: String(paths.length), reasonUntrusted: null });
const paths500 = Array.from({ length: 500 }, (_, i) => `C:\\TMP\\F${i}.TXT`);
const displays = {
  'codex command': codexCmd,
  'codex command, other command': { ...codexCmd, commandLine: 'Remove-Item C:\\Users\\gopi\\other.txt' },
  'codex command, other cwd': { ...codexCmd, workingDirectory: 'C:\\USERS\\GOPI\\DOCUMENTS' },
  'codex command, network requested': { ...codexCmd, networkAccess: 'requested', escalation: ['Network access to example.com (https)'] },
  'codex command, escalation only': { ...codexCmd, escalation: ['Allow similar commands without asking: git push'] },
  'codex command, reason (untrusted)': { ...codexCmd, reasonUntrusted: 'Codex says: needed to clean up' },
  'codex command, reason at 500 code points (ellipsis)': { ...codexCmd, reasonUntrusted: 'r'.repeat(499) + '\u2026' },
  'codex command, multi-line': { ...codexCmd, commandLine: 'Get-ChildItem\n  | Remove-Item' },
  'codex command, 8192 bytes': { ...codexCmd, commandLine: 'x'.repeat(8192) },
  'codex command, 8191 bytes multibyte': { ...codexCmd, commandLine: '\u00e9'.repeat(4095) + 'x' },
  'codex command, 8192 bytes multibyte': { ...codexCmd, commandLine: '\u00e9'.repeat(4096) },
  // ruling 1t: LF and CRLF render the same but hash differently (displayHash covers the raw command).
  'codex command, LF': { ...codexCmd, commandLine: 'Get-ChildItem\n| Remove-Item' },
  'codex command, CRLF': { ...codexCmd, commandLine: 'Get-ChildItem\r\n| Remove-Item' },
  // ruling 1t: hidden characters in bound fields are kept raw (escaped when rendered), never stripped.
  'codex command, ESC + lone CR + U+202E': { ...codexCmd, commandLine: 'echo \u001b[2J\rx \u202Etxt.exe' },
  'codex file change': fc('overwrite', ['C:\\TMP\\A.TXT', 'C:\\TMP\\B.TXT', 'C:\\TMP\\C.TXT']),
  'codex file change, other path': fc('overwrite', ['C:\\TMP\\A.TXT', 'C:\\TMP\\B.TXT', 'C:\\TMP\\D.TXT']),
  'codex file change, 500 paths': fc('local_change', paths500),
  'codex command, workingDirectory 4096 bytes': { ...codexCmd, workingDirectory: 'C:\\' + 'D'.repeat(4093) },
  'codex command, 32 escalations of 256 code points': { ...codexCmd, escalation: Array.from({ length: 32 }, (_, i) => String(i).padStart(2, '0') + 'e'.repeat(254)) },
  'codex file change, path 4096 bytes': fc('overwrite', ['C:\\' + 'P'.repeat(4093)]),
  'tool delete, one path': T('delete', 'files.delete_item', 'Delete NOTES.TXT', { paths: ['C:\\USERS\\GOPI\\NOTES.TXT'], fileCount: '1' }),
  'tool delete, path with U+202E (bound, kept)': T('delete', 'files.delete_item', 'Delete an item', { paths: ['C:\\TMP\\\u202Etxt.exe'], fileCount: '1' }),
  'tool delete, three paths': T('delete', 'files.delete_item', 'Delete 3 items', { paths: ['C:\\TMP\\A', 'C:\\TMP\\B', 'C:\\TMP\\C'], fileCount: '3' }),
  'tool local_change paths': T('local_change', 'files.edit_text', 'Edit 2 files in C:\\TMP', { targets: ['C:\\TMP\\A.TXT', 'C:\\TMP\\B.TXT'], itemCount: '2' }),
  'tool external_send': T('external_send', 'mail.send_message', 'Send an email to 2 recipients', { recipients: ['a@example.com', 'b@example.com'], channel: 'email', bodyUntrusted: 'Hi both, the report is attached.' }),
  'tool external_upload': T('external_upload', 'files.upload_file', 'Upload REPORT.PDF', { path: 'C:\\USERS\\GOPI\\REPORT.PDF', destinationHost: 'files.example.com' }),
  'tool purchase': T('purchase', 'shop.buy_item', 'Buy 1 item', { merchant: 'Example Store', amount: '19.99', currency: 'USD' }),
  'tool install_or_elevate': T('install_or_elevate', 'apps.install_package', 'Install 7-Zip', { package: '7zip.7zip', publisher: 'Igor Pavlov', version: '24.08', source: 'winget' }),
  'tool security_setting': T('security_setting', 'settings.set_value', 'Change a Windows setting', { setting: 'Windows Firewall (Private)', currentValue: 'on', newValue: 'off' }),
  'ui_action in an app': uiAction,
  'pre_dispatch absent': { kind: 'pre_dispatch', category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summaryUntrusted: 'Delete old.log in Downloads' },
  'pre_dispatch possible repeat': { kind: 'pre_dispatch', category: 'delete', risk: 'high', possibleRepeat: 'possible', retryOfTaskId: 'task_0', summaryUntrusted: 'Delete old.log in Downloads' },
  'pre_dispatch clean-failure retry': { kind: 'pre_dispatch', category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: 'task_0', summaryUntrusted: 'Delete old.log in Downloads' },
  // Ruling 2a (dottie-e01 972d5f4): pre_dispatch and codex_* are complete by kind for every category incl. read/navigate.
  'ruling 2a: pre_dispatch read (D14 read retry, C-25)': { kind: 'pre_dispatch', category: 'read', risk: 'low', possibleRepeat: null, retryOfTaskId: 'task_0', summaryUntrusted: 'Show the files in Downloads' },
  'ruling 2a: pre_dispatch navigate': { kind: 'pre_dispatch', category: 'navigate', risk: 'low', possibleRepeat: null, retryOfTaskId: 'task_0', summaryUntrusted: 'Open the Downloads folder' },
  'ruling 2a: codex_command read': { ...codexCmd, category: 'read', commandLine: 'Get-ChildItem C:\\Users\\gopi' },
  'ruling 2a: codex_file_change navigate': fc('navigate', ['C:\\TMP\\A.TXT']),
  // 2a addition (agreed with E03): the former invalid vector 'read has no display rule' (a pre_dispatch read), now valid.
  'ruling 2a: pre_dispatch read (formerly invalid "read has no display rule")': { kind: 'pre_dispatch', category: 'read', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summaryUntrusted: 'Delete old.log in Downloads' },
  // 2a addition: method is never cut; 64 code points accepted.
  'ui_action method 64 code points (never cut)': { kind: 'ui_action', category: 'local_change', method: 'window.' + 'x'.repeat(57), app: { appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } },
  // E01 1y follow-up: methods outside the ui./window. namespace stay valid for kind tool.
  '1y follow-up: tool method "uix.click" accepted': T('delete', 'uix.click', 'Delete NOTES.TXT', { paths: ['C:\\USERS\\GOPI\\NOTES.TXT'], fileCount: '1' }),
  '1y follow-up: tool method "file.read" accepted': T('local_change', 'file.read', 'Edit NOTES.TXT', { targets: ['C:\\USERS\\GOPI\\NOTES.TXT'], itemCount: '1' }),
  'tool method 64 code points (never cut)': T('delete', 'files.' + 'x'.repeat(58), 'Delete NOTES.TXT', { paths: ['C:\\USERS\\GOPI\\NOTES.TXT'], fileCount: '1' }),
  'pre_dispatch display summary changed': { kind: 'pre_dispatch', category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summaryUntrusted: 'Delete new.log in Downloads' },
};
const H = (name) => computeDisplayHash(displays[name]);
const omit = (o, k) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));
const displaysInvalid = [
  ['missing kind', omit(codexCmd, 'kind')],
  ['unknown kind', { ...codexCmd, kind: 'command' }],
  ['kind tool with codex fields', { ...codexCmd, kind: 'tool' }],
  ['extra field', { ...codexCmd, title: 'x' }],
  ['pre-1v name: command instead of commandLine', { ...omit(codexCmd, 'commandLine'), command: codexCmd.commandLine }],
  ['pre-1v name: summary instead of summaryUntrusted', { ...omit(displays['pre_dispatch absent'], 'summaryUntrusted'), summary: 'Delete old.log in Downloads' }],
  ['pre-1v shape: ui_action with targetLabel', { ...uiAction, targetLabel: 'Close a Notepad window' }],
  ['pre-1v shape: ui_action app fields flat', { ...omit(uiAction, 'app'), ...uiAction.app }],
  ['ui_action app with an extra field', { ...uiAction, app: { ...uiAction.app, pid: '4321' } }],
  ['ui_action with a non-UI method', { ...uiAction, method: 'files.delete_item' }],
  ['ruling 1z: ui_action method "ui." is not a UI-action method', { ...uiAction, method: 'ui.' }],
  ['ruling 1z: ui_action method "window." is not a UI-action method', { ...uiAction, method: 'window.' }],
  ['ruling 1z: ui_action method "ui.Click" is not a UI-action method', { ...uiAction, method: 'ui.Click' }],
  ['ruling 1z: ui_action method "ui.1x" is not a UI-action method', { ...uiAction, method: 'ui.1x' }],
  ['ruling 1z: ui_action method "uix.click" is not a UI-action method', { ...uiAction, method: 'uix.click' }],
  ['ruling 1z: ui_action method "ui.click.extra" is not a UI-action method', { ...uiAction, method: 'ui.click.extra' }],
  ['tool with a UI-action method', { ...displays['tool delete, one path'], method: 'window.close' }],
  ['1y follow-up: tool method "ui.Click" (ui./window. prefix, any case) rejected', { ...displays['tool delete, one path'], method: 'ui.Click' }],
  ['1y follow-up: tool method "window." (ui./window. prefix, any case) rejected', { ...displays['tool delete, one path'], method: 'window.' }],
  ['1y follow-up: tool method "UI.x" (ui./window. prefix, any case) rejected', { ...displays['tool delete, one path'], method: 'UI.x' }],
  ['1y follow-up: tool method "Window.close" (ui./window. prefix, any case) rejected', { ...displays['tool delete, one path'], method: 'Window.close' }],
  ['1y follow-up: tool method "ui.click" (ui./window. prefix, any case) rejected', { ...displays['tool delete, one path'], method: 'ui.click' }],
  // Ruling 2a: the 1l coverage rule applies to kind tool (and ui_action stays local_change or stricter).
  ['ruling 2a: tool read has no display rule', T('read', 'files.read', 'Read NOTES.TXT', {})],
  ['navigate has no display rule', T('navigate', 'explorer.open_known_folder', 'Downloads', {})],
  ['ruling 2a: ui_action read has no display rule', { ...uiAction, category: 'read' }],
  ['credential_access has no display rule', T('credential_access', 'x.y', 'API key', {})],
  ['ruling 2a: pre_dispatch credential_access has no display rule', { ...displays['pre_dispatch absent'], category: 'credential_access' }],
  ['ruling 2a: codex_command credential_access has no display rule', { ...codexCmd, category: 'credential_access' }],
  ['optional field omitted instead of null', omit(codexCmd, 'reasonUntrusted')],
  ['escalation null instead of []', { ...codexCmd, escalation: null }],
  ['blank reason instead of null', { ...codexCmd, reasonUntrusted: '  ' }],
  ['command over 8192 bytes', { ...codexCmd, commandLine: 'x'.repeat(8193) }],
  ['command 8193 bytes multibyte (4096 x U+00E9 + one byte)', { ...codexCmd, commandLine: '\u00e9'.repeat(4096) + 'x' }],
  ['command 8194 bytes multibyte (4097 x U+00E9)', { ...codexCmd, commandLine: '\u00e9'.repeat(4097) }],
  ['untrusted reason not stripped (U+202E)', { ...codexCmd, reasonUntrusted: 'ok \u202Etxt' }],
  ['untrusted reason not stripped (ZWSP)', { ...codexCmd, reasonUntrusted: 'ok\u200Bthen' }],
  ['reason over 500 code points', { ...codexCmd, reasonUntrusted: 'r'.repeat(501) }],
  ['untrusted body not stripped (ESC)', { ...displays['tool external_send'], bodyUntrusted: 'hi \u001b[2J' }],
  ['501 paths', fc('local_change', [...paths500, 'C:\\TMP\\X'])],
  ['path cut with an ellipsis', { ...displays['codex file change'], paths: ['C:\\TMP\\A\u2026'], fileCount: '1' }],
  ['fileCount not the path count', { ...displays['codex file change'], fileCount: '2' }],
  ['fileCount as a number', { ...displays['codex file change'], fileCount: 3 }],
  ['networkAccess boolean', { ...codexCmd, networkAccess: true }],
  ['tool delete: fileCount != paths', { ...displays['tool delete, three paths'], fileCount: '2' }],
  ['tool delete: 501 paths', { ...displays['tool delete, three paths'], paths: Array.from({ length: 501 }, (_, i) => `C:\\T${i}`), fileCount: '501' }],
  ['ui_action without processImage', { ...uiAction, app: omit(uiAction.app, 'processImage') }],
  ['ui_action with an empty windowTitle', { ...uiAction, app: { ...uiAction.app, windowTitle: '' } }],
  ['ui_action processImage is a path', { ...uiAction, app: { ...uiAction.app, processImage: 'C:\\Windows\\notepad.exe' } }],
  ['body over 200 code points', { ...displays['tool external_send'], bodyUntrusted: 'x'.repeat(201) }],
  ['workingDirectory 4097 bytes (never cut)', { ...codexCmd, workingDirectory: 'C:\\' + 'D'.repeat(4094) }],
  ['path 4097 bytes (never cut)', fc('overwrite', ['C:\\' + 'P'.repeat(4094)])],
  ['33 escalations (never cut)', { ...codexCmd, escalation: Array.from({ length: 33 }, (_, i) => `e${i}`) }],
  ['escalation entry 257 code points (never cut)', { ...codexCmd, escalation: ['e'.repeat(257)] }],
  ['ui_action method 65 code points (never cut)', { ...uiAction, method: 'window.' + 'x'.repeat(58) }],
  ['tool method 65 code points (never cut)', { ...displays['tool delete, one path'], method: 'files.' + 'x'.repeat(59) }],
  ['targetLabel 257 code points', { ...displays['tool delete, one path'], targetLabel: 't'.repeat(257) }],
  ['app.windowTitle 257 code points', { ...uiAction, app: { ...uiAction.app, windowTitle: 'w'.repeat(257) } }],
  ['app.appName 129 code points', { ...uiAction, app: { ...uiAction.app, appName: 'a'.repeat(129) } }],
  ['app.processImage 261 code points', { ...uiAction, app: { ...uiAction.app, processImage: 'p'.repeat(257) + '.exe' } }],
  ['summaryUntrusted 501 code points', { ...displays['pre_dispatch absent'], summaryUntrusted: 's'.repeat(501) }],
  ['amount not a decimal', { ...displays['tool purchase'], amount: '$19.99' }],
  ['currency lowercase', { ...displays['tool purchase'], currency: 'usd' }],
];

// Cut-rule cross-check (E03 f3672da): untrusted → strip hidden characters first; then over `max` code points →
// max−1 code points + U+2026. Bound (windowTitle) → cut, never stripped. [name, builder, field, raw input]
const PDI = { risk: 'high', category: 'delete', possibleRepeat: null, retryOfTaskId: null };
const UIA = { category: 'local_change', method: 'window.close', appName: 'Notepad', processImage: 'notepad.exe' };
const cutCases = [
  ['summaryUntrusted at max-1 (499)', 'pre_dispatch', 'summaryUntrusted', 's'.repeat(499)],
  ['summaryUntrusted at max (500)', 'pre_dispatch', 'summaryUntrusted', 's'.repeat(500)],
  ['summaryUntrusted at max+1 (501): 499 + U+2026', 'pre_dispatch', 'summaryUntrusted', 's'.repeat(501)],
  ['summaryUntrusted 501 with one U+202E: stripped to 500, not cut', 'pre_dispatch', 'summaryUntrusted', 's'.repeat(250) + '\u202E' + 's'.repeat(250)],
  ['summaryUntrusted 501 astral code points (U+1F600): 499 + U+2026', 'pre_dispatch', 'summaryUntrusted', '\u{1F600}'.repeat(501)],
  ['app.windowTitle at max-1 (255)', 'ui_action', 'windowTitle', 'w'.repeat(255)],
  ['app.windowTitle at max (256)', 'ui_action', 'windowTitle', 'w'.repeat(256)],
  ['app.windowTitle at max+1 (257): 255 + U+2026', 'ui_action', 'windowTitle', 'w'.repeat(257)],
  ['app.windowTitle 257 with U+202E kept (bound, cut not stripped)', 'ui_action', 'windowTitle', '\u202E' + 'w'.repeat(256)],
];
const buildCut = (kind, field, raw) => kind === 'pre_dispatch' ? preDispatchDisplay({ ...PDI, summary: raw }) : uiActionDisplay({ ...UIA, windowTitle: raw });

const base = { method: 'item/commandExecution/requestApproval', targets: null, taskId: 'task-1', threadId: 'thr-1', turnId: 'turn-1', itemId: 'item-1', requestId: '0', displayHash: H('codex command'), requestSource: 'codex' };
const cmdArgs = { kind: 'command', command: 'Remove-Item C:\\Users\\gopi\\notes.txt', cwd: 'C:\\USERS\\GOPI', networkApprovalContext: null, environmentId: null, approvalId: null };
const window = { hwnd: '197640', pid: '4321', windowClass: 'Notepad', processStartTime: '133725312000000000' };
const PD = { summary: 'Delete old.log in Downloads', risk: 'high', category: 'delete' };
const pd = (args) => ({ purpose: 'dottie.actionId.v1', ...preDispatchBinding({ taskId: 'task_1', turnId: 'task_1.t1', requestId: 'req_conf', args }) });
const pdAbsent = pd(PD);
const swapDisplay = (b, name) => ({ ...b, args: { ...b.args, displayHash: H(name) }, displayHash: H(name) });

const canonicalCases = [
  ['empty object', {}],
  ['keys sorted recursively, arrays keep order', { b: [3, 1, 2], a: { d: 'x', c: null } }],
  ['booleans become strings', { t: true, f: false }],
  ['integers become decimal strings', { zero: 0, neg: -42, big: 9007199254740991 }],
  ['bigint beyond 2^53 as decimal string', { n: { $bigint: '18446744073709551615' } }],
  ['minimal escaping, non-ASCII kept', { s: 'tab\there "q" \\ é 😀 \u0001 \u2028' }],
  ['key order is by code point (astral after BMP-high)', { '\uffff': 1, '😀': 2, Z: 3, a: 4 }],
  ['nested arrays of objects', { list: [{ y: 1, x: 2 }, [true, null]] }],
];
const canonicalInvalid = [
  ['NaN', { n: { $number: 'NaN' } }],
  ['Infinity', { n: { $number: 'Infinity' } }],
  ['-Infinity', { n: { $number: '-Infinity' } }],
  ['negative zero', { n: { $number: '-0' } }],
  ['non-integer', { n: 1.5 }],
  ['integer beyond 2^53-1 as a number', { n: 9007199254740992 }],
  ['lone surrogate in a string', { s: '\ud800' }],
];
// [name, input, display name (the display whose hash the input binds) | null]
// [name, input, display name (the display whose hash the input binds) | null]
const actionCases = [
  // ruling 1q (c): a generic call: top-level displayHash, none in args.
  ['codex command approval', { ...base, args: cmdArgs }, 'codex command'],
  ['all optional ids null', { ...base, threadId: null, turnId: null, itemId: null, requestId: null, args: { path: 'C:\\TMP' } }, 'codex command'],
  ['ui_action tool call with window target', { ...base, method: 'window.close', threadId: null, turnId: null, itemId: null, requestId: null, args: {}, targets: window, displayHash: H('ui_action in an app'), requestSource: 'tool_host' }, 'ui_action in an app'],
  ['tool delete call', { ...base, method: 'files.delete_item', args: { path: 'C:\\USERS\\GOPI\\NOTES.TXT' }, displayHash: H('tool delete, one path'), requestSource: 'tool_host' }, 'tool delete, one path'],
  // Ruling 1u: a different requestSource gives a different actionId (K8 recomputes: DENIED_BY_POLICY{wrong_action}).
  ['changed requestSource only (ruling 1r)', { ...base, args: cmdArgs, requestSource: 'tool_host' }, 'codex command'],
  ['navigate with requestSource codex instead of tool_host (K8 wrong_action)', { purpose: 'dottie.actionId.v1', ...toolCallBinding({ toolId: 'explorer.open_known_folder', args: { folder: 'downloads' }, taskId: 'task_1', threadId: 'thr_1', turnId: 'task_1.t1', itemId: 'item_1', requestId: 'req_1', displayHash: null }), requestSource: 'codex' }, null],
  ['changed requestId', { ...base, requestId: '1', args: cmdArgs }, 'codex command'],
  ['changed taskId', { ...base, taskId: 'task-2', args: cmdArgs }, 'codex command'],
  ['changed arg', { ...base, args: { ...cmdArgs, command: 'Remove-Item C:\\Users\\gopi\\other.txt' } }, 'codex command'],
  ['changed display only: command', { ...base, args: cmdArgs, displayHash: H('codex command, other command') }, 'codex command, other command'],
  ['changed display only: cwd', { ...base, args: cmdArgs, displayHash: H('codex command, other cwd') }, 'codex command, other cwd'],
  ['changed display only: network', { ...base, args: cmdArgs, displayHash: H('codex command, network requested') }, 'codex command, network requested'],
  ['changed display only: escalation', { ...base, args: cmdArgs, displayHash: H('codex command, escalation only') }, 'codex command, escalation only'],
  ['changed display only: file-change path', { ...base, method: 'item/fileChange/requestApproval', args: { changes: [] }, displayHash: H('codex file change, other path') }, 'codex file change, other path'],
  ['codex file change approval', { ...base, method: 'item/fileChange/requestApproval', args: { changes: [] }, displayHash: H('codex file change') }, 'codex file change'],
  ['integer arg', { ...base, args: { count: 3 } }, 'codex command'],
  ['the same arg as a string hashes the same (scalar leaves are strings)', { ...base, args: { count: '3' } }, 'codex command'],
  // §2.1 pre-dispatch (ruling 1q (a)): args.displayHash byte-equal to the top-level one; requestSource coordinator.
  ['pre_dispatch_confirmation', pdAbsent, 'pre_dispatch absent'],
  ['pre_dispatch_confirmation possible repeat', pd({ ...PD, possibleRepeat: 'possible', retryOfTaskId: 'task_0' }), 'pre_dispatch possible repeat'],
  ['pre_dispatch_confirmation clean-failure retry', pd({ ...PD, retryOfTaskId: 'task_0' }), 'pre_dispatch clean-failure retry'],
  ['pre_dispatch_confirmation display summary changed alone', swapDisplay(pdAbsent, 'pre_dispatch display summary changed'), 'pre_dispatch display summary changed'],
  ['pre_dispatch_confirmation args summary changed alone', { ...pdAbsent, args: { ...pdAbsent.args, summary: 'Delete new.log in Downloads' } }, 'pre_dispatch absent'],
  // DOT-090 item 12 / ruling 1u: navigate opens no dialog: requestSource 'tool_host', displayHash null; method = toolId,
  // folder enum only, targets null.
  ['navigate tool call', { purpose: 'dottie.actionId.v1', ...toolCallBinding({ toolId: 'explorer.open_known_folder', args: { folder: 'downloads' }, taskId: 'task_1', threadId: 'thr_1', turnId: 'task_1.t1', itemId: 'item_1', requestId: 'req_1', displayHash: null }) }, null],
];
const actionInvalid = [
  ['missing turnId', (() => { const { turnId: _t, ...r } = base; return { ...r, args: {} }; })()],
  ['empty taskId', { ...base, taskId: '', args: {} }],
  ['non-integer arg', { ...base, args: { ratio: 0.5 } }],
  ['NaN arg', { ...base, args: { n: { $number: 'NaN' } } }],
  ['negative zero arg', { ...base, args: { n: { $number: '-0' } } }],
  ['wrong purpose', { ...base, purpose: 'dottie.approvalToken.v1', args: {} }],
  ['unknown binding key', { ...base, turnID: 'x', args: {} }],
  ['pre-dispatch args.displayHash differs from the top-level displayHash (ruling 1q)', { ...pdAbsent, displayHash: H('pre_dispatch display summary changed') }],
  ['pre-dispatch with no displayHash in args (ruling 1q)', { ...pdAbsent, args: (({ displayHash: _d, ...r }) => r)(pdAbsent.args) }],
  ['generic call with displayHash in args (ruling 1q)', { ...base, args: { ...cmdArgs, displayHash: base.displayHash } }],
  ['null requestSource (ruling 1u)', { ...base, requestSource: null, args: {} }],
  ['missing requestSource (ruling 1r)', (({ requestSource: _s, ...r }) => ({ ...r, args: {} }))(base)],
  ['unknown requestSource', { ...base, requestSource: 'model', args: {} }],
  ['pre-dispatch method with requestSource codex (ruling 1r)', { ...pdAbsent, requestSource: 'codex' }],
  ['coordinator requestSource on a generic call (ruling 1r)', { ...base, requestSource: 'coordinator', args: {} }],
  ['missing displayHash', (({ displayHash: _d, ...r }) => ({ ...r, args: {} }))(base)],
  ['uppercase displayHash', { ...base, displayHash: base.displayHash.toUpperCase(), args: {} }],
];
// Short-name table the vectors' expander uses (stands in for GetLongPathNameW).
const shortNames = { 'C:\\PROGRA~1\\APP': 'C:\\Program Files\\App', 'C:\\USERS\\GOPI~1\\DOCUME~1': 'C:\\Users\\gopi.thungam\\Documents', 'C:\\Users\\a~1b': 'C:\\Users\\a~1b' };
const W = 'win32';
const P = 'posix';
const pathCases = [
  ['plain drive path', W, 'C:\\Users\\Gopi\\notes.txt'],
  ['forward slashes', W, 'C:/Users/Gopi/notes.txt'],
  ['lowercase drive and name', W, 'c:\\users\\gopi\\NOTES.TXT'],
  ['long-path prefix', W, '\\\\?\\C:\\Users\\Gopi\\notes.txt'],
  ['long-path UNC prefix', W, '\\\\?\\UNC\\server\\share\\dir'],
  ['UNC', W, '\\\\server\\share\\dir\\'],
  ['trailing separator', W, 'C:\\Users\\Gopi\\'],
  ['repeated separators and dots', W, 'C:\\Users\\\\.\\Gopi\\x\\..\\notes.txt'],
  ['drive root keeps its separator', W, 'C:\\'],
  ['8.3 short name expanded', W, 'C:\\PROGRA~1\\App\\app.exe'],
  ['8.3 nested short names expanded', W, 'C:\\Users\\GOPI~1\\DOCUME~1\\a.txt'],
  ['long name that contains ~1 (expander confirms it is long)', W, 'C:\\Users\\a~1b'],
  ['8.3 short name that cannot be expanded', W, 'C:\\NOPE~1\\x'],
  ['device namespace refused', W, '\\\\.\\PhysicalDrive0'],
  ['NT object namespace refused', W, '\\??\\C:\\x'],
  ['relative refused', W, 'Users\\Gopi'],
  ['drive-relative refused', W, 'C:Users'],
  ['.. above the root refused', W, 'C:\\..\\Windows'],
  ['alternate data stream refused', W, 'C:\\x.txt:secret'],
  ['trailing dot refused', W, 'C:\\x.txt.'],
  ['trailing space refused', W, 'C:\\x.txt '],
  ['reserved device name refused', W, 'C:\\tmp\\NUL.txt'],
  ['wildcard refused', W, 'C:\\tmp\\*.txt'],
  ['control character refused', W, 'C:\\tmp\\a\u0007'],
  ['Kelvin sign is not folded to K (NTFS keeps them distinct)', W, 'C:\\\u212a'],
  ['sharp s keeps its code point (uppercase would change length)', W, 'C:\\straße'],
  ['posix keeps case', P, '/Users/Gopi/Notes.txt'],
  ['posix trailing slash and dots', P, '/home//gopi/./x/../notes/'],
  ['posix root', P, '/'],
  ['posix relative refused', P, 'home/gopi'],
];
// Equivalent spellings must hash the same; any spelling difference the canonicaliser doesn't fold must not.
const pathBindings = [
  ['equivalent spellings, one actionId', W, ['C:\\Users\\Gopi\\notes.txt', 'c:/users/gopi/NOTES.TXT', '\\\\?\\C:\\Users\\Gopi\\notes.txt', 'C:\\Users\\Gopi\\.\\x\\..\\notes.txt']],
  ['short and long names, one actionId', W, ['C:\\PROGRA~1\\App\\app.exe', 'C:\\Program Files\\App\\app.exe']],
  ['a different file, a different actionId (re-prompt)', W, ['C:\\Users\\Gopi\\notes.txt', 'C:\\Users\\Gopi\\notes.txt.bak']],
  ['posix case differs, different actionId (re-prompt)', P, ['/home/gopi/a', '/home/gopi/A']],
];

const expand = (p) => shortNames[p.toUpperCase()] ?? Object.entries(shortNames).find(([k]) => k.toUpperCase() === p.toUpperCase())?.[1] ?? (() => {
  // prefix match: expand the longest short prefix, keep the rest.
  const hit = Object.keys(shortNames).filter((k) => p.toUpperCase().startsWith(k.toUpperCase() + '\\')).sort((a, b) => b.length - a.length)[0];
  return hit ? shortNames[hit] + p.slice(hit.length) : undefined;
})();
const tryOr = (f) => { try { return { ok: f() }; } catch (e) { if (e instanceof CanonicalError) return { error: e.message }; throw e; } };

export function build() {
  return {
    _readme: [
      'Dottie actionId / canonical JSON vectors (ADR-0009 CR2, CONTRACTS §3.3, E08 DOT-090 follow-ups 7-8). Generated by packages/contracts/scripts/action-id-vectors.mjs; do not edit by hand.',
      'Markers: {"$number":"NaN"|"Infinity"|"-Infinity"|"-0"} and {"$bigint":"<decimal>"} stand for values JSON text cannot carry faithfully; decode them before canonicalising.',
      'canonicalJson: scalar leaves become strings (booleans "true"/"false", integers decimal), keys sorted by code point recursively, no whitespace, ensure_ascii=False escaping. Python: json.dumps(stringify_leaves(v), sort_keys=True, separators=(",",":"), ensure_ascii=False).',
      'actionId = lowercase hex sha256(utf8(canonicalJson(actionObject))) where actionObject adds purpose "dottie.actionId.v1"; path args must be canonicalPath()-ed first (see "paths"; "shortNames" is the expander table those vectors assume).',
      'requestSource (CR2 key next to displayHash, CONTRACTS e41d1ca rulings 1r/1u): codex | tool_host | coordinator; coordinator exactly for method dottie.pre_dispatch_confirmation. displayHash (CR2 key, rulings 1k/1l/1q) = lowercase hex sha256(utf8(canonicalJson(display))) of the bound ApprovalDisplay ("displays"; key names per E01 ruling 1v = E03 DISPLAY_KEYS; counts and flags are strings); null ONLY for calls that open no dialog (navigate). Each actionId vector names the display it binds ("display"); pre-dispatch vectors bind it twice (args.displayHash and displayHash).',
      '"displayCuts": the cut rule for cross-checking E03 (f3672da): untrusted fields strip hidden characters first, then any field over "max" code points becomes max-1 code points + U+2026 (exactly max); bound fields (windowTitle) are cut, never stripped.',
      '"error" entries must be rejected (INVALID_ARGUMENT); the message text is informative only.',
    ],
    purpose: 'dottie.actionId.v1',
    canonicalJson: canonicalCases.map(([name, input]) => ({ name, input, canonical: canonicalJson(decode(input)) })),
    canonicalJsonInvalid: canonicalInvalid.map(([name, input]) => ({ name, input, error: tryOr(() => canonicalJson(decode(input))).error ?? fail(name) })),
    displays: Object.entries(displays).map(([name, display]) => {
      if (!validateApprovalDisplay(display).ok) fail(name);
      return { name, display, canonical: canonicalJson(display), displayHash: computeDisplayHash(display) };
    }),
    displaysInvalid: displaysInvalid.map(([name, display]) => ({ name, display, error: validateApprovalDisplay(display).ok ? fail(name) : validateApprovalDisplay(display).issues.map((i) => `${i.path} ${i.message}`).join('; ') })),
    displayCuts: cutCases.map(([name, kind, field, raw]) => {
      const display = buildCut(kind, field, raw);
      if (!display) fail(name);
      const shown = kind === 'pre_dispatch' ? display.summaryUntrusted : display.app.windowTitle;
      return { name, field, max: DISPLAY_MAX[field], input: raw, inputCodePoints: [...raw].length, output: shown, outputCodePoints: [...shown].length, cut: shown !== raw.replace(/\u202E/g, kind === 'pre_dispatch' ? '' : '\u202E'), display, displayHash: computeDisplayHash(display) };
    }),
    actionId: actionCases.map(([name, input, display]) => ({ name, input, display, canonical: canonicalJson(actionIdObject(decode(input))), actionId: computeActionId(decode(input)) })),
    actionIdInvalid: actionInvalid.map(([name, input]) => ({ name, input, error: tryOr(() => computeActionId(decode(input))).error ?? fail(name) })),
    shortNames,
    paths: pathCases.map(([name, platform, raw]) => {
      const r = tryOr(() => canonicalPath(raw, { platform, expandShortName: expand }));
      return 'ok' in r ? { name, platform, raw, canonical: r.ok } : { name, platform, raw, error: r.error };
    }),
    pathBindings: pathBindings.map(([name, platform, raws]) => {
      const ids = raws.map((raw) => computeActionId({ ...base, method: 'item/fileChange/requestApproval', args: { changes: [{ path: canonicalPath(raw, { platform, expandShortName: expand }), kind: 'delete' }] } }));
      return { name, platform, raws, actionIds: ids, same: ids.every((x) => x === ids[0]) };
    }),
  };
}
function fail(name) { throw new Error(`vector "${name}" was expected to be rejected`); }
export { expand, base };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(build(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) { console.error('fixtures/action-id/vectors.json is stale: run npm run vectors'); process.exit(1); }
    console.log('action-id vectors up to date');
  } else { writeFileSync(OUT, text); console.log(`wrote ${OUT}`); }
}
