/** In-memory activity ring buffer for the Activity view. Main-authored messages only; no secrets. */
import { randomUUID } from 'node:crypto';
import type { ActivityEntry } from '../shared/ipc';

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private listeners = new Set<(e: ActivityEntry) => void>();

  constructor(
    private readonly max = 200,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(level: ActivityEntry['level'], message: string, event?: ActivityEntry['event']): ActivityEntry {
    const entry: ActivityEntry = { id: randomUUID(), at: this.now().toISOString(), level, message: message.slice(0, 2000), ...(event ? { event } : {}) };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    for (const l of this.listeners) l(entry);
    return entry;
  }

  list(): ActivityEntry[] {
    return [...this.entries].reverse();
  }

  onEntry(listener: (e: ActivityEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
