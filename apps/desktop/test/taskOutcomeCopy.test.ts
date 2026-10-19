import { describe, expect, it } from 'vitest';
import { SHARED_TASK_REASONS, TASK_FINISHED_REASON_RULES, TASK_FINISHED_REASONS, TASK_OUTCOMES, TaskFinishedSchema, type TaskFinishedReason, type TaskOutcome } from '../src/shared/contracts.draft';
import { APPROVAL_UNAVAILABLE_COPY, LAST_TASK_NOTE_TOOLTIP, REASON_DETAIL, taskFinishedCopy } from '../src/main/state/taskOutcomeCopy';
import { deriveTrayView } from '../src/main/state/trayModel';
import { snap } from './helpers';

/**
 * Every outcome/reason pair from the E03 coordinator README (feature/E03-DOT-061-auth-gate @ a18eae2,
 * "TaskFinished" row) and CONTRACTS §3 / §2.1. `undefined` = no reason.
 */
const E03_PAIRS: [TaskOutcome, TaskFinishedReason | undefined, 'info' | 'warning', string | null][] = [
  ['succeeded', undefined, 'info', 'Done, and Dottie checked the result.'],
  ['answered', undefined, 'info', 'Answered.'],
  ['partial', undefined, 'warning', 'Partly done: the main goal happened, but not everything could be confirmed.'],
  ['unverified', undefined, 'warning', "Codex says it finished, but Dottie couldn't confirm the result."],
  ['failed', undefined, 'warning', 'The task failed; nothing was changed.'],
  ['failed', 'clarification_timeout', 'warning', 'Stopped: Dottie asked a question and got no answer in time, so nothing was changed.'],
  ['failed', 'clarification_cancelled', 'warning', "Stopped: Dottie's question was cancelled before you answered, so nothing was changed."],
  ['failed', 'retry_not_allowed', 'info', null], // tooltip only (E01 correction to ruling 4)
  ['declined', undefined, 'info', 'You declined, so nothing was done.'],
  ['declined', 'approval_unavailable', 'warning', "Couldn't ask for approval safely, so nothing was done."],
  ['blocked_auth', 'auth_required', 'warning', 'Reconnect ChatGPT to run tasks.'],
  ['blocked_auth', 'sign_in_in_progress', 'info', 'Finish signing in in your browser, then try again.'],
  ['blocked_auth', 'account_unsupported', 'warning', "This ChatGPT account can't run Codex. Sign out or switch account."],
  ['blocked_unavailable', 'codex_unavailable', 'warning', 'Codex is unavailable right now, so the task was not run. No sign-in is needed.'],
  ['failed_after_side_effects', undefined, 'warning', 'The task failed after making changes. Check what changed.'],
  ['failed_after_side_effects', 'auth_required', 'warning', 'The task failed after making changes (ChatGPT sign-in expired). Check what changed.'],
  ['failed_after_side_effects', 'sign_in_in_progress', 'warning', 'The task failed after making changes (sign-in was in progress). Check what changed.'],
  ['failed_after_side_effects', 'account_unsupported', 'warning', "The task failed after making changes (this ChatGPT account can't run Codex). Check what changed."],
  ['failed_after_side_effects', 'codex_unavailable', 'warning', 'The task failed after making changes (Codex became unavailable). Check what changed.'],
  ['failed_after_side_effects', 'clarification_timeout', 'warning', 'The task failed after making changes (no answer to a question). Check what changed.'],
  ['failed_after_side_effects', 'clarification_cancelled', 'warning', 'The task failed after making changes (question cancelled). Check what changed.'],
  ['failed_after_side_effects', 'approval_unavailable', 'warning', "Some changes were made, then I couldn't ask for approval safely, so I stopped."],
];

const parse = (outcome: TaskOutcome, reason?: TaskFinishedReason) =>
  TaskFinishedSchema.safeParse({ taskId: 't1', outcome, verified: outcome === 'succeeded', summary: 's', ...(reason ? { reason } : {}) }).success;

