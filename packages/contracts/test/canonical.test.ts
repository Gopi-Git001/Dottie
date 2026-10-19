// DOT-090 / E01 addition 1: the shared canonicaliser (ADR-0009 CR2; E08 follow-ups 7 and 8).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACTION_ID_PURPOSE, actionIdObject, actionIdOf, CanonicalError, canonicalInteger, canonicalJson, canonicalPath, computeActionId,
  hasDuplicateKeys, validateEvent, type ActionBinding,
  preDispatchArgs, computeDisplayHash, preDispatchDisplay, displayHashGuard,
  preDispatchBinding,
  toolCallActionIdStatus,
  toolCallBinding,
} from '../src/index.js';

const VECTORS = fileURLToPath(new URL('../../fixtures/action-id/vectors.json', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/action-id-vectors.mjs', import.meta.url));
const PY = fileURLToPath(new URL('../../scripts/check_action_id_vectors.py', import.meta.url));

const B: ActionBinding = {
  method: 'item/commandExecution/requestApproval',
  args: { command: 'del x', cwd: 'C:\\TMP' },
  targets: null, taskId: 'task-1', threadId: 'thr-1', turnId: 'turn-1', itemId: 'item-1', requestId: '0', displayHash: 'ab'.repeat(32), requestSource: 'codex',
};

test('RB02-U2 fixed vector: canonical JSON and actionId pinned by literal (not generated)', () => {
  const text = '{"args":{"command":"del x","cwd":"C:\\\\TMP"},"displayHash":"abababababababababababababababababababababababababababababababab","itemId":"item-1","method":"item/commandExecution/requestApproval","purpose":"dottie.actionId.v1","requestId":"0","requestSource":"codex","targets":null,"taskId":"task-1","threadId":"thr-1","turnId":"turn-1"}';
  assert.equal(canonicalJson(actionIdObject(B)), text);
  // sha256 of the literal above, computed independently: python3 -c 'import hashlib;print(hashlib.sha256(open(0,"rb").read()).hexdigest())'
  assert.equal(computeActionId(B), PINNED);
});
const PINNED = '5ab315ff8db4ee834784a8270ba429f09595f49b320006725966fa032bd6e521';

test('RB02-U2 changing any hashed field changes the actionId', () => {
  const id = computeActionId(B);
  const variants: Partial<ActionBinding>[] = [
    { method: 'item/fileChange/requestApproval' }, { args: { command: 'del y', cwd: 'C:\\TMP' } }, { args: { command: 'del x', cwd: 'C:\\TMP2' } },
    { targets: { hwnd: '1', pid: '2', windowClass: 'X', processStartTime: '3' } }, { taskId: 'task-2' }, { threadId: 'thr-2' },
    { turnId: 'turn-2' }, { itemId: 'item-2' }, { requestId: '1' }, { threadId: null }, { turnId: null }, { itemId: null }, { requestId: null },
  ];
  const seen = new Set([id]);
  for (const v of variants) {
    const other = computeActionId({ ...B, ...v });
    assert.notEqual(other, id, JSON.stringify(v));
    seen.add(other);
  }
  assert.equal(seen.size, variants.length + 1);
  assert.match(id, /^[0-9a-f]{64}$/);
});

test('RB02-U2 purpose and key set are enforced; fields that do not apply are null, never omitted', () => {
  const o = actionIdObject(B);
  assert.equal(o['purpose'], ACTION_ID_PURPOSE);
  assert.throws(() => actionIdOf({ ...o, purpose: 'dottie.approvalToken.v1' }), CanonicalError);
  const { purpose: _p, ...noPurpose } = o;
  assert.throws(() => actionIdOf(noPurpose), CanonicalError);
  assert.throws(() => actionIdOf({ ...o, extra: null }), CanonicalError);
  const { requestId: _r, ...noReq } = B;
  assert.throws(() => computeActionId(noReq as ActionBinding), /missing requestId/);
  assert.throws(() => computeActionId({ ...B, turnId: '' }), CanonicalError);
  assert.throws(() => computeActionId({ ...B, taskId: '' }), CanonicalError);
});

test('follow-up 7: integers only; NaN, ±Infinity, -0, fractions, unsafe integers rejected as INVALID_ARGUMENT', () => {
  assert.equal(canonicalInteger(0), '0');
  assert.equal(canonicalInteger(-7), '-7');
  assert.equal(canonicalInteger(1e21 - 1e21 + 12), '12');
  assert.equal(canonicalInteger(10n ** 30n), '1' + '0'.repeat(30));
  for (const bad of [NaN, Infinity, -Infinity, -0, 0.5, 1e-7, 2 ** 53]) {
    assert.throws(() => canonicalJson({ n: bad }), (e: unknown) => e instanceof CanonicalError && e.code === 'INVALID_ARGUMENT', String(bad));
  }
  assert.equal(canonicalJson({ n: 1e2 }), '{"n":"100"}', 'no exponent');
  assert.equal(canonicalJson([true, false, null]), '["true","false",null]');
});

test('canonicalJson rejects what it cannot represent faithfully', () => {
  for (const bad of [undefined, () => 1, Symbol('s'), new Date(0), new Map(), { a: undefined }, [1, , 2], { [Symbol('k')]: 1 }, '\udc00']) {
    assert.throws(() => canonicalJson(bad), CanonicalError);
  }
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":"2","b":"1"}');
});

test('canonicalJson: keys by code point (Python sort_keys order), minimal escaping', () => {
  assert.equal(canonicalJson({ '\uffff': 1, '😀': 2 }), '{"\uffff":"1","😀":"2"}', 'UTF-16 order would put 😀 first');
  assert.equal(canonicalJson({ s: 'é\u0001"\\\u2028' }), '{"s":"é\\u0001\\"\\\\\u2028"}');
});

test('CR2 duplicate JSON keys are detected anywhere in the raw text', () => {
  assert.equal(hasDuplicateKeys('{"a":1,"b":{"c":1,"d":[{"e":1}]}}'), false);
  assert.equal(hasDuplicateKeys('{"a":1,"a":2}'), true);
  assert.equal(hasDuplicateKeys('{"x":{"a":1,"b":2,"a":3}}'), true);
  assert.equal(hasDuplicateKeys('{"x":[{"a":1},{"a":2,"\\u0061":3}]}'), true, 'escaped spelling of the same key');
  assert.equal(hasDuplicateKeys('{"a":"{\\"a\\":1}","b":["a","a"]}'), false, 'keys inside strings and array values do not count');
  assert.equal(hasDuplicateKeys('{"a":{"k":1},"b":{"k":1}}'), false, 'same key in sibling objects is fine');
});

test('follow-up 8: path canonicalisation folds equivalent spellings; a mismatch re-prompts, never bypasses', () => {
  const w = (p: string, expandShortName?: (p: string) => string | undefined) => canonicalPath(p, { platform: 'win32', ...(expandShortName ? { expandShortName } : {}) });
  const same = ['C:\\Users\\Gopi\\a.txt', 'c:/users/gopi/A.TXT', '\\\\?\\C:\\Users\\Gopi\\a.txt', 'C:\\Users\\Gopi\\\\x\\..\\a.txt', 'C:\\Users\\Gopi\\a.txt\\'];
  assert.equal(new Set(same.map((p) => w(p))).size, 1);
  assert.equal(w('\\\\?\\UNC\\srv\\share\\d'), w('\\\\srv\\share\\d\\'));
  assert.equal(w('C:\\PROGRA~1\\x', (p) => (p.toUpperCase().startsWith('C:\\PROGRA~1') ? `C:\\Program Files${p.slice(11)}` : undefined)), w('C:\\Program Files\\x'));
  assert.throws(() => w('C:\\PROGRA~1\\x'), /8\.3/, 'no expander: refused (decline + re-ask), never hashed as-is');
  assert.throws(() => w('C:\\PROGRA~1\\x', (p) => (p === 'C:\\PROGRA~1\\x' ? 'C:\\OTHER~2\\x' : undefined)), /8\.3/, 'expansion still short and not confirmed long');
  assert.equal(w('C:\\a~1b', (p) => p), 'C:\\A~1B', 'expander confirms a long name that contains ~1');
  for (const bad of ['\\\\.\\pipe\\x', '\\??\\C:\\x', 'x', 'C:x', 'C:\\..\\x', 'C:\\a:b', 'C:\\a.', 'C:\\a ', 'C:\\con', 'C:\\com1.txt', 'C:\\a?', '', 'C:\\a\nb']) {
    assert.throws(() => w(bad), CanonicalError, JSON.stringify(bad));
  }
  assert.notEqual(w('C:\\\u212a'), w('C:\\k'), 'NTFS keeps Kelvin sign and k distinct; so does the hash');
  assert.equal(canonicalPath('/a//b/./c/../d/', { platform: 'posix' }), '/a/b/d');
  assert.notEqual(canonicalPath('/a/B', { platform: 'posix' }), canonicalPath('/a/b', { platform: 'posix' }));
  assert.throws(() => canonicalPath('a/b', { platform: 'posix' }), CanonicalError);
  assert.throws(() => canonicalPath(42, { platform: 'posix' }), CanonicalError);
});

test('published vectors are up to date and self-consistent', async () => {
  const mod = (await import(SCRIPT)) as { build(): unknown };
  const committed = JSON.parse(readFileSync(VECTORS, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(committed, JSON.parse(JSON.stringify(mod.build())), 'run npm run vectors');
  const pb = committed['pathBindings'] as { name: string; same: boolean }[];
  assert.deepEqual(pb.map((x) => x.same), [true, true, false, false]);
});

test('published vectors verify under an independent Python implementation (E04/E11 consumers)', (t) => {
  const r = spawnSync('python3', [PY, VECTORS], { encoding: 'utf8' });
  if (r.error) return t.skip('python3 not available');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok \d+/);
});

test('validateEvent keeps rejecting act-… ids; a computed actionId is accepted', () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/events/valid/approval-resolved.json', import.meta.url)), 'utf8')) as { payload: Record<string, unknown> };
  const ev = (actionId: string) => ({ ...fixture, payload: { ...fixture.payload, actionId } });
  assert.equal(validateEvent(ev('act-1')).ok, false);
  assert.equal(validateEvent(ev(`act-${'3f'.repeat(30)}`)).ok, false);
  const good = validateEvent(ev(computeActionId(B)));
  assert.equal(good.ok, true, JSON.stringify(good));
});

// D14 final ruling (E01 + E08, 2026-10-19): pre-dispatch args {summary, risk, category, possibleRepeat, retryOfTaskId}.
// Literal hashes, independently recomputed by scripts/check_action_id_vectors.py (Python hashlib + json.dumps).
// Ruling 1l (CONTRACTS E01 0d53abc): every vector regenerated with displayHash. Re-pin these in E03.
// Final set (CONTRACTS e41d1ca: rulings 1q/1r/1t/1u + ruling 1v key names). Re-pin these in E03/E04.
const D14_PINNED = {
  pre_dispatch_confirmation: 'c95085229aab3dd9dd9e4f13bfd36213a9203322a69d1b9224bdbcea1a806a95',
  'pre_dispatch_confirmation possible repeat': '2c0890f2775d3767d574ef9bf2337a74c23e2f2f379511761ecc8828bd798947',
  'pre_dispatch_confirmation clean-failure retry': '60c4800f5ffc2455f389b2901814b27a9752380f21b15129317bcc938a5415ea',
  'navigate tool call': '086df4468b250df47761550c2b0f1b7e4d98d3877aceb313f36cfcfd3ddcbc37',
} as const;
/** Every superseded pin (E03 original, D14 before displayHash, fee16aa before ruling 1r, e41d1ca before ruling 1v). None may survive. */
const SUPERSEDED_DOC = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/action-id/superseded.json', import.meta.url)), 'utf8')) as Record<string, string[]>;
const SUPERSEDED = [...SUPERSEDED_DOC['e03-original']!, ...SUPERSEDED_DOC['d14-ef1f6d3']!, ...SUPERSEDED_DOC['fee16aa']!, ...SUPERSEDED_DOC['e41d1ca-pre-1v']!];
const OLD_E03_PRE_DISPATCH = SUPERSEDED[0]!;
const PD_DISPLAY_HASH = '1af4547418602b5bb9ad80149f7e006109da68aa851d288109cfda4c8deb5a8d';
const PD_ARGS = { summary: 'Delete old.log in Downloads', risk: 'high', category: 'delete' } as const;
const pd = (args: Parameters<typeof preDispatchArgs>[0]) => preDispatchBinding({ taskId: 'task_1', turnId: 'task_1.t1', requestId: 'req_conf', args });

test('D14 pinned vectors: the four new hashes are in vectors.json and the helpers produce them', () => {
  const committed = JSON.parse(readFileSync(VECTORS, 'utf8')) as { actionId: { name: string; actionId: string }[] };
  for (const [name, hash] of Object.entries(D14_PINNED)) {
    assert.deepEqual(committed.actionId.filter((x) => x.name === name).map((x) => x.actionId), [hash], name);
  }
  assert.equal(computeActionId(pd(PD_ARGS)), D14_PINNED.pre_dispatch_confirmation, '(a) absent: both D14 keys null');
  assert.equal(computeActionId(pd({ ...PD_ARGS, possibleRepeat: null, retryOfTaskId: null })), D14_PINNED.pre_dispatch_confirmation, 'explicit null = absent');
  assert.equal(computeActionId(pd({ ...PD_ARGS, possibleRepeat: 'possible', retryOfTaskId: 'task_0' })), D14_PINNED['pre_dispatch_confirmation possible repeat'], '(b)');
  assert.equal(computeActionId(pd({ ...PD_ARGS, retryOfTaskId: 'task_0' })), D14_PINNED['pre_dispatch_confirmation clean-failure retry'], '(4) clean-failure retry');
  const nav = toolCallBinding({ toolId: 'explorer.open_known_folder', args: { folder: 'downloads' }, taskId: 'task_1', threadId: 'thr_1', turnId: 'task_1.t1', itemId: 'item_1', requestId: 'req_1', displayHash: null });
  assert.equal(nav.targets, null);
  assert.equal(computeActionId(nav), D14_PINNED['navigate tool call'], '(c) navigate, targets null');
  // Literal (not generated); sha256 of it checked with `sha256sum`: c9508522….
  assert.equal(canonicalJson(actionIdObject(pd(PD_ARGS))),
    '{"args":{"category":"delete","displayHash":"1af4547418602b5bb9ad80149f7e006109da68aa851d288109cfda4c8deb5a8d","possibleRepeat":null,"retryOfTaskId":null,"risk":"high","summary":"Delete old.log in Downloads"},"displayHash":"1af4547418602b5bb9ad80149f7e006109da68aa851d288109cfda4c8deb5a8d","itemId":null,"method":"dottie.pre_dispatch_confirmation","purpose":"dottie.actionId.v1","requestId":"req_conf","requestSource":"coordinator","targets":null,"taskId":"task_1","threadId":null,"turnId":"task_1.t1"}');
  assert.equal(canonicalJson(preDispatchDisplay(pd(PD_ARGS).args as never)), '{"category":"delete","kind":"pre_dispatch","possibleRepeat":null,"retryOfTaskId":null,"risk":"high","summaryUntrusted":"Delete old.log in Downloads"}');
  assert.equal(computeDisplayHash(preDispatchDisplay(pd(PD_ARGS).args as never)), PD_DISPLAY_HASH);
});

test('superseded pins (E03 original, D14 before displayHash) are gone from vectors.json and the source', () => {
  const text = readFileSync(VECTORS, 'utf8');
  for (const h of SUPERSEDED) assert.ok(!text.includes(h), h);
  assert.notEqual(computeActionId(pd(PD_ARGS)), OLD_E03_PRE_DISPATCH);
});

test('ruling 1l: summary is bound twice (pre-dispatch arg and display); either alone changes the actionId', () => {
  const b = pd(PD_ARGS);
  const other = computeDisplayHash(preDispatchDisplay({ ...(b.args as never as Parameters<typeof preDispatchDisplay>[0]), summary: 'Delete new.log in Downloads' }));
  const displayOnly = { ...b, displayHash: other, args: { ...(b.args as object), displayHash: other } };
  const argOnly = { ...b, args: { ...(b.args as object), summary: 'Delete new.log in Downloads' } };
  const ids = [b, displayOnly, argOnly].map((x) => computeActionId(x));
  assert.equal(new Set(ids).size, 3);
  const v = JSON.parse(readFileSync(VECTORS, 'utf8')) as { actionId: { name: string; actionId: string }[] };
  const pin = (n: string) => v.actionId.find((x) => x.name === n)!.actionId;
  assert.equal(ids[1], pin('pre_dispatch_confirmation display summary changed alone'));
  assert.equal(ids[2], pin('pre_dispatch_confirmation args summary changed alone'));
  // and for a tool-call display: same args, different targetLabel → different actionId.
  assert.notEqual(pin('codex command approval'), pin('changed display only: command'));
});

test('displayHash placement: generic calls top-level only; pre-dispatch in args AND top-level (same value); navigate null', () => {
  const b = pd(PD_ARGS);
  assert.equal(b.displayHash, PD_DISPLAY_HASH);
  assert.equal((b.args as { displayHash: string }).displayHash, PD_DISPLAY_HASH);
  assert.equal(displayHashGuard('delete', b.displayHash), 'ok');
  assert.equal(displayHashGuard('navigate', null), 'ok');
  assert.equal(displayHashGuard('delete', null), 'display_unavailable');
  assert.equal(displayHashGuard('navigate', PD_DISPLAY_HASH), 'display_unavailable');
  // Ruling 2a: the guard is per display kind. tool (default) / ui_action read+navigate: no dialog, null hash only.
  // pre_dispatch / codex_*: read+navigate open a dialog and need a hash. credential_access: never a hash.
  for (const c of ['read', 'navigate'] as const) {
    for (const k of ['tool', 'ui_action'] as const) {
      assert.equal(displayHashGuard(c, null, k), 'ok');
      assert.equal(displayHashGuard(c, PD_DISPLAY_HASH, k), 'display_unavailable', `${k} ${c} with a dialog`);
    }
    for (const k of ['pre_dispatch', 'codex_command', 'codex_file_change'] as const) {
      assert.equal(displayHashGuard(c, PD_DISPLAY_HASH, k), 'ok', `${k} ${c}`);
      assert.equal(displayHashGuard(c, null, k), 'display_unavailable', `${k} ${c} without a hash`);
    }
  }
  for (const k of ['tool', 'ui_action', 'pre_dispatch', 'codex_command', 'codex_file_change'] as const) {
    assert.equal(displayHashGuard('credential_access', PD_DISPLAY_HASH, k), 'display_unavailable', k);
    assert.equal(displayHashGuard('delete', PD_DISPLAY_HASH, k), 'ok', k);
    assert.equal(displayHashGuard('delete', null, k), 'display_unavailable', k);
  }
  // pre-dispatch read (D14 read retry, C-25) binds a display hash.
  const rd = pd({ ...PD_ARGS, category: 'read', possibleRepeat: null, retryOfTaskId: 'task_0' });
  assert.match(rd.displayHash as string, /^[0-9a-f]{64}$/);
  assert.equal(displayHashGuard('read', rd.displayHash, 'pre_dispatch'), 'ok');
  assert.throws(() => computeActionId({ ...B, displayHash: undefined as never }), CanonicalError);
});

test('E03 C-57 / rulings 1r/1u: computeActionId itself throws on a null, missing or out-of-enum requestSource; never null; pre-dispatch ⇔ coordinator; navigate = tool_host + null', () => {
  const v = JSON.parse(readFileSync(VECTORS, 'utf8')) as { actionId: { name: string; actionId: string; input: Record<string, unknown> }[]; actionIdInvalid: { name: string }[] };
  const nav = v.actionId.find((x) => x.name === 'navigate tool call')!;
  assert.equal(nav.input['requestSource'], 'tool_host');
  assert.equal(nav.input['displayHash'], null);
  for (const n of ['null requestSource (ruling 1u)', 'missing requestSource (ruling 1r)', 'pre-dispatch method with requestSource codex (ruling 1r)', 'coordinator requestSource on a generic call (ruling 1r)']) {
    assert.ok(v.actionIdInvalid.some((x) => x.name === n), n);
  }
  assert.throws(() => computeActionId({ ...B, requestSource: null as never }), /requestSource/);
  assert.throws(() => computeActionId({ ...B, requestSource: undefined as never }), /requestSource/);
  assert.throws(() => computeActionId({ ...B, requestSource: 'model' as never }), /requestSource/);
  assert.throws(() => computeActionId({ ...B, requestSource: 'coordinator' }), /coordinator/);
  assert.throws(() => computeActionId({ ...pd(PD_ARGS), requestSource: 'codex' }), /coordinator/);
  assert.equal(pd(PD_ARGS).requestSource, 'coordinator');
  // K8 recomputes with its own requestSource: any other value is a different actionId (→ wrong_action).
  const ids = (['codex', 'tool_host'] as const).map((requestSource) => computeActionId({ ...B, requestSource }));
  assert.notEqual(ids[0], ids[1]);
  const pin = (n: string) => v.actionId.find((x) => x.name === n)!.actionId;
  assert.notEqual(pin('codex command approval'), pin('changed requestSource only (ruling 1r)'));
  assert.notEqual(pin('navigate tool call'), pin('navigate with requestSource codex instead of tool_host (K8 wrong_action)'));
});

test('ruling 1q: pre-dispatch args.displayHash must equal the top-level one; generic args never carry it (fail closed)', () => {
  const b = pd(PD_ARGS);
  const other = 'cd'.repeat(32);
  assert.throws(() => computeActionId({ ...b, displayHash: other }), /ruling 1q/);
  assert.throws(() => computeActionId({ ...b, args: { ...(b.args as object), displayHash: other } }), /ruling 1q/);
  const { displayHash: _d, ...noArgHash } = b.args as Record<string, unknown>;
  assert.throws(() => computeActionId({ ...b, args: noArgHash }), /ruling 1q/);
  assert.throws(() => computeActionId({ ...b, args: 'x' }), /ruling 1q/, 'pre-dispatch args must be the §2.1 object');
  assert.throws(() => computeActionId({ ...B, args: { ...(B.args as object), displayHash: B.displayHash } }), /ruling 1q/);
  assert.throws(() => computeActionId({ ...B, args: { ...(B.args as object), displayHash: null } }), /ruling 1q/);
  assert.doesNotThrow(() => computeActionId({ ...B, args: { nested: { displayHash: 'x' } } }), 'only a top-level args key counts');
  assert.doesNotThrow(() => computeActionId(b));
  const v = JSON.parse(readFileSync(VECTORS, 'utf8')) as { actionIdInvalid: { name: string }[] };
  for (const n of ['pre-dispatch args.displayHash differs from the top-level displayHash (ruling 1q)', 'generic call with displayHash in args (ruling 1q)']) {
    assert.ok(v.actionIdInvalid.some((x) => x.name === n), n);
  }
});

test('D14: every pre-dispatch field changes the hash; not replayable to another turn', () => {
  const base = computeActionId(pd(PD_ARGS));
  const variants = [
    pd({ ...PD_ARGS, possibleRepeat: 'unknown', retryOfTaskId: 'task_0' }),
    pd({ ...PD_ARGS, possibleRepeat: 'committed', retryOfTaskId: 'task_0' }),
    pd({ ...PD_ARGS, retryOfTaskId: 'task_9' }),
    pd({ ...PD_ARGS, summary: 'Delete new.log in Downloads' }),
    pd({ ...PD_ARGS, risk: 'critical' }),
    pd({ ...PD_ARGS, category: 'overwrite' }),
    { ...pd(PD_ARGS), turnId: 'task_1.t2' },
  ];
  const hashes = new Set([base, ...variants.map((v) => computeActionId(v))]);
  assert.equal(hashes.size, variants.length + 1);
});

test('D14: preDispatchArgs rejects the event object, unknown values and keys, and read with a repeat', () => {
  assert.throws(() => preDispatchArgs({ ...PD_ARGS, possibleRepeat: { priorTaskId: 'task_0', priorSideEffect: 'possible' } as never }), /possibleRepeat must be/);
  assert.throws(() => preDispatchArgs({ ...PD_ARGS, possibleRepeat: 'none' as never }), /possibleRepeat must be/);
  assert.throws(() => preDispatchArgs({ ...PD_ARGS, retryOfTaskId: '' }), /retryOfTaskId/);
  assert.throws(() => preDispatchArgs({ ...PD_ARGS, risk: 'severe' as never }), /risk/);
  assert.throws(() => preDispatchArgs({ ...PD_ARGS, category: 'nuke' as never }), /category/);
  assert.throws(() => preDispatchArgs({ ...PD_ARGS, expiry: 'x' } as never), /unknown pre-dispatch arg/);
  assert.throws(() => preDispatchArgs({ ...PD_ARGS, category: 'read', possibleRepeat: 'possible', retryOfTaskId: 'task_0' }), /read/);
  assert.doesNotThrow(() => preDispatchArgs({ ...PD_ARGS, possibleRepeat: 'possible' }), 'pairing with retryOfTaskId is coordinator-only (ruling 1f)');
  assert.throws(() => preDispatchBinding({ taskId: 'task_1', turnId: '', requestId: 'r', args: PD_ARGS }), /turnId/);
  assert.throws(() => preDispatchBinding({ taskId: 'task_1', turnId: 'task_1.t1', requestId: '', args: PD_ARGS }), /requestId/);
});

test('ruling 1d: toolCallBinding needs an area.verb_object toolId; toolCallActionIdStatus flags missing/malformed ids', () => {
  const b = { args: { folder: 'downloads' }, taskId: 't', threadId: null, turnId: null, itemId: null, requestId: null, displayHash: null };
  assert.throws(() => toolCallBinding({ ...b, toolId: 'open_known_folder' }), /area.verb_object/);
  assert.throws(() => toolCallBinding({ ...b, toolId: 'Explorer.Open' }), /area.verb_object/);
  assert.equal(toolCallActionIdStatus({ v: 1, callId: 'c', toolId: 'explorer.open_known_folder', actionId: D14_PINNED['navigate tool call'], category: 'navigate' }), 'ok');
  for (const p of [{}, { actionId: null }, { actionId: 'act-1' }, { actionId: D14_PINNED['navigate tool call'].toUpperCase() }, { actionId: `x${D14_PINNED['navigate tool call']}` }, { actionId: `${D14_PINNED['navigate tool call']}0` }, null]) assert.equal(toolCallActionIdStatus(p), 'malformed');
});
