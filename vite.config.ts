import { defineConfig } from 'vite';
import { reportPlugin } from './tools/vite-plugin-report';
import { tomlPlugin } from './tools/vite-plugin-toml';
import { wgslPlugin } from './tools/vite-plugin-wgsl';

export default defineConfig({
  // The report endpoint exists only in the dev server, for the browser checks (npm run safari).
  plugins: [tomlPlugin(), wgslPlugin(), reportPlugin()],
  // Workers are bundled separately and need the same plugins: generation
  // workers read tunables too.
  worker: { format: 'es', plugins: () => [tomlPlugin(), wgslPlugin()] },
  build: { target: 'es2022' },
});
