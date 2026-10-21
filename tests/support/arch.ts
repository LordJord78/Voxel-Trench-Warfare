/**
 * The simulation's two structural rules, as a checker the architecture test runs
 * over src/. Same boundary the Python game's test_architecture.py enforced, plus
 * the determinism rule the browser needs.
 */

import fs from 'node:fs';
import path from 'node:path';

export type Violation = { file: string; line: number; rule: 'import' | 'global' | 'math'; text: string };

const FORBIDDEN = ['src/render', 'src/ui', 'src/app'].map((d) => path.normalize(d));
const IMPORT_QUOTE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])/g;
const GLOBALS = /(?<![.$\w])(?:document|window|navigator|requestAnimationFrame|GPU\w*)\b/g;
const MATH = /\bMath\s*\.\s*(?:sin|cos|tan|asin|acos|atan2|atan|exp|expm1|log1p|log2|log10|log|pow|cbrt|hypot|sinh|cosh|tanh|random)\b/g;

/** Blank comments and the contents of string literals, keeping quotes, offsets and newlines. */
function blank(source: string): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      wipe(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      wipe(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      wipe(i + 1, Math.min(j, n));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

export function checkSource(file: string, source: string): Violation[] {
  const code = blank(source);
  const found: { index: number; v: Violation }[] = [];
  const add = (index: number, rule: Violation['rule'], text: string) =>
    found.push({ index, v: { file, line: lineOf(code, index), rule, text } });

  for (const m of code.matchAll(IMPORT_QUOTE)) {
    const open = m.index + m[0].length - 1;
    const close = code.indexOf(m[1], open + 1);
    if (close === -1) continue;
    const spec = source.slice(open + 1, close);
    if (!spec.startsWith('.')) continue;
    const target = path.normalize(path.join(path.dirname(file), spec));
    if (FORBIDDEN.some((dir) => target === dir || target.startsWith(dir + path.sep))) add(m.index, 'import', spec);
  }
  for (const m of code.matchAll(GLOBALS)) add(m.index, 'global', m[0]);
  for (const m of code.matchAll(MATH)) add(m.index, 'math', m[0]);

  return found.sort((a, b) => a.index - b.index).map((f) => f.v);
}

function walk(dir: string, files: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
}

/** Check every .ts file under root/<dir> for each dir; dirs that don't exist yet are skipped. */
export function checkTree(root: string, dirs: string[]): Violation[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const base = path.join(root, dir);
    if (fs.existsSync(base)) walk(base, files);
  }
  return files.flatMap((file) => checkSource(file, fs.readFileSync(file, 'utf8')));
}
