import { expect, test, type Page, type TestInfo } from '@playwright/test';

type CapturedWorkerInit = {
  mapId?: string;
  modeId?: string;
  contentHash?: string;
  bounds?: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  } | null;
};

declare global {
  interface Window {
    __rearenaWorkerInits?: CapturedWorkerInit[];
    rearena?: {
      state?: () => Record<string, unknown>;
    };
  }
}

const FIXED_ONE = 65_536;

const MAPS = [
  {
    id: 'military-outpost',
    name: 'Military Outpost',
    contentHash: 'military-outpost-01',
    bounds: {
      minX: -56 * FIXED_ONE,
      minY: 0,
      minZ: -56 * FIXED_ONE,
      maxX: 56 * FIXED_ONE,
      maxY: 32 * FIXED_ONE,
      maxZ: 56 * FIXED_ONE,
    },
  },
  {
    id: 'urban-street',
    name: 'Urban Street',
    contentHash: 'urban-street-01',
    bounds: {
      minX: -64 * FIXED_ONE,
      minY: 0,
      minZ: -64 * FIXED_ONE,
      maxX: 64 * FIXED_ONE,
      maxY: 48 * FIXED_ONE,
      maxZ: 64 * FIXED_ONE,
    },
  },
  {
    id: 'container-yard',
    name: 'Container Yard',
    contentHash: 'container-yard-01',
    bounds: {
      minX: -32 * FIXED_ONE,
      minY: 0,
      minZ: -32 * FIXED_ONE,
      maxX: 32 * FIXED_ONE,
      maxY: 32 * FIXED_ONE,
      maxZ: 32 * FIXED_ONE,
    },
  },
] as const;

function mapButton(page: Page, mapId: string) {
  return page.locator(`[data-action="selectMap"][data-value="${mapId}"]`);
}

function setupScreen(page: Page) {
  return page.locator('.screen-setup');
}

function countdownScreen(page: Page) {
  return page.locator('.screen-countdown');
}

function pauseScreen(page: Page) {
  return page.locator('.screen-pause');
}

async function preparePage(page: Page, testInfo: TestInfo) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  if (testInfo.project.name === 'mobile-android') {
    await page.setViewportSize({ width: 915, height: 412 });
  }

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (
      /supabase\.co/i.test(url) ||
      /\/(auth|rest|storage|functions|realtime)\/v1\//i.test(url)
    ) {
      await route.abort();
      return;
    }
    await route.continue();
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

    if (!localStorage.getItem('rearena.selection.v1')) {
      localStorage.setItem(
        'rearena.selection.v1',
        JSON.stringify({ mapId: 'container-yard', modeId: 'survival' }),
      );
    }

    localStorage.removeItem('rearena.auth.v1');

    window.__rearenaWorkerInits = [];

    const NativeWorker = window.Worker;
    class WorkerSpy extends NativeWorker {
      postMessage(message: unknown, transfer?: Transferable[]): void {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'init'
        ) {
          const init = message as {
            config?: { mapId?: string; modeId?: string; contentHash?: string };
            content?: {
              bounds?: {
                minX: number;
                minY: number;
                minZ: number;
                maxX: number;
                maxY: number;
                maxZ: number;
              };
            };
          };
          window.__rearenaWorkerInits ??= [];
          window.__rearenaWorkerInits.push({
            mapId: init.config?.mapId,
            modeId: init.config?.modeId,
            contentHash: init.config?.contentHash,
            bounds: init.content?.bounds
              ? {
                  minX: init.content.bounds.minX,
                  minY: init.content.bounds.minY,
                  minZ: init.content.bounds.minZ,
                  maxX: init.content.bounds.maxX,
                  maxY: init.content.bounds.maxY,
                  maxZ: init.content.bounds.maxZ,
                }
              : null,
          });
        }

        super.postMessage(message, transfer ?? []);
      }
    }

    window.Worker = WorkerSpy;
  });

  return { pageErrors };
}

