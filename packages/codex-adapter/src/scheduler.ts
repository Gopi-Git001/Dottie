/** Injected time source so supervision and timeouts are testable without sleeps. */
export interface Scheduler {
  now(): number;
  /** Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};
