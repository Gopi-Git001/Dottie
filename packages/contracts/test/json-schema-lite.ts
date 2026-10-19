/**
 * Minimal JSON Schema 2020-12 evaluator for the keywords scripts/json-schemas.mjs emits (no dependency). Any other
 * keyword throws, so a generator change can't silently weaken the sync check. Cross-checked against Python
 * `jsonschema` by scripts/check_records_schemas.py.
 */
type Schema = boolean | { readonly [k: string]: unknown };
const ANNOTATIONS = new Set(['$schema', '$id', 'title', '$comment', 'description', '$defs']);
const KNOWN = new Set([...ANNOTATIONS, 'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'not', 'properties', 'required',
  'additionalProperties', 'propertyNames', 'items', 'uniqueItems', 'minimum', 'if', 'then', 'else', 'allOf', '$ref']);

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => equal(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort();
  return equal(ka, kb) && ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: throw new Error(`unknown type ${t}`);
  }
}
const codePoints = (s: string) => [...s].length;

export function valid(root: Schema, value: unknown): boolean {
  const resolve = (ref: string): Schema => {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
    if (!m || typeof root !== 'object') throw new Error(`unsupported $ref ${ref}`);
    const d = (root['$defs'] as Record<string, Schema> | undefined)?.[m[1]!];
    if (d === undefined) throw new Error(`dangling $ref ${ref}`);
    return d;
  };
  const ev = (s: Schema, v: unknown): boolean => {
    if (s === true) return true;
    if (s === false) return false;
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`json-schema-lite: unsupported keyword ${k}`);
    if (s['$ref'] !== undefined && !ev(resolve(s['$ref'] as string), v)) return false;
    if (s['type'] !== undefined) {
      const ts = Array.isArray(s['type']) ? (s['type'] as string[]) : [s['type'] as string];
      if (!ts.some((t) => typeOk(t, v))) return false;
    }
    if (Object.hasOwn(s, 'const') && !equal(s['const'], v)) return false;
    if (s['enum'] !== undefined && !(s['enum'] as unknown[]).some((e) => equal(e, v))) return false;
    if (typeof v === 'string') {
      if (s['pattern'] !== undefined && !new RegExp(s['pattern'] as string, 'u').test(v)) return false;
      if (s['minLength'] !== undefined && codePoints(v) < (s['minLength'] as number)) return false;
      if (s['maxLength'] !== undefined && codePoints(v) > (s['maxLength'] as number)) return false;
    }
    if (typeof v === 'number' && s['minimum'] !== undefined && v < (s['minimum'] as number)) return false;
    if (Array.isArray(v)) {
      if (s['items'] !== undefined && !v.every((x) => ev(s['items'] as Schema, x))) return false;
      if (s['uniqueItems'] === true && v.some((x, i) => v.slice(i + 1).some((y) => equal(x, y)))) return false;
    }
    if (typeOk('object', v)) {
      const o = v as Record<string, unknown>;
      if (s['required'] !== undefined && !(s['required'] as string[]).every((k) => Object.hasOwn(o, k))) return false;
      const props = (s['properties'] ?? {}) as Record<string, Schema>;
      for (const [k, x] of Object.entries(o)) {
        if (Object.hasOwn(props, k)) {
          if (!ev(props[k]!, x)) return false;
        } else if (s['additionalProperties'] !== undefined && !ev(s['additionalProperties'] as Schema, x)) return false;
      }
    }
    if (typeOk('object', v) && s['propertyNames'] !== undefined && !Object.keys(v as object).every((k) => ev(s['propertyNames'] as Schema, k))) return false;
    if (s['not'] !== undefined && ev(s['not'] as Schema, v)) return false;
    if (s['allOf'] !== undefined && !(s['allOf'] as Schema[]).every((x) => ev(x, v))) return false;
    if (s['if'] !== undefined) {
      const branch = ev(s['if'] as Schema, v) ? s['then'] : s['else'];
      if (branch !== undefined && !ev(branch as Schema, v)) return false;
    }
    return true;
  };
  return ev(root, value);
}
