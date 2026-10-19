/**
 * E02's real computeActionId / computeDisplayHash and E02's vectors, re-vendored at dottie-e02
 * feature/E02-approvals-bridge 45129fe (plain data only; on top of 0146c90 1y follow-up, 2581593 / cc22afb) (packages/contracts/fixtures/action-id/vectors.json; CONTRACTS e41d1ca + rulings
 * 1v (c19b751), 1x (474c502), 1y (c0b36d4), 1z (492c01c), 2a (972d5f4), 2b (97e7bc0), 1y follow-up; first vendored at 895676d, every 895676d
 * entry is byte-identical in cc22afb). The E02 sources are VENDORED verbatim under
 * src/vendor/e02-contracts (no runtime dependency on @dottie/contracts; see the NOTICE there); the vectors are vendored
 * under test/fixtures/e02. Every hash must be byte-identical; a mismatch is a stop, never patched around.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateEvent } from '../src/contracts.js';
import { DISPLAY_KEYS as K, codexDisplay, preDispatchDisplay, renderBoundText, toolDisplay, uiActionDisplay } from '../src/display.js';
import { contractsActionIdPort } from '../src/actionIdPort.js';
import { codexDisplayParams, computeDisplayHash as e02ComputeDisplayHash, preDispatchDisplay as e02PreDispatchDisplay, validateApprovalDisplay } from '../src/vendor/e02-contracts/display.js';
import type { ActionIdBinding, PolicyPort } from '../src/ports.js';
import { allowAllChannels, envelope, fixture, flush, hexId } from './helpers.js';

type Json = Record<string, unknown>;
const VECTORS_PATH = new URL('../../test/fixtures/e02/vectors.json', import.meta.url);
const raw = readFileSync(VECTORS_PATH);
const V = JSON.parse(raw.toString('utf8')) as Record<string, Json[]> & { purpose: string };
const port = contractsActionIdPort;
/** Decode the vector markers ({"$number": "NaN"|"Infinity"|"-Infinity"|"-0"}, {"$bigint": "…"}) before hashing (vectors _readme). */
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$number') return ({ NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 } as Record<string, number>)[o['$number'] as string];
    if (keys.length === 1 && keys[0] === '$bigint') return BigInt(o['$bigint'] as string);
    return Object.fromEntries(keys.map(k => [k, decode(o[k])]));
  }
  return v;
}
const aid = (b: unknown) => port.computeActionId(decode(b) as ActionIdBinding) as string;
const dh = (d: unknown) => port.computeDisplayHash!(d as never) as string;
const SOURCE_OF: Record<string, string> = { tool: 'tool_host', ui_action: 'tool_host', codex_command: 'codex', codex_file_change: 'codex', pre_dispatch: 'coordinator' };
const repeatOf = (d: Json): Json => (d['kind'] === 'pre_dispatch' && d['possibleRepeat'] !== null && d['possibleRepeat'] !== undefined ? { possibleRepeat: { priorTaskId: d['retryOfTaskId'], priorSideEffect: d['possibleRepeat'] } } : {});
const reqEnv = (display: Json, extra: Json = {}) => validateEvent({
  ...envelope('ApprovalRequested', {} as never), taskId: 'task_v',
  payload: { taskId: 'task_v', actionId: hexId('v'), summary: 's', risk: (display['risk'] as string) ?? 'high', expiry: '2026-10-19T00:00:00Z', category: (display['category'] as string) ?? 'local_change', display, requestSource: SOURCE_OF[display['kind'] as string] ?? 'codex', ...repeatOf(display), ...extra } as never,
});
const byName = (section: string, name: string) => {
  const v = V[section]!.find(x => x['name'] === name);
  assert.ok(v, `${section}: ${name}`);
  return v!;
};

