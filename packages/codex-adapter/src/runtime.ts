/**
 * Supervised `codex app-server --listen stdio://` child (DOT-011). Every launch, including each restart:
 *   verify the pinned sha256 → build the scrubbed env → spawn (stdio only) → initialize → initialized → ready.
 * A sha mismatch or refused CODEX_HOME halts in breaker_open (RuntimeHealth.halt) with no automatic restart. Exits are classified (CONTRACTS §2.4) clean | crash | hang | env_unavailable
 * (ADR-0013) and fed to the injected RestartPolicy. While ready, a heartbeat (`thread/loaded/list`, local and read-only)
 * detects a hung child, which is killed and counted as `hang`. The runtime never resubmits a turn; in-flight requests
 * are rejected with ConnectionClosedError and the turn layer reports them as unknown.
 */
import { AppServerConnection, ConnectionClosedError, RpcError, type NotificationHandler, type ServerReply, type ServerRequestContext } from './connection.js';
import { buildArgs, buildChildEnv, envScrubFields } from './env.js';
import type { RequestId } from './jsonrpc.js';
import { IntegrityError, verifyBinary } from './integrity.js';
import { createSecurityAudit, nullLogger, type Logger, type Redactor, type SecurityAudit } from './logger.js';
import {
  DEFAULT_RESTART_POLICY,
  FRESH_MEMORY,
  decideRestart,
  markHealthy,
  type ExitClass,
  type PowerSource,
  type RestartPolicy,
  type SupervisorMemory,
} from './restart-policy.js';
import { realScheduler, type Scheduler } from './scheduler.js';
import { createServerRequestHandler } from './server-requests.js';
import { spawnStdioTransport, type ExitInfo, type Transport, type TransportFactory } from './transport.js';

/**
 * CONTRACTS §2.4 RuntimeStatus / ExitClass, used directly. Mapping of the adapter's former internal states:
 * ready→running, restarting→backoff, the half-open trial launch → half_open, before the first start → unknown,
 * stop() → stopped (the child may still be exiting; `stopping` is internal). A refused launch (binary sha256
 * mismatch, or an env/config refusal such as a shared ~/.codex) is not a §2.4 value: it is published as
 * breaker_open (tray: Error with Retry) with RuntimeHealth.halt set, and it never half-opens by itself.
 */
import type { RuntimeStatus } from '@dottie/contracts';
export type { RuntimeStatus };
export type HaltReason = 'integrity' | 'env_config';

/** Adapter-internal health snapshot. `RuntimeHealth` is still a *proposed* event (CONTRACTS §3), so it is not emitted. */
export interface RuntimeHealth {
  readonly status: RuntimeStatus;
  readonly breaker: 'closed' | 'open' | 'half_open';
  readonly recentFailures: number;
  readonly trips: number;
  readonly lastExit: ExitClass | null;
  /** Set while a refused launch holds the runtime in breaker_open (no automatic half-open; only retry()). */
  readonly halt: HaltReason | null;
}

export class RuntimeUnavailableError extends Error {
  constructor(readonly status: RuntimeStatus) {
    super(`codex runtime is ${status}`);
  }
}

export interface ExitContext {
  /** Why the runtime killed the child, if it did. */
  readonly killedFor: 'hang' | 'crash' | null;
  readonly stopping: boolean;
}
export type ExitClassifier = (info: ExitInfo, ctx: ExitContext) => ExitClass;

/** Default: a spawn failure (binary unreadable/locked after the check, temp dir gone…) waits for the environment. */
export const defaultExitClassifier: ExitClassifier = (info, ctx) => {
  if (ctx.stopping) return 'clean';
  if (ctx.killedFor) return ctx.killedFor;
  if (info.spawnError) return 'env_unavailable';
  return 'crash';
};

/**
 * Hook for the approvals bridge. `handle` returning undefined falls through to the default-deny handler; a throw also
 * falls through to it (ADR-0009 CR1: any exception → decline, never an error the server might retry or treat as yes).
 */
export interface ServerRequestDelegate {
  handle(method: string, params: unknown, ctx: ServerRequestContext): Promise<ServerReply | undefined> | ServerReply | undefined;
  duplicate?(id: RequestId, method: string): void;
}

