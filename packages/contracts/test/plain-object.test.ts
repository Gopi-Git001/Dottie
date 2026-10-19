// E03 report (2026-10-19): the validators required keys with `in`, so a display whose fields were all inherited
// (Object.create({kind, ...})) validated while canonicalJson refused it. Validators now take plain data objects only
// (prototype Object.prototype or null; own enumerable data keys) and check every key with hasOwn, nested app and
// event payloads included, so what validates is exactly what hashes.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, computeActionId, computeDisplayHash, isPlainArray, isPlainObject, toolDisplay, uiActionDisplay, validateApprovalDisplay, validateEvent } from '../src/index.js';

const ui = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' })!;
const tool = toolDisplay({ category: 'delete', method: 'files.delete_item', targetLabel: 'Delete NOTES.TXT', fields: { paths: ['C:\\USERS\\GOPI\\NOTES.TXT'] } })!;
const EVENT = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/events/valid/approval-requested-ui-action.json', import.meta.url)), 'utf8')) as { payload: Record<string, unknown> & { display: Record<string, unknown> } };
const nullProto = <T extends object>(o: T): T => Object.assign(Object.create(null) as T, o);
const rejected = (d: unknown, why: string) => assert.equal(validateApprovalDisplay(d).ok, false, why);

test('baseline: the plain displays and the fixture event are valid', () => {
  assert.equal(validateApprovalDisplay(ui).ok, true);
  assert.equal(validateApprovalDisplay(tool).ok, true);
  assert.equal(validateEvent(EVENT).ok, true);
});

test('a display whose fields are inherited is rejected (top level and nested app), as canonicalJson refuses it', () => {
  for (const d of [ui, tool]) {
    const inherited = Object.create(d) as object;
    rejected(inherited, 'Object.create(display)');
    assert.throws(() => canonicalJson(inherited));
    assert.throws(() => computeDisplayHash(inherited as never));
    // Own kind, everything else inherited.
    const partly = Object.assign(Object.create(d) as object, { kind: d.kind });
    rejected(partly, 'partly inherited');
  }
  rejected({ ...ui, app: Object.create(ui.app) }, 'nested app inherited');
  rejected({ ...ui, app: Object.assign(Object.create({ processImage: 'notepad.exe' }) as object, { appName: 'Notepad', windowTitle: 't' }) }, 'one app field inherited');
  // Event validator: inherited envelope, payload or display.
  assert.equal(validateEvent(Object.create(EVENT)).ok, false, 'inherited envelope');
  assert.equal(validateEvent({ ...EVENT, payload: Object.create(EVENT.payload) }).ok, false, 'inherited payload');
  assert.equal(validateEvent({ ...EVENT, payload: { ...EVENT.payload, display: Object.create(EVENT.payload.display) } }).ok, false, 'inherited display');
});

test('a class instance is rejected, even with only own data fields', () => {
  class ToolDisplayObj {
    constructor() { Object.assign(this, tool); }
  }
  class AppObj {
    appName = 'Notepad'; windowTitle = 't'; processImage = 'notepad.exe';
  }
  const inst = new ToolDisplayObj();
  assert.deepEqual(Object.keys(inst).sort(), Object.keys(tool).sort());
  rejected(inst, 'class instance');
  rejected({ ...ui, app: new AppObj() }, 'class instance app');
  for (const x of [new Date(), new Map(), [tool], new (class extends Array {})()]) rejected(x, String(x?.constructor?.name));
  class Payload { constructor() { Object.assign(this, EVENT.payload); } }
  assert.equal(validateEvent({ ...EVENT, payload: new Payload() }).ok, false, 'class instance payload');
});

