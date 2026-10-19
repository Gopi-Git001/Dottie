/**
 * Stub implementations used until E02/E05/E03 deliver real adapters. Every result that did not
 * touch real hardware/services is labelled `simulated: true` and says so in its message, so the
 * UI never claims a real mic/wake/sign-in happened.
 */
import { InputFieldStrippedRecordSchema, type ApprovalResolved, type StopTaskResult, type UtteranceReady, type UtteranceOrigin } from '../../shared/contracts.draft';
import type { RuntimeStatus } from '../../shared/runtime';
import type { AuthStatus, CoordinatorState } from '../../shared/states';
import type { AuditSink, AuthAdapter, AuthStatusInfo, CoordinatorPort, CoordinatorSnapshot, DesktopAuditRecord, LoginStart, RuntimeStatusSource, VoiceService } from './types';

export class StubAuthAdapter implements AuthAdapter {
  readonly mode = 'stub' as const;
  private listeners = new Set<(i: AuthStatusInfo) => void>();
  constructor(private status: AuthStatus = 'unavailable') {}

  getStatus(): Promise<AuthStatusInfo> {
    return Promise.resolve({
      status: this.status,
      accountLabel: null,
      message:
        this.status === 'unavailable'
          ? 'ChatGPT sign-in is not connected yet (waiting for the official Codex adapter from E02). Codex tasks are disabled.'
          : `Stub auth status: ${this.status}.`,
    });
  }

  startLogin(): Promise<LoginStart> {
    return Promise.resolve({
      kind: 'unavailable',
      reason: 'Official Codex ChatGPT sign-in adapter not integrated yet (E02). No credentials were requested.',
    });
  }

  cancelLogin(): Promise<void> {
    return Promise.resolve();
  }

  logouts = 0;

  /** Stub sign-out: no credentials exist here; reports signed_out unless the adapter is unavailable. */
  async logout(): Promise<void> {
    this.logouts++;
    if (this.status !== 'unavailable' && this.status !== 'unknown') await this.simulateStatus('signed_out');
  }

