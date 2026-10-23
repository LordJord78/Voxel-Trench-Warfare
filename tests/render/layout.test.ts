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

  it('writes a path set again in the same place, each element of an array at its own, and checks every write', () => {
    // The frame's uniform is written every frame, the same paths each time: the writer keeps where each goes.
    const listed: StructDef = { name: 'Listed', fields: [['n', 'u32'], ['items', { element: inner, count: 3 }], ['tail', 'f32']] };
    const w = new StructWriter(listed);
    const f = new Float32Array(w.buffer);
    const u = new Uint32Array(w.buffer);
    for (let pass = 0; pass < 2; pass++) {
      w.set('n', 3 + pass);
      for (let k = 0; k < 3; k++) {
        w.set(`items.${k}.a`, [k, k + pass, 2]);
        w.set(`items.${k}.b`, 10 * k + pass);
      }
      w.set('tail', 0.5 + pass);
      expect(u[0]).toBe(3 + pass);
      for (let k = 0; k < 3; k++) expect([f[4 + 4 * k], f[5 + 4 * k], f[6 + 4 * k], f[7 + 4 * k]]).toEqual([k, k + pass, 2, 10 * k + pass]);
      expect(f[16]).toBe(0.5 + pass);
      expect(() => w.set('items.0.a', [1, 2])).toThrow();
      expect(() => w.set('items.3.b', 1)).toThrow();
      expect(() => w.set('items.1', 1)).toThrow();
    }
    expect(structLayout(listed)).toBe(structLayout(listed));
  });
});