export interface RuntimeOptions {
  readonly binaryPath: string;
  /** Pinned sha256 for this platform (codex-pin.json). */
  readonly expectedSha256: string;
  /** Dedicated CODEX_HOME (ADR-0004). */
  readonly codexHome: string;
  readonly clientVersion: string;
  readonly userHome?: string;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Global flags placed before Dottie's forced flags and `app-server` (e.g. `-c key=value`). */
  readonly extraArgs?: readonly string[];
  /** Selects the env allowlist; defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly transportFactory?: TransportFactory;
  readonly scheduler?: Scheduler;
  readonly logger?: Logger;
  /** E08's redactor; every security audit event passes through it. */
  readonly redactor?: Redactor;
  readonly restartPolicy?: RestartPolicy;
  readonly classifyExit?: ExitClassifier;
  /** Read at each restart decision. Defaults to AC. */
  readonly powerSource?: () => PowerSource;
  readonly random?: () => number;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  /** Heartbeat period while ready; 0 disables. Default 30 s. */
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  /** Consecutive missed heartbeats that count as a hang. Default 2. */
  readonly heartbeatMisses?: number;
  /** Time ready before the child counts as healthy (closes a HALF-OPEN breaker). Default 60 s. */
  readonly stableMs?: number;
  /** Grace period after closing stdin before the child is killed on stop(). */
  readonly stopGraceMs?: number;
}

export interface InitializeInfo {
  readonly platformFamily: string;
  readonly platformOs: string;
}

export class AppServerRuntime {
  readonly audit: SecurityAudit;
  readonly logger: Logger;
  readonly scheduler: Scheduler;
  private statusValue: RuntimeStatus = 'unknown';
  private halt: HaltReason | null = null;
  private stopping = false;
  private generation = 0;
  private transport: Transport | undefined;
  private connection: AppServerConnection | undefined;
  private memory: SupervisorMemory = FRESH_MEMORY;
  private lastExit: ExitClass | null = null;
  private killedFor: 'hang' | 'crash' | null = null;
  private timers: (() => void)[] = [];
  private pendingLaunch: (() => void) | undefined;
  private initInfo: InitializeInfo | undefined;
  private stopWaiters: (() => void)[] = [];
  private delegate: ServerRequestDelegate | undefined;
  private readonly statusCbs = new Set<(s: RuntimeStatus) => void>();
  private readonly readyCbs = new Set<() => void>();
  private readonly healthCbs = new Set<(h: RuntimeHealth) => void>();
  private readonly notificationCbs: NotificationHandler[] = [];
  private readonly policy: RestartPolicy;
  private readonly factory: TransportFactory;
  private readonly classify: ExitClassifier;
  private readonly defaultHandler;

