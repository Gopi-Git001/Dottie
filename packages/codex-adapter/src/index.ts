/**
 * @dottie/codex-adapter public surface. Codex wire types are deliberately not exported (boundary discipline):
 * consumers see @dottie/contracts types plus runtime controls only.
 */
import type { AuthPort, CodexPort } from '@dottie/contracts';
import { AuthService, type OpenExternal } from './auth-service.js';
import { realScheduler } from './scheduler.js';
import { CodexTaskRunner, type TurnRunnerOptions } from './turns.js';
import { ApprovalBridge, type ApprovalBridgeOptions, type ApprovalDismissal, type RevokeReason } from './approvals/bridge.js';
import { nullLogger } from './logger.js';
import { AppServerRuntime, type RuntimeHealth, type RuntimeOptions, type RuntimeStatus } from './runtime.js';

export type { Logger, LogLevel, LogValue, LogFields, Redactor, SecurityAudit } from './logger.js';
export { minimalRedactor } from './logger.js';
export type { RestartPolicy, ExitClass, PowerSource } from './restart-policy.js';
export { DEFAULT_RESTART_POLICY } from './restart-policy.js';
export type { Scheduler } from './scheduler.js';
export type { SpawnRequest, Transport, TransportFactory, ExitInfo } from './transport.js';
export type { RuntimeOptions, RuntimeStatus, RuntimeHealth, InitializeInfo, ExitClassifier } from './runtime.js';
export { RuntimeUnavailableError } from './runtime.js';
export { IntegrityError } from './integrity.js';
export { EnvError, EXCLUDED_ENV_NAMES, FORCED_CONFIG_FLAGS, POSIX_ENV_ALLOWLIST, PROXY_ENV_ALLOWLIST, TLS_ENV_ALLOWLIST, WINDOWS_ENV_ALLOWLIST } from './env.js';
export type { OpenExternal } from './auth-service.js';
export type { ThreadSandbox, TurnRunnerOptions } from './turns.js';
export { shouldRetryTurn } from './turns.js';
export type { TurnRecord, TurnRecordState, TurnStore } from './turn-store.js';
export { MemoryTurnStore } from './turn-store.js';
export type { ApprovalBridgeOptions, ApprovalDismissal, RevokeReason } from './approvals/bridge.js';
export { DEFAULT_APPROVAL_TIMEOUT_MS, MAX_APPROVAL_TIMEOUT_MS } from './approvals/bridge.js';
export type { ApprovalToken, ApprovalTokenPort, ApprovalTokenRequest, Classifier, Classification } from './approvals/policy.js';
export { APPROVAL_TOKEN_PURPOSE, FAIL_CLOSED_TOKENS, defaultClassifier } from './approvals/policy.js';
// actionId / canonical JSON / canonicalPath live in @dottie/contracts (one shared helper, E01 2026-10-19).

export interface CodexAdapterOptions extends RuntimeOptions {
  /** Opens a sign-in URL in the user's browser (Electron shell.openExternal). Only ever called with https://auth.openai.com/... */
  readonly openExternal: OpenExternal;
  /** taskId → threadId/turnId persistence (default: in memory). */
  readonly turnStore?: TurnRunnerOptions['store'];
  readonly sandbox?: TurnRunnerOptions['sandbox'];
  readonly defaultCwd?: string;
  readonly interruptTimeoutMs?: number;
  readonly progressThrottleMs?: number;
  /**
   * The ADR-0009 approvals bridge (DOT-090). Absent → every approval request is declined (slice-1 default-deny).
   * Even when present, nothing is accepted until a real K8 token port replaces FAIL_CLOSED_TOKENS (DOT-092).
   */
  readonly approvals?: ApprovalBridgeOptions;
}

export interface ApprovalsControl {
  /** Item 7 revocation: panic-stop, mute, Quit, desktop locked. Task cancel goes through codex.cancel(). */
  revokeAll(reason: Exclude<RevokeReason, 'task_cancel' | 'app_server_restart'>): void;
  /** Fires when a pending approval ends for any reason other than the user's own answer: close the dialog. */
  onDismiss(cb: (d: ApprovalDismissal) => void): () => void;
}

export interface CodexAdapter {
  readonly codex: CodexPort;
  readonly auth: AuthPort;
  start(): Promise<RuntimeStatus>;
  stop(): Promise<void>;
  /** Leave the open restart breaker early. */
  retry(): void;
  readonly status: RuntimeStatus;
  readonly health: RuntimeHealth;
  onRuntimeStatus(cb: (s: RuntimeStatus) => void): () => void;
  onRuntimeHealth(cb: (h: RuntimeHealth) => void): () => void;
  /** OS event: the environment the child was waiting for is back (ADR-0013 waitingForEnv). */
  envAvailable(): void;
  /** Present only when options.approvals was given. */
  readonly approvals?: ApprovalsControl;
}

export function createCodexAdapter(options: CodexAdapterOptions): CodexAdapter {
  const runtime = new AppServerRuntime(options);
  const auth = new AuthService(runtime, {
    logger: options.logger ?? nullLogger,
    openExternal: options.openExternal,
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  const codex = new CodexTaskRunner(runtime, auth, {
    logger: options.logger ?? nullLogger,
    scheduler: options.scheduler ?? realScheduler,
    ...(options.random !== undefined ? { random: options.random } : {}),
    ...(options.turnStore !== undefined ? { store: options.turnStore } : {}),
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.defaultCwd !== undefined ? { defaultCwd: options.defaultCwd } : {}),
    ...(options.interruptTimeoutMs !== undefined ? { interruptTimeoutMs: options.interruptTimeoutMs } : {}),
    ...(options.progressThrottleMs !== undefined ? { progressThrottleMs: options.progressThrottleMs } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  let approvals: ApprovalsControl | undefined;
  if (options.approvals) {
    const bridge = new ApprovalBridge(codex, options.approvals, { scheduler: options.scheduler ?? realScheduler, logger: options.logger ?? nullLogger, audit: runtime.audit });
    runtime.setServerRequestDelegate(bridge);
    runtime.onNotification((m, p) => bridge.onNotification(m, p));
    runtime.onStatus((s) => {
      if (s !== 'running') bridge.runtimeLost();
    });
    codex.setCancelListener((taskId) => bridge.revokeTask(taskId, 'task_cancel'));
    approvals = { revokeAll: (r) => bridge.revokeAll(r), onDismiss: (cb) => bridge.onDismiss(cb) };
  }
  return {
    ...(approvals ? { approvals } : {}),
    codex,
    auth,
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    retry: () => runtime.retry(),
    get status() {
      return runtime.status;
    },
    get health() {
      return runtime.health;
    },
    onRuntimeStatus: (cb) => runtime.onStatus(cb),
    onRuntimeHealth: (cb) => runtime.onHealth(cb),
    envAvailable: () => runtime.envAvailable(),
  };
}
