/**
 * Approvals bridge (DOT-090; ADR-0009 CRs 1, 2, 4-6 and items 7, 9, 11, 12; CONTRACTS §1.4 #1-2, §3.2, §3.3).
 * Lives inside the adapter, as the runtime's ServerRequestDelegate for exactly two methods:
 * item/commandExecution/requestApproval and item/fileChange/requestApproval. Every other server request
 * (permissions → empty grant, elicitation → decline and no URL is ever opened, tool/* and token/attestation → -32601,
 * legacy → denied, unknown → -32601) stays with the default-deny handler (server-requests.ts).
 *
 * A request is answered `accept` ONLY when ALL of these hold; anything else is `decline` (or `cancel` / no reply):
 * 1. params are schema-shaped (known keys only, no duplicate JSON keys) and belong to a turn this adapter runs now;
 * 2. the desktop is not locked (item 12), there is no grantRoot (CR4), the action is not credential_access;
 * 3. the bound display builds (contracts codexDisplay from the validated params, rulings 1o/1r/1v; over a limit,
 *    malformed, or a `writeStdin` request (ruling 1x) → declined, reason display_unavailable, no dialog, no hook) and
 *    the actionId over the canonicalised args + displayHash + requestSource 'codex' computes (computeActionId +
 *    canonicalPath; CR2; the audit's argsHash is the same hash, §3.2); if it can't, the approval is unavailable
 *    (reason approval_unavailable) and nothing is shown;
 * 4. the coordinator's hook returns exactly {approved:true, reason:'approved'} while the request is still live (not
 *    expired, revoked, ended, resolved by the server or duplicated; CR5);
 * 5. K8 issues a token bound to this actionId + taskId, not outliving the approval, never seen before, and it is
 *    consumed before the reply (CR6). The default port issues none, so today nothing is ever accepted.
 * The only positive reply is the string `accept`: never acceptForSession or an amendment, whatever Codex proposes (CR4).
 * Every outcome is audited without args or contents (item 11); every outcome that wasn't the user's own answer
 * dismisses the dialog (CR1). Codex's `reason` text is untrusted (item 9, ruling 1o): it reaches the dialog only as the
 * stripped, cut `reasonUntrusted` slot of the display (covered by displayHash), never a title, never interpreted.
 */
import {
  CanonicalError,
  canonicalPath,
  codexDisplay,
  codexDisplayParams,
  computeActionId,
  computeDisplayHash,
  fileChangePaths,
  sha256Hex,
  type CodexDisplayParams,
  type CodexRunHooks,
  type PathPlatform,
  type Risk,
} from '@dottie/contracts';
import { NO_REPLY, type ServerReply, type ServerRequestContext } from '../connection.js';
import type { RequestId } from '../jsonrpc.js';
import type { Logger, LogFields, SecurityAudit } from '../logger.js';
import type { Scheduler } from '../scheduler.js';
import { APPROVAL_TOKEN_PURPOSE, defaultClassifier, FAIL_CLOSED_TOKENS, type ActionFacts, type ApprovalTokenPort, type Classification, type Classifier } from './policy.js';

export const CMD = 'item/commandExecution/requestApproval';
export const FILE = 'item/fileChange/requestApproval';
export const BRIDGED_METHODS: ReadonlySet<string> = new Set([CMD, FILE]);

// Exactly the 0.163.0 schema's property sets (CommandExecution/FileChangeRequestApprovalParams.json).
const CMD_KEYS = new Set(['kind', 'threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId', 'reason', 'networkApprovalContext', 'command', 'cwd', 'commandActions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments']);
const FILE_KEYS = new Set(['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot']);

