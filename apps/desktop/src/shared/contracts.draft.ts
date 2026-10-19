/**
 * ============================================================================================
 *  Local mirror of the shared event contract **v2** (arch/CONTRACTS.md §3, §3.2, §5; ADR-0012).
 *  The canonical implementation is packages/contracts (E02 branch today, DOT-007). Do NOT import
 *  this file from outside apps/desktop. When packages/contracts lands on main, delete this file
 *  and import from there; the desktop only consumes these shapes (Activity view, TaskFinished,
 *  stop status). Where E02's package and CONTRACTS disagree, this file follows CONTRACTS (see
 *  docs/contracts/desktop-ipc.DRAFT.md §5).
 * ============================================================================================
 */
import { own } from './own';
import { z } from 'zod';
import { COORDINATOR_STATES } from './states';

export const CONTRACT_STATUS = 'MIRROR_OF_CONTRACTS_V2' as const;
/** ADR-0012 §2 envelope identity. Version 1 (and any other version) is rejected, never coerced. */
export const EVENT_SCHEMA = 'dottie.event' as const;
export const EVENT_VERSION = 2 as const;

const Id = z.string().min(1).max(128);
const IsoTimestamp = z.iso.datetime({ offset: true });

// ------------------------------------------------------------------------------------ enums (§3)
/** CONTRACTS §3 `CapabilityScope` (ADR-0009 scope list, incl. `files.navigate`). */
export const CAPABILITY_SCOPES = [
  'files.read',
  'files.navigate',
  'files.write',
  'shell.execute',
  'desktop.control',
  'browser.navigate',
  'network.send',
  'app.install',
  'credentials.access',
  'purchases',
] as const;
export const RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
/** CONTRACTS §3 ApprovalRequested.category (ADR-0012 §4, incl. `navigate`). */
export const APPROVAL_CATEGORIES = [
  'read',
  'navigate',
  'local_change',
  'delete',
  'overwrite',
  'external_send',
  'external_upload',
  'purchase',
  'install_or_elevate',
  'security_setting',
  'credential_access',
] as const;
/** `tray` (E01 2026-10-19, ruling on Q3): only on main-built tray utterances (Retry last task). */
export const END_REASONS = ['vad_silence', 'timeout', 'max_duration', 'user_stop', 'tray'] as const;
export const SIDE_EFFECTS = ['none', 'committed', 'unknown'] as const;
export const SIDE_EFFECT_SUMMARIES = ['none', 'committed', 'possible'] as const;
export const VERIFIER_OUTCOMES = ['verified', 'partially_verified', 'unverified', 'failed'] as const;
export const OBSERVED_DECISIONS = ['done', 'retry', 'ask_user', 'stop'] as const;
export const CHECK_RESULTS = ['pass', 'fail', 'unknown'] as const;
/** CONTRACTS §5 ToolError.code (UPPER_SNAKE by rule). */
export const TOOL_ERROR_CODES = [
  'DENIED_BY_POLICY',
  'PERMISSION_REQUIRED',
  'APPROVAL_REQUIRED',
  'AMBIGUOUS',
  'NOT_FOUND',
  'TIMEOUT',
  'PRECONDITION_FAILED',
  'POSTCONDITION_FAILED',
  'POSTCONDITION_UNKNOWN',
  'CANCELLED',
  'INVALID_ARGUMENT',
  'USER_DECLINED',
  'INTERNAL',
] as const;

/** TaskFinished outcome (ADR-0012 §6). */
export const TASK_OUTCOMES = [
  'succeeded',
  'answered',
  'partial',
  'unverified',
  'failed',
  'failed_after_side_effects',
  'declined',
  'blocked_auth',
  'blocked_unavailable',
] as const;
/** `reason` values allowed with `blocked_auth` (CONTRACTS §2.1 auth gate). */
export const BLOCKED_AUTH_REASONS = ['auth_required', 'sign_in_in_progress', 'account_unsupported'] as const;
/** `reason` values allowed with `blocked_unavailable`. */
export const BLOCKED_UNAVAILABLE_REASONS = ['codex_unavailable'] as const;
export const CLARIFICATION_REASONS = ['clarification_timeout', 'clarification_cancelled'] as const;
/** `reason` with `declined` when an approval couldn't be requested (ADR-0009 CR1). Never "you declined". */
export const APPROVAL_UNAVAILABLE_REASONS = ['approval_unavailable'] as const;
/** The shared reason set `failed_after_side_effects` may carry (CONTRACTS §3 / §2.1). */
export const SHARED_TASK_REASONS = [...BLOCKED_AUTH_REASONS, ...BLOCKED_UNAVAILABLE_REASONS, ...CLARIFICATION_REASONS, ...APPROVAL_UNAVAILABLE_REASONS] as const;
/** `reason` paired ONLY with `failed`: a user retry was refused (E01 2026-10-19 correction to ruling 4). */
export const RETRY_REASONS = ['retry_not_allowed'] as const;
/** Every TaskFinished reason. */
export const TASK_FINISHED_REASONS = [...SHARED_TASK_REASONS, ...RETRY_REASONS] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
export type TaskFinishedReason = (typeof TASK_FINISHED_REASONS)[number];

/**
 * Outcome → reason pairing (E03 coordinator README "TaskFinished" row, CONTRACTS §3 / §2.1):
 * `required` = a reason must be present; `reasons` = the only reasons allowed.
 */
