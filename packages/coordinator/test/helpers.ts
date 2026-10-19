import { contractsActionIdPort } from '../src/actionIdPort.js';
import type { ApprovalDisplay, CodexDisplayParams } from '../src/display.js';
import type { ApprovalDisplayPort } from '../src/ports.js';
import { createHash } from 'node:crypto';
import { EVENT_SCHEMA, EVENT_SCHEMA_VERSION, validateEvent, type AnyEvent, type EventEnvelope, type EventType, type ObservedState, type SideEffect } from '../src/contracts.js';
import { Coordinator, type CoordinatorConfig } from '../src/coordinator.js';
import type { PinnedToolCatalog } from '../src/toolCatalog.js';
import type {
  ActionIdBinding,
  ActionIdPort,
  AuthState,
  AuthorizeToolCallParams,
  CancelAck,
  Clock,
  CodexPort,
  CodexRunHooks,
  CodexRunResult,
  CodexTaskRequest,
  IdSource,
  LogLevel,
  LogValue,
  Logger,
  PolicyPort,
  SpeechKind,
  SpeechPort,
  ToolCallContext,
  ToolHostPort,
  VerifierPort,
} from '../src/ports.js';

/** v2 ObservedState fixture (CONTRACTS §5). `note` is a tool-specific scalar key. */
export function obs(note: string, sideEffect: SideEffect = 'none', verified = true, extra: Partial<ObservedState> = {}): ObservedState {
  return { outcome: verified ? 'verified' : 'unverified', decision: 'done', checks: {}, sideEffect, note, ...extra };
}

export const flush = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r));
};

interface Timer { at: number; resolve: () => void; signal: AbortSignal | undefined }
export class FakeClock implements Clock {
  private t = Date.parse('2026-10-18T13:00:00.000Z');
  private timers: Timer[] = [];
  readonly sleeps: number[] = [];
  now(): number { return this.t; }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>(resolve => {
      if (signal?.aborted) return resolve();
      const timer: Timer = { at: this.t + ms, resolve, signal };
      this.timers.push(timer);
      signal?.addEventListener('abort', () => { this.timers = this.timers.filter(x => x !== timer); resolve(); }, { once: true });
    });
  }
  get pending(): number { return this.timers.length; }
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.timers.filter(x => x.at <= this.t);
    this.timers = this.timers.filter(x => x.at > this.t);
    for (const d of due) d.resolve();
    await flush();
  }
  /** Advance to the next timer. */
  async tick(): Promise<boolean> {
    const next = this.timers.reduce<number | undefined>((m, x) => (m === undefined || x.at < m ? x.at : m), undefined);
    if (next === undefined) return false;
    await this.advance(next - this.t);
    return true;
  }
}

export interface RunCtx {
  readonly req: CodexTaskRequest;
  readonly hooks: CodexRunHooks;
  readonly signal: AbortSignal;
  readonly aborted: Promise<void>;
}
export type Script = (ctx: RunCtx) => Promise<CodexRunResult>;

export class FakeCodex implements CodexPort {
  auth: AuthState = 'signed_in';
  /** Override the auth read (throw, reject, hang, delay). Default: resolve `auth`. */
  authImpl: (() => Promise<AuthState>) | undefined;
  authReads = 0;
  scripts: Script[] = [];
  defaultScript: Script = async () => ({ status: 'completed', summary: 'Done.' });
  cancelAck: CancelAck | 'never' = { stopped: true };
  readonly runs: CodexTaskRequest[] = [];
  readonly cancels: string[] = [];
  /** run() calls in flight now, and the most ever in flight at once (local idempotency: must stay 1). */
  inFlight = 0;
  maxInFlight = 0;
  authState(): Promise<AuthState> {
    this.authReads++;
    return this.authImpl ? this.authImpl() : Promise.resolve(this.auth);
  }
  run(req: CodexTaskRequest, hooks: CodexRunHooks, signal: AbortSignal): Promise<CodexRunResult> {
    this.runs.push(req);
    const script = this.scripts.shift() ?? this.defaultScript;
    const aborted = new Promise<void>(r => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const p = script({ req, hooks, signal, aborted });
    void p.then(() => this.inFlight--, () => this.inFlight--);
    return p;
  }
  cancel(taskId: string): Promise<CancelAck> {
    this.cancels.push(taskId);
    const ack = this.cancelAck;
    return ack === 'never' ? new Promise<CancelAck>(() => {}) : Promise.resolve(ack);
  }
}

/** A run that waits until aborted, then reports aborted. */
export const untilAborted: Script = async ({ aborted }) => { await aborted; return { status: 'aborted' }; };

export class FakeSpeech implements SpeechPort {
  manual = false;
  readonly spoken: { text: string; kind: SpeechKind; taskId?: string }[] = [];
  stops = 0;
  private pending: ((r: 'completed' | 'interrupted') => void)[] = [];
  speak(text: string, ctx: { taskId?: string; kind: SpeechKind }): Promise<'completed' | 'interrupted'> {
    this.spoken.push({ text, kind: ctx.kind, ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}) });
    if (!this.manual) return Promise.resolve('completed');
    return new Promise(r => this.pending.push(r));
  }
  stop(): void {
    this.stops++;
    for (const r of this.pending.splice(0)) r('interrupted');
  }
  completeAll(): void { for (const r of this.pending.splice(0)) r('completed'); }
  get playing(): number { return this.pending.length; }
}

