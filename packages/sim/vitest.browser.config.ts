import { defineConfig } from 'vitest/config';

/**
 * Chromium job of .github/workflows/determinism.yml.
 *
 * The same suite and the same snapshot files as the Node run. If V8-in-Chrome and V8-in-Node ever
 * disagree, or if a future engine does, the snapshots fail here and AC-ARM-007.2 is violated
 * before a player ever sees a wrongly rejected run.
 */
export default defineConfig({
  test: {
    name: 'sim-browser',
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
