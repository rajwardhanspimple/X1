import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 5173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // Babylon is large; keeping it in its own chunk lets the CDN cache it across releases
    // while the game code changes.
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
