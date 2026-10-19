/**
 * Dottie task coordinator (E03). Owns the lifecycle state machine, duplicate prevention, single-active-task
 * rule with an explicit new-task policy, dispatch to the injected Codex port, approvals, bounded retries,
 * recovery and cancellation. It holds no credentials, audio, or tool implementations.
 */
import { randomUUID } from 'node:crypto';
import {
  EVENT_SCHEMA,
  EVENT_SCHEMA_VERSION,
  isActionId,
  type AnyEvent,
  type ApprovalCategory,
  type ApprovalRequested,
  type PossibleRepeat,
  type PossibleRepeatSideEffect,
  type Risk,
  type EventEnvelope,
  type EventPayloads,
  type EventType,
  type RedactedMetadata,
  type StopStatus,
  type TaskOutcome,
  type TaskFinishReason,
  type AuthBlockReason,
  type ToolError,
  type ToolResult,
  type WorkspaceScope,
  type ObservedState,
  CLARIFICATION_REASONS,
} from './contracts.js';
import { SideEffectLedger, cancelReport, decideStopStatus } from './cancellation.js';
import { DedupeGuard, normalizeUtterance } from './dedupe.js';
import type { PinnedToolCatalog } from './toolCatalog.js';
import { codexDisplay, preDispatchDisplay, type ApprovalDisplay, type RequestSource } from './display.js';
import {
  failClosedPolicy,
  type ActionIdBinding,
  type ActionIdPort,
  type ApprovalChannel,
  type ApprovalDisplayPort,
  type AuthorizeToolCallParams,
  type ApprovalDecision,
  type AuthState,
  type CancelAck,
  type Clock,
  type CodexApprovalRequest,
  type CodexError,
  type CodexPort,
  type CodexRunHooks,
  type CodexRunResult,
  type EventSink,
  type IdSource,
  type Logger,
  type PolicyPort,
  type SpeechKind,
  type SpeechPort,
  type ToolCallAuthorization,
  type ToolCallContext,
  type ToolCatalogPort,
  type ToolHostPort,
  type TurnKind,
  type VerifierPort,
} from './ports.js';
import { DEFAULT_RETRY_POLICY, backoffDelay, shouldRetry, type RetryPolicy } from './retry.js';
import { StateMachine, type TransitionResult } from './stateMachine.js';
import { TASK_ACTIVE_STATES, type CoordinatorState } from './states.js';

export type NewTaskPolicy = 'queue' | 'cancel_then_start';

/**
 * E01 ruling 2g (90ceed5): what the desktop's CoordinatorPort reads (`getState()` / `onStateChange`), same names and
 * shape as E06's port (feature/E06-runtime-status services/types.ts `CoordinatorSnapshot`). `activeTaskId` is the
 * single active task (ADR-0010) or null; `taskActive` is true exactly when it is non-null.
 */
export interface CoordinatorSnapshot {
  readonly state: CoordinatorState;
  readonly taskActive: boolean;
  readonly activeTaskId: string | null;
}

export interface CoordinatorConfig {
  /** Same normalised text within this window is a duplicate (spec gives no number; see README open questions). */
  readonly dedupeWindowMs: number;
  readonly retry: RetryPolicy;
  /** Approval requests auto-deny after this long (silence never approves). */
  readonly approvalTimeoutMs: number;
  /** How long to wait for the Codex adapter to confirm a stop before reporting stop_unconfirmed. */
  readonly cancelAckTimeoutMs: number;
  /** Spec §9.11: "queued or cancel-then-start according to an explicit rule". */
  readonly newTaskPolicy: NewTaskPolicy;
  readonly maxQueued: number;
  /** Speak a short "On it." when execution starts (spec §4: short progress confirmations). */
  readonly acknowledgeOnDispatch: boolean;
  /** Bound on one auth read (CodexPort.authState). A read slower than this counts as Codex unavailable (DOT-061; E01-confirmed 5 s). */
  readonly authReadTimeoutMs: number;
  /** How long a clarification question waits for the user's answer before the task ends (Ruling 2; E01-confirmed 30 s). */
  readonly clarificationTimeoutMs: number;
  /** Clarification rounds allowed per task before the task ends as failed (loop guard; E01-confirmed 3). */
  readonly maxClarificationTurns: number;
}

export const DEFAULT_CONFIG: CoordinatorConfig = {
  dedupeWindowMs: 10_000,
  retry: DEFAULT_RETRY_POLICY,
  approvalTimeoutMs: 60_000,
  cancelAckTimeoutMs: 3_000,
  newTaskPolicy: 'queue',
  maxQueued: 1,
  acknowledgeOnDispatch: true,
  authReadTimeoutMs: 5_000,
  clarificationTimeoutMs: 30_000,
  maxClarificationTurns: 3,
};

export interface CoordinatorDeps {
  readonly codex: CodexPort;
  readonly speech: SpeechPort;
  readonly events: EventSink;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly policy?: PolicyPort;
  readonly verifier?: VerifierPort;
  /** E04 tool host control channel. Optional so the coordinator runs without a host in unit tests. */
  readonly toolHost?: ToolHostPort;
  /** actionId source (CONTRACTS §3.3). Unwired = fail closed: no ApprovalRequested is ever emitted. */
  readonly actionIds?: ActionIdPort;
  /**
   * Pinned tool catalog (P27), built only through PinnedToolCatalog.fromPinned (SHA-256 verified; E01 condition).
   * Unwired, unverified or unknown tool = the tool's side effects count for D14 (fail closed).
   */
  readonly toolCatalog?: PinnedToolCatalog;
  /** E01 1o: Codex approval display builder (default: display.ts codexDisplay over request.displayParams). */
  readonly approvalDisplays?: ApprovalDisplayPort;
  readonly random?: () => number;
}

export type SubmitResult =
  | { readonly kind: 'started'; readonly taskId: string }
  /** Ruling 2: the utterance answered a clarification and continues the same task as a new turn. */
  | { readonly kind: 'continued'; readonly taskId: string }
  | { readonly kind: 'queued'; readonly taskId: string; readonly position: number }
  | { readonly kind: 'duplicate'; readonly originalTaskId: string; readonly reason: 'same_request_id' | 'same_text_within_window' }
  | { readonly kind: 'rejected'; readonly reason: 'not_accepting_commands' | 'queue_full' | 'empty_utterance' | 'shutting_down' };

export type CancelResult =
  | { readonly kind: 'cancelling'; readonly taskId: string }
  | { readonly kind: 'already_cancelling'; readonly taskId: string }
  | { readonly kind: 'no_active_task' };

export interface StopSpeakingResult {
  readonly wasSpeaking: boolean;
  /** true when a task keeps running: stopping speech never stops the task. */
  readonly taskStillRunning: boolean;
}

export type ApprovalResolveResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: 'unknown_action' | 'already_resolved' | 'expired' | 'channel_not_allowed' | 'invalid_answer' };

export type FaultSource = 'audio' | 'codex_runtime' | 'internal';

interface PendingApproval {
  readonly taskId: string;
  readonly request: ApprovalRequested;
  readonly expiresAt: number;
  readonly timer: AbortController;
  readonly resolve: (d: ApprovalDecision) => void;
  /** eventId of the dialog's ApprovalRequested (joinedTo for any joined request, E01 1k e / 1o). */
  eventId: string;
}

/** What a later user retry needs to know about an ended task (D14). Bounded history; no utterance text. */
interface PriorTaskRecord {
  /**
   * From the ledger / ToolResult.sideEffect, counting only tools whose catalog category is not read/navigate:
   * 'committed' > 'unknown' (a ToolResult said unknown) > 'possible' (a side-effecting tool never reported); else null.
   */
  readonly sideEffect: PossibleRepeatSideEffect | null;
  /**
   * E01 §5 (c) (CONTRACTS 5b6b3f5/060cd60): whether a user retry of this task may start one. False for succeeded,
   * answered, cancelled (TaskCancelled), declined, blocked_auth, anything that ended in a clarification timeout/cancel,
   * and a refused retry itself.
   */
  readonly retryable: boolean;
  /** E01 ruling 1j (a): the prior task's Codex thread, so a retry starts on it. Never utterance text. */
  readonly threadId: string | undefined;
  /** The last approval the task asked for whose category is not read/navigate/credential_access (E01 1f b); null if none. */
  readonly lastGated: { readonly category: ApprovalCategory; readonly risk: Risk; readonly summary: string } | null;
}
/** Categories whose side effects never make a retry a possible repeat, and never set the forced category (E01 1f b). */
const NON_REPEAT_CATEGORIES: ReadonlySet<ApprovalCategory> = new Set<ApprovalCategory>(['read', 'navigate']);
/** E01 §5 (c): prior outcomes a user retry may start from. */
const RETRYABLE_OUTCOMES: ReadonlySet<TaskOutcome> = new Set<TaskOutcome>(['failed', 'failed_after_side_effects', 'unverified', 'partial', 'blocked_unavailable']);
/** How a tool's side effects count for D14: not at all (read/navigate), at their reported class, or floored at unknown (no category). */
type RepeatClass = 'excluded' | 'counted' | 'uncategorised';
const PRIOR_TASK_HISTORY = 64;
const SETTLED_DECISION_HISTORY = 256;
/** D14 fail-closed defaults for a forced retry approval when the prior task recorded no usable category. */
const RETRY_FALLBACK = { category: 'local_change', risk: 'high' } as const satisfies { category: ApprovalCategory; risk: Risk };

interface Task {
  readonly taskId: string;
  readonly requestId: string;
  readonly interactionId: string;
  readonly text: string;
  readonly scope: WorkspaceScope;
  /** eventId of the UtteranceReady that created the task. */
  readonly causationId: string;
  readonly abort: AbortController;
  readonly ledger: SideEffectLedger;
  readonly toolResults: ToolResult[];
  /** D14 (UtteranceReady.retryOfTaskId, accepted by E01): the task the user explicitly asked to retry. Only user input sets it. */
  readonly retryOfTaskId: string | undefined;
  /** D14: set at flow start when the retried task's side effect was possible/unknown. */
  possibleRepeat: PossibleRepeat | undefined;
  /** Approvals this task asked for (category/risk/summary), kept for a later retry's forced confirmation. */
  readonly approvalsSeen: { readonly category: ApprovalCategory; readonly risk: Risk; readonly summary: string }[];
  threadId: string | undefined;
  /** Retry attempt within the current user turn. */
  attempt: number;
  /** Number of run() calls so far; turnId = `${taskId}.t${turnSeq}`. */
  turnSeq: number;
  /**
   * The first turn's id, minted with the task (before CONFIRMING) so a pre-dispatch approval is bound to the exact turn
   * that will be dispatched (CONTRACTS §2.1 pre-dispatch preimage): beginTurn() reuses it for turn 1.
   */
  readonly firstTurnId: string;
  /** The turn that may call tools right now (null between turns and after a cancel request). */
  currentTurn: ToolCallContext | null;
  /** ToolResults reported during the current/last turn. */
  turnResults: ToolResult[];
  /** True once the current turn started a side-effecting item (§1.5 per-turn ledger for the retry rule). */
  turnSideEffectStarted: boolean;
  /** A "Reconnecting…" progress is showing for the current willRetry burst. */
  reconnectingShown: boolean;
  /** Set while the task waits for the user's answer to an AMBIGUOUS question. */
  clarification: { readonly question: string; readonly timer: AbortController } | null;
  clarificationTurns: number;
  dispatched: boolean;
  cancelRequested: boolean;
  /** 'flow' = cancel requested before the task reached a cancellable state; the run flow finishes it. */
  cancelOwner: 'none' | 'flow' | 'cancel_path';
  closed: boolean;
  runSettled: Promise<CodexRunResult> | undefined;
}

