/**
 * Whether this process may enter smoke mode.
 * `buildAllowsSmoke` is the build-time constant (`__DOTTIE_SMOKE__`). A production
 * bundle never calls this: the only call site sits inside `if (__DOTTIE_SMOKE__)`.
 * A packaged app never enters, even when the dev bundle is what got packaged.
 */
const SMOKE_FLAG = '--dottie-smoke-test';

export function smokeLaunch(buildAllowsSmoke: boolean, packaged: boolean, argv: readonly string[]): 'enter' | 'ignore' | 'off' {
  if (!buildAllowsSmoke) return 'off';
  if (!argv.includes(SMOKE_FLAG)) return 'off';
  if (packaged) return 'ignore';
  return 'enter';
}

let active = false;

/** Called only after smokeLaunch returned 'enter'. */
export function markSmokeActive(): void {
  active = true;
}

/** Smoke helpers throw unless this process actually entered smoke mode. */
export function assertSmokeMode(): void {
  if (!__DOTTIE_SMOKE__ || !active) throw new Error('smoke mode is not active');
}