/**
 * E01 2i sweep: every event any test's coordinator emits must pass the closed validateEvent (envelope and payload).
 * A failure is recorded here and fails the test file at exit, so no emit site can produce an unknown key unnoticed.
 */
export const EMITTED_INVALID: string[] = [];
process.on('exit', () => {
  if (EMITTED_INVALID.length > 0) {
    console.error(`E01 2i sweep: ${EMITTED_INVALID.length} emitted event(s) failed validateEvent:\n${EMITTED_INVALID.slice(0, 20).join('\n')}`);
    process.exitCode = 1;
  }
});
export class Sink {
  readonly events: AnyEvent[] = [];
  emit(e: AnyEvent): void {
    const r = validateEvent(e);
    if (!r.ok) EMITTED_INVALID.push(`${e.type}: ${r.errors.join('; ')}`);
    this.events.push(e);
  }
  of<T extends EventType>(type: T): EventEnvelope<T>[] { return this.events.filter((e): e is EventEnvelope<T> & AnyEvent => e.type === type) as EventEnvelope<T>[]; }
  types(): EventType[] { return this.events.map(e => e.type); }
}

export class MemLogger implements Logger {
  readonly lines: { level: LogLevel; event: string; fields: Readonly<Record<string, LogValue>> }[] = [];
  log(level: LogLevel, event: string, fields: Readonly<Record<string, LogValue>>): void { this.lines.push({ level, event, fields }); }
  find(event: string) { return this.lines.filter(l => l.event === event); }
}

export function seqIds(): IdSource & { readonly asked: string[] } {
  let n = 0;
  const asked: string[] = [];
  return { asked, next: prefix => { asked.push(prefix); return `${prefix}_${++n}`; } };
}

/** Deterministic 64-lowercase-hex id for test fixtures (e.g. adapter-supplied Codex approval actionIds). */
export function hexId(label: string): string {
  return createHash('sha256').update(`test-fixture:${label}`).digest('hex');
}

/**
 * The REAL ActionIdPort (src/actionIdPort.ts: E02 computeActionId / computeDisplayHash @ 2581593, vendored), wrapped
 * only to RECORD what the coordinator hashed. `impl` / `displayImpl` override it for fail-closed tests (throw, bad
 * output, missing method); otherwise every id and display hash in the suite is E02's.
 */
