/**
 * Injected ports. The coordinator never talks to Codex, audio, tools, or the OS directly.
 *  - CodexPort      -> E02 (Codex runtime adapter: App Server, auth, threads, approvals, cancel; CONTRACTS v2 §2.1)
 *  - ToolHostPort   -> E04 (tool host control channel: coordinator-sourced taskId/turnId; CONTRACTS §5 E04 review)
 *  - SpeechPort     -> E05 (TTS playback, barge-in stop)
 *  - VerifierPort   -> E11 with E04 adapters (postcondition checks; "tool returned OK" is not enough)
 *  - PolicyPort     -> E08 (default-deny scopes, pre-dispatch confirmation, approval-channel rules)
 *  - EventSink      -> E06 UI / tray / history (typed IPC transport chosen by E01/E06)
 */
import type { ApprovalDisplay, CodexDisplayParams, RequestSource } from './display.js';
import type {
  AnyEvent,
  ApprovalCategory,
  ApprovalRequested,
  ObservedState,
  Risk,
  SideEffect,
  ToolError,
  ToolResult,
  VerifierOutcome,
  WorkspaceScope,
} from './contracts.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
/** Structured, secret-free logging. Never pass utterance text, tokens, or raw audio as fields. */
export interface Logger {
  log(level: LogLevel, event: string, fields: Readonly<Record<string, LogValue>>): void;
}

export interface Clock {
  now(): number;
  /** Resolves after ms, or early (without throwing) when signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Never used for actionIds (CONTRACTS §3.3 / ADR-0009): those come only from ActionIdPort. */
export interface IdSource {
  next(prefix: 'task' | 'evt' | 'int'): string;
}

/** Canonical-JSON value per CONTRACTS §3.3: scalar leaves are strings or null; arrays keep order. */
export type CanonicalValue = string | null | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };

/**
 * actionId preimage (ADR-0009 CR2, CONTRACTS §3.3). Fields that don't apply are null, never omitted.
 * Pre-dispatch confirmations use method `dottie.pre_dispatch_confirmation`, args {summary, risk, category}
 * (exactly what the secure dialog shows), targets/threadId/turnId/itemId null (nothing dispatched yet).
 */
export interface ActionIdBinding {
  readonly purpose: 'dottie.actionId.v1';
  readonly method: string;
  readonly args: CanonicalValue;
  readonly targets: CanonicalValue;
  readonly taskId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly requestId: string | null;
  /**
   * CR2 top-level displayHash (E01 1k/1q): authoritative for every call: the display hash when a dialog is shown,
   * null when there is none. Pre-dispatch bindings also carry it in args.displayHash, byte-equal (1q).
   */
  readonly displayHash: string | null;
  /** CR2 (E01 1r, E08 co-signed): who raised it, from coordinator/K8 state only. */
  readonly requestSource: RequestSource;
}

/**
 * Injected actionId source. Must return 64 lowercase hex (SHA-256 of the §3.3 canonical JSON). The real one is
 * `contractsActionIdPort` (src/actionIdPort.ts: E02 computeActionId / computeDisplayHash @ 0146c90, vendored). Unwired, throwing, or malformed output fails closed:
 * no ApprovalRequested; the confirmation resolves as decline (ADR-0009 CR1).
 */
export interface ActionIdPort {
  computeActionId(binding: ActionIdBinding): string | Promise<string>;
  /**
   * CONTRACTS §3 X5 (1k/1l): displayHash = SHA-256 (64 lowercase hex) of the §3.3 canonical ApprovalDisplay. Behind
   * the same port as computeActionId so E02's packages/contracts swap covers both. Missing, throwing or malformed →
   * the approval can't be requested (fail closed).
   */
  readonly computeDisplayHash?: ((display: ApprovalDisplay) => string | Promise<string>) | undefined;
}

/**
 * E01 1o: builds the bound display of a Codex approval from the adapter's validated request params (E02 plugs its
 * params in here). null or a throw → the Codex approval is declined with reason display_unavailable.
 * Default: `codexDisplay(request.category, request.display)` from display.ts.
 */