const gitBlob = (b: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
test('E02 vectors: the vendored fixture is 45129fe byte-for-byte (blob SHA) and has the sections we pin', () => {
  // git blob id = sha1("blob <len>\0" + bytes): equals `git rev-parse 45129fe:packages/contracts/fixtures/action-id/vectors.json`
  assert.equal(gitBlob(raw), '524d2c311f91c3b2c86022b5b1cdeaa0dccdc4b9');
  assert.equal(V.purpose, 'dottie.actionId.v1');
  assert.deepEqual([V['displays']!.length, V['displayCuts']!.length, V['actionId']!.length, V['actionIdInvalid']!.length, V['displaysInvalid']!.length], [43, 9, 23, 17, 62]);
});

test('E02 vectors: the seven pinned actionIds and fifteen displayHashes, byte-for-byte, through the real port', () => {
  const pinnedIds: Array<[string, string]> = [
    ['pre_dispatch_confirmation', 'c95085229aab3dd9dd9e4f13bfd36213a9203322a69d1b9224bdbcea1a806a95'],
    ['pre_dispatch_confirmation possible repeat', '2c0890f2775d3767d574ef9bf2337a74c23e2f2f379511761ecc8828bd798947'],
    ['pre_dispatch_confirmation clean-failure retry', '60c4800f5ffc2455f389b2901814b27a9752380f21b15129317bcc938a5415ea'],
    ['navigate tool call', '086df4468b250df47761550c2b0f1b7e4d98d3877aceb313f36cfcfd3ddcbc37'],
    ['codex command approval', 'b07386ab1015ba4a8ca6f48e2bcfe39722c84daece2179e00143eb8605381466'],
    ['codex file change approval', 'e481a033aa5d4db69eb3616559060ddc1ebde2b501b1f22dfa98349f19b972c8'],
    ['ui_action tool call with window target', '22e4c17f269fb107a551bfb2d40f09f5790ad10102fcea1a4b3b4cf39d3a119a'],
  ];
  for (const [name, id] of pinnedIds) {
    const v = byName('actionId', name);
    assert.equal(v['actionId'], id, `${name}: vector file`);
    assert.equal(aid(v['input']), id, `${name}: computed`);
  }
  const navigate = byName('actionId', 'navigate tool call')['input'] as Json;
  assert.deepEqual([navigate['requestSource'], navigate['displayHash']], ['tool_host', null]);
  const pinnedDisplays: Array<[string, string]> = [
    ['pre_dispatch absent', '1af4547418602b5bb9ad80149f7e006109da68aa851d288109cfda4c8deb5a8d'],
    ['pre_dispatch possible repeat', 'f203b61e871f93deb947e6426d9405fff04f095f5f5014d0e593363f00eef8f9'],
    ['pre_dispatch clean-failure retry', '3ecef892426bc977e128f438a41992cc1ad54be9d16ac0d00de7c8cb3c4ce523'],
    ['codex command', 'fbfb108e2a915c30f29b414022e62a8ee343d40ed904622fbef19b3ed397fc44'],
    ['codex file change', '35d80a6dfa2c255a7f59868e01c51cd58c943fde392dd7f9dfa9272cf2f197a2'],
    ['ui_action in an app', 'e571b332c617844d5c7f182bf218e36e1bdacf1d51ffbb37677a1186248a6d5e'],
    // new at cc22afb (2a kind-scoped coverage; the flipped pre_dispatch read; method never cut at 64)
    ['ruling 2a: pre_dispatch read (D14 read retry, C-25)', '8c5fb1b88cf528496601128f86bdedc4970e6e49fbcb79fe59082ef7692ab6a8'],
    ['ruling 2a: pre_dispatch navigate', '956eb33bdeed455ad8539595d55236017c519ab35100ea62a64d1d752e4b339b'],
    ['ruling 2a: codex_command read', 'c1067656bbc5ce82779fd3771049032488261ae02087a0316716b3290fb01dcf'],
    ['ruling 2a: codex_file_change navigate', 'ba82e371dc3692bd3188cd758fd43ff1bbc9214c0bbd1851dc72ac7f9d7d831d'],
    ['ruling 2a: pre_dispatch read (formerly invalid "read has no display rule")', '52bc8f64bf80fa75308743e08fde03a6ca65d44ddf347065d385ff2a1802fecf'],
    ['ui_action method 64 code points (never cut)', '9d8dc7c29bd9f4677d057a0203ab5e1b25b0aa0def264410f615f3400b94be8d'],
    ['tool method 64 code points (never cut)', '0f0e17c3603de1f16e7be03f028ce237d931d4ff6b1e570e0e3f7a3f5b2ece41'],
    // new at 0146c90 (E01 1y follow-up: names outside the ui./window. namespace stay tools)
    ['1y follow-up: tool method "uix.click" accepted', '257971a2411c86b005f51642a00c7a30f5ed050b52d0e3bc8124dc45f3767dbc'],
    ['1y follow-up: tool method "file.read" accepted', '4bcf7734794b7c1a0945d9fe3ad8c85bb5d76d7e7f704ea53fa558cb183ae64a'],
  ];
  for (const [name, h] of pinnedDisplays) {
    const v = byName('displays', name);
    assert.equal(v['displayHash'], h, `${name}: vector file`);
    assert.equal(dh(v['display']), h, `${name}: computed`);
  }
});

test('E02 vectors: all 23 actionId vectors (canonical + id) and all 17 invalid bindings (incl. null / missing / out-of-enum requestSource) through the real port', () => {
  for (const v of V['actionId']!) assert.equal(aid(v['input']), v['actionId'], v['name'] as string);
  const names = V['actionIdInvalid']!.map(v => v['name']);
  for (const n of ['null requestSource (ruling 1u)', 'missing requestSource (ruling 1r)', 'unknown requestSource']) assert.ok(names.includes(n), n);
  for (const v of V['actionIdInvalid']!) assert.throws(() => aid(v['input']), (e: Error) => e.name === 'CanonicalError', v['name'] as string);
});

test('E02 vectors: all 43 displays: hash byte-identical (vendored computeDisplayHash and the port); vendored validator, our validateEvent and our builder for that kind all accept / rebuild the same bytes', () => {
  for (const v of V['displays']!) {
    const d = v['display'] as Json;
    const name = v['name'] as string;
    assert.equal(dh(d), v['displayHash'], `${name}: displayHash`);
    assert.equal(e02ComputeDisplayHash(d as never), v['displayHash'], `${name}: vendored computeDisplayHash`);
    assert.equal(validateApprovalDisplay(d).ok, true, `${name}: vendored validator`);
    const r = reqEnv(d);
    assert.equal(r.ok, true, `${name}: validateEvent ${JSON.stringify(r)}`);
    let rebuilt: unknown;
    switch (d['kind']) {
      case 'pre_dispatch': rebuilt = preDispatchDisplay({ category: d['category'] as string, risk: d['risk'] as string, possibleRepeat: d['possibleRepeat'] as string | null, retryOfTaskId: d['retryOfTaskId'] as string | null, summary: d[K.summary] as string }); break;
      case 'ui_action': { const a = d[K.app] as Record<string, string>; rebuilt = uiActionDisplay({ category: d['category'] as string, method: d[K.method] as string, appName: a[K.appName]!, windowTitle: a[K.windowTitle]!, processImage: a[K.processImage]! }); break; }
      case 'codex_command': case 'codex_file_change': rebuilt = codexDisplay(d['category'] as string, codexDisplayParams(d as never)); break;
      case 'tool': {
        const { kind: _k, category, method, targetLabel, fileCount: _f, itemCount: _i, ...fields } = d as Record<string, unknown>;
        rebuilt = toolDisplay({ category: category as string, method: method as string, targetLabel: targetLabel as string, fields: fields as never });
        break;
      }
    }
    assert.deepEqual(rebuilt, d, `${name}: our builder`);
    assert.equal(dh(rebuilt), v['displayHash'], `${name}: our builder hash`);
  }
});

test('E02 vectors: all 9 displayCuts (max-1 / max / max+1 summary and windowTitle, strip-before-cut, astral, bidi in a bound title) through our builders, byte-identical', () => {
  for (const v of V['displayCuts']!) {
    const d = v['display'] as Json;
    const input = v['input'] as string;
    const built = v['field'] === 'summaryUntrusted'
      ? preDispatchDisplay({ category: d['category'] as string, risk: d['risk'] as string, possibleRepeat: null, retryOfTaskId: null, summary: input })
      : uiActionDisplay({ category: d['category'] as string, method: d[K.method] as string, appName: 'Notepad', windowTitle: input, processImage: 'notepad.exe' });
    assert.deepEqual(built, d, v['name'] as string);
    assert.equal(dh(built), v['displayHash'], `${v['name']}: hash`);
    assert.equal(e02ComputeDisplayHash(d as never), v['displayHash'], `${v['name']}: vendored hash`);
    const out = v['field'] === 'summaryUntrusted' ? built![K.summary] : (built![K.app] as Json)[K.windowTitle];
    assert.equal(out, v['output'], `${v['name']}: output`);
    assert.equal([...(out as string)].length, v['outputCodePoints']);
  }
});

test('E02 vectors: all 62 invalid displays are rejected by the vendored validator, the port hash and our validateEvent; the 21 1z / 2a / 1y-follow-up / never-cut ones are refused by our builders too', () => {
  const built: string[] = [];
  for (const v of V['displaysInvalid']!) {
    const d = v['display'] as Json;
    const name = v['name'] as string;
    assert.equal(validateApprovalDisplay(d).ok, false, `${name}: vendored validator`);
    assert.throws(() => dh(d), `${name}: port hash`);
    assert.equal(reqEnv(d).ok, false, `${name}: validateEvent`);
    if (!/^ruling (1z|2a)|never cut|^1y follow-up/.test(name)) continue;
    let rebuilt: unknown;
    switch (d['kind']) {
      case 'ui_action': { const a = d[K.app] as Record<string, string>; rebuilt = uiActionDisplay({ category: d['category'] as string, method: d[K.method] as string, appName: a[K.appName]!, windowTitle: a[K.windowTitle]!, processImage: a[K.processImage]! }); break; }
      case 'tool': {
        const { kind: _k, category, method, targetLabel, fileCount: _f, itemCount: _i, ...fields } = d as Record<string, unknown>;
        rebuilt = toolDisplay({ category: category as string, method: method as string, targetLabel: targetLabel as string, fields: fields as never });
        break;
      }
      case 'codex_command': case 'codex_file_change': rebuilt = codexDisplay(d['category'] as string, codexDisplayParams(d as never)); break;
      case 'pre_dispatch': rebuilt = null; assert.equal(reqEnv(preDispatchDisplay({ category: d['category'] as string, risk: d['risk'] as string, possibleRepeat: null, retryOfTaskId: null, summary: d[K.summary] as string })).ok, false, `${name}: our pre_dispatch build never validates`); break;
    }
    assert.equal(rebuilt, null, `${name}: our builder refuses (display_unavailable)`);
    built.push(name);
  }
  assert.equal(built.length, 21, built.join(' | '));
});

test('real port end to end: the pre-dispatch ApprovalRequested actionId = computeActionId(binding) over E02 canonical JSON; its displayHash = the vector rule', async () => {
  const policy: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary: 'Delete old.log in Downloads', risk: 'high', category: 'delete' }) };
  const f = await fixture({ policy });
  f.say('delete old.log', 'req_conf');
  await flush();
  const req = f.sink.of('ApprovalRequested')[0]!.payload;
  assert.equal(req.display[K.summary], 'Delete old.log in Downloads');
  const b = f.actionIds!.bindings[0]!;
  assert.equal(b.displayHash, '1af4547418602b5bb9ad80149f7e006109da68aa851d288109cfda4c8deb5a8d', 'same display as the "pre_dispatch absent" vector');
  const vec = byName('actionId', 'pre_dispatch_confirmation')['input'] as Json;
  assert.equal(req.actionId, aid({ ...vec, taskId: b.taskId, turnId: b.turnId, requestId: b.requestId }), 'same rule as the vector, our ids');
});

