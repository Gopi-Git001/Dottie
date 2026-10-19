/**
 * E01 ruling 2b (dottie-e01 97e7bc0; E02 2581593):
 * (a) a Codex approval always opens exactly one dialog or is declined, whatever its category; the category passes
 *     through UNCHANGED (no raise to local_change on our side; E02's bridge dropped its raise in 5fc689b), so a Codex
 *     read/navigate approval carries its real category on the event and in the bound (hashed) display;
 * (b) validateEvent requires display.category === payload.category for EVERY kind (E02's per-kind negative event
 *     fixtures, vendored verbatim from 2581593, plus our own per-kind cases in both directions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validateEvent } from '../src/contracts.js';
import { DISPLAY_KEYS as K, codexDisplay, preDispatchDisplay, toolDisplay, uiActionDisplay, type ApprovalDisplay } from '../src/display.js';
import type { ApprovalDecision, CodexApprovalRequest } from '../src/ports.js';
import { allowAllChannels, approval, displayHashOf, envelope, fixture, flush, hexId, type Fixture } from './helpers.js';

type Json = Record<string, unknown>;
const EV_DIR = new URL('../../test/fixtures/e02/events/invalid/', import.meta.url);
const errorsOf = (r: ReturnType<typeof validateEvent>) => (r.ok ? [] : [...r.errors]);
const CATEGORY_ISSUE = /payload\.display\.category must equal payload\.category/;

test('2b (b): E02 2581593 per-kind negative event fixtures (display.category ≠ event category) are rejected by our validateEvent at payload.display.category; the same event with matching categories is accepted', () => {
  const files = readdirSync(EV_DIR).filter(f => f.endsWith('.json')).sort();
  assert.deepEqual(files, [
    'approval-requested-codex-command-category-mismatch.json', 'approval-requested-codex-file-change-category-mismatch.json',
    'approval-requested-display-category-mismatch.json', 'approval-requested-pre-dispatch-category-mismatch.json', 'approval-requested-ui-action-category-mismatch.json',
  ]);
  const kinds: string[] = [];
  for (const f of files) {
    const fx = JSON.parse(readFileSync(new URL(f, EV_DIR), 'utf8')) as { errorPath: string; event: Json };
    assert.equal(fx.errorPath, 'payload.display.category', f);
    const payload = fx.event['payload'] as Json;
    const display = payload['display'] as Json;
    kinds.push(display['kind'] as string);
    assert.notEqual(display['category'], payload['category'], `${f}: a mismatch`);
    const bad = validateEvent(fx.event);
    assert.equal(bad.ok, false, `${f}: rejected`);
    assert.ok(errorsOf(bad).some(e => CATEGORY_ISSUE.test(e)), `${f}: at payload.display.category: ${errorsOf(bad).join(' | ')}`);
    const fixed = { ...fx.event, payload: { ...payload, display: { ...display, category: payload['category'] } } };
    const good = validateEvent(fixed);
    assert.equal(good.ok, true, `${f}: matching categories valid: ${errorsOf(good).join(' | ')}`);
  }
  assert.deepEqual(kinds.sort(), ['codex_command', 'codex_file_change', 'pre_dispatch', 'tool', 'ui_action']);
});

// Our own per-kind cases: each kind's builder output, event category equal (valid) and different (rejected), both
// directions, including read/navigate for the kinds that allow them (2a).
const SRC: Record<string, string> = { tool: 'tool_host', ui_action: 'tool_host', codex_command: 'codex', codex_file_change: 'codex', pre_dispatch: 'coordinator' };
const ev = (display: ApprovalDisplay, category: string) => validateEvent({
  ...envelope('ApprovalRequested', {} as never), taskId: 'task_b',
  payload: { taskId: 'task_b', actionId: hexId('b'), summary: 's', risk: (display[K.risk] as string) ?? 'high', expiry: '2026-10-19T00:00:00Z', category, display, requestSource: SRC[display[K.kind] as string] } as never,
});
const BUILD: Record<string, (category: string) => ApprovalDisplay | null> = {
  tool: c => toolDisplay({ category: c, method: 'files.delete_item', targetLabel: 'Delete A', fields: { paths: ['C:\\A'] } }),
  ui_action: c => uiActionDisplay({ category: c, method: 'window.close', appName: 'Notepad', windowTitle: 'notes.txt - Notepad', processImage: 'notepad.exe' }),
  codex_command: c => codexDisplay(c, { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false }),
  codex_file_change: c => codexDisplay(c, { kind: 'codex_file_change', paths: ['C:\\A'] }),
  pre_dispatch: c => preDispatchDisplay({ category: c, risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 'Delete A' }),
};
const PAIRS: Record<string, Array<[string, string]>> = {
  tool: [['delete', 'overwrite'], ['overwrite', 'delete']],
  ui_action: [['local_change', 'delete'], ['delete', 'local_change']],
  codex_command: [['read', 'local_change'], ['local_change', 'read'], ['navigate', 'delete']],
  codex_file_change: [['navigate', 'overwrite'], ['overwrite', 'navigate'], ['read', 'local_change']],
  pre_dispatch: [['delete', 'overwrite'], ['read', 'delete'], ['delete', 'read']],
};
for (const kind of Object.keys(BUILD)) {
  test(`2b (b): ${kind}: validateEvent requires display.category === payload.category (both directions)`, () => {
    for (const [dc, ec] of PAIRS[kind]!) {
      const d = BUILD[kind]!(dc);
      assert.ok(d, `${kind} ${dc}: built`);
      assert.equal(ev(d!, dc).ok, true, `${kind}: display ${dc} / event ${dc} valid`);
      const r = ev(d!, ec);
      assert.equal(r.ok, false, `${kind}: display ${dc} / event ${ec} rejected`);
      assert.ok(errorsOf(r).some(e => CATEGORY_ISSUE.test(e)), `${kind}: category issue: ${errorsOf(r).join(' | ')}`);
    }
  });
}

// ---------------------------------------------------------------- (a) Codex category passes through unchanged
async function codexApproval(f: Fixture, req: CodexApprovalRequest, n: string): Promise<{ decision: Promise<ApprovalDecision> }> {
  let decision!: Promise<ApprovalDecision>;
  f.codex.scripts.push(async ({ hooks }) => {
    decision = hooks.requestApproval(req);
    await decision;
    return { status: 'completed', summary: 'ok' };
  });
  f.say('look at the files', `req_2b_${n}`);
  await flush();
  await flush();
  return { decision: Promise.resolve().then(() => decision) };
}
for (const category of ['read', 'navigate', 'local_change', 'delete'] as const) {
  test(`2b (a): a Codex ${category} approval opens exactly one dialog with its real category (no raise), bound in the display hash, and can be approved`, async () => {
    const f = await fixture({ policy: allowAllChannels });
    const params = category === 'navigate' || category === 'delete'
      ? { kind: 'codex_file_change' as const, paths: ['C:\\USERS\\GOPI\\DOWNLOADS'] }
      : { kind: 'codex_command' as const, commandLine: 'Get-ChildItem C:\\Users\\gopi', workingDirectory: 'C:\\USERS\\GOPI', networkAccess: false };
    const { decision } = await codexApproval(f, { actionId: hexId(`cx2b_${category}`), summary: 'Codex approval', risk: 'low', category, display: params }, category);
    const reqs = f.sink.of('ApprovalRequested');
    assert.equal(reqs.length, 1, 'exactly one dialog');
    const p = reqs[0]!.payload;
    assert.equal(p.category, category, 'event category unchanged');
    assert.equal(p.display[K.category], category, 'display category unchanged');
    assert.deepEqual(p.display, codexDisplay(category, params));
    const h = displayHashOf(p.display);
    if (category !== 'local_change') assert.notEqual(h, displayHashOf(codexDisplay('local_change', params)!), 'the real category is in the hash (not local_change)');
    assert.equal(validateEvent(JSON.parse(JSON.stringify(reqs[0]))).ok, true);
    f.c.resolveApproval(approval(p.actionId, true, f), 'secure_ui');
    assert.deepEqual(await decision, { approved: true, reason: 'approved' });
    await f.drain();
  });
}
