/**
 * Bound approval display, X5 (CONTRACTS §3 at E01 e41d1ca: rulings 1k/1l/1m/1o/1r/1t; E08 co-signed). The secure UI renders
 * ONLY this object; `displayHash` = SHA-256 of its canonical JSON (§3.3) is bound into the CR2 actionId preimage, top
 * level (ruling 1q), so any change to a displayed field, including `kind`, changes the actionId.
 *
 * Ruling 1r: a discriminated union on a required `kind`. Every kind has a fixed key set (a field that doesn't apply is
 * `null`, never omitted); unknown kinds and extra keys are rejected. Lengths count Unicode code points (Python `len`).
 * Two field types are never shortened (ruling 1o/1r): the command line (hard limit 8 KB = 8192 UTF-8 bytes) and path
 * lists (hard limit 500 entries); over a hard limit the display can't be built → `display_unavailable`. Every other
 * field has a maximum length and builders cut it with `truncateDisplayText` (visible ellipsis). The validator rejects,
 * never repairs.
 *
 * Ruling 1t: BOUND fields (everything except the untrusted free text) keep control, bidi and invisible characters as
 * raw bytes (the hash covers what runs); the renderer helpers below show them as visible highlighted escapes plus a
 * "contains hidden characters" badge. UNTRUSTED free text (`summaryUntrusted`, `bodyUntrusted`, `reasonUntrusted`) is stripped by the
 * builder and the validator rejects any such character left in it.
 *
 * Ruling 1v: key names mirror E03 3029c7b `DISPLAY_KEYS` exactly (one table below). Codex displays are built by
 * `codexDisplay` from the port params (CodexApprovalRequest.display) so the adapter (which binds the hash into the
 * actionId) and the coordinator (which rebuilds it from the same params) hash the same bytes.
 *
 * TODO(DOT-095): final per-field maxima with E06's dialog layout; `source` as a URL vs a label; recipient formats per
 * channel; the P27 list of UI-action methods (CONTRACTS: `ui_action` only for UI-action methods).
 */
import { CanonicalError, canonicalJson, hasOwn, isPlainArray, isPlainObject, sha256Hex } from './canonical.js';
import { PRIOR_SIDE_EFFECTS, RISK_SEVERITIES, type ApprovalCategory, type PriorSideEffect, type RequestSource, type Risk } from './enums.js';

/** Categories that open a dialog (ruling 1l coverage); each has a display rule. */
export const DIALOG_CATEGORIES = ['local_change', 'delete', 'overwrite', 'external_send', 'external_upload', 'purchase', 'install_or_elevate', 'security_setting'] as const;
export type DialogCategory = (typeof DIALOG_CATEGORIES)[number];
/** Categories that never open a dialog: displayHash null (navigate, read); credential_access is always DENIED_BY_POLICY. */
export const NO_DIALOG_CATEGORIES = ['read', 'navigate', 'credential_access'] as const satisfies readonly ApprovalCategory[];
/**
 * Ruling 2a (dottie-e01 972d5f4): the 1l coverage rule (dialog categories only) applies to kind `tool` ONLY; `ui_action`
 * stays `local_change` or stricter (a dialog category). Kinds `pre_dispatch`, `codex_command` and `codex_file_change`
 * are complete by kind for every category including `read` and `navigate` (D14 read/navigate retry, Codex read command;
 * C-25). `credential_access` keeps no display rule for any kind (ruling 1l: always DENIED_BY_POLICY, no request).
 */
export const KIND_COMPLETE_CATEGORIES = [...DIALOG_CATEGORIES, 'read', 'navigate'] as const satisfies readonly ApprovalCategory[];
export type KindCompleteCategory = (typeof KIND_COMPLETE_CATEGORIES)[number];
/** Kinds whose display is complete by kind (ruling 2a), i.e. not subject to the tool-kind coverage rule. */
export const KIND_COMPLETE_KINDS = ['pre_dispatch', 'codex_command', 'codex_file_change'] as const;
/** The categories a display of `kind` may carry (ruling 2a). */
export function displayCategories(kind: DisplayKind): readonly ApprovalCategory[] {
  return (KIND_COMPLETE_KINDS as readonly string[]).includes(kind) ? KIND_COMPLETE_CATEGORIES : DIALOG_CATEGORIES;
}

/**
 * THE key table (ruling 1v: E03 3029c7b `DISPLAY_KEYS`, mirrored exactly). Logical name → wire key. Every builder,
 * validator and the adapter take key names from here only. Untrusted free text sits only in a slot whose key says so.
 * The tool-kind per-category keys (E02-owned, DOT-095) are in TOOL_FIELD_KEYS below.
 */
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
const K = DISPLAY_KEYS;
/** Tool-kind per-category keys (E02, DOT-095). E03's toolDisplay passes them through as strings / string lists. */
export const TOOL_FIELD_KEYS = {
  targets: 'targets',
  itemCount: 'itemCount',
  recipients: 'recipients',
  channel: 'channel',
  body: 'bodyUntrusted',
  path: 'path',
  destinationHost: 'destinationHost',
  merchant: 'merchant',
  amount: 'amount',
  currency: 'currency',
  package: 'package',
  publisher: 'publisher',
  version: 'version',
  source: 'source',
  setting: 'setting',
  currentValue: 'currentValue',
  newValue: 'newValue',
} as const;
const F = TOOL_FIELD_KEYS;