// ---------------------------------------------------------------- item 2: E02's larger hidden-character strip set
const ADDED = ['\u034f', '\u115f', '\u1160', '\u17b4', '\u17b5', '\u206a', '\u206f', '\u3164', '\uffa0', '\ufff9', '\ufffb', '\u{e0001}', '\u{e007f}'];
test('strip set (bug): a pre-dispatch summary with a character only E02 strips is emitted and validates (before: kept, then rejected / not approvable)', async () => {
  for (const ch of ADDED) {
    const summary = `Delete${ch} old.log`;
    const policy: PolicyPort = { ...allowAllChannels, preDispatchConfirmation: () => ({ summary, risk: 'high', category: 'delete' }) };
    const f = await fixture({ policy });
    f.say('delete old.log', `req_strip_${ch.codePointAt(0)}`);
    await flush();
    const req = f.sink.of('ApprovalRequested')[0];
    assert.ok(req, `U+${ch.codePointAt(0)!.toString(16)}: an approval is requested`);
    assert.equal(req!.payload.display[K.summary], 'Delete old.log');
    assert.deepEqual(req!.payload.display, e02PreDispatchDisplay({ summary, risk: 'high', category: 'delete', possibleRepeat: null, retryOfTaskId: null }));
    assert.equal(validateEvent(JSON.parse(JSON.stringify(req))).ok, true);
  }
});

