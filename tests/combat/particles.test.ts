import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BILLBOARD_FLOATS, BLOOD_BILLBOARD, CASING_BILLBOARD, particleSpec, Particles, SMOKE_BILLBOARD, type ParticleSpec } from '../../src/combat/particles';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { effectsLook } from '../../src/render/effects';
import { wgslFn } from '../support/wgsl-fn';

const EFFECTS_WGSL = readFileSync('src/render/shaders/effects.wgsl', 'utf8');

// The reference's particle pool (combat/particles.py): struct-of-arrays, per-second drag then
// gravity then the move, removal in order at the end of life, and billboards whose size and
// colour run from start to end by age. Its two kinds (the flash and brass) and the dust and
// sparks of impacts come from [particles.*].
const tun = loadTunables();
const DT = 1 / 60;

const spec = (over: Partial<ParticleSpec> = {}): ParticleSpec => ({
  lifeS: 1,
  gravity: -9.81,
  drag: 2,
  sizeStartM: 0.2,
  sizeEndM: 0.4,
  colourStart: [1, 0, 0, 1],
  colourEnd: [0, 0, 1, 0],
  emissive: false,
  square: false,
  count: 1,
  speed: 0,
  lift: 0,
  spread: 0,
  speedJitter: 0,
  ...over,
});

function billboards(p: Particles): Float32Array[] {
  const out = new Float32Array(p.capacity * BILLBOARD_FLOATS);
  const n = p.billboards(out);
  return Array.from({ length: n }, (_, i) => out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS));
}

