/**
 * Runtime validation for events crossing IPC / worker boundaries (CONTRACTS §4). Unknown versions are rejected, never
 * coerced (ADR-0012 §2): a v1 producer fails loudly. Unknown payload keys are rejected so a stale spelling cannot slip
 * through; ObservedState is the one open object (tool-specific scalar keys).
 */
import {
  APPROVAL_CATEGORIES,
  CAPABILITY_SCOPES,
  CHECK_RESULTS,
  COORDINATOR_STATES,
  END_REASONS,
  FORBIDDEN_CATEGORIES,
  OBSERVED_DECISIONS,
  PRIOR_SIDE_EFFECTS,
  REQUEST_SOURCES,
  APPROVAL_RESOLVED_DECISIONS,
  APPROVAL_RESOLVED_REASONS,
  RISK_SEVERITIES,
  SIDE_EFFECTS,
  SIDE_EFFECT_SUMMARIES,
  STOP_STATUSES,
  TASK_OUTCOMES,
  TASK_FINISHED_REASONS,
  taskFinishedReasonFits,
  TOOL_ERROR_CODES,
  VERIFIER_OUTCOMES,
  type ApprovalCategory,
} from './enums.js';
import { hasOwn, isPlainArray, isPlainObject } from './canonical.js';
import { DISPLAY_KIND_SOURCE, DISPLAY_KINDS, validateApprovalDisplay, type DisplayKind } from './display.js';
import { EVENT_SCHEMA, EVENT_TYPES, EVENT_VERSION, REDACTED_METADATA_MAX_BYTES, REDACTED_METADATA_MAX_KEYS, type AnyEvent, type EventType } from './events.js';

export interface ValidationIssue {
  /** Dotted path of the offending value, e.g. `payload.category`. */
  readonly path: string;
  readonly message: string;
}
export type ValidationResult =
  | { readonly ok: true; readonly event: AnyEvent }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

type Check = (value: unknown, path: string, issues: ValidationIssue[]) => void;

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Plain data objects only (E03 report): prototype Object.prototype or null, own enumerable data keys (isPlainObject). */
const isRecord = isPlainObject;

const str: Check = (v, p, i) => {
  if (typeof v !== 'string') i.push({ path: p, message: 'must be a string' });
};
const nonEmpty: Check = (v, p, i) => {
  if (typeof v !== 'string' || v.length === 0) i.push({ path: p, message: 'must be a non-empty string' });
};
const bool: Check = (v, p, i) => {
  if (typeof v !== 'boolean') i.push({ path: p, message: 'must be a boolean' });
};
const iso: Check = (v, p, i) => {
  if (typeof v !== 'string' || !ISO_WITH_OFFSET.test(v) || Number.isNaN(Date.parse(v))) {
    i.push({ path: p, message: 'must be an ISO-8601 timestamp with an offset' });
  }
};
const unitInterval: Check = (v, p, i) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) i.push({ path: p, message: 'must be a number in 0..1' });
};
const oneOf =
  (values: readonly string[]): Check =>
  (v, p, i) => {
    if (typeof v !== 'string' || !values.includes(v)) i.push({ path: p, message: `must be one of ${values.join('|')}` });
  };
const arrayOf =
  (item: Check): Check =>
  (v, p, i) => {
    if (!isPlainArray(v)) {
      i.push({ path: p, message: 'must be a plain dense array' });
      return;
    }
    v.forEach((el, idx) => item(el, `${p}[${idx}]`, i));
  };

interface Field {
  readonly check: Check;
  readonly optional?: boolean;
}
/** Shape only; the X5 display rules run in invariants() after the category rules, so those keep their own messages. */
const objectShape: Check = (v, p, i) => {
  if (!isPlainObject(v)) i.push({ path: p, message: 'must be a plain object' });
};
const req = (check: Check): Field => ({ check });
const opt = (check: Check): Field => ({ check, optional: true });

