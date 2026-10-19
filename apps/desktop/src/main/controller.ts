/**
 * Desktop controller: the Electron-free core of the main process. Owns settings, state hub,
 * activity, auto-start and service ports, and implements every IPC handler and tray action.
 * main.ts injects the few Electron capabilities it needs (PlatformHooks).
 */
import { z } from 'zod';
import { isAbsolute, normalize, parse as parsePath } from 'node:path';
import type { AppView, ControlAction, NavigateTarget } from '../shared/ipc';
import type { RuntimeStatus, RuntimeStatusEvent } from '../shared/runtime';
import { addCompletedStep, isOnboardingComplete } from '../shared/onboarding';
import type { FolderGrant, Settings } from '../shared/settings';
import { admitUtterance } from './input/utteranceGate';
import { MemoryAuditSink } from './services/stubs';
import type { AuditSink } from './services/types';
import { TRAY_IPC_CHANNEL, type UtteranceOrigin, ApprovalResolvedFields, approvalResolvedIssues, StopTaskResultSchema, TaskCancelledSchema, TaskFinishedSchema, TaskProgressSchema, UtteranceReadySchema, type StopStatus } from '../shared/contracts.draft';
import { randomUUID } from 'node:crypto';
import type { AuthStatus, FailedAfterChanges, LastTaskNote, MenuItemId, NetworkStatus, TaskBlock } from '../shared/states';
import { ActivityLog } from './activity';
import { ApprovalRefused, ApprovalService, type ApprovalErrorCode } from './approval/approvalService';
import type { FeatureFlags } from './flags';
import { IpcHandlerError, type IpcHandlers } from './ipc/router';
import { isAllowedExternalUrl } from './ipc/trust';
import type { AutoStartManager } from './lifecycle/autostart';
import type { SettingsStore } from './settings/store';
import { StateHub, type DerivedView } from './state/hub';
import { taskFinishedCopy } from './state/taskOutcomeCopy';
import { isAccountUnsupported } from './state/trayModel';
import type { AuthAdapter, CoordinatorPort, RuntimeStatusSource, VoiceService } from './services/types';

export interface PlatformHooks {
  platform: NodeJS.Platform;
  version: string;
  /** shell.openExternal — only ever called with allowlisted https URLs. */
  openExternal(url: string): Promise<void>;
  /** Native folder picker; returns an absolute path or null. */
  pickFolder(): Promise<string | null>;
  showWindow(view: NavigateTarget): void;
  /** Open/focus the main-owned secure approval window (approval.html). */
  showApproval?(): void;
  /** Close the approval window (nothing pending). */
  closeApproval?(): void;
  /** Push the Approve gate to the approval window (EVENT_CHANNELS.approvalGate). */
  approvalGate?(e: { dialogId: string; approveAfterMs: number | null }): void;
  /** BCP-47 locale for tray-originated UtteranceReady (defaults to en-US). */
  locale?: string;
  quit(): void;
}

/** Coordinator → desktop approval outcome: envelope taskId + ApprovalResolved payload. */
const CoordinatorApprovalOutcomeSchema = z
  .strictObject({ ...ApprovalResolvedFields, taskId: z.string().min(1).max(128) })
  .superRefine((e, ctx) => {
    for (const i of approvalResolvedIssues(e)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
  });

const APPROVAL_REFUSED_MESSAGES: Record<ApprovalErrorCode, string> = {
  unknown_or_used: 'This approval is no longer valid.',
  expired: 'This request expired, so nothing was done.',
  warning_not_shown: 'Approve is not available until the warning has been shown.',
  view_not_delivered: 'Approve is not available until the request has been shown.',
  not_attentive: 'Approve is available once this window has been on screen and focused for a moment.',
};

function approvalCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ApprovalRefused) throw new IpcHandlerError('FORBIDDEN', APPROVAL_REFUSED_MESSAGES[e.reason]);
    throw e;
  }
}

