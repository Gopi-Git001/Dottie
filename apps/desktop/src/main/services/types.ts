/**
 * Service ports the desktop shell depends on. Implementations are owned by other engineers;
 * the desktop ships stubs (./stubs.ts) selected by feature flags (../flags.ts).
 *
 *  - AuthAdapter      -> E02 (official Codex app-server `account/*` methods; spec §5)
 *  - VoiceService     -> E05 (local audio worker: devices, mic test, wake word, mute)
 *  - CoordinatorPort  -> E03 (task state machine, spec §4)
 *  - AuditSink        -> E08 (K8 audit store, DOT-097; CONTRACTS §3.2)
 *
 * DRAFT — pending E01 sign-off; these will move to packages/contracts.
 */
import type { ApprovalResolved, InputFieldStrippedRecord, StopTaskResult, UtteranceReady, UtteranceOrigin } from '../../shared/contracts.draft';
import type { FeatureMode } from '../../shared/ipc';
import type { RuntimeStatus } from '../../shared/runtime';
import type { AuthStatus, CoordinatorState } from '../../shared/states';

export type Unsubscribe = () => void;

// ----------------------------------------------------------------------------- Auth (E02)
export interface AuthStatusInfo {
  status: AuthStatus;
  /** Display-only label; never a token, cookie, or password. */
  accountLabel: string | null;
  message: string;
}

export type LoginStart =
  /** Official browser flow: main opens authUrl in the SYSTEM browser after allowlist check. */
  | { kind: 'system_browser'; loginId: string; authUrl: string }
  /** Official device-code flow: show userCode, open verificationUrl. */
  | { kind: 'device_code'; loginId: string; verificationUrl: string; userCode: string }
  | { kind: 'unavailable'; reason: string };

export interface AuthAdapter {
  readonly mode: FeatureMode;
  getStatus(): Promise<AuthStatusInfo>;
  /**
   * Begin the official Codex ChatGPT sign-in (app-server `account/login/start`). MUST NOT collect
   * passwords, render a login form, embed a webview, or read Codex credential files.
   */
  startLogin(): Promise<LoginStart>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  onStatusChange(listener: (info: AuthStatusInfo) => void): Unsubscribe;
}

// ----------------------------------------------------------------------------- Voice (E05)
export interface MicDevice {
  id: string;
  label: string;
}
export interface VoiceService {
  readonly mode: FeatureMode;
  listDevices(): Promise<{ devices: MicDevice[]; simulated: boolean }>;
  /** Short level test on the worker side; the renderer never opens the mic itself. */
  testMic(deviceId: string | null): Promise<{ ok: boolean; peakLevel: number; simulated: boolean; message: string }>;
  runWakeTest(timeoutMs: number): Promise<{ detected: boolean; confidence: number | null; simulated: boolean; message: string }>;
  /** Hard mic gate. When true the worker must close the capture device (not just ignore audio). */
  setMicSuppressed(suppressed: boolean, reason: 'mute' | 'pause' | 'quit'): Promise<void>;
  stop(): void;
}

// ----------------------------------------------------------------------------- Coordinator (E03)
/**
 * Coordinator state as main sees it. `activeTaskId` is the single active task (ADR-0010; E03
 * `Coordinator.activeTaskId`), null when none: approval requests for any other taskId open nothing
 * and send nothing (E01 ruling 2e). Non-null only while `taskActive`.
 */
export interface CoordinatorSnapshot {
  state: CoordinatorState;
  taskActive: boolean;
  activeTaskId: string | null;
}

export interface CoordinatorPort {
  readonly mode: FeatureMode;
  getState(): CoordinatorSnapshot;
  onStateChange(listener: (s: CoordinatorSnapshot) => void): Unsubscribe;
  /** TaskFinished events (CONTRACTS v2 §3); main validates them before they reach the tray model. */
  onTaskFinished(listener: (e: unknown) => void): Unsubscribe;
  /**
   * TaskCancelled events (CONTRACTS v2 §3; ruling 2g). A task ends with exactly one of TaskFinished
   * or TaskCancelled; main validates it and treats both the same for ending the current task.
   */
  onTaskCancelled(listener: (e: unknown) => void): Unsubscribe;
  /** TaskProgress events (CONTRACTS v2 §3); main validates them. RECOVERING = Codex retry burst. */
  onTaskProgress(listener: (e: unknown) => void): Unsubscribe;
  /**
   * Cancel the running task; resolves with the coordinator's truthful v2 stop status, or
   * `{noActiveTask: true}` (CONTRACTS §3.1 / ADR-0012 §7). Main validates the result.
   */
  stopTask(): Promise<StopTaskResult>;
  /**
   * Submit a user utterance to the coordinator. `source` is the transport origin, never a payload
   * field. Main has already run the L211 origin check (DesktopController.submitUtterance): only
   * voice_worker / tray_ipc utterances can still carry retryOfTaskId. The desktop calls this today
   * only for tray Retry (tray_ipc).
   */
  submitUtterance(utterance: UtteranceReady, source: UtteranceOrigin): void;
  /** ApprovalRequested events (CONTRACTS v2 §3); main validates them and owns the dialog. */
  onApprovalRequested(listener: (e: unknown) => void): Unsubscribe;
  /**
   * The coordinator's final word on an approval (its ApprovalResolved incl. expiry declines), as
   * `{taskId, actionId, approved, timestamp}`; main validates it and closes that dialog.
   */
  onApprovalResolved(listener: (e: unknown) => void): Unsubscribe;
  /** The user's decision from the main-owned secure dialog (ApprovalResolved, source secure_ui). */
  resolveApproval(taskId: string, resolved: ApprovalResolved): void;
  stop(): void;
}

// ----------------------------------------------------------------------------- Runtime supervisor (E06/E09, ADR-0013)
/**
 * Status of the supervised Codex app-server child (CONTRACTS §2.4). Fed by the supervisor rewrite
 * (DOT-067); a stub until then.
 */
export interface RuntimeStatusSource {
  readonly mode: FeatureMode;
  getStatus(): RuntimeStatus;
  onStatusChange(listener: (status: RuntimeStatus) => void): Unsubscribe;
  /** User Reconnect while waiting_for_env: re-check the environment now (no sign-in). */
  recheck(): Promise<void>;
  /** User Retry while breaker_open: move the breaker to HALF-OPEN and try a restart (ADR-0013 item 3). */
  retry(): Promise<void>;
}

// ----------------------------------------------------------------------------- Audit (E08, DOT-097)
/** §3.2 AuditRecord kinds the desktop main process writes today. */
export type DesktopAuditRecord = InputFieldStrippedRecord;
/**
 * The audit store port (E01 ruling 1w; BACKLOG DOT-097, owner E08/K8). Append-only: there is no read,
 * update or delete through the port. `write` validates the record and THROWS on an invalid one
 * (fail closed: never written). The desktop ships an in-memory implementation (stubs.ts) that
 * DOT-097's real store replaces with wiring only.
 */
export interface AuditSink {
  write(record: DesktopAuditRecord): void;
}
