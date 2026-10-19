/** Shared event contract v2 (arch/CONTRACTS.md §3, ADR-0012 §2, §6-§9). Payload field names are the spec §7 names. */
import type { ApprovalDisplay } from './display.js';
import type {
  ApprovalCategory,
  CapabilityScope,
  CheckResult,
  ObservedDecision,
  CoordinatorState,
  EndReason,
  PriorSideEffect,
  RequestSource,
  ApprovalResolvedDecision,
  ApprovalResolvedReason,
  Risk,
  SideEffect,
  SideEffectSummary,
  StopStatus,
  TaskFinishedReason,
  TaskOutcome,
  ToolErrorCode,
  VerifierOutcome,
} from './enums.js';

export const EVENT_SCHEMA = 'dottie.event' as const;
export const EVENT_VERSION = 2 as const;

export interface WorkspaceScope {
  readonly scopes: readonly CapabilityScope[];
  readonly paths: readonly string[];
}

/** §3.2: flat scalars (null allowed), at most 32 keys and at most 2 KB (UTF-8 bytes of its JSON). */
export type RedactedMetadata = Readonly<Record<string, string | number | boolean | null>>;
export const REDACTED_METADATA_MAX_KEYS = 32;
export const REDACTED_METADATA_MAX_BYTES = 2048;

export interface Candidate {
  /** Opaque id the tool can resolve; never a full user path. */
  readonly id: string;
  /** Safe display label. */
  readonly label: string;
}

/** CONTRACTS §5. Never window titles, file contents or full user paths. */
export interface ObservedState {
  readonly outcome: VerifierOutcome;
  readonly decision: ObservedDecision;
  readonly checks: Readonly<Record<string, CheckResult>>;
  readonly sideEffect: SideEffect;
  readonly question?: string;
  readonly candidates?: readonly Candidate[];
  /** Tool-specific scalar keys. */
  readonly [key: string]: unknown;
}

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  /** May be true only when sideEffect is 'none'. */
  readonly retryable: boolean;
}

export interface CommittedAction {
  readonly toolId: string;
  /** The redacted ObservedState object (§5), never a string (E01 2026-10-19). */
  readonly observedState: ObservedState;
  readonly certainty: 'committed' | 'possible';
}

export interface WakeDetected {
  readonly timestamp: string;
  readonly deviceId: string;
  /** 0..1 */
  readonly confidence: number;
}
export interface UtteranceReady {
  readonly requestId: string;
  readonly text: string;
  readonly locale: string;
  readonly endReason: EndReason;
  /** D14 (DOT-092): the task the user asked to retry. Set only by the voice or tray path (the user's command); non-empty. */
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
  /** ISO-8601 instant after which the request counts as denied. */
  readonly expiry: string;
  /** v2 required extension. Never `credential_access` (that is DENIED_BY_POLICY, no request). */
  readonly category: Exclude<ApprovalCategory, 'credential_access'>;
  /**
   * D14 (DOT-092): set only on a user-requested retry after a possible side effect; the dialog shows "this action may
   * already have happened" before Approve. Never with category `read`; priorTaskId is never this task (a D14 retry is a
   * new task). Matching it to retryOfTaskId is a coordinator-only invariant (E01 ruling 1f).
   */
  readonly possibleRepeat?: PossibleRepeat;
  /**
   * Bound display (X5, E01 rulings 1k/1l/1m; CONTRACTS 0d53abc): required; its category equals `category`. Ruling 2a
   * (dottie-e01 972d5f4): kind `tool` / `ui_action` need a dialog category (ruling 1l coverage); `pre_dispatch` and
   * `codex_*` are valid for every category incl. read/navigate; credential_access never produces an ApprovalRequested. Its hash is the
   * actionId preimage's displayHash; the actionId itself is not recomputed here (no args on the event).
   */
  readonly display: ApprovalDisplay;
  /**
   * Ruling 1r (E08 guard, CONTRACTS 819b30d): set only by the coordinator from its own state, never from model or Codex
   * input; in the CR2 preimage next to displayHash. codex_* displays ⇔ 'codex', tool/ui_action ⇔ 'tool_host',
   * pre_dispatch ⇔ 'coordinator'.
   */
  readonly requestSource: RequestSource;
}
export interface PossibleRepeat {
  readonly priorTaskId: string;
  readonly priorSideEffect: PriorSideEffect;
}
export interface ApprovalResolved {
  readonly actionId: string;
  /** The only approval signal; `decision`/`reason` are additive and both imply false (ruling 1n: no decision enum). */
  readonly approved: boolean;
  readonly timestamp: string;
  /** Coordinator-emitted only, on the C-08 timeout (one per joined request), with approved:false (ruling 1m). */
  readonly decision?: ApprovalResolvedDecision;
  /** Desktop-sent only, with approved:false and no decision: join (f) display mismatch, fail closed (ruling 1n). */
  readonly reason?: ApprovalResolvedReason;
}
export interface ToolResult {
  readonly taskId: string;
  readonly toolId: string;
  readonly observedState: ObservedState;
  readonly verified: boolean;
  /** Present exactly when verified is false. */
  readonly error?: ToolError;
  readonly sideEffect: SideEffect;
  readonly evidenceRef?: string;
}
export interface TaskFinished {
  readonly taskId: string;
  readonly outcome: TaskOutcome;
  /** true only with outcome 'succeeded'. */
  readonly verified: boolean;
  readonly summary: string;
  /**
   * Required with blocked_auth (BLOCKED_AUTH_REASONS) and blocked_unavailable ('codex_unavailable'); otherwise
   * optional, always from TASK_FINISHED_REASONS (E01 2026-10-19).
   */
  readonly reason?: TaskFinishedReason;
}
export interface TaskCancelled {
  readonly taskId: string;
  readonly stopStatus: StopStatus;
  readonly sideEffects: SideEffectSummary;
  /** true exactly when sideEffects === 'committed'. */
  readonly sideEffectsCommitted: boolean;
  readonly committedActions: readonly CommittedAction[];
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
export const EVENT_TYPES = [
  'WakeDetected',
  'UtteranceReady',
  'TaskRequested',
  'TaskProgress',
  'ApprovalRequested',
  'ApprovalResolved',
  'ToolResult',
  'TaskFinished',
  'TaskCancelled',
] as const satisfies readonly EventType[];

export interface EventEnvelope<T extends EventType = EventType> {
  readonly schema: typeof EVENT_SCHEMA;
  readonly version: typeof EVENT_VERSION;
  readonly type: T;
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  /** Required for ApprovalResolved (its spec payload has no taskId). */
  readonly taskId?: string;
  /** ISO-8601 with an offset (Z or ±hh:mm). */
  readonly timestamp: string;
  readonly payload: EventPayloads[T];
}
export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];