function objectOf(fields: Readonly<Record<string, Field>>, open?: Check): Check {
  return (v, p, i) => {
    if (!isRecord(v)) {
      i.push({ path: p, message: 'must be an object' });
      return;
    }
    for (const [name, field] of Object.entries(fields)) {
      const value = hasOwn(v, name) ? v[name] : undefined;
      if (value === undefined) {
        if (!field.optional) i.push({ path: `${p}.${name}`, message: 'is required' });
        continue;
      }
      field.check(value, `${p}.${name}`, i);
    }
    for (const key of Object.keys(v)) {
      if (hasOwn(fields, key)) continue;
      if (open) open(v[key], `${p}.${key}`, i);
      else i.push({ path: `${p}.${key}`, message: 'is not a v2 field' });
    }
  };
}

const scalar: Check = (v, p, i) => {
  const ok = v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
  if (!ok) i.push({ path: p, message: 'tool-specific observedState keys must be scalars' });
};

const checksMap: Check = (v, p, i) => {
  if (!isRecord(v)) {
    i.push({ path: p, message: 'must be an object' });
    return;
  }
  for (const [k, r] of Object.entries(v)) oneOf(CHECK_RESULTS)(r, `${p}.${k}`, i);
};

const observedState: Check = objectOf(
  {
    outcome: req(oneOf(VERIFIER_OUTCOMES)),
    decision: req(oneOf(OBSERVED_DECISIONS)),
    checks: req(checksMap),
    sideEffect: req(oneOf(SIDE_EFFECTS)),
    question: opt(str),
    candidates: opt(arrayOf(objectOf({ id: req(nonEmpty), label: req(str) }))),
  },
  scalar,
);

const toolError: Check = objectOf({ code: req(oneOf(TOOL_ERROR_CODES)), message: req(str), retryable: req(bool) });

const workspaceScope: Check = objectOf({ scopes: req(arrayOf(oneOf(CAPABILITY_SCOPES))), paths: req(arrayOf(str)) });

const redactedMetadata: Check = (v, p, i) => {
  if (!isRecord(v)) {
    i.push({ path: p, message: 'must be an object' });
    return;
  }
  const entries = Object.entries(v);
  for (const [k, val] of entries) {
    const ok = val === null || typeof val === 'string' || typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val));
    if (!ok) i.push({ path: `${p}.${k}`, message: 'must be a string, number, boolean or null' });
  }
  if (entries.length > REDACTED_METADATA_MAX_KEYS) i.push({ path: p, message: `at most ${REDACTED_METADATA_MAX_KEYS} keys (§3.2)` });
  const bytes = new TextEncoder().encode(JSON.stringify(v)).length;
  if (bytes > REDACTED_METADATA_MAX_BYTES) i.push({ path: p, message: `at most ${REDACTED_METADATA_MAX_BYTES} bytes as JSON (§3.2)` });
};

/** §3 ApprovalRequested: actionId = lowercase-hex SHA-256 (ADR-0009 CR2). */
const sha256Hex: Check = (v, p, i) => {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) i.push({ path: p, message: 'must be a lowercase-hex SHA-256' });
};

