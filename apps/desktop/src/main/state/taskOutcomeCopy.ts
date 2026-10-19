/**
 * User-facing copy for every TaskFinished outcome/reason pair (E03 coordinator README, CONTRACTS §3).
 * Pure and table-tested. Rules:
 *  - `declined` + `approval_unavailable` is NOT a user decision: it never says "declined" or
 *    "you declined" (ADR-0009 CR1; E03 README).
 *  - `blocked_unavailable` never mentions signing in; `account_unsupported` never says "reconnect".
 */
import { own } from '../../shared/own';
import type { TaskFinishedReason, TaskOutcome } from '../../shared/contracts.draft';

export type CopyLevel = 'info' | 'warning';
export interface OutcomeCopy {
  level: CopyLevel;
  /** Activity message, or null when the outcome is tooltip-only (never logged, never spoken). */
  activity: string | null;
}

/** Short reason detail, used in parentheses (activity) and in the tooltip. */
export const REASON_DETAIL: Record<TaskFinishedReason, string> = {
  auth_required: 'ChatGPT sign-in expired',
  sign_in_in_progress: 'sign-in was in progress',
  account_unsupported: "this ChatGPT account can't run Codex",
  codex_unavailable: 'Codex became unavailable',
  clarification_timeout: 'no answer to a question',
  clarification_cancelled: 'question cancelled',
  approval_unavailable: "couldn't ask for approval safely",
  retry_not_allowed: "couldn't retry that task",
};

export const APPROVAL_UNAVAILABLE_COPY = "Couldn't ask for approval safely, so nothing was done.";
export const FAILED_AFTER_CHANGES_APPROVAL_UNAVAILABLE_COPY = "Some changes were made, then I couldn't ask for approval safely, so I stopped.";

/** ` (detail)` for a known reason, else '' (never an inherited value). */
function reasonDetail(reason: string | undefined): string {
  const d = reason === undefined ? undefined : own(REASON_DETAIL, reason);
  return d === undefined ? '' : ` (${d})`;
}

/** Copy for an outcome that is not in TASK_OUTCOMES (unreachable after TaskFinishedSchema; fail calm, no throw). */
const UNKNOWN_OUTCOME_COPY: OutcomeCopy = { level: 'warning', activity: 'The task ended, but Dottie could not tell how.' };

export function taskFinishedCopy(outcome: TaskOutcome, reason?: TaskFinishedReason): OutcomeCopy {
  switch (outcome) {
    case 'succeeded':
      return { level: 'info', activity: 'Done, and Dottie checked the result.' };
    case 'answered':
      return { level: 'info', activity: 'Answered.' };
    case 'partial':
      return { level: 'warning', activity: 'Partly done: the main goal happened, but not everything could be confirmed.' };
    case 'unverified':
      return { level: 'warning', activity: "Codex says it finished, but Dottie couldn't confirm the result." };
    case 'failed':
      if (reason === 'clarification_timeout') return { level: 'warning', activity: "Stopped: Dottie asked a question and got no answer in time, so nothing was changed." };
      // Tooltip only (E01): no activity entry, nothing spoken. CONTRACTS has no activity-log rule
      // for it, and activity can be read aloud later, so it stays out of the log.
      if (reason === 'retry_not_allowed') return { level: 'info', activity: null };
      if (reason === 'clarification_cancelled') return { level: 'warning', activity: "Stopped: Dottie's question was cancelled before you answered, so nothing was changed." };
      return { level: 'warning', activity: 'The task failed; nothing was changed.' };
    case 'failed_after_side_effects':
      // E01 ruling 8: kept as a valid pair with its own copy (never "declined").
      if (reason === 'approval_unavailable') return { level: 'warning', activity: FAILED_AFTER_CHANGES_APPROVAL_UNAVAILABLE_COPY };
      return { level: 'warning', activity: `The task failed after making changes${reasonDetail(reason)}. Check what changed.` };
    case 'declined':
      if (reason === 'approval_unavailable') return { level: 'warning', activity: APPROVAL_UNAVAILABLE_COPY };
      return { level: 'info', activity: 'You declined, so nothing was done.' };
    case 'blocked_auth':
      if (reason === 'account_unsupported') return { level: 'warning', activity: "This ChatGPT account can't run Codex. Sign out or switch account." };
      if (reason === 'sign_in_in_progress') return { level: 'info', activity: 'Finish signing in in your browser, then try again.' };
      return { level: 'warning', activity: 'Reconnect ChatGPT to run tasks.' };
    case 'blocked_unavailable':
      return { level: 'warning', activity: 'Codex is unavailable right now, so the task was not run. No sign-in is needed.' };
  }
  return UNKNOWN_OUTCOME_COPY;
}

/** Tooltip detail for LastTaskNote (non-executing states). Never "declined". */
export const LAST_TASK_NOTE_TOOLTIP: Record<'approval_unavailable' | 'clarification_timeout' | 'clarification_cancelled' | 'retry_not_allowed', string> = {
  retry_not_allowed: "Couldn't retry that task",
  approval_unavailable: "last task not started: couldn't ask for approval safely",
  clarification_timeout: 'last task stopped: no answer to a question',
  clarification_cancelled: 'last task stopped: question cancelled',
};
