import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * E2E_BASE_URL points the suite at an already-running server, which is how CI tests a deployed
 * preview. Without it, Playwright starts the dev server itself.
 */
const reuseExternalServer = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
  ],
  /*
   * Spread conditionally rather than assigning undefined. Playwright types this as
   * `TestConfigWebServer | TestConfigWebServer[]` with no undefined in the union, so `webServer:
   * cond ? undefined : {...}` does not type-check even though Playwright treats the absent key as
   * "do not start a server". An omitted property is allowed where an explicit undefined is not.
   */
  ...(reuseExternalServer
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter @rearena/client dev --host 127.0.0.1 --port 5173',
          url: 'http://127.0.0.1:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