/** Ruling 1r discriminator. */
export const DISPLAY_KINDS = ['tool', 'ui_action', 'codex_command', 'codex_file_change', 'pre_dispatch'] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];
/** Kind/source guard (CONTRACTS e41d1ca L226). E03 name: KIND_SOURCE. */
export const DISPLAY_KIND_SOURCE: Readonly<Record<DisplayKind, RequestSource>> = {
  tool: 'tool_host',
  ui_action: 'tool_host',
  codex_command: 'codex',
  codex_file_change: 'codex',
  pre_dispatch: 'coordinator',
};
export const KIND_SOURCE = DISPLAY_KIND_SOURCE;
/** E01 ruling 1z (dottie-e01 492c01c): a UI action inside an app is EXACTLY `ui.<name>` or `window.<name>`, one
 *  lowercase segment: `^(ui|window)\.[a-z][a-z0-9_]*$` (anchored; no empty name, no capitals, no leading digit, no
 *  `uix.`, no second dot). Replaces the E03 3029c7b prefix test `^(ui|window)\.`. */
export const UI_ACTION_METHOD_RE = /^(ui|window)\.[a-z][a-z0-9_]*$/;
export const isUiActionMethod = (method: unknown): boolean => typeof method === 'string' && UI_ACTION_METHOD_RE.test(method);
/**
 * E01 1y follow-up (confirmed): the `ui.` / `window.` namespace belongs to kind `ui_action` only. A kind-`tool` display
 * rejects ANY method with that prefix, in any case (`ui.Click`, `window.`, `UI.x`, `Window.close`, and the valid
 * `ui.click` too). Valid UI methods go only through ui_action with the 1z regex. `uix.click` / `file.read` are not
 * matched.
 */
export const UI_ACTION_PREFIX_RE = /^(ui|window)\./i;
export const hasUiActionPrefix = (method: unknown): boolean => typeof method === 'string' && UI_ACTION_PREFIX_RE.test(method);

/**
 * NEVER cut (rulings 1o/1r; values from the parent dispatch, given to E03 2026-10-19): over a limit the display can't be
 * built → display_unavailable. Byte limits are raw UTF-8 bytes.
 */
export const DISPLAY_HARD_LIMITS = {
  [K.commandLine]: { maxBytes: 8192 },
  [K.workingDirectory]: { maxBytes: 4096 },
  [K.paths]: { maxEntries: 500, maxEntryBytes: 4096 },
  [K.escalation]: { maxEntries: 32, maxEntryCodePoints: 256 },
  /**
   * 2a addition (agreed with E03): `method` is bound and never cut. Cutting would give e.g. `ui.mmm…`, which breaks
   * the 1z regex, so over 64 code points → display_unavailable in the builders, and validateEvent rejects it.
   */
  [K.method]: { maxCodePoints: 64 },
} as const;
export const COMMAND_MAX_BYTES = DISPLAY_HARD_LIMITS[K.commandLine].maxBytes;
export const PATH_LIST_MAX = DISPLAY_HARD_LIMITS[K.paths].maxEntries;
export const MAX_COMMAND_BYTES = COMMAND_MAX_BYTES;
export const MAX_PATHS = PATH_LIST_MAX;
/** One listed path / the working directory: never shortened; over 4096 bytes → display_unavailable. */
export const PATH_MAX_BYTES = DISPLAY_HARD_LIMITS[K.paths].maxEntryBytes;

/**
 * CUT fields, keyed by wire key: maximum length in code points. Builders strip first if the field is untrusted free
 * text, then cut to max−1 code points + U+2026 (so a cut value is exactly `max`); the validator rejects over-length
 * values. The first seven are the cross-team values (E03 f3672da); the tool per-category ones are E02's (DOT-095).
 * TODO(DOT-095): tool per-category maxima with E06's dialog layout.
 */
export const DISPLAY_MAX = {
  [K.summary]: 500,
  [K.reason]: 500,
  [K.windowTitle]: 256,
  [K.targetLabel]: 256,
  [K.appName]: 128,
  [K.processImage]: 260,
  [K.retryOfTaskId]: 128,
  /** external_upload's single path (not a path list). */
  [F.path]: 1024,
  /** Per recipient; at most 20 recipients. */
  [F.recipients]: 254,
  recipientCount: 20,
  [F.channel]: 64,
  [F.body]: 200,
  [F.package]: 128,
  [F.publisher]: 128,
  [F.version]: 64,
  [F.source]: 256,
  [F.merchant]: 128,
  [F.amount]: 32,
  [F.destinationHost]: 253,
  [F.setting]: 128,
  [F.currentValue]: 256,
  [F.newValue]: 256,
} as const;
export const DISPLAY_ELLIPSIS = '\u2026';
/** Never-cut code-point-limited text fields (validator message only). */
const NEVER_CUT_TEXT = [K.method] as const;
export const METHOD_MAX = DISPLAY_HARD_LIMITS[K.method].maxCodePoints;
/** Wire keys the dialog renders under the untrusted-content label (model, web, app or Codex text). */
export const UNTRUSTED_DISPLAY_FIELDS = [K.summary, K.reason, F.body, K.windowTitle] as const;
/** Untrusted FREE TEXT: hidden characters are stripped (ruling 1t). The window title is untrusted but bound: escaped. */
export const STRIPPED_DISPLAY_FIELDS = [K.summary, K.reason, F.body] as const;
/** Fields the dialog highlights (ruling 1o: sandbox/escalation requests). */
export const HIGHLIGHTED_DISPLAY_FIELDS = [K.escalation] as const;
/** Values (E03 convention): strings, null, string lists, nested objects of those. Flags and counts are strings. */
export const NETWORK_ACCESS_VALUES = ['requested', 'not_requested'] as const;
export const NETWORK_FLAG_VALUES = NETWORK_ACCESS_VALUES;
export type NetworkAccess = (typeof NETWORK_ACCESS_VALUES)[number];

