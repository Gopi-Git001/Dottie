/** Pure first-run wizard model (spec §13.2). Shared by main (persistence) and renderer (UI). */
import { ONBOARDING_STEPS, type OnboardingStep } from './settings';

export const STEP_TITLES: Readonly<Record<OnboardingStep, string>> = {
  privacy: 'Privacy',
  mic: 'Microphone test',
  signin: 'Sign in with ChatGPT',
  grants: 'Folders & capabilities',
  wake: 'Wake-word test',
  autostart: 'Start at sign-in',
};

/** Steps that must be completed (not skipped) before onboarding can finish. */
export const REQUIRED_STEPS: readonly OnboardingStep[] = ['privacy'];

export function nextStep(completed: readonly OnboardingStep[]): OnboardingStep | null {
  return ONBOARDING_STEPS.find((s) => !completed.includes(s)) ?? null;
}

/** Steps must be completed in order; a step can be marked complete only once its predecessors are. */
export function canCompleteStep(step: OnboardingStep, completed: readonly OnboardingStep[]): boolean {
  const idx = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS.slice(0, idx).every((s) => completed.includes(s));
}

export function addCompletedStep(step: OnboardingStep, completed: readonly OnboardingStep[]): OnboardingStep[] {
  if (!canCompleteStep(step, completed)) {
    throw new Error(`Onboarding step "${step}" cannot be completed before earlier steps`);
  }
  const set = new Set<OnboardingStep>([...completed, step]);
  return ONBOARDING_STEPS.filter((s) => set.has(s));
}

export function isOnboardingComplete(completed: readonly OnboardingStep[]): boolean {
  return ONBOARDING_STEPS.every((s) => completed.includes(s)) && REQUIRED_STEPS.every((s) => completed.includes(s));
}
