import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'content-schema', include: ['src/**/*.test.ts'], environment: 'node' },
});