async function waitForAppReady(page: Page, testInfo: TestInfo): Promise<void> {
  await expect(page).toHaveTitle(/RE:ARENA/);
  await page.waitForFunction(() => typeof window.rearena?.state === 'function');

  const quality = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('rearena.quality.v1') ?? 'null'),
  );
  expect(quality).toMatchObject({
    tier: 'low',
    manual: true,
    dynamicResolution: false,
    frameRateCap: 30,
  });

  if (testInfo.project.name === 'mobile-android') {
    await expect(page.getByText('Rotate your device to play')).toBeHidden();
  }
}

async function openSetup(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Choose arena' }).click();
  await expect(setupScreen(page)).toHaveAttribute('data-visible', 'true');
}

async function startRoundAndWaitForPlay(
  page: Page,
  expectedMap: (typeof MAPS)[number],
): Promise<void> {
  const initCountBefore = await page.evaluate(() => window.__rearenaWorkerInits?.length ?? 0);
  const readyLog = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[rearena] simulation ready'),
  });
  const countdownLog = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[rearena] loading -> countdown'),
  });
  const playingLog = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[rearena] countdown -> playing'),
  });

  await page.getByRole('button', { name: 'Start round' }).click();

  await countdownLog;
  await expect(countdownScreen(page)).toHaveAttribute('data-visible', 'true');
  await expect(page.locator('.countdown-number')).toBeVisible();

  await page.waitForFunction(
    (count) => (window.__rearenaWorkerInits?.length ?? 0) > count,
    initCountBefore,
  );
  const init = await page.evaluate(() => window.__rearenaWorkerInits?.at(-1) ?? null);
  expect(init).toMatchObject({
    mapId: expectedMap.id,
    modeId: 'survival',
    contentHash: expectedMap.contentHash,
    bounds: expectedMap.bounds,
  });

  await readyLog;
  await playingLog;
  await expect(countdownScreen(page)).toHaveAttribute('data-visible', 'false');

  const simState = await page.evaluate(() => window.rearena?.state?.() ?? null);
  expect(simState).not.toBeNull();
  expect(simState).toMatchObject({ running: true, tainted: false });
  expect(Number(simState?.tick ?? 0)).toBeGreaterThan(0);
  expect(Number(simState?.secondsRemaining ?? 0)).toBeGreaterThan(170);
}

async function pauseAndQuitToSetup(page: Page, testInfo: TestInfo): Promise<void> {
  const pausedLog = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[rearena] playing -> paused'),
  });

  if (testInfo.project.name === 'mobile-android') {
    await page.getByRole('button', { name: 'Pause' }).click();
  } else {
    await page.keyboard.press('Escape');
  }

  await pausedLog;
  await expect(pauseScreen(page)).toHaveAttribute('data-visible', 'true');
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeVisible();

  const setupLog = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[rearena] paused -> setup'),
  });
  await page.getByRole('button', { name: 'Quit to setup' }).click();
  await setupLog;
  await expect(setupScreen(page)).toHaveAttribute('data-visible', 'true');
}

test('built-in map selection persists across reload and starts each arena', async ({ page }, testInfo) => {
  test.slow();

  const { pageErrors } = await preparePage(page, testInfo);

  await page.goto('/');
  await waitForAppReady(page, testInfo);

  for (const map of MAPS) {
    await openSetup(page);
    await mapButton(page, map.id).click();
    await expect(mapButton(page, map.id)).toHaveAttribute('data-selected', 'true');

    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem('rearena.selection.v1') ?? '{}').mapId),
      )
      .toBe(map.id);

    await page.reload();
    await waitForAppReady(page, testInfo);
    await openSetup(page);
    await expect(mapButton(page, map.id)).toHaveAttribute('data-selected', 'true');

    await startRoundAndWaitForPlay(page, map);
    await pauseAndQuitToSetup(page, testInfo);
  }

  expect(pageErrors).toEqual([]);
});
