import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { Plugin } from 'vite';

const INCLUDE = /^\s*#include\s+"([^"]+)"\s*$/;

/**
 * Inline every `#include "file.wgsl"` line, resolved relative to the file that
 * includes it. Each file appears once, where it is first included, so shared
 * modules (the scene bindings, the traversal) can be included by anything
 * without being declared twice.
 */
export function composeWgsl(file: string, read: (path: string) => string): string {
  const seen = new Set<string>([posix.normalize(file)]);
  const compose = (path: string, text: string): string[] => {
    const out: string[] = [];
    text.split('\n').forEach((line, i) => {
      const m = INCLUDE.exec(line);
      if (!m) {
        out.push(line);
        return;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), m[1]));
      if (seen.has(target)) return;
      seen.add(target);
      let body: string;
      try {
        body = read(target);
      } catch {
        throw new Error(`${path}:${i + 1}: cannot include "${m[1]}"`);
      }
      out.push(...compose(target, body));
    });
    return out;
  };
  return compose(posix.normalize(file), read(file)).join('\n');
}

/** `.wgsl` imports become their composed source as a string. */
export function wgslPlugin(): Plugin {
  return {
    name: 'trenchline-wgsl',
    enforce: 'pre',
    load(id: string) {
      if (!id.endsWith('.wgsl')) return null;
      const files: string[] = [];
      const code = composeWgsl(id, (path) => {
        files.push(path);
        return readFileSync(path, 'utf8');
      });
      for (const f of files) this.addWatchFile(f);
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}
