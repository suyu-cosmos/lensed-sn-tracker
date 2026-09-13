import { defineConfig } from 'vite';

// Relative base so the built assets work whether the app is served from
// https://<org>.github.io/lensed-sn-tracker/ (project pages) or from a
// custom domain root — no repo name hard-coded here.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
  },
});
