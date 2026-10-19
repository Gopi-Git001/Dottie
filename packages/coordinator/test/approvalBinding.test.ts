/**
 * Pre-dispatch preimage binding + bound approval display (E01 rulings 1k, 1l, 1o, 1p, 1q; CONTRACTS §2.1, §3, §3.3):
 * - args {summary, risk, category, possibleRepeat, retryOfTaskId, displayHash} (six keys; all always present) and CR2
 *   top-level displayHash, byte-equal to args.displayHash (1q);
 * - display = {category, risk, possibleRepeat, retryOfTaskId, summary (untrusted slot)} (1l), hashed via ActionIdPort
 *   (test fake until E02's computeActionId/displayHash land; vectors re-pinned then);
 * - Codex approvals: display built by the coordinator from the adapter's validated params; none → declined
 *   display_unavailable (1o); full command / paths, 8 KB / 500-path limits, escalation bound, reason untrusted (1o);
 * - Codex joins: only the first request can be approved; every joined request declined duplicate_request at once (1o/1p);
 * - TaskProgress.redactedMetadata awaitingClarification/turnsSoFar (1o), awaitingClarification:true only in LISTENING (1q).
 * Display key names settled by E01 ruling 1v (display.ts DISPLAY_KEYS); limits are E02's FINAL values (1v).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/contracts.js';
import { DISPLAY_KEYS as K, preDispatchDisplay } from '../src/display.js';
import type { ApprovalDecision, CodexApprovalRequest, PolicyPort } from '../src/ports.js';
import { allowAllChannels, approval, envelope, displayHashOf, fileParams, fixture, flush, hexId, obs, RecordingActionIdPort, type Fixture } from './helpers.js';

type F = Fixture;
const HEX = /^[0-9a-f]{64}$/;
const confirm: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: (t: string) => (t.startsWith('delete') || t.startsWith('Retry') ? { summary: 'Delete old.log in Downloads', risk: 'high', category: 'delete' } : null) };
let rs = 0;
function sayRetry(f: F, retryOfTaskId: string) {
  f.c.handleWake(envelope('WakeDetected', { timestamp: '2026-10-18T13:00:00.000Z', deviceId: 'mic-1', confidence: 0.9 }));
  f.c.handleListeningStarted();
  f.c.handleCaptureEnded();
  return f.c.submitUtterance(envelope('UtteranceReady', { requestId: `req_b_retry_${++rs}`, text: 'Retry the last task.', locale: 'en-US', endReason: 'tray', retryOfTaskId })) as { taskId: string };
}
const cleanFail = async () => ({ status: 'failed' as const, error: { kind: 'fatal' as const, origin: 'turn_failed' as const, message: 'model error' } });
const unknownFail = async ({ hooks }: { hooks: { toolResult: (r: never) => void } }) => {
  hooks.toolResult({ toolId: 'files.delete', observedState: obs('?', 'unknown', false), verified: false, sideEffect: 'unknown', error: { code: 'POSTCONDITION_UNKNOWN', message: 'x', retryable: false } } as never);
  return { status: 'failed' as const, error: { kind: 'fatal' as const, origin: 'adapter' as const, message: 'x' } };
};
async function priorTask(f: F, script: Parameters<F['codex']['scripts']['push']>[0], text = 'open the report'): Promise<string> {
  f.codex.scripts.push(script);
  const p = f.say(text, `req_b_prior_${++rs}`) as { taskId: string };
  await f.drain();
  return p.taskId;
}
const lastReq = (f: F) => f.sink.of('ApprovalRequested').at(-1)!;
const lastBinding = (f: F) => f.actionIds!.bindings.at(-1)!;

// ---------------------------------------------------------------- pre-dispatch six-key binding
test('binding (§2.1, 1q): a non-retry confirmation binds possibleRepeat null and retryOfTaskId null; args.displayHash == top-level displayHash == hash of the emitted display', async () => {
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_b1');
  await flush();
  const req = lastReq(f);
  const b = lastBinding(f);
  const display = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 'Delete old.log in Downloads' });
  assert.deepEqual(req.payload.display, display, 'the dialog renders exactly the bound display');
  const h = displayHashOf(display);
  assert.deepEqual(b.args, { summary: 'Delete old.log in Downloads', risk: 'high', category: 'delete', possibleRepeat: null, retryOfTaskId: null, displayHash: h });
  assert.equal(b.displayHash, h, 'CR2 top-level displayHash (authoritative, 1q)');
  assert.equal((b.args as Record<string, unknown>)['displayHash'], b.displayHash, 'byte-equal');
  assert.deepEqual(f.actionIds!.displays, [display]);
  assert.deepEqual([b.method, b.targets, b.threadId, b.itemId, b.requestId, b.turnId], ['dottie.pre_dispatch_confirmation', null, null, null, 'req_b1', `${req.taskId}.t1`]);
  assert.ok(validateEvent(req).ok, JSON.stringify(validateEvent(req)));
  f.c.resolveApproval(approval(req.payload.actionId, true, f), 'secure_ui');
  await f.drain();
  assert.equal(f.codex.runs.length, 1);
});

test('binding (§2.1): a clean-failure retry with a policy-required approval binds retryOfTaskId with possibleRepeat null', async () => {
  const f = await fixture({ policy: confirm });
  const prior = await priorTask(f, cleanFail);
  const r = sayRetry(f, prior);
  await flush();
  const req = lastReq(f);
  assert.equal(req.taskId, r.taskId);
  assert.equal(req.payload.possibleRepeat, undefined);
  const b = lastBinding(f);
  assert.deepEqual([(b.args as Record<string, unknown>)['possibleRepeat'], (b.args as Record<string, unknown>)['retryOfTaskId']], [null, prior]);
  assert.deepEqual([req.payload.display[K.possibleRepeat], req.payload.display[K.retryOfTaskId]], [null, prior]);
  assert.ok(validateEvent(req).ok);
  f.c.resolveApproval(approval(req.payload.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('binding (§2.1): a possible-repeat retry binds possibleRepeat = priorSideEffect and retryOfTaskId = the prior task, in args and display', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await priorTask(f, unknownFail as never);
  sayRetry(f, prior);
  await flush();
  const req = lastReq(f);
  assert.deepEqual(req.payload.possibleRepeat, { priorTaskId: prior, priorSideEffect: 'unknown' });
  const b = lastBinding(f);
  assert.deepEqual([(b.args as Record<string, unknown>)['possibleRepeat'], (b.args as Record<string, unknown>)['retryOfTaskId']], ['unknown', prior]);
  assert.deepEqual([req.payload.display[K.possibleRepeat], req.payload.display[K.retryOfTaskId]], ['unknown', prior]);
  assert.equal((b.args as Record<string, unknown>)['displayHash'], displayHashOf(req.payload.display));
  assert.ok(validateEvent(req).ok, JSON.stringify(validateEvent(req)));
  f.c.resolveApproval(approval(req.payload.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('binding (§2.1 required tests): changing possibleRepeat, retryOfTaskId or the displayed summary between display and approval invalidates the approval; nothing is dispatched', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const prior = await priorTask(f, unknownFail as never);
  sayRetry(f, prior);
  await flush();
  const req = lastReq(f);
  const b = lastBinding(f);
  const port = new RecordingActionIdPort();
  const args = b.args as Record<string, string | null>;
  const variants: Array<[string, Record<string, string | null>, Record<string, string | null>]> = [
    ['possibleRepeat', { ...args, possibleRepeat: 'possible' }, { ...req.payload.display, [K.possibleRepeat]: 'possible' }],
    ['possibleRepeat null', { ...args, possibleRepeat: null }, { ...req.payload.display, [K.possibleRepeat]: null }],
    ['retryOfTaskId', { ...args, retryOfTaskId: 'task_other' }, { ...req.payload.display, [K.retryOfTaskId]: 'task_other' }],
    ['retryOfTaskId null', { ...args, retryOfTaskId: null }, { ...req.payload.display, [K.retryOfTaskId]: null }],
    ['summary', { ...args, summary: 'Delete new.log' }, { ...req.payload.display, [K.summary]: 'Delete new.log' }],
  ];
  for (const [name, a, d] of variants) {
    const dh = displayHashOf(d);
    const forged = await port.computeActionId({ ...b, args: { ...a, displayHash: dh }, displayHash: dh });
    assert.match(forged, HEX);
    assert.notEqual(forged, req.payload.actionId, name);
    assert.deepEqual(f.c.resolveApproval(approval(forged, true, f), 'secure_ui'), { kind: 'rejected', reason: 'unknown_action' }, name);
  }
  await flush();
  assert.equal(f.c.state, 'CONFIRMING', 'the real dialog is still open');
  assert.equal(f.codex.runs.length, 1, 'only the prior run; nothing dispatched for the retry');
  assert.equal(await port.computeActionId({ ...b }), req.payload.actionId, 'the unchanged binding reproduces the id');
  f.c.resolveApproval(approval(req.payload.actionId, false, f), 'secure_ui');
  await f.drain();
});

for (const [why, setup] of [
  ['no displayHash method', (p: RecordingActionIdPort) => { p.displayImpl = null; }],
  ['throws', (p: RecordingActionIdPort) => { p.displayImpl = () => { throw new Error('canonicaliser'); }; }],
  ['malformed output', (p: RecordingActionIdPort) => { p.displayImpl = () => 'ABC'; }],
] as const) {
  test(`binding (X5 fail closed): displayHash ${why} → no ApprovalRequested, declined approval_unavailable, nothing dispatched, copy never says the user declined`, async () => {
    const port = new RecordingActionIdPort();
    setup(port);
    const f = await fixture({ policy: confirm, actionIds: port });
    f.say('delete old.log', `req_dh_${why}`);
    await f.drain();
    assert.equal(f.sink.of('ApprovalRequested').length, 0);
    assert.equal(port.bindings.length, 0, 'no actionId computed without a display hash');
    assert.equal(f.codex.runs.length, 0);
    const fin = f.sink.of('TaskFinished').at(-1)!.payload;
    assert.deepEqual([fin.outcome, fin.reason], ['declined', 'approval_unavailable']);
    assert.doesNotMatch(f.speech.spoken.map(s => s.text).join(' ') + fin.summary, /you declined/i);
    assert.equal(f.log.find('coordinator.approval.display_unavailable').length, 1);
  });
}

// ---------------------------------------------------------------- Codex approval display (1o)
const cmd = (over: Partial<{ commandLine: string; workingDirectory: string; networkAccess: boolean; escalation: string[]; reason: string }> = {}): CodexApprovalRequest => ({
  actionId: hexId(`cmd_${JSON.stringify(over).length}`), summary: 'Run a command', risk: 'high', category: 'local_change',
  display: { kind: 'codex_command', commandLine: 'pwsh -NoProfile -Command Remove-Item C:\\Users\\me\\tmp\\*.log', workingDirectory: 'C:\\Users\\me', networkAccess: false, ...over },
});
async function codexApproval(f: F, req: CodexApprovalRequest): Promise<{ decision: Promise<ApprovalDecision> }> {
  let decision!: Promise<ApprovalDecision>;
  f.codex.scripts.push(async ({ hooks }) => {
    decision = hooks.requestApproval(req);
    await decision;
    return { status: 'completed', summary: 'ok' };
  });
  f.say('do the thing', `req_cx_${++rs}`);
  await flush();
  await flush();
  return { decision: Promise.resolve().then(() => decision) };
}

test('Codex display (1o): no adapter params → declined display_unavailable, no ApprovalRequested, warning without values, nothing approved', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const { decision } = await codexApproval(f, { actionId: hexId('noparams'), summary: 'Delete secret-plan.txt', risk: 'high', category: 'delete' });
  assert.deepEqual(await decision, { approved: false, reason: 'display_unavailable' });
  await f.drain();
  assert.equal(f.sink.of('ApprovalRequested').length, 0);
  const logs = f.log.find('coordinator.approval.display_unavailable');
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /secret-plan|Delete/);
  assert.doesNotMatch(f.speech.spoken.map(s => s.text).join(' '), /you declined/i);
});

test('Codex display (1o): a command shows the full command line (no ellipsis), cwd, network flag, the escalation as its own field, Codex reason only in the untrusted slot', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const long = `pwsh -Command "${'x'.repeat(6000)}"`;
  const { decision } = await codexApproval(f, cmd({ commandLine: long, networkAccess: true, escalation: ['sandbox_bypass'], reason: 'Model says: this is safe' }));
  const req = lastReq(f).payload;
  assert.deepEqual(req.display, {
    [K.kind]: 'codex_command', [K.category]: 'local_change', [K.commandLine]: long, [K.workingDirectory]: 'C:\\Users\\me',
    [K.networkAccess]: 'requested', [K.escalation]: ['sandbox_bypass'], [K.reason]: 'Model says: this is safe',
  });
  assert.doesNotMatch(String(req.display[K.commandLine]), /…|\.\.\.$/);
  assert.ok(validateEvent(lastReq(f)).ok, JSON.stringify(validateEvent(lastReq(f))));
  f.c.resolveApproval(approval(req.actionId, true, f), 'secure_ui');
  assert.equal((await decision).approved, true);
  await f.drain();
});

test('Codex display (1o): a file change shows every full path and the count; 500 paths ok; 501 paths or a command over 8 KB → display_unavailable', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const paths = Array.from({ length: 500 }, (_, i) => `C:\\Users\\me\\Documents\\very\\long\\folder\\name\\file-${i}.txt`);
  const ok = await codexApproval(f, { actionId: hexId('fc500'), summary: 'Edit files', risk: 'medium', category: 'overwrite', display: { kind: 'codex_file_change', paths } });
  const d = lastReq(f).payload.display;
  assert.deepEqual(d[K.paths], paths);
  assert.equal(d[K.fileCount], '500');
  f.c.resolveApproval(approval(lastReq(f).payload.actionId, false, f), 'secure_ui');
  await ok.decision;
  await f.drain();
  for (const [name, req] of [
    ['501 paths', { actionId: hexId('fc501'), summary: 'Edit', risk: 'medium', category: 'overwrite', display: { kind: 'codex_file_change', paths: [...paths, 'C:\\x.txt'] } }],
    ['8193-byte command', cmd({ commandLine: 'a'.repeat(8193) })],
    ['multi-byte over 8 KB', cmd({ commandLine: 'é'.repeat(4097) })],
  ] as Array<[string, CodexApprovalRequest]>) {
    const g = await fixture({ policy: allowAllChannels });
    const r = await codexApproval(g, req);
    assert.deepEqual(await r.decision, { approved: false, reason: 'display_unavailable' }, name);
    assert.equal(g.sink.of('ApprovalRequested').length, 0, name);
    await g.drain();
  }
  const g = await fixture({ policy: allowAllChannels });
  await codexApproval(g, cmd({ commandLine: 'a'.repeat(8192) }));
  assert.equal(g.sink.of('ApprovalRequested').length, 1, 'exactly 8 KB is allowed');
  g.c.resolveApproval(approval(lastReq(g).payload.actionId, false, g), 'secure_ui');
  await g.drain();
});

test('Codex display (1o): a display port plugs in (E02 params) and its output is what is shown; a throwing port → display_unavailable', async () => {
  const custom = { codexDisplay: (r: CodexApprovalRequest) => ({ [K.kind]: 'codex_file_change', [K.category]: r.category, [K.paths]: ['C:\\from-port.txt'], [K.fileCount]: '1', [K.reason]: null }) };
  const f = await fixture({ policy: allowAllChannels, approvalDisplays: custom });
  await codexApproval(f, { actionId: hexId('port_disp'), summary: 's', risk: 'high', category: 'delete', display: { kind: 'codex_file_change', paths: ['C:\\innocent.txt'] } });
  assert.deepEqual(lastReq(f).payload.display[K.paths], ['C:\\from-port.txt']);
  f.c.resolveApproval(approval(lastReq(f).payload.actionId, false, f), 'secure_ui');
  await f.drain();
  const g = await fixture({ policy: allowAllChannels, approvalDisplays: { codexDisplay: () => { throw new Error('boom'); } } });
  const r = await codexApproval(g, cmd());
  assert.deepEqual(await r.decision, { approved: false, reason: 'display_unavailable' });
  await g.drain();
});

// ---------------------------------------------------------------- Codex joins (1o/1p)
test('Codex join (1o c / 1p): a joined request is declined at once with duplicate_request; only the first can be approved; each request answered exactly once; joinedTo logged; no "you declined" copy', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const answers: Array<{ which: string; d: ApprovalDecision }> = [];
  const track = (which: string, p: Promise<ApprovalDecision>) => p.then(d => { answers.push({ which, d }); return d; });
  const req = cmd();
  f.codex.scripts.push(async ({ hooks }) => {
    const first = track('first', hooks.requestApproval(req));
    await flush();
    const second = await track('second', hooks.requestApproval({ ...req }));
    assert.deepEqual(second, { approved: false, reason: 'duplicate_request' }, 'declined immediately, before the dialog is answered');
    assert.equal(answers.length, 1);
    await first;
    const late = await track('late', hooks.requestApproval({ ...req }));
    assert.deepEqual(late, { approved: false, reason: 'duplicate_request' }, 'a join after the APPROVED answer is declined, never replayed');
    return { status: 'completed', summary: 'ok' };
  });
  f.say('run it', 'req_join_cx');
  await flush();
  await flush();
  await flush();
  const reqs = f.sink.of('ApprovalRequested');
  assert.equal(reqs.length, 1, 'one dialog');
  f.c.resolveApproval(approval(reqs[0]!.payload.actionId, true, f), 'secure_ui');
  await f.drain();
  assert.deepEqual(answers.map(a => [a.which, a.d.reason]), [['second', 'duplicate_request'], ['first', 'approved'], ['late', 'duplicate_request']]);
  assert.equal(answers.filter(a => a.d.approved).length, 1, 'only the first request is approved');
  const joined = f.log.find('coordinator.approval.joined_declined');
  assert.equal(joined.length, 2, 'one record per joined request');
  for (const j of joined) {
    assert.equal(j.level, 'warn');
    assert.equal(j.fields['joinedTo'], reqs[0]!.eventId);
    assert.equal(j.fields['reason'], 'duplicate_request');
    assert.doesNotMatch(JSON.stringify(j.fields), /pwsh|Remove-Item|Run a command/, 'no values');
  }
  assert.doesNotMatch(JSON.stringify(f.sink.events) + f.speech.spoken.map(s => s.text).join(' '), /you declined|user_declined/i);
  assert.equal(f.sink.of('ApprovalResolved').length, 0, 'a user answer is not re-announced');
});

test('Codex join (1o): on the C-08 timeout the dialog expires once (one ApprovalResolved{expired}, before TaskFinished) and the joined request had already been declined', async () => {
  const f = await fixture({ policy: allowAllChannels });
  const got: string[] = [];
  f.codex.scripts.push(async ({ hooks }) => {
    const a = hooks.requestApproval(cmd());
    await f.clock.advance(20_000);
    got.push((await hooks.requestApproval(cmd())).reason);
    got.push((await a).reason);
    return { status: 'completed', summary: 'ok' };
  });
  f.say('run it', 'req_join_exp');
  await flush();
  await f.clock.advance(40_000);
  await f.drain();
  assert.deepEqual(got, ['duplicate_request', 'expired']);
  const out = f.sink.of('ApprovalResolved');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.payload.decision, 'expired');
  const types = f.sink.events.map(e => e.type);
  assert.ok(types.indexOf('ApprovalResolved') < types.indexOf('TaskFinished'));
});

// ---------------------------------------------------------------- validateEvent display rules
const reqEnv = (payload: Record<string, unknown>) => validateEvent({ ...envelope('ApprovalRequested', {} as never), taskId: 'task_v', payload: { taskId: 'task_v', actionId: hexId('v'), summary: 's', risk: 'high', expiry: '2026-10-19T00:00:00Z', category: 'local_change', ...payload } as never });
test('validateEvent (X5, 1l/1m/1o): display is required and must follow its kind rule', () => {
  const app = { [K.appName]: 'Notepad', [K.windowTitle]: 'notes.txt - Notepad', [K.processImage]: 'notepad.exe' };
  const ui = { [K.kind]: 'ui_action', [K.category]: 'local_change', [K.method]: 'ui.click', [K.app]: app };
  assert.ok(reqEnv({ display: ui, requestSource: 'tool_host' }).ok, JSON.stringify(reqEnv({ display: ui, requestSource: 'tool_host' })));
  assert.equal(reqEnv({ requestSource: 'tool_host' }).ok, false, 'missing display');
  assert.equal(reqEnv({ requestSource: 'tool_host', display: { ...ui, [K.kind]: undefined } }).ok, false, 'kind is required (1r)');
  for (const k of [K.appName, K.windowTitle, K.processImage]) {
    const { [k]: _drop, ...rest } = app;
    assert.equal(reqEnv({ requestSource: 'tool_host', display: { ...ui, [K.app]: rest } }).ok, false, `UI action without app.${k}`);
    assert.equal(reqEnv({ requestSource: 'tool_host', display: { ...ui, [K.app]: { ...app, [k]: '  ' } } }).ok, false, `UI action with blank app.${k}`);
  }
  const { [K.app]: _noApp, ...uiNoApp } = ui;
  assert.equal(reqEnv({ requestSource: 'tool_host', display: uiNoApp }).ok, false, 'UI action without app');
  assert.equal(reqEnv({ requestSource: 'tool_host', display: { ...ui, [K.category]: 'delete' } }).ok, false, 'display category ≠ event category');
  assert.equal(reqEnv({ requestSource: 'tool_host', display: { ...ui, [K.kind]: 'mystery' } }).ok, false, 'unknown kind');
  assert.equal(reqEnv({ requestSource: 'tool_host', display: { ...ui, extra: 3 } }).ok, false, 'non-string leaf');
  assert.equal(reqEnv({ requestSource: 'tool_host', display: ui, category: 'credential_access' }).ok, false, 'credential_access has no display rule');
  const c = { [K.kind]: 'codex_command', [K.category]: 'local_change', [K.commandLine]: 'dir', [K.workingDirectory]: 'C:\\', [K.networkAccess]: 'not_requested', [K.escalation]: [], [K.reason]: null };
  assert.ok(reqEnv({ display: c, requestSource: 'codex' }).ok, JSON.stringify(reqEnv({ display: c, requestSource: 'codex' })));
  assert.equal(reqEnv({ requestSource: 'codex', display: { ...c, [K.networkAccess]: 'yes' } }).ok, false);
  assert.equal(reqEnv({ requestSource: 'codex', display: { ...c, [K.workingDirectory]: '' } }).ok, false);
  assert.equal(reqEnv({ requestSource: 'codex', display: { ...c, [K.commandLine]: 'a'.repeat(8193) } }).ok, false, 'over 8 KB');
  const fc = { [K.kind]: 'codex_file_change', [K.category]: 'local_change', [K.paths]: ['C:\\a', 'C:\\b'], [K.fileCount]: '2', [K.reason]: null };
  assert.ok(reqEnv({ display: fc, requestSource: 'codex' }).ok);
  assert.equal(reqEnv({ requestSource: 'codex', display: { ...fc, [K.fileCount]: '1' } }).ok, false);
  assert.equal(reqEnv({ requestSource: 'codex', display: { ...fc, [K.paths]: Array.from({ length: 501 }, (_, i) => `C:\\${i}`), [K.fileCount]: '501' } }).ok, false, 'over 500 paths');
  const pd = preDispatchDisplay({ category: 'local_change', risk: 'high', possibleRepeat: 'unknown', retryOfTaskId: 'task_p', summary: 's' });
  assert.ok(reqEnv({ display: pd, requestSource: 'coordinator', possibleRepeat: { priorTaskId: 'task_p', priorSideEffect: 'unknown' } }).ok);
  assert.equal(reqEnv({ requestSource: 'coordinator', display: pd }).ok, false, 'display possibleRepeat without the event field');
  assert.equal(reqEnv({ requestSource: 'coordinator', display: { ...pd, [K.risk]: 'low' }, possibleRepeat: { priorTaskId: 'task_p', priorSideEffect: 'unknown' } }).ok, false, 'risk mismatch');
});

// ---------------------------------------------------------------- TaskProgress metadata (1o/1q)
const prog = (state: string, md: Record<string, unknown>) => validateEvent({ ...envelope('TaskProgress', {} as never), taskId: 't', payload: { taskId: 't', state, message: 'm', redactedMetadata: md } as never });
test('validateEvent (1o/1q): TaskProgress awaitingClarification boolean, turnsSoFar number; awaitingClarification:true only in LISTENING', () => {
  assert.ok(prog('LISTENING', { awaitingClarification: true, turnsSoFar: 2 }).ok);
  assert.ok(prog('EXECUTING', { awaitingClarification: false }).ok);
  assert.ok(prog('SPEAKING', { turnsSoFar: 1 }).ok);
  assert.equal(prog('LISTENING', { awaitingClarification: 'yes' }).ok, false);
  assert.equal(prog('LISTENING', { turnsSoFar: '2' }).ok, false);
  for (const s of ['EXECUTING', 'VERIFYING', 'SPEAKING', 'STANDBY']) assert.equal(prog(s, { awaitingClarification: true }).ok, false, s);
});

test('1q: every coordinator TaskProgress with awaitingClarification:true is emitted in LISTENING (both emit sites), and carries turnsSoFar', async () => {
  const f = await fixture({ policy: allowAllChannels });
  f.codex.scripts.push(async ({ hooks }) => {
    hooks.toolResult({ toolId: 'files.search', observedState: obs('two', 'none', false, { decision: 'ask_user', question: 'Which one?' }), verified: false, sideEffect: 'none', error: { code: 'AMBIGUOUS', message: 'two', retryable: false } });
    return { status: 'completed', summary: 'Which one?' };
  });
  f.say('open the report', 'req_clar_state');
  await flush();
  await flush();
  const flagged = f.sink.of('TaskProgress').filter(e => e.payload.redactedMetadata['awaitingClarification'] === true);
  assert.ok(flagged.length >= 1);
  for (const e of flagged) {
    assert.equal(e.payload.state, 'LISTENING');
    assert.equal(typeof e.payload.redactedMetadata['turnsSoFar'], 'number');
    assert.ok(validateEvent(e).ok);
  }
  assert.equal(f.c.state, 'LISTENING');
  for (const e of f.sink.of('TaskProgress')) assert.ok(validateEvent(e).ok, JSON.stringify([e.payload.state, e.payload.redactedMetadata]));
  await f.drain();
});

// ---------------------------------------------------------------- 1r: requestSource + kind/source guard; 1r follow-up: DOT-060 AC 11
test('1r: requestSource is set from coordinator state (coordinator for pre-dispatch, codex for Codex approvals) and bound in CR2; an adapter-supplied one is ignored', async () => {
  const f = await fixture({ policy: confirm });
  f.say('delete old.log', 'req_src_pd');
  await flush();
  assert.equal(lastReq(f).payload.requestSource, 'coordinator');
  assert.equal(lastBinding(f).requestSource, 'coordinator');
  f.c.resolveApproval(approval(lastReq(f).payload.actionId, false, f), 'secure_ui');
  await f.drain();
  const g = await fixture({ policy: allowAllChannels });
  await codexApproval(g, { ...cmd(), requestSource: 'coordinator' } as unknown as CodexApprovalRequest);
  assert.equal(lastReq(g).payload.requestSource, 'codex', 'never taken from adapter input');
  assert.ok(validateEvent(lastReq(g)).ok);
  g.c.resolveApproval(approval(lastReq(g).payload.actionId, false, g), 'secure_ui');
  await g.drain();
});

test('1r validateEvent: requestSource required (codex | tool_host | coordinator); every wrong kind/source pairing rejected; UI-action methods only as ui_action', () => {
  const app = { [K.appName]: 'Notepad', [K.windowTitle]: 'notes.txt', [K.processImage]: 'notepad.exe' };
  const displays: Record<string, Record<string, unknown>> = {
    codex_command: { [K.kind]: 'codex_command', [K.category]: 'local_change', [K.commandLine]: 'dir', [K.workingDirectory]: 'C:\\', [K.networkAccess]: 'not_requested', [K.escalation]: [], [K.reason]: null },
    codex_file_change: { [K.kind]: 'codex_file_change', [K.category]: 'local_change', [K.paths]: ['C:\\a'], [K.fileCount]: '1', [K.reason]: null },
    tool: { [K.kind]: 'tool', [K.category]: 'local_change', [K.method]: 'files.move', [K.targetLabel]: 'C:\\a → C:\\b', targets: ['C:\\a', 'C:\\b'], itemCount: '2' },
    ui_action: { [K.kind]: 'ui_action', [K.category]: 'local_change', [K.method]: 'ui.click', [K.app]: app },
    pre_dispatch: preDispatchDisplay({ category: 'local_change', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' }),
  };
  const fits: Record<string, string> = { codex_command: 'codex', codex_file_change: 'codex', tool: 'tool_host', ui_action: 'tool_host', pre_dispatch: 'coordinator' };
  for (const [kind, display] of Object.entries(displays)) {
    for (const src of ['codex', 'tool_host', 'coordinator']) {
      const r = reqEnv({ display, requestSource: src });
      assert.equal(r.ok, src === fits[kind], `${kind} with ${src}: ${JSON.stringify(r)}`);
    }
    assert.equal(reqEnv({ display }).ok, false, `${kind}: requestSource missing`);
    assert.equal(reqEnv({ display, requestSource: 'model' }).ok, false, `${kind}: requestSource model`);
    assert.equal(reqEnv({ display: { ...display, extraField: 'x' }, requestSource: fits[kind] }).ok, false, `${kind}: extra field (tool too: exact per-category keys, E01 1x)`);
  }
  assert.equal(reqEnv({ display: { ...displays['tool']!, [K.method]: 'ui.type' }, requestSource: 'tool_host' }).ok, false, 'a UI-action method must use kind ui_action');
  assert.equal(reqEnv({ display: { ...displays['ui_action']!, [K.method]: 'files.move' }, requestSource: 'tool_host' }).ok, false, 'ui_action only for UI-action methods');
  const many = Array.from({ length: 501 }, (_, i) => `C:\\d\\${i}`);
  const toolDel = { [K.kind]: 'tool', [K.category]: 'delete', [K.method]: 'files.delete', [K.targetLabel]: 'Delete items' };
  assert.equal(reqEnv({ display: { ...toolDel, [K.paths]: many, [K.fileCount]: '501' }, category: 'delete', requestSource: 'tool_host' }).ok, false, 'tool delete over 500 paths');
  assert.ok(reqEnv({ display: { ...toolDel, [K.paths]: many.slice(0, 500), [K.fileCount]: '500' }, category: 'delete', requestSource: 'tool_host' }).ok, 'tool delete with 500 paths');
});

test('1r validateEvent: each pre_dispatch mismatch is rejected (possibleRepeat, retryOfTaskId vs priorTaskId, category, risk)', () => {
  const pr = { priorTaskId: 'task_p', priorSideEffect: 'unknown' };
  const pd = preDispatchDisplay({ category: 'local_change', risk: 'high', possibleRepeat: 'unknown', retryOfTaskId: 'task_p', summary: 's' });
  const ok = (display: Record<string, unknown>, extra: Record<string, unknown> = {}) => reqEnv({ display, requestSource: 'coordinator', possibleRepeat: pr, ...extra }).ok;
  assert.ok(ok(pd));
  assert.equal(ok({ ...pd, [K.possibleRepeat]: 'possible' }), false, 'possibleRepeat value');
  assert.equal(reqEnv({ display: pd, requestSource: 'coordinator' }).ok, false, 'display possibleRepeat without the event field');
  assert.equal(ok({ ...pd, [K.retryOfTaskId]: 'task_other' }), false, 'retryOfTaskId ≠ possibleRepeat.priorTaskId');
  assert.equal(ok({ ...pd, [K.retryOfTaskId]: null }), false, 'retryOfTaskId null with a possibleRepeat');
  assert.equal(ok({ ...pd, [K.category]: 'delete' }), false, 'category');
  assert.equal(ok({ ...pd, [K.risk]: 'low' }), false, 'risk');
  const { [K.summary]: _s, ...noSummary } = pd;
  assert.equal(ok(noSummary), false, 'missing summary slot');
});

test('DOT-060 AC 11 (1r follow-up): a clean-failure retry (possibleRepeat null) whose display.retryOfTaskId differs from the utterance retryOfTaskId emits no ApprovalRequested and dispatches nothing', async () => {
  const port = new RecordingActionIdPort();
  const f = await fixture({ policy: confirm, actionIds: port });
  const prior = await priorTask(f, cleanFail);
  // Simulated internal bug: the task's retryOfTaskId changes after the display was built (while its hash is computed).
  port.displayImpl = d => {
    const active = (f.c as unknown as { active: { retryOfTaskId?: string } | null }).active;
    if (active) (active as { retryOfTaskId?: string }).retryOfTaskId = 'task_someone_else';
    return displayHashOf(d);
  };
  const r = sayRetry(f, prior);
  await f.drain();
  assert.equal(f.sink.of('ApprovalRequested').filter(e => e.taskId === r.taskId).length, 0, 'refused before emitting');
  assert.equal(f.codex.runs.length, 1, 'only the prior run');
  assert.equal(f.log.find('coordinator.retry.binding_mismatch').length, 1);
  const fin = f.sink.of('TaskFinished').at(-1)!.payload;
  assert.deepEqual([fin.taskId, fin.outcome, fin.reason], [r.taskId, 'declined', 'approval_unavailable']);
  assert.doesNotMatch(f.speech.spoken.map(s => s.text).join(' '), /you declined/i);
});

test('DOT-060 AC 11 (control): the same clean-failure retry without the bug emits the approval with display.retryOfTaskId = the utterance retryOfTaskId', async () => {
  const f = await fixture({ policy: confirm });
  const prior = await priorTask(f, cleanFail);
  sayRetry(f, prior);
  await flush();
  assert.equal(lastReq(f).payload.display[K.retryOfTaskId], prior);
  assert.equal(lastReq(f).payload.possibleRepeat, undefined);
  f.c.resolveApproval(approval(lastReq(f).payload.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('1r: one builder per kind; each builder output validates only with its own requestSource; builders fail closed on missing fields', async () => {
  const { toolDisplay, uiActionDisplay, codexDisplay } = await import('../src/display.js');
  const built: Array<[string, Record<string, unknown> | null, string]> = [
    ['tool', toolDisplay({ category: 'local_change', method: 'files.move', targetLabel: 'C:\\a → C:\\b', fields: { targets: ['C:\\a', 'C:\\b'] } }), 'tool_host'],
    ['ui_action', uiActionDisplay({ category: 'local_change', method: 'ui.click', appName: 'Notepad', windowTitle: 'notes.txt', processImage: 'notepad.exe' }), 'tool_host'],
    ['codex_command', codexDisplay('local_change', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false }), 'codex'],
    ['codex_file_change', codexDisplay('local_change', { kind: 'codex_file_change', paths: ['C:\\a'] }), 'codex'],
    ['pre_dispatch', preDispatchDisplay({ category: 'local_change', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' }), 'coordinator'],
  ];
  for (const [kind, display, src] of built) {
    assert.ok(display, `${kind} built`);
    assert.equal(display![K.kind], kind);
    for (const other of ['codex', 'tool_host', 'coordinator']) assert.equal(reqEnv({ display, requestSource: other }).ok, other === src, `${kind}/${other}`);
  }
  assert.equal(uiActionDisplay({ category: 'local_change', method: 'ui.click', appName: 'Notepad', windowTitle: '', processImage: 'notepad.exe' }), null);
  assert.equal(uiActionDisplay({ category: 'local_change', method: 'files.move', appName: 'a', windowTitle: 'b', processImage: 'c' }), null);
  assert.equal(toolDisplay({ category: 'local_change', method: 'ui.type', targetLabel: 'x' }), null, 'UI-action method needs ui_action');
  assert.equal(toolDisplay({ category: 'delete', method: 'files.delete', targetLabel: 'x', fields: { paths: Array.from({ length: 501 }, (_, i) => `C:\\${i}`) } }), null, 'delete over 500 paths');
  assert.equal(toolDisplay({ category: 'delete', method: 'files.delete', targetLabel: 'x', fields: { kind: 'pre_dispatch' } }), null, 'a field cannot override the kind');
  assert.equal(codexDisplay('local_change', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\' }), null, 'network flag missing');
  assert.equal(codexDisplay('local_change', { kind: 'codex_file_change', paths: [] }), null);
});

// ---------------------------------------------------------------- 1t: bound fields never stripped; codex_command rendering
test('1t codex_command: a multi-line command shows its lines and line count; CRLF normalised for display only; the bound (hashed) command is the raw bytes', async () => {
  const { renderCodexCommand } = await import('../src/display.js');
  const raw = 'cd C:\\work\r\nnpm ci\nnpm test';
  const f = await fixture({ policy: allowAllChannels });
  await codexApproval(f, cmd({ commandLine: raw }));
  const d = lastReq(f).payload.display;
  assert.equal(d[K.commandLine], raw, 'bound raw: executed bytes == hashed bytes');
  assert.equal(f.actionIds!.displays.length, 0, 'Codex ids come from the adapter; nothing re-hashed here');
  const r = renderCodexCommand(d)!;
  assert.deepEqual([r.lines, r.lineCount, r.hiddenCharacters], [['cd C:\\work', 'npm ci', 'npm test'], 3, false]);
  f.c.resolveApproval(approval(lastReq(f).payload.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('1t codex_command: ESC, a lone CR, U+202E, zero-width, BOM and soft hyphen render as visible escapes with the badge; tab and trailing spaces are visible; nothing is stripped from the bound value', async () => {
  const { renderBoundText, codexDisplay, TAB_MARKER, TRAILING_SPACE_MARKER } = await import('../src/display.js');
  const raw = 'echo \u001b[31mred\rover \u202Etxt.exe\u200b\ufeff\u00ad\tend  ';
  const d = codexDisplay('local_change', { kind: 'codex_command', commandLine: raw, workingDirectory: 'C:\\', networkAccess: false })!;
  assert.equal(d[K.commandLine], raw, 'never stripped');
  const r = renderBoundText(raw);
  assert.equal(r.hiddenCharacters, true);
  assert.equal(r.lineCount, 1, 'a lone CR is not a line break');
  assert.equal(r.lines[0], `echo \\x1b[31mred\\x0dover <U+202E>txt.exe<U+200B><U+FEFF><U+00AD>${TAB_MARKER}\tend${TRAILING_SPACE_MARKER}${TRAILING_SPACE_MARKER}`);
  assert.equal(renderBoundText('plain').hiddenCharacters, false);
  // escapes count at raw byte length for the limit: 8192 raw bytes of ESC is fine even though the rendering is 4x longer
  assert.ok(codexDisplay('local_change', { kind: 'codex_command', commandLine: '\u001b'.repeat(8192), workingDirectory: 'C:\\', networkAccess: false }));
  assert.equal(codexDisplay('local_change', { kind: 'codex_command', commandLine: '\u001b'.repeat(8193), workingDirectory: 'C:\\', networkAccess: false }), null);
});

test('1t: bound paths and the window title keep hidden characters (rendered, not stripped); only the untrusted summary/reason slots are stripped', async () => {
  const { codexDisplay, uiActionDisplay, renderBoundText } = await import('../src/display.js');
  const p = 'C:\\Users\\me\\invoice\u202Efdp.exe';
  const fc = codexDisplay('delete', { kind: 'codex_file_change', paths: [p], reason: 'because\u202E it is safe\u0007' })!;
  assert.deepEqual(fc[K.paths], [p]);
  assert.equal(fc[K.reason], 'because it is safe', 'untrusted slot stripped');
  assert.equal(renderBoundText(p).hiddenCharacters, true);
  const ui = uiActionDisplay({ category: 'local_change', method: 'ui.click', appName: 'Notepad', windowTitle: 'notes\u200b.txt', processImage: 'notepad.exe' })!;
  assert.equal((ui[K.app] as Record<string, string>)[K.windowTitle], 'notes\u200b.txt');
  const pd = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 'Delete\u202E old.log' });
  assert.equal(pd[K.summary], 'Delete old.log');
});

// ---------------------------------------------------------------- untrusted-slot maximum length + ellipsis (CONTRACTS §3 Rendering, 1r)
// CONTRACTS (E01 e41d1ca L230): every field except the command (8 KB) and path lists (500) has a fixed maximum length with a
// visible ellipsis; the numbers are E02's (L222 "Exact key names and maximum lengths: E02 in the ApprovalDisplay type").
// Values are E02's FINAL limits (E01 1v); the full table is tested in the "1v final limits" tests below.
test('untrusted max length: reasonUntrusted (codex_command, codex_file_change) unchanged at the limit, one over cut to the limit ending in an ellipsis; command and paths never cut', async () => {
  const { codexDisplay, DISPLAY_MAX_LENGTH, DISPLAY_ELLIPSIS } = await import('../src/display.js');
  const max = DISPLAY_MAX_LENGTH.reasonUntrusted;
  assert.equal(max, 500);
  assert.equal(DISPLAY_ELLIPSIS, '\u2026');
  const at = 'r'.repeat(max);
  const over = 'r'.repeat(max + 1);
  const longCmd = 'x'.repeat(8192);
  const longPath = 'C:\\' + 'p'.repeat(4000);
  const paths = Array.from({ length: 500 }, (_, i) => `${longPath}${i}`);
  for (const base of [
    { kind: 'codex_command', commandLine: longCmd, workingDirectory: longPath, networkAccess: true, escalation: ['e'.repeat(256)] },
    { kind: 'codex_file_change', paths },
  ]) {
    const a = codexDisplay('local_change', { ...base, reason: at })!;
    assert.equal(a[K.reason], at, `${base.kind}: at the limit unchanged`);
    const o = codexDisplay('local_change', { ...base, reason: over })!;
    const cut = o[K.reason] as string;
    assert.equal([...cut].length, max, `${base.kind}: cut to the limit (ellipsis included)`);
    assert.ok(cut.endsWith(DISPLAY_ELLIPSIS));
    assert.equal(cut, 'r'.repeat(max - 1) + DISPLAY_ELLIPSIS);
    assert.equal(reqEnv({ display: o, requestSource: 'codex' }).ok, true, 'the truncated display validates');
    if (base.kind === 'codex_command') {
      assert.equal(o[K.commandLine], longCmd, 'command never cut');
      assert.ok(!(o[K.commandLine] as string).endsWith(DISPLAY_ELLIPSIS));
      assert.equal(o[K.workingDirectory], longPath);
    } else {
      assert.deepEqual(o[K.paths], paths, 'paths never cut');
      assert.equal(o[K.fileCount], '500');
    }
  }
  // code points, not UTF-16 units: an astral character counts once and is never split
  const astral = '\u{1F600}'.repeat(max + 1);
  const cutA = codexDisplay('local_change', { kind: 'codex_file_change', paths: ['C:\\a'], reason: astral })![K.reason] as string;
  assert.equal(cutA, '\u{1F600}'.repeat(max - 1) + '\u2026');
  // stripped first, then measured: hidden characters don't count toward the limit
  assert.equal(codexDisplay('local_change', { kind: 'codex_file_change', paths: ['C:\\a'], reason: at + '\u202E\u200b' })![K.reason], at);
});

test('untrusted max length: summaryUntrusted (pre_dispatch) and app.windowTitle (ui_action) follow the same rule; the coordinator emits the cut summary and the hash covers what is shown', async () => {
  const { uiActionDisplay, DISPLAY_MAX_LENGTH } = await import('../src/display.js');
  const sMax = DISPLAY_MAX_LENGTH.summaryUntrusted;
  assert.equal(sMax, 500);
  const pd = (summary: string) => preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary });
  assert.equal(pd('s'.repeat(sMax))[K.summary], 's'.repeat(sMax));
  assert.equal(pd('s'.repeat(sMax + 1))[K.summary], 's'.repeat(sMax - 1) + '\u2026');
  const wMax = DISPLAY_MAX_LENGTH.windowTitle;
  assert.equal(wMax, 256);
  const ui = (windowTitle: string) => (uiActionDisplay({ category: 'local_change', method: 'ui.click', appName: 'Notepad', windowTitle, processImage: 'notepad.exe' })![K.app] as Record<string, string>)[K.windowTitle];
  assert.equal(ui('w'.repeat(wMax)), 'w'.repeat(wMax));
  assert.equal(ui('w'.repeat(wMax + 1)), 'w'.repeat(wMax - 1) + '\u2026');
  assert.equal(ui('w'.repeat(wMax) + '\u202E'), 'w'.repeat(wMax - 1) + '\u2026', 'window title is bound: hidden chars kept and counted, at the limit + 1 cut');
  // end to end: a long pre-dispatch summary is cut in ApprovalRequested.display and displayHash is computed over the cut display
  const longSummary = 'Delete ' + 'o'.repeat(600);
  const f = await fixture({ policy: { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: longSummary, risk: 'high', category: 'delete' }) } });
  f.say('delete the old logs', 'req_b_maxlen_1');
  await flush();
  const req = lastReq(f).payload;
  assert.equal([...(req.display[K.summary] as string)].length, sMax);
  assert.ok((req.display[K.summary] as string).endsWith('\u2026'));
  assert.deepEqual(f.actionIds!.displays.at(-1), req.display, 'displayHash input == the shown (cut) display');
  assert.equal(validateEvent(lastReq(f) as never).ok, true);
  f.c.resolveApproval(approval(req.actionId, false, f), 'secure_ui');
  await f.drain();
});

test('untrusted max length: validateEvent rejects an over-length untrusted slot (validator rejects, never repairs)', async () => {
  const { codexDisplay, uiActionDisplay } = await import('../src/display.js');
  const c = { ...codexDisplay('local_change', { kind: 'codex_file_change', paths: ['C:\\a'] })!, [K.reason]: 'r'.repeat(501) };
  assert.equal(reqEnv({ display: c, requestSource: 'codex' }).ok, false);
  const c2 = { ...codexDisplay('local_change', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false })!, [K.reason]: 'r'.repeat(501) };
  assert.equal(reqEnv({ display: c2, requestSource: 'codex' }).ok, false);
  const u = uiActionDisplay({ category: 'local_change', method: 'ui.click', appName: 'N', windowTitle: 't', processImage: 'n.exe' })!;
  assert.equal(reqEnv({ display: { ...u, [K.app]: { ...(u[K.app] as object), [K.windowTitle]: 'w'.repeat(257) } }, requestSource: 'tool_host' }).ok, false);
});

// ---------------------------------------------------------------- E02 FINAL display limits (E01 ruling 1v; names settled)
// CUT (code points, max-1 + U+2026): summaryUntrusted 500, reasonUntrusted 500, app.windowTitle 256,
// targetLabel 256 (tool), app.appName 128, app.processImage 260.
// NEVER cut (over → null → display_unavailable): commandLine 8192 UTF-8 bytes; paths ≤500 entries, each ≤4096 bytes;
// workingDirectory ≤4096 bytes; escalation ≤32 entries, each ≤256 code points; method ≤64 code points (E02 cc22afb
// 2a addition, E01 2b: a cut method would break the 1z regex).
const ELL = '\u2026';
const cutExpect = (n: number, max: number, ch = 'x') => (n <= max ? ch.repeat(n) : ch.repeat(max - 1) + ELL);
test('1v final limits (CUT): max-1 / max / max+1 for every cut field; at or under unchanged, over cut to max-1 + ellipsis; the cut display validates', async () => {
  const { DISPLAY_MAX_LENGTH, codexDisplay, toolDisplay, uiActionDisplay } = await import('../src/display.js');
  assert.deepEqual({ ...DISPLAY_MAX_LENGTH }, { summaryUntrusted: 500, reasonUntrusted: 500, windowTitle: 256, targetLabel: 256, appName: 128, processImage: 260 });
  const ui = (o: Partial<{ method: string; appName: string; windowTitle: string; processImage: string }>) =>
    uiActionDisplay({ category: 'local_change', method: 'ui.click', appName: 'Notepad', windowTitle: 'notes.txt', processImage: 'notepad.exe', ...o })!;
  const app = (d: Record<string, unknown>, k: string) => (d[K.app] as Record<string, string>)[k];
  type Case = [string, number, (s: string) => { value: unknown; display: Record<string, unknown>; src: string }, string?];
  const cases: Case[] = [
    ['summaryUntrusted', 500, s => { const d = preDispatchDisplay({ category: 'local_change', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: s }); return { value: d[K.summary], display: d, src: 'coordinator' }; }],
    ['reasonUntrusted (codex_command)', 500, s => { const d = codexDisplay('local_change', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false, reason: s })!; return { value: d[K.reason], display: d, src: 'codex' }; }],
    ['reasonUntrusted (codex_file_change)', 500, s => { const d = codexDisplay('local_change', { kind: 'codex_file_change', paths: ['C:\\a'], reason: s })!; return { value: d[K.reason], display: d, src: 'codex' }; }],
    ['app.windowTitle', 256, s => { const d = ui({ windowTitle: s }); return { value: app(d, K.windowTitle), display: d, src: 'tool_host' }; }],
    ['app.appName', 128, s => { const d = ui({ appName: s }); return { value: app(d, K.appName), display: d, src: 'tool_host' }; }],
    ['app.processImage', 260, s => { const d = ui({ processImage: s }); return { value: app(d, K.processImage), display: d, src: 'tool_host' }; }],
    ['targetLabel (tool)', 256, s => { const d = toolDisplay({ category: 'local_change', method: 'files.move', targetLabel: s, fields: { targets: ['C:\\a'] } })!; return { value: d[K.targetLabel], display: d, src: 'tool_host' }; }],
  ];
  for (const [name, max, build] of cases) {
    assert.equal((DISPLAY_MAX_LENGTH as Record<string, number>)[name.split(' ')[0]!.replace('app.', '')], max, name);
    for (const n of [max - 1, max, max + 1]) {
      const r = build('x'.repeat(n));
      assert.equal(r.value, cutExpect(n, max), `${name} @ ${n}`);
      assert.equal([...(r.value as string)].length, Math.min(n, max), `${name} @ ${n}: length`);
      assert.equal(reqEnv({ display: r.display, requestSource: r.src }).ok, true, `${name} @ ${n}: validates`);
    }
    // code points, not UTF-16 units or bytes
    const astral = build('\u{1F600}'.repeat(max + 1)).value as string;
    assert.equal(astral, '\u{1F600}'.repeat(max - 1) + ELL, `${name}: astral`);
  }
  // ui_action has no targetLabel (1v)
  assert.equal(K.targetLabel in ui({}), false);
});

test('1v final limits (NEVER cut): limit passes unchanged, limit+1 → null (display_unavailable) for command bytes, path count, path bytes, cwd bytes, escalation count and entry length', async () => {
  const { DISPLAY_HARD_LIMITS, codexDisplay, toolDisplay, uiActionDisplay } = await import('../src/display.js');
  assert.deepEqual({ ...DISPLAY_HARD_LIMITS }, { commandLineBytes: 8192, paths: 500, pathBytes: 4096, workingDirectoryBytes: 4096, escalationEntries: 32, escalationChars: 256, methodCodePoints: 64 });
  const c = (o: Record<string, unknown>) => codexDisplay('local_change', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false, ...o });
  const fc = (paths: string[]) => codexDisplay('local_change', { kind: 'codex_file_change', paths });
  const e2 = '\u00e9'; // 2 UTF-8 bytes: limits are bytes, not characters
  const okAndUnchanged = (d: Record<string, unknown> | null, key: string, v: unknown, name: string) => { assert.ok(d, `${name}: at limit`); assert.deepEqual(d![key], v, `${name}: never cut`); };
  // method: never cut (E02 cc22afb, E01 2b): 63/64 code points unchanged, 65 → null, for tool and ui_action; code points, not UTF-16 units
  const tm = (m: string) => toolDisplay({ category: 'local_change', method: m, targetLabel: 'C:\\a', fields: { targets: ['C:\\a'] } });
  const um = (m: string) => uiActionDisplay({ category: 'local_change', method: m, appName: 'Notepad', windowTitle: 'notes.txt', processImage: 'notepad.exe' });
  for (const n of [63, 64]) {
    okAndUnchanged(tm('m'.repeat(n)), K.method, 'm'.repeat(n), `tool method ${n}`);
    okAndUnchanged(um('ui.' + 'm'.repeat(n - 3)), K.method, 'ui.' + 'm'.repeat(n - 3), `ui method ${n}`);
  }
  assert.equal(tm('m'.repeat(65)), null, 'tool method 65');
  assert.equal(um('ui.' + 'm'.repeat(62)), null, 'ui method 65');
  okAndUnchanged(tm('\u{1F600}'.repeat(64)), K.method, '\u{1F600}'.repeat(64), 'tool method 64 astral');
  assert.equal(tm('\u{1F600}'.repeat(65)), null, 'tool method 65 astral');
  okAndUnchanged(c({ commandLine: e2.repeat(4096) }), K.commandLine, e2.repeat(4096), 'commandLine 8192 B');
  assert.equal(c({ commandLine: e2.repeat(4096) + 'x' }), null, 'commandLine 8193 B');
  okAndUnchanged(c({ workingDirectory: e2.repeat(2048) }), K.workingDirectory, e2.repeat(2048), 'cwd 4096 B');
  assert.equal(c({ workingDirectory: e2.repeat(2048) + 'x' }), null, 'cwd 4097 B');
  const esc32 = Array.from({ length: 32 }, (_, i) => `e${i}`);
  okAndUnchanged(c({ escalation: esc32 }), K.escalation, esc32, 'escalation 32');
  assert.equal(c({ escalation: [...esc32, 'e32'] }), null, 'escalation 33');
  okAndUnchanged(c({ escalation: ['\u{1F600}'.repeat(256)] }), K.escalation, ['\u{1F600}'.repeat(256)], 'escalation entry 256 chars (1024 B)');
  assert.equal(c({ escalation: ['\u{1F600}'.repeat(257)] }), null, 'escalation entry 257 chars');
  const p500 = Array.from({ length: 500 }, (_, i) => `C:\\${i}`);
  okAndUnchanged(fc(p500), K.paths, p500, '500 paths');
  assert.equal(fc([...p500, 'C:\\x']), null, '501 paths');
  const p4096 = 'C:\\' + e2.repeat(2046) + 'x'; // 3 + 4092 + 1 = 4096 B
  okAndUnchanged(fc([p4096]), K.paths, [p4096], 'path 4096 B');
  assert.equal(fc([p4096 + 'x']), null, 'path 4097 B');
  // the tool-host builder applies the same path bounds
  assert.ok(toolDisplay({ category: 'delete', method: 'files.delete', targetLabel: 'x', fields: { paths: [p4096] } }));
  assert.equal(toolDisplay({ category: 'delete', method: 'files.delete', targetLabel: 'x', fields: { paths: [p4096 + 'x'] } }), null, 'tool path 4097 B');
  assert.equal(toolDisplay({ category: 'delete', method: 'files.delete', targetLabel: 'x', fields: { paths: [...p500, 'C:\\x'] } }), null, 'tool 501 paths');
});

test('1v final limits (NEVER cut, end to end): an over-limit cwd, path or escalation → declined display_unavailable, no dialog, nothing approved', async () => {
  const over: Array<[string, CodexApprovalRequest]> = [
    ['cwd 4097 B', cmd({ workingDirectory: 'C:\\' + 'w'.repeat(4094) })],
    ['escalation 33', cmd({ escalation: Array.from({ length: 33 }, (_, i) => `e${i}`) })],
    ['escalation entry 257', cmd({ escalation: ['e'.repeat(257)] })],
    ['path 4097 B', { actionId: hexId('p4097'), summary: 'Edit', risk: 'medium', category: 'overwrite', display: { kind: 'codex_file_change', paths: ['C:\\' + 'p'.repeat(4094)] } }],
  ];
  for (const [name, req] of over) {
    const f = await fixture({ policy: allowAllChannels });
    const r = await codexApproval(f, req);
    assert.deepEqual(await r.decision, { approved: false, reason: 'display_unavailable' }, name);
    await f.drain();
    assert.equal(f.sink.of('ApprovalRequested').length, 0, `${name}: no dialog`);
  }
});

test('1v final limits: validateEvent accepts each field at its limit and rejects limit+1 (cut fields and never-cut bounds; validator rejects, never repairs)', async () => {
  const { codexDisplay, toolDisplay, uiActionDisplay } = await import('../src/display.js');
  const cc = codexDisplay('local_change', { kind: 'codex_command', commandLine: 'dir', workingDirectory: 'C:\\', networkAccess: false })!;
  const fc = codexDisplay('local_change', { kind: 'codex_file_change', paths: ['C:\\a'] })!;
  const ui = uiActionDisplay({ category: 'local_change', method: 'ui.click', appName: 'N', windowTitle: 't', processImage: 'n.exe' })!;
  const tl = toolDisplay({ category: 'local_change', method: 'files.move', targetLabel: 'x', fields: { targets: ['C:\\a'] } })!;
  const pd = preDispatchDisplay({ category: 'local_change', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' });
  const withApp = (k: string, v: string) => ({ ...ui, [K.app]: { ...(ui[K.app] as object), [k]: v } });
  const p4096 = 'C:\\' + 'p'.repeat(4093);
  const rows: Array<[string, (atLimit: boolean) => Record<string, unknown>, string]> = [
    ['summaryUntrusted', ok => ({ ...pd, [K.summary]: 's'.repeat(ok ? 500 : 501) }), 'coordinator'],
    ['reasonUntrusted cmd', ok => ({ ...cc, [K.reason]: 'r'.repeat(ok ? 500 : 501) }), 'codex'],
    ['reasonUntrusted fc', ok => ({ ...fc, [K.reason]: 'r'.repeat(ok ? 500 : 501) }), 'codex'],
    ['app.windowTitle', ok => withApp(K.windowTitle, 'w'.repeat(ok ? 256 : 257)), 'tool_host'],
    ['app.appName', ok => withApp(K.appName, 'a'.repeat(ok ? 128 : 129)), 'tool_host'],
    ['app.processImage', ok => withApp(K.processImage, 'p'.repeat(ok ? 260 : 261)), 'tool_host'],
    ['method ui_action', ok => ({ ...ui, [K.method]: 'ui.' + 'm'.repeat(ok ? 61 : 62) }), 'tool_host'],
    ['method tool', ok => ({ ...tl, [K.method]: 'm'.repeat(ok ? 64 : 65) }), 'tool_host'],
    ['targetLabel tool', ok => ({ ...tl, [K.targetLabel]: 't'.repeat(ok ? 256 : 257) }), 'tool_host'],
    ['commandLine bytes', ok => ({ ...cc, [K.commandLine]: '\u00e9'.repeat(4096) + (ok ? '' : 'x') }), 'codex'],
    ['workingDirectory bytes', ok => ({ ...cc, [K.workingDirectory]: '\u00e9'.repeat(2048) + (ok ? '' : 'x') }), 'codex'],
    ['escalation entries', ok => ({ ...cc, [K.escalation]: Array.from({ length: ok ? 32 : 33 }, (_, i) => `e${i}`) }), 'codex'],
    ['escalation entry chars', ok => ({ ...cc, [K.escalation]: ['\u{1F600}'.repeat(ok ? 256 : 257)] }), 'codex'],
    ['codex path bytes', ok => ({ ...fc, [K.paths]: [p4096 + (ok ? '' : 'x')] }), 'codex'],
    ['codex path count', ok => ({ ...fc, [K.paths]: Array.from({ length: ok ? 500 : 501 }, (_, i) => `C:\\${i}`), [K.fileCount]: ok ? '500' : '501' }), 'codex'],
    ['tool path bytes', ok => ({ ...tl, targets: [p4096 + (ok ? '' : 'x')] }), 'tool_host'],
  ];
  for (const [name, make, src] of rows) {
    assert.equal(reqEnv({ display: make(true), requestSource: src }).ok, true, `${name}: at limit valid`);
    assert.equal(reqEnv({ display: make(false), requestSource: src }).ok, false, `${name}: limit+1 rejected`);
  }
});
