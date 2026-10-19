/** Pure rules for the approval dialog's Approve button (unit-tested; DOM-free). */
import type { ApprovalView } from '../shared/approval';

/**
 * Approve is enabled only for an unexpired view, once main's gate says the window has been visible
 * and focused for APPROVE_ATTENTION_MS (`attentionReady`, from main's approvalGate push; main
 * enforces it again), and, with a warning, once main acknowledged the warning was shown and its
 * minimum visible time (WARNING_MIN_VISIBLE_MS) passed.
 */
export function approveEnabled(view: ApprovalView | null, warningAckedByMain: boolean, expiredLocally = false, attentionReady = false): boolean {
  if (!view || view.expired || expiredLocally || !attentionReady) return false;
  return view.warning === null || warningAckedByMain;
}

export interface VisibilityProbe {
  documentVisible: boolean;
  intersectionRatio: number;
  width: number;
  height: number;
  display: string;
  visibility: string;
  opacity: number;
}

/** The warning counts as visible only when fully on screen, laid out and not hidden. */
export function isWarningVisible(p: VisibilityProbe): boolean {
  return p.documentVisible && p.intersectionRatio >= 0.99 && p.width > 0 && p.height > 0 && p.display !== 'none' && p.visibility === 'visible' && p.opacity >= 0.99;
}
