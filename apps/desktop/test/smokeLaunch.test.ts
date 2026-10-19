import { describe, expect, it } from 'vitest';
import { smokeLaunch } from '../src/main/smoke/launch';

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