/** ADR-0009 item 7. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
export const MAX_APPROVAL_TIMEOUT_MS = 120_000;

export type RevokeReason = 'panic_stop' | 'mute' | 'quit' | 'task_cancel' | 'locked' | 'app_server_restart';
/** CONTRACTS §3.2 `decision`. */
export type Decision = 'approved' | 'declined' | 'cancelled' | 'denied_by_policy' | 'expired' | 'revoked';
/** CONTRACTS §3.2 `wireReply` (error_32601 is the default handler's). */
export type WireReply = 'accept' | 'decline' | 'cancel' | 'none';
export type AuditKind = 'approval.requested' | 'approval.resolved' | 'approval.expired' | 'approval.revoked' | 'policy.denied';

export interface ApprovalDismissal {
  readonly actionId: string;
  readonly taskId: string;
  readonly reason: string;
}

export interface TurnLookup {
  /** The running Dottie task that owns this Codex turn on the current child, or undefined. */
  lookupTurn(threadId: string, turnId: string): { readonly taskId: string; readonly hooks: CodexRunHooks } | undefined;
}

export interface ApprovalBridgeOptions {
  /** CR6 seam (DOT-092). Default FAIL_CLOSED_TOKENS: nothing is ever accepted. */
  readonly tokens?: ApprovalTokenPort;
  /** Item 12: while this returns anything but false, every request is denied with no dialog. Required. */
  readonly isDesktopLocked: () => boolean;
  readonly classify?: Classifier;
  /** OS of the paths Codex reports (the App Server's platform). */
  readonly pathPlatform: PathPlatform;
  /** GetLongPathNameW in production (8.3 expansion); absent → any short name is refused (approval_unavailable). */
  readonly expandShortName?: (path: string) => string | undefined;
  /** Whether a canonical path exists now; undefined = can't tell (treated as "might" → overwrite, RB02-U3). */
  readonly pathExists?: (path: string) => boolean | undefined;
  /** Item 7: default 60 s, clamped to the 120 s maximum; a non-positive or non-finite value gives the default. */
  readonly timeoutMs?: number;
}

interface Outcome {
  readonly kind: Exclude<AuditKind, 'approval.requested'>;
  readonly decision: Decision;
  readonly reason?: string;
  readonly wire: WireReply;
}

interface Pending {
  readonly key: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly expiresAt: number;
  settled: boolean;
  resolve(o: Outcome): void;
}

interface Executed {
  readonly actionId: string;
  readonly argsHash: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly cls: Classification;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const optStr = (v: unknown): v is string | null | undefined => v === undefined || v === null || typeof v === 'string';
const reply = (w: WireReply): ServerReply => (w === 'none' ? NO_REPLY : { result: { decision: w === 'accept' ? 'accept' : w } });

class Refusal extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.reason ?? outcome.decision);
  }
}
function refuse(decision: Decision, reason: string, kind: Outcome['kind'] = 'approval.resolved', wire: WireReply = 'decline'): never {
  throw new Refusal({ kind, decision, reason, wire });
}

