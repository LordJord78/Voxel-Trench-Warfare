import { describe, expect, it } from 'vitest';
import { checkSource, checkTree } from './support/arch';

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
  it('flags engine-dependent maths but not comments or strings', () => {
    const v = checkSource('src/core/x.ts', "// Math.sin is banned\nconst s = 'Math.cos';\nconst y = Math.exp(1) + Math.sqrt(2) + Math.floor(3);");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'math', line: 3 });
  });
  it('the real simulation tree is clean', () => {
    expect(checkTree('src', ['core', 'world', 'physics', 'sim'])).toEqual([]);
  });
});
