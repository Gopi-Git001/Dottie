/**
 * (1) E01 1y follow-up (E02 0146c90): kind `tool` rejects ANY ui./window. method, in any case (UI.x, Window.close, …);
 *     our hasUiActionPrefix was case-sensitive, so the tool builder let them through.
 * (2) Prototype-key hardening: category / kind / tool / field names such as 'toString', '__proto__', 'constructor',
 *     'hasOwnProperty' must give a clean rejection (null / display_unavailable / unknown / validateEvent false), never
 *     a throw and never a valid result. Lookups are own-property only; inherited display fields don't count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateEvent } from '../src/contracts.js';
import { DISPLAY_KEYS as K, codexDisplay, hasUiActionPrefix, plainOwnDisplay, preDispatchDisplay, toolDisplay, uiActionDisplay, type ApprovalDisplay } from '../src/display.js';
import { contractsActionIdPort } from '../src/actionIdPort.js';
import { PinnedToolCatalog } from '../src/toolCatalog.js';
import { validateApprovalDisplay } from '../src/vendor/e02-contracts/display.js';
import type { ApprovalDecision } from '../src/ports.js';
import { allowAllChannels, envelope, fileParams, fixture, flush, hexId } from './helpers.js';

type Json = Record<string, unknown>;
const SRC: Record<string, string> = { tool: 'tool_host', ui_action: 'tool_host', codex_command: 'codex', codex_file_change: 'codex', pre_dispatch: 'coordinator' };
const ev = (display: unknown, extra: Json = {}) => validateEvent({
  ...envelope('ApprovalRequested', {} as never), taskId: 'task_p',
  payload: { taskId: 'task_p', actionId: hexId('p'), summary: 's', risk: 'high', expiry: '2026-10-19T00:00:00Z', category: (display as Json)?.['category'] ?? 'local_change', display, requestSource: SRC[String((display as Json)?.['kind'])] ?? 'tool_host', ...extra } as never,
});
const tool = (method: string, category = 'local_change') => toolDisplay({ category, method, targetLabel: 'x', fields: { targets: ['C:\\A'] } });
const toolShape = (method: string): Json => ({ kind: 'tool', category: 'local_change', method, targetLabel: 'x', targets: ['C:\\A'], itemCount: '1' });

test('1y follow-up: kind tool rejects every ui./window. method in ANY case (builder and validateEvent); uix.click / file.read are tools', () => {
  for (const m of ['UI.x', 'Window.close', 'WINDOW.focus', 'Ui.click', 'uI.Type', 'ui.click', 'window.close', 'ui.Click', 'window.']) {
    assert.equal(hasUiActionPrefix(m), true, m);
    assert.equal(tool(m), null, `${m}: tool builder refuses`);
    assert.equal(ev(toolShape(m)).ok, false, `${m}: validateEvent rejects`);
  }
  for (const m of ['uix.click', 'file.read', 'windows.open', 'uiclick', 'app.launch']) {
    assert.equal(hasUiActionPrefix(m), false, m);
    const d = tool(m);
    assert.ok(d, `${m}: a tool`);
    assert.equal(ev(d).ok, true, `${m}: valid tool display`);
  }
});

const PROTO = ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__defineGetter__'];

test('prototype keys: every builder given a prototype-name category returns null or a display validateEvent rejects; never throws, never valid', () => {
  for (const p of PROTO) {
    assert.doesNotThrow(() => tool('files.move', p), `tool ${p}`);
    assert.equal(tool('files.move', p), null, `tool category ${p}`);
    assert.equal(uiActionDisplay({ category: p, method: 'window.close', appName: 'N', windowTitle: 'w', processImage: 'n.exe' }), null, `ui_action ${p}`);
    assert.equal(codexDisplay(p, { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false }), null, `codex_command ${p}`);
    assert.equal(codexDisplay(p, { kind: 'codex_file_change', paths: ['C:\\A'] }), null, `codex_file_change ${p}`);
    assert.equal(codexDisplay('local_change', { kind: p, paths: ['C:\\A'] }), null, `codex params kind ${p}`);
    const pd = preDispatchDisplay({ category: p, risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' });
    assert.equal(ev(pd).ok, false, `pre_dispatch ${p}: rejected`);
    assert.throws(() => contractsActionIdPort.computeDisplayHash!(pd), (e: Error) => e.name === 'CanonicalError', `pre_dispatch ${p}: clean CanonicalError`);
    // a prototype name as a tool FIELD key
    assert.equal(toolDisplay({ category: 'local_change', method: 'files.move', targetLabel: 'x', fields: { targets: ['C:\\A'], [p]: 'x' } }), null, `tool field ${p}`);
    assert.equal(toolDisplay({ category: 'external_send', method: 'mail.send', targetLabel: 'x', fields: { recipients: ['a@b.c'], channel: 'email', bodyUntrusted: 'hi', [p]: 'x' } }), null, `external_send field ${p}`);
  }
});

test('prototype keys: validateEvent rejects a prototype-name kind, category, or extra display key, for every kind; never throws', () => {
  const good: Json[] = [
    preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' }),
    codexDisplay('delete', { kind: 'codex_file_change', paths: ['C:\\A'] })!,
    codexDisplay('delete', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false })!,
    uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'N', windowTitle: 'w', processImage: 'n.exe' })!,
    tool('files.move')!,
  ];
  for (const g of good) assert.equal(ev(g).ok, true, `${String(g[K.kind])}: baseline valid`);
  for (const p of PROTO) {
    for (const g of good) {
      const name = `${String(g[K.kind])} / ${p}`;
      for (const bad of [{ ...g, [K.kind]: p }, { ...g, [K.category]: p }, { ...g, [p]: 'x' }, JSON.parse(JSON.stringify(g).replace(/^\{/, `{"${p}":"x",`))]) {
        assert.doesNotThrow(() => ev(bad), name);
        assert.equal(ev(bad).ok, false, `${name}: rejected`);
        assert.doesNotThrow(() => validateApprovalDisplay(bad), `${name}: vendored`);
      }
      assert.equal(ev(g, { category: p }).ok, false, `${name}: event category`);
      assert.equal(ev(g, { requestSource: p }).ok, false, `${name}: requestSource`);
    }
  }
});

test('prototype keys: a display whose fields are INHERITED (not own) is rejected by validateEvent and the port, never hashed as {}', () => {
  const g = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' });
  const inherited = Object.create(g) as ApprovalDisplay;
  assert.equal(ev(inherited).ok, false, 'pre_dispatch with inherited fields');
  assert.throws(() => contractsActionIdPort.computeDisplayHash!(inherited), 'port');
  const u = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'N', windowTitle: 'w', processImage: 'n.exe' })!;
  const inheritedApp = { ...u, [K.app]: Object.create(u[K.app] as object) };
  assert.equal(ev(inheritedApp).ok, false, 'ui_action app with inherited fields');
  assert.throws(() => contractsActionIdPort.computeDisplayHash!(inheritedApp as ApprovalDisplay), 'port (app)');
  const nullProto = Object.assign(Object.create(null), g) as ApprovalDisplay;
  assert.equal(ev(nullProto).ok, true, 'a null-prototype object with own fields is fine');
});

test('prototype keys: toolCatalog categoryOf is own-entry only: prototype-name toolIds are unknown unless listed; a prototype-name category is unknown', () => {
  const json = JSON.stringify([
    { toolId: 'files.search', category: 'read', scope: 'files.read' },
    { toolId: 'toString', category: 'delete', scope: 'files.write' },
    { toolId: 'odd.cat', category: 'constructor', scope: 'files.read' },
  ]);
  const sha = createHash('sha256').update(json).digest('hex');
  const c = PinnedToolCatalog.fromPinned(json, sha);
  assert.equal(c.verified, true);
  assert.equal(c.categoryOf('toString'), 'delete', 'listed own entry');
  assert.equal(c.categoryOf('odd.cat'), undefined, 'a prototype-name category is not a category');
  for (const p of PROTO.filter(x => x !== 'toString')) {
    assert.doesNotThrow(() => c.categoryOf(p));
    assert.equal(c.categoryOf(p), undefined, `${p}: unknown`);
  }
  const withProtoKey = '[{"toolId":"a.b","category":"read","scope":"files.read","__proto__":{"x":1}}]';
  const c2 = PinnedToolCatalog.fromPinned(withProtoKey, createHash('sha256').update(withProtoKey).digest('hex'));
  assert.equal(c2.verified, false, 'an own "__proto__" key is an extra key: the file fails closed');
});

test('prototype keys end to end: a Codex approval with a prototype-name category is declined display_unavailable, no dialog', async () => {
  for (const p of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    const f = await fixture({ policy: allowAllChannels });
    const answers: ApprovalDecision[] = [];
    f.codex.scripts.push(async ({ hooks }) => {
      answers.push(await hooks.requestApproval({ actionId: hexId(`proto_${p}`), summary: 'x', risk: 'high', category: p as never, toolId: 'files.delete', display: fileParams() }));
      return { status: 'completed', summary: 'ok' };
    });
    f.say('do it', `req_proto_${p}`);
    await flush();
    await f.drain();
    assert.deepEqual(answers, [{ approved: false, reason: 'display_unavailable' }], p);
    assert.equal(f.sink.of('ApprovalRequested').length, 0, `${p}: no dialog`);
  }
});

test('prototype keys: an event whose payload fields are INHERITED is rejected by validateEvent (own fields only)', () => {
  const display = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' });
  const payload = { taskId: 'task_p', actionId: hexId('p'), summary: 's', risk: 'high', expiry: '2026-10-19T00:00:00Z', category: 'delete', display, requestSource: 'coordinator' };
  const base = { ...envelope('ApprovalRequested', {} as never), taskId: 'task_p' };
  assert.equal(validateEvent({ ...base, payload }).ok, true, 'baseline');
  assert.equal(validateEvent({ ...base, payload: Object.create(payload) }).ok, false, 'inherited payload fields');
  assert.equal(validateEvent(Object.assign(Object.create({ schema: base.schema, version: base.version }), { ...base, payload, schema: undefined, version: undefined })).ok, false, 'inherited envelope fields');
});

test('prototype keys: plainOwnDisplay accepts only plain / null-prototype objects whose nested objects are plain too', () => {
  const g = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'N', windowTitle: 'w', processImage: 'n.exe' })!;
  assert.equal(plainOwnDisplay(g), true);
  assert.equal(plainOwnDisplay(JSON.parse(JSON.stringify(g))), true);
  assert.equal(plainOwnDisplay(Object.assign(Object.create(null), g)), true);
  assert.equal(plainOwnDisplay(Object.create(g)), false, 'inherited fields');
  assert.equal(plainOwnDisplay({ ...g, [K.app]: Object.create(g[K.app] as object) }), false, 'inherited app fields');
  class D { kind = 'ui_action'; }
  assert.equal(plainOwnDisplay(new D()), false, 'class instance');
  assert.equal(plainOwnDisplay({ ...g, [K.app]: new Map() }), false, 'a Map inside');
  for (const v of [null, [], 'x', 1, undefined]) assert.equal(plainOwnDisplay(v), false, String(v));
});