test('a null-prototype object is accepted when otherwise valid, and hashes the same', () => {
  const n = nullProto({ ...ui, app: nullProto({ ...ui.app }) });
  assert.equal(Object.getPrototypeOf(n), null);
  assert.equal(validateApprovalDisplay(n).ok, true);
  assert.equal(computeDisplayHash(n), computeDisplayHash(ui));
  assert.equal(validateApprovalDisplay(nullProto({ ...tool })).ok, true);
  const ev = nullProto({ ...EVENT, payload: nullProto({ ...EVENT.payload, display: nullProto({ ...EVENT.payload.display, app: nullProto({ ...(EVENT.payload.display['app'] as object) }) }) }) });
  assert.equal(validateEvent(ev).ok, true, 'null-prototype event');
  // ...but still strict: a null-prototype object missing a field is rejected.
  const { method: _m, ...rest } = ui;
  rejected(nullProto(rest), 'null-prototype, missing method');
});

test('a "__proto__" key in JSON-parsed input is an unknown own key: rejected, no prototype change, no pollution', () => {
  // JSON.parse makes "__proto__" an ordinary own data property; it never sets the prototype.
  const top = JSON.parse(JSON.stringify(ui).replace(/^\{/, '{"__proto__":{"isAdmin":true},')) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(top), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(top, '__proto__'));
  const r = validateApprovalDisplay(top);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === 'display.__proto__' && /not a field/.test(i.message)), JSON.stringify(r.issues));
  // All fields only under "__proto__": required keys are missing, nothing is read through it.
  const only = JSON.parse(`{"__proto__":${JSON.stringify(ui)}}`) as Record<string, unknown>;
  assert.equal(only['kind'], undefined, 'not inherited');
  rejected(only, 'fields only under __proto__');
  rejected(JSON.parse(JSON.stringify({ ...ui, app: { ...ui.app } }).replace('"app":{', '"app":{"__proto__":{"x":1},')), 'nested app __proto__ key');
  // Event payload with a "__proto__" key.
  const ev = JSON.parse(JSON.stringify(EVENT).replace('"payload":{', '"payload":{"__proto__":{"taskId":"evil"},')) as unknown;
  const re = validateEvent(ev);
  assert.equal(re.ok, false);
  assert.ok(!re.ok && re.issues.some((i) => i.path === 'payload.__proto__'), JSON.stringify(!re.ok && re.issues));
  // A JS object literal `{ __proto__: x }` DOES set the prototype: not plain, rejected.
  rejected({ __proto__: ui } as unknown, 'literal __proto__ sets the prototype');
  assert.equal(({} as Record<string, unknown>)['isAdmin'], undefined, 'Object.prototype not polluted');
  assert.equal(({} as Record<string, unknown>)['taskId'], undefined);
});

test('other non-plain shapes: getters, non-enumerable or symbol keys, sparse or decorated arrays', () => {
  const getter = { ...tool };
  Object.defineProperty(getter, 'method', { get: () => 'files.delete_item', enumerable: true });
  rejected(getter, 'accessor property');
  const hidden = { ...tool };
  Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
  rejected(hidden, 'non-enumerable own key');
  rejected({ ...tool, [Symbol('s')]: 1 }, 'symbol key');
  const sparse = ['C:\\A', 'C:\\B'];
  delete sparse[0];
  rejected({ ...tool, paths: sparse, fileCount: '2' }, 'sparse paths (forEach would skip the hole)');
  const decorated = Object.assign(['C:\\A'], { extra: 1 });
  rejected({ ...tool, paths: decorated }, 'array with an extra own key');
  assert.equal(isPlainArray(['a']), true);
  assert.equal(isPlainArray(Object.setPrototypeOf(['a'], null)), false);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  // An event key named like an Object.prototype member is an unknown field, not a known one.
  for (const k of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = validateEvent({ ...EVENT, payload: { ...EVENT.payload, [k]: 'x' } });
    assert.ok(!r.ok && r.issues.some((i) => i.path === `payload.${k}`), `payload.${k}`);
  }
});