test('strip set: our untrusted strip equals E02 for every code point; lone surrogates become U+FFFD; our validateEvent rejects a hidden character left in an untrusted slot', () => {
  const diffs: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const ours = preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: `a${ch}b` })[K.summary];
    const e02 = e02PreDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: `a${ch}b` }).summaryUntrusted;
    if (ours !== e02) diffs.push(cp.toString(16));
  }
  assert.deepEqual(diffs, []);
  assert.equal(preDispatchDisplay({ category: 'delete', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 'a\ud800b\udc00c' })[K.summary], 'a\ufffdb\ufffdc');
  assert.equal(codexDisplay('delete', { kind: 'codex_file_change', paths: ['C:\\a'], reason: 'x\ud83dy' })![K.reason], 'x\ufffdy');
  const pd = preDispatchDisplay({ category: 'local_change', risk: 'high', possibleRepeat: null, retryOfTaskId: null, summary: 's' });
  for (const ch of ADDED) assert.equal(reqEnv({ ...pd, [K.summary]: `s${ch}` }).ok, false, `U+${ch.codePointAt(0)!.toString(16)} left in the summary`);
});

test('strip set (1t): bound fields keep the added characters and render them as visible escapes with the badge', () => {
  for (const ch of ADDED) {
    const p = `C:\\TMP\\a${ch}b.txt`;
    const d = codexDisplay('delete', { kind: 'codex_file_change', paths: [p] })!;
    assert.deepEqual(d[K.paths], [p], 'never stripped');
    const r = renderBoundText(p);
    assert.equal(r.hiddenCharacters, true, `U+${ch.codePointAt(0)!.toString(16)}: badge`);
    assert.equal(r.lines[0], `C:\\TMP\\a<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>b.txt`);
  }
});

