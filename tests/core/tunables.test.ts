import { describe, expect, it } from 'vitest';
import { Tunables, loadTunables } from '../../src/core/tunables';
import { tomlPlugin } from '../../tools/vite-plugin-toml';

describe('Tunables', () => {
  const t = new Tunables({ a: { b: { c: 2.5, n: 7 } }, s: { x: 1, y: 2 } });
  it('reads dotted keys', () => {
    expect(t.f('a.b.c')).toBe(2.5);
    expect(t.i('a.b.n')).toBe(7);
    expect(t.sections('s')).toEqual(['x', 'y']);
    expect(t.has('a.b.z')).toBe(false);
  });
  it('reads a range as two numbers, low first, and refuses anything else', () => {
    const r = new Tunables({ g: { ok: [1, 5], flat: [2, 2], back: [5, 1], three: [1, 2, 3], word: 'x' } });
    expect(r.pair('g.ok')).toEqual([1, 5]);
    expect(r.pair('g.flat')).toEqual([2, 2]);
    for (const k of ['g.back', 'g.three', 'g.word']) expect(() => r.pair(k), k).toThrow(TypeError);
  });
  it('names the missing part', () => {
    expect(() => t.get('a.b.z')).toThrow("tunable 'a.b.z' not found (missing 'z')");
  });
  it('refuses to truncate a float into an int', () => {
    expect(() => t.i('a.b.c')).toThrow(TypeError);
    expect(() => t.i('a.b.c')).toThrow(/a\.b\.c/);
  });
  it('loads the real file at 10 cm and 256 m', () => {
    const real = loadTunables();
    expect(real.f('world.voxel_size')).toBe(0.1);
    expect(real.f('world.size_x_m')).toBe(256);
    expect(real.f('player.eye_height_standing')).toBe(1.62);
    expect(real.has('world.rebuild_budget_ms')).toBe(false);
  });
});

describe('tomlPlugin', () => {
  it('reports the file and line of bad TOML', () => {
    const plugin = tomlPlugin() as { transform: (code: string, id: string) => unknown };
    expect(() => plugin.transform('a = [', '/x/tunables.toml')).toThrow(/tunables\.toml/);
    expect(plugin.transform('a = 1', '/x/other.ts')).toBeNull();
  });
});