export class ApprovalBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly executed: Executed[] = [];
  private readonly fileItems = new Map<string, readonly unknown[]>();
  private readonly consumedTokens = new Set<string>();
  private readonly dismissCbs = new Set<(d: ApprovalDismissal) => void>();
  private readonly tokens: ApprovalTokenPort;
  private readonly classify: Classifier;
  readonly timeoutMs: number;

  constructor(
    private readonly turns: TurnLookup,
    private readonly options: ApprovalBridgeOptions,
    private readonly deps: { readonly scheduler: Scheduler; readonly logger: Logger; readonly audit: SecurityAudit },
  ) {
    this.tokens = options.tokens ?? FAIL_CLOSED_TOKENS;
    this.classify = options.classify ?? defaultClassifier;
    const t = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, MAX_APPROVAL_TIMEOUT_MS) : DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  onDismiss(cb: (d: ApprovalDismissal) => void): () => void {
    this.dismissCbs.add(cb);
    return () => void this.dismissCbs.delete(cb);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  // ------------------------------------------------------------------ ServerRequestDelegate
  async handle(method: string, params: unknown, ctx: ServerRequestContext): Promise<ServerReply | undefined> {
    if (!BRIDGED_METHODS.has(method)) return undefined;
    try {
      return await this.approve(method, params, ctx);
    } catch (e) {
      const o: Outcome =
        e instanceof Refusal
          ? e.outcome
          : e instanceof CanonicalError
            ? { kind: 'approval.resolved', decision: 'cancelled', reason: 'approval_unavailable', wire: 'decline' }
            : { kind: 'approval.resolved', decision: 'cancelled', reason: 'internal_error', wire: 'decline' };
      this.record(o.kind, { method, decision: o.decision, reason: o.reason ?? null, wireReply: o.wire, outcome: o.kind === 'policy.denied' ? 'denied' : 'reply_sent' });
      return reply(o.wire === 'accept' ? 'decline' : o.wire);
    }
  }

  /** The connection saw a second request with an id still being answered: the first can't be trusted either. */
  duplicate(id: RequestId): void {
    this.pending.get(keyOf(id))?.resolve({ kind: 'approval.resolved', decision: 'denied_by_policy', reason: 'reused', wire: 'decline' });
  }

  // ------------------------------------------------------------------ revocation (item 7)
  revokeAll(reason: RevokeReason): void {
    this.revoke(() => true, reason);
  }

  revokeTask(taskId: string, reason: RevokeReason = 'task_cancel'): void {
    this.revoke((x) => x.taskId === taskId, reason);
  }

  private revoke(match: (x: { taskId: string }) => boolean, reason: RevokeReason): void {
    // After an App Server restart the connection is gone: nothing can be written (wireReply none).
    const wire: WireReply = reason === 'app_server_restart' ? 'none' : 'cancel';
    for (const p of [...this.pending.values()]) if (match(p)) p.resolve({ kind: 'approval.revoked', decision: 'revoked', reason, wire });
    for (let i = this.executed.length - 1; i >= 0; i--) {
      const x = this.executed[i] as Executed;
      if (!match(x)) continue;
      this.executed.splice(i, 1);
      // Accepted and handed to Codex before the revoke: reported, not undone (item 7).
      this.record('approval.revoked', { actionId: x.actionId, argsHash: x.argsHash, taskId: x.taskId, category: x.cls.category, risk: x.cls.risk, decision: 'revoked', reason, wireReply: 'none', outcome: 'already_executed' });
    }
  }

  // ------------------------------------------------------------------ notifications
  onNotification(method: string, params: unknown): void {
    const p = obj(params);
    if (!p) return;
    const threadId = p['threadId'];
    if (method === 'item/started') {
      const item = obj(p['item']);
      if (item?.['type'] === 'fileChange' && nonEmpty(item['id']) && Array.isArray(item['changes'])) {
        this.fileItems.set(itemKey(String(threadId), String(p['turnId']), item['id']), item['changes'] as unknown[]);
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = obj(p['turn']);
      const turnId = turn?.['id'];
      const reason = turn?.['status'] === 'interrupted' ? 'turn_interrupted' : 'turn_ended';
      for (const x of [...this.pending.values()]) if (x.threadId === threadId && x.turnId === turnId) x.resolve({ kind: 'approval.resolved', decision: 'cancelled', reason, wire: 'cancel' });
      const prefix = `${String(threadId)}\u0000${String(turnId)}\u0000`;
      for (const k of [...this.fileItems.keys()]) if (k.startsWith(prefix)) this.fileItems.delete(k);
      for (let i = this.executed.length - 1; i >= 0; i--) {
        const x = this.executed[i] as Executed;
        if (x.threadId === threadId && x.turnId === turnId) this.executed.splice(i, 1);
      }
      return;
    }
    if (method === 'serverRequest/resolved') {
      const rid = p['requestId'];
      if (typeof rid !== 'string' && typeof rid !== 'number') return;
      const x = this.pending.get(keyOf(rid));
      if (x && x.threadId === threadId) x.resolve({ kind: 'approval.resolved', decision: 'cancelled', reason: 'resolved_by_server', wire: 'none' });
    }
  }

  /** The runtime left `running` (crash, restart, stop): nothing pending can be answered any more. */
  runtimeLost(): void {
    this.revokeAll('app_server_restart');
    this.fileItems.clear();
  }

  // ------------------------------------------------------------------ the request path
  private async approve(method: string, params: unknown, ctx: ServerRequestContext): Promise<ServerReply> {
    const p = obj(params);
    if (ctx.duplicateKeys || !p) return refuse('cancelled', 'schema_invalid');
    const allowed = method === CMD ? CMD_KEYS : FILE_KEYS;
    if (Object.keys(p).some((k) => !allowed.has(k))) refuse('cancelled', 'schema_invalid');
    const { threadId, turnId, itemId, startedAtMs } = p;
    if (!nonEmpty(threadId) || !nonEmpty(turnId) || !nonEmpty(itemId) || typeof startedAtMs !== 'number' || !Number.isInteger(startedAtMs)) refuse('cancelled', 'schema_invalid');
    if (!optStr(p['reason'])) refuse('cancelled', 'schema_invalid');

    const turn = this.turns.lookupTurn(threadId as string, turnId as string);
    if (!turn) return refuse('cancelled', 'unknown_turn');
    const { taskId, hooks } = turn;
    if (this.options.isDesktopLocked() !== false) {
      this.record('approval.requested', { method, taskId, outcome: 'not_displayed', reason: 'locked' });
      refuse('denied_by_policy', 'locked', 'policy.denied');
    }

    const canon = (v: unknown) => canonicalPath(v, { platform: this.options.pathPlatform, ...(this.options.expandShortName ? { expandShortName: this.options.expandShortName } : {}) });
    let args: Record<string, unknown>;
    let facts: ActionFacts;
    let displayParams: CodexDisplayParams;
    if (method === CMD) {
      const kind = p['kind'] ?? 'command'; // schema default
      if (kind !== 'command' && kind !== 'writeStdin') refuse('cancelled', 'schema_invalid');
      // E01 ruling 1x: terminal input has no display kind (never rendered as codex_command) → declined, no dialog.
      if (kind === 'writeStdin') this.displayUnavailable(method, taskId, 'write_stdin');
      if (!nonEmpty(p['command']) || !nonEmpty(p['cwd']) || !optStr(p['environmentId']) || !optStr(p['approvalId'])) refuse('cancelled', 'schema_invalid');
      const net = p['networkApprovalContext'] ?? null;
      if (net !== null && (!obj(net) || !nonEmpty(obj(net)!['host']) || !nonEmpty(obj(net)!['protocol']))) refuse('cancelled', 'schema_invalid');
      const execAmend = p['proposedExecpolicyAmendment'] ?? null;
      if (execAmend !== null && (!Array.isArray(execAmend) || !execAmend.every(nonEmpty))) refuse('cancelled', 'schema_invalid');
      const netAmend = p['proposedNetworkPolicyAmendments'] ?? null;
      if (netAmend !== null && (!Array.isArray(netAmend) || !netAmend.every((a) => nonEmpty(obj(a)?.['host']) && (obj(a)?.['action'] === 'allow' || obj(a)?.['action'] === 'deny')))) refuse('cancelled', 'schema_invalid');
      const cwd = canon(p['cwd']);
      // Ruling 1o: every sandbox / escalation request is its own highlighted bound field. Dottie never grants an
      // amendment (CR4: Approve answers plain `accept` for this one call), but the dialog shows what was asked.
      const escalation: string[] = [];
      if (net !== null) escalation.push(`Network access to ${String(obj(net)!['host'])} (${String(obj(net)!['protocol'])})`);
      if (execAmend !== null && execAmend.length > 0) escalation.push(`Allow similar commands without asking: ${(execAmend as string[]).join(' ')}`);
      for (const a of (netAmend ?? []) as Record<string, unknown>[]) escalation.push(`Network rule: ${String(a['action'])} ${String(a['host'])}`);
      displayParams = { kind: 'codex_command', commandLine: p['command'] as string, workingDirectory: cwd, networkAccess: net !== null, escalation, ...untrustedReason(p['reason']) };
      args = {
        kind,
        command: p['command'],
        cwd,
        network: net === null ? null : { host: obj(net)!['host'], protocol: obj(net)!['protocol'] },
        environmentId: p['environmentId'] ?? null,
        approvalId: p['approvalId'] ?? null,
      };
      facts = { method: CMD, command: p['command'] as string, cwd, network: net !== null };
    } else {
      if (p['grantRoot'] !== undefined && p['grantRoot'] !== null) refuse('denied_by_policy', 'grant_root', 'policy.denied');
      const changes = this.fileItems.get(itemKey(threadId as string, turnId as string, itemId as string));
      if (!changes || changes.length === 0) return refuse('cancelled', 'unknown_item');
      const parsed = changes.map((raw) => {
        const c = obj(raw);
        const k = obj(c?.['kind']);
        const kind = k?.['type'];
        if (!c || (kind !== 'add' && kind !== 'delete' && kind !== 'update') || typeof c['diff'] !== 'string') return refuse('cancelled', 'schema_invalid');
        const path = canon(c['path']);
        const mv = k!['move_path'];
        if (mv !== undefined && mv !== null && kind !== 'update') refuse('cancelled', 'schema_invalid');
        const movePath = mv === undefined || mv === null ? null : canon(mv);
        return { path, kind: kind as 'add' | 'delete' | 'update', movePath, diffSha256: sha256Hex(c['diff'] as string), exists: this.options.pathExists?.(movePath ?? path) };
      });
      args = { changes: parsed.map(({ exists: _e, ...rest }) => rest) };
      displayParams = { kind: 'codex_file_change', paths: fileChangePaths(parsed), ...untrustedReason(p['reason']) };
      facts = { method: FILE, changes: parsed };
    }

    const requestId = String(ctx.id);
    const ids = { method, args, targets: null, taskId, threadId: threadId as string, turnId: turnId as string, itemId: itemId as string, requestId, requestSource: 'codex' } as const;
    // Ruling 2b (dottie-e01 97e7bc0): the category is passed through unchanged (no raise to local_change). A Codex
    // approval always opens a dialog or is declined, whatever its category: read/navigate are never skipped as low risk
    // (codex_* displays are complete for them, ruling 2a); credential_access is never asked (below).
    const cls = this.classify(facts);
    if (cls.category === 'credential_access') {
      // No dialog ever (DENIED_BY_POLICY), so no display: the binding's displayHash is null.
      const actionId = computeActionId({ ...ids, displayHash: null });
      this.record('approval.requested', { actionId, argsHash: actionId, taskId, category: cls.category, risk: cls.risk, outcome: 'not_displayed', reason: 'credential_access' });
      refuse('denied_by_policy', 'credential_access', 'policy.denied');
    }
    // Rulings 1o/1r/1v: the bound display from the validated params; over a limit or malformed → display_unavailable.
    const built = codexDisplay(cls.category, displayParams);
    if (!built.ok) return this.displayUnavailable(method, taskId, 'build_failed');
    const display = codexDisplayParams(built.display); // normalised: the coordinator rebuilds the same bytes
    const displayHash = computeDisplayHash(built.display);
    const actionId = computeActionId({ ...ids, displayHash });
    if (!/^[0-9a-f]{64}$/.test(actionId)) throw new CanonicalError('actionId is not lowercase hex');
    const argsHash = actionId; // CONTRACTS §3.2: argsHash = the canonical-action SHA-256 (same hash as actionId)
    if (this.pending.has(keyOf(ctx.id))) refuse('denied_by_policy', 'reused');
    return this.ask({ method, actionId, argsHash, taskId, threadId: threadId as string, turnId: turnId as string, itemId: itemId as string, key: keyOf(ctx.id), cls, hooks, args, display });
  }

  /** Rulings 1k/1o/1x: no display → declined with display_unavailable; no dialog, no coordinator approval request. */
  private displayUnavailable(method: string, taskId: string, why: 'write_stdin' | 'build_failed'): never {
    this.record('approval.requested', { method, taskId, outcome: 'not_displayed', reason: 'display_unavailable', detail: why });
    return refuse('declined', 'display_unavailable');
  }

  private async ask(r: {
    method: string;
    actionId: string;
    argsHash: string;
    taskId: string;
    threadId: string;
    turnId: string;
    itemId: string;
    key: string;
    cls: Classification;
    hooks: CodexRunHooks;
    args: Record<string, unknown>;
    display: CodexDisplayParams;
  }): Promise<ServerReply> {
    const requestedAt = this.deps.scheduler.now();
    let resolveOutcome!: (o: Outcome) => void;
    const done = new Promise<Outcome>((res) => (resolveOutcome = res));
    const p: Pending = {
      key: r.key,
      actionId: r.actionId,
      taskId: r.taskId,
      threadId: r.threadId,
      turnId: r.turnId,
      expiresAt: requestedAt + this.timeoutMs,
      settled: false,
      resolve: (o) => {
        if (p.settled) return;
        p.settled = true;
        resolveOutcome(o);
      },
    };
    this.pending.set(r.key, p);
    const base = { actionId: r.actionId, argsHash: r.argsHash, taskId: r.taskId, category: r.cls.category, risk: r.cls.risk, requestedAt: iso(requestedAt), expiresAt: iso(p.expiresAt) };
    this.record('approval.requested', { ...base, outcome: 'displayed' });
    const cancelTimer = this.deps.scheduler.setTimeout(() => p.resolve({ kind: 'approval.expired', decision: 'expired', reason: 'timeout', wire: 'decline' }), this.timeoutMs);

    void this.decide(r, p);

    const o = await done;
    cancelTimer();
    this.pending.delete(r.key);
    if (o.wire === 'accept') this.executed.push({ actionId: r.actionId, argsHash: r.argsHash, taskId: r.taskId, threadId: r.threadId, turnId: r.turnId, cls: r.cls });
    this.record(o.kind, {
      ...base,
      decision: o.decision,
      reason: o.reason ?? null,
      wireReply: o.wire,
      resolvedAt: iso(this.deps.scheduler.now()),
      outcome: o.wire === 'none' ? 'reply_failed' : 'reply_sent',
    });
    if (o.decision !== 'approved' && o.reason !== 'user_declined') this.dismiss({ actionId: r.actionId, taskId: r.taskId, reason: o.reason ?? o.decision });
    return reply(o.wire);
  }

  /** Hook → exact decision → K8 token (bound, unexpired, unused, consumed) → accept. Every other path denies. */
  private async decide(r: { method: string; actionId: string; taskId: string; itemId: string; cls: Classification; hooks: CodexRunHooks; args: Record<string, unknown>; display: CodexDisplayParams }, p: Pending): Promise<void> {
    let d: unknown;
    try {
      d = await r.hooks.requestApproval({
        actionId: r.actionId,
        summary: summarise(r.method, r.args),
        risk: r.cls.risk as Risk,
        category: r.cls.category,
        toolId: r.itemId,
        display: r.display,
      });
    } catch {
      return p.resolve({ kind: 'approval.resolved', decision: 'cancelled', reason: 'internal_error', wire: 'decline' });
    }
    if (p.settled) return; // a late answer (after expiry, revoke, turn end…) changes nothing
    const verdict = readDecision(d);
    if (verdict !== 'approved') return p.resolve(verdict);
    let t: unknown;
    try {
      t = await this.tokens.issue({ purpose: APPROVAL_TOKEN_PURPOSE, actionId: r.actionId, taskId: r.taskId, expiresAt: p.expiresAt });
    } catch {
      return p.resolve({ kind: 'approval.resolved', decision: 'cancelled', reason: 'internal_error', wire: 'decline' });
    }
    if (p.settled) return;
    const tok = obj(t);
    if (!tok || !nonEmpty(tok['token'])) return p.resolve({ kind: 'approval.resolved', decision: 'denied_by_policy', reason: 'no_token', wire: 'decline' });
    const now = this.deps.scheduler.now();
    const exp = tok['expiresAt'];
    if (tok['purpose'] !== APPROVAL_TOKEN_PURPOSE || tok['actionId'] !== r.actionId || tok['taskId'] !== r.taskId) {
      return p.resolve({ kind: 'approval.resolved', decision: 'denied_by_policy', reason: 'token_mismatch', wire: 'decline' });
    }
    // exp <= the approval's expiry, so now < exp also means the approval itself is still in time.
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp > p.expiresAt || now >= exp) {
      return p.resolve({ kind: 'approval.resolved', decision: 'denied_by_policy', reason: 'token_expired', wire: 'decline' });
    }
    if (this.consumedTokens.has(tok['token'])) return p.resolve({ kind: 'approval.resolved', decision: 'denied_by_policy', reason: 'token_reused', wire: 'decline' });
    this.consumedTokens.add(tok['token']); // consumed before the side effect (the accept reply)
    p.resolve({ kind: 'approval.resolved', decision: 'approved', wire: 'accept' });
  }

  private dismiss(d: ApprovalDismissal): void {
    for (const cb of [...this.dismissCbs]) {
      try {
        cb(d);
      } catch {
        this.deps.logger.log('error', 'codex.approval.dismiss_threw', {});
      }
    }
  }

  private record(kind: AuditKind, fields: LogFields): void {
    this.deps.audit.emit(kind, fields);
  }
}