export interface ApprovalDisplayPort {
  codexDisplay(request: CodexApprovalRequest): ApprovalDisplay | null;
}

export interface EventSink {
  emit(event: AnyEvent): void;
}

// ---------------------------------------------------------------- E02: Codex runtime adapter
/** CONTRACTS v2 §2.1 (ADR-0012 §3). Only `signed_in` may dispatch (ADR-0010 allow-list, DOT-061). */
export type AuthState = 'unknown' | 'unavailable' | 'signed_out' | 'signing_in' | 'signed_in' | 'expired' | 'unsupported';

/** Why this run() exists. Every run() is one new Codex turn with its own coordinator-minted turnId. */
export type TurnKind = 'initial' | 'retry' | 'clarification_answer';

export interface CodexTaskRequest {
  readonly taskId: string;
  /** Stable per task (= taskId). */
  readonly idempotencyKey: string;
  /**
   * Coordinator-minted, unique per run() call (`<taskId>.t<n>`). The adapter must never start a second Codex
   * turn for the same turnId, and enforces one in-flight turn per thread itself: Codex does NOT dedupe
   * `clientUserMessageId` (CONTRACTS §1 L52, §6 item 8, E09 wire run 0.163.0). The coordinator never has two
   * run() calls in flight (single active task; a retry is dispatched only after the failed run settled).
   */
  readonly turnId: string;
  /**
   * The adapter sends this as `turn/start.clientUserMessageId` (CONTRACTS §1 L52 `clientUserMessageId?: turnId`: optional in
   * the wire schema, but the coordinator always supplies it and the adapter always sends it). Always equal to turnId, so every
   * retry and every clarification turn carries its own id. It is a correlation id only: the server does not dedupe on
   * it, and nothing in Dottie relies on server-side idempotency.
   */
  readonly clientUserMessageId: string;
  readonly turnKind: TurnKind;
  /** Retry attempt within the current user turn (1 = first try). Reset to 1 for a clarification answer. */
  readonly attempt: number;
  /** Initial request text, or the user's clarification answer for turnKind 'clarification_answer'. */
  readonly text: string;
  readonly threadId?: string;
  readonly workspaceScope: WorkspaceScope;
  /** true for every turn after the first: continue the same thread rather than re-planning from scratch. */
  readonly resume: boolean;
}

export interface CodexApprovalRequest {
  readonly actionId: string;
  readonly summary: string;
  readonly risk: Risk;
  /** v2 (ADR-0012 §4). */
  readonly category: ApprovalCategory;
  readonly toolId?: string;
  /**
   * E01 1o/1r: the adapter's validated params as the 'codex_command' / 'codex_file_change' ApprovalDisplay members
   * (field names settled, E02 895676d mirrors them exactly; unchanged at 0146c90). The coordinator builds the bound display from it (ApprovalDisplayPort);
   * absent, malformed or over the limits → the approval is declined with display_unavailable.
   */
  readonly display?: CodexDisplayParams;
}

/** `display_unavailable` (E01 1k/1o): the bound display couldn't be built, so no dialog was opened. Never "the user declined". */
/** `duplicate_request` (E01 1o c / 1p): a joined Codex request; only the dialog's first request can be approved. */
export type ApprovalDecisionReason = 'approved' | 'denied' | 'expired' | 'cancelled' | 'display_unavailable' | 'duplicate_request';
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason: ApprovalDecisionReason;
}

export interface ToolStart {
  readonly toolId: string;
  /** Adapter/tool catalog (E04) declares whether the call can change external state. Unknown => true. */
  readonly mayHaveSideEffects: boolean;
}

