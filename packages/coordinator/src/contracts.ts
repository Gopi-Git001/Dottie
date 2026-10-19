/**
 * Shared event contract v2 (arch/CONTRACTS.md §3 and §5; ADR-0012, accepted by E01 2026-10-19).
 *
 * Payload field names are exactly the spec's (§7). v2 extensions accepted by E01: ApprovalRequested.category,
 * ToolResult.sideEffect/evidenceRef with object observedState/error, the 8-value outcome, and the coordinator's
 * TaskCancelled extensions. Enum values are snake_case (ADR-0012 §1).
 *
 * NOTE: the contract's home is packages/contracts (DOT-007, E01). This module is the coordinator's copy and
 * should be replaced by an import once DOT-007 lands.
 */
import { isCoordinatorState, type CoordinatorState } from './states.js';

import { displayProblems, REQUEST_SOURCES, type ApprovalDisplay, type RequestSource } from './display.js';
export const EVENT_SCHEMA = 'dottie.event' as const;
export const EVENT_SCHEMA_VERSION = 2 as const;

/** Capability scopes from spec §10. */
export const CAPABILITY_SCOPES = [
  'files.read',
  'files.write',
  'shell.execute',
  'desktop.control',
  'browser.navigate',
  'network.send',
  'app.install',
  'credentials.access',
  'purchases',
] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

export interface WorkspaceScope {
  readonly scopes: readonly CapabilityScope[];
  readonly paths: readonly string[];
}

export const RISKS = ['low', 'medium', 'high', 'critical'] as const;
export type Risk = (typeof RISKS)[number];

/** `tray`: an utterance main builds from the tray (e.g. the fixed retry text), E01 ruling 1j (c). */
export const END_REASONS = ['vad_silence', 'timeout', 'max_duration', 'user_stop', 'tray'] as const;
export type EndReason = (typeof END_REASONS)[number];

/** CONTRACTS §3 ApprovalRequested.category (ADR-0012 §4). */
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
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

/** Per-tool side-effect classification. `unknown` is treated as "may have happened". */
export const SIDE_EFFECTS = ['none', 'committed', 'unknown'] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

/** Verifier outcome (CONTRACTS §2.3, ObservedState.outcome). */
export const VERIFIER_OUTCOMES = ['verified', 'partially_verified', 'unverified', 'failed'] as const;
export type VerifierOutcome = (typeof VERIFIER_OUTCOMES)[number];

/** ObservedState.decision (CONTRACTS §5). Cancellation is `stop` + error.code CANCELLED, never a `cancelled` value. */
export const TOOL_DECISIONS = ['done', 'retry', 'ask_user', 'stop'] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

