/**
 * taskId → threadId/turnId mapping (DOT-011 slice 2). Injectable so the desktop can persist it across Dottie restarts;
 * the in-memory default only survives App Server restarts. Holds Codex ids and states only: no prompt text, no output.
 */

export type TurnRecordState =
  /** A thread is ready for this task; no turn/start has been written yet. */
  | 'thread_ready'
  /** turn/start was written (or is about to be): from here on a turn MAY exist even if no id came back. */
  | 'dispatching'
  | 'in_flight'
  | 'completed'
  | 'failed'
  | 'interrupted'
  /** The child (or Dottie) went away while the turn was dispatching/in flight: outcome unknown, never retried blindly. */
  | 'unknown'
  /** Cancelled before turn/start was written: nothing was sent. */
  | 'stopped_before_dispatch';

export interface TurnRecord {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly threadId?: string;
  /** Codex's turn id (from turn/start's result). */
  readonly turnId?: string;
  /** The coordinator's turnId of the latest run (sent as clientUserMessageId). */
  readonly dottieTurnId?: string;
  /** Every coordinator turnId that may have reached the server for this task: never dispatched again. */
  readonly dispatchedTurnIds?: readonly string[];
  readonly state: TurnRecordState;
  /**
   * Server cross-check of an `unknown` record after a restart (thread/turns/list, matched on the userMessage
   * clientId = dottieTurnId; E09 v0.3.0). The store stays authoritative: the state stays `unknown` and the turn is
   * never resent whatever this says. `mismatch` (another Codex turn id, or several turns with this clientId) is audited.
   */
  readonly serverCheck?: {
    readonly result: 'match' | 'absent' | 'mismatch' | 'unavailable';
    readonly serverTurnId?: string;
    readonly serverStatus?: string;
  };
  /** Scheduler time (ms) of the last write. */
  readonly updatedAt: number;
}

export interface TurnStore {
  get(taskId: string): Promise<TurnRecord | undefined>;
  put(record: TurnRecord): Promise<void>;
  list(): Promise<readonly TurnRecord[]>;
}

/** States in which a Codex turn may exist for the record's idempotencyKey + attempt. */
export const DISPATCHED_STATES: ReadonlySet<TurnRecordState> = new Set<TurnRecordState>(['dispatching', 'in_flight', 'completed', 'failed', 'interrupted', 'unknown']);
/** States that mean a turn was live when the process holding it went away. */
export const LIVE_STATES: ReadonlySet<TurnRecordState> = new Set<TurnRecordState>(['dispatching', 'in_flight']);

export class MemoryTurnStore implements TurnStore {
  private readonly records = new Map<string, TurnRecord>();
  async get(taskId: string): Promise<TurnRecord | undefined> {
    return this.records.get(taskId);
  }
  async put(record: TurnRecord): Promise<void> {
    this.records.set(record.taskId, record);
  }
  async list(): Promise<readonly TurnRecord[]> {
    return [...this.records.values()];
  }
}