export const TASK_FINISHED_REASON_RULES: Record<TaskOutcome, { required: boolean; reasons: readonly TaskFinishedReason[] }> = {
  succeeded: { required: false, reasons: [] },
  answered: { required: false, reasons: [] },
  partial: { required: false, reasons: [] },
  unverified: { required: false, reasons: [] },
  failed: { required: false, reasons: [...CLARIFICATION_REASONS, ...RETRY_REASONS] },
  failed_after_side_effects: { required: false, reasons: SHARED_TASK_REASONS },
  declined: { required: false, reasons: APPROVAL_UNAVAILABLE_REASONS },
  blocked_auth: { required: true, reasons: BLOCKED_AUTH_REASONS },
  blocked_unavailable: { required: true, reasons: BLOCKED_UNAVAILABLE_REASONS },
};

/**
 * TaskCancelled.stopStatus (ADR-0012 §7) — the single stop enum for every package. Also the
 * desktop's `CoordinatorPort.stopTask()` result; "no task" is NOT a stop status but the separate
 * port result `{noActiveTask: true}` (CONTRACTS §3.1).
 */
export const STOP_STATUSES = ['stopped_before_dispatch', 'stopped_no_side_effects', 'stopped_after_side_effects', 'stop_unconfirmed', 'completed_before_stop'] as const;
export const StopStatusSchema = z.enum(STOP_STATUSES);
export type StopStatus = z.infer<typeof StopStatusSchema>;
/** `CoordinatorPort.stopTask()` result (CONTRACTS §3.1 / ADR-0012 §7). */
export const StopTaskResultSchema = z.union([z.strictObject({ stopStatus: StopStatusSchema }), z.strictObject({ noActiveTask: z.literal(true) })]);
export type StopTaskResult = z.infer<typeof StopTaskResultSchema>;
/** The `{noActiveTask: true}` arm of StopTaskResult (own property only; no `in`). */
export function isNoActiveTask(r: StopTaskResult): r is { noActiveTask: true } {
  return Object.hasOwn(r, 'noActiveTask');
}

// ------------------------------------------------------------------------------------ shared shapes
/** CONTRACTS §3.2 RedactedMetadata: flat scalars (incl. null), ≤ 32 keys, ≤ 2 KB. */
export const RedactedMetadataSchema = z
  .record(z.string().max(64), z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 32, 'at most 32 keys')
  .refine((m) => JSON.stringify(m).length <= 2048, 'at most 2 KB')
  // CONTRACTS §3 TaskProgress @ 6834524 (E01 ruling 1o): advisory keys, no text.
  .refine((m) => !Object.hasOwn(m, 'awaitingClarification') || typeof m['awaitingClarification'] === 'boolean', { path: ['awaitingClarification'], message: 'must be a boolean' })
  .refine((m) => !Object.hasOwn(m, 'turnsSoFar') || typeof m['turnsSoFar'] === 'number', { path: ['turnsSoFar'], message: 'must be a number' });

const Scalar = z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]);
/** CONTRACTS §5 ObservedState: redacted object; tool-specific scalar keys allowed. */
export const ObservedStateSchema = z
  .object({
    outcome: z.enum(VERIFIER_OUTCOMES),
    decision: z.enum(OBSERVED_DECISIONS),
    checks: z.record(z.string().max(64), z.enum(CHECK_RESULTS)),
    sideEffect: z.enum(SIDE_EFFECTS),
    question: z.string().max(2000).optional(),
    candidates: z.array(z.strictObject({ id: Id, label: z.string().max(256) })).max(32).optional(),
  })
  .catchall(Scalar);

export const ToolErrorSchema = z.strictObject({ code: z.enum(TOOL_ERROR_CODES), message: z.string().max(2000), retryable: z.boolean() });

// ------------------------------------------------------------------------------------ payloads (§3)
/** WakeDetected {timestamp, deviceId, confidence} — no raw audio, ever. */
export const WakeDetectedSchema = z.strictObject({
  timestamp: IsoTimestamp,
  deviceId: z.string().min(1).max(256),
  confidence: z.number().min(0).max(1),
});

export const UtteranceReadySchema = z.strictObject({
  requestId: Id,
  text: z.string().max(4000),
  locale: z.string().min(2).max(35),
  endReason: z.enum(END_REASONS),
  /**
   * D14 (ACCEPTED by E01 2026-10-19): set only by the user side (E05 voice intent, E06 tray Retry)
   * when the user explicitly asks to retry that task. Codex/the model/the renderer have no path.
   */
  retryOfTaskId: Id.optional(),
});
export type UtteranceReady = z.infer<typeof UtteranceReadySchema>;
/** Who produced an UtteranceReady; taken from the transport (port argument), never from a payload. */
/**
 * Origin-check channel ids for UtteranceReady (CONTRACTS §3 L211 @ 6834524, E01 ruling 1o): the
 * same strings as AuditRecord.sourceChannel. The transport (`submitUtterance(u, source)`), never a
 * payload field.
 */
export const VOICE_WORKER_CHANNEL = 'voice_worker' as const;
export const TRAY_IPC_CHANNEL = 'tray_ipc' as const;
export const UTTERANCE_SOURCES = [VOICE_WORKER_CHANNEL, TRAY_IPC_CHANNEL] as const;
export type UtteranceSource = (typeof UTTERANCE_SOURCES)[number];
/**
 * §3.2 AuditRecord.sourceChannel (CONTRACTS @ f4784ee, rulings 1i/1o/1w): every origin an
 * UtteranceReady can reach main from, in CONTRACTS order. `renderer_ipc` = any renderer-process
 * IPC (ruling 1w); the renderer is untrusted and never an allowed retryOfTaskId origin. Only
 * UTTERANCE_SOURCES (voice_worker, tray_ipc) may carry `retryOfTaskId` (L211, ruling 1t); main
 * strips it from the rest. Today no IPC request schema accepts an utterance at all.
 */