export const CHECK_RESULTS = ['pass', 'fail', 'unknown'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

/** CONTRACTS §5 ToolError.code. */
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
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** CONTRACTS §5: `retryable` may be true only when sideEffect is 'none'. */
export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** Opaque candidate id issued by a tool, with a safe label (CONTRACTS §5 candidate selection). */
export interface Candidate {
  readonly id: string;
  readonly label: string;
}

/**
 * Redacted observed state (CONTRACTS §5). Never window titles, file contents or full user paths.
 * Tool-specific scalar keys are allowed alongside the required ones.
 */
export interface ObservedState {
  readonly outcome: VerifierOutcome;
  readonly decision: ToolDecision;
  readonly checks: Readonly<Record<string, CheckResult>>;
  readonly sideEffect: SideEffect;
  readonly question?: string;
  readonly candidates?: readonly Candidate[];
  readonly [toolSpecific: string]: unknown;
}

export const TASK_OUTCOMES = [
  'succeeded', // verifier: verified (the only outcome with verified:true)
  'answered', // no tool actions, nothing to verify (conversational answer)
  'partial', // verifier: partially_verified
  'unverified', // Codex reported done but postcondition not verified
  'failed', // failed with an empty side-effect ledger
  'failed_after_side_effects', // failed after committed/possible side effects
  'declined', // user declined / confirmation expired before dispatch
  'blocked_auth', // auth gate: the account needs the user (AUTH_REQUIRED; nothing sent to Codex)
  'blocked_unavailable', // auth gate: Codex/auth unreadable (reason codex_unavailable); never a sign-in prompt
] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
/** TaskFinished.reason values that go with `blocked_auth` (CONTRACTS §2.1, §3; E01 2026-10-19). */
export const AUTH_BLOCK_REASONS = ['auth_required', 'sign_in_in_progress', 'account_unsupported'] as const;
/** Clarification-ending reasons: `clarification_timeout` = silence only; `clarification_cancelled` = capture aborted. */
export const CLARIFICATION_REASONS = ['clarification_timeout', 'clarification_cancelled'] as const;
/** Optional snake_case cause on TaskFinished (CONTRACTS §3). `codex_unavailable` goes only with `blocked_unavailable` (or `failed_after_side_effects`). */
/**
 * `retry_not_allowed` (E01 CONTRACTS 5b6b3f5/060cd60 §5 c): a user retry of a non-retryable prior; no task started,
 * goes only with `failed`.
 */
export const TASK_FINISH_REASONS = [...AUTH_BLOCK_REASONS, 'codex_unavailable', ...CLARIFICATION_REASONS, 'approval_unavailable', 'retry_not_allowed'] as const;
export type TaskFinishReason = (typeof TASK_FINISH_REASONS)[number];
export type AuthBlockReason = (typeof AUTH_BLOCK_REASONS)[number];

/**
 * Reason/outcome pairing (CONTRACTS §3 TaskFinished): blocked_auth needs an auth reason; blocked_unavailable needs
 * codex_unavailable; clarification reasons only with failed / failed_after_side_effects; declined carries none (the user
 * declined) or approval_unavailable (an approval couldn't be requested, ADR-0009 CR1); failed_after_side_effects may
 * carry any reason but retry_not_allowed (blocked or unanswered after something was committed); failed may carry a
 * clarification reason or retry_not_allowed; other outcomes carry none.
 */
export function reasonFitsOutcome(outcome: TaskOutcome, reason: TaskFinishReason | undefined): boolean {
  switch (outcome) {
    case 'blocked_auth':
      return reason !== undefined && (AUTH_BLOCK_REASONS as readonly string[]).includes(reason);
    case 'blocked_unavailable':
      return reason === 'codex_unavailable';
    case 'failed':
      return reason === undefined || reason === 'retry_not_allowed' || (CLARIFICATION_REASONS as readonly string[]).includes(reason);
    case 'declined':
      return reason === undefined || reason === 'approval_unavailable';
    case 'failed_after_side_effects':
      return reason !== 'retry_not_allowed';
    default:
      return reason === undefined;
  }
}

/**
 * TaskCancelled.stopStatus. A "clean" stop is only `stopped_before_dispatch` or `stopped_no_side_effects`.
 */
export const STOP_STATUSES = [
  'stopped_before_dispatch', // nothing was sent to Codex
  'stopped_no_side_effects', // executor acknowledged stop, ledger has no committed/possible side effects
  'stopped_after_side_effects', // executor stopped, but external actions had already happened
  'stop_unconfirmed', // executor did not acknowledge in time; work may still be running
  'completed_before_stop', // the task finished before the stop took effect
] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

export const SIDE_EFFECT_SUMMARIES = ['none', 'committed', 'possible'] as const;
export type SideEffectSummary = (typeof SIDE_EFFECT_SUMMARIES)[number];

export interface CommittedAction {
  readonly toolId: string;
  /** Last observed state; null when the tool was still running when the stop was requested. */
  readonly observedState: ObservedState | null;
  readonly certainty: 'committed' | 'possible';
}

export type RedactedMetadata = Readonly<Record<string, string | number | boolean>>;

export interface WakeDetected {
  readonly timestamp: string;
  readonly deviceId: string;
  readonly confidence: number;
}
export interface UtteranceReady {
  readonly requestId: string;
  readonly text: string;
  readonly locale: string;
  readonly endReason: EndReason;
  /**
   * D14, ACCEPTED by E01 2026-10-19: set only by the user-facing side (E05 voice intent / E06 tray "Retry") when the
   * user explicitly asks to retry task X. Codex and the model have no path to set it. Non-empty when present.
   * E01 also wants it rejected unless the source is voice or tray, but UtteranceReady (and the v2 envelope) carries no
   * source field, so validateEvent can't check that yet (reported to E01).
   */
  readonly retryOfTaskId?: string;
}
export interface TaskRequested {
  readonly taskId: string;
  readonly requestId: string;
  readonly text: string;
  readonly threadId?: string;
  readonly workspaceScope: WorkspaceScope;
}
export interface TaskProgress {
  readonly taskId: string;
  readonly state: CoordinatorState;
  readonly message: string;
  readonly toolId?: string;
  readonly redactedMetadata: RedactedMetadata;
}
export interface ApprovalRequested {
  readonly taskId: string;
  readonly actionId: string;
  readonly summary: string;
  readonly risk: Risk;
  /** ISO-8601 instant after which the request auto-denies (silence never approves, spec §10). */
  readonly expiry: string;
  /** v2 (ADR-0012 §4), required. */
  readonly category: ApprovalCategory;
  /**
   * D14 (tool-host-control §4.4, E08 ruling 4 addition (2); E01 shape 2026-10-19): this approval belongs to a user-requested
   * retry of a task whose side effect was possible/unknown. The secure UI shows 'this action may already have happened'
   * before Approve is enabled. Never present when category is 'read' or 'navigate' (E01 ruling 1g). Absent = no warning.
   */
  readonly possibleRepeat?: PossibleRepeat;
  /**
   * CONTRACTS §3 X5 (1k/1l/1o, required on every approval): the bound display the secure UI renders, a discriminated
   * union on `kind` (1r). displayHash (in the actionId preimage) covers it. Key names: display.ts (settled, E01 1v).
   */
  readonly display: ApprovalDisplay;
  /** E01 1r (E08 co-signed): set only by the coordinator from its own state; in CR2 next to displayHash. */
  readonly requestSource: RequestSource;
}
/**
 * D14: taken from the prior task's ledger / ToolResult.sideEffect (only tools whose category is not read/navigate),
 * never from a TaskOutcome or a ToolError code. Precedence when several apply: committed > unknown > possible (E01:
 * if anything definitely happened, the dialog says it already happened).
 */
export const POSSIBLE_REPEAT_SIDE_EFFECTS = ['committed', 'possible', 'unknown'] as const;
export type PossibleRepeatSideEffect = (typeof POSSIBLE_REPEAT_SIDE_EFFECTS)[number];
export interface PossibleRepeat {
  readonly priorTaskId: string;
  readonly priorSideEffect: PossibleRepeatSideEffect;
}
export interface ApprovalResolved {
  readonly actionId: string;
  readonly approved: boolean;
  readonly timestamp: string;
  /** E01 1m: coordinator → desktop only, on the C-08 timeout, with approved:false. The desktop never sends it. */
  readonly decision?: 'expired';
  /** E01 1n: desktop → coordinator only, approved:false and no decision (join condition f: differing display). */
  readonly reason?: 'display_unavailable';
}
export interface ToolResult {
  /** Always the coordinator's active taskId, never a value supplied by the model or the tool (CONTRACTS §5). */
  readonly taskId: string;
  readonly toolId: string;
  readonly observedState: ObservedState;
  /** `error` present ⇔ verified:false. verified:false is never reported as success. */
  readonly verified: boolean;
  readonly error?: ToolError;
  readonly sideEffect: SideEffect;
  readonly evidenceRef?: string;
}
export interface TaskFinished {
  readonly taskId: string;
  readonly outcome: TaskOutcome;
  readonly verified: boolean;
  readonly summary: string;
  readonly reason?: TaskFinishReason;
}
export interface TaskCancelled {
  readonly taskId: string;
  readonly stopStatus: StopStatus;
  /** EXTENSION: aggregate of side effects at the time the stop settled. */
  readonly sideEffects: SideEffectSummary;
  /** EXTENSION: true only when sideEffects === 'committed'. 'possible' is reported separately, never as clean. */
  readonly sideEffectsCommitted: boolean;
  /** EXTENSION: the actions that happened (or may have happened) before the stop. */
  readonly committedActions: readonly CommittedAction[];
  /** EXTENSION: the exact user-facing (spoken/tray) report text. */
  readonly report: string;
}

export interface EventPayloads {
  WakeDetected: WakeDetected;
  UtteranceReady: UtteranceReady;
  TaskRequested: TaskRequested;
  TaskProgress: TaskProgress;
  ApprovalRequested: ApprovalRequested;
  ApprovalResolved: ApprovalResolved;
  ToolResult: ToolResult;
  TaskFinished: TaskFinished;
  TaskCancelled: TaskCancelled;
}
export type EventType = keyof EventPayloads;
export const EVENT_TYPES: readonly EventType[] = [
  'WakeDetected',
  'UtteranceReady',
  'TaskRequested',
  'TaskProgress',
  'ApprovalRequested',
  'ApprovalResolved',
  'ToolResult',
  'TaskFinished',
  'TaskCancelled',
];

export interface EventEnvelope<T extends EventType = EventType> {
  readonly schema: typeof EVENT_SCHEMA;
  readonly version: typeof EVENT_SCHEMA_VERSION;
  readonly type: T;
  /** Unique per event. */
  readonly eventId: string;
  /** One interaction id spans wake -> utterance -> task -> response. */
  readonly correlationId: string;
  /** eventId of the event that caused this one, when known. */
  readonly causationId?: string;
  /** Routing key for task-scoped events (needed for ApprovalResolved, whose spec payload has no taskId). */
  readonly taskId?: string;
  /** ISO-8601 emission time. */
  readonly timestamp: string;
  readonly payload: EventPayloads[T];
}
export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

// ---------------------------------------------------------------------------------------------
// Runtime validation for IPC/worker boundaries (no external schema dependency).
// ---------------------------------------------------------------------------------------------

/** CONTRACTS §3 / §3.3, ADR-0009: actionId is lowercase-hex SHA-256 of the canonical binding. */
export const ACTION_ID_PATTERN = /^[0-9a-f]{64}$/;
export function isActionId(value: unknown): value is string {
  return typeof value === 'string' && ACTION_ID_PATTERN.test(value);
}

type FieldKind = 'string' | 'nonempty_string' | 'possible_repeat' | 'action_id' | 'number' | 'boolean' | 'object' | 'array' | readonly string[] | 'state' | 'observed_state' | 'tool_error';
interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
  readonly optional?: boolean;
}
const f = (name: string, kind: FieldKind, optional = false): FieldSpec => ({ name, kind, optional });

