import { defineConfig } from 'vitest/config';
import { tomlPlugin } from './tools/vite-plugin-toml';
import { wgslPlugin } from './tools/vite-plugin-wgsl';

export default defineConfig({
  plugins: [tomlPlugin(), wgslPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The world-generation tests build whole map bands: a couple of seconds alone, past the default
    // 5 s when every file runs at once on a loaded machine.
    testTimeout: 20_000,
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
