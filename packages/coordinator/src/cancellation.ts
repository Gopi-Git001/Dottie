/**
 * Side-effect ledger and honest cancellation reporting (spec §4 speaking policy, §9.11, §14 "Stop/cancel").
 * A cancel is never reported as clean when an external action already happened or may have happened.
 */
import type { CommittedAction, SideEffectSummary, StopStatus, ToolResult } from './contracts.js';
import type { CancelAck, ToolStart } from './ports.js';

export class SideEffectLedger {
  private readonly inFlight = new Map<string, number>();
  private readonly actions: CommittedAction[] = [];

  started(start: ToolStart): void {
    if (!start.mayHaveSideEffects) return;
    this.inFlight.set(start.toolId, (this.inFlight.get(start.toolId) ?? 0) + 1);
  }

  result(result: ToolResult): void {
    const n = this.inFlight.get(result.toolId) ?? 0;
    if (n <= 1) this.inFlight.delete(result.toolId);
    else this.inFlight.set(result.toolId, n - 1);
    if (result.sideEffect === 'committed') this.actions.push({ toolId: result.toolId, observedState: result.observedState, certainty: 'committed' });
    else if (result.sideEffect === 'unknown') this.actions.push({ toolId: result.toolId, observedState: result.observedState, certainty: 'possible' });
  }

  /** Side-effecting tools that started and have not reported a result (their TaskCancelled entry is observedState null). */
  get toolsInFlight(): boolean {
    return this.inFlight.size > 0;
  }

  /** committed > possible > none. In-flight side-effecting tools count as possible. */
  summary(): SideEffectSummary {
    if (this.actions.some(a => a.certainty === 'committed')) return 'committed';
    if (this.actions.length > 0 || this.inFlight.size > 0) return 'possible';
    return 'none';
  }

  snapshot(): CommittedAction[] {
    const pending: CommittedAction[] = [...this.inFlight.keys()].map(toolId => ({
      toolId,
      observedState: null,
      certainty: 'possible',
    }));
    return [...this.actions.map(a => ({ ...a })), ...pending];
  }
}

export interface StopInputs {
  readonly dispatched: boolean;
  /** undefined => the adapter did not answer within the cancel timeout. */
  readonly ack: CancelAck | undefined;
  readonly completedBeforeStop: boolean;
  readonly sideEffects: SideEffectSummary;
  /** E01 2j: a side-effecting tool started and never reported (its committedActions entry is observedState null). */
  readonly toolsInFlight: boolean;
}

export function decideStopStatus(i: StopInputs): StopStatus {
  if (!i.dispatched) return 'stopped_before_dispatch';
  // E01 2j: a run that completed while a side-effecting tool never reported did not complete that tool as far as we
  // know; its entry is observedState null, so the stop can't be called completed_before_stop: it is unconfirmed.
  if (i.completedBeforeStop) return i.toolsInFlight ? 'stop_unconfirmed' : 'completed_before_stop';
  if (!i.ack || !i.ack.stopped) return 'stop_unconfirmed';
  if (i.sideEffects !== 'none') return 'stopped_after_side_effects';
  return 'stopped_no_side_effects';
}

/** True only for stops that changed nothing outside Dottie. */
export function isCleanStop(status: StopStatus, sideEffects: SideEffectSummary): boolean {
  return (status === 'stopped_before_dispatch' || status === 'stopped_no_side_effects') && sideEffects === 'none';
}

function describe(actions: readonly CommittedAction[], certainty: CommittedAction['certainty']): string {
  return actions
    .filter(a => a.certainty === certainty)
    .map(a => (a.observedState === null ? `${a.toolId} (still running when the stop was requested; its result is unknown)` : a.toolId))
    .join('; ');
}

function effectsSentence(sideEffects: SideEffectSummary, actions: readonly CommittedAction[]): string {
  const committed = describe(actions, 'committed');
  const possible = describe(actions, 'possible');
  const parts: string[] = [];
  if (committed) parts.push(`These steps had already happened: ${committed}.`);
  if (possible) parts.push(`I can't confirm whether these took effect: ${possible}.`);
  if (sideEffects !== 'none') parts.push(`I have not undone anything, so please check.`);
  return parts.join(' ');
}

/** User-facing report text. Never claims "cancelled cleanly" or "undone" when side effects exist. */
export function cancelReport(status: StopStatus, sideEffects: SideEffectSummary, actions: readonly CommittedAction[]): string {
  const effects = effectsSentence(sideEffects, actions);
  // Defence in depth: a "clean" status can never be spoken when the ledger shows side effects.
  const honest: StopStatus = sideEffects !== 'none' && (status === 'stopped_before_dispatch' || status === 'stopped_no_side_effects') ? 'stopped_after_side_effects' : status;
  switch (honest) {
    case 'stopped_before_dispatch':
      return "Okay, I didn't start that task.";
    case 'stopped_no_side_effects':
      return 'I stopped the task before it changed anything.';
    case 'stopped_after_side_effects':
      return `I stopped the task, but it was not a clean stop. ${effects}`;
    case 'stop_unconfirmed':
      return `I asked the task to stop, but I couldn't confirm that it stopped. ${effects || 'No changes had been reported when I asked.'}`.trim();
    case 'completed_before_stop':
      return `The task had already finished before I could stop it. ${effects}`.trim();
  }
}
