/**
 * Bound approval display (CONTRACTS §3 "Bound approval display, X5", E01 rulings 1k/1l/1m/1o/1q; 1r relayed).
 *
 * ApprovalDisplay is a discriminated union on a REQUIRED `kind` (E01 1r, relayed; not yet in E01 HEAD dd082ec):
 * 'tool' | 'ui_action' | 'codex_command' | 'codex_file_change' | 'pre_dispatch'. displayHash covers `kind`.
 *
 * Key names settled by E01 ruling 1v (as at 3029c7b: `summaryUntrusted` stays; ui_action has no targetLabel); every key lives in
 * DISPLAY_KEYS, so a rename is one edit here. Values are canonical (§3.3): strings, null, arrays of strings or nested
 * objects of those; booleans and counts are encoded as strings.
 *
 * Built only from coordinator state or the adapter's validated request params; model text is never a structured field
 * and free text sits only in a slot whose key says it is untrusted.
 */
import * as e02 from './vendor/e02-contracts/display.js';

export const DISPLAY_KEYS = {
  kind: 'kind',
  category: 'category',
  // pre_dispatch
  risk: 'risk',
  possibleRepeat: 'possibleRepeat',
  retryOfTaskId: 'retryOfTaskId',
  summary: 'summaryUntrusted',
  // tool / ui_action
  method: 'method',
  targetLabel: 'targetLabel',
  app: 'app',
  appName: 'appName',
  windowTitle: 'windowTitle',
  processImage: 'processImage',
  // codex_command / codex_file_change
  commandLine: 'commandLine',
  workingDirectory: 'workingDirectory',
  networkAccess: 'networkAccess',
  escalation: 'escalation',
  paths: 'paths',
  fileCount: 'fileCount',
  reason: 'reasonUntrusted',
} as const;

export const DISPLAY_KINDS = ['tool', 'ui_action', 'codex_command', 'codex_file_change', 'pre_dispatch'] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];
export const NETWORK_ACCESS_VALUES = ['requested', 'not_requested'] as const;
/** E01 1r: who raised the approval; set only by the coordinator from its own state (never adapter, model or host input). */
export const REQUEST_SOURCES = ['codex', 'tool_host', 'coordinator'] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];
/** E01 1r kind/source guard: the only requestSource each display kind may come with. */
export const KIND_SOURCE: Readonly<Record<DisplayKind, RequestSource>> = {
  codex_command: 'codex', codex_file_change: 'codex', tool: 'tool_host', ui_action: 'tool_host', pre_dispatch: 'coordinator',
};
/**
 * Settled, E01 1y (c0b36d4): UI-action methods are `ui.*` (in-app control: click, type, key press, UIA invoke) and
 * `window.*` (focus/close/move/minimize/maximize). `app.*` (launch/terminate) is NOT a UI action: kind `tool`.
 * E01 1z (492c01c): exactly ^(ui|window)\.[a-z][a-z0-9_]*$, so a bare `ui.`/`window.`, uppercase, a leading digit or
 * any other character is not a UI-action method. The vendored E02 check (0146c90) is used as-is.
 */
export const UI_ACTION_METHOD_RE: RegExp = e02.UI_ACTION_METHOD_RE;
export const isUiActionMethod = (method: unknown): boolean => e02.isUiActionMethod(method);
/**
 * E01 1y prefix rule + follow-up (E02 0146c90): the `ui.`/`window.` namespace belongs to kind ui_action only; kind
 * `tool` rejects ANY method with that prefix, in ANY case (`UI.x`, `Window.close`, `ui.Click`, `window.`, and the
 * valid `ui.click` too). Used by toolDisplay and validateEvent.
 */
export const UI_ACTION_PREFIX_RE = /^(ui|window)\./i;
export const hasUiActionPrefix = (method: unknown): boolean => typeof method === 'string' && UI_ACTION_PREFIX_RE.test(method);
/**
 * Prototype-key hardening: a display (and its nested `app`) must be a plain JSON-like object whose fields are its OWN
 * properties (prototype Object.prototype or null). An object with inherited fields would pass an `in` / index check
 * but canonicalise (and hash) as its own keys only, so it is refused before any validation or hashing.
 */