type VerificationOutcome = 'verified' | 'partially_verified' | 'unverified' | 'failed';
/** Result of one bounded auth read: an AuthState, or why no state was obtained. */
type AuthObservation = AuthState | 'read_error' | 'read_timeout';
/**
 * Auth gate verdict (CONTRACTS §2.1 "Auth gate outcomes", ADR-0010, E01 2026-10-19). Only `signed_in` is admitted.
 * The three account verdicts go to AUTH_REQUIRED + blocked_auth with that reason. `codex_unavailable` (unavailable,
 * unknown, a throw, rejection or timeout) → blocked_unavailable, no AUTH_REQUIRED, no sign-in copy, coordinator idle.
 * The environment condition is the supervisor's RuntimeStatus (§2.4, ADR-0013), not a coordinator state.
 */
export type AuthVerdict = 'admit' | AuthBlockReason | 'codex_unavailable';
export function classifyAuth(observed: AuthObservation): AuthVerdict {
  switch (observed) {
    case 'signed_in':
      return 'admit';
    case 'signed_out':
    case 'expired':
      return 'auth_required';
    case 'signing_in':
      return 'sign_in_in_progress';
    case 'unsupported':
      return 'account_unsupported';
    default:
      return 'codex_unavailable';
  }
}
const isAccountBlock = (v: AuthVerdict): v is AuthBlockReason => v !== 'admit' && v !== 'codex_unavailable';

/** Spoken copy per account verdict. account_unsupported never says "reconnect" (no reconnect loop). */
const ACCOUNT_COPY: Record<AuthBlockReason, { speak: string; summary: string }> = {
  auth_required: {
    speak: 'I need you to reconnect ChatGPT before I can do that. Use Reconnect in the Dottie tray menu.',
    summary: 'ChatGPT sign-in is required before Codex can run tasks. Nothing was sent to Codex for this step.',
  },
  sign_in_in_progress: {
    speak: "You're still signing in to ChatGPT. Finish signing in, then ask me again.",
    summary: 'ChatGPT sign-in is still in progress; finish signing in first. Nothing was sent to Codex for this step.',
  },
  account_unsupported: {
    speak: "This ChatGPT account can't run Codex. You can sign out or switch to a different account from the Dottie tray menu.",
    summary: "This ChatGPT account can't run Codex; sign out or switch account. Nothing was sent to Codex for this step.",
  },
};
/** Top-level model-argument keys that try to name the task or turn (Ruling 1). Matched case-insensitively. */
const RESERVED_KEY = /^(?:(?:task|turn|thread)[_-]?id|hwnd|pid)$/i;
const MUTABLE_NOW: ReadonlySet<CoordinatorState> = new Set<CoordinatorState>(['BOOTING', 'STANDBY', 'WAKE_DETECTED', 'LISTENING', 'TRANSCRIBING', 'AUTH_REQUIRED']);

const PROGRESS_TEXT: Partial<Record<CoordinatorState, string>> = {
  CONFIRMING: 'Waiting for confirmation',
  EXECUTING: 'Working on it',
  PERMISSION_REQUIRED: 'Waiting for your approval',
  VERIFYING: 'Checking the result',
  RECOVERING: 'Recovering from a temporary problem',
  CANCELLING: 'Stopping the task',
};

