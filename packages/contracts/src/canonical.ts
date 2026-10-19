/**
 * The ONE canonicaliser for Dottie hashes (ADR-0009 CR2, CONTRACTS §3.3) and actionId. Owner E02; E03's IdSource,
 * the E02 approvals bridge and the Python packages (via fixtures/action-id/vectors.json) all use these rules.
 *
 * canonicalJson(v):
 * - UTF-8, no whitespace, object keys sorted by Unicode code point, recursively (= Python sort_keys=True); array
 *   order kept; strings escaped minimally (JSON.stringify = Python json.dumps(ensure_ascii=False)).
 * - Scalar leaves (E01 2026-10-19): every scalar leaf becomes a string or null. Booleans → "true"/"false".
 *   Numbers (E08 follow-up 7): INTEGERS ONLY, as decimal strings with no leading zeros or exponent; NaN, ±Infinity,
 *   -0, non-integers and integers beyond ±(2^53-1) are rejected (bigint allowed). Rejected, never coerced:
 *   undefined, functions, symbols, symbol keys, non-plain objects, sparse arrays, lone surrogates.
 * - Duplicate JSON keys can't exist in a JS object; raw JSON text must be checked with hasDuplicateKeys() first.
 *
 * actionId = lowercase-hex SHA-256 of canonicalJson({purpose:"dottie.actionId.v1", method, args, targets, taskId,
 * threadId, turnId, itemId, requestId}); every key present, null when it doesn't apply; missing/extra keys or a
 * wrong purpose are rejected. Path-valued args MUST be passed through canonicalPath() first (E08 follow-up 8).
 *
 * canonicalPath(raw, {platform}) (E08 follow-up 8):
 * - win32: '/' → '\'; strip `\\?\` (and `\\?\UNC\srv\share` → `\\srv\share`); other device namespaces (`\\.\`,
 *   `\??\`) refused; only absolute drive (`C:\`) or UNC (`\\srv\share`) paths; `.`/`..` resolved and may not climb
 *   above the root; 8.3 short components (`~<digit>`) expanded through the injected expander (GetLongPathNameW in
 *   production) and refused when they can't be; ADS (`:`), reserved device names (CON, NUL, COM1, …), components
 *   ending in a dot or space and `<>"|?*` refused; repeated and trailing separators dropped (the drive root keeps its
 *   `\`); case folded per code point with the simple 1:1 uppercase mapping (NTFS upcase-table semantics; a mapping
 *   that would change the length keeps the original code point). No Unicode normalisation.
 * - posix: absolute only; `.`/`..` resolved; repeated and trailing `/` dropped; case preserved.
 * A spelling it can't canonicalise is an error (INVALID_ARGUMENT): the caller declines and the user is asked again.
 * A difference it doesn't fold gives a different actionId, i.e. a re-prompt, never a bypass.
 */
import { createHash } from 'node:crypto';
import { APPROVAL_CATEGORIES, PRIOR_SIDE_EFFECTS, REQUEST_SOURCES, RISK_SEVERITIES, type ApprovalCategory, type PriorSideEffect, type RequestSource, type Risk } from './enums.js';
import { computeDisplayHash, preDispatchDisplay } from './display.js';
import { posix } from 'node:path';

export class CanonicalError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;
  override readonly name = 'CanonicalError';
}