/** User-facing text per v2 stop status (ADR-0012 §7). Never a bare "cancelled" (spec §14). */
const STOP_MESSAGES: Record<StopStatus, string> = {
  stopped_before_dispatch: 'Task stopped before it was sent to Codex.',
  stopped_no_side_effects: 'Task stopped before it changed anything.',
  stopped_after_side_effects: 'Task stopped, but some actions had already happened — see activity.',
  stop_unconfirmed: 'Stop requested; Dottie could not confirm the task stopped.',
  completed_before_stop: 'The task finished before it could be stopped — see activity.',
};

/**
 * Fixed text for a tray retry (E01): the desktop never holds utterance text; the coordinator uses
 * retryOfTaskId and reuses the prior task's threadId (see docs §4e).
 */
export const RETRY_UTTERANCE_TEXT = 'Retry the last task.';
/** Outcomes after which "Retry last task" is enabled (E01 correction to ruling 4). */
export const RETRYABLE_OUTCOMES: ReadonlySet<string> = new Set(['failed', 'failed_after_side_effects', 'unverified', 'partial', 'blocked_unavailable']);

export interface ControllerDeps {
  store: SettingsStore;
  autostart: AutoStartManager;
  auth: AuthAdapter;
  voice: VoiceService;
  coordinator: CoordinatorPort;
  runtime: RuntimeStatusSource;
  flags: FeatureFlags;
  hooks: PlatformHooks;
  activity?: ActivityLog;
  /** Audit store port (CONTRACTS §3.2; DOT-097, E08). Defaults to the in-memory stub until DOT-097 swaps it in. */
  audit?: AuditSink;
}

export const WAKE_TEST_TIMEOUT_MS = 8_000;

