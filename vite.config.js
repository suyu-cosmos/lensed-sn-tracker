import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Build stamp shown in the page footer, so a viewer can tell which version
// they're on — GitHub Pages lets browsers cache the page for ~10 min after a
// deploy. CI (deploy.yml) provides GITHUB_SHA; locally fall back to git.
function commitId() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// Relative base so the built assets work whether the app is served from
// https://<org>.github.io/lensed-sn-tracker/ (project pages) or from a
// custom domain root — no repo name hard-coded here.
export default defineConfig({
  base: './',
  define: {
    __BUILD_COMMIT__: JSON.stringify(commitId()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
  },
});
