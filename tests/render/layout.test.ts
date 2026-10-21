import { describe, expect, it } from 'vitest';
import { StructWriter, structLayout, structWgsl, type StructDef } from '../../src/render/layout';

const plain: StructDef = {
  name: 'Plain',
  fields: [
    ['a', 'f32'],
    ['b', 'vec3f'],
    ['c', 'f32'],
    ['d', 'vec2f'],
  ],
};
const inner: StructDef = { name: 'Inner', fields: [['a', 'vec3f'], ['b', 'f32']] };
const outer: StructDef = { name: 'Outer', fields: [['s', inner], ['u', 'u32']] };

describe('WGSL struct layout', () => {
  it('follows the alignment rules', () => {
    const l = structLayout(plain);
    expect(l.offsets).toEqual({ a: 0, b: 16, c: 28, d: 32 });
    expect(l.size).toBe(48);
    expect(l.align).toBe(16);
  });
  it('nests structs at their own alignment and rounds the size up', () => {
    const l = structLayout(outer);
    expect(l.offsets.s).toBe(0);
    expect(l.offsets.u).toBe(16);
    expect(l.size).toBe(32);
  });
  it('declares nested structs once, before their users', () => {
    const text = structWgsl({ name: 'Two', fields: [['x', outer], ['y', inner]] });
    expect(text.indexOf('struct Inner {')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('struct Inner {')).toBeLessThan(text.indexOf('struct Outer {'));
    expect(text.split('struct Inner {').length).toBe(2);
    expect(text).toContain('struct Inner {\n  a: vec3f,\n  b: f32,\n}');
  });
  it('writes floats and integers by path', () => {
    const w = new StructWriter(outer);
    w.set('s.a', [1, 2, 3]);
    w.set('u', 7);
    const f = new Float32Array(w.buffer);
    const u = new Uint32Array(w.buffer);
    expect([f[0], f[1], f[2]]).toEqual([1, 2, 3]);
    expect(u[4]).toBe(7);
    expect(() => w.set('nope', 1)).toThrow();
  });
});
