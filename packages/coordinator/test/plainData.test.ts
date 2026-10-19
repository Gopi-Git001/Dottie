/**
 * E02 45129fe (plain data only): at OUR boundary (validateEvent, the display builders, the ActionIdPort and a Codex
 * approval end to end), a sparse paths list, a getter-defined field, a symbol key and an unknown payload key named
 * 'constructor' / 'toString' / 'valueOf' each give a clean rejection (validateEvent false, builder null, CanonicalError)
 * or display_unavailable: never a throw, never a valid result, never an ApprovalRequested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/contracts.js';
import { DISPLAY_KEYS as K, codexDisplay, preDispatchDisplay, toolDisplay, uiActionDisplay, type ApprovalDisplay, type CodexDisplayParams } from '../src/display.js';
import { contractsActionIdPort } from '../src/actionIdPort.js';
import type { ApprovalDecision } from '../src/ports.js';
import { allowAllChannels, envelope, fixture, flush, hexId } from './helpers.js';

type Json = Record<string, unknown>;
const SRC: Record<string, string> = { tool: 'tool_host', ui_action: 'tool_host', codex_command: 'codex', codex_file_change: 'codex', pre_dispatch: 'coordinator' };
const approvalEvent = (display: unknown, extra: Json = {}) => ({
  ...envelope('ApprovalRequested', {} as never), taskId: 'task_pd',
  payload: { taskId: 'task_pd', actionId: hexId('pd'), summary: 's', risk: 'high', expiry: '2026-10-19T00:00:00Z', category: (display as Json)['category'], display, requestSource: SRC[String((display as Json)['kind'])], ...extra },
});
/** validateEvent never throws and rejects. */
function rejects(input: unknown, label: string) {
  let r: ReturnType<typeof validateEvent> | undefined;
  assert.doesNotThrow(() => { r = validateEvent(input); }, `${label}: no throw`);
  assert.equal(r!.ok, false, `${label}: rejected`);
}
/** The port refuses with a clean CanonicalError (never hashes). */
const portRefuses = (d: unknown, label: string) =>
  assert.throws(() => contractsActionIdPort.computeDisplayHash!(d as ApprovalDisplay), (e: Error) => e.name === 'CanonicalError', `${label}: port CanonicalError`);
const sparse = (...xs: string[]): string[] => { const a = [...xs]; a.length = xs.length + 1; return a; }; // trailing hole
const holeInside = (): string[] => { const a: string[] = []; a[0] = 'C:\\A'; a[2] = 'C:\\B'; return a; };
const fileChange = (): Json => codexDisplay('delete', { kind: 'codex_file_change', paths: ['C:\\A', 'C:\\B'] }) as unknown as Json;
const withGetter = (o: Json, k: string, value: unknown, throwing = false): Json => {
  const c = { ...o };
  delete c[k];
  Object.defineProperty(c, k, { enumerable: true, configurable: true, get: () => { if (throwing) throw new Error('getter boom'); return value; } });
  return c;
};

test('plain data: baseline displays are valid (so each rejection below is the gap, not the fixture)', () => {
  assert.equal(validateEvent(approvalEvent(fileChange())).ok, true);
  const pd = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' });
  assert.equal(validateEvent(approvalEvent(pd)).ok, true);
});

test('plain data: a SPARSE paths list is rejected by validateEvent, refused by the builders and the port (no throw)', () => {
  for (const [label, paths] of [['trailing hole', sparse('C:\\A', 'C:\\B')], ['hole inside', holeInside()]] as const) {
    const d = { ...fileChange(), [K.paths]: paths, [K.fileCount]: String(paths.length) };
    rejects(approvalEvent(d), `codex_file_change ${label}`);
    portRefuses(d, label);
    assert.equal(codexDisplay('delete', { kind: 'codex_file_change', paths } as CodexDisplayParams), null, `codexDisplay ${label}`);
    assert.equal(toolDisplay({ category: 'delete', method: 'files.delete', targetLabel: 'x', fields: { paths } }), null, `toolDisplay ${label}`);
    const tool = { kind: 'tool', category: 'delete', method: 'files.delete', targetLabel: 'x', paths, fileCount: String(paths.length) };
    rejects(approvalEvent(tool), `tool ${label}`);
  }
  const esc = sparse('admin');
  assert.equal(codexDisplay('local_change', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false, escalation: esc } as CodexDisplayParams), null, 'codex_command sparse escalation');
});

