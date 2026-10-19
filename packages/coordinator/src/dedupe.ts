import type { Clock } from './ports.js';

/** Normalise an utterance for duplicate detection: case, punctuation, whitespace, leading wake word. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(hey |ok |okay )?dottie\b ?/, '')
    .trim();
}

export type DedupeVerdict =
  | { readonly duplicate: false; readonly key: string }
  | { readonly duplicate: true; readonly key: string; readonly reason: 'same_request_id' | 'same_text_within_window'; readonly originalTaskId: string };

/**
 * Two-layer duplicate-command guard:
 *  1. requestId (from UtteranceReady) is idempotent: the same requestId never creates a second task.
 *  2. The same normalised text inside `windowMs` is treated as an accidental resubmission
 *     (double wake, echo, IPC retry). Callers may bypass layer 2 for an explicit "do it again".
 */
export class DedupeGuard {
  private readonly byText = new Map<string, { at: number; taskId: string }>();
  private readonly byRequest = new Map<string, { at: number; taskId: string }>();

  constructor(
    private readonly clock: Clock,
    readonly windowMs: number,
    private readonly requestTtlMs = 3_600_000,
    private readonly cap = 1000,
  ) {}

  check(requestId: string, text: string, allowRepeat = false): DedupeVerdict {
    this.cleanup();
    const key = normalizeUtterance(text);
    const byReq = this.byRequest.get(requestId);
    if (byReq) return { duplicate: true, key, reason: 'same_request_id', originalTaskId: byReq.taskId };
    const byText = this.byText.get(key);
    if (!allowRepeat && byText) return { duplicate: true, key, reason: 'same_text_within_window', originalTaskId: byText.taskId };
    return { duplicate: false, key };
  }

  record(requestId: string, key: string, taskId: string): void {
    const at = this.clock.now();
    this.byRequest.set(requestId, { at, taskId });
    this.byText.set(key, { at, taskId });
    for (const m of [this.byRequest, this.byText]) {
      while (m.size > this.cap) {
        const first = m.keys().next();
        if (first.done) break;
        m.delete(first.value);
      }
    }
  }

  /** Record only the requestId (Ruling 2: a clarification answer must not block later identical words). */
  recordRequest(requestId: string, taskId: string): void {
    this.byRequest.set(requestId, { at: this.clock.now(), taskId });
  }

  private cleanup(): void {
    const now = this.clock.now();
    for (const [k, v] of this.byText) if (now - v.at >= this.windowMs) this.byText.delete(k);
    for (const [k, v] of this.byRequest) if (now - v.at >= this.requestTtlMs) this.byRequest.delete(k);
  }
}
