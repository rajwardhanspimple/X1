import { expect, test, type Page } from '@playwright/test';

type CapturedInit = {
  mapId: string | undefined;
  contentHash: string | undefined;
  halfSize: number;
};

declare global {
  interface Window {
    __rearenaWorkerInits?: CapturedInit[];
    rearena?: { state?: () => Record<string, unknown> };
  }
}

const MAPS = [
  { id: 'military-outpost', hash: 'military-outpost-01', halfSize: 56 },
  { id: 'urban-street', hash: 'urban-street-01', halfSize: 64 },
  { id: 'container-yard', hash: 'container-yard-01', halfSize: 32 },
];

async function ready(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/RE:Arena/i);
  await expect(page.locator('.screen-menu')).toHaveAttribute('data-visible', 'true');
}

test('selects, starts and switches all maps, then restores selection after reload', async ({
  page,
}, testInfo) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (testInfo.project.name === 'mobile-android') {
    await page.setViewportSize({ width: 915, height: 600 });
  }
  // Tests must not create accounts, upload runs or write to the production backend.
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (/supabase\.co|\/(auth|rest|storage|functions|realtime)\/v1\//i.test(url)) {
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'rearena.quality.v1',
      JSON.stringify({
        tier: 'low',
        manual: true,
        dynamicResolution: false,
        frameRateCap: 30,
        lowPowerMode: false,
        showFrameStats: false,
      }),
    );
    localStorage.removeItem('rearena.auth.v1');
    window.__rearenaWorkerInits = [];
    const NativeWorker = window.Worker;
    class WorkerSpy extends NativeWorker {
      override postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ): void {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'init') {
          const init = message as {
            config?: { mapId?: string; contentHash?: string };
            content?: { bounds?: { maxX: number } };
          };
          window.__rearenaWorkerInits?.push({
            mapId: init.config?.mapId,
            contentHash: init.config?.contentHash,
            halfSize: (init.content?.bounds?.maxX ?? 0) / 65536,
          });
        }
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    }
    window.Worker = WorkerSpy;
  });

  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Choose arena', exact: true }).click();
  const setup = page.locator('.screen-setup');
  for (const [index, map] of MAPS.entries()) {
    await expect(setup).toHaveAttribute('data-visible', 'true');
    const option = setup.locator(`[data-action="selectMap"][data-value="${map.id}"]`);
    await option.click();
    await expect(option).toHaveAttribute('data-selected', 'true');
    await setup.getByRole('button', { name: 'Start round', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__rearenaWorkerInits?.length ?? 0))
      .toBe(index + 1);
    expect(await page.evaluate(() => window.__rearenaWorkerInits?.at(-1))).toEqual({
      mapId: map.id,
      contentHash: map.hash,
      halfSize: map.halfSize,
    });
    await expect(page.locator('.screen-countdown')).toHaveAttribute('data-visible', 'true');
    await expect(page.locator('.screen-countdown')).toHaveAttribute('data-visible', 'false', {
      timeout: 20000,
    });
    const state = await page.evaluate(() => window.rearena?.state?.());
    expect(state?.running).toBe(true);
    expect(state?.tainted).toBe(false);
    expect(Number(state?.tick)).toBeGreaterThan(0);

    if (testInfo.project.name === 'mobile-android') {
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
    } else {
      await page.keyboard.press('Escape');
    }
    const pause = page.locator('.screen-pause');
    await expect(pause).toHaveAttribute('data-visible', 'true');
    await pause.getByRole('button', { name: 'Quit to setup', exact: true }).click();
  }

  await setup.locator('[data-action="selectMap"][data-value="urban-street"]').click();
  await page.reload();
  await ready(page);
  await page.getByRole('button', { name: 'Choose arena', exact: true }).click();
  await expect(
    setup.locator('[data-action="selectMap"][data-value="urban-street"]'),
  ).toHaveAttribute('data-selected', 'true');
  expect(errors).toEqual([]);
});