test('plain data: a GETTER-defined field (even one that throws) is rejected by validateEvent and the port and refused by the builder; nothing invokes a throwing getter', () => {
  const pd = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' }) as unknown as Json;
  for (const throwing of [false, true]) {
    const t = throwing ? ' (throwing)' : '';
    rejects(approvalEvent(withGetter(pd, K.summary, 's', throwing)), `pre_dispatch summaryUntrusted getter${t}`);
    portRefuses(withGetter(pd, K.summary, 's', throwing), `pre_dispatch getter${t}`);
    const u = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'N', windowTitle: 'w', processImage: 'n.exe' }) as unknown as Json;
    rejects(approvalEvent({ ...u, [K.app]: withGetter(u[K.app] as Json, K.windowTitle, 'w', throwing) }), `ui_action app.windowTitle getter${t}`);
    rejects(approvalEvent(withGetter(fileChange(), K.paths, ['C:\\A', 'C:\\B'], throwing)), `paths getter${t}`);
    let built: unknown = 'unset';
    assert.doesNotThrow(() => { built = codexDisplay('local_change', withGetter({ kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false }, 'commandLine', 'dir', throwing)); }, `codexDisplay getter${t}: no throw`);
    assert.equal(built, null, `codexDisplay getter params${t} → null`);
    const ev = approvalEvent(fileChange());
    rejects({ ...ev, payload: withGetter(ev.payload as Json, 'summary', 's', throwing) }, `payload.summary getter${t}`);
    let tb: unknown = 'unset';
    assert.doesNotThrow(() => { tb = toolDisplay({ category: 'local_change', method: 'files.move', targetLabel: 'x', fields: withGetter({}, 'targets', ['C:\\A'], throwing) as never }); }, `toolDisplay getter${t}: no throw`);
    assert.equal(tb, null, `toolDisplay getter fields${t} → null`);
  }
});

test('plain data: a SYMBOL key on the display, the app, the Codex params or the payload is rejected / refused', () => {
  const s = Symbol('x');
  const fc = { ...fileChange(), [s]: 'hidden' };
  rejects(approvalEvent(fc), 'display symbol key');
  portRefuses(fc, 'display symbol key');
  const u = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'N', windowTitle: 'w', processImage: 'n.exe' }) as unknown as Json;
  rejects(approvalEvent({ ...u, [K.app]: { ...(u[K.app] as Json), [s]: 1 } }), 'app symbol key');
  assert.equal(codexDisplay('delete', { kind: 'codex_file_change', paths: ['C:\\A'], [s]: 1 } as unknown as CodexDisplayParams), null, 'codex params symbol key');
  assert.equal(toolDisplay({ category: 'local_change', method: 'files.move', targetLabel: 'x', fields: { targets: ['C:\\A'], [s]: 'x' } as never }), null, 'tool fields symbol key');
  const ev = approvalEvent(fileChange());
  rejects({ ...ev, payload: { ...(ev.payload as Json), [s]: 1 } }, 'payload symbol key');
});

