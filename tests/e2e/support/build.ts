/**
 * The production build as a static host serves it: built through Vite with the project's config into a
 * directory of its own outside the repository (whose files the e2e suite's dev server watches), and
 * served by Vite's preview server on `port` under `base`, a sub-path, as GitHub Pages serves a project.
 * Closing it stops the server and removes the build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

export async function servedBuild(base: string, port: number): Promise<{ url: string; outDir: string; close(): Promise<void> }> {
  const outDir = mkdtempSync(join(tmpdir(), 'trenchline-site-'));
  await build({ logLevel: 'error', build: { outDir, emptyOutDir: true } });
  const server = await preview({ logLevel: 'error', base, build: { outDir }, preview: { port, strictPort: true } });
  return {
    url: `http://localhost:${port}${base}`,
    outDir,
    close: async () => {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