const PAYLOAD_FIELDS: Readonly<Record<EventType, readonly FieldSpec[]>> = {
  WakeDetected: [f('timestamp', 'string'), f('deviceId', 'string'), f('confidence', 'number')],
  UtteranceReady: [f('requestId', 'string'), f('text', 'string'), f('locale', 'string'), f('endReason', END_REASONS), f('retryOfTaskId', 'nonempty_string', true)],
  TaskRequested: [f('taskId', 'string'), f('requestId', 'string'), f('text', 'string'), f('threadId', 'string', true), f('workspaceScope', 'object')],
  TaskProgress: [f('taskId', 'string'), f('state', 'state'), f('message', 'string'), f('toolId', 'string', true), f('redactedMetadata', 'object')],
  ApprovalRequested: [f('taskId', 'string'), f('actionId', 'action_id'), f('summary', 'string'), f('risk', RISKS), f('expiry', 'string'), f('category', APPROVAL_CATEGORIES), f('possibleRepeat', 'possible_repeat', true), f('display', 'object'), f('requestSource', REQUEST_SOURCES)],
  ApprovalResolved: [f('actionId', 'action_id'), f('approved', 'boolean'), f('timestamp', 'string'), f('decision', ['expired'], true), f('reason', ['display_unavailable'], true)],
  ToolResult: [
    f('taskId', 'string'),
    f('toolId', 'string'),
    f('observedState', 'observed_state'),
    f('verified', 'boolean'),
    f('error', 'tool_error', true),
    f('sideEffect', SIDE_EFFECTS),
    f('evidenceRef', 'string', true),
  ],
  TaskFinished: [f('taskId', 'string'), f('outcome', TASK_OUTCOMES), f('verified', 'boolean'), f('summary', 'string'), f('reason', TASK_FINISH_REASONS, true)],
  TaskCancelled: [
    f('taskId', 'string'),
    f('stopStatus', STOP_STATUSES),
    f('sideEffects', SIDE_EFFECT_SUMMARIES),
    f('sideEffectsCommitted', 'boolean'),
    f('committedActions', 'array'),
    f('report', 'string'),
  ],
};