// ------------------------------------------------------------------ shapes (property names = DISPLAY_KEYS values)
interface ToolBase<C extends DialogCategory> {
  readonly kind: 'tool';
  readonly category: C;
  /** The tool id; never a UI-action method (those are kind ui_action). */
  readonly method: string;
  /** Built from validated args; never model text. */
  readonly targetLabel: string;
}
export interface LocalChangeDisplay extends ToolBase<'local_change'> {
  /** Full targets, never shortened, 1-500. */
  readonly targets: readonly string[];
  /** = String(targets.length). */
  readonly itemCount: string;
}
export interface PathDisplay<C extends 'delete' | 'overwrite'> extends ToolBase<C> {
  /** Full path list, never shortened, 1-500 (ruling 1r). */
  readonly paths: readonly string[];
  /** = String(paths.length). */
  readonly fileCount: string;
}
export interface ExternalSendDisplay extends ToolBase<'external_send'> {
  readonly recipients: readonly string[];
  /** Channel or app, e.g. `email`, `Teams`. */
  readonly channel: string;
  /** Untrusted; stripped, at most 200 code points (ellipsis). */
  readonly bodyUntrusted: string;
}
export interface ExternalUploadDisplay extends ToolBase<'external_upload'> {
  readonly path: string;
  readonly destinationHost: string;
}
export interface PurchaseDisplay extends ToolBase<'purchase'> {
  readonly merchant: string;
  /** Decimal string, e.g. `19.99`. */
  readonly amount: string;
  /** ISO 4217 code, e.g. `USD`. */
  readonly currency: string;
}
export interface InstallDisplay extends ToolBase<'install_or_elevate'> {
  readonly package: string;
  readonly publisher: string;
  readonly version: string;
  readonly source: string;
}
export interface SecuritySettingDisplay extends ToolBase<'security_setting'> {
  readonly setting: string;
  /** Plain text unless secret-shaped (then already redacted by the redactor). */
  readonly currentValue: string;
  readonly newValue: string;
}
export type ToolDisplay =
  | LocalChangeDisplay
  | PathDisplay<'delete'>
  | PathDisplay<'overwrite'>
  | ExternalSendDisplay
  | ExternalUploadDisplay
  | PurchaseDisplay
  | InstallDisplay
  | SecuritySettingDisplay;
/** UI actions inside apps (ruling 1v: no targetLabel; app fields nested under `app`). */
export interface UiActionDisplay {
  readonly kind: 'ui_action';
  readonly category: DialogCategory;
  /** A UI-action method (`ui.*` / `window.*`). */
  readonly method: string;
  readonly app: {
    readonly appName: string;
    /** Untrusted (window titles come from the app) but bound: kept raw, escaped when rendered. */
    readonly windowTitle: string;
    /** Process image BASENAME only, e.g. `notepad.exe`; never a path. */
    readonly processImage: string;
  };
}
export const CODEX_COMMAND_METHOD = 'item/commandExecution/requestApproval';
export const CODEX_FILE_CHANGE_METHOD = 'item/fileChange/requestApproval';
/** A Codex command approval (ruling 1o). */
export interface CodexCommandDisplay {
  readonly kind: 'codex_command';
  readonly category: KindCompleteCategory;
  /** The full command line, never shortened; at most 8192 UTF-8 bytes; raw (tabs, line breaks, hidden chars kept). */
  readonly commandLine: string;
  /** Canonical working directory, never shortened. */
  readonly workingDirectory: string;
  readonly networkAccess: NetworkAccess;
  /** Sandbox/escalation requests, highlighted (ruling 1o); [] when none. */
  readonly escalation: readonly string[];
  /** Codex's `reason` (model text): stripped, cut with an ellipsis; null when absent or blank. Never the title. */
  readonly reasonUntrusted: string | null;
}
/** A Codex file-change approval (ruling 1o). */
export interface CodexFileChangeDisplay {
  readonly kind: 'codex_file_change';
  readonly category: KindCompleteCategory;
  /** Every canonical path the change touches (a move lists source then destination), never shortened, 1-500. */
  readonly paths: readonly string[];
  /** = String(paths.length). */
  readonly fileCount: string;
  readonly reasonUntrusted: string | null;
}
/** §2.1 pre-dispatch confirmation display (ruling 1l), built by the coordinator. The preimage args keep `summary`. */
export interface PreDispatchDisplay {
  readonly kind: 'pre_dispatch';
  readonly category: KindCompleteCategory;
  readonly risk: Risk;
  readonly possibleRepeat: PriorSideEffect | null;
  readonly retryOfTaskId: string | null;
  /** Untrusted slot: the summary stripped and cut with an ellipsis. */
  readonly summaryUntrusted: string;
}
export type ApprovalDisplay = ToolDisplay | UiActionDisplay | CodexCommandDisplay | CodexFileChangeDisplay | PreDispatchDisplay;