const PAYLOADS: Readonly<Record<EventType, Check>> = {
  WakeDetected: objectOf({ timestamp: req(iso), deviceId: req(nonEmpty), confidence: req(unitInterval) }),
  UtteranceReady: objectOf({ requestId: req(nonEmpty), text: req(str), locale: req(nonEmpty), endReason: req(oneOf(END_REASONS)), retryOfTaskId: opt(nonEmpty) }),
  TaskRequested: objectOf({
    taskId: req(nonEmpty),
    requestId: req(nonEmpty),
    text: req(str),
    threadId: opt(nonEmpty),
    workspaceScope: req(workspaceScope),
  }),
  TaskProgress: objectOf({
    taskId: req(nonEmpty),
    state: req(oneOf(COORDINATOR_STATES)),
    message: req(str),
    toolId: opt(nonEmpty),
    redactedMetadata: req(redactedMetadata),
  }),
  ApprovalRequested: objectOf({
    taskId: req(nonEmpty),
    actionId: req(sha256Hex),
    summary: req(str),
    risk: req(oneOf(RISK_SEVERITIES)),
    expiry: req(iso),
    category: req(oneOf(APPROVAL_CATEGORIES)),
    possibleRepeat: opt(objectOf({ priorTaskId: req(nonEmpty), priorSideEffect: req(oneOf(PRIOR_SIDE_EFFECTS)) })),
    display: req(objectShape),
    requestSource: req(oneOf(REQUEST_SOURCES)),
  }),
  ApprovalResolved: objectOf({
    actionId: req(sha256Hex),
    approved: req(bool),
    timestamp: req(iso),
    decision: opt(oneOf(APPROVAL_RESOLVED_DECISIONS)),
    reason: opt(oneOf(APPROVAL_RESOLVED_REASONS)),
  }),
  ToolResult: objectOf({
    taskId: req(nonEmpty),
    toolId: req(nonEmpty),
    observedState: req(observedState),
    verified: req(bool),
    error: opt(toolError),
    sideEffect: req(oneOf(SIDE_EFFECTS)),
    evidenceRef: opt(nonEmpty),
  }),
  TaskFinished: objectOf({ taskId: req(nonEmpty), outcome: req(oneOf(TASK_OUTCOMES)), verified: req(bool), summary: req(str), reason: opt(oneOf(TASK_FINISHED_REASONS)) }),
  TaskCancelled: objectOf({
    taskId: req(nonEmpty),
    stopStatus: req(oneOf(STOP_STATUSES)),
    sideEffects: req(oneOf(SIDE_EFFECT_SUMMARIES)),
    sideEffectsCommitted: req(bool),
    committedActions: req(
      arrayOf(objectOf({ toolId: req(nonEmpty), observedState: req(observedState), certainty: req(oneOf(['committed', 'possible'])) })),
    ),
    report: req(str),
  }),
};

