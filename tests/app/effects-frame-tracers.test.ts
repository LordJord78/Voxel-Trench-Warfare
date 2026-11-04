import { describe, expect, it } from 'vitest';
import { daylightAt, EffectsFrameBuilder, effectsTunables, NO_BATTLE } from '../../src/app/effects-frame';
import type { TracerState } from '../../src/battle/tracers';
import { projectileSpec, type ProjectileSpec } from '../../src/combat/ballistics';
import { BILLBOARD_FLOATS } from '../../src/combat/particles';
import { loadTunables } from '../../src/core/tunables';
import { TRACER_KIND } from '../../src/net/gear';
import { MAX_BILLBOARDS, MAX_RIBBONS } from '../../src/render/effects';
import { Session, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The tracer's look (the shots spec §1): a streak a frame's flight long, lit in over its first
// metres, drawn as a white-hot core in a coloured glow (ribbon style 1) with a burning head, and
// brighter by day.
const tun = loadTunables();
const t = effectsTunables(tun);
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [] });
type V3 = [number, number, number];
const close = (got: readonly number[], want: readonly number[], digits: number, what = '') => want.forEach((w, k) => expect(got[k], `${what}[${k}]`).toBeCloseTo(w, digits));

/** A round that keeps its speed (no drag), so its streak is the law's own at that speed. */
const steady = (weapon: string): ProjectileSpec => ({ ...projectileSpec(tun, weapon), dragFactor: 0 });

/** 25.6 × 6.4 × 51.2 m of open ground, the player standing at its near end. */
function stand(): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 2] } }, tun, 7, 0);
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

function shoot(s: Session): CombatEvents {
  s.intent = { ...s.intent, fire: true };
  s.tick();
  s.intent = { ...s.intent, fire: false };
  return s.drainEvents();
}

/** Ribbon `i`, 16 floats apart as effects.wgsl's Ribbon is laid out. */
function ribbon(r: Float32Array, i: number) {
  const o = i * 16;
  const at = (k: number) => [r[o + k], r[o + k + 1], r[o + k + 2]];
  return { tail: at(0), width: r[o + 3], head: at(4), alphaTail: r[o + 7], rgb: at(8), alphaHead: r[o + 11], style: r[o + 12], coreShare: r[o + 13], glowShare: r[o + 14], white: r[o + 15] };
}

const lengthOf = (r: { tail: number[]; head: number[] }) => Math.hypot(r.head[0] - r.tail[0], r.head[1] - r.tail[1], r.head[2] - r.tail[2]);

/** The frame's billboards, each its BILLBOARD_FLOATS floats. */
function billboards(built: { frame: { billboards: Float32Array; billboardCount: number } }): number[][] {
  const out = built.frame.billboards;
  return Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
}