const TOOL_BASE = [K.kind, K.category, K.method, K.targetLabel] as const;
/** The exact key set per kind (and per category for `tool`). */
export const DISPLAY_KIND_KEYS = {
  tool: {
    local_change: [...TOOL_BASE, F.targets, F.itemCount],
    delete: [...TOOL_BASE, K.paths, K.fileCount],
    overwrite: [...TOOL_BASE, K.paths, K.fileCount],
    external_send: [...TOOL_BASE, F.recipients, F.channel, F.body],
    external_upload: [...TOOL_BASE, F.path, F.destinationHost],
    purchase: [...TOOL_BASE, F.merchant, F.amount, F.currency],
    install_or_elevate: [...TOOL_BASE, F.package, F.publisher, F.version, F.source],
    security_setting: [...TOOL_BASE, F.setting, F.currentValue, F.newValue],
  },
  ui_action: [K.kind, K.category, K.method, K.app],
  codex_command: [K.kind, K.category, K.commandLine, K.workingDirectory, K.networkAccess, K.escalation, K.reason],
  codex_file_change: [K.kind, K.category, K.paths, K.fileCount, K.reason],
  pre_dispatch: [K.kind, K.category, K.risk, K.possibleRepeat, K.retryOfTaskId, K.summary],
} as const satisfies { readonly tool: Readonly<Record<DialogCategory, readonly string[]>> } & Readonly<Record<Exclude<DisplayKind, 'tool'>, readonly string[]>>;
export const UI_ACTION_APP_KEYS = [K.appName, K.windowTitle, K.processImage] as const;
// Compile-time: the interfaces use exactly the table's wire names.
type _KeysOf<T> = T extends unknown ? keyof T : never;
type _Check<A extends B, B> = A;
export type _DisplayKeysMatch = _Check<_KeysOf<ApprovalDisplay>, (typeof DISPLAY_KEYS)[keyof typeof DISPLAY_KEYS] | (typeof TOOL_FIELD_KEYS)[keyof typeof TOOL_FIELD_KEYS]>;

/**
 * Hidden characters (ruling 1t): C0 and C1 controls, DEL, bidi marks/embeddings/overrides/isolates (ALM U+061C, LRM/RLM
 * U+200E/F, U+202A-202E, U+2066-2069), zero-width and other invisible format characters (U+200B-200D ZWSP/ZWNJ/ZWJ,
 * U+2060-2064, U+206A-206F, U+FEFF BOM, U+00AD soft hyphen, U+034F CGJ, U+180E, U+115F/1160/3164/FFA0 Hangul fillers,
 * U+17B4/17B5, U+FFF9-FFFB, tags U+E0000-E007F). A superset of E03's strip set, so stripping here first makes E03's
 * strip a no-op (both builders then produce the same bytes).
 */
const HIDDEN_CHAR = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;
const HIDDEN_CHAR_G = new RegExp(HIDDEN_CHAR.source, 'gu');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const codePoints = (s: string) => [...s].length;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** Truncate to `max` code points with a visible ellipsis (the last kept position becomes "…"). Never for command/paths. */
export function truncateDisplayText(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, max - 1).join('') + DISPLAY_ELLIPSIS;
}
/** Builder helper: drop control and bidi characters (CONTRACTS rendering rule). Never for command/paths (refused instead). */
export function stripDisplayText(s: string): string {
  return s.replace(HIDDEN_CHAR_G, '');
}
/**
 * Untrusted free text slot value: lone surrogates → U+FFFD, hidden characters stripped, cut to `max` with an ellipsis.
 * Idempotent. `nullable`: null when absent or blank after trimming (E03 rule).
 */
export function untrustedText(s: string, max: number): string {
  return truncateDisplayText(stripDisplayText(s.replace(new RegExp(LONE_SURROGATE.source, 'g'), '\uFFFD')), max);
}
function untrustedSlot(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = untrustedText(s, max);
  return t.trim() === '' ? null : t;
}

export interface DisplayIssue {
  readonly path: string;
  readonly message: string;
}
/** Plain data objects only (prototype Object.prototype or null; own enumerable data keys): see isPlainObject. */
const isObj = isPlainObject;