/** Callbacks the adapter invokes while a Codex turn runs. */
export interface CodexRunHooks {
  threadAssigned(threadId: string): void;
  progress(message: string, toolId?: string): void;
  /**
   * Call on every `error` notification with `willRetry:true` (Codex is retrying internally, e.g. the ~14 s of
   * reconnects before a 401). No arguments on purpose: the user only ever sees "Reconnecting…"
   * (`TaskProgress{state:'RECOVERING'}`, CONTRACTS §1.5). The error kind is applied only at the final
   * `willRetry:false` / `turn/completed`, which the adapter reports through run()'s result.
   */
  codexRetrying(): void;
  toolStarted(start: ToolStart): void;
  toolResult(result: Omit<ToolResult, 'taskId'>): void;
  /** Resolves when the user decides, the request expires, or the task is cancelled. Never auto-approves. */
  requestApproval(request: CodexApprovalRequest): Promise<ApprovalDecision>;
}

/** CONTRACTS v2 §1.5. `plan_limit` and `auth` are never retried (no API-key fallback). */
export type CodexErrorKind = 'transient' | 'rate_limited' | 'plan_limit' | 'auth' | 'fatal';
/**
 * Where a failure came from (CONTRACTS §1.5, E01 2026-10-19, E09 wire run on 0.163.0):
 * - `turn_failed`: `turn/completed{status:'failed', error}` (codexErrorInfo classified per §1.5). This is the ONLY
 *   origin the coordinator may retry, and only for rate_limited/transient.
 * - `rpc_error`: a JSON-RPC error response (always -32600, no `data`, so no codexErrorInfo), e.g. a rejected
 *   `turn/start`. Always fatal; the coordinator treats it as fatal whatever `kind` says.
 * - `adapter`: anything else that is not a wire turn failure (adapter bug, transport loss, run aborted without a cancel).
 *   Never retried by the coordinator.
 */
export type CodexErrorOrigin = 'turn_failed' | 'rpc_error' | 'adapter';
export interface CodexError {
  readonly kind: CodexErrorKind;
  readonly origin: CodexErrorOrigin;
  readonly message: string;
}

export type CodexRunResult =
  | { readonly status: 'completed'; readonly summary: string }
  | { readonly status: 'failed'; readonly error: CodexError }
  | { readonly status: 'aborted' };

export interface CancelAck {
  /** true only when the adapter has confirmed the turn and its tool processes stopped. */
  readonly stopped: boolean;
  readonly detail?: string;
}

export interface CodexPort {
  authState(): Promise<AuthState>;
  run(request: CodexTaskRequest, hooks: CodexRunHooks, signal: AbortSignal): Promise<CodexRunResult>;
  /** Propagate cancellation to the Codex turn and active tool processes "when safe" (spec §4). */
  cancel(taskId: string): Promise<CancelAck>;
}

// ---------------------------------------------------------------- E05: speech output
export type SpeechKind = 'progress' | 'result' | 'prompt' | 'cancel_report';
export interface SpeechPort {
  /** Resolves 'interrupted' when stop() is called during playback. */
  speak(text: string, context: { readonly taskId?: string; readonly kind: SpeechKind }): Promise<'completed' | 'interrupted'>;
  /** Barge-in / "stop speaking": halts playback only. Must never cancel a task. */
  stop(): void;
}

// ---------------------------------------------------------------- E11/E04: verification
export interface VerificationInput {
  readonly taskId: string;
  readonly text: string;
  readonly summary: string;
  readonly toolResults: readonly ToolResult[];
}
/** CONTRACTS v2 §2.3. `verified` ≡ outcome === 'verified'. */
export interface VerificationResult {
  readonly outcome: VerifierOutcome;
  readonly verified: boolean;
  readonly observedState: ObservedState;
  readonly error?: ToolError;
  readonly evidenceRef?: string;
}
export interface VerifierPort {
  verify(input: VerificationInput, signal: AbortSignal): Promise<VerificationResult>;
}

