import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

export default defineConfig({
  plugins: [
    react(),
    {
      // Stamps the service worker with a build id so every deploy gets a fresh cache namespace.
      name: 'cozy-sw-version',
      apply: 'build',
      generateBundle(_, bundle) {
        const assets = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
        this.emitFile({
          type: 'asset',
          fileName: 'precache-manifest.json',
          source: JSON.stringify({ version: buildId, assets }),
        });
      },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : id.includes('node_modules/react') ? 'react' : undefined) },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