test('computeActionId refuses an inherited binding', () => {
  const b = { method: 'files.delete_item', args: {}, targets: null, taskId: 't', threadId: null, turnId: null, itemId: null, requestId: null, displayHash: computeDisplayHash(tool), requestSource: 'tool_host' } as const;
  assert.match(computeActionId(b), /^[0-9a-f]{64}$/);
  assert.throws(() => computeActionId(Object.create(b)));
  assert.equal(computeActionId(nullProto({ ...b })), computeActionId(b));
});

test('arrays: an index that is a getter, non-enumerable or joined by a symbol key is not plain (display lists and event arrays)', () => {
  const withIndex = (desc: PropertyDescriptor) => {
    const a: string[] = ['C:\\B'];
    Object.defineProperty(a, 0, desc);
    return a;
  };
  const getterIdx = withIndex({ get: () => 'C:\\A', enumerable: true, configurable: true });
  const hiddenIdx = withIndex({ value: 'C:\\A', enumerable: false, writable: true, configurable: true });
  const symbolArr = Object.assign(['C:\\A'], { [Symbol('s')]: 1 });
  for (const [name, a] of [['getter index', getterIdx], ['non-enumerable index', hiddenIdx], ['symbol key', symbolArr]] as const) {
    assert.equal(isPlainArray(a), false, name);
    rejected({ ...tool, paths: a, fileCount: '1' }, `paths: ${name}`);
  }
  // list(): escalation (codex_command) and recipients (tool external_send) reject sparse lists too.
  const sparse = (xs: string[]) => { const a = [...xs]; delete a[0]; return a; };
  const send = toolDisplay({ category: 'external_send', method: 'mail.send_message', targetLabel: 'Send', fields: { recipients: ['a@example.com', 'b@example.com'], channel: 'email', bodyUntrusted: 'hi' } })!;
  assert.equal(validateApprovalDisplay(send).ok, true);
  rejected({ ...send, recipients: sparse(['a@example.com', 'b@example.com']) }, 'sparse recipients');
  // Event arrays (arrayOf): a sparse workspaceScope.paths is rejected.
  const TR = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/events/valid/task-requested.json', import.meta.url)), 'utf8')) as { payload: { workspaceScope: { scopes: string[]; paths: string[] } } };
  assert.equal(validateEvent(TR).ok, true);
  const ws = TR.payload.workspaceScope;
  const holey = [...ws.paths, ...ws.paths, 'C:\\X'];
  delete holey[0];
  const r = validateEvent({ ...TR, payload: { ...TR.payload, workspaceScope: { ...ws, paths: holey } } });
  assert.ok(!r.ok && r.issues.some((i) => i.path === 'payload.workspaceScope.paths'), JSON.stringify(!r.ok && r.issues));
});

test('a polluted Object.prototype / Array.prototype never supplies a missing field or array entry', () => {
  const OP = Object.prototype as Record<string, unknown>;
  const AP = Array.prototype as unknown as Record<number, unknown>;
  try {
    OP['targetLabel'] = 'Delete NOTES.TXT';
    OP['taskId'] = 'task-1';
    OP['method'] = 'window.close';
    AP[0] = 'C:\\A';
    const { targetLabel: _t, ...noLabel } = tool;
    rejected(noLabel, 'display: targetLabel only on Object.prototype');
    const { method: _m, ...noMethod } = ui;
    rejected(noMethod, 'ui_action: method only on Object.prototype');
    const { taskId: _k, ...noTask } = EVENT.payload;
    const r = validateEvent({ ...EVENT, payload: noTask });
    assert.ok(!r.ok && r.issues.some((i) => i.path === 'payload.taskId' && /required/.test(i.message)), 'event: taskId only on Object.prototype');
    const hole: unknown[] = [];
    hole.length = 1;
    assert.throws(() => canonicalJson(hole), /sparse/, 'canonicalJson: index 0 only on Array.prototype');
  } finally {
    delete OP['targetLabel'];
    delete OP['taskId'];
    delete OP['method'];
    delete AP[0];
  }
  assert.equal(({} as Record<string, unknown>)['taskId'], undefined);
  assert.equal(([] as unknown[])[0], undefined);
});
