import { defineConfig } from 'vitest/config';
import { tomlPlugin } from './tools/vite-plugin-toml';
import { wgslPlugin } from './tools/vite-plugin-wgsl';

export default defineConfig({
  plugins: [tomlPlugin(), wgslPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