export const SOURCE_CHANNELS = [VOICE_WORKER_CHANNEL, TRAY_IPC_CHANNEL, 'renderer_ipc', 'model', 'codex', 'tool_host'] as const;
export const UTTERANCE_ORIGINS = SOURCE_CHANNELS;
export type UtteranceOrigin = (typeof UTTERANCE_ORIGINS)[number];

/**
 * §3.2 AuditRecord, kind `input.field_stripped` only (CONTRACTS @ f4784ee, rulings 1h/1i/1o/1w).
 * Strict: only the base record fields plus decision, field, sourceChannel, reason and taskId;
 * `channel`, `actionId`, `toolId` and the injected value are never allowed.
 */
export const InputFieldStrippedRecordSchema = z.strictObject({
  schema: z.literal('dottie.audit'),
  version: z.literal(1),
  eventId: Id,
  correlationId: Id,
  causationId: Id.optional(),
  timestamp: IsoTimestamp,
  kind: z.literal('input.field_stripped'),
  decision: z.literal('denied_by_policy'),
  field: z.enum(['retryOfTaskId', 'possibleRepeat']),
  sourceChannel: z.enum(SOURCE_CHANNELS),
  reason: z.literal('untrusted_origin'),
  taskId: Id.optional(),
});
export type InputFieldStrippedRecord = z.infer<typeof InputFieldStrippedRecordSchema>;

export const TaskRequestedSchema = z.strictObject({
  taskId: Id,
  requestId: Id,
  text: z.string().max(4000),
  threadId: Id.optional(),
  workspaceScope: z.strictObject({
    scopes: z.array(z.enum(CAPABILITY_SCOPES)).max(32),
    paths: z.array(z.string().max(1024)).max(64),
  }),
});

export const TaskProgressSchema = z
  .strictObject({
  taskId: Id,
  state: z.enum(COORDINATOR_STATES),
  message: z.string().max(2000),
  toolId: Id.optional(),
  redactedMetadata: RedactedMetadataSchema,
  })
  // CONTRACTS §3 TaskProgress (ruling 1q, ADR-0010): awaitingClarification:true only while LISTENING.
  .refine((e) => e.redactedMetadata['awaitingClarification'] !== true || e.state === 'LISTENING', {
    path: ['redactedMetadata', 'awaitingClarification'],
    message: 'awaitingClarification:true is valid only with state LISTENING',
  });

/** `possibleRepeat.priorSideEffect` (CONTRACTS §3 / tool-host-control D14; E01+E08 final ruling 2026-10-19 adds `committed`). */
export const PRIOR_SIDE_EFFECTS = ['committed', 'possible', 'unknown'] as const;
export type PriorSideEffect = (typeof PRIOR_SIDE_EFFECTS)[number];
/** Categories that never carry `possibleRepeat` (CONTRACTS §3 L214, E01 ruling 1g). */
export const NO_REPEAT_CATEGORIES: readonly string[] = ['read', 'navigate'];
export const PossibleRepeatSchema = z.strictObject({ priorTaskId: Id, priorSideEffect: z.enum(PRIOR_SIDE_EFFECTS) });

// ------------------------------------------------------------- bound approval display, X5 (§3)
/**
 * CONTRACTS §3 "Bound approval display, X5" @ dottie-e01 97e7bc0 (E01 rulings 1k/1l/1m/1o/1r/1t/1v/1w/
 * 1y/1z/2a/2b; E08 co-signed). Mirrors E02 packages/contracts/src/display.ts @ 2581593.
 *
 * Coverage (ruling 1l, scoped by ruling 2a): every category that can create a dialog has a display
 * rule. The 1l coverage rule (dialog categories only) applies to kind `tool` ONLY; `ui_action`
 * stays `local_change` or stricter (a dialog category). `pre_dispatch`, `codex_command` and
 * `codex_file_change` are complete by kind for every category INCLUDING `read` and `navigate`
 * (D14 read/navigate retry confirmation, Codex read command; C-25: fresh approval, no repeat
 * warning). `credential_access` is rejected for every kind (ruling 2b: 1l overrides 2a).
 * Ruling 2b: `display.category` equals the event's `category` for every kind; a Codex approval
 * always opens a dialog or is declined, whatever its category (never skipped as low risk).
 *
 * Ruling 1r: a discriminated union on a required `kind` (tool | ui_action | codex_command |
 * codex_file_change | pre_dispatch). Fixed key set per kind (a field that doesn't apply is `null`,
 * never omitted); unknown kinds and extra keys are rejected.
 *
 * Ruling 1v (c19b751): key names and value conventions are E03 3029c7b's `DISPLAY_KEYS`:
 * pre_dispatch carries `summaryUntrusted` (the §2.1 preimage arg stays `summary`); ui_action is
 * `{kind, category, method, app{appName, windowTitle, processImage}}` with no `targetLabel`
 * (`targetLabel` is tool-only); values are strings (flags and counts as strings: `networkAccess`
 * 'requested'|'not_requested', `fileCount`/`itemCount` = String(list length)), `escalation: []`
 * when none, untrusted slots end in `Untrusted` (`summaryUntrusted`, `reasonUntrusted`, `bodyUntrusted`).
 *
 * Limits: `DISPLAY_MAX` and `DISPLAY_HARD_LIMITS` are an exact copy (keys, shape and values) of
 * E02's committed packages/contracts/src/display.ts @ 2581593 (feature/E02-approvals-bridge).
 *
 * Hidden characters (ruling 1t; L230/L231; DOT-095 criterion 10, same as E02 2581593 validateApprovalDisplay):
 *  - `codex_command.commandLine`: raw, NOTHING stripped or rejected; the dialog renders hidden
 *    characters as visible escapes (L231, `renderCodexCommand`). Only the 8 KB limit (raw UTF-8 bytes) applies.
 *  - Untrusted free text (`summaryUntrusted`, `reasonUntrusted`, `bodyUntrusted`, E02 `STRIPPED_DISPLAY_FIELDS`):
 *    must arrive stripped (rejected otherwise).
 *  - Every other bound field (method, targetLabel, paths/targets, workingDirectory, escalation,
 *    app name, window title, process image, recipients, channel, path, host, merchant, amount,
 *    package, publisher, version, source, setting, values, retryOfTaskId): raw, hidden characters
 *    ALLOWED and never stripped; the dialog renders them as visible highlighted escapes with the
 *    "contains hidden characters" badge (`renderBoundText`, src/shared/commandRender.ts). Length
 *    limits count the raw value (code points, or raw UTF-8 bytes for paths/cwd). Format rules
 *    (1z method regex, host/amount/currency patterns, process-image basename) still apply.
 */