export class RecordingActionIdPort implements ActionIdPort {
  readonly bindings: ActionIdBinding[] = [];
  readonly displays: ApprovalDisplay[] = [];
  impl: ((b: ActionIdBinding) => string | Promise<string>) | undefined;
  /** Override for the display hash; `null` = port lacks the method. */
  displayImpl: ((d: ApprovalDisplay) => string | Promise<string>) | null | undefined;
  get computeDisplayHash(): ((d: ApprovalDisplay) => string | Promise<string>) | undefined {
    if (this.displayImpl === null) return undefined;
    return (d: ApprovalDisplay) => {
      this.displays.push(d);
      return this.displayImpl ? this.displayImpl(d) : displayHashOf(d);
    };
  }
  computeActionId(binding: ActionIdBinding): string | Promise<string> {
    this.bindings.push(binding);
    if (this.impl) return this.impl(binding);
    return contractsActionIdPort.computeActionId(binding);
  }
}
/** The host's ruling-1d actionId for a non-approval gated call (CR2 object, targets/threadId/itemId null), real hash. */
export function hostActionId(toolId: string, args: Readonly<Record<string, unknown>>, ctx: ToolCallContext): string {
  const binding = { purpose: 'dottie.actionId.v1', method: toolId, args, targets: null, taskId: ctx.taskId, threadId: null, turnId: ctx.turnId, itemId: null, requestId: null, displayHash: null, requestSource: 'tool_host' } as const;
  return contractsActionIdPort.computeActionId(binding as unknown as ActionIdBinding) as string;
}
/** TEST: a valid Codex file-change display + requestSource for validator payloads (E01 1o/1r). */
export const codexDisp = (category: unknown) => ({ display: { kind: 'codex_file_change', category, paths: ['C:\\Users\\me\\old.log'], fileCount: '1', reasonUntrusted: null }, requestSource: 'codex' as const });
/** E02's displayHash (real). */
export function displayHashOf(d: ApprovalDisplay): string {
  return contractsActionIdPort.computeDisplayHash!(d) as string;
}
/** TEST: the validated params a Codex adapter supplies (E01 1o); file change of the given paths. */
export const fileParams = (...paths: string[]): CodexDisplayParams => ({ kind: 'codex_file_change', paths: paths.length ? paths : ['C:\\Users\\me\\Downloads\\old.log'] });

let evtSeq = 0;
export function envelope<T extends EventType>(type: T, payload: EventEnvelope<T>['payload'], correlationId = 'int_test'): EventEnvelope<T> {
  return { schema: EVENT_SCHEMA, version: EVENT_SCHEMA_VERSION, type, eventId: `ext_${++evtSeq}`, correlationId, timestamp: '2026-10-18T13:00:00.000Z', payload };
}
export const wake = (correlationId = 'int_test') => envelope('WakeDetected', { timestamp: '2026-10-18T13:00:00.000Z', deviceId: 'mic-1', confidence: 0.93 }, correlationId);
export const utterance = (text: string, requestId: string) => envelope('UtteranceReady', { requestId, text, locale: 'en-US', endReason: 'vad_silence' });
/** ApprovalResolved from the secure UI. v2 requires envelope taskId; taken from the matching ApprovalRequested when a sink is given. */
export const approval = (actionId: string, approved: boolean, from?: { sink: Sink }): EventEnvelope<'ApprovalResolved'> => {
  const taskId = from?.sink.of('ApprovalRequested').find(e => e.payload.actionId === actionId)?.payload.taskId ?? 'task_none';
  return { ...envelope('ApprovalResolved', { actionId, approved, timestamp: '2026-10-18T13:00:01.000Z' }), taskId };
};

/**
 * Fake E04 tool host. Stamps every call with the coordinator's context (never the model's) and issues opaque
 * targetIds scoped to a taskId; an unknown, cross-task or ended-task targetId returns NOT_FOUND (CONTRACTS §5).
 */
