/**
 * Child-worker supervisor (spec §13.5): restart only crashed child workers, with exponential
 * backoff and a crash-loop cap; never restart after the user quits. Electron-free and timer-
 * injectable for tests. The desktop app itself is NEVER supervised/resurrected — Quit means quit.
 */
import type { SpawnOptions } from 'node:child_process';

/** Use for every worker spawn: no console window on Windows, no shell interpolation. */
export const HIDDEN_SPAWN_OPTIONS: Readonly<SpawnOptions> = Object.freeze<SpawnOptions>({
  windowsHide: true,
  shell: false,
  detached: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});

export interface ChildHandle {
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  /** Give up after this many crashes inside windowMs (crash loop). */
  maxCrashes: number;
  windowMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000, maxCrashes: 5, windowMs: 10 * 60_000 };

export type WorkerStatus = 'idle' | 'running' | 'backoff' | 'gave_up' | 'stopped';

export interface SupervisorDeps {
  spawn: () => ChildHandle;
  schedule: (fn: () => void, ms: number) => () => void;
  now: () => number;
  onStatus?: (status: WorkerStatus, detail: { crashes: number; nextDelayMs?: number }) => void;
}

export function backoffDelay(policy: BackoffPolicy, crashIndex: number): number {
  return Math.min(policy.maxMs, policy.initialMs * 2 ** Math.max(0, crashIndex));
}

export class WorkerSupervisor {
  private child: ChildHandle | null = null;
  private crashTimes: number[] = [];
  private cancelTimer: (() => void) | null = null;
  private stopping = false;
  status: WorkerStatus = 'idle';

  constructor(
    private readonly deps: SupervisorDeps,
    private readonly policy: BackoffPolicy = DEFAULT_BACKOFF,
  ) {}

  start(): void {
    if (this.stopping || this.status === 'running') return;
    const child = this.deps.spawn();
    this.child = child;
    this.setStatus('running');
    child.onExit(() => {
      if (this.child !== child) return;
      this.child = null;
      this.handleExit();
    });
  }

  private handleExit(): void {
    if (this.stopping) {
      this.setStatus('stopped');
      return;
    }
    const now = this.deps.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < this.policy.windowMs), now];
    if (this.crashTimes.length >= this.policy.maxCrashes) {
      this.setStatus('gave_up');
      return;
    }
    const delay = backoffDelay(this.policy, this.crashTimes.length - 1);
    this.setStatus('backoff', delay);
    this.cancelTimer = this.deps.schedule(() => {
      this.cancelTimer = null;
      this.start();
    }, delay);
  }

  /** Called on user Quit: cancel pending restarts, kill the child, and refuse future starts. */
  stop(): void {
    this.stopping = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.setStatus('stopped');
  }

  private setStatus(status: WorkerStatus, nextDelayMs?: number): void {
    this.status = status;
    this.deps.onStatus?.(status, nextDelayMs === undefined ? { crashes: this.crashTimes.length } : { crashes: this.crashTimes.length, nextDelayMs });
  }
}