export const DIALOG_CATEGORIES = ['local_change', 'delete', 'overwrite', 'external_send', 'external_upload', 'purchase', 'install_or_elevate', 'security_setting'] as const;
export type DialogCategory = (typeof DIALOG_CATEGORIES)[number];
/** Ruling 2a (E02 2581593 `KIND_COMPLETE_CATEGORIES`): the dialog categories plus read and navigate; never credential_access. */
export const KIND_COMPLETE_CATEGORIES = [...DIALOG_CATEGORIES, 'read', 'navigate'] as const;
export type KindCompleteCategory = (typeof KIND_COMPLETE_CATEGORIES)[number];
/** Kinds whose display is complete by kind (ruling 2a), i.e. not subject to the tool-kind coverage rule. */
export const KIND_COMPLETE_KINDS = ['pre_dispatch', 'codex_command', 'codex_file_change'] as const;
export const DISPLAY_KINDS = ['tool', 'ui_action', 'codex_command', 'codex_file_change', 'pre_dispatch'] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];
/** The categories a display of `kind` may carry (ruling 2a; same as E02 2581593 `displayCategories`). */
export function displayCategories(kind: DisplayKind): readonly string[] {
  return (KIND_COMPLETE_KINDS as readonly string[]).includes(kind) ? KIND_COMPLETE_CATEGORIES : DIALOG_CATEGORIES;
}
/** ApprovalRequested.requestSource (ruling 1r): set only by the coordinator from its own state. */
export const REQUEST_SOURCES = ['codex', 'tool_host', 'coordinator'] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];
/** Kind/source guard (L226). */
export const DISPLAY_KIND_SOURCE: Readonly<Record<DisplayKind, RequestSource>> = {
  tool: 'tool_host',
  ui_action: 'tool_host',
  codex_command: 'codex',
  codex_file_change: 'codex',
  pre_dispatch: 'coordinator',
};
/** UI-action method (CONTRACTS ruling 1z): exactly `^(ui|window)\.[a-z][a-z0-9_]*$`; a bare `ui.` is not a method. */
export const UI_ACTION_METHOD = /^(ui|window)\.[a-z][a-z0-9_]*$/;
export const isUiActionMethod = (method: unknown): boolean => typeof method === 'string' && UI_ACTION_METHOD.test(method);
/** Ruling 1y: no tool other than a UI action may use the `ui.` / `window.` prefixes at all. */
const UI_ACTION_PREFIX = /^(ui|window)\./;

/**
 * Never cut (rulings 1o/1r/1v/2b): over a limit the display is unavailable (display_unavailable).
 * Bytes = raw UTF-8; escalation entries and method in code points. Keyed by wire key, same shape and
 * values as E02 @ 2581593. Ruling 2b: `method` is never cut (a cut method would fail the 1z regex),
 * over 64 → display_unavailable, so it moved here from DISPLAY_MAX (E02 2581593 did the same).
 */
export const DISPLAY_HARD_LIMITS = {
  commandLine: { maxBytes: 8192 },
  workingDirectory: { maxBytes: 4096 },
  paths: { maxEntries: 500, maxEntryBytes: 4096 },
  escalation: { maxEntries: 32, maxEntryCodePoints: 256 },
  method: { maxCodePoints: 64 },
} as const;
export const COMMAND_MAX_BYTES = DISPLAY_HARD_LIMITS.commandLine.maxBytes;
export const PATH_LIST_MAX = DISPLAY_HARD_LIMITS.paths.maxEntries;
export const METHOD_MAX = DISPLAY_HARD_LIMITS.method.maxCodePoints;
/** Cut fields: maximum length in code points (builders cut with an ellipsis), keyed by wire key (E02 @ 2581593). */
export const DISPLAY_MAX = {
  summaryUntrusted: 500,
  reasonUntrusted: 500,
  windowTitle: 256,
  targetLabel: 256,
  appName: 128,
  processImage: 260,
  retryOfTaskId: 128,
  /** external_upload's single path (not a path list). */
  path: 1024,
  /** Per recipient; at most recipientCount recipients. */
  recipients: 254,
  recipientCount: 20,
  channel: 64,
  bodyUntrusted: 200,
  package: 128,
  publisher: 128,
  version: 64,
  source: 256,
  merchant: 128,
  amount: 32,
  destinationHost: 253,
  setting: 128,
  currentValue: 256,
  newValue: 256,
} as const;
export const DISPLAY_ELLIPSIS = '\u2026';
export const NETWORK_ACCESS_VALUES = ['requested', 'not_requested'] as const;

