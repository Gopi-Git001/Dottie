/**
 * Main-owned secure approval broker (tool-host-control DRAFT 8 §4.4 CR3/CR5, D2/P12, D14, C-25).
 * Electron-free and unit-tested.
 *
 *  - A coordinator ApprovalRequested is validated with zod (contracts.draft, CONTRACTS @ 97e7bc0).
 *    Malformed requests, a missing or invalid X5 `display`, `possibleRepeat` with
 *    `category:'read'|'navigate'`, a `read`/`navigate` request with a tool or ui_action display
 *    (ruling 2a: the coverage rule is tool-kind only; pre_dispatch and codex_* read/navigate DO open
 *    a dialog), a display whose category differs from the event's (ruling 2b, every kind) and
 *    already-expired requests are refused.
 *  - Ruling 2c (dottie-e01 a147dbe; extends 2b from Codex to every source): ANY ApprovalRequested
 *    with a valid actionId that fails validation or can't be shown (its view model fails the IPC
 *    schema), whatever its requestSource (codex, tool_host, coordinator/pre_dispatch, unknown), is
 *    answered at once with ApprovalResolved{approved:false, reason:'display_unavailable'}; never a
 *    silent drop. The warning log carries no field values. If a dialog is open for that actionId,
 *    the whole joined set is declined with it (join (f) fail closed). Nothing is sent only when
 *    there is no valid actionId (logged), the action is already answered or expired (one
 *    ApprovalResolved per actionId; arrival already expired or a copy after local expiry: the
 *    coordinator's C-08 expiry owns it, ruling 7), or the request is not for the active task.
 *  - Active-task check (E01 ruling 2e, dottie-e01 23553dc; ADR-0010 single active task): an
 *    ApprovalRequested (valid or not) whose `taskId` is not the coordinator's current active task
 *    opens no dialog and sends nothing; the warning log carries no field values and the
 *    coordinator's C-08 expiry closes it. This covers finished, cancelled and unknown taskIds alike.
 *    There is NO remembered finished-task cache (an evicted id would have looked new). The active
 *    task comes from `CoordinatorPort.getState().activeTaskId` (deps.activeTaskId), which the
 *    coordinator clears BEFORE it emits TaskFinished/TaskCancelled (ruling 2g.1, E03 0714286), so no
 *    desktop-side race workaround is kept. A terminal event (`dropTask`) closes only that task's own
 *    dialogs; for any other taskId it never ends or clears the current task.
 *    The answered/expired actionId memory is scoped to the active task (entries for any other task
 *    are pruned), so it is unbounded only within one task and never evicts while the task runs.
 *  - Each pending approval gets a fresh random `dialogId` (256-bit, single use). The renderer only
 *    ever sees that id and a view model built here from fixed templates; it never sees `actionId`.
 *  - Join (D2/P12, E01 ruling 6 + E08 conditions): a second ApprovalRequested with the same
 *    `actionId` while the dialog is open JOINS it: same dialog, same id, and the original expiry
 *    and the original warning-visible timer are kept (neither resets). One answer resolves the
 *    joined set with ONE ApprovalResolved (CONTRACTS §3 ApprovalResolved is keyed by `actionId`).
 *    A join arriving after the dialog was resolved, expired or settled never reopens it: dropped.
 *    A different `actionId` gets its own dialog.
 *  - Join condition (f) FAIL CLOSED (CONTRACTS §3 @ 0d53abc, E01 rulings 1m/1n): a joined request
 *    whose validated record differs in anything (summary, category, risk, expiry, possibleRepeat,
 *    display, taskId) disables Approve by resolving the WHOLE joined set at once as declined:
 *    one ApprovalResolved{approved:false, reason:'display_unavailable'} with no `decision`. The
 *    dialog id is consumed (a late Approve is refused), the dialog closes, and the warning log
 *    carries no field values.
 *  - Approve-enable timer (CONTRACTS §3 X5 @ 6834524, ruling 1l), on EVERY dialog: Approve is
 *    accepted only after the dialog has been on screen in a window that main saw as visible
 *    (shown, not minimized) AND focused for APPROVE_ATTENTION_MS continuously. Main tracks the
 *    BrowserWindow's focus/blur/show/hide/minimize/restore events (setWindowAttention); the
 *    renderer is never trusted for focus. Losing focus or visibility resets the timer; a join
 *    never resets or extends it; a different dialog coming on screen restarts it.
 *  - Approve is accepted only when the id is live and unexpired, the view was delivered, and,
 *    if `possibleRepeat` is present, the renderer confirmed the warning is visible AND at least
 *    WARNING_MIN_VISIBLE_MS passed since that confirmation. Decline is accepted for a live id.
 *  - Idempotent: a repeated click with the same id and decision returns the same result and
 *    emits nothing more; a different decision on a used id is refused.
 *  - Expiry (E01 ruling 7): on local expiry the dialog stays open with Approve (and Decline)
 *    disabled; nothing is sent. It closes when the coordinator's outcome for that action/task
 *    arrives (`settleExpired` from its ApprovalResolved{decision:'expired'}, one per dialog,
 *    rulings 1m/1o; or `dropTask` from TaskFinished/TaskCancelled). The desktop never sends one for expiry.
 *  - Only the secure_ui dialog (approval.html via IPC) reaches resolve(); there is no tray, voice
 *    or ControlAction path to it.
 *  - Codex approvals (CONTRACTS L221 @ 6834524, ruling 1o): the command line or the full path list
 *    is shown in full (scrollable read-only plain text, no ellipsis), the escalation request is
 *    its own highlighted field, and Codex's reason appears only in the untrusted slot.
 *  - Codex join (L214 (c), ruling 1p): the desktop sends ONE ApprovalResolved per actionId; the
 *    coordinator approves only the first JSON-RPC requestId and declines the joined ones
 *    (`duplicate_request`). Desktop copy never says the user declined a joined request.
 *  - Bound display fields (CONTRACTS X5 L230; DOT-095 criterion 10, UI side, E02 2581593
 *    `renderBoundText` semantics): every bound field of the display (method, labels, paths/targets,
 *    workingDirectory, escalation, app name, window title, process image, recipients, …) is shown
 *    with hidden characters as visible highlighted escapes and a "contains hidden characters"
 *    badge; nothing is stripped and the display object is never modified. Untrusted free text
 *    (summary, Codex reason, message body) stays stripped. The title is still the category template.
 */
