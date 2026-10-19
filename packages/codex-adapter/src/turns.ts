/**
 * CodexPort over the App Server (DOT-011 slice 2): threads and turns behind E03's canonical port (CONTRACTS §2.1).
 * threadId/turnId stay inside the adapter; the coordinator sees CodexRunHooks, CodexRunResult and CancelAck only.
 *
 * Safety rules enforced here:
 * - Gate (ADR-0010): turn/start is never written unless AuthState is signed_in, checked by a fresh account/read at
 *   run() entry AND against the latest status immediately before the write (the App Server itself accepts
 *   thread/start and turn/start while signed out, V-run L16-18).
 * - Threads are started/resumed with approvalPolicy "on-request" and the read-only sandbox by default. The server's
 *   echoed policy and sandbox are checked; a mismatch refuses the task before any turn exists.
 * - Idempotency (CONTRACTS §1.3, E01 2026-10-19; 0.163.0 does NOT dedupe clientUserMessageId and appends a second
 *   turn/start to the active turn): one Codex turn per coordinator turnId (sent as clientUserMessageId), and as a
 *   second layer at most one task per thread at a time and at most one run per taskId and per idempotencyKey. All are refused locally, before any wire write.
 *   Once turn/start may have reached the server the record is `dispatching`, and that attempt is never dispatched
 *   again (a crash leaves it `unknown`, not retried).
 * - Cancel sends turn/interrupt and reports stopped:true ONLY after turn/completed{status:"interrupted"} is observed.
 * - Errors (CONTRACTS §1.5 "Where errors come from"): a JSON-RPC error response (always -32600, no data) is `fatal`.
 *   The kind comes from turn/completed{failed}.error.codexErrorInfo (falling back to the last willRetry:false error
 *   notification); willRetry:true notifications only surface "reconnecting". auth (401/unauthorized, including
 *   httpConnectionFailed{401}) → AuthPort.markExpired(); plan_limit is terminal. The adapter never retries by itself:
 *   the coordinator retries per shouldRetryTurn() (rate_limited/transient AND ledger empty AND attempt < max), and a
 *   failed turn whose ledger is not empty is reported as `fatal` so it can never be blindly retried.
 * - Server requests: the approvals bridge (approvals/bridge.ts) when configured, else the slice-1 default-deny.
 */
import { authGate, RETRYABLE_ERROR_KINDS, type AuthGate, type AuthState, type CancelAck, type CodexError, type CodexErrorKind, type CodexErrorOrigin, type CodexPort, type CodexRunHooks, type CodexRunResult, type CodexTaskRequest } from '@dottie/contracts';
import type { AuthService } from './auth-service.js';
import { RpcError } from './connection.js';
import { classifyCodexErrorInfo, classifyRpcError, interpretErrorNotification, type ClassifiedError } from './errors.js';
import type { Logger } from './logger.js';
import type { AppServerRuntime } from './runtime.js';
import type { Scheduler } from './scheduler.js';
import { DISPATCHED_STATES, LIVE_STATES, MemoryTurnStore, type TurnRecord, type TurnRecordState, type TurnStore } from './turn-store.js';

export type ThreadSandbox = 'read-only' | 'workspace-write';
const SANDBOX_ECHO: Readonly<Record<ThreadSandbox, string>> = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite' };
const APPROVAL_POLICY = 'on-request';

export interface TurnRunnerOptions {
  readonly logger: Logger;
  readonly scheduler: Scheduler;
  readonly random?: () => number;
  readonly store?: TurnStore;
  /** Thread sandbox. Default read-only; danger-full-access is not representable. */
  readonly sandbox?: ThreadSandbox;
  /** cwd when the task's workspaceScope has no paths. Without either, the task is refused. */
  readonly defaultCwd?: string;
  /** How long cancel() waits for turn/completed{interrupted}. Default 10 s. */
  readonly interruptTimeoutMs?: number;
  /** Agent-message deltas are coalesced into at most one progress() per period. Default 250 ms. */
  readonly progressThrottleMs?: number;
  readonly requestTimeoutMs?: number;
}

type TurnEnd =
  | { readonly kind: 'turn'; readonly status: 'completed' | 'interrupted' | 'failed'; readonly error: unknown }
  | { readonly kind: 'lost' };
type DispatchState = 'not_dispatched' | 'running' | 'lost';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(v: T): void;
  settled: boolean;
}
function deferred<T>(): Deferred<T> {
  let r!: (v: T) => void;
  const d: Deferred<T> = {
    promise: new Promise<T>((res) => (r = res)),
    settled: false,
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      r(v);
    },
  };
  return d;
}