/** Validate an untrusted ApprovalDisplay (strict, per kind). Never coerces. */
export function validateApprovalDisplay(v: unknown, path = 'display'): { readonly ok: boolean; readonly issues: readonly DisplayIssue[] } {
  const out: DisplayIssue[] = [];
  const bad = (p: string, message: string) => out.push({ path: `${path}.${p}`, message });
  const textIn = (o: Record<string, unknown>, prefix: string, k: string, max: number, opts: { nullable?: boolean; empty?: boolean } = {}): void => {
    const x = o[k];
    if (x === null && opts.nullable) return;
    if (typeof x !== 'string' || (x.length === 0 && !opts.empty)) bad(prefix + k, opts.nullable ? 'must be a non-empty string or null' : 'must be a non-empty string');
    else if (codePoints(x) > max) bad(prefix + k, (NEVER_CUT_TEXT as readonly string[]).includes(k) ? `at most ${max} code points (never cut: display_unavailable)` : `at most ${max} code points (truncate with an ellipsis)`);
    else if ((STRIPPED_DISPLAY_FIELDS as readonly string[]).includes(k) && HIDDEN_CHAR.test(x)) bad(prefix + k, 'untrusted free text must have hidden characters stripped (ruling 1t)');
    else if (LONE_SURROGATE.test(x)) bad(prefix + k, 'contains a lone surrogate');
    else if (opts.nullable && x.trim() === '') bad(prefix + k, 'is null when blank');
  };
  const text = (k: string, max: number, opts?: { nullable?: boolean; empty?: boolean }): void => textIn(v as Record<string, unknown>, '', k, max, opts);
  /** A bound full-text field (command, cwd, a listed path): raw, hidden characters allowed (escaped when rendered). */
  const fullText = (x: unknown, p: string): boolean => {
    if (typeof x !== 'string' || x.length === 0) return bad(p, 'must be a non-empty string'), false;
    if (LONE_SURROGATE.test(x)) return bad(p, 'contains a lone surrogate'), false;
    return true;
  };
  /** A path list (ruling 1r): 1-500 full paths, never shortened. */
  const pathList = (k: string): number => {
    const x = (v as Record<string, unknown>)[k];
    if (!isPlainArray(x) || x.length === 0 || x.length > PATH_LIST_MAX) {
      bad(k, `must be a list of 1-${PATH_LIST_MAX} full paths (more → display_unavailable)`);
      return -1;
    }
    x.forEach((e, i) => {
      if (fullText(e, `${k}[${i}]`) && utf8Bytes(e as string) > PATH_MAX_BYTES) bad(`${k}[${i}]`, `is over ${PATH_MAX_BYTES} UTF-8 bytes (never shortened → display_unavailable)`);
      else if (typeof e === 'string' && e.endsWith(DISPLAY_ELLIPSIS)) bad(`${k}[${i}]`, 'a path is never shortened with an ellipsis');
    });
    return x.length;
  };
  const list = (k: string, minItems: number, maxItems: number, maxLen: number): void => {
    const x = (v as Record<string, unknown>)[k];
    if (!isPlainArray(x) || x.length < minItems || x.length > maxItems) return void bad(k, `must be a list of ${minItems}-${maxItems} entries`);
    x.forEach((e, i) => {
      if (typeof e !== 'string' || e.length === 0) bad(`${k}[${i}]`, 'must be a non-empty string');
      else if (codePoints(e) > maxLen) bad(`${k}[${i}]`, `at most ${maxLen} code points`);
      else if (LONE_SURROGATE.test(e)) bad(`${k}[${i}]`, 'contains a lone surrogate');
    });
  };
  /** Counts are decimal strings equal to the list length (E03 convention). */
  const count = (k: string, listLen: number): void => {
    if (listLen > 0 && (v as Record<string, unknown>)[k] !== String(listLen)) bad(k, 'is the list length as a decimal string');
  };

  if (!isObj(v)) return { ok: false, issues: [{ path, message: 'must be a plain object (prototype Object.prototype or null, own data keys only)' }] };
  const kind = v[K.kind];
  if (!(DISPLAY_KINDS as readonly unknown[]).includes(kind)) return { ok: false, issues: [{ path: `${path}.${K.kind}`, message: `must be one of ${DISPLAY_KINDS.join('|')}` }] };
  const cat = v[K.category];
  let keys: readonly string[];
  if (kind === 'tool') {
    if (!(DIALOG_CATEGORIES as readonly unknown[]).includes(cat)) return { ok: false, issues: [{ path: `${path}.${K.category}`, message: `has no display rule (dialog categories: ${DIALOG_CATEGORIES.join('|')})` }] };
    keys = DISPLAY_KIND_KEYS.tool[cat as DialogCategory];
  } else keys = DISPLAY_KIND_KEYS[kind as Exclude<DisplayKind, 'tool'>];
  for (const k of Object.keys(v)) if (!keys.includes(k)) bad(k, `is not a field of a ${String(kind)} display`);
  for (const k of keys) if (!hasOwn(v, k)) bad(k, 'is required (null when it does not apply)');
  // Ruling 2a: the coverage rule is per kind (tool already checked above; ui_action dialog categories only;
  // pre_dispatch / codex_* every category but credential_access).
  {
    const allowed = displayCategories(kind as DisplayKind);
    if (!(allowed as readonly unknown[]).includes(cat)) bad(K.category, `has no ${String(kind)} display rule (allowed: ${allowed.join('|')})`);
  }

  switch (kind as DisplayKind) {
    case 'pre_dispatch':
      if (!(RISK_SEVERITIES as readonly unknown[]).includes(v[K.risk])) bad(K.risk, 'must be a §3 risk severity');
      if (v[K.possibleRepeat] !== null && !(PRIOR_SIDE_EFFECTS as readonly unknown[]).includes(v[K.possibleRepeat])) bad(K.possibleRepeat, `must be ${PRIOR_SIDE_EFFECTS.join('|')} or null`);
      text(K.retryOfTaskId, DISPLAY_MAX[K.retryOfTaskId], { nullable: true });
      text(K.summary, DISPLAY_MAX[K.summary], { empty: true });
      break;
    case 'codex_command': {
      if (fullText(v[K.commandLine], K.commandLine) && utf8Bytes(v[K.commandLine] as string) > COMMAND_MAX_BYTES) {
        bad(K.commandLine, `is over ${COMMAND_MAX_BYTES} UTF-8 bytes (never shortened → display_unavailable)`);
      }
      if (fullText(v[K.workingDirectory], K.workingDirectory) && utf8Bytes(v[K.workingDirectory] as string) > DISPLAY_HARD_LIMITS[K.workingDirectory].maxBytes) bad(K.workingDirectory, `is over ${DISPLAY_HARD_LIMITS[K.workingDirectory].maxBytes} UTF-8 bytes (never shortened → display_unavailable)`);
      if (!(NETWORK_ACCESS_VALUES as readonly unknown[]).includes(v[K.networkAccess])) bad(K.networkAccess, `must be ${NETWORK_ACCESS_VALUES.join('|')}`);
      list(K.escalation, 0, DISPLAY_HARD_LIMITS[K.escalation].maxEntries, DISPLAY_HARD_LIMITS[K.escalation].maxEntryCodePoints);
      text(K.reason, DISPLAY_MAX[K.reason], { nullable: true });
      break;
    }
    case 'codex_file_change':
      count(K.fileCount, pathList(K.paths));
      text(K.reason, DISPLAY_MAX[K.reason], { nullable: true });
      break;
    case 'ui_action': {
      text(K.method, METHOD_MAX);
      if (typeof v[K.method] === 'string' && !isUiActionMethod(v[K.method])) bad(K.method, 'is not a UI-action method (ruling 1z: ^(ui|window)\\.[a-z][a-z0-9_]*$)');
      const app = v[K.app];
      if (!isObj(app)) {
        bad(K.app, 'must be a plain object {appName, windowTitle, processImage}');
        break;
      }
      const p = `${K.app}.`;
      for (const k of Object.keys(app)) if (!(UI_ACTION_APP_KEYS as readonly string[]).includes(k)) bad(p + k, 'is not a field of a ui_action app');
      for (const k of UI_ACTION_APP_KEYS) if (!hasOwn(app, k)) bad(p + k, 'is required');
      textIn(app, p, K.appName, DISPLAY_MAX[K.appName]);
      textIn(app, p, K.windowTitle, DISPLAY_MAX[K.windowTitle]);
      textIn(app, p, K.processImage, DISPLAY_MAX[K.processImage]);
      const img = app[K.processImage];
      if (typeof img === 'string' && !/^[^\\/:*?"<>|]+$/.test(img)) bad(p + K.processImage, 'is a process image basename only, never a path');
      break;
    }
    case 'tool':
      text(K.method, METHOD_MAX);
      if (hasUiActionPrefix(v[K.method])) bad(K.method, 'has a ui./window. prefix (any case): only kind ui_action may use it (E01 1y follow-up)');
      text(K.targetLabel, DISPLAY_MAX[K.targetLabel]);
      switch (cat as DialogCategory) {
        case 'local_change':
          count(F.itemCount, pathList(F.targets));
          break;
        case 'delete':
        case 'overwrite':
          count(K.fileCount, pathList(K.paths));
          break;
        case 'external_send':
          list(F.recipients, 1, DISPLAY_MAX.recipientCount, DISPLAY_MAX[F.recipients]);
          text(F.channel, DISPLAY_MAX[F.channel]);
          text(F.body, DISPLAY_MAX[F.body]);
          break;
        case 'external_upload':
          text(F.path, DISPLAY_MAX[F.path]);
          text(F.destinationHost, DISPLAY_MAX[F.destinationHost]);
          if (typeof v[F.destinationHost] === 'string' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v[F.destinationHost] as string)) bad(F.destinationHost, 'is a lowercase host name');
          break;
        case 'purchase':
          text(F.merchant, DISPLAY_MAX[F.merchant]);
          text(F.amount, DISPLAY_MAX[F.amount]);
          if (typeof v[F.amount] === 'string' && !/^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$/.test(v[F.amount] as string)) bad(F.amount, 'is a decimal string, e.g. 19.99');
          if (typeof v[F.currency] !== 'string' || !/^[A-Z]{3}$/.test(v[F.currency] as string)) bad(F.currency, 'is an ISO 4217 code');
          break;
        case 'install_or_elevate':
          text(F.package, DISPLAY_MAX[F.package]);
          text(F.publisher, DISPLAY_MAX[F.publisher]);
          text(F.version, DISPLAY_MAX[F.version]);
          text(F.source, DISPLAY_MAX[F.source]);
          break;
        case 'security_setting':
          text(F.setting, DISPLAY_MAX[F.setting]);
          text(F.currentValue, DISPLAY_MAX[F.currentValue]);
          text(F.newValue, DISPLAY_MAX[F.newValue]);
          break;
      }
      break;
  }
  return { ok: out.length === 0, issues: out };
}

/** displayHash = SHA-256 (lowercase hex) of the canonical display. Throws CanonicalError on an invalid display. */
export function computeDisplayHash(d: ApprovalDisplay): string {
  const r = validateApprovalDisplay(d);
  if (!r.ok) throw new CanonicalError(`invalid ApprovalDisplay: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  return sha256Hex(canonicalJson(d));
}

/** The §2.1 pre-dispatch display, from the same values the preimage args carry (summary bound twice, ruling 1l). */
export function preDispatchDisplay(a: { readonly summary: string; readonly risk: Risk; readonly category: ApprovalCategory; readonly possibleRepeat: PriorSideEffect | null; readonly retryOfTaskId: string | null }): PreDispatchDisplay {
  if (!(KIND_COMPLETE_CATEGORIES as readonly string[]).includes(a.category)) throw new CanonicalError(`category ${a.category} has no display rule`);
  return { kind: 'pre_dispatch', category: a.category as KindCompleteCategory, risk: a.risk, possibleRepeat: a.possibleRepeat, retryOfTaskId: a.retryOfTaskId, summaryUntrusted: untrustedText(a.summary, DISPLAY_MAX[K.summary]) };
}

/**
 * The tool display (mirrors E03 `toolDisplay`): per-category `fields` must be exactly that category's keys (no base
 * keys, no count: `fileCount` / `itemCount` = String(list length) are filled in here). `method` is bound and never
 * cut. `targetLabel` is bound and cut. `bodyUntrusted` is stripped and cut. null (display_unavailable) when the method
 * has a ui./window. prefix in any case (E01 1y follow-up), the category has no tool display rule (1l / 2a), or the
 * result fails validation.
 */
export function toolDisplay(p: { readonly category: ApprovalCategory; readonly method: string; readonly targetLabel: string; readonly fields?: Readonly<Record<string, string | readonly string[]>> }): ToolDisplay | null {
  if (typeof p.method !== 'string' || hasUiActionPrefix(p.method) || typeof p.targetLabel !== 'string') return null;
  const table = DISPLAY_KIND_KEYS.tool as Readonly<Record<string, readonly string[]>>;
  if (!Object.prototype.hasOwnProperty.call(table, p.category)) return null;
  const keys = table[p.category]!;
  const counted: Readonly<Record<string, readonly [string, string]>> = { delete: [K.paths, K.fileCount], overwrite: [K.paths, K.fileCount], local_change: [F.targets, F.itemCount] };
  const count = Object.prototype.hasOwnProperty.call(counted, p.category) ? counted[p.category] : undefined;
  const d: Record<string, unknown> = { [K.kind]: 'tool', [K.category]: p.category, [K.method]: p.method, [K.targetLabel]: truncateDisplayText(p.targetLabel, DISPLAY_MAX[K.targetLabel]) };
  for (const [k, v] of Object.entries(p.fields ?? {})) {
    if (!keys.includes(k) || (TOOL_BASE as readonly string[]).includes(k) || k === count?.[1]) return null;
    if (k === F.body) {
      if (typeof v !== 'string') return null;
      d[k] = untrustedText(v, DISPLAY_MAX[F.body]);
    } else d[k] = typeof v === 'string' ? v : Array.isArray(v) ? [...v] : v;
  }
  if (count) {
    const list = d[count[0]];
    if (!Array.isArray(list)) return null;
    d[count[1]] = String(list.length);
  }
  return validateApprovalDisplay(d).ok ? (d as unknown as ToolDisplay) : null;
}

/**
 * The ui_action display (rulings 1m/1r/1v) from K8's validated window identity. Bound fields, never stripped:
 * appName, windowTitle, processImage are cut; method is never cut (2a addition: over 64 code points → null). null when the method isn't a UI-action method or a field is empty or
 * the image name is a path → display_unavailable.
 */
export function uiActionDisplay(p: { readonly category: ApprovalCategory; readonly method: string; readonly appName: string; readonly windowTitle: string; readonly processImage: string }): UiActionDisplay | null {
  const cut = (k: keyof typeof DISPLAY_MAX, x: string) => truncateDisplayText(x, DISPLAY_MAX[k]);
  const d: UiActionDisplay = {
    kind: 'ui_action',
    category: p.category as DialogCategory,
    method: p.method, // never cut (2a addition): over METHOD_MAX → null (display_unavailable)
    app: { appName: cut(K.appName, p.appName), windowTitle: cut(K.windowTitle, p.windowTitle), processImage: cut(K.processImage, p.processImage) },
  };
  return validateApprovalDisplay(d).ok ? d : null;
}

/**
 * Guard (ruling 1l, E08 confirmed; scoped by ruling 2a): a call that opens a dialog has a non-null displayHash, a call
 * that opens none has null; else denied_by_policy{display_unavailable}. `kind` = the display kind the call would bind
 * (default `tool`: tool-host gated calls). For `tool` (and `ui_action`) the dialog categories are the 1l ones, so a
 * tool read/navigate with a hash is display_unavailable. For `pre_dispatch` / `codex_*` read and navigate open a dialog
 * too (ruling 2a), so they need a hash; credential_access never has one.
 */
export function displayHashGuard(category: ApprovalCategory, displayHash: string | null, kind: DisplayKind = 'tool'): 'ok' | 'display_unavailable' {
  const dialog = (displayCategories(kind) as readonly string[]).includes(category);
  if (dialog) return typeof displayHash === 'string' && /^[0-9a-f]{64}$/.test(displayHash) ? 'ok' : 'display_unavailable';
  return displayHash === null ? 'ok' : 'display_unavailable';
}

// ------------------------------------------------------------------ Codex displays from the port input (ruling 1o)
/** CodexApprovalRequest.display: the adapter's validated params (E03 3029c7b CodexDisplayParams, mirrored exactly). */
export interface CodexCommandParams {
  readonly kind: 'codex_command';
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly networkAccess: boolean;
  /** Sandbox / permission escalations requested; its own highlighted bound field. */
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

export type DisplayBuild<D> = { readonly ok: true; readonly display: D } | { readonly ok: false; readonly reason: 'display_unavailable'; readonly why: string };
const unavailable = (why: string) => ({ ok: false, reason: 'display_unavailable', why }) as const;
const nonEmptyStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/**
 * Build the bound display of a Codex approval from the port params (E03 `codexDisplay` semantics). Command line, cwd and
 * paths and escalation entries are kept raw and in full; over a DISPLAY_HARD_LIMITS limit, missing or malformed →
 * display_unavailable. The reason (untrusted) is stripped and cut with an ellipsis; that is idempotent, so params from
 * `codexDisplayParams` rebuild to the same bytes in E03's builder.
 */
export function codexDisplay(category: ApprovalCategory, params: unknown): DisplayBuild<CodexCommandDisplay | CodexFileChangeDisplay> {
  if (!(KIND_COMPLETE_CATEGORIES as readonly string[]).includes(category)) return unavailable(`category ${category} has no display rule`);
  if (!isObj(params)) return unavailable('no display params');
  const reason = params['reason'];
  if (reason !== undefined && typeof reason !== 'string') return unavailable('reason is not a string');
  const reasonUntrusted = untrustedSlot(reason as string | undefined, DISPLAY_MAX[K.reason]);
  let display: CodexCommandDisplay | CodexFileChangeDisplay;
  if (params['kind'] === 'codex_command') {
    const { commandLine, workingDirectory, networkAccess } = params;
    const escalation = params['escalation'] ?? [];
    if (!nonEmptyStr(commandLine) || !nonEmptyStr(workingDirectory) || typeof networkAccess !== 'boolean') return unavailable('malformed command params');
    if (!Array.isArray(escalation) || !escalation.every(nonEmptyStr)) return unavailable('malformed escalation');
    if (utf8Bytes(commandLine) > COMMAND_MAX_BYTES) return unavailable(`command over ${COMMAND_MAX_BYTES} bytes`);
    if (utf8Bytes(workingDirectory) > DISPLAY_HARD_LIMITS[K.workingDirectory].maxBytes) return unavailable(`working directory over ${DISPLAY_HARD_LIMITS[K.workingDirectory].maxBytes} bytes`);
    const esc = DISPLAY_HARD_LIMITS[K.escalation];
    if (escalation.length > esc.maxEntries) return unavailable(`more than ${esc.maxEntries} escalation requests`);
    if ((escalation as string[]).some((e) => codePoints(e) > esc.maxEntryCodePoints)) return unavailable(`an escalation request over ${esc.maxEntryCodePoints} code points`);
    // Ruling 1t: nothing is stripped from the command or cwd; hidden characters are escaped when rendered.
    display = {
      kind: 'codex_command',
      category: category as KindCompleteCategory,
      commandLine,
      workingDirectory,
      networkAccess: networkAccess ? 'requested' : 'not_requested',
      escalation: [...(escalation as string[])],
      reasonUntrusted,
    };
  } else if (params['kind'] === 'codex_file_change') {
    const paths = params['paths'];
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every(nonEmptyStr)) return unavailable('malformed paths');
    if (paths.length > PATH_LIST_MAX) return unavailable(`more than ${PATH_LIST_MAX} paths`);
    if ((paths as string[]).some((x) => utf8Bytes(x) > PATH_MAX_BYTES)) return unavailable(`a path over ${PATH_MAX_BYTES} bytes`);
    display = { kind: 'codex_file_change', category: category as KindCompleteCategory, paths: [...(paths as string[])], fileCount: String(paths.length), reasonUntrusted };
  } else return unavailable('unknown display params kind');
  const r = validateApprovalDisplay(display);
  return r.ok ? { ok: true, display } : unavailable(r.issues.map((i) => `${i.path} ${i.message}`).join('; '));
}

/** The port params that rebuild exactly `d` (normalised values; reason omitted when null). */
export function codexDisplayParams(d: CodexCommandDisplay | CodexFileChangeDisplay): CodexDisplayParams {
  const reason = d.reasonUntrusted === null ? {} : { reason: d.reasonUntrusted };
  return d.kind === 'codex_command'
    ? { kind: 'codex_command', commandLine: d.commandLine, workingDirectory: d.workingDirectory, networkAccess: d.networkAccess === 'requested', escalation: [...d.escalation], ...reason }
    : { kind: 'codex_file_change', paths: [...d.paths], ...reason };
}

/** All canonical paths of a Codex file change, a move listing source then destination. */
export function fileChangePaths(changes: readonly { readonly path: string; readonly movePath: string | null }[]): string[] {
  return changes.flatMap((c) => (c.movePath === null ? [c.path] : [c.path, c.movePath]));
}

// ------------------------------------------------------------------ pure renderer helpers (ruling 1t, DOT-095 criterion 10)
/** One rendered run. `escape` and `tab` are highlighted; `trailing_whitespace` is shown visibly. */
export type RenderSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'escape'; readonly text: string; readonly codePoint: number }
  | { readonly kind: 'tab' }
  | { readonly kind: 'trailing_whitespace'; readonly text: string };
export interface RenderedText {
  readonly segments: readonly RenderSegment[];
  /** Drives the "contains hidden characters" badge. */
  readonly hiddenCharacters: boolean;
}
/** `\x1b` for C0/DEL/C1 controls, `<U+202E>` for every other hidden character (CONTRACTS ruling 1t examples). */
export function hiddenCharEscape(cp: number): string {
  return cp <= 0x9f ? `\\x${cp.toString(16).padStart(2, '0')}` : `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}
/** True when `s` contains a hidden character (ruling 1t set). */
export function hasHiddenCharacters(s: string): boolean {
  return HIDDEN_CHAR.test(s);
}
function renderRun(s: string, tabMarker: boolean): { segments: RenderSegment[]; hidden: boolean } {
  const segments: RenderSegment[] = [];
  let hidden = false;
  let buf = '';
  const flush = (): void => {
    if (buf) segments.push({ kind: 'text', text: buf });
    buf = '';
  };
  for (const ch of s) {
    if (tabMarker && ch === '\t') {
      flush();
      segments.push({ kind: 'tab' });
    } else if (HIDDEN_CHAR.test(ch)) {
      flush();
      hidden = true;
      const cp = ch.codePointAt(0)!;
      segments.push({ kind: 'escape', text: hiddenCharEscape(cp), codePoint: cp });
    } else buf += ch;
  }
  flush();
  const last = segments[segments.length - 1];
  if (last?.kind === 'text') {
    const m = / +$/.exec(last.text);
    if (m) {
      segments.pop();
      if (m.index > 0) segments.push({ kind: 'text', text: last.text.slice(0, m.index) });
      segments.push({ kind: 'trailing_whitespace', text: m[0] });
    }
  }
  return { segments, hidden };
}
/** A bound one-line field (path, label, window title, …): every hidden character, incl. tab and newline, is an escape. */
export function renderBoundText(s: string): RenderedText {
  const r = renderRun(s, false);
  return { segments: r.segments, hiddenCharacters: r.hidden };
}
/**
 * The codex_command box (ruling 1t): `\n` is a real line break and the line count is shown; `\r\n` → `\n` for DISPLAY
 * ONLY (displayHash and Codex use the raw bytes); a lone `\r` and every other hidden character render as an escape; tab
 * is a visible marker; trailing spaces are visible. LF, CRLF and tab are layout, so they don't set the badge.
 */
export function renderCodexCommand(command: string): { readonly lines: readonly (readonly RenderSegment[])[]; readonly lineCount: number; readonly hiddenCharacters: boolean } {
  let hidden = false;
  const lines = command.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const r = renderRun(line, true);
    hidden ||= r.hidden;
    return r.segments;
  });
  return { lines, lineCount: lines.length, hiddenCharacters: hidden };
}
/** Untrusted free text (Codex reason, body, summary): stripped, never escaped (ruling 1t). */
export function renderUntrustedText(s: string): string {
  return stripDisplayText(s);
}
