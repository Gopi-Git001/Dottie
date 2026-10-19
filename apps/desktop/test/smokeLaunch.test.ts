import { describe, expect, it } from 'vitest';
import { smokeLaunch, smokeScreenshotRequested, smokeShouldCapture } from '../src/main/smoke/launch';

const FLAG = '--dottie-smoke-test';

describe('smoke launch gate', () => {
  it('stays off when the build stripped smoke, even if the flag and a dev app are present', () => {
    expect(smokeLaunch(false, false, [FLAG, '--dottie-smoke-ui'])).toBe('off');
    expect(smokeLaunch(false, true, [FLAG])).toBe('off');
  });

  it('stays off when the flag is absent', () => {
    expect(smokeLaunch(true, false, ['--dottie-smoke-ui'])).toBe('off');
  });

  it('refuses a packaged app that was passed the flag', () => {
    expect(smokeLaunch(true, true, [FLAG])).toBe('ignore');
  });

  it('enters only for an unpackaged build that still contains smoke', () => {
    expect(smokeLaunch(true, false, [FLAG])).toBe('enter');
  });
});

describe('smoke screenshot', () => {
  it('treats the flag or env 1 as a request, and a path as not a destination', () => {
    expect(smokeScreenshotRequested(['--dottie-smoke-screenshot'], undefined)).toBe(true);
    expect(smokeScreenshotRequested([], '1')).toBe(true);
    expect(smokeScreenshotRequested([], undefined)).toBe(false);
    expect(smokeScreenshotRequested([], '/tmp/anywhere.png')).toBe(false);
  });

  it('skips only the CI default, and still captures when a screenshot was requested', () => {
    expect(smokeShouldCapture(true, false)).toBe(false);
    expect(smokeShouldCapture(true, true)).toBe(true);
    expect(smokeShouldCapture(false, false)).toBe(true);
    expect(smokeShouldCapture(false, true)).toBe(true);
  });
});