const OBSERVED_STATE_FIELDS: readonly FieldSpec[] = [
  f('outcome', VERIFIER_OUTCOMES),
  f('decision', TOOL_DECISIONS),
  f('checks', 'object'),
  f('sideEffect', SIDE_EFFECTS),
  f('question', 'string', true),
  f('candidates', 'array', true),
];
const TOOL_ERROR_FIELDS: readonly FieldSpec[] = [f('code', TOOL_ERROR_CODES), f('message', 'string'), f('retryable', 'boolean')];
const POSSIBLE_REPEAT_FIELDS: readonly FieldSpec[] = [f('priorTaskId', 'nonempty_string'), f('priorSideEffect', POSSIBLE_REPEAT_SIDE_EFFECTS)];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkField(obj: Record<string, unknown>, spec: FieldSpec, path: string, errors: string[]): void {
  const value = Object.hasOwn(obj, spec.name) ? obj[spec.name] : undefined; // own fields only
  if (value === undefined) {
    if (!spec.optional) errors.push(`${path}.${spec.name} is required`);
    return;
  }
  const kind = spec.kind;
  if (typeof kind !== 'string') {
    if (typeof value !== 'string' || !kind.includes(value)) errors.push(`${path}.${spec.name} must be one of ${kind.join('|')}`);
    return;
  }
  if (kind === 'action_id') {
    if (!isActionId(value)) errors.push(`${path}.${spec.name} must be 64 lowercase hex (CONTRACTS §3.3 actionId)`);
    return;
  }
  if (kind === 'observed_state') {
    if (!isRecord(value)) errors.push(`${path}.${spec.name} must be object`);
    else for (const s of OBSERVED_STATE_FIELDS) checkField(value, s, `${path}.${spec.name}`, errors);
    return;
  }
  if (kind === 'nonempty_string') {
    if (typeof value !== 'string' || value === '') errors.push(`${path}.${spec.name} must be a non-empty string`);
    return;
  }
  if (kind === 'possible_repeat') {
    // Closed shape: exactly {priorTaskId, priorSideEffect}. The superseded priorOutcome key (and any other key) is rejected.
    if (!isRecord(value)) {
      errors.push(`${path}.${spec.name} must be object`);
      return;
    }
    for (const s of POSSIBLE_REPEAT_FIELDS) checkField(value, s, `${path}.${spec.name}`, errors);
    for (const k of Object.keys(value)) if (!POSSIBLE_REPEAT_FIELDS.some(s => s.name === k)) errors.push(`${path}.${spec.name}.${k} is not allowed`);
    return;
  }
  if (kind === 'tool_error') {
    if (!isRecord(value)) errors.push(`${path}.${spec.name} must be object`);
    else for (const s of TOOL_ERROR_FIELDS) checkField(value, s, `${path}.${spec.name}`, errors);
    return;
  }
  const ok =
    kind === 'array' ? Array.isArray(value)
    : kind === 'object' ? isRecord(value)
    : kind === 'state' ? isCoordinatorState(value)
    : kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === kind;
  if (!ok) errors.push(`${path}.${spec.name} must be ${kind}`);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type ValidationResult = { readonly ok: true; readonly event: AnyEvent } | { readonly ok: false; readonly errors: readonly string[] };

/** Validate an untrusted event crossing IPC. Unknown versions are rejected, never coerced. */
export function validateEvent(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['event must be an object'] };
  if (input['schema'] !== EVENT_SCHEMA) errors.push(`schema must be ${EVENT_SCHEMA}`);
  if (input['version'] !== EVENT_SCHEMA_VERSION) errors.push(`unsupported version ${String(input['version'])}`);
  const type = input['type'];
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    errors.push('unknown event type');
    return { ok: false, errors };
  }
  for (const spec of [f('eventId', 'string'), f('correlationId', 'string'), f('causationId', 'string', true), f('taskId', 'string', true), f('timestamp', 'string')]) {
    checkField(input, spec, 'envelope', errors);
  }
  if (typeof input['timestamp'] === 'string' && !ISO.test(input['timestamp'])) errors.push('envelope.timestamp must be ISO-8601');
  const payload = input['payload'];
  if (!isRecord(payload)) {
    errors.push('payload must be an object');
  } else {
    for (const spec of PAYLOAD_FIELDS[type as EventType]) checkField(payload, spec, 'payload', errors);
    for (const key of ['timestamp', 'expiry'] as const) {
      const v = payload[key];
      if (typeof v === 'string' && !ISO.test(v)) errors.push(`payload.${key} must be ISO-8601`);
    }
    if (type === 'ToolResult') {
      const err = payload['error'];
      if ((err !== undefined) === (payload['verified'] === true)) errors.push('payload.error must be present exactly when verified is false');
      if (isRecord(err) && err['retryable'] === true && payload['sideEffect'] !== 'none') errors.push('payload.error.retryable requires sideEffect none');
    }
    if (type === 'ApprovalRequested' && payload['possibleRepeat'] !== undefined) {
      // D14: a read or navigate approval never warns (E01 ruling 1g); a task is never a repeat of itself.
      if (payload['category'] === 'read' || payload['category'] === 'navigate') errors.push(`payload.possibleRepeat is not allowed when category is ${String(payload['category'])}`);
      const pr = payload['possibleRepeat'];
      if (isRecord(pr) && pr['priorTaskId'] === payload['taskId']) errors.push('payload.possibleRepeat.priorTaskId must differ from payload.taskId');
    }
    if (type === 'ApprovalRequested' && payload['display'] !== undefined) {
      const pr = payload['possibleRepeat'];
      errors.push(...displayProblems(payload['display'], { category: payload['category'], risk: payload['risk'], priorSideEffect: isRecord(pr) ? pr['priorSideEffect'] : null, priorTaskId: isRecord(pr) ? pr['priorTaskId'] : null, requestSource: payload['requestSource'] }));
    }
    if (type === 'TaskProgress' && isRecord(payload['redactedMetadata'])) {
      // E01 1o/1q: advisory keys; awaitingClarification:true only while LISTENING for the answer (ADR-0010).
      const md = payload['redactedMetadata'];
      if (md['awaitingClarification'] !== undefined && typeof md['awaitingClarification'] !== 'boolean') errors.push('payload.redactedMetadata.awaitingClarification must be a boolean');
      if (md['turnsSoFar'] !== undefined && (typeof md['turnsSoFar'] !== 'number' || !Number.isFinite(md['turnsSoFar']))) errors.push('payload.redactedMetadata.turnsSoFar must be a number');
      if (md['awaitingClarification'] === true && payload['state'] !== 'LISTENING') errors.push('payload.redactedMetadata.awaitingClarification:true requires state LISTENING');
    }
    if (type === 'ApprovalResolved') {
      // E01 1n: additive; approved:boolean stays. Neither field may ride on a yes, and they never appear together.
      if (payload['decision'] !== undefined && payload['approved'] === true) errors.push('payload.decision expired requires approved:false');
      if (payload['reason'] !== undefined && payload['approved'] === true) errors.push('payload.reason requires approved:false');
      if (payload['decision'] !== undefined && payload['reason'] !== undefined) errors.push('payload.decision and payload.reason are mutually exclusive');
    }
    if (type === 'TaskFinished' && payload['verified'] === true && payload['outcome'] !== 'succeeded') errors.push('payload.verified:true only with outcome succeeded');
    if (type === 'TaskFinished' && (TASK_OUTCOMES as readonly unknown[]).includes(payload['outcome'])) {
      const reason = payload['reason'];
      if (reason === undefined || (TASK_FINISH_REASONS as readonly unknown[]).includes(reason)) {
        if (!reasonFitsOutcome(payload['outcome'] as TaskOutcome, reason as TaskFinishReason | undefined)) errors.push(`payload.reason ${String(reason)} does not fit outcome ${String(payload['outcome'])}`);
      }
    }
  }
  if (type === 'ApprovalResolved' && typeof input['taskId'] !== 'string') errors.push('envelope.taskId is required for ApprovalResolved');
  return errors.length ? { ok: false, errors } : { ok: true, event: input as unknown as AnyEvent };
}
