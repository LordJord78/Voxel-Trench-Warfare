import { describe, expect, it } from 'vitest';
import { composeWgsl } from '../../tools/vite-plugin-wgsl';

const files: Record<string, string> = {
  'a.wgsl': '#include "b.wgsl"\n#include "c.wgsl"\nA',
  'b.wgsl': '#include "c.wgsl"\nB',
  'c.wgsl': 'C',
  'bad.wgsl': 'X\n#include "nope.wgsl"',
  'dir/x.wgsl': '#include "../y.wgsl"\nX',
  'y.wgsl': 'Y',
};
const read = (path: string) => {
  const text = files[path];
  if (text === undefined) throw new Error(`no such file ${path}`);
  return text;
};

describe('composeWgsl', () => {
  it('inlines each include once, where it first appears', () => {
    expect(composeWgsl('a.wgsl', read)).toBe('C\nB\nA');
  });
  it('reports a missing include by file and line', () => {
    expect(() => composeWgsl('bad.wgsl', read)).toThrow(/bad\.wgsl:2: cannot include "nope\.wgsl"/);
  });
  it('resolves relative to the including file', () => {
    expect(composeWgsl('dir/x.wgsl', read)).toBe('Y\nX');
  });
});
