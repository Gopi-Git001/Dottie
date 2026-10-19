/** DOT-098: bounded, named smoke steps (src/main/smoke/steps.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmokeStepAssertion, SmokeStepTimeout, SmokeSteps, clickRepliesBlame, exactlyOneReply, ownerStep, replySequenceBlame, replySequenceMismatch, shortActionId } from '../src/main/smoke/steps';

describe('SmokeSteps (DOT-098)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a step that never settles fails with its own name and bound (no retry, no skip)', async () => {
    const s = new SmokeSteps();
    const work = vi.fn(() => new Promise<never>(() => undefined));
    const p = s.run('repeat.approveDoubleClick', work(), 5_000);
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(s.current).toBe('repeat.approveDoubleClick');
    await vi.advanceTimersByTimeAsync(1);
    const e = await caught;
    expect(e).toBeInstanceOf(SmokeStepTimeout);
    expect(e).toMatchObject({ step: 'repeat.approveDoubleClick', timeoutMs: 5_000 });
    expect(work).toHaveBeenCalledTimes(1);
    expect(s.completed).toEqual([]);
  });

  it('a step that settles in time resolves with its value and is recorded', async () => {
    const s = new SmokeSteps();
    await expect(s.run('renderer.probe', Promise.resolve(42), 5_000)).resolves.toBe(42);
    expect(s.completed).toEqual(['renderer.probe']);
    expect(s.current).toBeNull();
  });

  it('a step error propagates unchanged (not turned into a pass)', async () => {
    const s = new SmokeSteps();
    await expect(s.run('codex.probe', Promise.reject(new Error('boom')), 5_000)).rejects.toThrow('boom');
    expect(s.completed).toEqual([]);
  });

  it('detach clears a failed step so a later failure is not blamed on it', async () => {
    const s = new SmokeSteps();
    await expect(s.run('renderer.screenshot', Promise.reject(new Error('UnknownVizError')), 5_000)).rejects.toThrow('UnknownVizError');
    expect(s.position()).toBe('renderer.screenshot');
    expect(s.completed).toEqual([]);
    s.detach();
    expect(s.position()).toBe('before:first-step');
  });

  it('waitFor polls until the check yields a value, else fails with the step name', async () => {
    const s = new SmokeSteps();
    let n = 0;
    const ok = s.waitFor('timer.reshow.waitLoad', () => (++n >= 3 ? 'wc' : null), 5_000, 100);
    await vi.advanceTimersByTimeAsync(250);
    await expect(ok).resolves.toBe('wc');
    const never = s.waitFor('bound.waitLoad', () => null, 1_000, 100).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await never).toMatchObject({ step: 'bound.waitLoad', timeoutMs: 1_000 });
    const calls = n;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(n).toBe(calls); // the timed-out poll stops
  });
});

describe('DOT-098 (a): exactly one reply per closing click', () => {
  it('one reply passes; a faked duplicate (or none) fails with the count', () => {
    expect(exactlyOneReply(4, 5)).toBeNull();
    expect(exactlyOneReply(4, 6)).toBe('expected exactly one ApprovalResolved, got 2'); // faked duplicate
    expect(exactlyOneReply(4, 4)).toBe('expected exactly one ApprovalResolved, got 0');
  });
  it('SmokeStepAssertion carries the step name', () => {
    const e = new SmokeStepAssertion('bound.decline', 'expected exactly one ApprovalResolved, got 2');
    expect(e).toMatchObject({ step: 'bound.decline', detail: 'expected exactly one ApprovalResolved, got 2' });
  });
});

describe('DOT-098 (c): watchdog position is never null', () => {
  it('running step, else after:<last completed>, else before:first-step', async () => {
    const s = new SmokeSteps();
    expect(s.position()).toBe('before:first-step');
    let release: () => void = () => undefined;
    const p = s.run('codex.probe', new Promise<void>((r) => (release = r)), 5_000);
    expect(s.position()).toBe('codex.probe');
    release();
    await p;
    expect(s.position()).toBe('after:codex.probe');
  });
});

describe('replySequenceMismatch (DOT-098 E07 recheck: full ordered ApprovalResolved sequence)', () => {
  const id = (c: string): string => c.repeat(64);
  const expected = [
    { actionId: id('a'), approved: true },
    { actionId: id('b'), approved: false },
    { actionId: id('c'), approved: false },
    { actionId: id('d'), approved: false },
    { actionId: id('f'), approved: false },
    { actionId: id('e'), approved: false },
    { actionId: id('9'), approved: false },
  ];
  const copy = (): { actionId: string; approved: boolean }[] => expected.map((e) => ({ ...e }));

  it('the exact sequence passes', () => {
    expect(replySequenceMismatch(expected, copy())).toBeNull();
  });

  it('a wrong approved value on the last (bound) reply fails at #7', () => {
    const got = copy();
    got[6] = { actionId: id('9'), approved: true };
    expect(replySequenceMismatch(expected, got)).toMatch(/^ApprovalResolved sequence differs at #7: expected 9x64\/false, got 9x64\/true/);
  });

  it('a wrong actionId with approved:true on the bound reply fails (E07 R3)', () => {
    const got = copy();
    got[6] = { actionId: id('7'), approved: true };
    expect(replySequenceMismatch(expected, got)).toMatch(/differs at #7: expected 9x64\/false, got 7x64\/true/);
  });

  it('a wrong actionId with the right value fails', () => {
    const got = copy();
    got[4] = { actionId: id('e'), approved: false };
    expect(replySequenceMismatch(expected, got)).toMatch(/differs at #5: expected fx64\/false, got ex64\/false/);
  });

  it('a late duplicate after the last click fails (E07 R2)', () => {
    const got = [...copy(), { actionId: id('9'), approved: false }];
    expect(replySequenceMismatch(expected, got)).toMatch(/differs at #8: expected \(none\), got 9x64\/false \(expected 7 replies, got 8/);
  });

  it('a missing reply and a reordered pair both fail', () => {
    expect(replySequenceMismatch(expected, copy().slice(0, 6))).toMatch(/differs at #7: expected 9x64\/false, got \(none\)/);
    const [a, b, c, ...rest] = copy();
    const swapped = [a, c, b, ...rest].filter((e) => e !== undefined);
    expect(replySequenceMismatch(expected, swapped)).toMatch(/differs at #2: expected bx64\/false, got cx64\/false/);
  });

  it('an empty run fails, and short ids print as <char>x64 only for 64-char repeats', () => {
    expect(replySequenceMismatch(expected, [])).toMatch(/differs at #1: expected ax64\/true, got \(none\)/);
    expect(shortActionId(id('a'))).toBe('ax64');
    expect(shortActionId('a'.repeat(63) + 'b')).toBe('a'.repeat(63) + 'b');
  });
});

describe('DOT-099 blame: late and stray replies go to the step that produced them', () => {
  const id = (c: string): string => c.repeat(64);
  const expected = [
    { actionId: id('a'), approved: true, step: 'repeat.approveDoubleClick' },
    { actionId: id('b'), approved: false, step: 'readWithRepeat.request' },
    { actionId: id('c'), approved: false, step: 'readDisplayMismatch.request' },
    { actionId: id('d'), approved: false, step: 'timer.decline' },
    { actionId: id('f'), approved: false, step: 'codex.decline' },
    { actionId: id('e'), approved: false, step: 'joinMismatch.request' },
    { actionId: id('9'), approved: false, step: 'bound.decline' },
  ];
  const entries = (...cs: [string, boolean][]): { actionId: string; approved: boolean }[] => cs.map(([c, approved]) => ({ actionId: id(c), approved }));
  const full = (): { actionId: string; approved: boolean }[] => expected.map(({ actionId, approved }) => ({ actionId, approved }));

  it('ownerStep maps an action to its step, unknown actions to undefined', () => {
    expect(ownerStep(expected, id('d'))).toBe('timer.decline');
    expect(ownerStep(expected, id('8'))).toBeUndefined();
  });

  it('F2: the click own single reply passes', () => {
    expect(clickRepliesBlame('codex.decline', id('f'), entries(['f', false]), expected)).toBeNull();
  });

  it('F2: a late duplicate of d landing in codex.decline is blamed after:timer.decline, not codex.decline (E07 G3a)', () => {
    for (const added of [entries(['f', false], ['d', false]), entries(['d', false], ['f', false])]) {
      const b = clickRepliesBlame('codex.decline', id('f'), added, expected);
      expect(b?.step).toBe('after:timer.decline');
      expect(b?.detail).toMatch(/stray ApprovalResolved dx64\/false \(from timer\.decline\) arrived during codex\.decline/);
    }
  });

  it('F2: a duplicate of the click own reply is still blamed on that click', () => {
    const b = clickRepliesBlame('bound.decline', id('9'), entries(['9', false], ['9', false]), expected);
    expect(b).toEqual({ step: 'bound.decline', detail: 'expected exactly one ApprovalResolved, for 9x64; got 2: 9x64/false, 9x64/false' });
  });

  it('F2: no reply, or a reply for an unknown action, is blamed on the click itself', () => {
    expect(clickRepliesBlame('bound.decline', id('9'), [], expected)?.step).toBe('bound.decline');
    expect(clickRepliesBlame('bound.decline', id('9'), entries(['7', true]), expected)).toEqual({ step: 'bound.decline', detail: 'expected exactly one ApprovalResolved, for 9x64; got 1: 7x64/true' });
  });

  it('F1: the settled re-check passes the exact sequence', () => {
    expect(replySequenceBlame('final.replySequenceSettled', expected, full())).toBeNull();
  });

  it('F1: a late duplicate of the last reply (9) is caught by the settled re-check and blamed after:bound.decline (E07 G3c)', () => {
    const b = replySequenceBlame('final.replySequenceSettled', expected, [...full(), { actionId: id('9'), approved: false }]);
    expect(b?.step).toBe('after:bound.decline');
    expect(b?.detail).toMatch(/^late ApprovalResolved 9x64\/false from bound\.decline, seen at final\.replySequenceSettled: ApprovalResolved sequence differs at #8/);
  });

  it('F2: a late duplicate of f before e is blamed after:codex.decline (E07 G3d)', () => {
    const got = full();
    got.splice(5, 0, { actionId: id('f'), approved: false });
    expect(replySequenceBlame('final.replySequence', expected, got)?.step).toBe('after:codex.decline');
  });

  it('a wrong value or id at an expected position, a missing reply, or an unknown extra is blamed on the check', () => {
    const wrongValue = full();
    wrongValue[6] = { actionId: id('9'), approved: true };
    expect(replySequenceBlame('final.replySequence', expected, wrongValue)?.step).toBe('final.replySequence');
    const wrongId = full();
    wrongId[6] = { actionId: id('7'), approved: false };
    expect(replySequenceBlame('final.replySequence', expected, wrongId)?.step).toBe('final.replySequence');
    expect(replySequenceBlame('final.replySequence', expected, full().slice(0, 6))?.step).toBe('final.replySequence');
    expect(replySequenceBlame('final.replySequenceSettled', expected, [...full(), { actionId: id('8'), approved: false }])?.step).toBe('final.replySequenceSettled');
  });
});