  onStatusChange(listener: (i: AuthStatusInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test/dev helper to exercise Auth required / Reconnect UI. */
  async simulateStatus(status: AuthStatus): Promise<void> {
    this.status = status;
    const info = await this.getStatus();
    for (const l of this.listeners) l(info);
  }
}

export class StubVoiceService implements VoiceService {
  readonly mode = 'stub' as const;
  suppressed = false;

  listDevices() {
    return Promise.resolve({ devices: [{ id: 'default', label: 'System default microphone (simulated)' }], simulated: true });
  }

  testMic() {
    if (this.suppressed) {
      return Promise.resolve({ ok: false, peakLevel: 0, simulated: true, message: 'Microphone is muted/paused. Unmute to test.' });
    }
    return Promise.resolve({ ok: true, peakLevel: 0.42, simulated: true, message: 'SIMULATED: no microphone was opened (voice worker pending E05).' });
  }

  runWakeTest() {
    if (this.suppressed) {
      return Promise.resolve({ detected: false, confidence: null, simulated: true, message: 'Microphone is muted/paused. Unmute to run the wake test.' });
    }
    return Promise.resolve({ detected: true, confidence: 0.9, simulated: true, message: 'SIMULATED: no audio was captured (wake-word engine pending E05).' });
  }

  setMicSuppressed(suppressed: boolean): Promise<void> {
    this.suppressed = suppressed;
    return Promise.resolve();
  }

  stop(): void {
    this.suppressed = true;
  }
}

export class StubCoordinator implements CoordinatorPort {
  readonly mode = 'stub' as const;
  private current: CoordinatorSnapshot = { state: 'BOOTING', taskActive: false, activeTaskId: null };
  private listeners = new Set<(s: CoordinatorSnapshot) => void>();
  private finishedListeners = new Set<(e: unknown) => void>();
  private cancelledListeners = new Set<(e: unknown) => void>();
  private progressListeners = new Set<(e: unknown) => void>();
  private approvalListeners = new Set<(e: unknown) => void>();
  /** ApprovalResolved sent by main (test/dev inspection). */
  readonly resolutions: { taskId: string; resolved: ApprovalResolved }[] = [];

  onApprovalRequested(listener: (e: unknown) => void) {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  private approvalOutcomeListeners = new Set<(e: unknown) => void>();

  onApprovalResolved(listener: (e: unknown) => void) {
    this.approvalOutcomeListeners.add(listener);
    return () => this.approvalOutcomeListeners.delete(listener);
  }

  /** Test/dev helper: the coordinator emits ApprovalResolved to the desktop (CONTRACTS: expiry only, decision:'expired'). */
  settleApproval(e: unknown): void {
    for (const l of this.approvalOutcomeListeners) l(e);
  }

  /** Test/dev helper: emit an ApprovalRequested payload (validated by main). */
  requestApproval(e: unknown): void {
    for (const l of this.approvalListeners) l(e);
  }

  /** UtteranceReady submitted by main (test/dev inspection). */
  readonly utterances: { utterance: UtteranceReady; source: UtteranceOrigin }[] = [];

  submitUtterance(utterance: UtteranceReady, source: UtteranceOrigin): void {
    this.utterances.push({ utterance, source });
  }

  resolveApproval(taskId: string, resolved: ApprovalResolved): void {
    this.resolutions.push({ taskId, resolved });
  }

  onTaskProgress(listener: (e: unknown) => void) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Test/dev helper: emit a TaskProgress payload (validated by main). */
  progress(e: unknown): void {
    for (const l of this.progressListeners) l(e);
  }

  onTaskFinished(listener: (e: unknown) => void) {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  /**
   * Test/dev helper: run `e.taskId` as the active task, then finish it the E03 way (active cleared
   * before the event is emitted). For tests where the event is for the desktop's latest task.
   */
  completeTask(e: { taskId: string } & Record<string, unknown>): void {
    this.set('EXECUTING', true, e.taskId);
    this.finish(e);
  }

  /** Test/dev helper: emit a TaskFinished payload (validated by main). */
  finish(e: unknown): void {
    this.endIfActive(e);
    for (const l of this.finishedListeners) l(e);
  }

  onTaskCancelled(listener: (e: unknown) => void) {
    this.cancelledListeners.add(listener);
    return () => this.cancelledListeners.delete(listener);
  }

  /** Test/dev helper: emit a TaskCancelled payload (validated by main). */
  cancel(e: unknown): void {
    this.endIfActive(e);
    for (const l of this.cancelledListeners) l(e);
  }

  /**
   * Like E03 @ 0714286 (ruling 2g.1): a terminal event for the active task clears the active task
   * BEFORE it is emitted. Events for any other taskId leave the state alone.
   */
  private endIfActive(e: unknown): void {
    const taskId = typeof e === 'object' && e !== null ? (e as { taskId?: unknown }).taskId : undefined;
    if (this.current.activeTaskId !== null && taskId === this.current.activeTaskId) this.set('STANDBY', false);
  }

  getState() {
    return { ...this.current };
  }

  onStateChange(listener: (s: CoordinatorSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test/dev helper. `activeTaskId` is kept while the task stays active, cleared when it isn't. */
  set(state: CoordinatorState, taskActive = this.current.taskActive, activeTaskId: string | null = taskActive ? this.current.activeTaskId : null): void {
    this.current = { state, taskActive, activeTaskId: taskActive ? activeTaskId : null };
    for (const l of this.listeners) l(this.getState());
  }

  stopTask(): Promise<StopTaskResult> {
    if (!this.current.taskActive) return Promise.resolve({ noActiveTask: true });
    this.set('CANCELLING', true);
    this.set('STANDBY', false);
    return Promise.resolve({ stopStatus: 'stopped_no_side_effects' });
  }

  stop(): void {
    this.set('SHUTDOWN', false);
    this.listeners.clear();
    this.finishedListeners.clear();
    this.cancelledListeners.clear();
    this.progressListeners.clear();
  }
}

/** Stub runtime supervisor feed until DOT-067 wires the real Codex app-server supervisor. */
export class StubRuntimeStatus implements RuntimeStatusSource {
  readonly mode = 'stub' as const;
  rechecks = 0;
  retries = 0;
  private listeners = new Set<(s: RuntimeStatus) => void>();
  constructor(private status: RuntimeStatus = 'unknown') {}

  getStatus(): RuntimeStatus {
    return this.status;
  }

  onStatusChange(listener: (s: RuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recheck(): Promise<void> {
    this.rechecks++;
    return Promise.resolve();
  }

  retry(): Promise<void> {
    this.retries++;
    return Promise.resolve();
  }

  /** Test/dev helper. */
  simulate(status: RuntimeStatus): void {
    this.status = status;
    for (const l of this.listeners) l(status);
  }
}

/**
 * In-memory AuditSink until DOT-097 (E08) lands the K8 audit store. Same contract as the real store:
 * validates on write (throws, never stores an invalid record), append-only (stored records are
 * frozen copies; `records` returns a frozen snapshot, so nothing can be changed through it).
 */
export class MemoryAuditSink implements AuditSink {
  private readonly stored: DesktopAuditRecord[] = [];
  write(record: DesktopAuditRecord): void {
    const parsed = InputFieldStrippedRecordSchema.parse(record);
    this.stored.push(Object.freeze({ ...parsed }));
  }
  get records(): readonly DesktopAuditRecord[] {
    return Object.freeze([...this.stored]);
  }
}
