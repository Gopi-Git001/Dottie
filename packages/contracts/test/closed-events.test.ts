// E01 ruling 2i: internal Dottie events are closed. The envelope and every payload object (nested objects, objects in
// arrays, the bound display and its app) reject unknown keys, prototype member names included, and never throw.
// Table-driven over every event type, using every valid fixture.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EVENT_TYPES, validateEvent } from '../src/index.js';
import { RESERVED_KEY_NAMES } from '../src/validate.js';

const DIR = fileURLToPath(new URL('../../fixtures/events/valid/', import.meta.url));
const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ f, ev: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Record<string, unknown> }));
/** Object.prototype member names (constructor, toString, hasOwnProperty, __proto__, __defineGetter__, ...). */
export const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype);
const KEYS = ['zzUnknownKey', ...PROTO_NAMES];
type Path = (string | number)[];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Every object node: [path segments, dotted issue path]. */
function nodes(v: unknown, path: Path = []): Path[] {
  const out: Path[] = [];
  if (isObj(v)) {
    out.push(path);
    for (const [k, x] of Object.entries(v)) out.push(...nodes(x, [...path, k]));
  } else if (Array.isArray(v)) v.forEach((x, i) => out.push(...nodes(x, [...path, i])));
  return out;
}
const issuePath = (p: Path) => p.reduce<string>((s, seg) => (typeof seg === 'number' ? `${s}[${seg}]` : s ? `${s}.${seg}` : seg), '');
/** Deep clone, then add an OWN data property (works for __proto__ too: defineProperty never sets the prototype). */
function inject(ev: unknown, path: Path, key: string): unknown {
  const c = JSON.parse(JSON.stringify(ev)) as unknown;
  let n = c as Record<string | number, unknown>;
  for (const seg of path) n = n[seg] as Record<string | number, unknown>;
  Object.defineProperty(n, key, { value: 'x', enumerable: true, writable: true, configurable: true });
  return c;
}

test('the reserved key list covers every Object.prototype member name of this runtime', () => {
  assert.deepEqual(PROTO_NAMES.filter((k) => !RESERVED_KEY_NAMES.has(k)), []);
});

test('the open maps stay open for ordinary keys (contract), closed for prototype names', () => {
  const TP = fixtures.find((x) => x.ev['type'] === 'TaskProgress' && Object.hasOwn((x.ev['payload'] ?? {}) as object, 'redactedMetadata'))!.ev as { payload: { redactedMetadata: Record<string, unknown> } };
  assert.equal(validateEvent({ ...TP, payload: { ...TP.payload, redactedMetadata: { ...TP.payload.redactedMetadata, stepCount: 3 } } }).ok, true);
  const TR = fixtures.find((x) => x.f === 'tool-result-ambiguous.json')!.ev as { payload: { observedState: Record<string, unknown> & { checks: Record<string, unknown> } } };
  assert.equal(validateEvent({ ...TR, payload: { ...TR.payload, observedState: { ...TR.payload.observedState, windowCount: 2, checks: { ...TR.payload.observedState.checks, extraCheck: 'pass' } } } }).ok, true);
  for (const k of ['constructor', 'toString']) {
    const r = validateEvent({ ...TP, payload: { ...TP.payload, redactedMetadata: { ...TP.payload.redactedMetadata, [k]: 1 } } });
    assert.ok(!r.ok && r.issues.some((i) => i.path === `payload.redactedMetadata.${k}` && /reserved/.test(i.message)));
    // A VALID value under a prototype name: only the reserved-name rule can reject these.
    const s = validateEvent({ ...TR, payload: { ...TR.payload, observedState: { ...TR.payload.observedState, [k]: 2 } } });
    assert.ok(!s.ok && s.issues.some((i) => i.path === `payload.observedState.${k}` && /reserved/.test(i.message)), `observedState.${k}`);
    const c = validateEvent({ ...TR, payload: { ...TR.payload, observedState: { ...TR.payload.observedState, checks: { ...TR.payload.observedState.checks, [k]: 'pass' } } } });
    assert.ok(!c.ok && c.issues.some((i) => i.path === `payload.observedState.checks.${k}` && /reserved/.test(i.message)), `checks.${k}`);
  }
});

test('every event type has a valid fixture here', () => {
  const types = new Set(fixtures.map((x) => x.ev['type']));
  assert.deepEqual(EVENT_TYPES.filter((t) => !types.has(t)), []);
  for (const { f, ev } of fixtures) assert.equal(validateEvent(ev).ok, true, f);
});

for (const type of EVENT_TYPES) {
  test(`ruling 2i: ${type}: an unknown or prototype-named key at any object level is rejected there, without throwing`, () => {
    let checked = 0;
    for (const { f, ev } of fixtures.filter((x) => x.ev['type'] === type)) {
      for (const p of nodes(ev)) {
        // Open by contract (CONTRACTS §5 ObservedState "may also hold tool-specific scalar keys", checks map, §3.2
        // RedactedMetadata): new scalar keys are allowed there, prototype member names never.
        const open = /(observedState|observedState\.checks|redactedMetadata)$/.test(issuePath(p));
        for (const key of open ? PROTO_NAMES : KEYS) {
          const bad = inject(ev, p, key);
          let r: ReturnType<typeof validateEvent>;
          assert.doesNotThrow(() => { r = validateEvent(bad); }, `${f} ${issuePath(p)}.${key}: threw`);
          r = validateEvent(bad);
          const at = issuePath([...p, key]);
          assert.equal(r.ok, false, `${f}: ${at} accepted`);
          assert.ok(!r.ok && r.issues.some((i) => i.path === at), `${f}: no issue at ${at}: ${JSON.stringify(!r.ok && r.issues)}`);
          checked++;
        }
      }
      // A JSON-parsed "__proto__" key is an own key, never the prototype: same result.
      const parsed = JSON.parse(JSON.stringify(ev).replace(/^\{/, '{"__proto__":{"type":"x"},')) as unknown;
      assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
      const r = validateEvent(parsed);
      assert.ok(!r.ok && r.issues.some((i) => i.path === '__proto__'), f);
    }
    assert.ok(checked > 0);
  });
}
