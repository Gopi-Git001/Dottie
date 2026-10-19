import type { Scheduler } from '../../src/index.js';

/** Deterministic Scheduler: time moves only when the test calls advance(). */
export class ManualScheduler implements Scheduler {
  private t = 1_800_000_000_000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.seq++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id);
    };
  }
  /** Delays (ms from now) of the timers currently pending, in firing order. */
  pendingDelays(): number[] {
    return this.timers.map((x) => x.at - this.t).sort((a, b) => a - b);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}
