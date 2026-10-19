/**
 * DOT-098: bounded smoke steps (Electron-free, unit-tested). Every wait in the smoke is a named
 * step with its own timeout; a step that doesn't settle in time fails the smoke with its name
 * (never skipped, never retried), so a hang can't hide.
 */

export class SmokeStepTimeout extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number,
  ) {
    super(`smoke step "${step}" did not finish within ${String(timeoutMs)} ms`);
    this.name = 'SmokeStepTimeout';
  }
}

/** A bounded step finished but its outcome is wrong (e.g. not exactly one reply). Fails the smoke with the step name. */
export class SmokeStepAssertion extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`smoke step "${step}" failed: ${detail}`);
    this.name = 'SmokeStepAssertion';
  }
}

/**
 * DOT-098 (a): a closing click must produce EXACTLY one ApprovalResolved (one click, one reply;
 * a double click is still one). Returns null when it did, else the failure detail.
 */
export function exactlyOneReply(before: number, after: number): string | null {
  const n = after - before;
  return n === 1 ? null : `expected exactly one ApprovalResolved, got ${String(n)}`;
}

/** One ApprovalResolved as the smoke pins it: which action, and the decision. */
export interface ReplyEntry {
  readonly actionId: string;
  readonly approved: boolean;
}

/** Short form for logs: a 64-char repeated id prints as `<char>x64`, anything else in full. */
export function shortActionId(id: string): string {
  return id.length === 64 && id === id.charAt(0).repeat(64) ? `${id.charAt(0)}x64` : id;
}

function fmt(e: ReplyEntry | undefined): string {
  return e === undefined ? '(none)' : `${shortActionId(e.actionId)}/${String(e.approved)}`;
}

/**
 * DOT-098 (E07 recheck): the WHOLE ordered ApprovalResolved sequence of a smoke run must equal the
 * expected one: same total count, and the same actionId and approved value at every position.
 * The per-click exactlyOneReply checks only count; this pins value and actionId and also catches
 * a duplicate that arrives after a click's settle window. Returns null on a match, else a detail
 * naming the first differing position.
 */
export function replySequenceMismatch(expected: readonly ReplyEntry[], actual: readonly ReplyEntry[]): string | null {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const want = expected[i];
    const got = actual[i];
    if (want?.actionId !== got?.actionId || want?.approved !== got?.approved) {
      return `ApprovalResolved sequence differs at #${String(i + 1)}: expected ${fmt(want)}, got ${fmt(got)} (expected ${String(expected.length)} replies, got ${String(actual.length)}: ${actual.map((e) => fmt(e)).join(', ')})`;
    }
  }
  return null;
}

export interface StepClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

const realClock: StepClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** Records which steps ran (for the failure report) and runs each with its own timeout. */
export class SmokeSteps {
  readonly completed: string[] = [];
  current: string | null = null;
  /** The most recently started step (kept after it completes). */
  lastStarted: string | null = null;

  constructor(private readonly clock: StepClock = realClock) {}

  /** Resolve with `work`'s value, or reject with SmokeStepTimeout(name) after `timeoutMs`. */
  run<T>(name: string, work: Promise<T>, timeoutMs: number): Promise<T> {
    this.current = name;
    this.lastStarted = name;
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => reject(new SmokeStepTimeout(name, timeoutMs)), timeoutMs);
      work.then(
        (v) => {
          this.clock.clearTimeout(timer);
          this.completed.push(name);
          this.current = null;
          resolve(v);
        },
        (e: unknown) => {
          this.clock.clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /**
   * Where the smoke is, for a watchdog report (DOT-098 (c)): never null. The running step, else
   * `after:<last completed step>`, else `before:first-step`.
   */
  position(): string {
    if (this.current !== null) return this.current;
    const last = this.completed[this.completed.length - 1];
    return last !== undefined ? `after:${last}` : 'before:first-step';
  }

  /** Poll `check` every `intervalMs` until it returns a non-null value; SmokeStepTimeout(name) after `timeoutMs`. */
  waitFor<T>(name: string, check: () => T | null | Promise<T | null>, timeoutMs: number, intervalMs = 50): Promise<T> {
    let stopped = false;
    const poll = async (): Promise<T> => {
      for (;;) {
        const v = await check();
        if (v !== null) return v;
        if (stopped) return new Promise<T>(() => undefined);
        await new Promise((r) => this.clock.setTimeout(() => r(undefined), intervalMs));
      }
    };
    return this.run(name, poll(), timeoutMs).finally(() => {
      stopped = true;
    });
  }
}

/** DOT-099: an expected reply plus the smoke step whose action produces it (for blame). */
export interface ExpectedReply extends ReplyEntry {
  readonly step: string;
}

/** DOT-099: which step to blame, and why. */
export interface Blame {
  readonly step: string;
  readonly detail: string;
}

/** The step whose action produces replies for `actionId`, if the smoke expects that action at all. */
export function ownerStep(expected: readonly ExpectedReply[], actionId: string): string | undefined {
  return expected.find((e) => e.actionId === actionId)?.step;
}

/**
 * DOT-099 F2: check the replies that arrived during closing click `name` for its own dialog
 * `ownActionId`. A reply for ANOTHER expected action is a stray from the step that produced it and
 * is blamed as `after:<that step>`, never on this (neighbouring) click. Otherwise this click must
 * have produced exactly one reply, for its own action (an unknown action is blamed on this click).
 */
export function clickRepliesBlame(name: string, ownActionId: string, added: readonly ReplyEntry[], expected: readonly ExpectedReply[]): Blame | null {
  for (const e of added) {
    const owner = e.actionId === ownActionId ? undefined : ownerStep(expected, e.actionId);
    if (owner !== undefined && owner !== name) {
      return { step: `after:${owner}`, detail: `stray ApprovalResolved ${fmt(e)} (from ${owner}) arrived during ${name}` };
    }
  }
  const own = added.filter((e) => e.actionId === ownActionId).length;
  if (own !== 1 || added.length !== 1) {
    return { step: name, detail: `expected exactly one ApprovalResolved, for ${shortActionId(ownActionId)}; got ${String(added.length)}: ${added.map((e) => fmt(e)).join(', ') || '(none)'}` };
  }
  return null;
}

/**
 * DOT-099 F1/F2: the full-sequence check with blame. A wrong entry at an expected position is
 * blamed on `checkName`; an EXTRA entry (a repeat of an action already answered, or past the
 * expected end) that belongs to a known action is blamed as `after:<its step>`.
 */
export function replySequenceBlame(checkName: string, expected: readonly ExpectedReply[], actual: readonly ReplyEntry[]): Blame | null {
  const detail = replySequenceMismatch(expected, actual);
  if (detail === null) return null;
  const i = actual.findIndex((got, k) => expected[k]?.actionId !== got.actionId || expected[k]?.approved !== got.approved);
  const got = i >= 0 ? actual[i] : undefined;
  if (got !== undefined) {
    const owner = ownerStep(expected, got.actionId);
    const extra = i >= expected.length || actual.slice(0, i).some((e) => e.actionId === got.actionId);
    if (owner !== undefined && extra) return { step: `after:${owner}`, detail: `late ApprovalResolved ${fmt(got)} from ${owner}, seen at ${checkName}: ${detail}` };
  }
  return { step: checkName, detail };
}