/** Cross-field rules from CONTRACTS §3/§5 and ADR-0012 §4, §6, §8. Run only when the shape is valid. */
function invariants(type: EventType, envelope: Record<string, unknown>, payload: Record<string, unknown>, i: ValidationIssue[]): void {
  switch (type) {
    case 'ApprovalRequested':
      if (FORBIDDEN_CATEGORIES.has(payload['category'] as ApprovalCategory)) {
        i.push({ path: 'payload.category', message: 'credential_access is DENIED_BY_POLICY and never produces an ApprovalRequested' });
      }
      {
        const pr = payload['possibleRepeat'] as { priorTaskId?: unknown } | undefined;
        if (pr !== undefined && (payload['category'] === 'read' || payload['category'] === 'navigate')) {
          i.push({ path: 'payload.possibleRepeat', message: "possibleRepeat is never set with category 'read' or 'navigate' (D14, ruling 1g)" });
        }
        // X5 (rulings 1k/1l/1m): every field rule, incl. UI-action app name/window title/process image; a category with no
        // display rule for the display's kind is rejected here (ruling 2a: the 1l coverage rule is tool-kind only, ui_action
        // dialog categories; pre_dispatch/codex_* every category incl. read/navigate; credential_access never); and the
        // display is for this action's category.
        const d = payload['display'] as Record<string, unknown>;
        for (const x of validateApprovalDisplay(d, 'payload.display').issues) i.push({ path: x.path, message: x.message });
        // Ruling 2b (dottie-e01 97e7bc0): for EVERY kind (tool, ui_action, codex_command, codex_file_change, pre_dispatch).
        if (d['category'] !== payload['category']) {
          i.push({ path: 'payload.display.category', message: 'must equal payload.category (the bound display is for this action)' });
        }
        // Ruling 1r kind/source guard (E08): codex_* only from codex, tool/ui_action only from tool_host, pre_dispatch only
        // from the coordinator.
        const kind = d['kind'] as DisplayKind;
        if ((DISPLAY_KINDS as readonly unknown[]).includes(kind) && DISPLAY_KIND_SOURCE[kind] !== payload['requestSource']) {
          i.push({ path: 'payload.requestSource', message: `a ${kind} display comes only with requestSource '${DISPLAY_KIND_SOURCE[kind]}' (ruling 1r)` });
        }
        // Ruling 1r pre_dispatch consistency (category is checked above for every kind).
        if (kind === 'pre_dispatch') {
          const prior = pr === undefined ? null : ((pr as { priorSideEffect?: unknown }).priorSideEffect ?? null);
          if (d['possibleRepeat'] !== prior) {
            i.push({ path: 'payload.display.possibleRepeat', message: "must equal payload.possibleRepeat.priorSideEffect (null when absent) (ruling 1r)" });
          }
          if (pr !== undefined && d['retryOfTaskId'] !== pr.priorTaskId) {
            i.push({ path: 'payload.display.retryOfTaskId', message: 'must equal payload.possibleRepeat.priorTaskId when possibleRepeat is present (ruling 1r)' });
          }
          if (d['risk'] !== payload['risk']) i.push({ path: 'payload.display.risk', message: 'must equal payload.risk (ruling 1r)' });
        }
        if (pr !== undefined && pr.priorTaskId === payload['taskId']) {
          i.push({ path: 'payload.possibleRepeat.priorTaskId', message: 'a D14 retry is a new task: priorTaskId must differ from taskId' });
        }
      }
      break;
    case 'TaskProgress': {
      // Rulings 1o/1q (CONTRACTS dd082ec): advisory metadata keys, no text. awaitingClarification is a boolean and true
      // only while LISTENING (ADR-0010); false or absent is valid in any state. turnsSoFar is a number.
      const md = payload['redactedMetadata'] as Record<string, unknown>;
      if (hasOwn(md, 'awaitingClarification') && typeof md['awaitingClarification'] !== 'boolean') {
        i.push({ path: 'payload.redactedMetadata.awaitingClarification', message: 'must be a boolean (ruling 1o)' });
      }
      if (md['awaitingClarification'] === true && payload['state'] !== 'LISTENING') {
        i.push({ path: 'payload.redactedMetadata.awaitingClarification', message: "true only with state 'LISTENING' (ruling 1q, ADR-0010)" });
      }
      if (hasOwn(md, 'turnsSoFar') && typeof md['turnsSoFar'] !== 'number') {
        i.push({ path: 'payload.redactedMetadata.turnsSoFar', message: 'must be a number (ruling 1o)' });
      }
      break;
    }
    case 'ApprovalResolved':
      if (typeof envelope['taskId'] !== 'string' || envelope['taskId'].length === 0) {
        i.push({ path: 'taskId', message: 'envelope taskId is required for ApprovalResolved' });
      }
      // Rulings 1m/1n: decision 'expired' and reason 'display_unavailable' are both non-approvals, and exclusive.
      if (payload['decision'] !== undefined && payload['approved'] === true) {
        i.push({ path: 'payload.decision', message: "decision 'expired' requires approved:false" });
      }
      if (payload['reason'] !== undefined && payload['approved'] === true) {
        i.push({ path: 'payload.reason', message: 'reason requires approved:false' });
      }
      if (payload['decision'] !== undefined && payload['reason'] !== undefined) {
        i.push({ path: 'payload.reason', message: 'decision and reason never appear together (expiry is coordinator-only, reason desktop-only)' });
      }
      break;
    case 'ToolResult': {
      const hasError = payload['error'] !== undefined;
      if (hasError === payload['verified']) i.push({ path: 'payload.error', message: 'error must be present exactly when verified is false' });
      const err = payload['error'] as { retryable?: unknown; code?: unknown } | undefined;
      if (err?.retryable === true && payload['sideEffect'] !== 'none') {
        i.push({ path: 'payload.error.retryable', message: "retryable may be true only when sideEffect is 'none'" });
      }
      // §5: INVALID_ARGUMENT is sideEffect 'none' and not retryable; USER_DECLINED is never retried.
      if ((err?.code === 'INVALID_ARGUMENT' || err?.code === 'USER_DECLINED') && err.retryable === true) {
        i.push({ path: 'payload.error.retryable', message: `${String(err.code)} is never retryable` });
      }
      if (err?.code === 'INVALID_ARGUMENT' && payload['sideEffect'] !== 'none') {
        i.push({ path: 'payload.sideEffect', message: "INVALID_ARGUMENT requires sideEffect 'none'" });
      }
      // §5: observedState.processImage is a basename only, never a path.
      const img = (payload['observedState'] as Record<string, unknown> | undefined)?.['processImage'];
      if (img !== undefined && (typeof img !== 'string' || img.length === 0 || /[\\/:]/.test(img))) {
        i.push({ path: 'payload.observedState.processImage', message: 'must be a process image basename, never a path' });
      }
      break;
    }
    case 'TaskFinished': {
      if (payload['verified'] === true && payload['outcome'] !== 'succeeded') {
        i.push({ path: 'payload.verified', message: "verified:true is allowed only with outcome 'succeeded'" });
      }
      if (payload['outcome'] === 'succeeded' && payload['verified'] !== true) {
        i.push({ path: 'payload.verified', message: "outcome 'succeeded' requires verified:true" });
      }
      const reason = payload['reason'];
      if ((reason === undefined || typeof reason === 'string') && typeof payload['outcome'] === 'string' && !taskFinishedReasonFits(payload['outcome'], reason)) {
        i.push({ path: 'payload.reason', message: `reason ${reason === undefined ? '(none)' : `'${reason}'`} does not fit outcome '${payload['outcome']}' (CONTRACTS §3 TaskFinished pairing)` });
      }
      break;
    }
    case 'TaskCancelled':
      if ((payload['sideEffects'] === 'committed') !== payload['sideEffectsCommitted']) {
        i.push({ path: 'payload.sideEffectsCommitted', message: "must be true exactly when sideEffects is 'committed'" });
      }
      break;
    default:
      break;
  }
}