export function plainOwnDisplay(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v).every(x => typeof x !== 'object' || x === null || Array.isArray(x) || plainOwnDisplay(x));
}
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
/**
 * E02 FINAL never-cut bounds (E01 1o/1r/1v): over any of them the display can't be built → display_unavailable
 * (declined, no dialog). Bytes are raw UTF-8 bytes; escalation entries and method are counted in Unicode code points.
 * `method` is bound and never cut (E02 cc22afb 2a addition; E01 2b): a cut `ui.mmm…` would break the 1z regex.
 */
export const DISPLAY_HARD_LIMITS = {
  commandLineBytes: 8192,
  paths: 500,
  pathBytes: 4096,
  workingDirectoryBytes: 4096,
  escalationEntries: 32,
  escalationChars: 256,
  methodCodePoints: 64,
} as const;
export const MAX_COMMAND_BYTES = DISPLAY_HARD_LIMITS.commandLineBytes;
export const MAX_PATHS = DISPLAY_HARD_LIMITS.paths;
/**
 * CONTRACTS §3 Rendering (E01 1r; E08 co-signed): fields other than the never-cut ones have a fixed maximum length with
 * a visible ellipsis. E02 FINAL values (E01 1v). Length = Unicode code points; over the limit → the first (max - 1)
 * code points + DISPLAY_ELLIPSIS (exactly max). The builders cut; displayHash covers the cut (shown) text;
 * validateEvent rejects an over-length value (never repairs).
 */
export const DISPLAY_MAX_LENGTH = {
  summaryUntrusted: 500,
  reasonUntrusted: 500,
  windowTitle: 256,
  targetLabel: 256,
  appName: 128,
  processImage: 260,
} as const;
export const DISPLAY_ELLIPSIS = '\u2026';
const codePoints = (s: string): number => [...s].length;
export function truncateDisplayText(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, max - 1).join('') + DISPLAY_ELLIPSIS;
}

/** Canonical display value (CONTRACTS §3.3). */
export type DisplayValue = string | null | readonly string[] | { readonly [key: string]: DisplayValue };
export type ApprovalDisplay = { readonly [key: string]: DisplayValue };

/**
 * What E02's adapter supplies on a Codex approval (CodexApprovalRequest.display): the validated params, as the
 * 'codex_command' / 'codex_file_change' union members. Field names settled (E02 895676d mirrors them exactly; unchanged at 0146c90).
 */
export interface CodexCommandParams {
  readonly kind: 'codex_command';
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly networkAccess: boolean;
  /** Sandbox / permission escalations requested (e.g. 'sandbox_bypass', 'network'); its own highlighted bound field. */
  readonly escalation?: readonly string[];
  /** Codex's (model) reason text: untrusted slot only, never the title. */
  readonly reason?: string;
}
export interface CodexFileChangeParams {
  readonly kind: 'codex_file_change';
  readonly paths: readonly string[];
  readonly reason?: string;
}
export type CodexDisplayParams = CodexCommandParams | CodexFileChangeParams;

// E01 1t (E08 co-signed): in UNTRUSTED free text (the summary / reason slots) control, bidi and invisible format
// characters are stripped. BOUND fields (command, paths, window title, …) are never stripped: they are bound raw
// (displayHash covers the raw bytes) and rendered with visible escapes (renderCodexCommand / DOT-095 renderer).
// Hidden-character set = E02 packages/contracts display.ts HIDDEN_CHAR @ 0146c90 (unchanged since 895676d) (C0/C1, DEL, bidi, zero-width and
// invisible format characters incl. U+034F, Hangul fillers, U+17B4/5, U+206A-206F, U+FFF9-FFFB, tags U+E0000-E007F).
// Rendering keeps TAB (own marker) and LF (line break) out of the escape set; everything else in it is escaped.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
/**
 * Untrusted free text (E02 untrustedText, vendored): lone surrogates → U+FFFD, hidden characters stripped (1t), then
 * cut to `max` with an ellipsis.
 */