/** Case-insensitive on Windows; resolves `..`; strips trailing separators. */
export function normalizeGrantPath(p: string, platform: NodeJS.Platform): string {
  const n = normalize(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? n.toLowerCase() : n;
}

export function isFilesystemRoot(p: string): boolean {
  const parsed = parsePath(normalize(p));
  return parsed.root !== '' && normalize(p).replace(/[\\/]+$/, '') === parsed.root.replace(/[\\/]+$/, '');
}

export class DesktopController {
  readonly hub: StateHub;
  readonly activity: ActivityLog;
  readonly approvals: ApprovalService;
  /** taskId of the last task the tray may retry (D14). Never exposed to the renderer. */
  private retryCandidate: string | null = null;
  /**
   * The desktop's latest task (ruling 2h): the last non-null `activeTaskId` seen on the coordinator
   * snapshot, kept after E03 clears it (E03 clears it before TaskFinished/TaskCancelled arrives).
   * Terminal-event UI effects apply only to this task. Never exposed to the renderer.
   */
  private latestTaskId: string | null = null;
  private paused = false;
  /** Paths returned by the native picker this session — the only new paths a grant may add. */
  private readonly pickedPaths = new Set<string>();
  private readonly runtimeListeners = new Set<(e: RuntimeStatusEvent) => void>();
  private runtimeSince: string;

  constructor(private readonly d: ControllerDeps) {
    this.activity = d.activity ?? new ActivityLog();
    this.approvals = new ApprovalService({
      resolve: (taskId, payload) => d.coordinator.resolveApproval(taskId, payload),
      show: () => d.hooks.showApproval?.(),
      close: () => d.hooks.closeApproval?.(),
      gate: (dialogId, approveAfterMs) => d.hooks.approvalGate?.({ dialogId, approveAfterMs }),
      log: (level, message) => this.activity.add(level, message),
      // Ruling 2e: read live on every request; never cached here.
      activeTaskId: () => d.coordinator.getState().activeTaskId,
    });
    const s = d.store.get();
    const c = d.coordinator.getState();
    this.runtimeSince = new Date().toISOString();
    this.hub = new StateHub({
      runtime: d.runtime.getStatus(),
      coordinator: c.state,
      taskActive: c.taskActive,
      muted: s.audio.muted,
      paused: false,
      auth: 'unknown',
      network: 'unknown',
      blocked: 'none',
      recovering: false,
      failedAfterChanges: 'none',
      lastTaskNote: 'none',
      retryTaskAvailable: false,
    });
    this.latestTaskId = c.activeTaskId;
    // Registered first, so the latest task is known before any other listener runs (ruling 2h).
    d.coordinator.onStateChange((cs) => {
      if (cs.activeTaskId !== null) this.latestTaskId = cs.activeTaskId;
    });
    d.coordinator.onStateChange((cs) =>
      // A new task in flight supersedes the previous task's block reason.
      // A finished/cancelled task ends any retry burst (recovering is task-scoped detail text).
      this.hub.update({
        coordinator: cs.state,
        taskActive: cs.taskActive,
        ...(cs.taskActive ? { blocked: 'none' as const, failedAfterChanges: 'none' as const, lastTaskNote: 'none' as const } : { recovering: false }),
      }),
    );
    d.coordinator.onStateChange((cs) => {
      if (cs.taskActive) this.setRetryCandidate(null);
    });
    d.coordinator.onTaskFinished((e) => this.onTaskFinished(e));
    d.coordinator.onTaskCancelled((e) => this.onTaskCancelled(e));
    d.coordinator.onTaskProgress((e) => this.onTaskProgress(e));
    d.coordinator.onApprovalRequested((e) => this.approvals.request(e));
    d.coordinator.onApprovalResolved((e) => {
      // CONTRACTS §3 @ 6834524 (E01 rulings 1m/1o): coordinator → desktop is expiry only: one
      // ApprovalResolved{approved:false, decision:'expired'} per dialog when C-08 fires. It closes
      // the dialog (idempotent: repeats or joined copies change nothing). `reason` is desktop-sent
      // only, and anything without decision:'expired' is not a coordinator outcome: ignored.
      const parsed = CoordinatorApprovalOutcomeSchema.safeParse(e);
      if (!parsed.success) this.activity.add('error', 'Ignored a malformed approval outcome from the coordinator.');
      else if (parsed.data.decision !== 'expired' || parsed.data.reason !== undefined) this.activity.add('warning', 'Ignored an unexpected approval outcome from the coordinator.');
      else this.approvals.settleExpired(parsed.data.actionId, parsed.data.taskId);
    });
    d.auth.onStatusChange((info) => this.setAuth(info.status));
    d.runtime.onStatusChange((status) => this.setRuntimeStatus(status));
  }

  /**
   * TaskFinished from the coordinator (CONTRACTS v2 §3). Invalid payloads are dropped and logged;
   * blocked outcomes become the tray's `blocked` input, anything else clears it.
   */
  /**
   * TaskProgress from the coordinator (CONTRACTS v2 §3). RECOVERING marks a Codex retry burst: the
   * coordinator stays EXECUTING, so this ONLY sets tooltip/detail text ('Reconnecting…'). It never
   * touches `coordinator` (tray state), never writes activity and never reaches voice/TTS — the
   * desktop has no speech path at all (spec §4; CONTRACTS §2.1 "nothing is spoken"). Any other
   * progress state clears the text.
   */
  onTaskProgress(raw: unknown): void {
    const parsed = TaskProgressSchema.safeParse(raw);
    if (!parsed.success) return; // malformed progress is dropped silently (it is display-only)
    // Ruling 2h.1 (E01 8af3cc7): a non-terminal task event changes desktop UI only when its taskId is
    // the CURRENT non-null activeTaskId (stricter than the latest-task rule for terminal events), so
    // progress for an old or already-finished task is a no-op.
    const active = this.d.coordinator.getState().activeTaskId;
    if (active === null || parsed.data.taskId !== active) return;
    this.hub.update({ recovering: parsed.data.state === 'RECOVERING' });
  }

  /**
   * TaskCancelled from the coordinator (CONTRACTS v2 §3; rulings 2g/2h). Validated in main;
   * malformed events are dropped and logged. Always closes that task's own leftover dialogs (2h a).
   * Its UI effect (ending the retry-burst "Reconnecting…" text) applies only when the taskId is the
   * desktop's latest task; for any other taskId nothing else changes (2h b). The stop report itself
   * is shown by the Stop task flow, not here, so a cancel adds no activity entry of its own.
   */
  onTaskCancelled(raw: unknown): void {
    const parsed = TaskCancelledSchema.safeParse(raw);
    if (!parsed.success) {
      this.activity.add('error', 'Ignored a malformed TaskCancelled event from the coordinator.');
      return;
    }
    this.approvals.dropTask(parsed.data.taskId);
    if (parsed.data.taskId !== this.latestTaskId) return;
    this.hub.update({ recovering: false });
  }

  onTaskFinished(raw: unknown): void {
    const parsed = TaskFinishedSchema.safeParse(raw);
    if (!parsed.success) {
      this.activity.add('error', 'Ignored a malformed TaskFinished event from the coordinator.');
      return;
    }
    const e = parsed.data;
    this.approvals.dropTask(e.taskId); // ruling 2h (a): that task's own leftover dialogs, any taskId
    const copy = taskFinishedCopy(e.outcome, e.reason);
    if (e.taskId !== this.latestTaskId) {
      // Ruling 2h (b): not the desktop's latest task (a late or unknown event). Only its own
      // activity entry; no blocked reason, retry candidate, tooltip or note. The desktop has no
      // speech path. retry_not_allowed stays silent (its copy has no activity entry).
      if (copy.activity !== null) this.activity.add(copy.level, copy.activity);
      return;
    }
    this.hub.update({ recovering: false });
    // D14: offer "Retry last task" after a failure with side effects or an unconfirmed result.
    // A refused retry (failed + retry_not_allowed) is not offered again.
    this.setRetryCandidate(RETRYABLE_OUTCOMES.has(e.outcome) && e.reason !== 'retry_not_allowed' ? e.taskId : null);
    if (e.outcome === 'failed_after_side_effects') {
      // Mid-run / after-commit failure (CONTRACTS §2.1). Detail only: it never sets `blocked`, never
      // touches auth (so no Auth required prompt, no sign-in), and never changes the tray state.
      // retry_not_allowed never pairs with this outcome (schema-enforced); map defensively.
      const detail: FailedAfterChanges = e.reason === undefined || e.reason === 'retry_not_allowed' ? 'unspecified' : e.reason;
      this.hub.update({ failedAfterChanges: detail, lastTaskNote: 'none' });
      if (copy.activity !== null) this.activity.add(copy.level, copy.activity);
      return;
    }
    let blocked: TaskBlock = 'none';
    if (e.outcome === 'blocked_auth' || e.outcome === 'blocked_unavailable') blocked = e.reason as TaskBlock;
    // declined+approval_unavailable and failed+clarification_* are detail only (tooltip + activity).
    const lastTaskNote: LastTaskNote =
      (e.outcome === 'declined' && e.reason === 'approval_unavailable') ||
      (e.outcome === 'failed' && (e.reason === 'clarification_timeout' || e.reason === 'clarification_cancelled' || e.reason === 'retry_not_allowed'))
        ? e.reason
        : 'none';
    this.hub.update({ blocked, failedAfterChanges: 'none', lastTaskNote });
    if (copy.activity !== null) this.activity.add(copy.level, copy.activity);
  }


  /**
   * Auth status from the adapter. A definitive answer means Codex answered, so a codex_unavailable
   * block is stale; signed_in also clears auth blocks.
   */
  private setAuth(auth: AuthStatus): void {
    const cur = this.hub.get().blocked;
    let blocked = cur;
    if (auth === 'signed_in') blocked = 'none';
    else if (cur === 'codex_unavailable' && auth !== 'unknown' && auth !== 'unavailable') blocked = 'none';
    this.hub.update({ auth, blocked });
  }

  /** Current runtime status as the push payload (CONTRACTS §2.4, shared/runtime.ts). */
  runtimeEvent(): RuntimeStatusEvent {
    return { role: 'codex_app_server', status: this.hub.get().runtime, since: this.runtimeSince };
  }

  onRuntimeStatus(listener: (e: RuntimeStatusEvent) => void): () => void {
    this.runtimeListeners.add(listener);
    return () => this.runtimeListeners.delete(listener);
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    const before = this.hub.get().runtime;
    if (before === status) return;
    this.runtimeSince = new Date().toISOString();
    this.hub.update({ runtime: status });
    if (status === 'breaker_open') this.activity.add('error', 'Codex stopped after repeated failures. Choose Retry to try again.');
    else if (status === 'waiting_for_env') this.activity.add('warning', 'Codex is unavailable while Dottie waits for its environment; tasks are paused. The wake word still works.');
    else if (before === 'waiting_for_env') this.activity.add('info', `Codex runtime ${status.replace(/_/g, ' ')}.`);
    const event = this.runtimeEvent();
    for (const l of this.runtimeListeners) l(event);
  }

  async init(): Promise<void> {
    const s = this.d.store.get();
    const rec = this.d.autostart.reconcile(s.startup.openAtLogin);
    if (rec.changed && rec.preference !== s.startup.openAtLogin) {
      await this.d.store.update((draft) => {
        draft.startup.openAtLogin = rec.preference;
      });
      this.activity.add('info', 'Start at sign-in was disabled outside Dottie (Windows Settings); preference updated.');
    }
    await this.d.voice.setMicSuppressed(s.audio.muted, 'mute');
    const auth = await this.d.auth.getStatus();
    this.setAuth(auth.status);
    this.activity.add('info', `Dottie started (voice: ${this.d.voice.mode}, auth: ${this.d.auth.mode}).`);
  }

  setNetwork(network: NetworkStatus): void {
    const before = this.hub.get().network;
    this.hub.update({ network });
    if (before !== network && before !== 'unknown') this.activity.add(network === 'offline' ? 'warning' : 'info', `Network ${network}.`);
  }

  appView(): AppView {
    const v: DerivedView = this.hub.view();
    return {
      tray: v.tray,
      menu: v.menu,
      flags: { voice: this.d.voice.mode, auth: this.d.auth.mode },
      platform: this.d.hooks.platform,
      version: this.d.hooks.version,
    };
  }

  // ------------------------------------------------------------------------- actions
  private async applyMicGate(reason: 'mute' | 'pause'): Promise<void> {
    const snap = this.hub.get();
    await this.d.voice.setMicSuppressed(snap.muted || snap.paused, reason);
  }

  async control(action: ControlAction): Promise<AppView> {
    switch (action) {
      case 'mute':
      case 'unmute': {
        const muted = action === 'mute';
        await this.d.store.update((draft) => {
          draft.audio.muted = muted;
        });
        this.hub.update({ muted });
        await this.applyMicGate('mute');
        this.activity.add('info', muted ? 'Microphone muted.' : 'Microphone unmuted.');
        break;
      }
      case 'pause':
      case 'resume':
        this.paused = action === 'pause';
        this.hub.update({ paused: this.paused });
        await this.applyMicGate('pause');
        this.activity.add('info', this.paused ? 'Dottie paused (mic off, no new tasks).' : 'Dottie resumed.');
        break;
      case 'stop_task': {
        // The coordinator's answer is untrusted input: validate it, and never claim more than it says.
        const parsed = StopTaskResultSchema.safeParse(await this.d.coordinator.stopTask());
        if (!parsed.success) {
          this.activity.add('warning', STOP_MESSAGES.stop_unconfirmed);
          break;
        }
        const r = parsed.data;
        if ('noActiveTask' in r) {
          this.activity.add('info', 'No task was running.');
          break;
        }
        const calm = r.stopStatus === 'stopped_before_dispatch' || r.stopStatus === 'stopped_no_side_effects';
        this.activity.add(calm ? 'info' : 'warning', STOP_MESSAGES[r.stopStatus]);
        break;
      }
      case 'reconnect':
        await this.reconnect();
        break;
      case 'retry':
        await this.retryRuntime();
        break;
      case 'sign_out':
        await this.signOut();
        break;
      case 'switch_account':
        await this.switchAccount();
        break;
    }
    return this.appView();
  }

  /** Ask the supervisor to retry the Codex runtime after its breaker opened (ADR-0013 item 3). */
  async retryRuntime(): Promise<void> {
    const snap = this.hub.get();
    if (snap.runtime !== 'breaker_open') {
      this.activity.add('info', 'Codex runtime is not in an error state; nothing to retry.');
      return;
    }
    if (snap.network === 'offline') {
      this.activity.add('warning', 'Still offline; Retry Codex is available when the network returns.');
      return;
    }
    await this.d.runtime.retry();
    this.activity.add('info', 'Retrying Codex…');
  }

  /** Unsupported account: sign out through the auth adapter (no credentials touch the renderer). */
  async signOut(): Promise<void> {
    await this.d.auth.logout();
    const info = await this.d.auth.getStatus();
    this.hub.update({ blocked: 'none' });
    this.setAuth(info.status);
    this.activity.add('info', 'Signed out of ChatGPT.');
  }

  /** Unsupported account: sign out, then start the official sign-in so the user can pick another account. */
  async switchAccount(): Promise<void> {
    await this.signOut();
    await this.startLogin();
  }

  async reconnect(): Promise<void> {
    const snap = this.hub.get();
    if (isAccountUnsupported(snap)) {
      // Never a reconnect loop for an unsupported account (CONTRACTS §2.1).
      this.activity.add('info', "This ChatGPT account can't run Codex. Use Sign out or Switch account.");
      return;
    }
    if (snap.blocked === 'codex_unavailable' && snap.runtime !== 'waiting_for_env') {
      // Re-probe only; never a sign-in prompt for codex_unavailable.
      await this.d.runtime.recheck();
      const info = await this.d.auth.getStatus();
      this.setAuth(info.status);
      this.activity.add('info', 'Checking whether Codex is reachable again; no sign-in needed.');
      return;
    }
    if (this.hub.get().runtime === 'waiting_for_env') {
      // No sign-in prompt: auth can't be probed and signing in would not help (E01 2026-10-19).
      await this.d.runtime.recheck();
      this.activity.add('info', 'Checking whether Codex can start again; no sign-in needed.');
      return;
    }
    const info = await this.d.auth.getStatus();
    this.setAuth(info.status);
    if (this.hub.get().network === 'offline') {
      this.activity.add('warning', 'Still offline; will reconnect when the network returns.');
      return;
    }
    if (info.status !== 'signed_in') await this.startLogin();
  }

  async startLogin(): Promise<{ started: boolean; method: 'system_browser' | 'device_code' | 'unavailable'; message: string; userCode?: string; verificationUrl?: string }> {
    const r = await this.d.auth.startLogin();
    if (r.kind === 'unavailable') {
      this.activity.add('warning', r.reason);
      return { started: false, method: 'unavailable', message: r.reason };
    }
    const url = r.kind === 'system_browser' ? r.authUrl : r.verificationUrl;
    if (!isAllowedExternalUrl(url)) {
      this.activity.add('error', 'Sign-in adapter returned a non-allowlisted URL; refused to open it.');
      await this.d.auth.cancelLogin(r.loginId);
      throw new IpcHandlerError('FORBIDDEN', 'Sign-in URL is not an allowlisted official OpenAI/ChatGPT address');
    }
    await this.d.hooks.openExternal(url);
    this.activity.add('info', 'Opened the official ChatGPT sign-in page in your browser.');
    if (r.kind === 'device_code') {
      return { started: true, method: 'device_code', message: 'Enter the code on the official page.', userCode: r.userCode, verificationUrl: r.verificationUrl };
    }
    return { started: true, method: 'system_browser', message: 'Continue in your browser. Dottie never asks for your password.' };
  }

  async wakeTest(): Promise<{ detected: boolean; confidence: number | null; simulated: boolean; message: string }> {
    if (!this.hub.view().tray.wakeAvailable) {
      return { detected: false, confidence: null, simulated: this.d.voice.mode === 'stub', message: 'Wake test unavailable: microphone is muted, paused, or starting up.' };
    }
    const r = await this.d.voice.runWakeTest(WAKE_TEST_TIMEOUT_MS);
    this.activity.add(r.detected ? 'info' : 'warning', `Wake test: ${r.detected ? 'detected' : 'not detected'}${r.simulated ? ' (simulated)' : ''}.`);
    return r;
  }

  private setRetryCandidate(taskId: string | null): void {
    this.retryCandidate = taskId;
    this.hub.update({ retryTaskAvailable: taskId !== null });
  }

  /**
   * Tray "Retry last task" (D14). Main builds UtteranceReady{retryOfTaskId} itself and submits it
   * with source 'tray_ipc' (CONTRACTS L211 channel id). There is no IPC path: the renderer cannot trigger it or choose a source.
   */
  private retryLastTask(): void {
    const taskId = this.retryCandidate;
    if (taskId === null) return;
    const parsed = UtteranceReadySchema.safeParse({
      requestId: randomUUID(),
      text: RETRY_UTTERANCE_TEXT,
      locale: this.d.hooks.locale ?? 'en-US',
      endReason: 'tray',
      retryOfTaskId: taskId,
    });
    if (!parsed.success) {
      this.activity.add('error', 'Could not start the retry.');
      return;
    }
    this.setRetryCandidate(null);
    this.submitUtterance(parsed.data, TRAY_IPC_CHANNEL);
    this.activity.add('info', 'Retrying the last task. Dottie will ask for approval again before doing anything that may repeat.');
  }

  /**
   * The single main-process entry for UtteranceReady (CONTRACTS L211, ruling 1t). `origin` is the
   * transport the caller received it on, never a payload field. retryOfTaskId is kept only from
   * voice_worker / tray_ipc; from any other origin it is stripped before the coordinator sees it,
   * with one value-free input.field_stripped audit record. Returns whether it was submitted.
   */
  submitUtterance(raw: unknown, origin: UtteranceOrigin, ctx: { taskId?: string } = {}): boolean {
    const r = admitUtterance(raw, origin, { audit: this.audit }, ctx);
    if (r.stripped) this.activity.add('warning', 'Ignored a retry request from a source that is not allowed to ask for one.');
    if (!r.ok) return false;
    this.d.coordinator.submitUtterance(r.utterance, origin);
    return true;
  }

  /** The audit sink in use (tests and smoke). */
  get audit(): AuditSink {
    return (this.auditSink ??= this.d.audit ?? new MemoryAuditSink());
  }
  private auditSink: AuditSink | undefined;

  async trayAction(id: MenuItemId): Promise<void> {
    const view = this.hub.view();
    const item = view.menu.find((m) => m.id === id);
    if (!item?.enabled) return; // defence in depth: disabled items do nothing
    const s = view.tray.snapshot;
    switch (id) {
      case 'wake_test':
        await this.wakeTest();
        return;
      case 'toggle_mute':
        await this.control(s.muted ? 'unmute' : 'mute');
        return;
      case 'toggle_pause':
        await this.control(s.paused ? 'resume' : 'pause');
        return;
      case 'settings':
        this.d.hooks.showWindow('settings');
        return;
      case 'show_activity':
        this.d.hooks.showWindow('activity');
        return;
      case 'reconnect':
        await this.control('reconnect');
        return;
      case 'stop_task':
        await this.control('stop_task');
        return;
      case 'retry':
        await this.control('retry');
        return;
      case 'retry_task':
        this.retryLastTask();
        return;
      case 'sign_out':
        await this.control('sign_out');
        return;
      case 'switch_account':
        await this.control('switch_account');
        return;
      case 'quit':
        this.d.hooks.quit();
        return;
    }
  }

  // ------------------------------------------------------------------------- grants
  private async setFolderGrants(folders: FolderGrant[]): Promise<Settings> {
    const platform = this.d.hooks.platform;
    const existing = new Set(this.d.store.get().grants.folders.map((f) => normalizeGrantPath(f.path, platform)));
    const seen = new Set<string>();
    for (const f of folders) {
      const key = normalizeGrantPath(f.path, platform);
      if (!isAbsolute(f.path)) throw new IpcHandlerError('INVALID_INPUT', 'Folder path must be absolute');
      if (!existing.has(key) && !this.pickedPaths.has(key)) {
        throw new IpcHandlerError('FORBIDDEN', 'Folders can only be added through the folder picker');
      }
      if (isFilesystemRoot(f.path)) throw new IpcHandlerError('FORBIDDEN', 'Grant a specific folder, not a whole drive');
      if (seen.has(key)) throw new IpcHandlerError('INVALID_INPUT', 'Duplicate folder');
      seen.add(key);
    }
    const next = await this.d.store.update((draft) => {
      draft.grants.folders = folders.map((f) => ({ path: f.path, scopes: [...new Set(f.scopes)] }));
    });
    this.activity.add('info', `Folder grants updated (${folders.length} folder${folders.length === 1 ? '' : 's'}).`);
    return next;
  }

  // ------------------------------------------------------------------------- IPC handlers
  handlers(): IpcHandlers {
    return {
      getView: () => this.appView(),
      getApproval: () => ({ approval: this.approvals.current() }),
      approvalWarningShown: ({ dialogId }) => approvalCall(() => this.approvals.warningShown(dialogId)),
      resolveApproval: ({ dialogId, decision }) => approvalCall(() => this.approvals.resolve(dialogId, decision)),
      control: ({ action }) => this.control(action),
      getSettings: () => this.d.store.get(),
      updateSettings: async (patch) => {
        const next = await this.d.store.update((draft) => {
          if (patch.audio) {
            const a = patch.audio;
            if (a.micDeviceId !== undefined) draft.audio.micDeviceId = a.micDeviceId;
            if (a.wakeSensitivity !== undefined) draft.audio.wakeSensitivity = a.wakeSensitivity;
            if (a.speakResponses !== undefined) draft.audio.speakResponses = a.speakResponses;
          }
          if (patch.capabilities) {
            for (const [scope, on] of Object.entries(patch.capabilities)) {
              if (on !== undefined) draft.grants.capabilities[scope as keyof Settings['grants']['capabilities']] = on;
            }
          }
        });
        if (patch.capabilities) this.activity.add('info', 'Capability grants updated.');
        return next;
      },
      getAutoStart: () => this.d.autostart.get(),
      setAutoStart: async ({ enabled }) => {
        const state = this.d.autostart.set(enabled);
        await this.d.store.update((draft) => {
          draft.startup.openAtLogin = state.supported && state.enabled;
        });
        this.activity.add('info', state.supported ? `Start at sign-in ${state.enabled ? 'enabled' : 'disabled'}.` : (state.note ?? 'Start at sign-in unsupported.'));
        return state;
      },
      completeOnboardingStep: async ({ step }) => {
        const current = this.d.store.get().onboarding.completedSteps;
        let steps;
        try {
          steps = addCompletedStep(step, current);
        } catch (e) {
          throw new IpcHandlerError('INVALID_INPUT', (e as Error).message);
        }
        return this.d.store.update((draft) => {
          draft.onboarding.completedSteps = steps;
          if (step === 'privacy' && draft.onboarding.privacyAcknowledgedAt === null) {
            draft.onboarding.privacyAcknowledgedAt = new Date().toISOString();
          }
          draft.onboarding.completed = isOnboardingComplete(steps);
        });
      },
      listMicDevices: () => this.d.voice.listDevices(),
      testMic: ({ deviceId }) => this.d.voice.testMic(deviceId),
      testWake: () => this.wakeTest(),
      getAuth: async () => {
        const info = await this.d.auth.getStatus();
        this.hub.update({ auth: info.status });
        return { ...info, adapter: this.d.auth.mode };
      },
      startLogin: () => this.startLogin(),
      logout: async () => {
        await this.signOut();
        const info = await this.d.auth.getStatus();
        return { ...info, adapter: this.d.auth.mode };
      },
      pickFolder: async () => {
        const picked = await this.d.hooks.pickFolder();
        if (picked) this.pickedPaths.add(normalizeGrantPath(picked, this.d.hooks.platform));
        return { picked };
      },
      setFolderGrants: ({ folders }) => this.setFolderGrants(folders),
      listActivity: () => ({ entries: this.activity.list() }),
    };
  }
}