interface Active {
  readonly request: CodexTaskRequest;
  readonly hooks: CodexRunHooks;
  readonly generation: number;
  threadId?: string;
  turnId?: string;
  phase: 'preparing' | 'dispatching' | 'running' | 'done';
  cancelRequested: boolean;
  cancelAck?: Promise<CancelAck>;
  readonly dispatch: Deferred<DispatchState>;
  readonly end: Deferred<TurnEnd>;
  readonly buffered: [string, Record<string, unknown>][];
  readonly agentText: Map<string, string>;
  lastAgentItem?: string;
  finalMessage?: string;
  lastError?: ClassifiedError;
  lastProgress?: string;
  cancelProgressTimer?: (() => void) | undefined;
  /** Action ledger for this turn (CONTRACTS §1.5): true once any possibly side-effecting item has started. */
  ledgerTouched: boolean;
  /** Dottie turnIds already dispatched for this task by earlier runs (from the store). */
  priorTurnIds: readonly string[];
}

/**
 * The bounded retry rule (CONTRACTS §1.5, E01 2026-10-19): retry only when the failed turn classifies as
 * rate_limited or transient AND its action ledger is empty AND attempt < maxAttempts. auth and plan_limit never.
 */
export function shouldRetryTurn(kind: CodexErrorKind, ledgerEmpty: boolean, attempt: number, maxAttempts: number): boolean {
  return RETRYABLE_ERROR_KINDS.has(kind) && ledgerEmpty && Number.isInteger(attempt) && attempt < maxAttempts;
}

/**
 * turn/start clientUserMessageId is the coordinator's turnId, taken from the request (E03 ports.ts: always equal
 * to turnId, new for every retry and clarification turn). Fail closed: a request where they differ or are empty is
 * refused before any wire write. It is correlation only; the server does not dedupe on it.
 */
function turnIdOk(request: CodexTaskRequest): boolean {
  return typeof request.turnId === 'string' && request.turnId.length > 0 && request.clientUserMessageId === request.turnId;
}

const GATE_MESSAGES = {
  auth_required: 'Sign in with ChatGPT to use Codex.',
  sign_in_in_progress: 'Finish signing in with ChatGPT first.',
  account_unsupported: "This ChatGPT account can't run Codex. Sign out or switch accounts.",
  codex_unavailable: "Codex isn't available right now.",
} as const;
/** §2.1 gate → CodexRunResult. blocked_unavailable is `transient`, never `auth`, so it can't become a sign-in prompt. */
function gateFailure(g: Exclude<AuthGate, { admit: true }>): CodexRunResult {
  return fail('adapter', g.outcome === 'blocked_auth' ? 'auth' : 'transient', GATE_MESSAGES[g.reason]);
}
const LEDGER_NOT_EMPTY = 'Codex failed after it may already have changed something, so I won\'t retry it automatically.';

const MESSAGES: Readonly<Record<CodexErrorKind, string>> = {
  auth: 'Your ChatGPT sign-in has expired. Please sign in again.',
  plan_limit: "You've reached your ChatGPT plan's Codex usage limit.",
  rate_limited: 'Codex is busy right now. Please try again in a moment.',
  transient: 'Codex had a temporary problem.',
  fatal: 'Codex could not complete this task.',
};
const UNKNOWN_OUTCOME = "Codex stopped unexpectedly while working on this, so I can't tell how far it got.";
const TOOL_PROGRESS: Readonly<Record<string, string>> = {
  commandExecution: 'Running a command.',
  fileChange: 'Changing files.',
  mcpToolCall: 'Using a tool.',
  dynamicToolCall: 'Using a tool.',
  collabAgentToolCall: 'Working with a helper agent.',
  webSearch: 'Searching the web.',
  imageGeneration: 'Creating an image.',
};
/** Tool-like items that cannot change anything on this PC. Everything else counts as possibly side-effecting. */
const NO_LOCAL_SIDE_EFFECTS = new Set(['webSearch']);
const MAX_PROGRESS_CHARS = 1000;

/**
 * Every failure carries its origin (E03 ports.ts @ da8215a, CONTRACTS §1.5): `turn_failed` = turn/completed{failed}
 * (the only origin the coordinator may retry), `rpc_error` = a JSON-RPC error response, `adapter` = anything the
 * adapter decides itself (gate refusal, duplicate, echo mismatch, lost child, cancel/interrupt without a cancel…).
 */