const consoleLogger: Logger = {
  log(level, event, fields) {
    if (level === 'warn' || level === 'error') console.warn(JSON.stringify({ level, event, ...fields }));
  },
};

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>(resolve => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done(): void {
        clearTimeout(t);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

const uuidIds: IdSource = { next: prefix => `${prefix}_${randomUUID()}` };

export class Coordinator {
  readonly config: CoordinatorConfig;
  private readonly machine: StateMachine;
  private readonly codex: CodexPort;
  private readonly speech: SpeechPort;
  private readonly events: EventSink;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly policy: PolicyPort;
  private readonly verifier: VerifierPort | undefined;
  private readonly toolHost: ToolHostPort | undefined;
  private readonly actionIds: ActionIdPort | undefined;
  private readonly approvalDisplays: ApprovalDisplayPort;
  private readonly toolCatalog: ToolCatalogPort | undefined;
  private readonly random: () => number;
  private readonly dedupe: DedupeGuard;

  private active: Task | null = null;
  private readonly queue: Task[] = [];
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly resolvedApprovals = new Set<string>();
  /** Settled dialogs (bounded; no args): the task and the dialog's eventId, so a later join can name joinedTo (1o). */
  private readonly settledDialogs = new Map<string, { readonly taskId: string; readonly eventId: string }>();
  /** D14: ended tasks, so a user retry can tell whether the prior side effect was possible/unknown. */
  private readonly priorTasks = new Map<string, PriorTaskRecord>();
  private readonly flows = new Set<Promise<void>>();
  private interactionId: string;
  private muted = false;
  /** True only when the account is known to need the user (sign_in class); drives AUTH_REQUIRED as the rest state. */
  private signInRequired = false;
  /** Bumped by every non-signed_in auth notification; a read that started before a bump is stale (DOT-061). */
  private authGeneration = 0;
  private lastNotifiedAuth: AuthState = 'unknown';
  private shuttingDown = false;
  private speechSeq = 0;
  private readonly snapshotListeners = new Set<(s: CoordinatorSnapshot) => void>();
  private readonly finishedListeners = new Set<(e: EventEnvelope<'TaskFinished'>) => void>();
  private readonly cancelledListeners = new Set<(e: EventEnvelope<'TaskCancelled'>) => void>();

  constructor(deps: CoordinatorDeps, config: Partial<CoordinatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.retry.maxAttempts < 1) throw new Error('retry.maxAttempts must be >= 1');
    this.codex = deps.codex;
    this.speech = deps.speech;
    this.events = deps.events;
    this.logger = deps.logger ?? consoleLogger;
    this.clock = deps.clock ?? realClock;
    this.ids = deps.ids ?? uuidIds;
    this.policy = deps.policy ?? failClosedPolicy;
    this.verifier = deps.verifier;
    this.toolHost = deps.toolHost;
    this.actionIds = deps.actionIds;
    this.approvalDisplays = deps.approvalDisplays ?? { codexDisplay: r => codexDisplay(r.category, r.display) };
    this.toolCatalog = deps.toolCatalog;
    this.random = deps.random ?? Math.random;
    this.dedupe = new DedupeGuard(this.clock, this.config.dedupeWindowMs);
    this.interactionId = this.ids.next('int');
    this.machine = new StateMachine(this.logger, () => this.clock.now(), (_from, to) => this.stateChanged(to));
  }

  // ------------------------------------------------------------------ introspection
  get state(): CoordinatorState {
    return this.machine.state;
  }
  get transitions(): StateMachine['history'] {
    return this.machine.history;
  }
  get rejectedTransitions(): number {
    return this.machine.rejected;
  }
  get activeTaskId(): string | undefined {
    return this.active?.taskId;
  }
  /** E01 2g: the desktop snapshot (CoordinatorPort.getState). */
  getState(): CoordinatorSnapshot {
    const activeTaskId = this.active?.taskId ?? null;
    return { state: this.machine.state, taskActive: activeTaskId !== null, activeTaskId };
  }
  /** E01 2g: snapshot listener (CoordinatorPort.onStateChange). Returns the unsubscribe. */
  onStateChange(listener: (s: CoordinatorSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => { this.snapshotListeners.delete(listener); };
  }
  /**
   * E01 2g / 2g.1 (499e61c): the desktop port's terminal-event members, E06's names (7f022d2 `onTaskFinished`; 2g.1
   * `onTaskCancelled`). Each event type has its own listener set (no union): a cancel never reaches onTaskFinished.
   * Delivered right after the EventSink emit, so the active task is already cleared and onStateChange already told.
   */
  onTaskFinished(listener: (e: EventEnvelope<'TaskFinished'>) => void): () => void {
    this.finishedListeners.add(listener);
    return () => { this.finishedListeners.delete(listener); };
  }
  onTaskCancelled(listener: (e: EventEnvelope<'TaskCancelled'>) => void): () => void {
    this.cancelledListeners.add(listener);
    return () => { this.cancelledListeners.delete(listener); };
  }
  get queuedTaskIds(): readonly string[] {
    return this.queue.map(t => t.taskId);
  }

  /** Resolves once every in-flight flow (task, cancel, speech) has settled. Test/shutdown helper. */
  async settled(): Promise<void> {
    while (this.flows.size > 0) await Promise.allSettled([...this.flows]);
  }

  // ------------------------------------------------------------------ lifecycle
  async boot(options: { readonly startMuted?: boolean } = {}): Promise<TransitionResult> {
    this.muted = options.startMuted ?? false;
    const auth = await this.readAuth();
    this.signInRequired = isAccountBlock(classifyAuth(auth));
    return this.machine.transition(this.restState(), `boot auth=${auth}`);
  }

  async shutdown(): Promise<void> {
    if (this.state === 'SHUTDOWN') return;
    this.shuttingDown = true;
    this.speech.stop();
    for (const queued of this.queue.splice(0)) this.emitCancelled(queued, 'stopped_before_dispatch');
    if (this.active) this.cancelTask('shutdown');
    await this.settled();
    if (this.machine.state !== 'SHUTDOWN') {
      this.machine.transition('SHUTDOWN', 'user quit');
    }
  }

  // ------------------------------------------------------------------ voice pipeline inputs (E05)
  handleWake(event: EventEnvelope<'WakeDetected'>): TransitionResult {
    if (this.muted) return this.reject('WAKE_DETECTED', 'wake while muted');
    if (this.queue.length > 0) return this.reject('WAKE_DETECTED', 'wake while tasks queued; deliver utterance directly');
    const from = this.state;
    const r = this.machine.transition('WAKE_DETECTED', `wake confidence=${event.payload.confidence}`);
    if (r.ok) {
      this.interactionId = event.correlationId;
      if (from === 'SPEAKING') this.speech.stop(); // barge-in halts TTS
    }
    return r;
  }

  handleListeningStarted(): TransitionResult {
    return this.machine.transition('LISTENING', 'capture started');
  }

  handleCaptureEnded(): TransitionResult {
    return this.machine.transition('TRANSCRIBING', 'capture ended');
  }

  /** No speech / timeout / false wake: return to the rest state (or end a task that was waiting for an answer). */
  handleCaptureAborted(reason: string): TransitionResult {
    if (this.state !== 'WAKE_DETECTED' && this.state !== 'LISTENING' && this.state !== 'TRANSCRIBING') {
      return this.reject(this.restState(), `capture aborted outside capture: ${reason}`);
    }
    const waiting = this.active?.clarification ? this.active : null;
    if (waiting) {
      const from = this.state;
      this.track(this.clarificationUnanswered(waiting, 'clarification_cancelled', `capture aborted: ${reason}`));
      return { ok: true, from, to: this.state };
    }
    return this.machine.transition(this.restState(), `capture aborted: ${reason}`);
  }

  /**
   * New command. Normal path: state TRANSCRIBING. While a task is active or queued, barge-in commands arrive
   * here directly and follow config.newTaskPolicy. Anything else is rejected and logged.
   */
  submitUtterance(event: EventEnvelope<'UtteranceReady'>, options: { readonly allowRepeat?: boolean } = {}): SubmitResult {
    const u = event.payload;
    if (this.shuttingDown || this.state === 'SHUTDOWN') return { kind: 'rejected', reason: 'shutting_down' };
    const waiting = this.active?.clarification ? this.active : null;
    if (waiting) return this.submitClarificationAnswer(waiting, event);
    const busy = this.active !== null || this.queue.length > 0;
    if (!busy && this.state !== 'TRANSCRIBING') {
      this.logger.log('warn', 'coordinator.utterance.rejected', { state: this.state, requestId: u.requestId });
      return { kind: 'rejected', reason: 'not_accepting_commands' };
    }
    if (normalizeUtterance(u.text) === '') {
      if (!busy) this.track(this.speakThenRest("Sorry, I didn't catch that.", 'prompt', undefined));
      return { kind: 'rejected', reason: 'empty_utterance' };
    }
    // D14: an explicit user retry is a new task by definition, so the same-text window must not swallow it.
    // requestId replay is still a duplicate (idempotency).
    const verdict = this.dedupe.check(u.requestId, u.text, (options.allowRepeat ?? false) || u.retryOfTaskId !== undefined);
    if (verdict.duplicate) {
      this.logger.log('info', 'coordinator.utterance.duplicate', { requestId: u.requestId, reason: verdict.reason, originalTaskId: verdict.originalTaskId });
      return { kind: 'duplicate', originalTaskId: verdict.originalTaskId, reason: verdict.reason };
    }
    if (busy && this.queue.length >= this.config.maxQueued) {
      this.logger.log('warn', 'coordinator.utterance.queue_full', { requestId: u.requestId, queued: this.queue.length });
      return { kind: 'rejected', reason: 'queue_full' };
    }
    const task = this.createTask(event);
    this.dedupe.record(u.requestId, verdict.key, task.taskId);
    // TaskRequested is emitted only once the auth gate admits the task (CONTRACTS v2 §3: "never sent" otherwise).
    if (!busy) {
      this.track(this.runFlow(task));
      return { kind: 'started', taskId: task.taskId };
    }
    this.queue.push(task);
    if (this.config.newTaskPolicy === 'cancel_then_start' && this.active && !this.active.cancelRequested) this.cancelTask('cancel_then_start');
    return { kind: 'queued', taskId: task.taskId, position: this.queue.length };
  }

  // ------------------------------------------------------------------ distinct interrupt intents
  /** "Stop speaking" / barge-in: halts TTS only. Never cancels, pauses or reports the task as stopped. */
  stopSpeaking(): StopSpeakingResult {
    const wasSpeaking = this.state === 'SPEAKING' || this.active !== null;
    this.speech.stop();
    this.logger.log('info', 'coordinator.stop_speaking', { state: this.state, taskId: this.active?.taskId });
    return { wasSpeaking, taskStillRunning: this.active !== null && !this.active.closed };
  }

  /** "Stop the task": cancels the active task and reports its true stop status. Queued tasks are untouched. */
  cancelTask(reason = 'user'): CancelResult {
    const task = this.active;
    if (!task || task.closed) return { kind: 'no_active_task' };
    if (task.cancelRequested) return { kind: 'already_cancelling', taskId: task.taskId };
    task.cancelRequested = true;
    this.logger.log('info', 'coordinator.cancel.requested', { taskId: task.taskId, state: this.state, reason });
    this.endTurn(task); // no further tool calls are authorised once a stop is requested
    if (task.clarification) {
      // Between turns (waiting for a clarification answer): no Codex turn is in flight.
      this.clearClarification(task);
      task.cancelOwner = 'flow';
      this.speech.stop();
      this.track(this.cancelCheckpoint(task));
      return { kind: 'cancelling', taskId: task.taskId };
    }
    if (TASK_ACTIVE_STATES.has(this.state) && this.state !== 'CANCELLING') {
      task.cancelOwner = 'cancel_path';
      this.machine.transition('CANCELLING', `cancel: ${reason}`);
      this.track(this.runCancel(task));
    } else {
      task.cancelOwner = 'flow'; // pre-dispatch window; the run flow finishes it at its next checkpoint
      task.abort.abort();
    }
    return { kind: 'cancelling', taskId: task.taskId };
  }

  // ------------------------------------------------------------------ tool host control channel (E04, Ruling 1)
  /** The coordinator-sourced context for the single active turn, or null when no turn may call tools. */
  toolCallContext(): ToolCallContext | null {
    const task = this.active;
    if (!task || task.closed || task.cancelRequested || !task.currentTurn) return null;
    return { ...task.currentTurn };
  }

  /**
   * Per-call answer to the tool host: taskId/turnId always come from the coordinator (Ruling 1, CONTRACTS §5).
   * Checked in this order (first failure wins; every refusal is sideEffect none and the tool must not run):
   * 1. A top-level reserved key in the model arguments (taskId, turnId, threadId, hwnd, pid and their spelling variants)
   *    → `INVALID_ARGUMENT`, retryable false. Nothing is stripped. This check comes first, so it applies even when no turn
   *    is active. Key names are logged; values never are (E01 ruling 6 + E04, tool schemas are additionalProperties:false).
   * 2. No active turn (idle, between turns, or a stop was requested) → `PRECONDITION_FAILED`.
   * 3. The host's `actionId` (E01 DOT-092 ruling 1d) is missing or not 64 lowercase hex → `DENIED_BY_POLICY`
   *    (CONTRACTS reason `malformed`). One check site: {@link checkCallActionId}.
   * 4. Otherwise `{ok:true, context, args}` with the coordinator's context and the arguments unchanged.
   */
  authorizeToolCall(params: AuthorizeToolCallParams): ToolCallAuthorization {
    const { toolId, modelArgs } = params;
    const reserved = Object.keys(modelArgs).filter(k => RESERVED_KEY.test(k));
    const context = this.toolCallContext();
    if (reserved.length > 0) {
      // Key names only; values are model-controlled and never logged or echoed.
      this.logger.log('warn', 'coordinator.tool_call.reserved_keys_rejected', { toolId, keys: reserved.join(','), ...(context ? { taskId: context.taskId, turnId: context.turnId } : {}) });
      return {
        ok: false,
        sideEffect: 'none',
        error: { code: 'INVALID_ARGUMENT', message: `Reserved argument(s) not allowed: ${reserved.join(', ')}. Dottie supplies task, turn and window context itself.`, retryable: false },
      };
    }
    if (!context) {
      this.logger.log('warn', 'coordinator.tool_call.no_active_turn', { toolId, state: this.state });
      return { ok: false, sideEffect: 'none', error: { code: 'PRECONDITION_FAILED', message: 'No active Dottie turn may call tools right now.', retryable: false } };
    }
    const idRefusal = this.checkCallActionId(params, context);
    if (idRefusal) return idRefusal;
    return { ok: true, context, args: { ...modelArgs } };
  }

  /**
   * The ONLY place the coordinator judges a tool call's actionId (E01 DOT-092 ruling 1d). Runs after the reserved-key
   * and active-turn checks, so it always has the authoritative context. Today: format only (missing / not 64 lowercase
   * hex → DENIED_BY_POLICY, reason `malformed`). Recomputing against the validated args is K8's (E08), not the
   * coordinator's. Pending ruling 1e slots in here: a K8 schema_invalid verdict (the one case where actionId is null)
   * is decided before this format check, and a K8 recompute mismatch (`wrong_action`, incl. a stale host
   * setActiveTurn cache) after it, both returning DENIED_BY_POLICY with sideEffect none.
   */
  private checkCallActionId(params: AuthorizeToolCallParams, context: ToolCallContext): ToolCallAuthorization | null {
    const actionId: unknown = (params as { readonly actionId?: unknown }).actionId;
    if (isActionId(actionId)) return null;
    // Never log the value (model/host-controlled); only why, the tool and the coordinator's own ids.
    this.logger.log('warn', 'coordinator.tool_call.action_id_rejected', { toolId: params.toolId, reason: 'malformed', missing: actionId === undefined, taskId: context.taskId, turnId: context.turnId });
    return { ok: false, sideEffect: 'none', error: { code: 'DENIED_BY_POLICY', message: 'The tool call has no valid action id, so it was not allowed.', retryable: false } };
  }

  // ------------------------------------------------------------------ approvals (E06 UI -> E03, policy by E08)
  resolveApproval(event: EventEnvelope<'ApprovalResolved'>, channel: ApprovalChannel): ApprovalResolveResult {
    const { actionId, approved } = event.payload;
    // E01 1m/1n: expiry is the coordinator's (C-08); an inbound decision, or a reason on a yes, is never acted on.
    if (event.payload.decision !== undefined || (event.payload.reason !== undefined && approved)) {
      this.logger.log('warn', 'coordinator.approval.rejected', { actionId, reason: 'invalid_answer' });
      return { kind: 'rejected', reason: 'invalid_answer' };
    }
    if (event.payload.reason !== undefined) this.logger.log('warn', 'coordinator.approval.display_unavailable', { actionId });
    const pending = this.approvals.get(actionId);
    if (!pending) {
      const reason = this.resolvedApprovals.has(actionId) ? 'already_resolved' : 'unknown_action';
      this.logger.log('warn', 'coordinator.approval.rejected', { actionId, reason });
      return { kind: 'rejected', reason };
    }
    if (event.taskId !== pending.taskId) {
      // CONTRACTS §3: envelope taskId is required on ApprovalResolved; a mismatch never approves.
      this.logger.log('warn', 'coordinator.approval.rejected', { actionId, reason: 'task_mismatch' });
      return { kind: 'rejected', reason: 'unknown_action' };
    }
    if (this.clock.now() >= pending.expiresAt) {
      this.settleApproval(actionId, { approved: false, reason: 'expired' }, true);
      return { kind: 'rejected', reason: 'expired' };
    }
    // D14: a possible-repeat approval needs a fresh secure_ui click whatever the policy allows (E08 ruling 4 addition (2)).
    const channelOk = this.policy.acceptsApprovalChannel(pending.request, channel) && (pending.request.possibleRepeat === undefined || channel === 'secure_ui');
    if (approved && !channelOk) {
      this.logger.log('warn', 'coordinator.approval.channel_rejected', { actionId, channel, risk: pending.request.risk });
      return { kind: 'rejected', reason: 'channel_not_allowed' };
    }
    // E01 1n/2c: the desktop answers any ApprovalRequested it can't validate or show (every requestSource) with
    // {approved:false, reason:'display_unavailable'}. That is not the user saying no: it settles as display_unavailable,
    // so Codex gets display_unavailable and a pre-dispatch confirmation ends declined{approval_unavailable} (no
    // "you declined" speech). The desktop's message is the only ApprovalResolved; the coordinator emits none.
    const reason = approved ? 'approved' : event.payload.reason === 'display_unavailable' ? 'display_unavailable' : 'denied';
    this.settleApproval(actionId, { approved, reason }, false);
    return { kind: 'accepted' };
  }

  // ------------------------------------------------------------------ mute / auth / faults
  setMuted(muted: boolean): CoordinatorState {
    this.muted = muted;
    if (muted) {
      if (this.active === null && MUTABLE_NOW.has(this.state)) this.machine.transition('MUTED', 'user mute');
      else this.logger.log('info', 'coordinator.mute.deferred', { state: this.state });
    } else if (this.state === 'MUTED') {
      this.machine.transition(this.restState(), 'user unmute');
    }
    return this.state;
  }

  /** account/updated hint (re-read by E02). Never resumes a task; the dispatch gate always does its own fresh read. */
  handleAuthChanged(auth: AuthState): void {
    if (auth !== 'signed_in') this.authGeneration++;
    this.lastNotifiedAuth = auth;
    this.signInRequired = isAccountBlock(classifyAuth(auth));
    if (!this.signInRequired && this.state === 'AUTH_REQUIRED') this.machine.transition('STANDBY', `auth ${auth}`);
    else if (this.signInRequired && this.state === 'STANDBY') this.machine.transition('AUTH_REQUIRED', `auth ${auth}`);
  }

  /** Non-task faults (audio device lost, runtime crash while idle). Task faults arrive via CodexRunResult. */
  handleFault(source: FaultSource, fatal: boolean): TransitionResult | undefined {
    if (this.active !== null && source !== 'internal') {
      this.logger.log('warn', 'coordinator.fault.during_task', { source, taskId: this.active.taskId });
      return undefined;
    }
    return this.machine.transition(fatal ? 'ERROR' : 'RECOVERING', `fault ${source}`);
  }

  handleRecovered(): TransitionResult {
    if (this.state === 'ERROR') {
      const r = this.machine.transition('RECOVERING', 'supervisor restart');
      if (!r.ok) return r;
    }
    if (this.state !== 'RECOVERING' || this.active !== null) return this.reject(this.restState(), 'recovered outside RECOVERING');
    return this.machine.transition(this.restState(), 'recovered');
  }

  // ================================================================== internals
  private createTask(event: EventEnvelope<'UtteranceReady'>): Task {
    const text = event.payload.text;
    const taskId = this.ids.next('task');
    return {
      taskId,
      firstTurnId: turnIdFor(taskId, 1),
      requestId: event.payload.requestId,
      interactionId: event.correlationId,
      text,
      scope: copyScope(this.policy.workspaceScopeFor(text)), // E01 2i: only {scopes, paths}; a port extra never reaches TaskRequested
      causationId: event.eventId,
      abort: new AbortController(),
      ledger: new SideEffectLedger(),
      toolResults: [],
      retryOfTaskId: event.payload.retryOfTaskId,
      possibleRepeat: undefined,
      approvalsSeen: [],
      threadId: undefined,
      attempt: 0,
      turnSeq: 0,
      currentTurn: null,
      turnResults: [],
      turnSideEffectStarted: false,
      reconnectingShown: false,
      clarification: null,
      clarificationTurns: 0,
      dispatched: false,
      cancelRequested: false,
      cancelOwner: 'none',
      closed: false,
      runSettled: undefined,
    };
  }

  private async runFlow(task: Task): Promise<void> {
    this.setActive(task); // 2g: the desktop sees the task as active before any of its events
    if (this.retryRefused(task)) return;
    const gate = await this.authGate(task, 'dispatch');
    if (task.cancelRequested) return this.cancelCheckpoint(task);
    if (gate !== 'admit') return this.blockOnAuth(task, gate);
    this.emit('TaskRequested', { taskId: task.taskId, requestId: task.requestId, text: task.text, workspaceScope: task.scope }, task, task.causationId);

    // D14: a user retry of a task whose side effect was possible/unknown always goes through a fresh pre-dispatch
    // approval, even when the policy would dispatch without one.
    const retry = this.retryConfirmation(task);
    const confirmation = this.policy.preDispatchConfirmation(task.text, task.scope) ?? retry;
    if (confirmation) {
      if (!this.machine.transition('CONFIRMING', 'pre-dispatch confirmation').ok) return this.abandon(task, 'cannot enter CONFIRMING');
      // CONTRACTS §2.1 six-key preimage (E01 D14 rulings, E08 co-signed; 1k/1q): both D14 values come only from the
      // coordinator's own state. possibleRepeat is what the dialog shows (null on read/navigate or no repeat).
      const possibleRepeat = task.possibleRepeat !== undefined && !NON_REPEAT_CATEGORIES.has(confirmation.category) ? task.possibleRepeat.priorSideEffect : null;
      const retryOfTaskId = task.retryOfTaskId ?? null;
      const display = preDispatchDisplay({ category: confirmation.category, risk: confirmation.risk, possibleRepeat, retryOfTaskId, summary: confirmation.summary });
      const displayHash = await this.computeDisplayHash(task, display);
      if (task.cancelRequested) return;
      if (displayHash === null) return this.finishNotApprovable(task);
      const actionId = await this.computeActionId(task, {
        purpose: 'dottie.actionId.v1',
        method: 'dottie.pre_dispatch_confirmation',
        args: { summary: confirmation.summary, risk: confirmation.risk, category: confirmation.category, possibleRepeat, retryOfTaskId, displayHash },
        targets: null,
        taskId: task.taskId,
        threadId: null,
        turnId: task.firstTurnId,
        itemId: null,
        requestId: task.requestId,
        displayHash, // CR2 top-level, byte-equal to args.displayHash (1q)
        requestSource: 'coordinator', // CR2 (1r)
      });
      if (task.cancelRequested) return; // cancel path (CONFIRMING -> CANCELLING) owns reporting
      if (actionId === null) return this.finishNotApprovable(task);
      const decision = await this.awaitApproval(task, { actionId, summary: confirmation.summary, risk: confirmation.risk, category: confirmation.category }, display, 'coordinator');
      if (task.cancelRequested) return; // cancel path (CONFIRMING -> CANCELLING) owns reporting
      if (decision.reason === 'display_unavailable') return this.finishNotApprovable(task);
      if (!decision.approved) {
        this.finish(task, 'declined', false, `Not started: confirmation ${decision.reason}.`);
        return this.speakThenRest("Okay, I won't do that.", 'result', task.taskId);
      }
      // The confirmation may have taken up to approvalTimeoutMs: re-read auth right before dispatch.
      const gate2 = await this.authGate(task, 'dispatch_after_confirmation');
      if (task.cancelRequested) return this.cancelCheckpoint(task);
      if (gate2 !== 'admit') return this.blockOnAuth(task, gate2);
    }
    if (!this.machine.transition('EXECUTING', 'dispatch').ok) return this.abandon(task, 'cannot enter EXECUTING');
    if (this.config.acknowledgeOnDispatch) void this.speech.speak('On it.', { taskId: task.taskId, kind: 'progress' }).catch(() => 'interrupted');
    return this.executeWithRetries(task, 'initial', task.text);
  }

  /**
   * E01 §5 (c): a retry of a non-retryable prior starts nothing: no TaskRequested, no auth gate, no Codex call, no TTS.
   * The refused request keeps its own fresh taskId; the prior task's record is left untouched. A prior with no
   * record (e.g. from before a restart) stays retryable and fails closed as 'unknown' (retryConfirmation).
   */
  private retryRefused(task: Task): boolean {
    const priorTaskId = task.retryOfTaskId;
    if (priorTaskId === undefined) return false;
    const prior = this.priorTasks.get(priorTaskId);
    if (prior === undefined || prior.retryable) return false;
    this.logger.log('info', 'coordinator.retry.refused', { taskId: task.taskId, priorTaskId });
    this.finish(task, 'failed', false, 'Not started: that task cannot be retried.', 'retry_not_allowed');
    this.afterSpeaking(); // silent: next queued task, else the rest state
    return true;
  }

  /**
   * D14: decide whether this task is a possible repeat and, if so, the confirmation to force. Only a user retry
   * (retryOfTaskId) can be one. A prior with no record (e.g. from before a restart) fails closed as 'unknown'.
   */
  private retryConfirmation(task: Task): { summary: string; risk: Risk; category: ApprovalCategory } | null {
    const priorTaskId = task.retryOfTaskId;
    if (priorTaskId === undefined || priorTaskId === task.taskId) return null;
    const prior = this.priorTasks.get(priorTaskId);
    // E01 ruling 1j (a): start on the prior thread so Codex has the original request (a tray retry's text is fixed).
    if (prior?.threadId !== undefined && task.threadId === undefined) task.threadId = prior.threadId;
    const sideEffect: PossibleRepeatSideEffect | null = prior ? prior.sideEffect : 'unknown';
    this.logger.log('info', 'coordinator.retry.requested', { taskId: task.taskId, priorTaskId, priorKnown: prior !== undefined, priorSideEffect: sideEffect ?? 'none' });
    if (sideEffect === null) return null;
    task.possibleRepeat = { priorTaskId, priorSideEffect: sideEffect };
    const last = prior?.lastGated ?? null;
    if (last) return { summary: `Retry: ${last.summary}`, risk: last.risk, category: last.category };
    return { summary: `Retry: ${task.text}`, ...RETRY_FALLBACK };
  }

  /**
   * D14 trigger class from the pinned catalog: read/navigate are excluded; an unknown tool, a missing/unverified
   * catalog or a lookup that throws counts as class unknown (CONTRACTS 5b6b3f5 §5 h, fail closed).
   */
  private repeatClass(toolId: string): RepeatClass {
    let category: ApprovalCategory | undefined;
    try {
      category = this.toolCatalog?.categoryOf(toolId);
    } catch {
      return 'uncategorised';
    }
    if (category === undefined) return 'uncategorised';
    return NON_REPEAT_CATEGORIES.has(category) ? 'excluded' : 'counted';
  }

  private rememberPriorTask(task: Task, end: { outcome: TaskOutcome; reason?: TaskFinishReason | undefined } | 'cancelled'): void {
    // Each side effect at its class; an uncategorised tool's is floored at 'unknown' (committed stays committed).
    const classes: PossibleRepeatSideEffect[] = [];
    for (const r of task.toolResults) {
      const cls = this.repeatClass(r.toolId);
      if (cls === 'excluded' || r.sideEffect === 'none') continue;
      classes.push(r.sideEffect === 'committed' ? 'committed' : 'unknown');
    }
    // In-flight (never reported) side-effecting tools are the ledger snapshot's entries with no observed state.
    for (const a of task.ledger.snapshot()) {
      if (a.observedState !== null) continue;
      const cls = this.repeatClass(a.toolId);
      if (cls !== 'excluded') classes.push(cls === 'uncategorised' ? 'unknown' : 'possible');
    }
    // E01: committed > unknown > possible.
    const sideEffect: PossibleRepeatSideEffect | null =
      classes.includes('committed') ? 'committed' : classes.includes('unknown') ? 'unknown' : classes.includes('possible') ? 'possible' : null;
    const retryable =
      end !== 'cancelled' &&
      RETRYABLE_OUTCOMES.has(end.outcome) &&
      end.reason !== 'retry_not_allowed' &&
      !(end.reason !== undefined && (CLARIFICATION_REASONS as readonly string[]).includes(end.reason));
    const gated = task.approvalsSeen.filter(a => !NON_REPEAT_CATEGORIES.has(a.category) && a.category !== 'credential_access');
    this.priorTasks.set(task.taskId, { sideEffect, retryable, lastGated: gated.at(-1) ?? null, threadId: task.threadId });
    while (this.priorTasks.size > PRIOR_TASK_HISTORY) this.priorTasks.delete(this.priorTasks.keys().next().value as string);
  }

  private async executeWithRetries(task: Task, firstKind: TurnKind, turnText: string): Promise<void> {
    const policy = this.config.retry;
    task.attempt = 0;
    for (;;) {
      task.attempt++;
      task.dispatched = true;
      const turnKind: TurnKind = task.attempt === 1 ? firstKind : 'retry';
      const resume = task.turnSeq > 0;
      const turn = this.beginTurn(task);
      const runP: Promise<CodexRunResult> = this.codex
        .run(
          {
            taskId: task.taskId,
            idempotencyKey: task.taskId,
            turnId: turn.turnId,
            clientUserMessageId: turn.turnId,
            turnKind,
            attempt: task.attempt,
            text: turnText,
            workspaceScope: task.scope,
            resume,
            ...(task.threadId !== undefined ? { threadId: task.threadId } : {}),
          },
          this.hooksFor(task),
          task.abort.signal,
        )
        .catch((err: unknown): CodexRunResult => ({ status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: err instanceof Error ? err.message : String(err) } }));
      task.runSettled = runP;
      let result = await runP;
      this.endTurn(task);
      if (task.cancelRequested) return; // cancel path owns the report
      if (this.state === 'PERMISSION_REQUIRED') {
        this.cancelApprovalsFor(task, 'cancelled');
        this.machine.transition('EXECUTING', 'run ended while approval pending');
      }
      if (result.status === 'aborted') result = { status: 'failed', error: { kind: 'fatal', origin: 'adapter', message: 'run aborted without a cancel request' } };
      if (result.status === 'completed') {
        const ambiguous = this.clarificationQuestion(task, result.summary);
        if (ambiguous !== null) return this.askClarification(task, ambiguous);
        return this.verifyAndFinish(task, result.summary);
      }

      let error = result.error;
      if (error.origin === 'rpc_error' && error.kind !== 'fatal') {
        // §1.5: JSON-RPC errors carry no codexErrorInfo, so any other kind is an adapter misclassification.
        this.logger.log('warn', 'coordinator.codex_error.reclassified', { taskId: task.taskId, from: error.kind, to: 'fatal', origin: error.origin });
        error = { ...error, kind: 'fatal' };
      }
      const sideEffects = task.ledger.summary();
      if (error.kind === 'auth') {
        this.signInRequired = true;
        this.machine.transition('AUTH_REQUIRED', 'auth expired during task');
        const text = this.failureText(task, error, 'Your ChatGPT sign-in expired. Use Reconnect in the tray menu.');
        this.finish(task, sideEffects === 'none' ? 'blocked_auth' : 'failed_after_side_effects', false, text, 'auth_required');
        return this.speakThenRest(text, 'result', task.taskId);
      }
      if (shouldRetry(policy, task.attempt, error, !task.turnSideEffectStarted)) {
        this.machine.transition('RECOVERING', `retry after ${error.kind}`);
        const delay = backoffDelay(policy, task.attempt, this.random);
        this.progress(task, `Temporary problem; retrying (attempt ${task.attempt + 1} of ${policy.maxAttempts})`, undefined, { delayMs: delay, errorKind: error.kind });
        await this.clock.sleep(delay, task.abort.signal);
        if (task.cancelRequested) return;
        const gate = await this.authGate(task, `retry_attempt_${task.attempt + 1}`);
        if (task.cancelRequested) return;
        if (gate !== 'admit') return this.blockOnAuth(task, gate);
        this.machine.transition('EXECUTING', `retry attempt ${task.attempt + 1}`);
        continue;
      }
      this.logger.log('warn', 'coordinator.task.failed', { taskId: task.taskId, kind: error.kind, attempts: task.attempt, sideEffects });
      const lead =
        error.kind === 'plan_limit'
          ? "You've reached your ChatGPT plan's Codex usage limit, so I won't retry or switch to an API key."
          : "I couldn't finish that.";
      const text = this.failureText(task, error, lead);
      this.finish(task, sideEffects === 'none' ? 'failed' : 'failed_after_side_effects', false, text);
      return this.speakThenRest(text, 'result', task.taskId);
    }
  }

  private failureText(task: Task, error: Pick<CodexError, 'kind' | 'message'>, lead: string): string {
    const se = task.ledger.summary();
    const actions = task.ledger.snapshot();
    const tail =
      se === 'committed' ? ` Some steps had already happened: ${actions.filter(a => a.certainty === 'committed').map(a => a.toolId).join(', ')}. I did not retry or undo them.`
      : se === 'possible' ? ` Some steps may have taken effect: ${actions.map(a => a.toolId).join(', ')}. Please check.`
      : '';
    const attempts = task.attempt > 1 ? ` (tried ${task.attempt} times)` : '';
    return `${lead}${attempts} Reason: ${error.kind}.${tail}`;
  }

  private async verifyAndFinish(task: Task, summary: string): Promise<void> {
    this.machine.transition('VERIFYING', 'codex completed');
    // A resolved AMBIGUOUS ask-the-user step is not a failed action (CONTRACTS §5 ask-the-user path).
    const results = task.toolResults.filter(r => !(r.error?.code === 'AMBIGUOUS' && r.sideEffect === 'none'));
    let outcome: TaskOutcome;
    let detail: string | undefined;
    if (this.verifier) {
      let verifierOutcome: VerificationOutcome;
      try {
        const r = await this.verifier.verify({ taskId: task.taskId, text: task.text, summary, toolResults: [...task.toolResults] }, task.abort.signal);
        verifierOutcome = r.verified && r.outcome === 'verified' ? 'verified' : r.outcome === 'verified' ? 'unverified' : r.outcome;
        detail = r.error?.message;
      } catch (err) {
        verifierOutcome = 'unverified';
        detail = 'the verifier failed';
        this.logger.log('warn', 'coordinator.verify.error', { taskId: task.taskId, error: err instanceof Error ? err.message : 'unknown' });
      }
      outcome = this.outcomeFromVerifier(task, verifierOutcome);
    } else if (results.length === 0) {
      outcome = 'answered';
    } else if (results.every(r => r.verified)) {
      outcome = 'succeeded';
    } else {
      outcome = 'unverified';
      detail = 'a step was not verified';
    }
    if (task.cancelRequested) return; // cancel during VERIFYING -> completed_before_stop, reported by cancel path
    const verified = outcome === 'succeeded';
    const text =
      outcome === 'succeeded' || outcome === 'answered' ? summary
      : outcome === 'partial' ? `Mostly done, but I couldn't confirm every part${detail ? ` (${detail})` : ''}. Codex reported: ${summary}`
      : outcome === 'unverified' ? `I couldn't confirm that it worked${detail ? ` (${detail})` : ''}. Codex reported: ${summary}`
      : this.failureText(task, { kind: 'fatal', message: detail ?? 'verification failed' }, "That didn't work.");
    this.finish(task, outcome, verified, text);
    return this.speakThenRest(text, 'result', task.taskId);
  }

  /** CONTRACTS §3.1: verified→succeeded, partially_verified→partial, unverified→unverified, failed→failed|failed_after_side_effects. */
  private outcomeFromVerifier(task: Task, v: VerificationOutcome): TaskOutcome {
    switch (v) {
      case 'verified':
        return 'succeeded';
      case 'partially_verified':
        return 'partial';
      case 'unverified':
        return 'unverified';
      case 'failed':
        return task.ledger.summary() === 'none' ? 'failed' : 'failed_after_side_effects';
    }
  }

  // ------------------------------------------------------------------ turns and clarification (Rulings 1 and 2)
  private beginTurn(task: Task): ToolCallContext {
    task.turnSeq++;
    const context: ToolCallContext = { taskId: task.taskId, turnId: task.turnSeq === 1 ? task.firstTurnId : turnIdFor(task.taskId, task.turnSeq) };
    task.currentTurn = context;
    task.turnResults = [];
    task.turnSideEffectStarted = false;
    task.reconnectingShown = false;
    this.notifyToolHost(host => host.setActiveTurn({ ...context }));
    return context;
  }

  private endTurn(task: Task): void {
    if (task.currentTurn === null) return;
    task.currentTurn = null;
    if (this.active === task || this.active === null) this.notifyToolHost(host => host.setActiveTurn(null));
  }

  private notifyToolHost(fn: (host: ToolHostPort) => void): void {
    if (!this.toolHost) return;
    try {
      fn(this.toolHost);
    } catch (err) {
      this.logger.log('error', 'coordinator.tool_host.notify_failed', { error: err instanceof Error ? err.message : 'unknown' });
    }
  }

  /** CONTRACTS §5 ask-the-user path: the turn's last tool result is AMBIGUOUS → the question (or Codex's relay of it). */
  private clarificationQuestion(task: Task, summary: string): string | null {
    const last = task.turnResults.at(-1);
    if (!last || last.error?.code !== 'AMBIGUOUS') return null;
    const q = last.observedState.question;
    return typeof q === 'string' && q.trim() !== '' ? q : summary;
  }

  private async askClarification(task: Task, question: string): Promise<void> {
    if (task.clarificationTurns >= this.config.maxClarificationTurns) {
      const outcome: TaskOutcome = task.ledger.summary() === 'none' ? 'failed' : 'failed_after_side_effects';
      const text = this.failureText(task, { kind: 'fatal', message: 'too many clarification rounds' }, "I still couldn't tell which one you meant, so I stopped there.");
      this.finish(task, outcome, false, text);
      return this.speakThenRest(text, 'result', task.taskId);
    }
    const timer = new AbortController();
    task.clarification = { question, timer };
    void this.clock.sleep(this.config.clarificationTimeoutMs, timer.signal).then(() => {
      if (!timer.signal.aborted && task.clarification?.timer === timer) this.track(this.clarificationUnanswered(task, 'clarification_timeout', 'timeout'));
    });
    // E01 1q: not yet LISTENING here (the question is about to be spoken), so no awaitingClarification flag.
    this.progress(task, question, undefined, { turnsSoFar: task.turnSeq });
    await this.speakThenRest(question, 'prompt', task.taskId); // afterSpeaking() opens LISTENING while clarification is set
  }

  private clearClarification(task: Task): void {
    task.clarification?.timer.abort();
    task.clarification = null;
  }

  private submitClarificationAnswer(task: Task, event: EventEnvelope<'UtteranceReady'>): SubmitResult {
    const u = event.payload;
    if (this.state !== 'TRANSCRIBING' && this.state !== 'LISTENING' && this.state !== 'SPEAKING') {
      this.logger.log('warn', 'coordinator.clarification.rejected', { state: this.state, taskId: task.taskId, requestId: u.requestId });
      return { kind: 'rejected', reason: 'not_accepting_commands' };
    }
    // Ruling 2: only requestId replay is a duplicate here; repeated words ("the first one") are a valid new answer.
    const verdict = this.dedupe.check(u.requestId, u.text, true);
    if (verdict.duplicate) {
      this.logger.log('info', 'coordinator.utterance.duplicate', { requestId: u.requestId, reason: verdict.reason, originalTaskId: verdict.originalTaskId });
      return { kind: 'duplicate', originalTaskId: verdict.originalTaskId, reason: verdict.reason };
    }
    if (normalizeUtterance(u.text) === '') {
      const question = task.clarification?.question ?? '';
      this.track(this.speakThenRest(`Sorry, I didn't catch that. ${question}`.trim(), 'prompt', task.taskId));
      return { kind: 'rejected', reason: 'empty_utterance' };
    }
    this.dedupe.recordRequest(u.requestId, task.taskId);
    this.clearClarification(task);
    task.clarificationTurns++;
    this.track(this.continueTask(task, u.text));
    return { kind: 'continued', taskId: task.taskId };
  }

  /** Same taskId, new turn on the same thread (resume:true). Per-task tool-host state (targetIds) stays valid. */
  private async continueTask(task: Task, answer: string): Promise<void> {
    if (this.state === 'SPEAKING') this.speech.stop();
    if (this.state === 'LISTENING') this.machine.transition('TRANSCRIBING', 'clarification answer delivered');
    const gate = await this.authGate(task, 'clarification_answer');
    if (task.cancelRequested) return this.cancelCheckpoint(task);
    if (gate !== 'admit') return this.blockOnAuth(task, gate);
    if (!this.machine.transition('EXECUTING', 'clarification answer').ok) return this.abandon(task, 'cannot enter EXECUTING for clarification answer');
    return this.executeWithRetries(task, 'clarification_answer', answer);
  }

  /** `clarification_timeout` = silence for clarificationTimeoutMs; `clarification_cancelled` = capture aborted (E01 2026-10-19). */
  private async clarificationUnanswered(task: Task, reason: 'clarification_timeout' | 'clarification_cancelled', why: string): Promise<void> {
    if (!task.clarification || task.closed) return;
    this.clearClarification(task);
    this.logger.log('info', 'coordinator.clarification.unanswered', { taskId: task.taskId, why, reason });
    const outcome: TaskOutcome = task.ledger.summary() === 'none' ? 'failed' : 'failed_after_side_effects';
    const lead = reason === 'clarification_cancelled' ? 'Okay, I stopped there.' : "I didn't get an answer, so I stopped there.";
    const text = this.failureText(task, { kind: 'fatal', message: 'no answer' }, lead);
    this.finish(task, outcome, false, text, reason);
    if (this.state === 'WAKE_DETECTED') return this.goRest('clarification unanswered');
    return this.speakThenRest(text, 'result', task.taskId);
  }

  /** Whitelist the adapter's fields and enforce CONTRACTS §5 invariants; taskId is always the coordinator's. */
  private normalizeToolResult(task: Task, partial: Omit<ToolResult, 'taskId'>): ToolResult {
    // E01 2i: copy only contract fields from the adapter's result (top level, error, observedState); extras are dropped.
    let error: ToolError | undefined = partial.error === undefined ? undefined : copyError(partial.error);
    let verified = partial.verified === true && error === undefined;
    if (partial.verified === true && error !== undefined) this.logger.log('warn', 'coordinator.tool_result.normalized', { taskId: task.taskId, toolId: partial.toolId, rule: 'error_implies_unverified' });
    if (!verified && error === undefined) {
      error = { code: 'POSTCONDITION_UNKNOWN', message: 'Tool reported verified:false without an error.', retryable: false };
      this.logger.log('warn', 'coordinator.tool_result.normalized', { taskId: task.taskId, toolId: partial.toolId, rule: 'unverified_needs_error' });
    }
    if (error && error.retryable && partial.sideEffect !== 'none') {
      error = { ...error, retryable: false };
      this.logger.log('warn', 'coordinator.tool_result.normalized', { taskId: task.taskId, toolId: partial.toolId, rule: 'retryable_requires_no_side_effect' });
    }
    verified = verified && error === undefined;
    return {
      taskId: task.taskId,
      toolId: partial.toolId,
      observedState: this.copyObserved(task, partial.observedState),
      verified,
      sideEffect: partial.sideEffect,
      ...(error !== undefined ? { error } : {}),
      ...(partial.evidenceRef !== undefined ? { evidenceRef: partial.evidenceRef } : {}),
    };
  }

  /**
   * E01 2i: ObservedState's contract fields, plus tool-specific keys only when their value is a scalar (CONTRACTS §5;
   * E02's validateEvent `scalar` rule). Anything else the adapter attached is dropped (logged by count, no values).
   */
  private copyObserved(task: Task, o: ObservedState): ObservedState {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return o;
    const src = o as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { outcome: o.outcome, decision: o.decision, checks: copyChecks(o.checks), sideEffect: o.sideEffect };
    if (o.question !== undefined) out['question'] = o.question;
    if (o.candidates !== undefined) out['candidates'] = Array.isArray(o.candidates) ? o.candidates.map(c => ({ id: c?.id, label: c?.label })) : o.candidates;
    let dropped = 0;
    for (const k of Object.keys(src)) {
      if (OBSERVED_KNOWN.includes(k)) continue;
      if (isScalarValue(src[k])) out[k] = src[k];
      else dropped++;
    }
    if (dropped > 0) this.logger.log('warn', 'coordinator.port_field.dropped', { taskId: task.taskId, where: 'observedState', count: dropped });
    return out as unknown as ObservedState;
  }

  private hooksFor(task: Task): CodexRunHooks {
    return {
      threadAssigned: threadId => {
        task.threadId = threadId;
      },
      progress: (message, toolId) => {
        task.reconnectingShown = false;
        this.progress(task, message, toolId);
      },
      codexRetrying: () => {
        this.logger.log('info', 'coordinator.codex_retrying', { taskId: task.taskId, turnId: task.currentTurn?.turnId ?? null });
        if (task.reconnectingShown || task.closed) return;
        task.reconnectingShown = true;
        // §1.5: only "Reconnecting…", no error detail; the coordinator's own state stays EXECUTING.
        this.emit('TaskProgress', { taskId: task.taskId, state: 'RECOVERING', message: 'Reconnecting…', redactedMetadata: { codexRetrying: true, attempt: task.attempt } }, task);
      },
      toolStarted: start => {
        task.reconnectingShown = false;
        if (start.mayHaveSideEffects) task.turnSideEffectStarted = true;
        task.ledger.started(start);
        if (task.closed) this.lateActivity(task, start.toolId, 'tool started after the task was stopped');
      },
      toolResult: partial => {
        const result = this.normalizeToolResult(task, partial);
        task.reconnectingShown = false;
        if (result.sideEffect !== 'none') task.turnSideEffectStarted = true;
        task.ledger.result(result);
        task.toolResults.push(result);
        task.turnResults.push(result);
        this.emit('ToolResult', result, task);
        if (task.closed && result.sideEffect !== 'none') this.lateActivity(task, result.toolId, 'an action completed after the task was stopped');
      },
      requestApproval: request => this.approvalFromCodex(task, request),
    };
  }

  /** Spec §14 release blocker: "commands running after cancellation without reporting". Always surface it. */
  private lateActivity(task: Task, toolId: string, message: string): void {
    this.logger.log('error', 'coordinator.side_effect_after_cancel', { taskId: task.taskId, toolId });
    this.emit('TaskProgress', { taskId: task.taskId, state: this.state, message: `Warning: ${message}.`, toolId, redactedMetadata: { lateAfterStop: true } }, task);
  }

  private async approvalFromCodex(task: Task, request: CodexApprovalRequest): Promise<ApprovalDecision> {
    if (task.cancelRequested || task.closed) return { approved: false, reason: 'cancelled' };
    // Adapter-supplied id (computed by the Codex adapter over the server request's CR2 binding): same fail-closed
    // rule. Not approvable → no ApprovalRequested; Codex gets a decline (ADR-0009 CR1).
    if (!isActionId(request.actionId)) {
      this.actionIdUnavailable(task, 'invalid_adapter_id');
      return { approved: false, reason: 'denied' };
    }
    // E01 1o (c) / 1p (E08 co-signed): a Codex request for an actionId that already has a dialog (open or settled) joins
    // it, and only the dialog's FIRST request can ever be approved. The joined request is declined at once with
    // duplicate_request: no second dialog, no expiry extension, never a replayed approval. Each JSON-RPC request gets
    // exactly one answer (this one). Record per joined request with joinedTo; no values; never "the user declined".
    const open = this.approvals.get(request.actionId);
    const dialog = open !== undefined && open.taskId === task.taskId ? open : this.settledDialogs.get(request.actionId);
    if (dialog !== undefined && dialog.taskId === task.taskId) {
      this.logger.log('warn', 'coordinator.approval.joined_declined', { taskId: task.taskId, actionId: request.actionId, joinedTo: dialog.eventId, reason: 'duplicate_request', open: open !== undefined });
      return { approved: false, reason: 'duplicate_request' };
    }
    // E01 1o: the bound display is built here from the adapter's validated params; none → declined display_unavailable.
    let display: ApprovalDisplay | null;
    try {
      display = this.approvalDisplays.codexDisplay(request);
    } catch {
      display = null;
    }
    if (display === null) {
      this.logger.log('warn', 'coordinator.approval.display_unavailable', { taskId: task.taskId, actionId: request.actionId, source: 'codex' });
      return { approved: false, reason: 'display_unavailable' };
    }
    if (!this.machine.transition('PERMISSION_REQUIRED', `approval ${request.risk}`).ok) return { approved: false, reason: 'cancelled' };
    const decision = await this.awaitApproval(task, request, display, 'codex');
    if (!task.cancelRequested && this.state === 'PERMISSION_REQUIRED') this.machine.transition('EXECUTING', `approval ${decision.reason}`);
    return decision;
  }

  /**
   * Fail-closed actionId (CONTRACTS §3.3, ADR-0009 CR1/CR2): returns the port's id only if it is 64 lowercase hex.
   * No port, a throw/rejection, or anything else → null, with one warning that carries no args or binding.
   */
  private async computeActionId(task: Task, binding: ActionIdBinding): Promise<string | null> {
    const port = this.actionIds;
    if (!port) return this.actionIdUnavailable(task, 'no_port');
    let out: unknown;
    try {
      out = await port.computeActionId(binding);
    } catch {
      return this.actionIdUnavailable(task, 'port_threw');
    }
    return isActionId(out) ? out : this.actionIdUnavailable(task, 'invalid_output');
  }

  /** X5 (1k/1l): displayHash from the port (E02 computeDisplayHash via contractsActionIdPort). No method, a throw or a non-hex result → null (fail closed). */
  private async computeDisplayHash(task: Task, display: ApprovalDisplay): Promise<string | null> {
    if (!this.actionIds) return this.actionIdUnavailable(task, 'no_port');
    const fn = this.actionIds.computeDisplayHash;
    let out: unknown;
    if (fn === undefined) out = undefined;
    else {
      try {
        out = await fn.call(this.actionIds, display);
      } catch {
        out = undefined;
      }
    }
    if (isActionId(out)) return out;
    this.logger.log('warn', 'coordinator.approval.display_unavailable', { taskId: task.taskId, source: 'pre_dispatch', why: fn === undefined ? 'no_port' : 'hash_failed' });
    return null;
  }

  private actionIdUnavailable(task: Task, why: 'no_port' | 'port_threw' | 'invalid_output' | 'invalid_adapter_id'): null {
    this.logger.log('warn', 'coordinator.approval.action_id_unavailable', { taskId: task.taskId, why });
    return null;
  }

  /**
   * The confirmation could not be put to the user safely. ADR-0009 CR1: any hash-computation failure resolves as
   * decline, so the outcome is `declined` (nothing dispatched), but the copy is truthful: the user did not decline.
   */
  private finishNotApprovable(task: Task): Promise<void> {
    this.finish(task, 'declined', false, "Not started: I couldn't request your approval safely, so nothing was done.", 'approval_unavailable');
    return this.speakThenRest("I couldn't ask for your approval safely, so I didn't do that.", 'result', task.taskId);
  }

  private awaitApproval(task: Task, req: CodexApprovalRequest, display: ApprovalDisplay, requestSource: RequestSource): Promise<ApprovalDecision> {
    const expiresAt = this.clock.now() + this.config.approvalTimeoutMs;
    // Fields are whitelisted: an adapter cannot inject possibleRepeat. It comes only from the task's user retry (D14), never on read.
    // E01 1g/1h: a possibleRepeat supplied by the adapter is ignored (never used to set, change or suppress the warning).
    // Noted by name only; the audit record input.field_stripped is K8's/main's to write (no audit port here).
    if ((req as unknown as Record<string, unknown>)['possibleRepeat'] !== undefined) {
      this.logger.log('warn', 'coordinator.input.field_stripped', { field: 'possibleRepeat', sourceChannel: 'codex', reason: 'untrusted_origin', taskId: task.taskId });
    }
    const repeat = task.possibleRepeat !== undefined && !NON_REPEAT_CATEGORIES.has(req.category) ? { possibleRepeat: { ...task.possibleRepeat } } : {};
    // E01 1f (a): coordinator invariant, checked before emitting. A flagged repeat must name exactly the task the user
    // asked to retry; anything else is an internal bug and fails closed (no ApprovalRequested, decline).
    // DOT-060 AC 11 (1r follow-up): the same invariant checks the pre-dispatch display's retryOfTaskId against the
    // utterance's, including when possibleRepeat is null (validateEvent can't: the event has no retryOfTaskId).
    const displayRetryMismatch = display['kind'] === 'pre_dispatch' && display['retryOfTaskId'] !== (task.retryOfTaskId ?? null);
    if ((repeat.possibleRepeat !== undefined && repeat.possibleRepeat.priorTaskId !== task.retryOfTaskId) || displayRetryMismatch) {
      this.logger.log('error', 'coordinator.retry.binding_mismatch', { taskId: task.taskId });
      return Promise.resolve({ approved: false, reason: 'display_unavailable' });
    }
    const request: ApprovalRequested = { taskId: task.taskId, actionId: req.actionId, summary: req.summary, risk: req.risk, expiry: new Date(expiresAt).toISOString(), category: req.category, ...repeat, display, requestSource };
    task.approvalsSeen.push({ category: req.category, risk: req.risk, summary: req.summary });
    const timer = new AbortController();
    const decision = new Promise<ApprovalDecision>(resolve => {
      this.approvals.set(req.actionId, { taskId: task.taskId, request, expiresAt, timer, resolve, eventId: '' });
    });
    const pendingEntry = this.approvals.get(req.actionId);
    const eventId = this.emit('ApprovalRequested', request, task);
    if (pendingEntry) pendingEntry.eventId = eventId;
    void this.clock.sleep(this.config.approvalTimeoutMs, timer.signal).then(() => {
      if (!timer.signal.aborted) this.settleApproval(req.actionId, { approved: false, reason: 'expired' }, true);
    });
    return decision;
  }

  private settleApproval(actionId: string, decision: ApprovalDecision, announce: boolean): void {
    const pending = this.approvals.get(actionId);
    if (!pending) return;
    this.approvals.delete(actionId);
    this.resolvedApprovals.add(actionId);
    this.settledDialogs.set(actionId, { taskId: pending.taskId, eventId: pending.eventId });
    while (this.settledDialogs.size > SETTLED_DECISION_HISTORY) this.settledDialogs.delete(this.settledDialogs.keys().next().value as string);
    pending.timer.abort();
    this.logger.log('info', 'coordinator.approval.settled', { actionId, taskId: pending.taskId, reason: decision.reason });
    if (announce) {
      const task = this.active?.taskId === pending.taskId ? this.active : undefined;
      // E01 1m: the timeout is announced to the desktop as decision:'expired' (approved:false), so it closes the dialog.
      this.emitRaw('ApprovalResolved', { actionId, approved: decision.approved, timestamp: this.iso(), ...(decision.reason === 'expired' ? { decision: 'expired' as const } : {}) }, task?.interactionId ?? this.interactionId, pending.taskId);
    }
    pending.resolve(decision);
  }

  private cancelApprovalsFor(task: Task, reason: 'cancelled'): void {
    for (const [actionId, p] of [...this.approvals]) if (p.taskId === task.taskId) this.settleApproval(actionId, { approved: false, reason }, true);
  }

  private async runCancel(task: Task): Promise<void> {
    task.abort.abort();
    this.cancelApprovalsFor(task, 'cancelled');
    if (!task.dispatched) return this.finishCancel(task, 'stopped_before_dispatch');
    const ackP = this.codex.cancel(task.taskId).catch((): CancelAck => ({ stopped: false, detail: 'cancel call failed' }));
    const settledP: Promise<CodexRunResult | undefined> = task.runSettled ?? Promise.resolve(undefined);
    const timer = new AbortController();
    const timeout = this.clock.sleep(this.config.cancelAckTimeoutMs, timer.signal).then(() => 'timeout' as const);
    const raced = await Promise.race([Promise.all([ackP, settledP]).then(([ack, result]) => ({ ack, result })), timeout]);
    timer.abort();
    const ack = raced === 'timeout' ? undefined : raced.ack;
    const completedBeforeStop = raced !== 'timeout' && raced.result?.status === 'completed';
    if (raced === 'timeout') this.logger.log('warn', 'coordinator.cancel.unconfirmed', { taskId: task.taskId, timeoutMs: this.config.cancelAckTimeoutMs });
    const status = decideStopStatus({ dispatched: true, ack, completedBeforeStop, sideEffects: task.ledger.summary(), toolsInFlight: task.ledger.toolsInFlight });
    return this.finishCancel(task, status);
  }

  private async finishCancel(task: Task, status: StopStatus): Promise<void> {
    const report = this.emitCancelled(task, status); // clears the active task before emitting (2g)
    if (this.shuttingDown) {
      this.machine.transition('SHUTDOWN', 'shutdown after cancel');
      return;
    }
    return this.speakThenRest(report, 'cancel_report', task.taskId);
  }

  private emitCancelled(task: Task, status: StopStatus): string {
    task.closed = true;
    this.rememberPriorTask(task, 'cancelled');
    this.closeTaskForTools(task);
    const sideEffects = task.ledger.summary();
    const committedActions = task.ledger.snapshot();
    const report = cancelReport(status, sideEffects, committedActions);
    this.endActive(task); // 2g: before the terminal event, so no listener sees a stale activeTaskId
    this.emit('TaskCancelled', { taskId: task.taskId, stopStatus: status, sideEffects, sideEffectsCommitted: sideEffects === 'committed', committedActions, report }, task);
    this.logger.log(sideEffects === 'none' ? 'info' : 'warn', 'coordinator.task.cancelled', { taskId: task.taskId, stopStatus: status, sideEffects });
    return report;
  }

  private closeTaskForTools(task: Task): void {
    this.clearClarification(task);
    this.endTurn(task);
    if (task.dispatched) this.notifyToolHost(host => host.endTask(task.taskId));
  }

  private finish(task: Task, outcome: TaskOutcome, verified: boolean, summary: string, reason?: TaskFinishReason): void {
    task.closed = true;
    this.rememberPriorTask(task, { outcome, reason });
    this.closeTaskForTools(task);
    this.endActive(task); // 2g: before the terminal event, so no listener sees a stale activeTaskId
    this.emit('TaskFinished', { taskId: task.taskId, outcome, verified, summary, ...(reason !== undefined ? { reason } : {}) }, task);
    this.logger.log('info', 'coordinator.task.finished', { taskId: task.taskId, outcome, verified, attempts: task.attempt, ...(reason !== undefined ? { reason } : {}) });
  }

  /** Internal invariant failure: never leave a task dangling or silently dropped. */
  private abandon(task: Task, why: string): void {
    this.logger.log('error', 'coordinator.task.abandoned', { taskId: task.taskId, why, state: this.state });
    this.finish(task, 'failed', false, `Internal coordinator error: ${why}.`);
  }

  private async speakThenRest(text: string, kind: SpeechKind, taskId: string | undefined): Promise<void> {
    if (this.state !== 'SPEAKING' && !this.machine.transition('SPEAKING', `speak ${kind}`).ok) {
      this.goRest(`could not speak ${kind}`);
      return;
    }
    const token = ++this.speechSeq;
    await this.speech.speak(text, { kind, ...(taskId !== undefined ? { taskId } : {}) }).catch(() => 'interrupted' as const);
    if (this.state === 'SPEAKING' && token === this.speechSeq) this.afterSpeaking();
  }

  private afterSpeaking(): void {
    if (this.active?.clarification) {
      // Ruling 2: open the follow-up window for the answer; the task stays active.
      if (this.machine.transition('LISTENING', 'awaiting clarification answer').ok) {
        this.progress(this.active, 'Listening for your answer', undefined, { awaitingClarification: true, turnsSoFar: this.active.turnSeq });
      }
      return;
    }
    const next = this.shuttingDown ? undefined : this.queue.shift();
    if (next) {
      this.track(this.runFlow(next));
      return;
    }
    this.goRest('response done');
  }

  private goRest(reason: string): void {
    if (this.state !== 'SHUTDOWN') this.machine.transition(this.restState(), reason);
  }

  private restState(): CoordinatorState {
    return this.muted ? 'MUTED' : this.signInRequired ? 'AUTH_REQUIRED' : 'STANDBY';
  }

  private reject(to: CoordinatorState, reason: string): TransitionResult {
    this.logger.log('warn', 'coordinator.transition.rejected', { from: this.state, to, reason });
    return { ok: false, from: this.state, to, error: reason };
  }

  private stateChanged(to: CoordinatorState): void {
    this.publishSnapshot();
    const task = this.active;
    const message = PROGRESS_TEXT[to];
    if (task && !task.closed && message) this.progress(task, message);
  }

  private setActive(task: Task | null): void {
    if (this.active === task) return;
    this.active = task;
    this.publishSnapshot();
  }

  /** Clears the active task only if it is this one: a queued task's terminal event never clears the running task. */
  private endActive(task: Task): void {
    if (this.active === task) this.setActive(null);
  }

  /** 2g.1: each terminal event goes to its own listener set only (no union), once, after the EventSink emit. */
  private deliverTerminal(e: AnyEvent): void {
    if (e.type === 'TaskFinished') this.callEach(this.finishedListeners, e);
    else if (e.type === 'TaskCancelled') this.callEach(this.cancelledListeners, e);
  }

  private callEach<E extends AnyEvent>(listeners: ReadonlySet<(e: E) => void>, e: E): void {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        this.logger.log('error', 'coordinator.task_listener.failed', { type: e.type, eventId: e.eventId, error: err instanceof Error ? err.message : 'unknown' });
      }
    }
  }

  private publishSnapshot(): void {
    const s = this.getState();
    for (const l of [...this.snapshotListeners]) {
      try {
        l(s);
      } catch (err) {
        this.logger.log('error', 'coordinator.snapshot.listener_failed', { error: err instanceof Error ? err.message : 'unknown' });
      }
    }
  }

  private progress(task: Task, message: string, toolId?: string, extra: RedactedMetadata = {}): void {
    if (task.closed) {
      this.logger.log('warn', 'coordinator.progress.after_close', { taskId: task.taskId });
      return;
    }
    this.emit('TaskProgress', { taskId: task.taskId, state: this.state, message, ...(toolId !== undefined ? { toolId } : {}), redactedMetadata: { attempt: task.attempt, ...extra } }, task);
  }

  /**
   * One bounded auth read. A throw, a rejection, or no answer within authReadTimeoutMs yields no AuthState,
   * which the allow-list treats as not signed in. Never returns a cached value.
   */
  private async readAuth(): Promise<AuthObservation> {
    const timer = new AbortController();
    const read = (async (): Promise<AuthObservation> => {
      try {
        return await this.codex.authState();
      } catch {
        return 'read_error';
      }
    })();
    const timeout = this.clock.sleep(this.config.authReadTimeoutMs, timer.signal).then((): AuthObservation => 'read_timeout');
    const observed = await Promise.race([read, timeout]);
    timer.abort();
    return observed;
  }

  /**
   * DOT-061 allow-list gate (ADR-0010, ADR-0012 §3): admits only an explicit `signed_in` from a fresh read that
   * no sign-out notification has overtaken. Runs before the first dispatch, after CONFIRMING and before every retry.
   */
  private async authGate(task: Task, phase: string): Promise<AuthVerdict> {
    const generation = this.authGeneration;
    const observed = await this.readAuth();
    const stale = generation !== this.authGeneration;
    // A notification that overtook the read wins; the stale read never admits.
    const notified = classifyAuth(this.lastNotifiedAuth);
    const cls: AuthVerdict = stale ? (notified === 'admit' ? 'codex_unavailable' : notified) : classifyAuth(observed);
    this.signInRequired = isAccountBlock(cls);
    this.logger.log(cls === 'admit' ? 'info' : 'warn', 'coordinator.auth_gate', { taskId: task.taskId, phase, observed, stale, admitted: cls === 'admit', class: cls });
    return cls;
  }

  private async blockOnAuth(task: Task, cls: Exclude<AuthVerdict, 'admit'>): Promise<void> {
    const sideEffects = task.ledger.summary();
    if (cls === 'codex_unavailable') {
      const outcome: TaskOutcome = sideEffects === 'none' ? 'blocked_unavailable' : 'failed_after_side_effects';
      // Codex is down, not signed out: no AUTH_REQUIRED and no sign-in prompt; the coordinator stays idle (E01 2026-10-19).
      this.signInRequired = false;
      const lead = sideEffects === 'none' ? "I can't reach Codex right now, so I didn't start that." : "I can't reach Codex right now, so I stopped there.";
      const text = sideEffects === 'none' ? `${lead} Nothing was sent. Try again in a moment.` : this.failureText(task, { kind: 'fatal', message: 'codex unavailable' }, lead);
      this.finish(task, outcome, false, `Codex is unavailable. Nothing was sent to Codex for this step. ${text}`, 'codex_unavailable');
      return this.speakThenRest(text, 'result', task.taskId);
    }
    this.signInRequired = true;
    if (!this.machine.transition('AUTH_REQUIRED', `auth gate: ${cls}`).ok) return this.abandon(task, 'cannot enter AUTH_REQUIRED');
    const copy = ACCOUNT_COPY[cls];
    this.finish(task, sideEffects === 'none' ? 'blocked_auth' : 'failed_after_side_effects', false, copy.summary, cls);
    return this.speakThenRest(copy.speak, 'prompt', task.taskId);
  }

  /** Cancel observed at a flow checkpoint: finish here only if the flow owns the cancel (pre-dispatch window). */
  private async cancelCheckpoint(task: Task): Promise<void> {
    if (task.cancelOwner !== 'flow') return;
    // Between turns no Codex turn is in flight, so the stop is observed by the coordinator itself.
    const status = task.dispatched
      ? decideStopStatus({ dispatched: true, ack: { stopped: true, detail: 'no turn in flight' }, completedBeforeStop: false, sideEffects: task.ledger.summary(), toolsInFlight: task.ledger.toolsInFlight })
      : 'stopped_before_dispatch';
    return this.finishCancel(task, status);
  }

  private track(p: Promise<void>): void {
    const tracked = p.catch(err => {
      this.logger.log('error', 'coordinator.flow.crashed', { error: err instanceof Error ? err.message : 'unknown', state: this.state });
      if (this.state !== 'SHUTDOWN' && this.state !== 'ERROR') this.machine.transition('ERROR', 'flow crashed');
    });
    this.flows.add(tracked);
    void tracked.finally(() => this.flows.delete(tracked));
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private emit<T extends EventType>(type: T, payload: EventPayloads[T], task: Task, causationId?: string): string {
    return this.emitRaw(type, payload, task.interactionId, task.taskId, causationId);
  }

  private emitRaw<T extends EventType>(type: T, payload: EventPayloads[T], correlationId: string, taskId?: string, causationId?: string): string {
    const envelope: EventEnvelope<T> = {
      schema: EVENT_SCHEMA,
      version: EVENT_SCHEMA_VERSION,
      type,
      eventId: this.ids.next('evt'),
      correlationId,
      timestamp: this.iso(),
      payload,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(causationId !== undefined ? { causationId } : {}),
    };
    try {
      this.events.emit(envelope as AnyEvent);
    } catch (err) {
      this.logger.log('error', 'coordinator.emit.failed', { type, eventId: envelope.eventId, error: err instanceof Error ? err.message : 'unknown' });
    }
    this.deliverTerminal(envelope as AnyEvent);
    return envelope.eventId;
  }
}

/** turnId = `<taskId>.t<n>` (CONTRACTS §1/§2.1). */
function turnIdFor(taskId: string, n: number): string {
  return `${taskId}.t${n}`;
}

// ------------------------------------------------------------------ E01 2i: port results → event fields (copy, never pass through)
const OBSERVED_KNOWN: readonly string[] = ['outcome', 'decision', 'checks', 'sideEffect', 'question', 'candidates'];
const isScalarValue = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
function copyScope(s: WorkspaceScope): WorkspaceScope {
  return { scopes: [...s.scopes], paths: [...s.paths] };
}
function copyError(e: ToolError): ToolError {
  return { code: e.code, message: e.message, retryable: e.retryable };
}
function copyChecks(c: ObservedState['checks']): ObservedState['checks'] {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return c;
  return Object.fromEntries(Object.keys(c).map(k => [k, c[k]!]));
}
