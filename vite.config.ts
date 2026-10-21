import { defineConfig } from 'vite';
import { tomlPlugin } from './tools/vite-plugin-toml';

export default defineConfig({
  plugins: [tomlPlugin()],
  build: { target: 'es2022' },
});
