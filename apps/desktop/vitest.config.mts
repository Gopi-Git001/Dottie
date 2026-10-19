import { defineConfig } from 'vitest/config';

// Unit tests are pure: they never import 'electron' and never need the Electron binary.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
