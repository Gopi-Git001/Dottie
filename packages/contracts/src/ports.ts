/**
 * Internal interfaces, main process only (CONTRACTS §2). The renderer never sees these.
 *
 * §2.1 CodexPort is canonical as E03's shape, mirrored verbatim from E03 ports.ts @ da8215a (CodexApprovalRequest.display
 * and ApprovalDecisionReason @ 3029c7b) (E01 is adding it to
 * CONTRACTS §2.1). §2.2 AuthPort is new in v2.
 */
import type { CodexDisplayParams } from './display.js';
import type { ApprovalCategory, AuthState, CodexErrorKind, Risk } from './enums.js';
import type { ToolResult, WorkspaceScope } from './events.js';

// ------------------------------------------------------------------ §2.1 CodexPort (E02 implements, E03 consumes)
// Mirrored VERBATIM from E03 packages/coordinator/src/ports.ts @ da8215a (feature/E03-DOT-061-auth-gate), the E02
// section, lines 48-153. AuthState and CodexErrorKind are the identical aliases from ./enums.js.
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
   * E01 1o/1r (E03 3029c7b, mirrored exactly): the adapter's validated params as the 'codex_command' /
   * 'codex_file_change' members. The coordinator builds the bound display from them; the adapter has already bound
   * computeDisplayHash(codexDisplay(category, display)) as the top-level displayHash of `actionId`. Absent, malformed
   * or over the limits → declined with display_unavailable, no dialog.
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

// CodexErrorKind: from ./enums.js (identical: CONTRACTS v2 §1.5; plan_limit and auth are never retried).
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

// ------------------------------------------------------------------ §2.2 AuthPort (E02 implements, E06 consumes)
export interface AuthStatusInfo {
  readonly status: AuthState;
  /** Plan name only unless E08 approves email (DOT-063). */
  readonly accountLabel: string | null;
  /** User-safe text. */
  readonly message: string;
}

export type LoginMode = 'browser' | 'device_code';

export type LoginStarted =
  /** The adapter already opened the URL (ADR-0015); no authUrl crosses this port. */
  | { readonly mode: 'browser'; readonly loginId: string }
  /** Display only; the adapter opens verificationUrl itself. */
  | { readonly mode: 'device_code'; readonly loginId: string; readonly verificationUrl: string; readonly userCode: string }
  | { readonly mode: 'unavailable'; readonly reason: string };

export interface AuthPort {
  getStatus(): Promise<AuthStatusInfo>;
  beginLogin(mode: LoginMode): Promise<LoginStarted>;
  cancelLogin(loginId: string): Promise<'canceled' | 'not_found'>;
  /** account/logout, then a fresh account/read. */
  logout(): Promise<void>;
  onStatusChange(cb: (s: AuthStatusInfo) => void): () => void;
}

// ------------------------------------------------------------------ §2.5 tool-host control channel params (DOT-092 ruling 1d)
// Shapes from docs/contracts/tool-host-control.md DRAFT 8 (E03 owns the channel; mirrored here only for the required
// actionId). actionId = computeActionId(toolCallBinding(...)) over the validated args (targets null); K8 recomputes it
// (mismatch → wrong_action, missing/malformed → malformed, both DENIED_BY_POLICY, sideEffect 'none').
export interface AuthorizeToolCallParams {
  readonly v: 1;
  readonly callId: string;
  readonly toolId: string;
  /** REQUIRED (ruling 1d). */
  readonly actionId: string;
  /** Top-level args exactly as received from MCP. */
  readonly modelArgs: Readonly<Record<string, unknown>>;
  /** Informational only, never trusted for authority. */
  readonly mcp: { readonly requestId: string | null; readonly itemId: string | null };
}
export interface CheckPolicyParams {
  readonly v: 1;
  readonly callId: string;
  readonly toolId: string;
  /** REQUIRED (ruling 1d): must equal the actionId authorizeToolCall accepted for this callId, else DENIED_BY_POLICY. */
  readonly actionId: string;
  readonly category: 'navigate';
}
/** K8's first check on either params object: `malformed` when actionId is missing or not a lowercase-hex SHA-256. */
export function toolCallActionIdStatus(p: unknown): 'ok' | 'malformed' {
  const id = typeof p === 'object' && p !== null ? (p as { actionId?: unknown }).actionId : undefined;
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? 'ok' : 'malformed';
}
