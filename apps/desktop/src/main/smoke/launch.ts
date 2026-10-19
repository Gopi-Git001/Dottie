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

const SCREENSHOT_FLAG = '--dottie-smoke-screenshot';
const SCREENSHOT_KEEP_FLAG = '--dottie-smoke-screenshot-keep';

/**
 * Screenshot is opt-in. `--dottie-smoke-ui` only opens the UI probe (CI always passes it)
 * and does not call capturePage. An explicit `--dottie-smoke-screenshot` does.
 * A path in the environment is never a destination.
 */
export function smokeScreenshotRequested(argv: readonly string[]): boolean {
  return argv.includes(SCREENSHOT_FLAG);
}

/** Keep the PNG. Otherwise the smoke deletes it at the end of the run. */
export function smokeScreenshotKeep(argv: readonly string[]): boolean {
  return argv.includes(SCREENSHOT_KEEP_FLAG);
}
