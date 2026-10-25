/**
 * The production build as a static host serves it: built through Vite with the project's config into
 * `outDir` (under the git-ignored artifacts/), and served by Vite's preview server on `port` under
 * `base`, a sub-path, as GitHub Pages serves a project.
 */
import { build, preview } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

export async function servedBuild(base: string, port: number, outDir = 'artifacts/s1/site'): Promise<{ url: string; outDir: string; close(): Promise<void> }> {
  await build({ logLevel: 'error', build: { outDir, emptyOutDir: true } });
  const server = await preview({ logLevel: 'error', base, build: { outDir }, preview: { port, strictPort: true } });
  return { url: `http://localhost:${port}${base}`, outDir, close: () => server.close() };
}