const untrusted = (s: string, max: number): string => e02.untrustedText(s, max);
/**
 * Final gate on every builder: E02's validator (vendored 0146c90, the contract's): exact key sets, limits (incl. the
 * never-cut method), the 1z method regex, the 2a kind-scoped coverage rule, credential_access for every kind. Anything
 * it rejects is display_unavailable.
 */
const e02Valid = (d: ApprovalDisplay): boolean => e02.validateApprovalDisplay(d).ok;
const bound = (s: string): string => s;
const K = DISPLAY_KEYS;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** CONTRACTS §3 (1l): the pre-dispatch confirmation display, built by the coordinator. */
export function preDispatchDisplay(p: { category: string; risk: string; possibleRepeat: string | null; retryOfTaskId: string | null; summary: string }): ApprovalDisplay {
  return {
    [K.kind]: 'pre_dispatch',
    [K.category]: p.category,
    [K.risk]: p.risk,
    [K.possibleRepeat]: p.possibleRepeat,
    [K.retryOfTaskId]: p.retryOfTaskId,
    [K.summary]: untrusted(p.summary, DISPLAY_MAX_LENGTH.summaryUntrusted),
  };
}

/**
 * E01 1o: a Codex approval's bound display from the adapter's validated params. Command line and paths are kept in
 * full (never shortened); over MAX_COMMAND_BYTES / MAX_PATHS, or missing/malformed params → null (the caller declines
 * with display_unavailable; there is no generic fallback).
 */
export function codexDisplay(category: string, params: unknown): ApprovalDisplay | null {
  if (typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  const reason = p['reason'];
  if (reason !== undefined && typeof reason !== 'string') return null;
  const reasonSlot = typeof reason === 'string' && untrusted(reason, DISPLAY_MAX_LENGTH.reasonUntrusted).trim() !== '' ? untrusted(reason, DISPLAY_MAX_LENGTH.reasonUntrusted) : null;
  if (p['kind'] === 'codex_command') {
    const { commandLine, workingDirectory, networkAccess } = p;
    const escalation = p['escalation'] ?? [];
    if (!nonEmpty(commandLine) || !nonEmpty(workingDirectory) || typeof networkAccess !== 'boolean') return null;
    if (!Array.isArray(escalation) || !escalation.every(nonEmpty)) return null;
    if (utf8Bytes(workingDirectory) > DISPLAY_HARD_LIMITS.workingDirectoryBytes) return null;
    if (escalation.length > DISPLAY_HARD_LIMITS.escalationEntries || escalation.some(e => codePoints(e) > DISPLAY_HARD_LIMITS.escalationChars)) return null;
    // 1t (4): the raw bytes count toward the limit (escapes are display-only); over it → null, never shortened.
    if (utf8Bytes(commandLine) > MAX_COMMAND_BYTES) return null;
    const d: ApprovalDisplay = {
      [K.kind]: 'codex_command', [K.category]: category, [K.commandLine]: bound(commandLine), [K.workingDirectory]: bound(workingDirectory),
      [K.networkAccess]: networkAccess ? 'requested' : 'not_requested', [K.escalation]: (escalation as string[]).map(bound), [K.reason]: reasonSlot,
    };
    return e02Valid(d) ? d : null;
  }
  if (p['kind'] === 'codex_file_change') {
    const paths = p['paths'];
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS || !paths.every(nonEmpty)) return null;
    if (paths.some(x => utf8Bytes(x) > DISPLAY_HARD_LIMITS.pathBytes)) return null;
    const list = (paths as string[]).map(bound);
    const d: ApprovalDisplay = { [K.kind]: 'codex_file_change', [K.category]: category, [K.paths]: list, [K.fileCount]: String(list.length), [K.reason]: reasonSlot };
    return e02Valid(d) ? d : null;
  }
  return null;
}