const envelopeFields = {
  schema: req((v, p, i) => {
    if (v !== EVENT_SCHEMA) i.push({ path: p, message: `must be ${EVENT_SCHEMA}` });
  }),
  version: req((v, p, i) => {
    if (v !== EVENT_VERSION) i.push({ path: p, message: `unsupported version ${String(v)}; only ${EVENT_VERSION} is accepted` });
  }),
  type: req(oneOf(EVENT_TYPES)),
  eventId: req(nonEmpty),
  correlationId: req(nonEmpty),
  causationId: opt(nonEmpty),
  taskId: opt(nonEmpty),
  timestamp: req(iso),
  payload: req(() => undefined),
} satisfies Record<string, Field>;

/** Validate an untrusted event. Never coerces; returns every issue found. */
export function validateEvent(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  objectOf(envelopeFields)(input, '', issues);
  const fixed = issues.map((x) => ({ ...x, path: x.path.replace(/^\./, '') }));
  if (!isRecord(input)) return { ok: false, issues: fixed };
  const type = input['type'];
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) return { ok: false, issues: fixed };
  const payloadIssues: ValidationIssue[] = [];
  PAYLOADS[type as EventType](input['payload'], 'payload', payloadIssues);
  fixed.push(...payloadIssues);
  if (fixed.length === 0) invariants(type as EventType, input, input['payload'] as Record<string, unknown>, fixed);
  return fixed.length === 0 ? { ok: true, event: input as unknown as AnyEvent } : { ok: false, issues: fixed };
}
