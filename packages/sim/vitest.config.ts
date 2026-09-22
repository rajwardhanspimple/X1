import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sim',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
