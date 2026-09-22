import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const monorepoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: {
      // Workspace packages are pnpm symlinks outside this app directory.
      allow: [monorepoRoot],
    },
  },
  preview: { host: '127.0.0.1', port: 5173 },
  optimizeDeps: {
    /*
     * These workspace packages export raw TypeScript from src/. Dependency pre-bundling treats
     * anything resolved through node_modules as a prebuilt dependency and does not transpile it,
     * which breaks the import inside the simulation worker. Excluding them keeps Vite's normal
     * source transform in play.
     */
    exclude: ['@rearena/sim', '@rearena/protocol', '@rearena/content-schema', '@rearena/ui'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // Babylon is large; its own chunk stays cached across releases while game code changes.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@babylonjs')) return 'babylon';
          return undefined;
        },
      },
    },
  },
});