// ---------------------------------------------------------------- item 3 / E01 1x: tool display keys per E02 895676d
test('1x tool keys: no detail; external_send body is bodyUntrusted (stripped, cut at 200); delete/overwrite get fileCount, local_change itemCount; exact key set per category', () => {
  const del = toolDisplay({ category: 'delete', method: 'files.delete_item', targetLabel: 'Delete 2 items', fields: { paths: ['C:\\A', 'C:\\B'] } })!;
  assert.deepEqual(del, { kind: 'tool', category: 'delete', method: 'files.delete_item', targetLabel: 'Delete 2 items', paths: ['C:\\A', 'C:\\B'], fileCount: '2' });
  const ow = toolDisplay({ category: 'overwrite', method: 'files.write_text', targetLabel: 'Overwrite A', fields: { paths: ['C:\\A'] } })!;
  assert.equal(ow[K.fileCount], '1');
  const lc = toolDisplay({ category: 'local_change', method: 'files.edit_text', targetLabel: 'Edit', fields: { targets: ['C:\\A', 'C:\\B', 'C:\\C'] } })!;
  assert.equal(lc['itemCount'], '3');
  const send = toolDisplay({ category: 'external_send', method: 'mail.send_message', targetLabel: 'Send', fields: { recipients: ['a@example.com'], channel: 'email', bodyUntrusted: 'Hi\u202e there' + 'x'.repeat(300) } })!;
  assert.equal([...(send['bodyUntrusted'] as string)].length, 200);
  assert.ok((send['bodyUntrusted'] as string).startsWith('Hi there'));
  assert.ok((send['bodyUntrusted'] as string).endsWith('\u2026'));
  assert.equal(reqEnv(send).ok, true);
  assert.equal(toolDisplay({ category: 'external_send', method: 'mail.send_message', targetLabel: 'Send', fields: { recipients: ['a@example.com'], channel: 'email', body: 'Hi' } }), null, 'body (pre-1x) rejected');
  assert.equal(toolDisplay({ category: 'delete', method: 'files.delete_item', targetLabel: 'x', fields: { paths: ['C:\\A'], detail: 'model text' } }), null, 'detail removed');
  assert.equal(toolDisplay({ category: 'delete', method: 'files.delete_item', targetLabel: 'x', fields: {} }), null, 'missing paths');
  assert.equal(toolDisplay({ category: 'purchase', method: 'shop.buy_item', targetLabel: 'Buy', fields: { merchant: 'M', amount: '19.99' } }), null, 'missing currency');
  // validateEvent: the same rules on an incoming event
  assert.equal(reqEnv({ ...del, detail: 'x' }).ok, false, 'detail');
  const { fileCount: _fc, ...noCount } = del;
  assert.equal(reqEnv(noCount).ok, false, 'delete without fileCount');
  const { bodyUntrusted: b, ...rest } = send;
  assert.equal(reqEnv({ ...rest, body: b }).ok, false, 'body instead of bodyUntrusted');
  assert.equal(reqEnv({ ...send, bodyUntrusted: 'Hi\u200b' }).ok, false, 'unstripped bodyUntrusted');
});

