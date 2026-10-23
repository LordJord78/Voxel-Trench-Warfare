import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, checkSource, checkTree, listFiles } from './support/arch';

describe('architecture rules', () => {
  it('flags imports from render, ui and app', () => {
    const v = checkSource('src/world/x.ts', "import { a } from '../render/gpu';\nexport * from '../ui/hud';");
    expect(v.map((x) => x.rule)).toEqual(['import', 'import']);
    expect(v[0].line).toBe(1);
  });
  it('flags DOM and WebGPU globals', () => {
    const v = checkSource('src/sim/x.ts', 'const c = document.body;\nconst u: GPUDevice = null!;');
    expect(v.map((x) => x.rule)).toEqual(['global', 'global']);
  });
  it('flags imports from audio, and WebAudio globals', () => {
    const v = checkSource('src/combat/x.ts', "import { a } from '../audio/engine';\nconst c = new AudioContext();");
    expect(v.map((x) => x.rule)).toEqual(['import', 'global']);
  });
  it('flags engine-dependent maths but not comments or strings', () => {
    const v = checkSource('src/core/x.ts', "// Math.sin is banned\nconst s = 'Math.cos';\nconst y = Math.exp(1) + Math.sqrt(2) + Math.floor(3);");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'math', line: 3 });
  });
  it('sees through template literals, regex literals and computed imports', () => {
    const src = [
      'const a = `${Math.atan2(y, x)}`;',
      'const b = `${document.title}`;',
      "const re = /'/g;",
      'const c = Math.sin(x);',
      'const re2 = /[/*]/;',
      'const d2 = Math.cos(x);',
      'const m = import(`../render/${n}`);',
    ].join('\n');
    const v = checkSource('src/world/x.ts', src);
    expect(v.map((x) => [x.rule, x.line])).toEqual([['math', 1], ['global', 2], ['math', 4], ['math', 6], ['import', 7]]);
  });
  it('allows only exact Math functions, however Math is reached', () => {
    const src = [
      'const a = x ** 1.5;',
      'y **= 2;',
      'const b = Math.asinh(1);',
      'const { sin } = Math;',
      'const M = Math;',
      "const c = Math['sin'](x);",
      'const d = Math?.sin(x);',
      'const ok = Math.sqrt(2) + Math.floor(1.5) + Math.PI + Math.imul(3, 4);',
    ].join('\n');
    expect(checkSource('src/core/x.ts', src).map((v) => [v.rule, v.line])).toEqual([
      ['math', 1], ['math', 2], ['math', 3], ['math', 4], ['math', 5], ['math', 6], ['math', 7],
    ]);
  });
  it('does not mistake fields and local names for globals', () => {
    const src = [
      'const state = { window: 1 };',
      'state.window = 2;',
      'class F { document = 3 }',
      'const GPU_BUDGET_MS = 3;',
      'export const t = GPU_BUDGET_MS + state.window + new F().document;',
    ].join('\n');
    expect(checkSource('src/sim/x.ts', src)).toEqual([]);
  });
  it('flags wall-clock time, nondeterministic crypto and Node built-ins', () => {
    const src = ["import fs from 'node:fs';", 'const t = Date.now();', 'crypto.getRandomValues(buf);'].join('\n');
    expect(checkSource('src/world/x.ts', src).map((v) => v.rule)).toEqual(['import', 'global', 'global']);
  });
  it('checks the real tree from the repo root, wherever the tests run from', () => {
    expect(listFiles('src', ['core']).length).toBeGreaterThan(4);
    expect(checkSource(path.join(REPO_ROOT, 'src/world/x.ts'), "import { a } from '../render/gpu';")).toHaveLength(1);
    expect(checkTree('src', ['core', 'world', 'physics', 'sim', 'combat'])).toEqual([]);
  });
});
