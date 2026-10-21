import { defineConfig } from 'vite';
import { tomlPlugin } from './tools/vite-plugin-toml';
import { wgslPlugin } from './tools/vite-plugin-wgsl';

export default defineConfig({
  plugins: [tomlPlugin(), wgslPlugin()],
  // Workers are bundled separately and need the same plugins: generation
  // workers read tunables too.
  worker: { format: 'es', plugins: () => [tomlPlugin(), wgslPlugin()] },
  build: { target: 'es2022' },
});
