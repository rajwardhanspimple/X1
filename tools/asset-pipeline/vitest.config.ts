import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'asset-pipeline', include: ['src/**/*.test.ts'], environment: 'node' },
});