export class FakeToolHost implements ToolHostPort {
  readonly turns: (ToolCallContext | null)[] = [];
  readonly ended: string[] = [];
  readonly calls: { toolId: string; context: ToolCallContext; args: Readonly<Record<string, unknown>> }[] = [];
  private readonly targets = new Map<string, string>(); // targetId -> taskId
  private seq = 0;
  setActiveTurn(context: ToolCallContext | null): void { this.turns.push(context); }
  endTask(taskId: string): void {
    this.ended.push(taskId);
    for (const [t, owner] of [...this.targets]) if (owner === taskId) this.targets.delete(t);
  }
  /**
   * Host order (E01 DOT-092 ruling 1d): [schema] → computeActionId over the args with the host's advisory
   * setActiveTurn context (targets/threadId/itemId null) → authorizeToolCall({toolId, modelArgs, actionId}).
   * No advisory context → the fake can't hash and sends no actionId. `opts.actionId` overrides (tamper tests).
   */
  readonly sentActionIds: unknown[] = [];
  call(c: Coordinator, toolId: string, modelArgs: Record<string, unknown>, opts: { actionId?: unknown } = {}):
    | { ok: true; context: ToolCallContext; targetIds: string[] }
    | { ok: false; code: string; sideEffect?: string } {
    const advisory = this.turns.at(-1) ?? null;
    const actionId = Object.hasOwn(opts, 'actionId') ? opts.actionId : advisory ? hostActionId(toolId, modelArgs, advisory) : undefined;
    this.sentActionIds.push(actionId);
    const auth = c.authorizeToolCall({ toolId, modelArgs, actionId } as AuthorizeToolCallParams);
    if (!auth.ok) return { ok: false, code: auth.error.code, sideEffect: auth.sideEffect };
    // Only an authorised call reaches the tool: `calls` is the record of tool invocations.
    this.calls.push({ toolId, context: auth.context, args: auth.args });
    const targetId = auth.args['targetId'];
    if (targetId !== undefined) {
      if (typeof targetId !== 'string' || !/^tgt_\d+$/.test(targetId)) return { ok: false, code: 'INVALID_ARGUMENT' };
      if (this.targets.get(targetId) !== auth.context.taskId) return { ok: false, code: 'NOT_FOUND' };
      return { ok: true, context: auth.context, targetIds: [targetId] };
    }
    const issued = [`tgt_${++this.seq}`, `tgt_${++this.seq}`];
    for (const t of issued) this.targets.set(t, auth.context.taskId);
    return { ok: true, context: auth.context, targetIds: issued };
  }
}

export interface Fixture {
  c: Coordinator; codex: FakeCodex; speech: FakeSpeech; sink: Sink; log: MemLogger; clock: FakeClock; tools: FakeToolHost;
  /** The wired action-id port (test fake), or null when the fixture runs unwired. */
  actionIds: RecordingActionIdPort | null;
  ids: ReturnType<typeof seqIds>;
  /** Drive the voice pipeline from STANDBY to a submitted utterance. */
  say(text: string, requestId?: string): ReturnType<Coordinator['submitUtterance']>;
  /** Run timers until all flows settle (no approvals pending). */
  drain(): Promise<void>;
}

let reqSeq = 0;
export async function fixture(opts: { config?: Partial<CoordinatorConfig>; policy?: PolicyPort; verifier?: VerifierPort; auth?: AuthState; boot?: boolean; actionIds?: RecordingActionIdPort | null; toolCatalog?: PinnedToolCatalog; approvalDisplays?: ApprovalDisplayPort } = {}): Promise<Fixture> {
  const codex = new FakeCodex(), speech = new FakeSpeech(), sink = new Sink(), log = new MemLogger(), clock = new FakeClock(), tools = new FakeToolHost();
  const actionIds = opts.actionIds === undefined ? new RecordingActionIdPort() : opts.actionIds;
  const ids = seqIds();
  if (opts.auth) codex.auth = opts.auth;
  const c = new Coordinator(
    { codex, speech, events: sink, logger: log, clock, ids, random: () => 0, toolHost: tools, ...(actionIds ? { actionIds } : {}), ...(opts.policy ? { policy: opts.policy } : {}), ...(opts.verifier ? { verifier: opts.verifier } : {}), ...(opts.toolCatalog ? { toolCatalog: opts.toolCatalog } : {}), ...(opts.approvalDisplays ? { approvalDisplays: opts.approvalDisplays } : {}) },
    opts.config,
  );
  if (opts.boot !== false) await c.boot();
  return {
    c, codex, speech, sink, log, clock, tools, actionIds, ids,
    say(text, requestId = `req_${++reqSeq}`) {
      c.handleWake(wake());
      c.handleListeningStarted();
      c.handleCaptureEnded();
      return c.submitUtterance(utterance(text, requestId));
    },
    async drain() {
      for (let i = 0; i < 100; i++) {
        await flush();
        if (!(await clock.tick())) break;
      }
      await c.settled();
    },
  };
}

export const allowAllChannels: PolicyPort = {
  workspaceScopeFor: () => ({ scopes: ['files.read'], paths: ['C:/Users/test/Downloads'] }),
  preDispatchConfirmation: () => null,
  acceptsApprovalChannel: () => true,
};