/**
 * Hidden characters (ruling 1t set, same as E02): C0/C1 controls, DEL, bidi marks/embeddings/
 * overrides/isolates, zero-width and invisible format characters (ZWSP/ZWNJ/ZWJ, word joiners,
 * BOM, soft hyphen, CGJ, Mongolian vowel separator, Hangul fillers, Khmer vowels, interlinear
 * annotation, tag characters).
 */
// eslint-disable-next-line no-control-regex, no-misleading-character-class -- matching lone control/combining/format characters is the point (X5)
export const HIDDEN_CHAR = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points on purpose (E02 counts like Python len(str))
const codePoints = (s: string): number => [...s].length;
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;
const noHidden = (v: string): boolean => !HIDDEN_CHAR.test(v);
const noLoneSurrogate = (v: string): boolean => !LONE_SURROGATE.test(v);
/** Untrusted free text (summary/reason/body): length-capped and must arrive with hidden characters STRIPPED (ruling 1t). */
const strippedText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => codePoints(v) <= max, `at most ${max} code points (truncate with an ellipsis)`)
    .refine(noHidden, 'untrusted free text must have hidden characters stripped (ruling 1t)')
    .refine(noLoneSurrogate, 'contains a lone surrogate');
/** A cut bound field: length-capped (raw code points); hidden characters allowed, rendered as escapes (L230, DOT-095). */
const boundText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => codePoints(v) <= max, `at most ${max} code points (truncate with an ellipsis)`)
    .refine(noLoneSurrogate, 'contains a lone surrogate');
/** An untrusted free-text slot that is null when absent or blank (E03 rule). */
/** A bound text field that is NEVER cut (ruling 2b: method): over the limit → display_unavailable. */
const neverCutText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => codePoints(v) <= max, `at most ${max} code points (never cut: display_unavailable)`)
    .refine(noLoneSurrogate, 'contains a lone surrogate');
const untrustedSlot = (max: number) =>
  strippedText(max)
    .refine((v) => v.trim() !== '', 'is null when blank')
    .nullable();
/** A bound path (listed path, workingDirectory): never shortened; raw UTF-8 bytes counted; hidden characters allowed (escaped when rendered). */
const fullPath = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((v) => utf8Bytes(v) <= maxBytes, `over ${maxBytes} UTF-8 bytes (never shortened: display_unavailable)`)
    .refine((v) => !v.endsWith(DISPLAY_ELLIPSIS), 'a path is never shortened with an ellipsis')
    .refine(noLoneSurrogate, 'contains a lone surrogate');