function keyOf(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}
function itemKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}\u0000${turnId}\u0000${itemId}`;
}
/** Codex's reason (model text) for the untrusted slot only; codexDisplay strips and cuts it. */
function untrustedReason(r: unknown): { reason?: string } {
  return typeof r === 'string' ? { reason: r } : {};
}
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Only the exact approval shape approves; a well-formed refusal maps to its class; anything else is a policy denial. */
export function readDecision(d: unknown): 'approved' | Outcome {
  const o = obj(d);
  const keys = o ? Object.keys(o).sort().join(',') : '';
  if (o && keys === 'approved,reason') {
    if (o['approved'] === true && o['reason'] === 'approved') return 'approved';
    if (o['approved'] === false) {
      if (o['reason'] === 'denied') return { kind: 'approval.resolved', decision: 'declined', reason: 'user_declined', wire: 'decline' };
      if (o['reason'] === 'expired') return { kind: 'approval.expired', decision: 'expired', reason: 'timeout', wire: 'decline' };
      if (o['reason'] === 'cancelled') return { kind: 'approval.resolved', decision: 'cancelled', reason: 'cancelled', wire: 'decline' };
      // CONTRACTS §1.4 (rulings 1m/1p): no dialog could be shown / a joined duplicate. Declines, never a user decline.
      if (o['reason'] === 'display_unavailable') return { kind: 'approval.resolved', decision: 'declined', reason: 'display_unavailable', wire: 'decline' };
      if (o['reason'] === 'duplicate_request') return { kind: 'approval.resolved', decision: 'declined', reason: 'duplicate_request', wire: 'decline' };
    }
  }
  return { kind: 'approval.resolved', decision: 'denied_by_policy', reason: 'invalid_decision', wire: 'decline' };
}

/** Exactly the hashed fields, rendered (CR2: the dialog shows no more and no fewer). Codex's `reason` is not shown. */
export function summarise(method: string, args: Record<string, unknown>): string {
  if (method === CMD) {
    const net = obj(args['network']);
    const where = net ? ` with network access to ${String(net['host'])} (${String(net['protocol'])})` : '';
    return `Run command${where}: ${String(args['command'])} (in ${String(args['cwd'])})`;
  }
  const changes = (args['changes'] as { path: string; kind: string; movePath: string | null }[]).map((c) => `${c.kind} ${c.path}${c.movePath ? ` → ${c.movePath}` : ''}`);
  return `Change files: ${changes.join('; ')}`;
}