describe('TaskFinished copy — every E03 outcome/reason pair', () => {
  it.each(E03_PAIRS)('%s + %s -> %s "%s"', (outcome, reason, level, text) => {
    expect(parse(outcome, reason)).toBe(true);
    expect(taskFinishedCopy(outcome, reason)).toEqual({ level, activity: text });
  });

  it('the table is exactly the set of valid pairs (every other outcome × reason combination is rejected)', () => {
    const listed = new Set(E03_PAIRS.map(([o, r]) => `${o}/${r ?? '-'}`));
    for (const outcome of TASK_OUTCOMES) {
      for (const reason of [undefined, ...TASK_FINISHED_REASONS]) {
        expect(parse(outcome, reason), `${outcome}/${reason ?? '-'}`).toBe(listed.has(`${outcome}/${reason ?? '-'}`));
      }
    }
    expect(listed.size).toBe(E03_PAIRS.length);
    // and the rules table agrees with the README row
    expect(TASK_FINISHED_REASON_RULES.declined.reasons).toEqual(['approval_unavailable']);
    expect(TASK_FINISHED_REASON_RULES.failed.reasons).toEqual(['clarification_timeout', 'clarification_cancelled', 'retry_not_allowed']);
    expect(TASK_FINISHED_REASON_RULES.failed_after_side_effects.reasons).toEqual(SHARED_TASK_REASONS);
    expect(SHARED_TASK_REASONS).not.toContain('retry_not_allowed');
  });

  it('approval_unavailable NEVER says "declined" or "you declined" (activity, reason detail, tooltip)', () => {
    const texts = [
      APPROVAL_UNAVAILABLE_COPY,
      taskFinishedCopy('declined', 'approval_unavailable').activity,
      taskFinishedCopy('failed_after_side_effects', 'approval_unavailable').activity,
      REASON_DETAIL.approval_unavailable,
      LAST_TASK_NOTE_TOOLTIP.approval_unavailable,
      deriveTrayView(snap({ lastTaskNote: 'approval_unavailable' })).tooltip,
      deriveTrayView(snap({ failedAfterChanges: 'approval_unavailable' })).tooltip,
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/declined/i);
      expect(t).not.toMatch(/you declined/i);
    }
    expect(taskFinishedCopy('declined', 'approval_unavailable').activity).toBe("Couldn't ask for approval safely, so nothing was done.");
    expect(taskFinishedCopy('failed_after_side_effects', 'approval_unavailable').activity).toBe("Some changes were made, then I couldn't ask for approval safely, so I stopped.");
  });

  it('codex_unavailable copy never prompts sign-in; account_unsupported copy never says reconnect', () => {
    expect(taskFinishedCopy('blocked_unavailable', 'codex_unavailable').activity).not.toMatch(/sign in|sign-in(?! is needed)|reconnect/i);
    for (const o of ['blocked_auth', 'failed_after_side_effects'] as const) expect(taskFinishedCopy(o, 'account_unsupported').activity).not.toMatch(/reconnect/i);
  });

  it('clarification copy is distinct per reason and has tooltip detail', () => {
    expect(taskFinishedCopy('failed', 'clarification_timeout').activity).not.toBe(taskFinishedCopy('failed', 'clarification_cancelled').activity);
    expect(deriveTrayView(snap({ lastTaskNote: 'clarification_timeout' })).tooltip).toBe('Dottie — Standby · say "Dottie" · last task stopped: no answer to a question');
    expect(deriveTrayView(snap({ lastTaskNote: 'clarification_cancelled' })).tooltip).toBe('Dottie — Standby · say "Dottie" · last task stopped: question cancelled');
    expect(deriveTrayView(snap({ lastTaskNote: 'approval_unavailable' })).tooltip).toBe('Dottie — Standby · say "Dottie" · last task not started: couldn\'t ask for approval safely');
  });
});