const pathList = z.array(fullPath(DISPLAY_HARD_LIMITS.paths.maxEntryBytes)).min(1).max(PATH_LIST_MAX);
/** Counts are the list length as a decimal string (ruling 1v / E03 convention). */
const countString = z.string().regex(/^[1-9][0-9]*$/, 'a decimal count string');
const countMatches = (count: string, n: number): boolean => count === String(n);
const dialogCategory = z.enum(DIALOG_CATEGORIES);
/** Ruling 2a: pre_dispatch / codex_* may carry any category but credential_access. */
const kindCompleteCategory = z.enum(KIND_COMPLETE_CATEGORIES);
const toolBase = {
  kind: z.literal('tool'),
  /** The tool id; never a UI-action method (those are kind ui_action). */
  method: neverCutText(METHOD_MAX).refine((m) => !UI_ACTION_PREFIX.test(m), 'uses the ui./window. prefix reserved for UI actions (ruling 1y): use kind ui_action'),
  /** Built from validated args; never model text. */
  targetLabel: boundText(DISPLAY_MAX.targetLabel),
};
export const ToolDisplaySchema = z.discriminatedUnion('category', [
  z
    .strictObject({ ...toolBase, category: z.literal('local_change'), targets: pathList, itemCount: countString })
    .refine((d) => countMatches(d.itemCount, d.targets.length), { path: ['itemCount'], message: 'is the list length as a decimal string' }),
  z
    // Ruling 1z: delete/overwrite always carry paths[] and fileCount, also for a single item (both required).
    .strictObject({ ...toolBase, category: z.literal('delete'), paths: pathList, fileCount: countString })
    .refine((d) => countMatches(d.fileCount, d.paths.length), { path: ['fileCount'], message: 'is the list length as a decimal string' }),
  z
    .strictObject({ ...toolBase, category: z.literal('overwrite'), paths: pathList, fileCount: countString })
    .refine((d) => countMatches(d.fileCount, d.paths.length), { path: ['fileCount'], message: 'is the list length as a decimal string' }),
  z.strictObject({
    ...toolBase,
    category: z.literal('external_send'),
    recipients: z.array(boundText(DISPLAY_MAX.recipients)).min(1).max(DISPLAY_MAX.recipientCount),
    channel: boundText(DISPLAY_MAX.channel),
    /** Untrusted; stripped, at most 200 code points. */
    bodyUntrusted: strippedText(DISPLAY_MAX.bodyUntrusted),
  }),
  z.strictObject({
    ...toolBase,
    category: z.literal('external_upload'),
    path: boundText(DISPLAY_MAX.path),
    destinationHost: boundText(DISPLAY_MAX.destinationHost).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'lowercase host name'),
  }),
  z.strictObject({
    ...toolBase,
    category: z.literal('purchase'),
    merchant: boundText(DISPLAY_MAX.merchant),
    amount: boundText(DISPLAY_MAX.amount).regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$/, 'decimal string'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code'),
  }),
  z.strictObject({
    ...toolBase,
    category: z.literal('install_or_elevate'),
    package: boundText(DISPLAY_MAX.package),
    publisher: boundText(DISPLAY_MAX.publisher),
    version: boundText(DISPLAY_MAX.version),
    source: boundText(DISPLAY_MAX.source),
  }),
  z.strictObject({
    ...toolBase,
    category: z.literal('security_setting'),
    setting: boundText(DISPLAY_MAX.setting),
    currentValue: boundText(DISPLAY_MAX.currentValue),
    newValue: boundText(DISPLAY_MAX.newValue),
  }),
]);
/** UI actions inside apps (rulings 1m/1v): no targetLabel; app name, window title (untrusted), process image basename. */
export const UiActionDisplaySchema = z.strictObject({
  kind: z.literal('ui_action'),
  category: dialogCategory,
  method: neverCutText(METHOD_MAX).refine(isUiActionMethod, 'is not a UI-action method (^(ui|window)\\.[a-z][a-z0-9_]*$, ruling 1z)'),
  app: z.strictObject({
    appName: boundText(DISPLAY_MAX.appName),
    windowTitle: boundText(DISPLAY_MAX.windowTitle),
    processImage: boundText(DISPLAY_MAX.processImage).refine((v) => /^[^\\/:*?"<>|]+$/.test(v), 'basename only, never a path'),
  }),
});
/**
 * Codex command approval (L221/L231). `commandLine` is the raw command: never shortened, nothing
 * stripped, control/bidi/invisible characters allowed (ruling 1t: rendered as visible escapes);
 * at most 8192 UTF-8 bytes, escapes counted at their raw byte length. Only this field relaxed.
 */
export const CodexCommandDisplaySchema = z.strictObject({
  kind: z.literal('codex_command'),
  category: kindCompleteCategory,
  commandLine: z
    .string()
    .min(1)
    .refine((v) => utf8Bytes(v) <= COMMAND_MAX_BYTES, `over ${COMMAND_MAX_BYTES} UTF-8 bytes (never shortened: display_unavailable)`)
    .refine(noLoneSurrogate, 'contains a lone surrogate'),
  workingDirectory: fullPath(DISPLAY_HARD_LIMITS.workingDirectory.maxBytes),
  networkAccess: z.enum(NETWORK_ACCESS_VALUES),
  /** Sandbox/escalation requests: its own highlighted bound field; [] when none. */
  escalation: z
    .array(
      z
        .string()
        .min(1)
        .refine((v) => codePoints(v) <= DISPLAY_HARD_LIMITS.escalation.maxEntryCodePoints, `at most ${DISPLAY_HARD_LIMITS.escalation.maxEntryCodePoints} code points`)
        .refine(noLoneSurrogate, 'contains a lone surrogate'),
    )
    .max(DISPLAY_HARD_LIMITS.escalation.maxEntries),
  /** Codex's reason (model text): untrusted slot only, never the title. */
  reasonUntrusted: untrustedSlot(DISPLAY_MAX.reasonUntrusted),
});
export const CodexFileChangeDisplaySchema = z
  .strictObject({
    kind: z.literal('codex_file_change'),
    category: kindCompleteCategory,
    /** Every path the change touches, never shortened, 1-500. */
    paths: pathList,
    /** = String(paths.length) (ruling 1v). */
    fileCount: countString,
    reasonUntrusted: untrustedSlot(DISPLAY_MAX.reasonUntrusted),
  })
  .refine((d) => countMatches(d.fileCount, d.paths.length), { path: ['fileCount'], message: 'is the list length as a decimal string' });
/** §2.1 pre-dispatch confirmation display (ruling 1l), built by the coordinator. */
export const PreDispatchDisplaySchema = z.strictObject({
  kind: z.literal('pre_dispatch'),
  category: kindCompleteCategory,
  risk: z.enum(RISK_SEVERITIES),
  possibleRepeat: z.enum(PRIOR_SIDE_EFFECTS).nullable(),
  retryOfTaskId: boundText(DISPLAY_MAX.retryOfTaskId).nullable(),
  /** Untrusted-labelled slot (ruling 1v key); may be empty after stripping (E02). */
  summaryUntrusted: z
    .string()
    .refine((v) => codePoints(v) <= DISPLAY_MAX.summaryUntrusted, `at most ${DISPLAY_MAX.summaryUntrusted} code points`)
    .refine(noHidden, 'untrusted free text must have hidden characters stripped (ruling 1t)')
    .refine(noLoneSurrogate, 'contains a lone surrogate'),
});
export const ApprovalDisplaySchema = z.discriminatedUnion('kind', [ToolDisplaySchema, UiActionDisplaySchema, CodexCommandDisplaySchema, CodexFileChangeDisplaySchema, PreDispatchDisplaySchema]);
export type ApprovalDisplay = z.infer<typeof ApprovalDisplaySchema>;
export type CodexCommandDisplay = z.infer<typeof CodexCommandDisplaySchema>;
export type CodexFileChangeDisplay = z.infer<typeof CodexFileChangeDisplaySchema>;

/**
 * ApprovalRequested (CONTRACTS §3 L215 @ 97e7bc0). `display` (X5, ruling 1k) and `requestSource`
 * (ruling 1r, coordinator-set) are required; `display.category` must equal `category` for every
 * kind (ruling 2b). `possibleRepeat` (D14 / C-25) is rejected with `read` or `navigate` (ruling 1g),
 * so a pre_dispatch read/navigate display always has `possibleRepeat: null` (consistency check).
 * Ruling 2a: read/navigate are valid only with a pre_dispatch / codex_* display; a tool or ui_action
 * display can't carry them. Ruling 1r adds the kind/source guard and the pre_dispatch consistency
 * check (L225/L226).
 * Not checkable here (no field on the event): pre_dispatch's `method:'dottie.pre_dispatch_confirmation'`
 * and the P27 list of UI-action methods; both are CR2/K8 checks.
 */
export const ApprovalRequestedSchema = z
  .strictObject({
    taskId: Id,
    actionId: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase-hex SHA-256'),
    summary: z.string().max(2000),
    risk: z.enum(RISK_SEVERITIES),
    expiry: IsoTimestamp,
    // credential_access never produces a request (DENIED_BY_POLICY).
    category: z.enum(APPROVAL_CATEGORIES).exclude(['credential_access']),
    display: ApprovalDisplaySchema,
    requestSource: z.enum(REQUEST_SOURCES),
    possibleRepeat: PossibleRepeatSchema.optional(),
  })
  // CONTRACTS §3 L215 (E01 ruling 1g): rejected with `read` or `navigate`.
  .refine((e) => !(NO_REPEAT_CATEGORIES.includes(e.category) && e.possibleRepeat !== undefined), {
    path: ['possibleRepeat'],
    message: 'possibleRepeat is not allowed with category read or navigate',
  })
  // Coverage (ruling 1l, scoped per kind by ruling 2a): a category with no display rule for the display's kind is rejected.
  .refine((e) => displayCategories(e.display.kind).includes(e.category), {
    path: ['category'],
    message: 'category has no display rule for this display kind (ruling 2a: tool/ui_action dialog categories only)',
  })
  // Ruling 2b: for EVERY kind.
  .refine((e) => e.display.category === e.category, { path: ['display', 'category'], message: 'display.category must equal category (ruling 2b, every kind)' })
  // Kind/source guard (ruling 1r, L226).
  .refine((e) => own(DISPLAY_KIND_SOURCE, e.display.kind) === e.requestSource, { path: ['requestSource'], message: 'display.kind does not fit requestSource' })
  // pre_dispatch consistency (ruling 1r, L225).
  .superRefine((e, ctx) => {
    const d = e.display;
    if (d.kind !== 'pre_dispatch') return;
    const add = (key: string, message: string): void => ctx.addIssue({ code: 'custom', path: ['display', key], message });
    if (d.risk !== e.risk) add('risk', 'pre_dispatch display.risk must equal risk');
    if (d.possibleRepeat !== (e.possibleRepeat?.priorSideEffect ?? null)) add('possibleRepeat', 'pre_dispatch display.possibleRepeat must equal possibleRepeat.priorSideEffect (null when absent)');
    if (e.possibleRepeat !== undefined && d.retryOfTaskId !== e.possibleRepeat.priorTaskId) add('retryOfTaskId', 'pre_dispatch display.retryOfTaskId must equal possibleRepeat.priorTaskId');
  });
export type ApprovalRequested = z.infer<typeof ApprovalRequestedSchema>;
export type ApprovalCategory = ApprovalRequested['category'];
/**
 * Ruling 2b: just enough of an ApprovalRequested to answer it (taskId + actionId). Used only to
 * DECLINE a Codex request that failed full validation, so it is never silently dropped.
 */
export const ApprovalIdentitySchema = z.object({ taskId: Id, actionId: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * ApprovalResolved (CONTRACTS §3 @ 0d53abc, E01 rulings 1m/1n; additive, `approved: boolean` stays):
 *  - `decision?: 'expired'`: coordinator → desktop only, on the C-08 timeout (one per joined
 *    request), always with `approved:false`. The desktop closes the dialog; it never sends one.
 *  - `reason?: 'display_unavailable'`: desktop → coordinator only, with `approved:false` and no
 *    `decision`, for the join-mismatch fail-closed case (join condition (f)).
 * `validateEvent` rejects `decision` with `approved:true`, `reason` with `approved:true`, and both together.
 */
export const APPROVAL_RESOLVED_DECISIONS = ['expired'] as const;
export const APPROVAL_RESOLVED_REASONS = ['display_unavailable'] as const;
export const ApprovalResolvedFields = {
  actionId: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase-hex SHA-256'),
  approved: z.boolean(),
  timestamp: IsoTimestamp,
  decision: z.enum(APPROVAL_RESOLVED_DECISIONS).optional(),
  reason: z.enum(APPROVAL_RESOLVED_REASONS).optional(),
};
type ResolvedLike = { approved: boolean; decision?: string | undefined; reason?: string | undefined };
export function approvalResolvedIssues(e: ResolvedLike): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (e.decision !== undefined && e.approved) out.push({ path: 'decision', message: "decision 'expired' requires approved:false" });
  if (e.reason !== undefined && e.approved) out.push({ path: 'reason', message: 'reason requires approved:false' });
  if (e.decision !== undefined && e.reason !== undefined) out.push({ path: 'reason', message: 'decision and reason are mutually exclusive' });
  return out;
}
export const ApprovalResolvedSchema = z.strictObject(ApprovalResolvedFields).superRefine((e, ctx) => {
  for (const i of approvalResolvedIssues(e)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
});
export type ApprovalResolved = z.infer<typeof ApprovalResolvedSchema>;

export const ToolResultSchema = z
  .strictObject({
    taskId: Id,
    toolId: Id,
    observedState: ObservedStateSchema,
    verified: z.boolean(),
    error: ToolErrorSchema.optional(),
    sideEffect: z.enum(SIDE_EFFECTS),
    evidenceRef: Id.optional(),
  })
  .superRefine((e, ctx) => {
    if ((e.error !== undefined) === e.verified) ctx.addIssue({ code: 'custom', path: ['error'], message: 'error must be present exactly when verified is false' });
    if (e.error?.retryable === true && e.sideEffect !== 'none') ctx.addIssue({ code: 'custom', path: ['error', 'retryable'], message: "retryable only when sideEffect is 'none'" });
  });

/**
 * TaskFinished {taskId, outcome, verified, summary, reason?}. The outcome/reason pairing follows
 * TASK_FINISHED_REASON_RULES (E03 README, CONTRACTS §3/§2.1); `verified:true` ⇔ `succeeded`
 * (ADR-0012 §6).
 */
export const TaskFinishedSchema = z
  .strictObject({
    taskId: Id,
    outcome: z.enum(TASK_OUTCOMES),
    verified: z.boolean(),
    summary: z.string().max(2000),
    reason: z.enum(TASK_FINISHED_REASONS).optional(),
  })
  .superRefine((e, ctx) => {
    const rule = own(TASK_FINISHED_REASON_RULES, e.outcome);
    if (rule === undefined) {
      ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'unknown outcome' });
      return;
    }
    if (e.reason === undefined && rule.required) ctx.addIssue({ code: 'custom', path: ['reason'], message: `${e.outcome} requires a reason (${rule.reasons.join('|')})` });
    if (e.reason !== undefined && !rule.reasons.includes(e.reason))
      ctx.addIssue({ code: 'custom', path: ['reason'], message: rule.reasons.length ? `${e.outcome} allows only ${rule.reasons.join('|')}` : `${e.outcome} carries no reason` });
    if (e.verified !== (e.outcome === 'succeeded')) ctx.addIssue({ code: 'custom', path: ['verified'], message: 'verified:true exactly with succeeded' });
  });
export type TaskFinished = z.infer<typeof TaskFinishedSchema>;

/** TaskCancelled {taskId, stopStatus} + accepted coordinator extensions (CONTRACTS §3). */
export const TaskCancelledSchema = z
  .strictObject({
    taskId: Id,
    stopStatus: StopStatusSchema,
    sideEffects: z.enum(SIDE_EFFECT_SUMMARIES),
    sideEffectsCommitted: z.boolean(),
    committedActions: z.array(z.strictObject({ toolId: Id, observedState: ObservedStateSchema, certainty: z.enum(['committed', 'possible']) })).max(64),
    report: z.string().max(4000),
  })
  .superRefine((e, ctx) => {
    if ((e.sideEffects === 'committed') !== e.sideEffectsCommitted) ctx.addIssue({ code: 'custom', path: ['sideEffectsCommitted'], message: "true exactly when sideEffects is 'committed'" });
  });

export const EVENT_SCHEMAS = {
  WakeDetected: WakeDetectedSchema,
  UtteranceReady: UtteranceReadySchema,
  TaskRequested: TaskRequestedSchema,
  TaskProgress: TaskProgressSchema,
  ApprovalRequested: ApprovalRequestedSchema,
  ApprovalResolved: ApprovalResolvedSchema,
  ToolResult: ToolResultSchema,
  TaskFinished: TaskFinishedSchema,
  TaskCancelled: TaskCancelledSchema,
} as const;
export type EventType = keyof typeof EVENT_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

// ------------------------------------------------------------------------------------ envelope (ADR-0012 §2)
/** `{schema:'dottie.event', version:2, type, eventId, correlationId, causationId?, taskId?, timestamp, payload}`. */
function envelope<T extends EventType>(type: T) {
  return z.strictObject({
    schema: z.literal(EVENT_SCHEMA),
    version: z.literal(EVENT_VERSION),
    type: z.literal(type),
    eventId: Id,
    correlationId: Id,
    causationId: Id.optional(),
    taskId: Id.optional(),
    timestamp: IsoTimestamp,
    payload: EVENT_SCHEMAS[type],
  });
}

export const EventEnvelopeSchema = z
  .discriminatedUnion('type', [
    envelope('WakeDetected'),
    envelope('UtteranceReady'),
    envelope('TaskRequested'),
    envelope('TaskProgress'),
    envelope('ApprovalRequested'),
    envelope('ApprovalResolved'),
    envelope('ToolResult'),
    envelope('TaskFinished'),
    envelope('TaskCancelled'),
  ])
  .superRefine((e, ctx) => {
    // ApprovalResolved's spec payload has no taskId; the envelope must carry it (CONTRACTS §3).
    if (e.type === 'ApprovalResolved' && e.taskId === undefined) ctx.addIssue({ code: 'custom', path: ['taskId'], message: 'envelope taskId is required for ApprovalResolved' });
  });
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