  constructor(private readonly options: RuntimeOptions) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.logger = options.logger ?? nullLogger;
    this.audit = createSecurityAudit(this.logger, options.redactor);
    this.policy = options.restartPolicy ?? DEFAULT_RESTART_POLICY;
    this.factory = options.transportFactory ?? spawnStdioTransport;
    this.classify = options.classifyExit ?? defaultExitClassifier;
    this.defaultHandler = createServerRequestHandler(this.logger, this.audit);
  }

  get status(): RuntimeStatus {
    return this.statusValue;
  }
  get initializeInfo(): InitializeInfo | undefined {
    return this.initInfo;
  }
  get health(): RuntimeHealth {
    const breaker = this.statusValue === 'breaker_open' ? 'open' : this.memory.halfOpen ? 'half_open' : 'closed';
    return { status: this.statusValue, breaker, recentFailures: this.memory.failures.length, trips: this.memory.trips, lastExit: this.lastExit, halt: this.halt };
  }

  onStatus(cb: (s: RuntimeStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => void this.statusCbs.delete(cb);
  }
  onHealth(cb: (h: RuntimeHealth) => void): () => void {
    this.healthCbs.add(cb);
    return () => void this.healthCbs.delete(cb);
  }
  /** Fires after every successful handshake (first start and each restart). */
  onReady(cb: () => void): () => void {
    this.readyCbs.add(cb);
    return () => void this.readyCbs.delete(cb);
  }
  onNotification(cb: NotificationHandler): void {
    this.notificationCbs.push(cb);
  }
  /** The approvals bridge. Returning undefined falls through to the default-deny table. */
  setServerRequestDelegate(delegate: ServerRequestDelegate | undefined): void {
    this.delegate = delegate;
  }

  /** Resolves with the status after the first launch attempt. Rejects on IntegrityError / EnvError (never restarted). */
  async start(): Promise<RuntimeStatus> {
    if (this.statusValue !== 'unknown' && this.statusValue !== 'stopped') return this.statusValue;
    this.stopping = false;
    await this.launch(true);
    return this.statusValue;
  }

  /** User "Try again": leaves an open breaker or the environment wait immediately and resets the history. */
  retry(): void {
    if (this.statusValue !== 'breaker_open' && this.statusValue !== 'waiting_for_env') return;
    this.cancelPendingLaunch();
    this.memory = FRESH_MEMORY;
    this.halt = null; // a refused launch is re-checked from scratch (sha256 and env again)
    void this.launch(false);
  }

  /** The OS reported that the environment the child needs is back (the matching event for waitingForEnv). */
  envAvailable(): void {
    if (this.statusValue !== 'waiting_for_env') return;
    void this.launch(false);
  }

  async stop(): Promise<void> {
    this.cancelPendingLaunch();
    this.clearTimers();
    const t = this.transport;
    if (!t || this.connection?.isClosed !== false) {
      this.generation++;
      this.transport = undefined;
      this.connection = undefined;
      if (this.halt === null) this.setStatus('stopped');
      return;
    }
    this.stopping = true;
    this.setStatus('stopped');
    const done = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    t.close();
    const cancelKill = this.scheduler.setTimeout(() => t.kill(), this.options.stopGraceMs ?? 2_000);
    await done;
    cancelKill();
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const c = this.connection;
    if (this.statusValue !== 'running' || this.stopping || !c) throw new RuntimeUnavailableError(this.statusValue);
    return c.request(method, params, timeoutMs);
  }

  // ------------------------------------------------------------------ internals
  private setStatus(s: RuntimeStatus): void {
    if (s === this.statusValue) return;
    this.statusValue = s;
    this.logger.log('info', 'codex.runtime.status', { status: s });
    for (const cb of [...this.statusCbs]) cb(s);
    const h = this.health;
    for (const cb of [...this.healthCbs]) cb(h);
  }

  private clearTimers(): void {
    this.timers.forEach((c) => c());
    this.timers = [];
  }
  private cancelPendingLaunch(): void {
    this.pendingLaunch?.();
    this.pendingLaunch = undefined;
  }

  private async launch(first: boolean): Promise<void> {
    const gen = ++this.generation;
    this.killedFor = null;
    this.setStatus(this.memory.halfOpen ? 'half_open' : 'starting');
    try {
      await verifyBinary(this.options.binaryPath, this.options.expectedSha256);
    } catch (e) {
      if (gen !== this.generation) return;
      this.audit.emit('codex.integrity_failed', {
        reason: e instanceof Error ? e.message : 'unknown',
        actualSha256: e instanceof IntegrityError ? e.actual : null,
      });
      this.halt = 'integrity';
      this.setStatus('breaker_open');
      if (first) throw e;
      return;
    }
    if (gen !== this.generation) return;
    const parentEnv = this.options.parentEnv ?? process.env;
    let env: Record<string, string>;
    let args: string[];
    try {
      env = buildChildEnv(parentEnv, {
        codexHome: this.options.codexHome,
        ...(this.options.userHome !== undefined ? { userHome: this.options.userHome } : {}),
        ...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
      });
      args = buildArgs(this.options.extraArgs ?? []);
    } catch (e) {
      this.audit.emit('codex.env_refused', { reason: e instanceof Error ? e.message : 'unknown' });
      this.halt = 'env_config';
      this.setStatus('breaker_open');
      if (first) throw e;
      return;
    }
    // CONTRACTS §3.2 env.scrub (E08 P-d): never values. Kept names (all from the allowlist) and the names of removed
    // SENSITIVE variables are listed; any other removed variable is only counted, because its name may be personal.
    this.audit.emit('env.scrub', envScrubFields(parentEnv, env));

    const transport = this.factory({
      command: this.options.binaryPath,
      args,
      env,
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
    });
    const connection = new AppServerConnection(transport, {
      logger: this.logger,
      scheduler: this.scheduler,
      ...(this.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
    });
    this.transport = transport;
    this.connection = connection;
    connection.setServerRequestHandler(async (method, params, ctx) => {
      const d = this.delegate;
      if (d && gen === this.generation) {
        try {
          const r = await d.handle(method, params, ctx);
          if (r) return r;
        } catch {
          this.logger.log('error', 'codex.server_request.delegate_threw', { method });
        }
      }
      return this.defaultHandler(method, params);
    });
    connection.onDuplicateServerRequest((id, method) => {
      if (gen === this.generation) this.delegate?.duplicate?.(id, method);
    });
    connection.onNotification((method, params) => {
      if (gen !== this.generation) return;
      for (const cb of this.notificationCbs) cb(method, params);
    });
    transport.onStderrLine((line) => {
      // Content is not logged: stderr can carry URLs and host names (E08 owns redaction).
      const level = /\bERROR\b/.test(line) ? 'error' : /\bWARN(ING)?\b/.test(line) ? 'warn' : 'other';
      this.logger.log('debug', 'codex.runtime.stderr', { level, chars: line.length });
    });
    transport.onExit((info) => this.onExit(gen, info));

    try {
      const result = (await connection.request(
        'initialize',
        {
          clientInfo: { name: 'dottie', title: 'Dottie', version: this.options.clientVersion },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        this.options.initializeTimeoutMs ?? 20_000,
      )) as Record<string, unknown> | null;
      if (gen !== this.generation) return;
      connection.notify('initialized', {});
      this.initInfo = {
        platformFamily: typeof result?.['platformFamily'] === 'string' ? result['platformFamily'] : 'unknown',
        platformOs: typeof result?.['platformOs'] === 'string' ? result['platformOs'] : 'unknown',
      };
      this.setStatus('running');
      this.armHealthTimers(gen, connection, transport);
      for (const cb of [...this.readyCbs]) cb();
    } catch (e) {
      if (gen !== this.generation) return;
      const reason = e instanceof ConnectionClosedError ? 'exited' : e instanceof RpcError ? 'rpc_error' : e instanceof Error ? e.constructor.name : 'unknown';
      this.logger.log('error', 'codex.runtime.handshake_failed', { reason });
      // The exit path drives the restart, so there is exactly one decision per failed child.
      if (!connection.isClosed) {
        this.killedFor = reason === 'rpc_error' ? 'crash' : 'hang';
        transport.kill();
      }
    }
  }

  private armHealthTimers(gen: number, connection: AppServerConnection, transport: Transport): void {
    const stableMs = this.options.stableMs ?? 60_000;
    this.timers.push(
      this.scheduler.setTimeout(() => {
        if (gen !== this.generation) return;
        this.memory = markHealthy(this.memory);
        const h = this.health;
        for (const cb of [...this.healthCbs]) cb(h);
      }, stableMs),
    );
    const interval = this.options.heartbeatIntervalMs ?? 30_000;
    if (interval <= 0) return;
    const timeout = this.options.heartbeatTimeoutMs ?? 10_000;
    const maxMisses = this.options.heartbeatMisses ?? 2;
    let misses = 0;
    const beat = () => {
      if (gen !== this.generation || connection.isClosed) return;
      connection.request('thread/loaded/list', { limit: 1 }, timeout).then(
        () => {
          misses = 0;
          schedule();
        },
        (e: unknown) => {
          if (gen !== this.generation || connection.isClosed) return;
          if (e instanceof RpcError) {
            misses = 0; // it answered: alive
            schedule();
            return;
          }
          misses++;
          this.logger.log('warn', 'codex.runtime.heartbeat_missed', { misses });
          if (misses >= maxMisses) {
            this.logger.log('error', 'codex.runtime.hang_detected', { misses });
            this.killedFor = 'hang';
            transport.kill();
            return;
          }
          schedule();
        },
      );
    };
    const schedule = () => this.timers.push(this.scheduler.setTimeout(beat, interval));
    schedule();
  }

  private onExit(gen: number, info: ExitInfo): void {
    if (gen !== this.generation) return;
    this.clearTimers();
    this.transport = undefined;
    this.connection = undefined;
    const during = this.stopping ? 'stopping' : this.statusValue;
    const exit = this.classify(info, { killedFor: this.killedFor, stopping: this.stopping });
    this.lastExit = exit;
    this.logger.log(exit === 'clean' ? 'info' : 'error', 'codex.runtime.exit', {
      code: info.code,
      signal: info.signal,
      spawnError: info.spawnError ?? null,
      during,
      exitClass: exit,
    });
    if (this.stopping) {
      this.stopping = false;
      this.setStatus('stopped');
      const w = this.stopWaiters;
      this.stopWaiters = [];
      w.forEach((r) => r());
      return;
    }
    const { decision, memory } = decideRestart(this.policy, this.memory, {
      exit,
      now: this.scheduler.now(),
      power: this.options.powerSource?.() ?? 'ac',
      random: this.options.random ?? Math.random,
    });
    this.memory = memory;
    switch (decision.action) {
      case 'none':
        this.setStatus('stopped');
        return;
      case 'wait_for_env':
        this.setStatus('waiting_for_env');
        this.logger.log('warn', 'codex.runtime.waiting_for_env', { spawnError: info.spawnError ?? null });
        return;
      case 'restart':
        this.setStatus('backoff');
        this.logger.log('warn', 'codex.runtime.restart_scheduled', { attempt: decision.attempt, delayMs: decision.delayMs });
        this.pendingLaunch = this.scheduler.setTimeout(() => {
          this.pendingLaunch = undefined;
          void this.launch(false);
        }, decision.delayMs);
        return;
      case 'breaker_open':
        this.setStatus('breaker_open');
        this.logger.log('error', 'codex.runtime.breaker_open', { coolOffMs: decision.coolOffMs, trips: decision.trips });
        this.pendingLaunch = this.scheduler.setTimeout(() => {
          this.pendingLaunch = undefined;
          this.memory = { ...this.memory, halfOpen: true };
          void this.launch(false);
        }, decision.coolOffMs);
        return;
    }
  }
}
