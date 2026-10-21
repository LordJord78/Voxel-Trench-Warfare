import { defineConfig } from 'vitest/config';
import { tomlPlugin } from './tools/vite-plugin-toml';

export default defineConfig({
  plugins: [tomlPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
