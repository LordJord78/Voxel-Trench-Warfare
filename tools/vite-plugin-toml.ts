import { parse } from 'smol-toml';
import type { Plugin } from 'vite';

/**
 * Compiles `*.toml` imports to JSON modules at build time, so the game ships no
 * TOML parser and a typo in tunables.toml fails the build with its file and
 * line rather than failing in a visitor's browser.
 */
export function tomlPlugin(): Plugin {
  return {
    name: 'trenchline-toml',
    transform(code: string, id: string) {
      if (!id.endsWith('.toml')) return null;
      let data: unknown;
      try {
        data = parse(code);
      } catch (error) {
        throw new Error(`${id}: ${(error as Error).message}`);
      }
      return { code: `export default ${JSON.stringify(data)};`, map: null };
    },
  };
}