import { own } from '../../shared/own';
import { randomBytes } from 'node:crypto';
import { renderBoundText, renderCodexCommand } from '../../shared/commandRender';
import { ApprovalIdentitySchema, ApprovalRequestedSchema, ApprovalResolvedSchema, HIDDEN_CHAR, type ApprovalCategory, type ApprovalDisplay, type ApprovalRequested, type ApprovalResolved } from '../../shared/contracts.draft';
import { APPROVE_ATTENTION_MS, ApprovalViewSchema, POSSIBLE_REPEAT_WARNINGS, UNTRUSTED_CODEX_REASON_LABEL, UNTRUSTED_SUMMARY_LABEL, WARNING_MIN_VISIBLE_MS, type ApprovalView, type BoundFieldKey, type BoundFieldView, type CodexView } from '../../shared/approval';

/** Shown only if a category ever lacks a label (unreachable after schema validation). */
export const UNKNOWN_CATEGORY_LABEL = 'this action';
export const CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  read: 'Read files or data',
  navigate: 'Open or navigate',
  local_change: 'Change something on this PC',
  delete: 'Delete',
  overwrite: 'Overwrite',
  external_send: 'Send something outside this PC',
  external_upload: 'Upload something outside this PC',
  purchase: 'Make a purchase',
  install_or_elevate: 'Install software or use admin rights',
  security_setting: 'Change a security setting',
};

