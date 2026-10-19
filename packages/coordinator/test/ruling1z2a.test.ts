/**
 * E01 ruling 1z (dottie-e01 492c01c), 2a (972d5f4) and 2b (97e7bc0: credential_access rejected for every kind; method
 * never cut). Since the re-vendor (now at E02 0146c90) these are enforced by the vendored validator itself
 * (validateApprovalDisplay / computeDisplayHash); these tests pin them through our builders, validateEvent and the port:
 * - 1z: a UI-action method is exactly ^(ui|window)\.[a-z][a-z0-9_]*$ (builder and validateEvent);
 * - 1z: delete/overwrite tool displays always carry paths[] and fileCount (the STRING '1' for one item);
 * - 2a: the coverage rule applies to kind `tool` only: pre_dispatch, codex_command and codex_file_change are valid
 *   for every category incl. read/navigate; ui_action stays local_change or stricter; tool read/navigate →
 *   display_unavailable; credential_access never, for any kind.
 * Kind `tool` rejects every `ui.`/`window.` prefix in any case (E01 1y + follow-up): our hasUiActionPrefix and, since
 * E02 0146c90, the vendored validator too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/contracts.js';
import { DISPLAY_KEYS as K, codexDisplay, isUiActionMethod, preDispatchDisplay, toolDisplay, uiActionDisplay } from '../src/display.js';
import { contractsActionIdPort } from '../src/actionIdPort.js';
import { canonicalJson, sha256Hex } from '../src/vendor/e02-contracts/canonical.js';
import { validateApprovalDisplay } from '../src/vendor/e02-contracts/display.js';
import { envelope, hexId } from './helpers.js';

type Json = Record<string, unknown>;
const SRC: Record<string, string> = { tool: 'tool_host', ui_action: 'tool_host', codex_command: 'codex', codex_file_change: 'codex', pre_dispatch: 'coordinator' };
const reqEnv = (display: Json, extra: Json = {}) => validateEvent({
  ...envelope('ApprovalRequested', {} as never), taskId: 'task_z',
  payload: { taskId: 'task_z', actionId: hexId('z'), summary: 's', risk: (display['risk'] as string) ?? 'low', expiry: '2026-10-19T00:00:00Z', category: display['category'], display, requestSource: SRC[display['kind'] as string], ...extra } as never,
});
const ui = (method: string, category = 'local_change') => uiActionDisplay({ category, method, appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' });
const UI_OK = { kind: 'ui_action', category: 'local_change', method: 'ui.click', app: { appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' } };

test('1z: UI-action method is exactly ^(ui|window)\\.[a-z][a-z0-9_]*$ in the builder and in validateEvent', () => {
  for (const m of ['ui.click', 'window.close', 'ui.key_press', 'window.minimize', 'ui.x1']) {
    assert.equal(isUiActionMethod(m), true, m);
    assert.ok(ui(m), `${m}: built`);
    assert.equal(reqEnv({ ...UI_OK, method: m }).ok, true, `${m}: validates`);
  }
  for (const m of ['ui.', 'window.', 'ui.Click', 'ui.1x', 'uix.click', 'ui.click.extra', 'UI.click', 'ui._x', 'ui.click ', 'ui.cl-ick', 'app.launch', 'ui']) {
    assert.equal(isUiActionMethod(m), false, m);
    assert.equal(ui(m), null, `${m}: builder refuses`);
    assert.equal(reqEnv({ ...UI_OK, method: m }).ok, false, `${m}: validateEvent rejects`);
  }
  // the prefix rule still keeps every ui./window.-prefixed id out of kind tool (no other tool may use them)
  for (const m of ['ui.', 'ui.Click', 'window.close']) {
    assert.equal(toolDisplay({ category: 'local_change', method: m, targetLabel: 'x', fields: { targets: ['C:\\A'] } }), null, `${m}: not a tool`);
    assert.equal(reqEnv({ kind: 'tool', category: 'local_change', method: m, targetLabel: 'x', targets: ['C:\\A'], itemCount: '1' }).ok, false, `${m}: tool rejected`);
  }
});

test('1z: delete/overwrite tool displays always carry paths[] and fileCount (string "1" for one item); missing or mismatched → rejected', () => {
  for (const category of ['delete', 'overwrite']) {
    const one = toolDisplay({ category, method: 'files.delete_item', targetLabel: 'One item', fields: { paths: ['C:\\A.TXT'] } })!;
    assert.deepEqual(one, { kind: 'tool', category, method: 'files.delete_item', targetLabel: 'One item', paths: ['C:\\A.TXT'], fileCount: '1' });
    assert.equal(typeof one[K.fileCount], 'string');
    assert.equal(reqEnv(one).ok, true, `${category}: single item valid`);
    assert.equal(toolDisplay({ category, method: 'files.delete_item', targetLabel: 'x', fields: {} }), null, `${category}: builder without paths`);
    assert.equal(toolDisplay({ category, method: 'files.delete_item', targetLabel: 'x', fields: { paths: [] } }), null, `${category}: builder with no path`);
    const { paths: _p, ...noPaths } = one;
    const { fileCount: _c, ...noCount } = one;
    assert.equal(reqEnv(noPaths).ok, false, `${category}: missing paths`);
    assert.equal(reqEnv(noCount).ok, false, `${category}: missing fileCount`);
    assert.equal(reqEnv({ ...one, fileCount: 1 }).ok, false, `${category}: fileCount as a number`);
    assert.equal(reqEnv({ ...one, fileCount: '2' }).ok, false, `${category}: fileCount != paths.length`);
    assert.equal(reqEnv({ ...one, paths: 'C:\\A.TXT' }).ok, false, `${category}: paths not a list`);
    assert.equal(reqEnv({ ...one, paths: ['C:\\A.TXT', 'C:\\B.TXT'], fileCount: '2' }).ok, true, `${category}: two items valid`);
  }
});

test('2a: pre_dispatch / codex_command / codex_file_change are valid for read and navigate (and hashable); tool and ui_action read/navigate → display_unavailable; credential_access never', () => {
  for (const category of ['read', 'navigate']) {
    const pd = preDispatchDisplay({ category, risk: 'low', possibleRepeat: null, retryOfTaskId: null, summary: 'Show old.log' });
    const cc = codexDisplay(category, { kind: 'codex_command', commandLine: 'type old.log', workingDirectory: 'C:\\TMP', networkAccess: false });
    const fc = codexDisplay(category, { kind: 'codex_file_change', paths: ['C:\\TMP\\OLD.LOG'] });
    assert.ok(cc, `${category}: codex_command built`);
    assert.ok(fc, `${category}: codex_file_change built`);
    for (const d of [pd, cc!, fc!]) {
      assert.equal(reqEnv(d).ok, true, `${category} ${String(d[K.kind])}: validates`);
      const h = contractsActionIdPort.computeDisplayHash!(d);
      assert.equal(h, sha256Hex(canonicalJson(d)), `${category} ${String(d[K.kind])}: displayHash = E02 canonical SHA-256`);
    }
    assert.equal(ui('ui.click', category), null, `${category}: ui_action stays local_change or stricter`);
    assert.equal(reqEnv({ ...UI_OK, category }).ok, false, `${category}: ui_action rejected`);
    assert.equal(toolDisplay({ category, method: 'files.read_text', targetLabel: 'x', fields: {} }), null, `${category}: tool builder → display_unavailable`);
    assert.equal(reqEnv({ kind: 'tool', category, method: 'files.read_text', targetLabel: 'x' }).ok, false, `${category}: tool rejected`);
    assert.throws(() => contractsActionIdPort.computeDisplayHash!({ kind: 'tool', category, method: 'files.read_text', targetLabel: 'x' }), `${category}: tool display not hashable`);
  }
  // credential_access: no display of any kind
  const ccred = codexDisplay('credential_access', { kind: 'codex_file_change', paths: ['C:\\A'] });
  assert.equal(ccred, null, 'credential_access: codex builder refuses');
  const pcred = preDispatchDisplay({ category: 'credential_access', risk: 'critical', possibleRepeat: null, retryOfTaskId: null, summary: 'x' });
  assert.equal(reqEnv(pcred).ok, false, 'credential_access pre_dispatch rejected');
  assert.throws(() => contractsActionIdPort.computeDisplayHash!(pcred), 'credential_access not hashable');
  // other fields are still checked by the vendored validator for read/navigate displays
  const pdBad = { ...preDispatchDisplay({ category: 'read', risk: 'low', possibleRepeat: null, retryOfTaskId: null, summary: 's' }), [K.summary]: 'x'.repeat(501) };
  assert.equal(reqEnv(pdBad).ok, false, 'read pre_dispatch: summary limit still enforced');
  assert.throws(() => contractsActionIdPort.computeDisplayHash!(pdBad));
  const fcBad = { ...codexDisplay('navigate', { kind: 'codex_file_change', paths: ['C:\\A'] })!, [K.fileCount]: '2' };
  assert.equal(reqEnv(fcBad).ok, false, 'navigate codex_file_change: fileCount still enforced');
});

test('2b: credential_access is rejected for every display kind (builders, validateEvent, port hash)', () => {
  const cat = 'credential_access';
  const pd = preDispatchDisplay({ category: cat, risk: 'critical', possibleRepeat: null, retryOfTaskId: null, summary: 'x' });
  const shapes: Json[] = [
    pd,
    { kind: 'codex_command', category: cat, commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: 'not_requested', escalation: [], reasonUntrusted: null },
    { kind: 'codex_file_change', category: cat, paths: ['C:\\A'], fileCount: '1', reasonUntrusted: null },
    { ...UI_OK, category: cat },
    { kind: 'tool', category: cat, method: 'vault.get_item', targetLabel: 'x' },
  ];
  for (const d of shapes) {
    assert.equal(reqEnv(d).ok, false, `${String(d[K.kind])}: validateEvent`);
    assert.equal(validateApprovalDisplay(d).ok, false, `${String(d[K.kind])}: vendored validator`);
    assert.throws(() => contractsActionIdPort.computeDisplayHash!(d as never), `${String(d[K.kind])}: not hashable`);
  }
  assert.equal(codexDisplay(cat, { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false }), null);
  assert.equal(codexDisplay(cat, { kind: 'codex_file_change', paths: ['C:\\A'] }), null);
  assert.equal(ui('ui.click', cat), null);
  assert.equal(toolDisplay({ category: cat, method: 'vault.get_item', targetLabel: 'x', fields: {} }), null);
});

test('1y prefix rule (our guard AND, since E02 0146c90, the vendored validator): kind tool rejects every ui./window. method in any case, also the ones the 1z regex does not match', () => {
  for (const m of ['ui.', 'window.', 'ui.Click', 'ui.1x', 'ui.click.extra', 'window.Close', 'UI.x', 'Window.close', 'ui.click']) {
    const d = { kind: 'tool', category: 'local_change', method: m, targetLabel: 'x', targets: ['C:\\A'], itemCount: '1' };
    // E02 0146c90 (1y follow-up) rejects these too; at 2581593 it accepted them (strict-1z tool check)
    assert.equal(validateApprovalDisplay(d).ok, false, `${m}: vendored validator rejects`);
    assert.equal(reqEnv(d).ok, false, `${m}: validateEvent rejects`);
    assert.equal(toolDisplay({ category: 'local_change', method: m, targetLabel: 'x', fields: { targets: ['C:\\A'] } }), null, `${m}: builder refuses`);
  }
});