test('plain data: an unknown payload key named constructor / toString / valueOf (or any other unknown key) is rejected, for ApprovalRequested and every other event type', () => {
  const ev = approvalEvent(fileChange());
  const fin = { ...envelope('TaskFinished', { taskId: 'task_pd', outcome: 'failed', verified: false, summary: 's' }), taskId: 'task_pd' };
  const res = { ...envelope('ApprovalResolved', { actionId: hexId('pd'), approved: false, timestamp: '2026-10-19T00:00:00Z' }), taskId: 'task_pd' };
  for (const base of [ev, fin, res] as Json[]) assert.equal(validateEvent(base).ok, true, `${String(base['type'])} baseline`);
  for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'notAField']) {
    for (const base of [ev, fin, res] as Json[]) {
      const payload = JSON.parse(JSON.stringify(base['payload']).replace(/^\{/, `{${JSON.stringify(k)}:"x",`)) as Json; // an OWN key, also for __proto__
      assert.ok(Object.hasOwn(payload, k), `${k} is own`);
      rejects({ ...base, payload }, `${String(base['type'])} payload.${k}`);
    }
    const d = JSON.parse(JSON.stringify(fileChange()).replace(/^\{/, `{${JSON.stringify(k)}:"x",`));
    rejects(approvalEvent(d), `display.${k}`);
    portRefuses(d, `display.${k}`);
  }
});

test('plain data end to end: Codex approvals whose params are sparse / getter / symbol are declined display_unavailable; no ApprovalRequested, no throw', async () => {
  const s = Symbol('x');
  const cases: [string, () => unknown][] = [
    ['sparse paths', () => ({ kind: 'codex_file_change', paths: sparse('C:\\A') })],
    ['getter paths', () => withGetter({ kind: 'codex_file_change' }, 'paths', ['C:\\A'])],
    ['throwing getter', () => withGetter({ kind: 'codex_file_change' }, 'paths', ['C:\\A'], true)],
    ['symbol key', () => ({ kind: 'codex_file_change', paths: ['C:\\A'], [s]: 1 })],
  ];
  for (const [label, params] of cases) {
    const f = await fixture({ policy: allowAllChannels });
    const answers: ApprovalDecision[] = [];
    f.codex.scripts.push(async ({ hooks }) => {
      answers.push(await hooks.requestApproval({ actionId: hexId(`pd_${label}`), summary: 'Delete', risk: 'high', category: 'delete', toolId: 'files.delete', display: params() as CodexDisplayParams }));
      return { status: 'completed', summary: 'ok' };
    });
    f.say('delete it', `req_pd_${label.replace(/ /g, '_')}`);
    await flush();
    await f.drain();
    assert.deepEqual(answers, [{ approved: false, reason: 'display_unavailable' }], label);
    assert.equal(f.sink.of('ApprovalRequested').length, 0, `${label}: no dialog`);
  }
});

test('plain data: list fields: a sparse or getter-indexed list (even a throwing one) is rejected at the event level and inside the display, never read', () => {
  const getterList = (throwing: boolean): string[] => {
    const a = ['C:\\A', 'C:\\B'];
    Object.defineProperty(a, 1, { enumerable: true, configurable: true, get: () => { if (throwing) throw new Error('index getter boom'); return 'C:\\B'; } });
    return a;
  };
  for (const throwing of [false, true]) {
    const t = throwing ? ' (throwing)' : '';
    rejects(approvalEvent({ ...fileChange(), [K.paths]: getterList(throwing) }), `display paths getter index${t}`);
    assert.equal(codexDisplay('delete', { kind: 'codex_file_change', paths: getterList(throwing) }), null, `codexDisplay getter index${t}`);
  }
  const cancelled = (committedActions: unknown) => ({
    ...envelope('TaskCancelled', { taskId: 'task_pd', stopStatus: 'stopped_before_dispatch', sideEffects: 'none', sideEffectsCommitted: false, committedActions, report: 'r' } as never), taskId: 'task_pd',
  });
  assert.equal(validateEvent(cancelled([])).ok, true, 'baseline TaskCancelled');
  const holey: unknown[] = []; holey.length = 1;
  rejects(cancelled(holey), 'payload.committedActions sparse');
  const extra = Object.assign([], { note: 'x' });
  rejects(cancelled(extra), 'payload.committedActions with an extra own key');
});