/** Pure rule (unit-tested): the approval window counts as attended only when shown, not minimized and focused. */
export function windowAttentive(w: { destroyed: boolean; visible: boolean; minimized: boolean; focused: boolean }): boolean {
  return !w.destroyed && w.visible && !w.minimized && w.focused;
}

export type ApprovalErrorCode = 'unknown_or_used' | 'expired' | 'warning_not_shown' | 'view_not_delivered' | 'not_attentive';

export class ApprovalRefused extends Error {
  constructor(readonly reason: ApprovalErrorCode) {
    super(reason);
    this.name = 'ApprovalRefused';
  }
}

export interface ApprovalServiceDeps {
  /** Emits ApprovalResolved to the coordinator (envelope taskId + payload). */
  resolve(taskId: string, payload: ApprovalResolved): void;
  /** Open / focus (reload) the main-owned approval window. */
  show(): void;
  /** Close the approval window (nothing pending). */
  close(): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
  /**
   * The coordinator's current single active task (ADR-0010), or null when no task is active.
   * Read on every request (ruling 2e); main takes it from CoordinatorPort.getState().activeTaskId.
   */
  activeTaskId(): string | null;
  /**
   * Push the Approve gate for the shown dialog to the approval window: `approveAfterMs` is how
   * long until main will accept Approve (0 = now), or null while the window is not visible and
   * focused. UX only; main enforces the same rule in resolve().
   */
  gate?(dialogId: string, approveAfterMs: number | null): void;
  now?: () => number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Pending {
  dialogId: string;
  request: ApprovalRequested;
  expiresAtMs: number;
  warningRequired: boolean;
  viewDelivered: boolean;
  /** Main clock time of the renderer's warning-visible confirmation (never reset by a join). */
  warningShownAt: number | null;
  expired: boolean;
  /** Main clock time since the window has been continuously visible AND focused with this dialog shown; null otherwise. */
  attentionSince: number | null;
  /** Requests joined into this dialog (1 = only the original). */
  requests: number;
  timer: unknown;
}

const NOT_ACTIVE_TASK = "Ignored an approval request that is not for the active task; the coordinator's expiry will close it.";
const DECLINED_UNUSABLE = 'An approval request could not be shown safely, so it was declined.';

export class ApprovalService {
  private readonly pending = new Map<string, Pending>();
  /**
   * actionId -> taskId for actions answered, expired or settled in the ACTIVE task: later joins are
   * dropped. Entries for any other task are pruned (they can't matter: such requests are dropped by
   * the active-task check), so nothing is ever evicted while its task is active (ruling 2e).
   */
  private readonly settled = new Map<string, string>();
  /** dialogId -> decision already taken (idempotent repeated clicks). */
  private readonly decided = new Map<string, 'approve' | 'decline'>();
  /** Window state from main's BrowserWindow events (never from the renderer). */
  private attentive = false;
  /** dialogId whose view the window last received. */
  private shownDialogId: string | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: ApprovalServiceDeps) {
    this.now = d.now ?? (() => Date.now());
    this.newId = d.newId ?? (() => randomBytes(32).toString('hex'));
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Coordinator → main. Returns the dialogId (new or joined), or null when refused/dropped. */
  request(raw: unknown): string | null {
    const parsed = ApprovalRequestedSchema.safeParse(raw);
    if (!parsed.success) {
      const custom = (field: string) => parsed.error.issues.some((i) => i.path[0] === field && i.code === 'custom');
      // Ruling 2c: no field values in the log; the message names only the rule.
      this.declineUnusable(
        raw,
        custom('possibleRepeat')
          ? 'An approval request was declined: a read or navigate action cannot carry a possible-repeat warning.'
          : custom('category')
            ? 'An approval request was declined: this kind of read or navigate action never opens an approval dialog.'
            : DECLINED_UNUSABLE,
      );
      return null;
    }
    const request = parsed.data;
    if (this.isSettled(request.actionId)) {
      this.d.log('warning', 'Ignored an approval request for an action that was already answered or expired.');
      return null;
    }
    const existing = this.findByAction(request.actionId);
    if (existing) {
      if (existing.expired || this.now() >= existing.expiresAtMs) {
        this.d.log('warning', 'Ignored an approval request for an action that was already answered or expired.');
        return null;
      }
      existing.requests += 1;
      if (!sameDisplayedRecord(existing.request, request)) {
        // Join condition (f): fail closed. No field values in the log.
        this.decided.set(existing.dialogId, 'decline');
        this.remove(existing);
        const payload = ApprovalResolvedSchema.parse({
          actionId: existing.request.actionId,
          approved: false,
          timestamp: new Date(this.now()).toISOString(),
          reason: 'display_unavailable',
        });
        this.d.resolve(existing.request.taskId, payload);
        this.d.log('warning', 'A repeated approval request did not match the one on screen, so the action was declined for safety.');
        return null;
      }
      // D2/P12 join: same dialog, original expiry and warning timer kept (the copy's own expiry is
      // ignored, not declined), display unchanged.
      return existing.dialogId;
    }
    const expiresAtMs = Date.parse(request.expiry);
    const remaining = expiresAtMs - this.now();
    if (!(remaining > 0)) {
      this.d.log('warning', 'An approval request arrived already expired, so nothing was done.');
      return null;
    }
    const dialogId = this.newId();
    const entry: Pending = {
      dialogId,
      request,
      expiresAtMs,
      warningRequired: request.possibleRepeat !== undefined,
      viewDelivered: false,
      warningShownAt: null,
      expired: false,
      attentionSince: null,
      requests: 1,
      timer: null,
    };
    if (!this.isActiveTask(request.taskId)) {
      // Ruling 2e: not the active task (finished, cancelled or unknown): open nothing, send nothing.
      this.d.log('warning', NOT_ACTIVE_TASK);
      return null;
    }
    // Ruling 2c: a request whose view can't cross IPC can't be shown: decline, never open an empty dialog.
    if (!ApprovalViewSchema.safeParse(toView(entry)).success) {
      this.declineUnusable(raw, DECLINED_UNUSABLE);
      return null;
    }
    entry.timer = this.setTimer(() => this.expire(entry), remaining);
    this.pending.set(dialogId, entry);
    this.d.show();
    return dialogId;
  }

  /**
   * Ruling 2c: an approval request (any source) that can't be validated or shown is declined,
   * never dropped. Answers with display_unavailable; if a dialog for that actionId is open, the
   * whole joined set is declined (join (f)). No valid actionId, an already answered/expired action
   * or a request that is not for the active task send nothing (see header). No field values are logged.
   */
  private declineUnusable(raw: unknown, message: string): void {
    const id = ApprovalIdentitySchema.safeParse(raw);
    if (!id.success) {
      this.d.log('warning', 'Ignored a malformed approval request that cannot be answered (no valid action id); the coordinator will let it expire.');
      return;
    }
    const { actionId } = id.data;
    if (this.isSettled(actionId)) {
      this.d.log('warning', 'Ignored an approval request for an action that was already answered or expired.');
      return;
    }
    const existing = this.findByAction(actionId);
    let taskId = id.data.taskId;
    if (existing) {
      if (existing.expired || this.now() >= existing.expiresAtMs) {
        this.d.log('warning', 'Ignored an approval request for an action that was already answered or expired.');
        return;
      }
      existing.requests += 1;
      taskId = existing.request.taskId;
      this.decided.set(existing.dialogId, 'decline');
      this.remove(existing);
    } else {
      if (!this.isActiveTask(taskId)) {
        this.d.log('warning', NOT_ACTIVE_TASK);
        return;
      }
      this.markSettled(actionId, taskId);
    }
    const payload = ApprovalResolvedSchema.parse({ actionId, approved: false, timestamp: new Date(this.now()).toISOString(), reason: 'display_unavailable' });
    this.d.resolve(taskId, payload);
    this.d.log('warning', message);
  }

  /** Oldest live approval (else the oldest expired one, shown disabled). Marks it delivered. */
  current(): ApprovalView | null {
    const all = [...this.pending.values()];
    for (const p of all) if (!p.expired && this.now() >= p.expiresAtMs) this.expire(p);
    const p = all.find((x) => !x.expired) ?? all[0];
    if (!p) return null;
    if (!p.expired) p.viewDelivered = true;
    if (this.shownDialogId !== p.dialogId) {
      const prev = this.shownDialogId === null ? undefined : this.pending.get(this.shownDialogId);
      if (prev) prev.attentionSince = null; // a different dialog on screen: its timer restarts
      this.shownDialogId = p.dialogId;
      if (this.attentive && !p.expired) p.attentionSince = this.now();
    } else if (this.attentive && !p.expired) p.attentionSince ??= this.now();
    this.pushGate();
    return toView(p);
  }

  /**
   * CONTRACTS §3 X5 approve-enable timer @ 6834524 (ruling 1l): main reports whether the approval
   * BrowserWindow is visible (shown, not minimized) AND focused, from its own window events.
   * Losing either resets the 500 ms timer; regaining starts it again for the shown dialog.
   */
  setWindowAttention(attentive: boolean): void {
    if (attentive === this.attentive) return;
    this.attentive = attentive;
    if (!attentive) for (const p of this.pending.values()) p.attentionSince = null;
    else {
      const p = this.shownDialogId === null ? undefined : this.pending.get(this.shownDialogId);
      if (p && p.viewDelivered && !p.expired) p.attentionSince = this.now();
    }
    this.pushGate();
  }

  /** ms until Approve is accepted for this dialog on attention grounds (0 = now), or null if not attentive. */
  private attentionWait(p: Pending): number | null {
    if (!this.attentive || p.attentionSince === null || p.dialogId !== this.shownDialogId) return null;
    return Math.max(0, p.attentionSince + APPROVE_ATTENTION_MS - this.now());
  }

  private pushGate(): void {
    const p = this.shownDialogId === null ? undefined : this.pending.get(this.shownDialogId);
    if (p && !p.expired) this.d.gate?.(p.dialogId, this.attentionWait(p));
  }

  /** Renderer confirms the warning is rendered and visible. */
  warningShown(dialogId: string): { approveEnabled: boolean; enableAfterMs: number } {
    const p = this.live(dialogId);
    if (!p.viewDelivered) throw new ApprovalRefused('view_not_delivered');
    if (!p.warningRequired) return { approveEnabled: true, enableAfterMs: 0 };
    p.warningShownAt ??= this.now();
    return { approveEnabled: true, enableAfterMs: Math.max(0, p.warningShownAt + WARNING_MIN_VISIBLE_MS - this.now()) };
  }

  resolve(dialogId: string, decision: 'approve' | 'decline'): { decision: 'approve' | 'decline' } {
    const prior = this.decided.get(dialogId);
    if (prior !== undefined) {
      if (prior === decision) return { decision }; // idempotent double click: nothing more is sent
      throw new ApprovalRefused('unknown_or_used');
    }
    const p = this.live(dialogId);
    if (decision === 'approve') {
      if (!p.viewDelivered) throw new ApprovalRefused('view_not_delivered');
      // Warning confirmation (D14/C-25) is an additional requirement on warning dialogs.
      if (p.warningRequired && (p.warningShownAt === null || this.now() - p.warningShownAt < WARNING_MIN_VISIBLE_MS)) {
        this.d.log('warning', 'Approve was refused because the possible-repeat warning had not been visible long enough.');
        throw new ApprovalRefused('warning_not_shown');
      }
      const wait = this.attentionWait(p);
      if (wait === null || wait > 0) {
        this.d.log('warning', 'Approve was refused because the dialog had not been visible and focused long enough.');
        throw new ApprovalRefused('not_attentive');
      }
    }
    this.decided.set(dialogId, decision);
    this.remove(p);
    // One ApprovalResolved per actionId, covering every joined request.
    const payload = ApprovalResolvedSchema.parse({ actionId: p.request.actionId, approved: decision === 'approve', timestamp: new Date(this.now()).toISOString() });
    this.d.resolve(p.request.taskId, payload);
    this.d.log('info', decision === 'approve' ? 'You approved the action.' : 'You declined the action, so it was not done.');
    return { decision };
  }

  /**
   * The coordinator's C-08 expiry for an action arrived (ApprovalResolved{decision:'expired'}):
   * close that dialog. Idempotent: a repeat (or one per joined request) finds nothing and does
   * nothing. Never sends anything back. Returns whether a dialog was closed.
   */
  settleExpired(actionId: string, taskId?: string): boolean {
    const p = this.findByAction(actionId);
    const owner = p?.request.taskId ?? taskId ?? this.d.activeTaskId();
    if (owner !== null) this.markSettled(actionId, owner);
    if (!p) return false;
    if (!p.expired) this.d.log('info', 'The approval request expired, so nothing was done.');
    this.remove(p);
    return true;
  }

  /**
   * Terminal event (TaskFinished OR TaskCancelled; a task ends with exactly one, rulings 2g/2g.1)
   * for `taskId`: closes that task's own dialogs only; no ApprovalResolved is sent. The current task
   * itself is the coordinator's `activeTaskId`, which it clears BEFORE it emits (E03 0714286), so
   * later requests for the ended task are refused by the active-task check. An event for any other
   * taskId touches nothing of the current (newer) task. Returns the number of dialogs closed.
   */
  dropTask(taskId: string): number {
    const mine = [...this.pending.values()].filter((p) => p.request.taskId === taskId);
    for (const p of mine) this.remove(p);
    return mine.length;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Number of requests joined into the dialog for an actionId (tests/diagnostics). */
  joinedCount(actionId: string): number {
    return this.findByAction(actionId)?.requests ?? 0;
  }

  /** The validated request as received (tests: proves the display is never rewritten for rendering). */
  pendingRequest(actionId: string): ApprovalRequested | null {
    return this.findByAction(actionId)?.request ?? null;
  }

  private expire(p: Pending): void {
    if (p.expired || !this.pending.has(p.dialogId)) return;
    p.expired = true;
    this.clearTimer(p.timer);
    this.markSettled(p.request.actionId, p.request.taskId);
    this.d.log('info', 'The approval request expired, so nothing was done.');
    // Re-render: the dialog now shows the expired state with Approve disabled. No ApprovalResolved.
    this.d.show();
  }

  private remove(p: Pending): void {
    this.clearTimer(p.timer);
    this.pending.delete(p.dialogId);
    this.markSettled(p.request.actionId, p.request.taskId);
    if (this.pending.size === 0) this.d.close();
    else this.d.show();
  }

  /** Ruling 2e (ADR-0010): the request's task is the coordinator's single active task, and it hasn't ended. */
  private isActiveTask(taskId: string): boolean {
    const active = this.d.activeTaskId();
    return active !== null && taskId === active;
  }

  private isSettled(actionId: string): boolean {
    this.pruneSettled();
    return this.settled.has(actionId);
  }

  private markSettled(actionId: string, taskId: string): void {
    this.settled.set(actionId, taskId);
    this.pruneSettled();
  }

  /** Keep only the active task's answered/expired actionIds (requests for other tasks never get this far). */
  private pruneSettled(): void {
    const active = this.d.activeTaskId();
    for (const [actionId, taskId] of this.settled) if (taskId !== active) this.settled.delete(actionId);
  }

  private findByAction(actionId: string): Pending | undefined {
    for (const p of this.pending.values()) if (p.request.actionId === actionId) return p;
    return undefined;
  }

  private live(dialogId: string): Pending {
    const p = this.pending.get(dialogId);
    if (!p) throw new ApprovalRefused('unknown_or_used');
    if (!p.expired && this.now() >= p.expiresAtMs) this.expire(p);
    if (p.expired) throw new ApprovalRefused('expired');
    return p;
  }
}

/** A request that claims to be Codex's (by source or display kind), validated or not (diagnostics/tests). */
export function isCodexRequest(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as { requestSource?: unknown; display?: unknown };
  const kind = r.display !== null && typeof r.display === 'object' ? (r.display as { kind?: unknown }).kind : undefined;
  return r.requestSource === 'codex' || kind === 'codex_command' || kind === 'codex_file_change';
}

/** Deep equality of two validated records (key order ignored); every field is shown or bound. */
/**
 * Join condition (f) (CONTRACTS L214 @ 1f3ac60, rulings 1t/1w): a joined copy must match the dialog in
 * every DISPLAYED field and the bound display (whose SHA-256 is displayHash), and, since ruling 1w,
 * in the CR2 inputs `taskId` and `requestSource` (same actionId with different CR2 inputs is an
 * integrity failure). The joined copy's own `expiry` is ignored (the first expiresAt is kept,
 * condition b) and is never a mismatch.
 */
export function sameDisplayedRecord(a: ApprovalRequested, b: ApprovalRequested): boolean {
  const shown = (r: ApprovalRequested) => ({ summary: r.summary, category: r.category, risk: r.risk, possibleRepeat: r.possibleRepeat, display: r.display, taskId: r.taskId, requestSource: r.requestSource });
  return stable(shown(a)) === stable(shown(b));
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Untrusted free text (ruling 1t; same as E02 2581593 display.ts `untrustedText` minus the cut):
 * lone surrogates → U+FFFD, then EVERY hidden character of the pinned E02 set (`HIDDEN_CHAR`: C0/C1
 * controls, DEL, bidi marks/embeddings/overrides/isolates, zero-width and invisible format characters,
 * BOM, soft hyphen, tag characters, …) is removed. Used for every untrusted free-text slot the dialog
 * shows: the event-level `summary` (tool / ui_action dialogs), pre_dispatch `summaryUntrusted`, Codex
 * `reasonUntrusted` and the external_send message body. The display fields already must arrive
 * stripped (schema); the event-level `summary` is not a display field, so this is its only strip.
 * Bound fields are never stripped: they go through renderBoundText (visible escapes, L230).
 */
const HIDDEN_CHAR_G = new RegExp(HIDDEN_CHAR.source, 'gu');
const LONE_SURROGATE_G = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const stripUnsafe = (s: string): string => s.replace(LONE_SURROGATE_G, '\uFFFD').replace(HIDDEN_CHAR_G, '');

/** The Codex block, or null for non-Codex displays. Never truncates the command or the paths. */
export function codexView(r: ApprovalRequested): { codex: CodexView; reason: string | null } | null {
  const d = r.display;
  if (d.kind === 'codex_command') {
    return {
      codex: {
        kind: 'command',
        fullTextLabel: 'Command',
        // L231: nothing stripped; hidden characters become visible escapes. The display object
        // (and so displayHash / what Codex runs) is never modified.
        command: renderCodexCommand(d.commandLine),
        paths: null,
        // L230 bound fields: never stripped; hidden characters become visible escapes (badge).
        workingDirectory: renderBoundText(d.workingDirectory),
        networkAccess: d.networkAccess === 'requested',
        escalation: d.escalation.length === 0 ? null : d.escalation.map(renderBoundText),
      },
      reason: d.reasonUntrusted,
    };
  }
  if (d.kind === 'codex_file_change') {
    return {
      codex: { kind: 'file_change', fullTextLabel: `Files (${String(d.paths.length)})`, command: null, paths: d.paths.map(renderBoundText), workingDirectory: null, networkAccess: null, escalation: null },
      reason: d.reasonUntrusted,
    };
  }
  return null;
}

/** L230 bound fields of a tool, ui_action or pre_dispatch display; [] for Codex (its block carries them). Fixed labels. */
export function boundFields(d: ApprovalDisplay): BoundFieldView[] {
  const f = (key: BoundFieldKey, label: string, values: readonly string[], untrusted = false): BoundFieldView => ({ key, label, values: values.map(renderBoundText), untrusted });
  const count = (n: number) => (n === 1 ? '' : ` (${String(n)})`);
  switch (d.kind) {
    case 'codex_command':
    case 'codex_file_change':
      return [];
    case 'pre_dispatch':
      return d.retryOfTaskId === null ? [] : [f('retryOfTaskId', 'Retry of task', [d.retryOfTaskId])];
    case 'ui_action':
      return [f('method', 'Action', [d.method]), f('appName', 'App', [d.app.appName]), f('windowTitle', 'Window title (untrusted)', [d.app.windowTitle], true), f('processImage', 'Program', [d.app.processImage])];
    case 'tool': {
      const head = [f('method', 'Action', [d.method]), f('targetLabel', 'Target', [d.targetLabel])];
      switch (d.category) {
        case 'local_change':
          return [...head, f('targets', `Items${count(d.targets.length)}`, d.targets)];
        case 'delete':
        case 'overwrite':
          return [...head, f('paths', `Files${count(d.paths.length)}`, d.paths)];
        case 'external_send':
          // bodyUntrusted is untrusted free text: it arrives stripped (schema), so it never shows escapes.
          return [...head, f('recipients', `Recipients${count(d.recipients.length)}`, d.recipients), f('channel', 'Channel', [d.channel]), f('bodyUntrusted', 'Message (untrusted, not checked by Dottie)', [stripUnsafe(d.bodyUntrusted)], true)];
        case 'external_upload':
          return [...head, f('path', 'File', [d.path]), f('destinationHost', 'Destination', [d.destinationHost])];
        case 'purchase':
          return [...head, f('merchant', 'Merchant', [d.merchant]), f('amount', 'Amount', [`${d.amount} ${d.currency}`])];
        case 'install_or_elevate':
          return [...head, f('package', 'Package', [d.package]), f('publisher', 'Publisher', [d.publisher]), f('version', 'Version', [d.version]), f('source', 'Source', [d.source])];
        case 'security_setting':
          return [...head, f('setting', 'Setting', [d.setting]), f('currentValue', 'Current value', [d.currentValue]), f('newValue', 'New value', [d.newValue])];
      }
    }
  }
}

function toView(p: Pending): ApprovalView {
  const r = p.request;
  const cx = codexView(r);
  // Codex's reason (model text) goes only in the untrusted slot (L221); otherwise the summary.
  const codexReason = cx?.reason ?? null;
  return {
    dialogId: p.dialogId,
    // TODO(DOT-095): body from ApprovalRequested.display for the other shapes (see header); category template title.
    title: `Approve: ${own(CATEGORY_LABELS, r.category) ?? UNKNOWN_CATEGORY_LABEL}?`,
    categoryLabel: own(CATEGORY_LABELS, r.category) ?? UNKNOWN_CATEGORY_LABEL,
    risk: r.risk,
    category: r.category,
    expiresAt: r.expiry,
    expired: p.expired,
    // pre_dispatch: the bound slot `summaryUntrusted` (ruling 1v), which displayHash covers.
    untrustedSummary: stripUnsafe(codexReason ?? (r.display.kind === 'pre_dispatch' ? r.display.summaryUntrusted : r.summary)),
    untrustedLabel: codexReason !== null ? UNTRUSTED_CODEX_REASON_LABEL : UNTRUSTED_SUMMARY_LABEL,
    codex: cx?.codex ?? null,
    fields: boundFields(r.display),
    warning: r.possibleRepeat ? { priorSideEffect: r.possibleRepeat.priorSideEffect, text: own(POSSIBLE_REPEAT_WARNINGS, r.possibleRepeat.priorSideEffect) ?? POSSIBLE_REPEAT_WARNINGS.committed } : null,
  };
}
