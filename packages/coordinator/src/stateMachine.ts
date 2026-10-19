import { isValidTransition, type CoordinatorState } from './states.js';
import type { Logger } from './ports.js';

export type TransitionResult =
  | { readonly ok: true; readonly from: CoordinatorState; readonly to: CoordinatorState }
  | { readonly ok: false; readonly from: CoordinatorState; readonly to: CoordinatorState; readonly error: string };

export interface TransitionRecord {
  readonly from: CoordinatorState;
  readonly to: CoordinatorState;
  readonly reason: string;
  readonly at: number;
  readonly accepted: boolean;
}

/**
 * Explicit-table state machine. Invalid transitions are rejected, logged at warn, recorded in history,
 * and never applied. SHUTDOWN is terminal.
 */
export class StateMachine {
  private current: CoordinatorState;
  private readonly records: TransitionRecord[] = [];
  private rejectedCount = 0;

  constructor(
    private readonly logger: Logger,
    private readonly now: () => number,
    private readonly onChange: (from: CoordinatorState, to: CoordinatorState, reason: string) => void = () => {},
    initial: CoordinatorState = 'BOOTING',
    private readonly historyCap = 500,
  ) {
    this.current = initial;
  }

  get state(): CoordinatorState {
    return this.current;
  }

  get rejected(): number {
    return this.rejectedCount;
  }

  get history(): readonly TransitionRecord[] {
    return this.records;
  }

  can(to: CoordinatorState): boolean {
    return isValidTransition(this.current, to);
  }

  transition(to: CoordinatorState, reason: string): TransitionResult {
    const from = this.current;
    if (!isValidTransition(from, to)) {
      this.rejectedCount++;
      this.record({ from, to, reason, at: this.now(), accepted: false });
      this.logger.log('warn', 'coordinator.transition.rejected', { from, to, reason });
      return { ok: false, from, to, error: `invalid transition ${from} -> ${to}` };
    }
    this.current = to;
    this.record({ from, to, reason, at: this.now(), accepted: true });
    this.logger.log('info', 'coordinator.transition', { from, to, reason });
    this.onChange(from, to, reason);
    return { ok: true, from, to };
  }

  private record(r: TransitionRecord): void {
    this.records.push(r);
    if (this.records.length > this.historyCap) this.records.shift();
  }
}