const fail = (origin: CodexErrorOrigin, kind: CodexErrorKind, message: string = MESSAGES[kind]): CodexRunResult => ({
  status: 'failed',
  error: { kind, origin, message } satisfies CodexError,
});
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

class PolicyMismatchError extends Error {}
/** Ruling 1s: thread/resume echoed a different threadId. Fail closed as blocked_unavailable; nothing is dispatched. */
class ThreadEchoMismatchError extends Error {}
/** §2.1 blocked_unavailable/codex_unavailable (transient, origin adapter: never retried by the coordinator, never sign-in). */
const UNAVAILABLE_GATE = { admit: false, outcome: 'blocked_unavailable', reason: 'codex_unavailable' } as const;

export class CodexTaskRunner implements CodexPort {
  private readonly store: TurnStore;
  private readonly active = new Map<string, Active>();
  private readonly loadedThreads = new Set<string>();
  /** threadId → taskId of the one task allowed on that thread (reserved synchronously, before any await). */
  private readonly threadOwner = new Map<string, string>();
  private generation = 0;
  private readonly recovered: Promise<void>;
  private cancelListener: ((taskId: string) => void) | undefined;
  private reconciledGeneration = -1;
  private reconciling: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: AppServerRuntime,
    private readonly auth: AuthService,
    private readonly options: TurnRunnerOptions,
  ) {
    this.store = options.store ?? new MemoryTurnStore();
    runtime.onReady(() => {
      this.generation++;
      this.loadedThreads.clear();
    });
    runtime.onStatus((s) => {
      if (s !== 'running') this.childLost();
    });
    runtime.onNotification((method, params) => this.onNotification(method, params));
    this.recovered = this.recover();
  }

  // ------------------------------------------------------------------ CodexPort
  async authState(): Promise<AuthState> {
    return (await this.auth.getStatus()).status;
  }

  async run(request: CodexTaskRequest, hooks: CodexRunHooks, signal: AbortSignal): Promise<CodexRunResult> {
    await this.recovered;
    if (this.reconciledGeneration !== this.generation && this.runtime.status === 'running') {
      this.reconciledGeneration = this.generation;
      this.reconciling = this.reconcileUnknown();
    }
    await this.reconciling;
    const log = this.options.logger;
    const ids = { taskId: request.taskId, attempt: request.attempt, turnId: request.turnId };
    if (this.active.has(request.taskId)) return fail('adapter', 'fatal', 'This task is already running.');
    if ([...this.active.values()].some((x) => x.request.idempotencyKey === request.idempotencyKey)) {
      log.log('warn', 'codex.turn.duplicate_refused', { ...ids, state: 'active_key' });
      return fail('adapter', 'fatal', 'This task is already running.');
    }
    if (signal.aborted) return { status: 'aborted' };
    const prior = await this.store.get(request.taskId);
    if (!turnIdOk(request)) {
      log.log('warn', 'codex.turn.bad_turn_id', ids);
      return fail('adapter', 'fatal');
    }
    // One Codex turn per coordinator turnId, ever (a clarification answer resets attempt to 1, so key+attempt is not
    // unique; turnId is). The task's dispatched turnIds are persisted with its record.
    const legacyDup = prior?.dispatchedTurnIds === undefined && prior?.idempotencyKey === request.idempotencyKey && prior.attempt === request.attempt && DISPATCHED_STATES.has(prior.state);
    if (prior && ((prior.dispatchedTurnIds ?? []).includes(request.turnId) || legacyDup)) {
      log.log('warn', 'codex.turn.duplicate_refused', { ...ids, state: prior.state });
      return fail('adapter', 'fatal', 'This task was already sent to Codex, so it was not sent again.');
    }
    // One task per thread (second layer behind turnId): check and reserve synchronously, before ANY wire write
    // (including the gate's account/read), so a racing run on the same thread can never reach the server.
    const candidate = request.threadId ?? (request.resume ? prior?.threadId : undefined);
    if (candidate !== undefined && !this.reserveThread(request.taskId, candidate)) return this.threadBusy(request);
    try {
      if (this.runtime.status !== 'running') return fail('adapter', 'transient', GATE_MESSAGES.codex_unavailable);
      let state: AuthState;
      try {
        state = (await this.auth.getStatus()).status;
      } catch {
        state = 'unavailable';
      }
      const gate = authGate(state);
      if (!gate.admit) {
        log.log('info', 'codex.turn.gate_blocked', { ...ids, authState: state, reason: gate.reason });
        return gateFailure(gate);
      }
      if (this.active.has(request.taskId) || [...this.active.values()].some((x) => x.request.idempotencyKey === request.idempotencyKey)) {
        return fail('adapter', 'fatal', 'This task is already running.');
      }
      const a: Active = {
        request,
        hooks,
        generation: this.generation,
        phase: 'preparing',
        cancelRequested: false,
        dispatch: deferred(),
        end: deferred(),
        buffered: [],
        agentText: new Map(),
        ledgerTouched: false,
        priorTurnIds: prior?.dispatchedTurnIds ?? [],
      };
      this.active.set(request.taskId, a);
      const onAbort = () => void this.cancel(request.taskId);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await this.drive(a, prior);
      } finally {
        signal.removeEventListener('abort', onAbort);
        a.phase = 'done';
        a.cancelProgressTimer?.();
        a.dispatch.resolve('not_dispatched');
        for (const [t, owner] of this.threadOwner) if (owner === request.taskId) this.threadOwner.delete(t);
        this.active.delete(request.taskId);
      }
    } finally {
      for (const [t, owner] of this.threadOwner) if (owner === request.taskId) this.threadOwner.delete(t);
    }
  }

  /** Approvals bridge lookup: the running task that owns this exact Codex turn on the current child. */
  lookupTurn(threadId: string, turnId: string): { readonly taskId: string; readonly hooks: CodexRunHooks } | undefined {
    for (const a of this.active.values()) {
      if (a.phase === 'running' && a.generation === this.generation && a.threadId === threadId && a.turnId === turnId) {
        return { taskId: a.request.taskId, hooks: a.hooks };
      }
    }
    return undefined;
  }

  /** Called first on every cancel (ADR-0009 item 7: task cancel revokes the task's pending approvals). */
  setCancelListener(cb: ((taskId: string) => void) | undefined): void {
    this.cancelListener = cb;
  }

  async cancel(taskId: string): Promise<CancelAck> {
    try {
      this.cancelListener?.(taskId);
    } catch {
      this.options.logger.log('error', 'codex.turn.cancel_listener_threw', { taskId });
    }
    const a = this.active.get(taskId);
    if (!a) return this.cancelInactive(taskId);
    a.cancelRequested = true;
    a.cancelAck ??= this.cancelActive(a);
    return a.cancelAck;
  }

  // ------------------------------------------------------------------ run
  private async drive(a: Active, prior: TurnRecord | undefined): Promise<CodexRunResult> {
    const { request } = a;
    const log = this.options.logger;
    const cwd = request.workspaceScope.paths[0] ?? this.options.defaultCwd;
    if (cwd === undefined) return fail('adapter', 'fatal', 'No workspace folder was given for this task.');

    let threadId: string;
    try {
      threadId = await this.ensureThread(a, prior, cwd);
    } catch (e) {
      if (e instanceof PolicyMismatchError) return fail('adapter', 'fatal');
      if (e instanceof ThreadEchoMismatchError) return gateFailure(UNAVAILABLE_GATE);
      if (e instanceof RpcError) return this.failFromRpc(e, a, 'thread');
      // Closed / timed out / runtime down: no turn can exist yet, so this is safely transient.
      log.log('warn', 'codex.thread.unavailable', { taskId: request.taskId, error: e instanceof Error ? e.name : 'unknown' });
      return fail('adapter', 'transient', GATE_MESSAGES.codex_unavailable);
    }
    if (!this.reserveThread(request.taskId, threadId)) return this.threadBusy(request);
    a.threadId = threadId;
    this.safeHook(() => a.hooks.threadAssigned(threadId));
    await this.record(a, 'thread_ready');

    if (a.cancelRequested) return this.stoppedBeforeDispatch(a);
    if (this.generation !== a.generation || this.runtime.status !== 'running') return fail('adapter', 'transient', GATE_MESSAGES.codex_unavailable);
    // Last-moment gate: the latest published status, which account/updated and markExpired keep current.
    const latest = authGate(this.auth.snapshot.status);
    if (!latest.admit) {
      log.log('info', 'codex.turn.gate_blocked', { taskId: request.taskId, authState: this.auth.snapshot.status, reason: latest.reason });
      await this.record(a, 'thread_ready');
      return gateFailure(latest);
    }
    // Belt and braces for the no-dedupe server: never a second turn/start while this thread has a live turn.
    if (this.threadOwner.get(threadId) !== request.taskId) return this.threadBusy(request);
    a.phase = 'dispatching';
    await this.record(a, 'dispatching');
    let result: unknown;
    try {
      result = await this.runtime.request(
        'turn/start',
        { threadId, input: [{ type: 'text', text: request.text, text_elements: [] }], clientUserMessageId: request.clientUserMessageId },
        this.options.requestTimeoutMs,
      );
    } catch (e) {
      if (e instanceof RpcError) {
        // The server answered with an error (always -32600, no data): no turn was created. fatal, not retried.
        await this.record(a, 'thread_ready');
        a.dispatch.resolve('not_dispatched');
        return this.failFromRpc(e, a, 'turn');
      }
      // Timed out / connection closed: turn/start may have reached the server. Outcome unknown, never re-sent.
      log.log('warn', 'codex.turn.start_unknown', { taskId: request.taskId, error: e instanceof Error ? e.name : 'unknown' });
      await this.record(a, 'unknown');
      a.dispatch.resolve('lost');
      return fail('adapter', 'fatal', UNKNOWN_OUTCOME);
    }
    const turnId = str(obj(obj(result)['turn'])['id']);
    if (turnId === undefined) {
      await this.record(a, 'unknown');
      a.dispatch.resolve('lost');
      return fail('adapter', 'fatal', UNKNOWN_OUTCOME);
    }
    a.turnId = turnId;
    a.phase = 'running';
    await this.record(a, 'in_flight');
    log.log('info', 'codex.turn.started', { taskId: request.taskId, threadId, turnId });
    for (const [m, p] of a.buffered.splice(0)) this.handle(a, m, p);
    a.dispatch.resolve('running');
    return this.finish(a, await a.end.promise);
  }

  private async finish(a: Active, end: TurnEnd): Promise<CodexRunResult> {
    a.cancelProgressTimer?.();
    const log = this.options.logger;
    const ids = { taskId: a.request.taskId, threadId: a.threadId ?? '', turnId: a.turnId ?? '' };
    if (end.kind === 'lost') {
      log.log('warn', 'codex.turn.lost', ids);
      await this.record(a, 'unknown');
      return fail('adapter', 'fatal', UNKNOWN_OUTCOME);
    }
    if (end.status === 'completed') {
      await this.record(a, 'completed');
      log.log('info', 'codex.turn.completed', ids);
      // Unverified by construction: the coordinator runs the verifier before any TaskFinished.
      return { status: 'completed', summary: a.finalMessage ?? '' };
    }
    if (end.status === 'interrupted') {
      await this.record(a, 'interrupted');
      log.log('info', 'codex.turn.interrupted', { ...ids, requested: a.cancelRequested });
      return a.cancelRequested ? { status: 'aborted' } : fail('adapter', 'fatal', 'Codex stopped this task before it finished.');
    }
    const info = obj(end.error)['codexErrorInfo'];
    const c = info !== undefined && info !== null ? classifyCodexErrorInfo(info) : (a.lastError ?? classifyCodexErrorInfo(null));
    await this.record(a, 'failed');
    log.log('warn', 'codex.turn.failed', { ...ids, kind: c.kind, variant: c.variant, httpStatusCode: c.httpStatusCode ?? -1, ledgerEmpty: !a.ledgerTouched });
    if (c.authExpired) this.auth.markExpired();
    // Retry rule (§1.5): a retryable kind stays retryable only while the turn's ledger is empty.
    if (RETRYABLE_ERROR_KINDS.has(c.kind) && a.ledgerTouched) return fail('turn_failed', 'fatal', LEDGER_NOT_EMPTY);
    return fail('turn_failed', c.kind);
  }

  private async ensureThread(a: Active, prior: TurnRecord | undefined, cwd: string): Promise<string> {
    const sandbox = this.options.sandbox ?? 'read-only';
    const common = { cwd, approvalPolicy: APPROVAL_POLICY, sandbox };
    const candidate = a.request.threadId ?? (a.request.resume ? prior?.threadId : undefined);
    let res: Record<string, unknown>;
    if (candidate !== undefined) {
      // Ruling 1s: a given threadId is made loaded in THIS App Server process whatever `resume` says (the flag only
      // picks the prior thread when no threadId is given). loadedThreads is cleared on every restart.
      if (this.loadedThreads.has(candidate)) return candidate;
      // excludeTurns (E09 v0.3.0): no full-history hydration, so no deprecationNotice and a small result.
      res = obj(await this.runtime.request('thread/resume', { threadId: candidate, ...common, excludeTurns: true }, this.options.requestTimeoutMs));
    } else {
      res = obj(await this.runtime.request('thread/start', common, this.options.requestTimeoutMs));
    }
    const id = str(obj(res['thread'])['id']);
    const echoedPolicy = res['approvalPolicy'];
    const echoedSandbox = str(obj(res['sandbox'])['type']);
    if (id === undefined || echoedPolicy !== APPROVAL_POLICY || echoedSandbox !== SANDBOX_ECHO[sandbox]) {
      this.runtime.audit.emit('codex.thread_policy_mismatch', {
        taskId: a.request.taskId,
        approvalPolicy: typeof echoedPolicy === 'string' ? echoedPolicy : 'non-string',
        sandbox: echoedSandbox ?? 'missing',
      });
      throw new PolicyMismatchError();
    }
    if (candidate !== undefined && id !== candidate) {
      this.runtime.audit.emit('codex.thread_echo_mismatch', { taskId: a.request.taskId });
      throw new ThreadEchoMismatchError();
    }
    this.loadedThreads.add(id);
    return id;
  }

  private stoppedBeforeDispatch(a: Active): Promise<CodexRunResult> {
    a.dispatch.resolve('not_dispatched');
    return this.record(a, 'stopped_before_dispatch').then(() => ({ status: 'aborted' }) as const);
  }

  private reserveThread(taskId: string, threadId: string): boolean {
    const owner = this.threadOwner.get(threadId);
    if (owner !== undefined && owner !== taskId) return false;
    this.threadOwner.set(threadId, taskId);
    return true;
  }

  private threadBusy(request: CodexTaskRequest): CodexRunResult {
    this.options.logger.log('warn', 'codex.turn.duplicate_refused', { taskId: request.taskId, turnId: request.turnId, state: 'thread_busy' });
    return fail('adapter', 'fatal', 'Codex is already working on this conversation, so this was not sent.');
  }

  private async failFromRpc(e: RpcError, a: Active, stage: 'thread' | 'turn'): Promise<CodexRunResult> {
    const c = classifyRpcError();
    this.options.logger.log('warn', `codex.${stage}.rejected`, { taskId: a.request.taskId, code: e.code, kind: c.kind, variant: c.variant });
    if (c.authExpired) this.auth.markExpired();
    return fail('rpc_error', 'fatal');
  }

  // ------------------------------------------------------------------ cancel
  private async cancelActive(a: Active): Promise<CancelAck> {
    const log = this.options.logger;
    const dispatched = await a.dispatch.promise;
    if (dispatched === 'not_dispatched') return { stopped: true, detail: 'stopped_before_dispatch' };
    if (dispatched === 'lost') return { stopped: false, detail: 'stop_unconfirmed' };
    if (!a.end.settled) {
      this.runtime
        .request('turn/interrupt', { threadId: a.threadId, turnId: a.turnId }, this.options.requestTimeoutMs)
        .catch((e: unknown) => log.log('warn', 'codex.turn.interrupt_error', { taskId: a.request.taskId, error: e instanceof Error ? e.name : 'unknown' }));
    }
    let cancelTimer: () => void = () => undefined;
    const timeout = new Promise<'timeout'>((r) => (cancelTimer = this.options.scheduler.setTimeout(() => r('timeout'), this.options.interruptTimeoutMs ?? 10_000)));
    const end = await Promise.race([a.end.promise, timeout]);
    cancelTimer();
    if (end === 'timeout') {
      log.log('warn', 'codex.turn.stop_unconfirmed', { taskId: a.request.taskId, turnId: a.turnId ?? '' });
      return { stopped: false, detail: 'stop_unconfirmed' };
    }
    if (end.kind === 'lost') return { stopped: false, detail: 'stop_unconfirmed' };
    if (end.status === 'interrupted') return { stopped: true, detail: 'interrupted' };
    return { stopped: false, detail: 'completed_before_stop' };
  }

  private async cancelInactive(taskId: string): Promise<CancelAck> {
    const rec = await this.store.get(taskId);
    switch (rec?.state) {
      case 'completed':
      case 'failed':
        return { stopped: false, detail: 'completed_before_stop' };
      case 'interrupted':
        return { stopped: true, detail: 'interrupted' };
      case 'stopped_before_dispatch':
        return { stopped: true, detail: 'stopped_before_dispatch' };
      case 'unknown':
      case 'dispatching':
      case 'in_flight':
        return { stopped: false, detail: 'stop_unconfirmed' };
      default:
        return { stopped: false, detail: 'no_active_turn' };
    }
  }

  // ------------------------------------------------------------------ notifications
  private onNotification(method: string, params: unknown): void {
    if (!(method.startsWith('turn/') || method.startsWith('item/') || method === 'error')) return;
    const p = obj(params);
    const threadId = str(p['threadId']);
    if (threadId === undefined) return;
    const a = [...this.active.values()].find((x) => x.threadId === threadId && x.generation === this.generation);
    if (!a) return;
    if (a.turnId === undefined) {
      if (a.phase === 'dispatching') a.buffered.push([method, p]);
      return;
    }
    this.handle(a, method, p);
  }

  private handle(a: Active, method: string, p: Record<string, unknown>): void {
    const turnId = str(p['turnId']) ?? str(obj(p['turn'])['id']);
    if (turnId !== a.turnId) return;
    switch (method) {
      case 'item/agentMessage/delta': {
        const itemId = str(p['itemId']);
        const delta = str(p['delta']);
        if (itemId === undefined || delta === undefined) return;
        a.agentText.set(itemId, (a.agentText.get(itemId) ?? '') + delta);
        a.lastAgentItem = itemId;
        if (!a.cancelProgressTimer) {
          a.cancelProgressTimer = this.options.scheduler.setTimeout(() => {
            a.cancelProgressTimer = undefined;
            this.emitAgentText(a);
          }, this.options.progressThrottleMs ?? 250);
        }
        return;
      }
      case 'item/started': {
        const item = obj(p['item']);
        const type = str(item['type']);
        const id = str(item['id']);
        // Ruling 2i: own-key lookup only. `in` let a wire type named after an Object.prototype member
        // ('constructor', 'toString'…) through as a tool item and pushed the inherited function into progress.
        if (type === undefined || id === undefined || !Object.hasOwn(TOOL_PROGRESS, type)) return;
        const mayHaveSideEffects = !NO_LOCAL_SIDE_EFFECTS.has(type);
        if (mayHaveSideEffects) a.ledgerTouched = true;
        this.safeHook(() => a.hooks.toolStarted({ toolId: id, mayHaveSideEffects }));
        this.progress(a, TOOL_PROGRESS[type] as string);
        return;
      }
      case 'item/completed': {
        const item = obj(p['item']);
        if (item['type'] !== 'agentMessage') return;
        const id = str(item['id']);
        const text = str(item['text']);
        if (id === undefined || text === undefined) return;
        a.agentText.set(id, text);
        a.lastAgentItem = id;
        a.finalMessage = text;
        a.cancelProgressTimer?.();
        a.cancelProgressTimer = undefined;
        this.emitAgentText(a);
        return;
      }
      case 'turn/plan/updated': {
        const plan = Array.isArray(p['plan']) ? p['plan'] : [];
        const done = plan.filter((s) => obj(s)['status'] === 'completed').length;
        this.progress(a, `Plan: ${done} of ${plan.length} steps done.`);
        return;
      }
      case 'error': {
        const r = interpretErrorNotification(p);
        // willRetry:true: Codex is retrying itself. Tell the coordinator on EVERY one (it collapses the burst into
        // "Reconnecting…"); no kind is applied until willRetry:false / turn/completed.
        if (r.recovering) this.safeHook(() => a.hooks.codexRetrying());
        else a.lastError = r.error;
        return;
      }
      case 'turn/completed': {
        const turn = obj(p['turn']);
        const status = turn['status'];
        if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') return;
        a.end.resolve({ kind: 'turn', status, error: turn['error'] });
        return;
      }
      default:
        return;
    }
  }

  private emitAgentText(a: Active): void {
    const text = a.lastAgentItem === undefined ? undefined : a.agentText.get(a.lastAgentItem);
    if (!text) return;
    this.progress(a, text.length > MAX_PROGRESS_CHARS ? `…${text.slice(-MAX_PROGRESS_CHARS)}` : text);
  }

  private progress(a: Active, message: string): void {
    if (a.phase === 'done' || message === a.lastProgress) return;
    a.lastProgress = message;
    this.safeHook(() => a.hooks.progress(message));
  }

  private safeHook(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.options.logger.log('error', 'codex.turn.hook_threw', { error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  // ------------------------------------------------------------------ restart / recovery
  /** The child went away: every turn of that child is reported as an unknown outcome (never as success or as retried). */
  private childLost(): void {
    for (const a of this.active.values()) {
      if (a.generation !== this.generation) continue;
      if (a.phase === 'running') a.end.resolve({ kind: 'lost' });
    }
  }

  /** On construction: turns a previous process left dispatching/in flight become `unknown`. */
  private async recover(): Promise<void> {
    for (const r of await this.store.list()) {
      if (!LIVE_STATES.has(r.state)) continue;
      this.options.logger.log('warn', 'codex.turn.recovered_unknown', { taskId: r.taskId, turnId: r.turnId ?? '' });
      await this.store.put({ ...r, state: 'unknown', updatedAt: this.options.scheduler.now() });
    }
  }

  /**
   * After a restart: cross-check `unknown` records against the server (thread/turns/list; E09 v0.3.0 showed each turn's
   * userMessage carries clientId = our turnId). Store first, server second: the record stays `unknown` and is never
   * resent; only `serverCheck` is written. Any failure leaves `unavailable`, re-checked once on the next child; settled
   * results (match/absent/mismatch) are not re-checked. Runs once per child generation.
   */
  private async reconcileUnknown(): Promise<void> {
    const MAX_PAGES = 4;
    const todo = (await this.store.list()).filter((r) => r.state === 'unknown' && r.threadId !== undefined && r.dottieTurnId !== undefined && (r.serverCheck === undefined || r.serverCheck.result === 'unavailable'));
    const byThread = new Map<string, TurnRecord[]>();
    for (const r of todo) byThread.set(r.threadId as string, [...(byThread.get(r.threadId as string) ?? []), r]);
    for (const [threadId, records] of byThread) {
      const turns: Record<string, unknown>[] = [];
      let ok = true;
      try {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = obj(await this.runtime.request('thread/turns/list', { threadId, ...(cursor !== undefined ? { cursor } : {}) }, this.options.requestTimeoutMs));
          if (!Array.isArray(res['data'])) throw new Error('bad turns/list result');
          turns.push(...(res['data'] as unknown[]).map(obj));
          cursor = str(res['nextCursor']);
          if (cursor === undefined) break;
          if (page === MAX_PAGES - 1) ok = false; // older turns not seen: can't say "absent"
        }
      } catch (e) {
        ok = false;
        this.options.logger.log('warn', 'codex.turn.reconcile_unavailable', { error: e instanceof Error ? e.name : 'unknown' });
      }
      for (const r of records) {
        const hits = turns.filter((t) => Array.isArray(t['items']) && (t['items'] as unknown[]).some((i) => obj(i)['type'] === 'userMessage' && obj(i)['clientId'] === r.dottieTurnId));
        let check: NonNullable<TurnRecord['serverCheck']>;
        if (hits.length === 0) check = { result: ok ? 'absent' : 'unavailable' };
        else {
          const t = hits[0] as Record<string, unknown>;
          const serverTurnId = str(t['id']);
          const serverStatus = str(t['status']);
          const same = hits.length === 1 && serverTurnId !== undefined && (r.turnId === undefined || r.turnId === serverTurnId);
          check = { result: same ? 'match' : 'mismatch', ...(serverTurnId !== undefined ? { serverTurnId } : {}), ...(serverStatus !== undefined ? { serverStatus } : {}) };
          if (!same) this.runtime.audit.emit('codex.turn_reconcile_mismatch', { taskId: r.taskId, matches: hits.length });
        }
        this.options.logger.log('info', 'codex.turn.reconciled', { taskId: r.taskId, result: check.result, serverStatus: check.serverStatus ?? '' });
        const latest = await this.store.get(r.taskId);
        if (latest && latest.state === 'unknown' && latest.dottieTurnId === r.dottieTurnId) await this.store.put({ ...latest, serverCheck: check });
      }
    }
  }

  private record(a: Active, state: TurnRecordState): Promise<void> {
    // Sticky: once this turnId may have reached the server it stays listed, whatever is written later.
    if (DISPATCHED_STATES.has(state) && !a.priorTurnIds.includes(a.request.turnId)) a.priorTurnIds = [...a.priorTurnIds, a.request.turnId];
    return this.store.put({
      taskId: a.request.taskId,
      idempotencyKey: a.request.idempotencyKey,
      attempt: a.request.attempt,
      ...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
      ...(a.turnId !== undefined ? { turnId: a.turnId } : {}),
      dottieTurnId: a.request.turnId,
      dispatchedTurnIds: a.priorTurnIds,
      state,
      updatedAt: this.options.scheduler.now(),
    });
  }
}
