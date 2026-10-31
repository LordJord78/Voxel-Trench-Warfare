import { defineConfig } from 'vite';
import { reportPlugin } from './tools/vite-plugin-report';
import { sitePlugin } from './tools/vite-plugin-site';
import { tomlPlugin } from './tools/vite-plugin-toml';
import { wgslPlugin } from './tools/vite-plugin-wgsl';

export default defineConfig({
  // Relative URLs throughout the build, so a static host serves it from any path (GitHub Pages
  // serves a project under its name); the dev server is unaffected.
  base: './',
  // The report endpoint exists only in the dev server, for the browser checks (npm run safari).
  // The site's address, where the page needs it whole (VITE_SITE_URL, from the Pages workflow).
  plugins: [tomlPlugin(), wgslPlugin(), reportPlugin(), sitePlugin()],
  // The build players must share to play together (net/room-core.ts refuses another): the commit
  // the Pages workflow built, or 'dev'.
  define: { __TRENCHLINE_BUILD__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 12) ?? 'dev') },
  // Workers are bundled separately and need the same plugins: generation
  // workers read tunables too.
  worker: { format: 'es', plugins: () => [tomlPlugin(), wgslPlugin()] },
  build: { target: 'es2022' },
});
