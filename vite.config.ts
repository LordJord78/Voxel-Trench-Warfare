import { defineConfig } from 'vite';
import { tomlPlugin } from './tools/vite-plugin-toml';

export default defineConfig({
  plugins: [tomlPlugin()],
  // Workers are bundled separately and need the same plugins: generation
  // workers read tunables too.
  worker: { format: 'es', plugins: () => [tomlPlugin()] },
  build: { target: 'es2022' },
});
