/**
 * The check's reports: in the dev server only, `POST /__report/<run>/<file>`
 * writes a check run's report (JSON) or a screenshot (PNG) under
 * `artifacts/<run>/`. Run and file names are lower-case words joined by
 * hyphens, so no request can write anywhere else.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** The run and file a report URL names (relative to /__report), or null if it names anything else. */
export function reportPath(url: string): { run: string; file: string } | null {
  const m = /^\/([a-z0-9-]+)\/([a-z0-9-]+\.(?:json|png))$/.exec(url);
  return m ? { run: m[1], file: m[2] } : null;
}

export function reportPlugin(dir = 'artifacts'): Plugin {
  return {
    name: 'trenchline-report',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__report', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const at = reportPath(req.url ?? '');
        if (!at) {
          res.statusCode = 400;
          res.end('a report is POSTed to /__report/<run>/<name>.json or .png');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const folder = resolve(server.config.root, dir, at.run);
          mkdirSync(folder, { recursive: true });
          writeFileSync(join(folder, at.file), Buffer.concat(chunks));
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}