export const ACTION_ID_PURPOSE = 'dottie.actionId.v1';
/** Sorted key set of the hashed action object. */
/** CR2 preimage keys; `displayHash` joined with ruling 1k/1l (E01 e93907c). */
export const ACTION_ID_KEYS = ['args', 'displayHash', 'itemId', 'method', 'purpose', 'requestId', 'requestSource', 'targets', 'taskId', 'threadId', 'turnId'] as const;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function byCodePoint(a: string, b: string): number {
  const ai = [...a];
  const bi = [...b];
  for (let i = 0; i < Math.min(ai.length, bi.length); i++) {
    const d = (ai[i] as string).codePointAt(0)! - (bi[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

function quote(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new CanonicalError('lone surrogate');
  return JSON.stringify(s);
}

/** Canonical decimal form of an integer (E08 follow-up 7), or a CanonicalError. */
export function canonicalInteger(n: number | bigint): string {
  if (typeof n === 'bigint') return n.toString(10);
  if (Number.isNaN(n)) throw new CanonicalError('NaN');
  if (!Number.isFinite(n)) throw new CanonicalError('non-finite number');
  if (Object.is(n, -0)) throw new CanonicalError('negative zero');
  if (!Number.isInteger(n)) throw new CanonicalError('non-integer number');
  if (!Number.isSafeInteger(n)) throw new CanonicalError('integer beyond 2^53-1');
  return String(n);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return quote(value);
    case 'boolean':
      return quote(value ? 'true' : 'false');
    case 'number':
    case 'bigint':
      return quote(canonicalInteger(value));
    case 'object': {
      if (Array.isArray(value)) {
        const out: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!hasOwn(value, i)) throw new CanonicalError('sparse array');
          out.push(canonicalJson(value[i]));
        }
        return `[${out.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError('non-plain object');
      if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalError('symbol key');
      const keys = Object.keys(value).sort(byCodePoint);
      return `{${keys.map((k) => `${quote(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    default:
      throw new CanonicalError(`unsupported value: ${typeof value}`);
  }
}

/**
 * true when any JSON object in `text` repeats a key (after unescaping). JSON.parse silently keeps the last one, which
 * would let a request show one value and hash another (ADR-0009 CR2: rejected). `text` must be valid JSON.
 */
export function hasDuplicateKeys(text: string): boolean {
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top) top.expectKey = true;
    }
  }
  return false;
}

/**
 * actionId preimage minus `purpose` (field names identical to E03's ActionIdBinding, coordinator ports.ts 886b251).
 * computeActionId also accepts E03's full binding: `purpose`, when present, must be exactly dottie.actionId.v1.
 * Any other key is rejected (a misspelt field must not be silently ignored).
 *
 * §2.1 pre-dispatch confirmation: see preDispatchBinding(). Gated tool calls (navigate, ruling 1d): see toolCallBinding().
 */
export interface ActionBinding {
  /** Tool id, or the server-request method. */
  readonly method: string;
  /** Resolved absolute args; path values already canonicalPath()-ed. */
  readonly args: unknown;
  /** E.g. the resolved WindowIdentity for desktop tools; null when none. */
  readonly targets: unknown;
  readonly taskId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly requestId: string | null;
  /**
   * SHA-256 of the canonical ApprovalDisplay (computeDisplayHash) for every call that opens a dialog; null ONLY for a
   * gated call with no dialog (navigate). See displayHashGuard (ruling 1l).
   */
  readonly displayHash: string | null;
  /** Ruling 1r (E08 guard, CONTRACTS 819b30d): next to displayHash; `coordinator` exactly for the pre-dispatch method. */
  readonly requestSource: RequestSource;
}

/**
 * A plain data object (E03 report, 2026-10-19): prototype Object.prototype or null, no symbol keys, and every own key
 * an enumerable DATA property (no getters/setters, nothing non-enumerable). Inherited fields
 * (`Object.create({kind, ...})`), class instances, arrays, Maps, Dates and boxed values are not plain. A JSON-parsed
 * `"__proto__"` key is an ordinary own data property (JSON.parse does not set the prototype). The validators therefore
 * see it as an unknown key, and it never pollutes a prototype. The validators use this together with `hasOwn` for
 * every required/allowed key check, so what they accept is exactly what canonicalJson hashes.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(v).length > 0) return false;
  for (const k of Object.getOwnPropertyNames(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (d === undefined || !d.enumerable || !hasOwn(d, 'value')) return false;
  }
  return true;
}
/**
 * A plain data array: prototype Array.prototype, dense (no holes, which forEach would skip and canonicalJson rejects),
 * and no own keys besides the indices and `length`; every index is an enumerable data property.
 */
export function isPlainArray(v: unknown): v is unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(v).length > 0) return false;
  const names = Object.getOwnPropertyNames(v);
  if (names.length !== v.length + 1) return false;
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, i);
    if (d === undefined || !d.enumerable || !hasOwn(d, 'value')) return false;
  }
  return true;
}
/** Own-property test that works for null-prototype objects and ignores inherited keys (`Object.hasOwn`). */
export const hasOwn = (o: object, k: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The exact object hashed for an actionId: every key present (null when it doesn't apply) plus `purpose`. */
export const PRE_DISPATCH_CONFIRMATION_METHOD = 'dottie.pre_dispatch_confirmation';

export function actionIdObject(b: ActionBinding & { readonly purpose?: typeof ACTION_ID_PURPOSE }): Record<string, unknown> {
  if (!isPlainObject(b)) throw new CanonicalError('binding is not a plain object');
  for (const k of Object.keys(b)) if (!(ACTION_ID_KEYS as readonly string[]).includes(k)) throw new CanonicalError(`unknown binding key ${k}`);
  if (hasOwn(b, 'purpose') && b.purpose !== ACTION_ID_PURPOSE) throw new CanonicalError('wrong purpose');
  const o: Record<string, unknown> = {
    purpose: ACTION_ID_PURPOSE,
    method: b.method,
    args: b.args,
    targets: b.targets,
    taskId: b.taskId,
    threadId: b.threadId,
    turnId: b.turnId,
    itemId: b.itemId,
    requestId: b.requestId,
    displayHash: b.displayHash,
    requestSource: b.requestSource,
  };
  for (const k of ACTION_ID_KEYS) if (o[k] === undefined) throw new CanonicalError(`missing ${k}`);
  if (typeof b.method !== 'string' || b.method === '') throw new CanonicalError('method must be a non-empty string');
  if (typeof b.taskId !== 'string' || b.taskId === '') throw new CanonicalError('taskId must be a non-empty string');
  if (b.displayHash !== null && (typeof b.displayHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.displayHash))) {
    throw new CanonicalError('displayHash must be a lowercase-hex SHA-256 or null');
  }
  // E01 ruling 1q: the top-level displayHash is authoritative on every call. A pre-dispatch confirmation also binds it
  // inside args (the six-key §2.1 list) and the two must be byte-equal; a generic gated call never has it in args.
  const argsObj = typeof b.args === 'object' && b.args !== null && !Array.isArray(b.args) ? (b.args as Record<string, unknown>) : null;
  const inArgs = argsObj !== null && Object.prototype.hasOwnProperty.call(argsObj, 'displayHash');
  if (!(REQUEST_SOURCES as readonly unknown[]).includes(b.requestSource)) throw new CanonicalError(`requestSource must be one of ${REQUEST_SOURCES.join('|')}`);
  if ((b.method === PRE_DISPATCH_CONFIRMATION_METHOD) !== (b.requestSource === 'coordinator')) {
    throw new CanonicalError("requestSource 'coordinator' exactly for method dottie.pre_dispatch_confirmation (ruling 1r)");
  }
  if (b.method === PRE_DISPATCH_CONFIRMATION_METHOD) {
    if (!inArgs || argsObj!['displayHash'] !== b.displayHash) throw new CanonicalError('pre-dispatch args.displayHash must equal the top-level displayHash (ruling 1q)');
  } else if (inArgs) {
    throw new CanonicalError('a generic gated call never carries displayHash in args; it is top-level only (ruling 1q)');
  }
  for (const k of ['threadId', 'turnId', 'itemId', 'requestId'] as const) {
    const v = b[k];
    if (v !== null && (typeof v !== 'string' || v === '')) throw new CanonicalError(`${k} must be a non-empty string or null`);
  }
  return o;
}

/** Rejects a canonical action object with a missing or extra key or a wrong `purpose`. */
export function checkActionIdObject(o: unknown): asserts o is Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new CanonicalError('not an object');
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== [...ACTION_ID_KEYS].join(',')) throw new CanonicalError('wrong key set');
  if ((o as Record<string, unknown>)['purpose'] !== ACTION_ID_PURPOSE) throw new CanonicalError('wrong purpose');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** actionId of an already-built action object (checked: key set and purpose). */
export function actionIdOf(o: Record<string, unknown>): string {
  checkActionIdObject(o);
  return sha256Hex(canonicalJson(o));
}

export function computeActionId(b: ActionBinding & { readonly purpose?: typeof ACTION_ID_PURPOSE }): string {
  return actionIdOf(actionIdObject(b));
}

// ------------------------------------------------------------------ §2.1 pre-dispatch confirmation (D14 final ruling)
/**
 * Preimage args (CONTRACTS §2.1 at E01 e93907c): `{summary, risk, category, possibleRepeat, retryOfTaskId, displayHash}`,
 * both D14 keys ALWAYS present; displayHash is the pre-dispatch display's hash, so `summary` is bound twice (arg + display). `possibleRepeat` is the
 * prior side effect STRING (not the event's object) or null; `retryOfTaskId` is the retried task id or null.
 * Their pairing (possibleRepeat.priorTaskId = retryOfTaskId) is a coordinator-only invariant (E01 ruling 1f), not
 * checked here.
 */
export interface PreDispatchArgs {
  readonly summary: string;
  readonly risk: Risk;
  readonly category: ApprovalCategory;
  readonly possibleRepeat: PriorSideEffect | null;
  readonly retryOfTaskId: string | null;
  /** computeDisplayHash(preDispatchDisplay(...)) over the values above (ruling 1k/1l). */
  readonly displayHash: string;
}
export const PRE_DISPATCH_ARGS_KEYS = ['summary', 'risk', 'category', 'possibleRepeat', 'retryOfTaskId', 'displayHash'] as const;
/** Inputs the caller supplies; displayHash is always computed here. */
const PRE_DISPATCH_INPUT_KEYS = ['summary', 'risk', 'category', 'possibleRepeat', 'retryOfTaskId'] as const;

/** Build the args with both D14 keys present (null when absent). Throws CanonicalError on any bad value. */
export function preDispatchArgs(a: {
  readonly summary: string;
  readonly risk: Risk;
  readonly category: ApprovalCategory;
  readonly possibleRepeat?: PriorSideEffect | null;
  readonly retryOfTaskId?: string | null;
}): PreDispatchArgs {
  if (typeof a !== 'object' || a === null) throw new CanonicalError('pre-dispatch args are not an object');
  for (const k of Object.keys(a)) if (!(PRE_DISPATCH_INPUT_KEYS as readonly string[]).includes(k)) throw new CanonicalError(`unknown pre-dispatch arg ${k}`);
  const out: Omit<PreDispatchArgs, 'displayHash'> = {
    summary: a.summary,
    risk: a.risk,
    category: a.category,
    possibleRepeat: a.possibleRepeat ?? null,
    retryOfTaskId: a.retryOfTaskId ?? null,
  };
  if (typeof out.summary !== 'string') throw new CanonicalError('summary must be a string');
  if (!(RISK_SEVERITIES as readonly unknown[]).includes(out.risk)) throw new CanonicalError('risk must be a §3 risk severity');
  if (!(APPROVAL_CATEGORIES as readonly unknown[]).includes(out.category)) throw new CanonicalError('category must be a §3 approval category');
  if (out.possibleRepeat !== null && !(PRIOR_SIDE_EFFECTS as readonly unknown[]).includes(out.possibleRepeat)) {
    throw new CanonicalError(`possibleRepeat must be one of ${PRIOR_SIDE_EFFECTS.join('|')} or null`);
  }
  if (out.retryOfTaskId !== null && (typeof out.retryOfTaskId !== 'string' || out.retryOfTaskId === '')) throw new CanonicalError('retryOfTaskId must be a non-empty string or null');
  if (out.possibleRepeat !== null && (out.category === 'read' || out.category === 'navigate')) {
    throw new CanonicalError(`possibleRepeat is never set with category '${out.category}' (ruling 1g)`);
  }
  return { ...out, displayHash: computeDisplayHash(preDispatchDisplay(out)) };
}

/**
 * The §2.1 binding: method 'dottie.pre_dispatch_confirmation', requestId set, turnId = the coordinator-minted turnId
 * (`<taskId>.t1` for the first turn), threadId/itemId/targets null.
 */
export function preDispatchBinding(b: {
  readonly taskId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly args: Parameters<typeof preDispatchArgs>[0];
}): ActionBinding {
  if (typeof b.turnId !== 'string' || b.turnId === '') throw new CanonicalError('pre-dispatch turnId must be the coordinator-minted turnId');
  if (typeof b.requestId !== 'string' || b.requestId === '') throw new CanonicalError('pre-dispatch requestId must be set');
  const args = preDispatchArgs(b.args);
  return {
    method: PRE_DISPATCH_CONFIRMATION_METHOD,
    args,
    targets: null,
    taskId: b.taskId,
    threadId: null,
    turnId: b.turnId,
    itemId: null,
    requestId: b.requestId,
    displayHash: args.displayHash,
    requestSource: 'coordinator',
  };
}

// ------------------------------------------------------------------ gated tool calls (DOT-092 ruling 1d)
/**
 * Preimage for navigate and other non-approval gated calls: method = toolId, args = the schema-validated args as they
 * will execute (navigate: only the `folder` enum value), targets null, every other id present (null where unknown).
 * AuthorizeToolCallParams.actionId and CheckPolicyParams.actionId carry this hash; if it can't be computed the call is
 * DENIED_BY_POLICY with sideEffect 'none'.
 */
export function toolCallBinding(b: {
  readonly toolId: string;
  readonly args: unknown;
  readonly taskId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly requestId: string | null;
  /** computeDisplayHash(display) when the call opens a dialog; null for no-dialog calls (navigate). */
  readonly displayHash: string | null;
}): ActionBinding {
  if (typeof b.toolId !== 'string' || !/^[a-z][a-z0-9]*(_[a-z0-9]+)*\.[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(b.toolId)) throw new CanonicalError('toolId must be area.verb_object');
  return { method: b.toolId, args: b.args, targets: null, taskId: b.taskId, threadId: b.threadId, turnId: b.turnId, itemId: b.itemId, requestId: b.requestId, displayHash: b.displayHash, requestSource: 'tool_host' };
}

// ------------------------------------------------------------------ paths (E08 follow-up 8)
export type PathPlatform = 'win32' | 'posix';
export interface PathCanonOptions {
  readonly platform: PathPlatform;
  /** Long form of a path containing 8.3 components (GetLongPathNameW), or undefined when it can't be expanded. */
  readonly expandShortName?: (path: string) => string | undefined;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const SHORT_COMPONENT = /~[0-9]/;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const UNC_ROOT = /^\\\\[^\\]+\\[^\\]+/;

function stripPrefix(p: string): string {
  const s = p.replace(/\//g, '\\');
  if (/^\\\\\?\\unc\\/i.test(s)) return `\\\\${s.slice(8)}`;
  if (s.startsWith('\\\\?\\')) return s.slice(4);
  if (s.startsWith('\\\\.\\') || s.startsWith('\\??\\')) throw new CanonicalError('device namespace path');
  return s;
}

function winNormalize(p: string): string {
  const s = stripPrefix(p);
  const drive = /^[a-zA-Z]:\\/.test(s);
  const unc = UNC_ROOT.test(s);
  if (!drive && !unc) throw new CanonicalError('not an absolute drive or UNC path');
  // Resolve '.'/'..' here (not path.win32.normalize, which clamps) so a '..' that climbs above the root is refused.
  const root = drive ? s.slice(0, 3) : (UNC_ROOT.exec(s)?.[0] as string);
  const parts: string[] = [];
  for (const c of s.slice(root.length).split('\\')) {
    if (c === '' || c === '.') continue;
    if (c === '..') {
      if (parts.length === 0) throw new CanonicalError('.. above the root');
      parts.pop();
      continue;
    }
    if (c.includes(':')) throw new CanonicalError('alternate data stream');
    if (/[. ]$/.test(c)) throw new CanonicalError('component ends in a dot or space');
    if (RESERVED.test(c)) throw new CanonicalError('reserved device name');
    if (/[<>"|?*]/.test(c)) throw new CanonicalError('invalid character');
    parts.push(c);
  }
  const head = drive ? root : `${root}\\`;
  return parts.length === 0 ? root : `${head}${parts.join('\\')}`;
}

/** NTFS-style fold: simple 1:1 uppercase per code point; a length-changing mapping keeps the code point. */
function foldCase(s: string): string {
  let out = '';
  for (const ch of s) {
    const u = ch.toUpperCase();
    out += [...u].length === 1 ? u : ch;
  }
  return out;
}

export function canonicalPath(raw: unknown, options: PathCanonOptions): string {
  if (typeof raw !== 'string' || raw === '' || CONTROL.test(raw)) throw new CanonicalError('empty path or control characters');
  if (LONE_SURROGATE.test(raw)) throw new CanonicalError('lone surrogate');
  if (options.platform === 'posix') {
    if (!raw.startsWith('/')) throw new CanonicalError('not absolute');
    const n = posix.normalize(raw);
    return n.length > 1 ? n.replace(/\/+$/, '') : n;
  }
  let n = winNormalize(raw);
  if (n.split('\\').some((c) => SHORT_COMPONENT.test(c))) {
    const long = options.expandShortName?.(n);
    if (long === undefined) throw new CanonicalError('8.3 short name could not be expanded');
    n = winNormalize(long);
    // A name may legitimately contain "~1" in its LONG form; accept only if the expander says it is already long.
    if (n.split('\\').some((c) => SHORT_COMPONENT.test(c)) && options.expandShortName?.(n) !== n) {
      throw new CanonicalError('8.3 short name still present after expansion');
    }
  }
  return foldCase(n);
}