/**
 * E01 1r/1x: K8's tool-host display (kind 'tool'). Per-category keys are E02's (0146c90 DISPLAY_KIND_KEYS.tool,
 * settled, E01 1x): no `detail`; external_send's body is `bodyUntrusted` (stripped, cut at 200); delete/overwrite get
 * `fileCount` and local_change `itemCount` (= list length, filled in here, never supplied). `fields` must be exactly the
 * category's other keys. A UI-action method (1y) must use uiActionDisplay. Anything E02's validator rejects (missing
 * or extra key, over a limit, bad amount/currency, …) → null (display_unavailable).
 */
export function toolDisplay(p: { category: string; method: string; targetLabel: string; fields?: Readonly<Record<string, string | readonly string[]>> }): ApprovalDisplay | null {
  if (!nonEmpty(p.method) || !nonEmpty(p.targetLabel) || hasUiActionPrefix(p.method)) return null;
  // own-property lookups only: a category such as 'toString' or '__proto__' is simply not a tool category
  const table = e02.DISPLAY_KIND_KEYS.tool as Readonly<Record<string, readonly string[]>>;
  if (typeof p.category !== 'string' || !Object.hasOwn(table, p.category)) return null;
  const keys = table[p.category]!;
  const F = e02.TOOL_FIELD_KEYS;
  const countOf: Readonly<Record<string, [list: string, count: string]>> = { delete: [K.paths, K.fileCount], overwrite: [K.paths, K.fileCount], local_change: [F.targets, F.itemCount] };
  const counted = Object.hasOwn(countOf, p.category) ? countOf[p.category] : undefined;
  const base: string[] = [K.kind, K.category, K.method, K.targetLabel];
  const d: Record<string, DisplayValue> = {
    [K.kind]: 'tool', [K.category]: p.category,
    [K.method]: p.method, // bound, never cut: over 64 code points the gate refuses it (display_unavailable)
    [K.targetLabel]: truncateDisplayText(bound(p.targetLabel), DISPLAY_MAX_LENGTH.targetLabel),
  };
  for (const [k, v] of Object.entries(p.fields ?? {})) {
    if (!keys.includes(k) || base.includes(k) || k === counted?.[1]) return null;
    if (k === F.body) {
      if (typeof v !== 'string') return null;
      d[k] = untrusted(v, e02.DISPLAY_MAX[F.body]);
    } else d[k] = typeof v === 'string' ? bound(v) : [...v].map(bound);
  }
  if (counted) {
    const list = d[counted[0]];
    if (!Array.isArray(list)) return null;
    d[counted[1]] = String(list.length);
  }
  return e02Valid(d) ? d : null;
}

/** E01 1m/1r: K8's UI-action display (kind 'ui_action'): app name, window title (untrusted), process image. */
export function uiActionDisplay(p: { category: string; method: string; appName: string; windowTitle: string; processImage: string }): ApprovalDisplay | null {
  if (!isUiActionMethod(p.method) || !nonEmpty(p.appName) || !nonEmpty(p.windowTitle) || !nonEmpty(p.processImage)) return null;
  const d: ApprovalDisplay = {
    [K.kind]: 'ui_action', [K.category]: p.category, [K.method]: p.method, // never cut (see toolDisplay)
    [K.app]: {
      [K.appName]: truncateDisplayText(bound(p.appName), DISPLAY_MAX_LENGTH.appName),
      [K.windowTitle]: truncateDisplayText(bound(p.windowTitle), DISPLAY_MAX_LENGTH.windowTitle),
      [K.processImage]: truncateDisplayText(bound(p.processImage), DISPLAY_MAX_LENGTH.processImage),
    },
  };
  return e02Valid(d) ? d : null;
}