describe('particles', () => {
  it("read their kinds from [particles.*]: the reference's flash and brass, and dust and sparks", () => {
    const brass = particleSpec(tun, 'brass');
    expect([brass.lifeS, brass.gravity, brass.drag, brass.sizeStartM]).toEqual([1.3, -9.81, 0.35, 0.028]);
    expect([brass.count, brass.speed, brass.lift, brass.spread, brass.speedJitter, brass.emissive]).toEqual([1, 2.6, 1.5, 0.55, 0.2, false]);
    const flash = particleSpec(tun, 'muzzle_flash');
    expect([flash.lifeS, flash.speed, flash.emissive]).toEqual([0.045, 2.0, true]);
    expect(particleSpec(tun, 'dust').emissive).toBe(false);
    expect(particleSpec(tun, 'spark').emissive).toBe(true);
    expect(tun.i('particles.pool_capacity')).toBe(4096);
  });

  it("a particle slows and falls as the reference's does", () => {
    const p = new Particles(8);
    p.emit([1, 2, 3], [3, 0, 4], spec(), 1);
    p.step(DT);
    const [b] = billboards(p);
    const k = 1 - 2 * DT;
    const v = [3 * k, -9.81 * DT, 4 * k];
    expect(b[0]).toBeCloseTo(1 + v[0] * DT, 6);
    expect(b[1]).toBeCloseTo(2 + v[1] * DT, 6);
    expect(b[2]).toBeCloseTo(3 + v[2] * DT, 6);
  });

  it('particles die at their life and the pool keeps its order', () => {
    const p = new Particles(8);
    p.emit([0, 0, 0], [0, 0, 0], spec({ lifeS: 0.05, gravity: 0 }), 1);
    p.emit([1, 0, 0], [0, 0, 0], spec({ lifeS: 1, gravity: 0 }), 1);
    p.emit([2, 0, 0], [0, 0, 0], spec({ lifeS: 0.05, gravity: 0 }), 1);
    p.emit([3, 0, 0], [0, 0, 0], spec({ lifeS: 1, gravity: 0 }), 1);
    for (let k = 0; k < 4; k++) p.step(DT);
    expect(p.count).toBe(2);
    expect(billboards(p).map((b) => b[0])).toEqual([1, 3]);
  });

  it('a full pool refuses the rest and counts them', () => {
    const p = new Particles(tun.i('particles.pool_capacity'));
    expect(p.emit([0, 0, 0], [0, 1, 0], spec(), 4100)).toBe(4096);
    expect(p.emit([0, 0, 0], [0, 1, 0], spec(), 6)).toBe(0);
    expect(p.count).toBe(4096);
    expect(p.dropped).toBe(10);
  });

  it('billboards run size and colour by age, half the size across, colour premultiplied', () => {
    const p = new Particles(8);
    p.emit([0, 0, 0], [0, 0, 0], spec({ gravity: 0, lifeS: 30 * DT }), 1);
    for (let k = 0; k < 15; k++) p.step(DT);
    const [b] = billboards(p);
    expect(b[3]).toBeCloseTo(0.15, 6);
    expect(Array.from(b.slice(4, 8)).map((v) => +v.toFixed(6))).toEqual([0.25, 0, 0.25, 0.5]);
    expect(b[8]).toBe(0);
  });

  it('a puff may swell quickly and then slowly (its `sizeEase`, k: its size start + (end − start)(1 − (1 − t)^k) at t of its life); 1, or none, as before', () => {
    const at = (sizeEase: number | undefined, steps: number) => {
      const p = new Particles(8);
      p.emit([0, 0, 0], [0, 0, 0], spec({ gravity: 0, lifeS: 30 * DT, sizeStartM: 0.1, sizeEndM: 0.3, ...(sizeEase === undefined ? {} : { sizeEase }) }), 1);
      for (let k = 0; k < steps; k++) p.step(DT);
      return 2 * billboards(p)[0][3];
    };
    for (const steps of [0, 3, 15, 29]) {
      const t = steps / 30;
      expect(at(undefined, steps)).toBeCloseTo(0.1 + 0.2 * t, 6);
      expect(at(1, steps)).toBeCloseTo(0.1 + 0.2 * t, 6);
      expect(at(4, steps)).toBeCloseTo(0.1 + 0.2 * (1 - (1 - t) ** 4), 6);
    }
    // A tenth of its life on, a puff of k 4 is a third of the way out, not a tenth.
    expect(at(4, 3)).toBeGreaterThan(0.1 + 0.2 * 0.34);
    expect(particleSpec(tun, 'blood_entry').sizeEase).toBe(tun.f('particles.blood_entry.size_ease'));
    expect(particleSpec(tun, 'blood_mist').sizeEase).toBe(tun.f('particles.blood_mist.size_ease'));
    expect(particleSpec(tun, 'dust').sizeEase).toBe(1);
  });

  it("dust takes the struck material's colour", () => {
    const p = new Particles(8);
    p.emit([0, 0, 0], [0, 0, 0], spec({ colourStart: [1, 1, 1, 0.5], colourEnd: [1, 1, 1, 0.5] }), 1, undefined, [0.2, 0.4, 0.6]);
    const [b] = billboards(p);
    expect(Array.from(b.slice(4, 8)).map((v) => +v.toFixed(6))).toEqual([0.1, 0.2, 0.3, 0.5]);
  });

  it("square particles are drawn lit as kind 2, the flash's kind 1 and the rest 0", () => {
    const p = new Particles(8);
    p.emit([0, 1, 0], [0, 0, 0], spec(), 1);
    p.emit([0, 1, 0], [0, 0, 0], spec({ emissive: true }), 1);
    p.emit([0, 1, 0], [0, 0, 0], spec({ square: true }), 1);
    expect(billboards(p).map((b) => b[8])).toEqual([0, 1, 2]);
    expect(particleSpec(tun, 'debris').square).toBe(true);
    expect(particleSpec(tun, 'shell_soil').square).toBe(false);
    expect(particleSpec(tun, 'blast_flash').emissive).toBe(true);
  });

  it("blood (its table's `blood = true`) is drawn as its own kind, 5: a lit disc whose light has a floor and that is drawn at least blood_min_px across (effects-light.wgsl); every other kind is as it was", () => {
    expect(BLOOD_BILLBOARD).toBe(5);
    const p = new Particles(8);
    p.emit([0, 1, 0], [0, 0, 0], spec({ blood: true }), 1);
    p.emit([0, 1, 0], [0, 0, 0], spec({ blood: false }), 1);
    p.emit([0, 1, 0], [0, 0, 0], spec(), 1);
    expect(billboards(p).map((b) => b[8])).toEqual([5, 0, 0]);
    for (const kind of ['blood', 'blood_mist', 'blood_entry']) expect(particleSpec(tun, kind).blood, kind).toBe(true);
    for (const kind of ['muzzle_flash', 'brass', 'dust', 'spark', 'blast_flash', 'shell_soil', 'debris', 'muzzle_smoke']) expect(particleSpec(tun, kind).blood ?? false, kind).toBe(false);
  });

  it("muzzle smoke ([particles.muzzle_smoke]): a lit grey puff rising and slowing, growing 0.05 to 0.35 m and fading from 0.18 over 1.4 s, one a shot", () => {
    const smoke = particleSpec(tun, 'muzzle_smoke');
    expect([smoke.lifeS, smoke.gravity, smoke.drag, smoke.sizeStartM, smoke.sizeEndM]).toEqual([1.4, 0.25, 1.5, 0.05, 0.35]);
    expect(smoke.colourStart).toEqual([0.55, 0.55, 0.55, 0.18]);
    expect(smoke.colourEnd).toEqual([0.55, 0.55, 0.55, 0.0]);
    expect([smoke.emissive, smoke.square, smoke.casing ?? false, smoke.blood ?? false, smoke.smoke ?? false]).toEqual([false, false, false, false, true]);
    expect([smoke.count, smoke.speed, smoke.spread]).toEqual([1, 0.6, 0.4]);
    // It rises: thrown still, it climbs.
    const p = new Particles(4);
    p.emit([0, 1, 0], [0, 0, 0], smoke, 1);
    // Lit as dust is, but of its own kind: a soft puff (effects.wgsl), not a mote's firm disc, which the
    // shot's own light showed as a bright ball near the eye.
    expect(SMOKE_BILLBOARD).toBe(7);
    expect(billboards(p)[0][8]).toBe(SMOKE_BILLBOARD);
    // No way to be drawn along: that is a casing's.
    expect(Array.from(billboards(p)[0].slice(9, 12))).toEqual([0, 0, 0]);
    for (let k = 0; k < 30; k++) p.step(DT);
    expect(billboards(p)[0][1]).toBeGreaterThan(1);
    // Only the muzzle's smoke is a puff: the rest are as they were.
    for (const kind of ['muzzle_flash', 'brass', 'dust', 'spark', 'blast_flash', 'shell_soil', 'debris', 'blood']) expect(particleSpec(tun, kind).smoke ?? false, kind).toBe(false);
  });

  it("the wind (`wind`, m/s) carries the lit particles that are not held to the drawn gun, added to their own velocity as they move; not the emissive, not the anchored, and none by default", () => {
    const still = spec({ gravity: 0, drag: 2 });
    const p = new Particles(8);
    expect(p.wind).toEqual([0, 0, 0]);
    p.emit([0, 1, 0], [1, 0, 0], still, 1);
    p.emit([0, 1, 0], [1, 0, 0], spec({ gravity: 0, drag: 2, emissive: true }), 1);
    p.emit([0, 1, 0], [1, 0, 0], still, 1, undefined, undefined, 2);
    p.emit([0, 1, 0], [1, 0, 0], spec({ gravity: 0, drag: 2, blood: true }), 1);
    p.emit([0, 1, 0], [1, 0, 0], spec({ gravity: 0, drag: 2, smoke: true }), 1);
    p.wind = [2, 0, -1];
    p.step(DT);
    const own = (1 - 2 * DT) * DT;
    const at = billboards(p).map((b) => Array.from(b.slice(0, 3)));
    const expectAt = (got: number[], want: number[], what: string) => got.forEach((v, k) => expect(v, `${what}.${k}`).toBeCloseTo(want[k], 6));
    expectAt(at[0], [own + 2 * DT, 1, -DT], 'lit');
    expectAt(at[1], [own, 1, 0], 'emissive');
    expectAt(at[2], [own, 1, 0], 'anchored');
    expectAt(at[3], [own + 2 * DT, 1, -DT], 'blood');
    // The muzzle's smoke (its own kind, a soft puff) drifts with it.
    expectAt(at[4], [own + 2 * DT, 1, -DT], 'smoke');
    // It is not their velocity: their own drag does not eat it, and with it gone they move as before.
    for (let k = 0; k < 30; k++) p.step(DT);
    const before = billboards(p)[0][0];
    p.step(DT);
    const v = 1 * (1 - 2 * DT) ** 32;
    expect(billboards(p)[0][0] - before).toBeCloseTo((v + 2) * DT, 6);
    p.wind = [0, 0, 0];
    const calm = billboards(p)[0][0];
    p.step(DT);
    expect(billboards(p)[0][0] - calm).toBeCloseTo(v * (1 - 2 * DT) * DT, 6);
  });

  it("the brass is a casing (its table's `casing = true`): its own kind, its long axis along its way as it flies and falls", () => {
    expect(CASING_BILLBOARD).toBe(6);
    // Twelve floats a billboard now, its way the last three; the pool says so for what reads it in the page.
    expect(BILLBOARD_FLOATS).toBe(12);
    expect(new Particles(1).floats).toBe(BILLBOARD_FLOATS);
    const brass = particleSpec(tun, 'brass');
    expect(brass.casing).toBe(true);
    for (const kind of ['muzzle_flash', 'dust', 'spark', 'debris', 'blood', 'muzzle_smoke']) expect(particleSpec(tun, kind).casing ?? false, kind).toBe(false);
    const p = new Particles(4);
    p.emit([0, 1.5, 0], [2.6, 1.5, 0.3], brass, 1);
    p.emit([0, 1.5, 0], [2.6, 1.5, 0.3], spec(), 1);
    const axis = () => {
      const [casing, mote] = billboards(p);
      expect(casing[8]).toBe(CASING_BILLBOARD);
      // A mote has no way to be drawn along.
      expect(Array.from(mote.slice(9, 12))).toEqual([0, 0, 0]);
      return Array.from(casing.slice(9, 12));
    };
    const unit = (v: number[]) => v.map((x) => x / Math.hypot(v[0], v[1], v[2]));
    // Thrown out and up, then falling: its axis is its velocity's way each step.
    const prev = [0, 1.5, 0];
    let falling = false;
    for (let k = 0; k < 40; k++) {
      p.step(DT);
      const [b] = billboards(p);
      const now = Array.from(b.slice(0, 3));
      const way = unit(now.map((x, i) => x - prev[i]));
      const a = axis();
      expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(1, 5);
      // Its velocity this step is the way it moved (the move is its velocity × dt).
      a.forEach((x, i) => expect(x, `step ${k}.${i}`).toBeCloseTo(way[i], 3));
      if (a[1] < -0.5) falling = true;
      prev.splice(0, 3, ...now);
    }
    expect(falling).toBe(true);
  });

  it("a casing is drawn about 1 cm × 3 cm, its length held to casing_max_px pixels near the eye, its width with it (effects.wgsl's own casingDrawn)", () => {
    const look = effectsLook(tun);
    const brass = particleSpec(tun, 'brass');
    // The shader's own sizing, run here: what the vertex shader draws a casing by, not a copy of it.
    const shader = wgslFn(EFFECTS_WGSL, 'casingDrawn');
    const casingDrawn = (lengthM: number, pixelM: number, l: typeof look) => {
      const [drawn, across] = shader(lengthM, pixelM, l.casingMaxPx, l.casingWidthShare) as number[];
      return { lengthM: drawn, widthM: across };
    };
    // The vertex shader lays a casing out by it, from its billboard (half its length) and a pixel's width
    // where it is (metres), with the draw's casing_* (effects.ts); and nowhere sizes one by a copy.
    const vs = EFFECTS_WGSL.slice(EFFECTS_WGSL.indexOf('fn vs(')).replace(/\s+/g, ' ');
    expect(vs).toContain('let size = casingDrawn(2.0 * abs(b.half), pixelAt(b.centre * toVoxels) * frame.voxel, draw.casingMaxPx, draw.casingWidthShare);');
    expect(vs).toContain('along * (corner.y * 0.5 * size.x) + across * (corner.x * 0.5 * size.y)');
    expect(EFFECTS_WGSL.replace(/\/\/[^\n]*/g, '').match(/draw\.casingMaxPx/g)).toHaveLength(1);
    expect(brass.sizeStartM).toBeGreaterThanOrEqual(0.025);
    expect(brass.sizeStartM).toBeLessThanOrEqual(0.035);
    // Far enough off, as it is: about 3 cm along and 1 cm across.
    const far = casingDrawn(brass.sizeStartM, 0.01, look);
    expect(far.lengthM).toBe(brass.sizeStartM);
    expect(far.widthM).toBeGreaterThanOrEqual(0.008);
    expect(far.widthM).toBeLessThanOrEqual(0.012);
    // At the port, 0.4 m from the eye at 1600 px across a 90° view, a pixel is 0.5 mm: 56 px long
    // unheld, the soft disc the flash lit; held to casing_max_px, its width in proportion.
    const pixelM = (2 * 0.4) / 1600;
    const near = casingDrawn(brass.sizeStartM, pixelM, look);
    expect(brass.sizeStartM / pixelM).toBeGreaterThan(look.casingMaxPx);
    expect(near.lengthM / pixelM).toBeCloseTo(look.casingMaxPx, 6);
    expect(near.widthM / near.lengthM).toBeCloseTo(far.widthM / far.lengthM, 6);
    expect(look.casingMaxPx).toBeGreaterThanOrEqual(8);
    expect(look.casingMaxPx).toBeLessThanOrEqual(24);
  });

  it("the muzzle's smoke is lit (the spec's: not emissive) as a mote is, by a shot's light whole: effects-light.wgsl gives no kind a share of it", () => {
    const light = readFileSync('src/render/shaders/effects-light.wgsl', 'utf8').replace(/\/\/[^\n]*/g, '');
    const main = light.slice(light.indexOf('fn main(')).replace(/\s+/g, ' ');
    // The light every lit billboard takes (dust, brass, blood, smoke): the key's, the shots' and the rest.
    expect(main).toContain('var light = frame.keyColour * keyLit(p) * look.dustKey + flashesAt(p) + mix(around, near.rgb, near.a);');
    // Read once, and smoke has no light of its own: no share, no tunable.
    expect(main.match(/flashesAt\(/g)).toHaveLength(1);
    expect(light).not.toContain('smokeFlash');
    expect(() => tun.f('effects.smoke_flash_share')).toThrow();
    expect('smokeFlashShare' in effectsLook(tun)).toBe(false);
    // Its kind is still its own, for the draw's soft puff (effects.wgsl), and it is not emissive.
    expect(particleSpec(tun, 'muzzle_smoke').emissive).toBe(false);
    expect(light.replace(/\s+/g, ' ')).toContain('if (kind != 1.0 && !core && !head && !ember) {');
  });

  it('the same seed throws the same brass', () => {
    const brass = particleSpec(tun, 'brass');
    const run = () => {
      const p = new Particles(64);
      const rng = Rng.root(9).derive('effects.particles');
      for (let k = 0; k < 10; k++) {
        p.emit([0, 1.5, 0], [brass.speed, brass.lift, 0], brass, brass.count, rng);
        p.step(DT);
      }
      return billboards(p).map((b) => Array.from(b));
    };
    const a = run();
    expect(a.length).toBe(10);
    expect(new Set(a.map((b) => b[0].toFixed(6))).size).toBeGreaterThan(5);
    expect(run()).toEqual(a);
  });

  it("an anchored particle is drawn off by its anchor's drift, less as it ages, none by the time given", () => {
    // The shot's flash and brass leave the rifle as it is drawn, then join their own paths.
    const still = spec({ gravity: 0, drag: 0 });
    const p = new Particles(8);
    p.emit([0, 1, 0], [0, 0, 0], still, 1);
    p.emit([0, 1, 0], [0, 0, 0], still, 1, undefined, undefined, 1);
    p.emit([0, 1, 0], [0, 0, 0], still, 1, undefined, undefined, 2);
    const drift = [
      [0.1, -0.2, 0.05],
      [0, 0.3, 0],
    ];
    const at = (d?: number[][]) => {
      const out = new Float32Array(p.capacity * BILLBOARD_FLOATS);
      expect(p.billboards(out, d, 0.15)).toBe(3);
      return [0, 1, 2].map((i) => Array.from(out.slice(i * BILLBOARD_FLOATS, i * BILLBOARD_FLOATS + 3)));
    };
    const expectAt = (got: number[][], want: number[][]) => got.forEach((g, i) => g.forEach((v, k) => expect(v, `${i}.${k}`).toBeCloseTo(want[i][k], 6)));
    expectAt(at(drift), [
      [0, 1, 0],
      [0.1, 0.8, 0.05],
      [0, 1.3, 0],
    ]);
    expectAt(at(), [
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 0],
    ]);
    p.step(0.075);
    expectAt(at(drift), [
      [0, 1, 0],
      [0.05, 0.9, 0.025],
      [0, 1.15, 0],
    ]);
    p.step(0.075);
    expectAt(at(drift), [
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 0],
    ]);
  });

  it("a shell's debris comes back down before it is gone", () => {
    // The review's case: thrown up at about 18 m/s and opaque for 2.4 s, debris ended its life
    // mid-air (median 6.3 m up). Thrown as the session throws it (speed and lift, straight up), a
    // piece ends its life at or under where it was thrown from: there the ground hides it.
    const debris = particleSpec(tun, 'debris');
    const rng = Rng.root(5).derive('effects.particles');
    let down = 0;
    const trials = 400;
    for (let k = 0; k < trials; k++) {
      const p = new Particles(1);
      p.emit([0, 0, 0], [0, debris.speed + debris.lift, 0], debris, 1, rng);
      let y = 0;
      while (p.count > 0) {
        y = billboards(p)[0][1];
        p.step(DT);
      }
      if (y <= 0) down++;
    }
    expect(down / trials).toBeGreaterThanOrEqual(0.95);
  });
});