// ---------------------------------------------------------------- E08: policy
export type ApprovalChannel = 'secure_ui' | 'tray' | 'voice';
export interface PreDispatchConfirmation {
  readonly summary: string;
  readonly risk: Risk;
  readonly category: ApprovalCategory;
}
export interface PolicyPort {
  /** Default-deny: the scopes/paths the task may use. */
  workspaceScopeFor(text: string): WorkspaceScope;
  /** Non-null => enter CONFIRMING before dispatch (e.g. ambiguous or high-impact request). */
  preDispatchConfirmation(text: string, scope: WorkspaceScope): PreDispatchConfirmation | null;
  /** Spec §9.7: voice identity alone is not sufficient for sensitive confirmation. */
  acceptsApprovalChannel(request: ApprovalRequested, channel: ApprovalChannel): boolean;
}

// ---------------------------------------------------------------- pinned tool catalog (P27, E08 CODEOWNER)
/**
 * Read-only lookup into the pinned catalog `packages/contracts/tool-catalog.json` (CONTRACTS §5 P27): toolId → category.
 * Used by D14 to ignore read/navigate side effects. `undefined` = not in the catalog → needs-confirm and mutating
 * (CONTRACTS §5), so it counts. Unwired = every tool counts (fail closed).
 */
export interface ToolCatalogPort {
  categoryOf(toolId: string): ApprovalCategory | undefined;
}

// ---------------------------------------------------------------- E04: tool host control channel
/**
 * Context the coordinator supplies for every tool call (CONTRACTS §5 "Tool-host context", ADR-0010 single active task).
 * Sourced only from the coordinator; never read from model-supplied tool arguments.
 */
export interface ToolCallContext {
  readonly taskId: string;
  readonly turnId: string;
}

export interface ToolHostPort {
  /** The single active turn, pushed at every turn start; null when no turn may call tools (between turns, after cancel). */
  setActiveTurn(context: ToolCallContext | null): void;
  /** The task ended (TaskFinished/TaskCancelled): the host may drop per-task state such as issued targetIds. */
  endTask(taskId: string): void;
}

/**
 * H→C `authorizeToolCall` params (tool-host-control §4.3; E01 DOT-092 ruling 1d, CONTRACTS @ de045c9 §5).
 * `actionId` is REQUIRED: the host computes it (computeActionId, purpose `dottie.actionId.v1`, CR2 object with
 * `targets` null) after schema validation and before this call, using its advisory setActiveTurn context.
 * Typed as a string, but it crosses IPC: the coordinator validates it (64 lowercase hex) and fails closed with
 * DENIED_BY_POLICY. K8 (E08) recomputes it against the validated args; the coordinator does not (it has no schema).
 */
export interface AuthorizeToolCallParams {
  readonly toolId: string;
  readonly modelArgs: Readonly<Record<string, unknown>>;
  readonly actionId: string;
}

/**
 * Per-call answer on the control channel: Coordinator.authorizeToolCall({toolId, modelArgs, actionId}).
 * Reserved top-level model-argument keys (E01 ruling 6 + E04, 2026-10-19) are `taskId`, `turnId`, `threadId`, `hwnd`,
 * `pid` and spelling variants (case-insensitive, with `_` or `-` allowed before `Id`). Tool schemas are
 * `additionalProperties:false`, so a call carrying one is rejected with INVALID_ARGUMENT (sideEffect none). Nothing is
 * stripped and the tool must not run. Only top level is checked (E01: sufficient). This check comes before the
 * active-turn check, whose failure is PRECONDITION_FAILED (sideEffect none). A missing or malformed `actionId`
 * (ruling 1d) is checked last and gives DENIED_BY_POLICY (sideEffect none).
 */
export type ToolCallAuthorization =
  | {
      readonly ok: true;
      /** Coordinator-sourced; the only taskId/turnId the tool host may use. */
      readonly context: ToolCallContext;
      /** The model's arguments, unchanged (they contain no reserved key). */
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly error: ToolError; readonly sideEffect: 'none' };

/** Fail-closed default until E08 supplies the real policy. */
export const failClosedPolicy: PolicyPort = {
  workspaceScopeFor: () => ({ scopes: [], paths: [] }),
  preDispatchConfirmation: () => null,
  acceptsApprovalChannel: (_request, channel) => channel === 'secure_ui',
};

export type { SideEffect };
