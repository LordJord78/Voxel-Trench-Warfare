import { defineConfig } from '@playwright/test';

// Shader and app tests in the installed Chrome. One worker: they share a GPU,
// and the perf runs must not compete with anything.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 180_000,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:5320',
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'] },
  },
  webServer: {
    command: 'npx vite --port 5320 --strictPort',
    url: 'http://localhost:5320',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