describe("a tracer's look", () => {
  it("a tracer's streak is its speed over a frame: 880 m/s draws 12.3 m, 375 m/s 5.25 m, never more than flown", () => {
    const s = stand();
    s.rounds.fire([10, 2, 2], [0, 0, 880], steady('assault_rifle'), 0, TRACER_KIND.red);
    s.rounds.fire([14, 2, 2], [0, 0, 375], steady('m17'), 0, TRACER_KIND.red);
    s.rounds.step(1 / 60);
    const built = new EffectsFrameBuilder(t).build(s, none());
    expect(built.counts.tracers).toBe(2);
    // 0.014 s of flight: 880 × 0.014 and 375 × 0.014.
    expect(lengthOf(ribbon(built.frame.ribbons, 0))).toBeCloseTo(12.32, 3);
    expect(lengthOf(ribbon(built.frame.ribbons, 1))).toBeCloseTo(5.25, 3);
    // 4.4 m out of the muzzle: a streak as long as its flight, not 12.3 m.
    const young = stand();
    young.rounds.fire([10, 2, 2], [0, 0, 880], steady('assault_rifle'), 0, TRACER_KIND.red);
    young.rounds.step(0.005);
    expect(lengthOf(ribbon(new EffectsFrameBuilder(t).build(young, none()).frame.ribbons, 0))).toBeCloseTo(4.4, 3);
  });

  it('a slow round still draws 2.5 m once it has flown that far, and a fast one no more than 14 m', () => {
    const s = stand();
    // 100 m/s would be 1.4 m, 1200 m/s 16.8 m.
    s.rounds.fire([10, 2, 2], [0, 0, 100], steady('assault_rifle'), 0, TRACER_KIND.red);
    s.rounds.fire([14, 2, 2], [0, 0, 1200], steady('assault_rifle'), 0, TRACER_KIND.red);
    s.rounds.step(1 / 30);
    const built = new EffectsFrameBuilder(t).build(s, none());
    expect(lengthOf(ribbon(built.frame.ribbons, 0))).toBeCloseTo(2.5, 3);
    expect(lengthOf(ribbon(built.frame.ribbons, 1))).toBeCloseTo(14, 3);
  });

  it('a tracer ignites over its first metres: at 1 m flown both alphas are under 0.3; at 10 m the head is 1', () => {
    const s = stand();
    s.rounds.fire([10, 2, 2], [0, 0, 880], steady('assault_rifle'), 0, TRACER_KIND.red);
    const b = new EffectsFrameBuilder(t);
    s.rounds.step(1 / 880);
    let r = ribbon(b.build(s, none()).frame.ribbons, 0);
    expect(r.alphaTail).toBeLessThan(0.3);
    expect(r.alphaHead).toBeLessThan(0.3);
    expect(r.alphaHead).toBeGreaterThan(0);
    s.rounds.step(9 / 880);
    r = ribbon(b.build(s, none()).frame.ribbons, 0);
    expect(r.alphaHead).toBe(1);
    // Its tail still at the muzzle: unlit.
    expect(r.alphaTail).toBeCloseTo(0, 4);
    // 30 m out, its tail 17.7 m out: lit through, fading to tracer_tail_alpha at the tail.
    s.rounds.step(20 / 880);
    r = ribbon(b.build(s, none()).frame.ribbons, 0);
    expect(r.alphaTail).toBeCloseTo(0.16, 6);
    expect(r.alphaHead).toBe(1);
  });

  it('a tracer is drawn style 1 with its core and glow shares; the flash star style 0', () => {
    const s = stand();
    const built = new EffectsFrameBuilder(t).build(s, shoot(s));
    expect(built.counts.tracers).toBe(1);
    expect(built.counts.stars).toBe(3);
    const tracer = ribbon(built.frame.ribbons, 0);
    expect(tracer.style).toBe(1);
    // Drawn as wide as its glow (0.22 m), its core 0.035 m of that, the glow at 0.35 of the core's
    // brightness and the core mixed 0.65 toward white.
    expect(tracer.width).toBeCloseTo(0.22, 6);
    expect(tracer.coreShare).toBeCloseTo(0.035 / 0.22, 6);
    expect(tracer.glowShare).toBeCloseTo(0.35, 6);
    expect(tracer.white).toBeCloseTo(0.65, 6);
    // The player's in solo: red [1.0, 0.16, 0.10] at 70, by night.
    close(tracer.rgb, [70, 11.2, 7], 4, 'red');
    for (let i = 1; i <= 3; i++) {
      const star = ribbon(built.frame.ribbons, i);
      expect(star.style, `ray ${i}`).toBe(0);
      expect(star.width, `ray ${i}`).toBeCloseTo(0.06, 6);
    }
  });

  it("each tracer's head is an emissive billboard from 1.5 m flown, none before", () => {
    const s = stand();
    s.rounds.fire([10, 2, 2], [0, 0, 880], steady('assault_rifle'), 0, TRACER_KIND.red);
    const b = new EffectsFrameBuilder(t);
    s.rounds.step(1.4 / 880);
    let built = b.build(s, none());
    expect(built.counts.tracers).toBe(1);
    expect(built.counts.heads).toBe(0);
    expect(built.frame.billboardCount).toBe(0);
    s.rounds.step(0.6 / 880);
    built = b.build(s, none());
    expect(built.counts.heads).toBe(1);
    // 2 m out, lit in as its streak is: half as bright as it will burn.
    const [early] = billboards(built);
    // Its colour the core's: red at 70, [70, 11.2, 7], mixed 0.65 toward white [70, 70, 70], 1.6 times
    // as bright, over the light pass's particle_glow (20) for emissive billboards.
    const burning = [5.6, 3.9536, 3.836];
    close(early.slice(4, 7), burning.map((c) => c * 0.5), 4, 'lit in');
    s.rounds.step(8 / 880);
    built = b.build(s, none());
    const [head] = billboards(built);
    close(head.slice(0, 3), s.rounds.position(0), 4, 'at the round');
    // 0.09 m across.
    expect(head[3]).toBeCloseTo(0.045, 6);
    close(head.slice(4, 7), burning, 4, 'burning');
    expect(head[7]).toBe(1);
    // Emissive, and held as a ribbon is to the pixels it is drawn over (kind 3, effects.wgsl): no
    // smaller than three, nor wider than its share of a tracer's glow at its widest.
    expect(head[8]).toBe(3);
  });

  it("a battle tracer is drawn as the session's are, its streak at most the battle's trail_m, its head from 1.5 m", () => {
    const tracers: TracerState[] = [
      { id: 1, position: [50, 30, 80], velocity: [400, 0, 300], flown: 100 },
      { id: 2, position: [60, 31, 90], velocity: [0, 0, 2000], flown: 100 },
      { id: 3, position: [40, 32, 70], velocity: [0, 0, 820], flown: 1 },
    ];
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, [50, 20, 70], { ...NO_BATTLE, tracers });
    expect(built.counts.battleTracers).toBe(3);
    const at = (p: readonly number[]) => [0, 1, 2].map((i) => ribbon(built.frame.ribbons, i)).find((r) => r.head.every((v, k) => Math.abs(v - p[k]) < 1e-4))!;
    // 500 m/s: 7 m back along its way, lit through, a tracer's style.
    const first = at(tracers[0].position);
    close(first.tail, [50 - 0.8 * 7, 30, 80 - 0.6 * 7], 4, 'tail');
    expect(first.style).toBe(1);
    expect(first.alphaHead).toBe(1);
    // The battle's amber [1.0, 0.83, 0.45] at 70.
    close(first.rgb, [70, 58.1, 31.5], 3, 'amber');
    // 2000 m/s would be 28 m: held at the battle's 24, not the session's 14.
    expect(lengthOf(at(tracers[1].position))).toBeCloseTo(24, 3);
    // Lit in as the session's: a metre out, a quarter lit, and no head yet.
    expect(at(tracers[2].position).alphaHead).toBeCloseTo(0.25, 6);
    expect(built.counts.heads).toBe(2);
    const heads = billboards(built).filter((q) => q[8] === 3);
    expect(heads.map((q) => q[0]).sort()).toEqual([50, 60]);
  });

  it("by day a tracer is brighter: daylight 1 gives 4× the radiance of night's", () => {
    const s = stand();
    s.rounds.fire([10, 2, 2], [0, 0, 880], steady('assault_rifle'), 0, TRACER_KIND.blue);
    s.rounds.step(1 / 60);
    const battle = { ...NO_BATTLE, tracers: [{ id: 1, position: [50, 30, 80] as V3, velocity: [0, 0, 820] as V3, flown: 100 }] };
    const built = (daylight?: number) => new EffectsFrameBuilder(t).build(s, none(), null, undefined, battle, 1, [], daylight);
    const night = built(0);
    const noon = built(1);
    expect(night.counts.tracers + night.counts.battleTracers).toBe(2);
    for (let i = 0; i < 2; i++) close(ribbon(noon.frame.ribbons, i).rgb, ribbon(night.frame.ribbons, i).rgb.map((c) => c * 4), 3, `ribbon ${i}`);
    // The blue at night: [0.20, 0.50, 1.0] at 70.
    close(ribbon(night.frame.ribbons, 0).rgb, [14, 35, 70], 4, 'blue');
    const heads = (b: ReturnType<typeof built>) => billboards(b).map((q) => q.slice(4, 7));
    expect(heads(noon).length).toBe(2);
    heads(noon).forEach((c, i) => close(c, heads(night)[i].map((v) => v * 4), 4, `head ${i}`));
    // None given: night's.
    close(ribbon(built().frame.ribbons, 0).rgb, ribbon(night.frame.ribbons, 0).rgb, 6, 'default');
  });

  it('daylight comes up with the sun: none 4° below the horizon, all of it from 20° up, a little at dusk', () => {
    expect(daylightAt(-10, t)).toBe(0);
    expect(daylightAt(-4, t)).toBe(0);
    expect(daylightAt(20, t)).toBe(1);
    expect(daylightAt(35, t)).toBe(1);
    // Dusk's sun, 4.5° up: (8.5 / 24)² (3 − 2 · 8.5 / 24).
    expect(daylightAt(4.5, t)).toBeCloseTo(0.2875, 3);
  });

  it('256 pool tracers and 2000 battle tracers give at most MAX_RIBBONS ribbons and MAX_BILLBOARDS billboards, max_drawn (900) of the battle drawn, without throwing', () => {
    const s = stand();
    const rifle = projectileSpec(tun, 'assault_rifle');
    for (let k = 0; k < 256; k++) s.rounds.fire([1 + (k % 16) * 1.5, 2 + Math.floor(k / 16) * 0.2, 2], [0, 0, 880], rifle, 0, TRACER_KIND.red);
    expect(s.rounds.count).toBe(256);
    s.rounds.step(1 / 60);
    const tracers: TracerState[] = Array.from({ length: 2000 }, (_, i) => ({ id: i, position: [10 + (i % 50), 30, 20 + Math.floor(i / 50)], velocity: [0, 0, 820], flown: 50 }));
    const b = new EffectsFrameBuilder(t);
    const build = () => b.build(s, none(), null, undefined, { ...NO_BATTLE, tracers });
    expect(build).not.toThrow();
    const built = build();
    expect(built.counts.tracers).toBe(256);
    expect(built.counts.battleTracers).toBe(900);
    expect(built.counts.heads).toBe(256 + 900);
    expect(built.frame.ribbonCount).toBeLessThanOrEqual(MAX_RIBBONS);
    expect(built.frame.billboardCount).toBeLessThanOrEqual(MAX_BILLBOARDS);
  });

  it('past the buffers, tracers stop at MAX_RIBBONS and their heads at MAX_BILLBOARDS, without throwing', () => {
    const s = stand();
    const rifle = projectileSpec(tun, 'assault_rifle');
    for (let k = 0; k < 256; k++) s.rounds.fire([1 + (k % 16) * 1.5, 2 + Math.floor(k / 16) * 0.2, 2], [0, 0, 880], rifle, 0, TRACER_KIND.red);
    s.rounds.step(1 / 60);
    const b = new EffectsFrameBuilder(t);
    // Room left for ten heads, and for ten of the battle's ribbons after the session's own.
    b.debug = Array.from({ length: MAX_BILLBOARDS - 10 }, (_, k) => ({ position: [k * 0.001, 2, 5] as V3, size: 0.1, colour: [1, 1, 1] as V3 }));
    b.debugRibbons = Array.from({ length: MAX_RIBBONS - 256 - 10 }, (_, k) => ({ tail: [k * 0.001, 2, 5] as V3, head: [k * 0.001, 3, 5] as V3, width: 0.06, colour: [1, 1, 1] as V3 }));
    const tracers: TracerState[] = Array.from({ length: 50 }, (_, i) => ({ id: i, position: [10 + i, 30, 20], velocity: [0, 0, 820], flown: 50 }));
    const build = () => b.build(s, none(), null, undefined, { ...NO_BATTLE, tracers });
    expect(build).not.toThrow();
    const built = build();
    expect(built.frame.ribbonCount).toBe(MAX_RIBBONS);
    expect(built.counts.battleTracers).toBe(10);
    expect(built.frame.billboardCount).toBe(MAX_BILLBOARDS);
    expect(built.counts.heads).toBe(10);
  });
});