// ---------------------------------------------------------------- E01 1y: UI-action methods are exactly ui.* / window.*
test('1y: app.launch is NOT a ui_action: the ui_action builder refuses it, validateEvent rejects an app.launch ui_action display, and it builds and validates as kind tool', () => {
  assert.equal(uiActionDisplay({ category: 'local_change', method: 'app.launch', appName: 'Notepad', windowTitle: 'Notepad', processImage: 'notepad.exe' }), null);
  const ok = uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'Notepad', windowTitle: 'Notepad', processImage: 'notepad.exe' })!;
  assert.equal(reqEnv(ok).ok, true);
  assert.equal(reqEnv({ ...ok, [K.method]: 'app.launch' }).ok, false, 'app.launch through a ui_action display');
  assert.equal(reqEnv({ ...ok, [K.method]: 'app.terminate' }).ok, false);
  for (const m of ['ui.click', 'ui.type', 'window.focus', 'window.move', 'window.minimize', 'window.maximize']) assert.equal(reqEnv({ ...ok, [K.method]: m }).ok, true, m);
  const tool = toolDisplay({ category: 'local_change', method: 'app.launch', targetLabel: 'Open Notepad', fields: { targets: ['C:\\WINDOWS\\NOTEPAD.EXE'] } })!;
  assert.ok(tool);
  assert.equal(reqEnv(tool).ok, true, 'app.launch as kind tool from tool_host');
  assert.equal(reqEnv(tool, { requestSource: 'codex' }).ok, false, 'kind/source guard still applies');
});

test('vendored E02 files are unedited: SHA-256 of each matches SHA256SUMS, git blob ids are 45129fe\'s (and NOTICE names 45129fe)', () => {
  const dir = new URL('../../src/vendor/e02-contracts/', import.meta.url);
  const check = (sums: URL, base: URL) => {
    const lines = readFileSync(sums, 'utf8').trim().split('\n');
    assert.ok(lines.length > 0);
    for (const l of lines) {
      const [hex, name] = l.split(/\s+/);
      assert.equal(createHash('sha256').update(readFileSync(new URL(name as string, base))).digest('hex'), hex as string, name as string);
    }
    return lines.length;
  };
  assert.equal(check(new URL('SHA256SUMS', dir), dir), 3);
  const fx = new URL('../../test/fixtures/e02/', import.meta.url);
  assert.equal(check(new URL('SHA256SUMS', fx), fx), 1);
  const ev = new URL('../../test/fixtures/e02/events/invalid/', import.meta.url);
  assert.equal(check(new URL('SHA256SUMS', ev), ev), 5);
  assert.match(readFileSync(new URL('NOTICE.md', dir), 'utf8'), /45129fe9b9e6ab98d009c88620a3cc2183ef9b43/);
  // git blob ids = `git rev-parse 45129fe:packages/contracts/src/<file>`
  const blobs: Record<string, string> = { 'canonical.ts': '3bf7343e6e00877b5634794bc5a937ba7cd6a99c', 'display.ts': '6c9091e788cf627914c314fceeed4e2e52645765', 'enums.ts': '48e25aadf78b5dbe8022a241d69af75bde92f6cd' };
  for (const [f, b] of Object.entries(blobs)) assert.equal(gitBlob(readFileSync(new URL(f, dir))), b, `${f}: blob`);
});

test('builders end with E02\'s validator: a ui_action whose processImage is a path (not a basename) is display_unavailable (null), as E02 rules', () => {
  assert.equal(uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'Notepad', windowTitle: 'notes', processImage: 'C:\\Windows\\notepad.exe' }), null);
  assert.ok(uiActionDisplay({ category: 'local_change', method: 'window.close', appName: 'Notepad', windowTitle: 'notes', processImage: 'notepad.exe' }));
  assert.equal(uiActionDisplay({ category: 'read', method: 'window.close', appName: 'Notepad', windowTitle: 'notes', processImage: 'notepad.exe' }), null, 'read has no display rule');
});