/** What the secure UI shows for a bound field (E01 1t). Display-only: the bound/hashed/executed value is the raw string. */
export interface RenderedBoundText {
  /** Lines after `\r\n` → `\n` (display only), with hidden characters as visible escapes. */
  readonly lines: readonly string[];
  readonly lineCount: number;
  /** Show the "contains hidden characters" badge. */
  readonly hiddenCharacters: boolean;
}
/** Visible tab marker (1t (2)); trailing whitespace marker (1t (3)). */
export const TAB_MARKER = '\u21e5';
export const TRAILING_SPACE_MARKER = '\u00b7';

/** Escape one hidden character visibly: C0/DEL/C1 controls as \xNN, other invisible/bidi characters as <U+XXXX>. */
function escapeHidden(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return `\\x${cp.toString(16).padStart(2, '0')}`;
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/**
 * E01 1t codex_command rendering (also used for other bound fields): (1) `\n` is a line break and the line count is
 * reported; `\r\n` → `\n` for display only. (2) Nothing is stripped: other controls, a lone `\r`, bidi controls and
 * invisible format characters (zero-width, BOM, soft hyphen) become visible escapes and set the badge; tab shows a
 * visible marker. (3) Trailing whitespace is shown visibly. Wrapping without horizontal scroll is the renderer's (E06).
 */
export function renderBoundText(raw: string): RenderedBoundText {
  const text = raw.replace(/\r\n/g, '\n');
  let hidden = false;
  const lines = text.split('\n').map(line => {
    let out = line.replace(HIDDEN, ch => {
      hidden = true;
      return escapeHidden(ch);
    });
    out = out.replace(/\t/g, `${TAB_MARKER}\t`);
    out = out.replace(/[ \t\u21e5]+$/, ws => ws.replace(/ /g, TRAILING_SPACE_MARKER));
    return out;
  });
  return { lines, lineCount: lines.length, hiddenCharacters: hidden };
}
export const renderCodexCommand = (display: ApprovalDisplay): RenderedBoundText | null =>
  display[K.kind] === 'codex_command' && typeof display[K.commandLine] === 'string' ? renderBoundText(display[K.commandLine] as string) : null;

/** CONTRACTS §3 (1l/1m/1o) display rules for validateEvent. Returns problems; empty = valid. */
export function displayProblems(display: unknown, ctx: { category: unknown; risk: unknown; priorSideEffect: unknown; priorTaskId: unknown; requestSource: unknown }): string[] {
  const out: string[] = [];
  if (!isRecord(display)) return ['payload.display must be an object'];
  if (!plainOwnDisplay(display)) return ['payload.display must be a plain object with its own fields (no inherited keys)'];
  const d = display;
  if (!canonical(d)) out.push('payload.display values must be strings, null, arrays of strings or objects of those');
  const kind = d[K.kind];
  if (!(DISPLAY_KINDS as readonly unknown[]).includes(kind)) return [...out, `payload.display.${K.kind} must be one of ${DISPLAY_KINDS.join(', ')}`];
  if (d[K.category] !== ctx.category) out.push(`payload.display.${K.category} must equal payload.category`);
  if (KIND_SOURCE[kind as DisplayKind] !== ctx.requestSource) out.push(`payload.display.${K.kind} ${String(kind)} does not fit requestSource ${String(ctx.requestSource)}`);
  const exact = (...allowed: string[]) => {
    const extra = Object.keys(d).filter(k => !allowed.includes(k));
    if (extra.length > 0) out.push(`payload.display has unexpected key(s) for ${String(kind)}: ${extra.join(', ')}`);
  };
  if (ctx.category === 'credential_access') out.push('credential_access has no display rule (always DENIED_BY_POLICY, no request)');
  const need = (obj: Record<string, unknown>, prefix: string, ...keys: string[]) => {
    for (const k of keys) if (!nonEmpty(own(obj, k))) out.push(`payload.display.${prefix}${k} is required (non-empty string) for kind ${String(kind)}`);
  };
  const maxLen = (obj: Record<string, unknown>, prefix: string, k: string, max: number) => {
    const v = own(obj, k);
    if (typeof v === 'string' && codePoints(v) > max) out.push(`payload.display.${prefix}${k} exceeds ${max} code points (builders cut with an ellipsis)`);
  };
  const maxBytes = (obj: Record<string, unknown>, k: string, max: number) => {
    const v = own(obj, k);
    if (typeof v === 'string' && utf8Bytes(v) > max) out.push(`payload.display.${k} exceeds ${max} bytes (display_unavailable)`);
  };
  const pathBytes = (paths: unknown) => {
    if (Array.isArray(paths) && paths.some(x => typeof x === 'string' && utf8Bytes(x) > DISPLAY_HARD_LIMITS.pathBytes)) out.push(`payload.display.${K.paths} has a path over ${DISPLAY_HARD_LIMITS.pathBytes} bytes (display_unavailable)`);
  };
  // The contract's own per-kind / per-category rules (E02 validateApprovalDisplay @ 0146c90, vendored): exact key sets
  // (1x tool keys), limits, hidden characters left in untrusted slots, lone surrogates, process-image basename, formats.
  for (const i of e02.validateApprovalDisplay(d).issues) out.push(`payload.${i.path} ${i.message}`);
  switch (kind as DisplayKind) {
    case 'pre_dispatch': {
      const allowed: string[] = [K.kind, K.category, K.risk, K.possibleRepeat, K.retryOfTaskId, K.summary];
      exact(...allowed);
      for (const k of allowed) if (!Object.hasOwn(d, k)) out.push(`payload.display.${k} is required for pre_dispatch`);
      if (ctx.priorTaskId !== undefined && ctx.priorTaskId !== null && d[K.retryOfTaskId] !== ctx.priorTaskId) out.push(`payload.display.${K.retryOfTaskId} must equal payload.possibleRepeat.priorTaskId`);
      if (d[K.risk] !== ctx.risk) out.push(`payload.display.${K.risk} must equal payload.risk`);
      if (d[K.possibleRepeat] !== (ctx.priorSideEffect ?? null)) out.push(`payload.display.${K.possibleRepeat} must equal payload.possibleRepeat.priorSideEffect (or null)`);
      if (d[K.retryOfTaskId] !== null && !nonEmpty(d[K.retryOfTaskId])) out.push(`payload.display.${K.retryOfTaskId} must be a non-empty string or null`);
      if (typeof d[K.summary] !== 'string') out.push(`payload.display.${K.summary} must be a string`);
      maxLen(d, '', K.summary, DISPLAY_MAX_LENGTH.summaryUntrusted);
      break;
    }
    case 'codex_command':
      exact(K.kind, K.category, K.commandLine, K.workingDirectory, K.networkAccess, K.escalation, K.reason);
      need(d, '', K.commandLine, K.workingDirectory);
      if (typeof d[K.commandLine] === 'string' && utf8Bytes(d[K.commandLine] as string) > MAX_COMMAND_BYTES) out.push(`payload.display.${K.commandLine} exceeds ${MAX_COMMAND_BYTES} bytes`);
      if (!(NETWORK_ACCESS_VALUES as readonly unknown[]).includes(d[K.networkAccess])) out.push(`payload.display.${K.networkAccess} must be one of ${NETWORK_ACCESS_VALUES.join(', ')}`);
      maxBytes(d, K.workingDirectory, DISPLAY_HARD_LIMITS.workingDirectoryBytes);
      if (!Array.isArray(d[K.escalation])) out.push(`payload.display.${K.escalation} must be an array (empty when none)`);
      else {
        const esc = d[K.escalation] as unknown[];
        if (esc.length > DISPLAY_HARD_LIMITS.escalationEntries) out.push(`payload.display.${K.escalation} exceeds ${DISPLAY_HARD_LIMITS.escalationEntries} entries (display_unavailable)`);
        if (esc.some(e => typeof e === 'string' && codePoints(e) > DISPLAY_HARD_LIMITS.escalationChars)) out.push(`payload.display.${K.escalation} has an entry over ${DISPLAY_HARD_LIMITS.escalationChars} code points (display_unavailable)`);
      }
      if (d[K.reason] !== null && typeof d[K.reason] !== 'string') out.push(`payload.display.${K.reason} must be a string or null`);
      maxLen(d, '', K.reason, DISPLAY_MAX_LENGTH.reasonUntrusted);
      break;
    case 'codex_file_change': {
      exact(K.kind, K.category, K.paths, K.fileCount, K.reason);
      const paths = d[K.paths];
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every(nonEmpty)) out.push(`payload.display.${K.paths} must be a non-empty array of non-empty strings`);
      else if (paths.length > MAX_PATHS) out.push(`payload.display.${K.paths} exceeds ${MAX_PATHS} paths`);
      else if (d[K.fileCount] !== String(paths.length)) out.push(`payload.display.${K.fileCount} must equal the number of paths`);
      pathBytes(paths);
      if (d[K.reason] !== null && typeof d[K.reason] !== 'string') out.push(`payload.display.${K.reason} must be a string or null`);
      maxLen(d, '', K.reason, DISPLAY_MAX_LENGTH.reasonUntrusted);
      break;
    }
    case 'ui_action': {
      // E01 1m/1r: a UI action inside an app (click, type, window) shows app.appName, app.windowTitle (untrusted), app.processImage.
      exact(K.kind, K.category, K.method, K.app);
      need(d, '', K.method);
      if (!isUiActionMethod(d[K.method])) out.push(`payload.display.${K.method} is not a UI-action method (kind ui_action)`);
      const app = d[K.app];
      if (!isRecord(app)) out.push(`payload.display.${K.app} is required for kind ui_action`);
      else {
        need(app, `${K.app}.`, K.appName, K.windowTitle, K.processImage);
        maxLen(app, `${K.app}.`, K.windowTitle, DISPLAY_MAX_LENGTH.windowTitle);
        maxLen(app, `${K.app}.`, K.appName, DISPLAY_MAX_LENGTH.appName);
        maxLen(app, `${K.app}.`, K.processImage, DISPLAY_MAX_LENGTH.processImage);
        const extra = Object.keys(app).filter(k => !([K.appName, K.windowTitle, K.processImage] as string[]).includes(k));
        if (extra.length > 0) out.push(`payload.display.${K.app} has unexpected key(s): ${extra.join(', ')}`);
      }
      break;
    }
    case 'tool': {
      // Per-category keys: settled, E01 1x (474c502) = E02 0146c90 DISPLAY_KIND_KEYS.tool; exact key sets are enforced by
      // the vendored validateApprovalDisplay above (no `detail`; `bodyUntrusted`; delete/overwrite `fileCount`).
      need(d, '', K.method, K.targetLabel);
      if (hasUiActionPrefix(d[K.method])) out.push(`payload.display.${K.method} has a ui./window. prefix: only kind ui_action may use it (E01 1y)`);
      maxLen(d, '', K.targetLabel, DISPLAY_MAX_LENGTH.targetLabel);
      const paths = d[K.paths];
      if (paths !== undefined) {
        if (!Array.isArray(paths) || !paths.every(nonEmpty)) out.push(`payload.display.${K.paths} must be an array of non-empty strings`);
        else if (paths.length > MAX_PATHS) out.push(`payload.display.${K.paths} exceeds ${MAX_PATHS} paths (display_unavailable)`);
        pathBytes(paths);
      }
      break;
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function canonical(v: unknown): boolean {
  if (v === null || typeof v === 'string') return true;
  if (Array.isArray(v)) return v.every(x => typeof x === 'string');
  if (isRecord(v)) return Object.values(v).every(canonical);
  return false;
}
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
