import { describe, expect, it } from 'vitest';
import { coverAt, daylightAt, EffectsFrameBuilder, effectsTunables, NO_BATTLE, tracerWhiteAt } from '../../src/app/effects-frame';
import type { TracerState } from '../../src/battle/tracers';
import { projectileSpec, type ProjectileSpec } from '../../src/combat/ballistics';
import { pose, toWorld } from '../../src/combat/soldier-rig';
import { BILLBOARD_FLOATS } from '../../src/combat/particles';
import { TICK_HZ } from '../../src/core/clock';
import { loadTunables } from '../../src/core/tunables';
import { TRACER_KIND } from '../../src/net/gear';
import { HEAD_BILLBOARD, MAX_BILLBOARDS, MAX_RIBBONS } from '../../src/render/effects';
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

/** The streak the law asks for at `speed` (m/s): tracer_streak_s of its flight, within tracer_min_m and tracer_max_m. */
const streakAt = (speed: number) => Math.min(t.tracerMaxM, Math.max(t.tracerMinM, speed * t.tracerStreakS));

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

/** The player 2 m along open ground looking along it (+z), a wall across it `wallM` in front of the eye (none: open to the map's end, 49 m on). */
function facing(wallM: number | null): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  if (wallM !== null) map.fillBox(0, 0, Math.round((2 + wallM) * 10), 256, 64, Math.round((2 + wallM) * 10) + 4, P.TIMBER);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 2] } }, tun, 7, 0);
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

/** The player's eye (metres): where their rounds leave. */
const eyeOf = (s: Session): V3 => [s.player.position.x, s.player.position.y + s.controller.eyeHeight(s.player), s.player.position.z];

/** The player's long gun made the M870, and up. */
function shotgun(s: Session): Session {
  s.equip({ primary: 'm870', secondary: 'm17', fits: {} });
  for (let k = 0; k < 120; k++) s.tick();
  s.drainEvents();
  return s;
}

/** A frame of `ticks` whole 60 Hz ticks, the trigger pulled in the first if `fire`: the events it drained, and the frame built from them. */
function frameOf(s: Session, b: EffectsFrameBuilder, ticks = 1, fire = false): { events: CombatEvents; built: ReturnType<EffectsFrameBuilder['build']> } {
  for (let k = 0; k < ticks; k++) {
    s.intent = { ...s.intent, fire: fire && k === 0 };
    s.tick();
  }
  s.intent = { ...s.intent, fire: false };
  const events = s.drainEvents();
  return { events, built: b.build(s, events) };
}

/** Ribbon `i`, 16 floats apart as effects.wgsl's Ribbon is laid out. */
function ribbon(r: Float32Array, i: number) {
  const o = i * 16;
  const at = (k: number) => [r[o + k], r[o + k + 1], r[o + k + 2]];
  return { tail: at(0), width: r[o + 3], head: at(4), alphaTail: r[o + 7], rgb: at(8), alphaHead: r[o + 11], style: r[o + 12], coreShare: r[o + 13], glowShare: r[o + 14], white: r[o + 15] };
}

const lengthOf = (r: { tail: readonly number[]; head: readonly number[] }) => Math.hypot(r.head[0] - r.tail[0], r.head[1] - r.tail[1], r.head[2] - r.tail[2]);

/** The frame's tracers' ribbons (style 1), in the order drawn. */
function tracerRibbons(built: { frame: { ribbons: Float32Array; ribbonCount: number } }) {
  return Array.from({ length: built.frame.ribbonCount }, (_, i) => ribbon(built.frame.ribbons, i)).filter((r) => r.style === 1);
}

/** The frame's billboards, each its BILLBOARD_FLOATS floats. */
function billboards(built: { frame: { billboards: Float32Array; billboardCount: number } }): number[][] {
  const out = built.frame.billboards;
  return Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
}

describe("a tracer's look", () => {
  it("a tracer's streak is its speed over more than a frame: the AK's round (880 m/s) draws 21.1 m, the M17's (375 m/s) 9 m, never more than flown", () => {
    const [ak, m17] = [steady('assault_rifle'), steady('m17')];
    expect([ak.muzzleVelocity, m17.muzzleVelocity]).toEqual([880, 375]);
    const s = stand();
    s.rounds.fire([10, 2, 2], [0, 0, ak.muzzleVelocity], ak, 0, TRACER_KIND.red);
    s.rounds.fire([14, 2, 2], [0, 0, m17.muzzleVelocity], m17, 0, TRACER_KIND.red);
    for (let k = 0; k < 2; k++) s.rounds.step(1 / TICK_HZ);
    const built = new EffectsFrameBuilder(t).build(s, none());
    expect(built.counts.tracers).toBe(2);
    // 0.024 s of flight, longer than a 60 Hz frame's (14.7 m and 6.25 m), so a round's streaks overlap
    // frame to frame and a stream leaves no gaps.
    expect(lengthOf(built.drawn[0])).toBeCloseTo(ak.muzzleVelocity * t.tracerStreakS, 3);
    expect(lengthOf(built.drawn[0])).toBeCloseTo(21.12, 3);
    expect(lengthOf(built.drawn[1])).toBeCloseTo(m17.muzzleVelocity * t.tracerStreakS, 3);
    expect(lengthOf(built.drawn[0])).toBeGreaterThan(ak.muzzleVelocity / TICK_HZ);
    // A tick out of the muzzle: a streak as long as its flight (14.7 m), not 21.1 m.
    const young = stand();
    young.rounds.fire([10, 2, 2], [0, 0, ak.muzzleVelocity], ak, 0, TRACER_KIND.red);
    young.rounds.step(1 / TICK_HZ);
    expect(lengthOf(new EffectsFrameBuilder(t).build(young, none()).drawn[0])).toBeCloseTo(ak.muzzleVelocity / TICK_HZ, 3);
  });

  it('a slow round still draws 2.5 m once it has flown that far, and a fast one no more than 24 m', () => {
    const s = stand();
    // 100 m/s would be 2.4 m, 1200 m/s 28.8 m.
    s.rounds.fire([10, 2, 2], [0, 0, 100], steady('assault_rifle'), 0, TRACER_KIND.red);
    s.rounds.fire([14, 2, 2], [0, 0, 1200], steady('assault_rifle'), 0, TRACER_KIND.red);
    s.rounds.step(1 / 30);
    const built = new EffectsFrameBuilder(t).build(s, none());
    expect(lengthOf(built.drawn[0])).toBeCloseTo(2.5, 3);
    expect(lengthOf(built.drawn[1])).toBeCloseTo(24, 3);
    // The slow one 3.3 m out, its tail 0.8 m out: lit in up to 1 m out, so two ribbons, one streak;
    // the fast one's tail 16 m out, one.
    const ribbons = tracerRibbons(built);
    expect(ribbons).toHaveLength(3);
    const [ramp, rest] = ribbons;
    expect(lengthOf(ramp) + lengthOf(rest)).toBeCloseTo(2.5, 3);
  });

  it("an aimed shot's tracer, a 60 Hz tick at a time: its first frame lit in from nothing at the muzzle to full 4 m out, its second lit through, fading to tracer_tail_alpha at its tail", () => {
    const ak = steady('assault_rifle');
    const aimedM = tun.f('effects.tracer_ignite_m');
    expect(aimedM).toBe(4);
    const s = stand();
    s.rounds.fire([10, 2, 2], [0, 0, ak.muzzleVelocity], ak, 0, TRACER_KIND.red, { igniteM: aimedM });
    const b = new EffectsFrameBuilder(t);
    // A tick out, 14.7 m, its streak (21.1 m asked) back to the muzzle: the ramp up to 4 m, and from
    // there full light, fading toward the tail as one streak would.
    s.rounds.step(1 / TICK_HZ);
    let built = b.build(s, none());
    const flown = built.drawn[0].flown;
    expect(flown).toBeCloseTo(ak.muzzleVelocity / TICK_HZ, 3);
    const first = tracerRibbons(built);
    expect(first).toHaveLength(2);
    const [ramp, rest] = first;
    const there = t.tracerTailAlpha + (1 - t.tracerTailAlpha) * (aimedM / flown);
    expect(lengthOf(ramp)).toBeCloseTo(aimedM, 3);
    expect(ramp.alphaTail).toBeCloseTo(0, 6);
    expect(ramp.alphaHead).toBeCloseTo(there, 6);
    expect(rest.alphaTail).toBeCloseTo(there, 6);
    expect(rest.alphaHead).toBe(1);
    // A tick on, 29.3 m out, its tail 8.2 m out: lit through, one ribbon fading to tracer_tail_alpha
    // at its tail.
    s.rounds.step(1 / TICK_HZ);
    built = b.build(s, none());
    const second = tracerRibbons(built);
    expect(second).toHaveLength(1);
    expect(second[0].alphaTail).toBeCloseTo(t.tracerTailAlpha, 6);
    expect(second[0].alphaHead).toBe(1);
  });

  it("a round's first frame, its streak reaching back to the muzzle, is lit in along it: from the hip fully lit from 1 m, aimed from 4 m, and past that as a round lit from the muzzle is", () => {
    const [hipM, aimedM] = [tun.f('effects.tracer_ignite_hip_m'), tun.f('effects.tracer_ignite_m')];
    /** The player's shot from the hip or aimed, after the 60 Hz tick it was fired in: what is drawn of it, and how far into its flight its streak's tail is. */
    const firstFrame = (aimed: boolean) => {
      const s = stand();
      s.intent = { ...s.intent, aim: aimed };
      while (aimed && s.aimed < 1) s.tick();
      s.drainEvents();
      const built = new EffectsFrameBuilder(t).build(s, shoot(s));
      expect(built.drawn).toHaveLength(1);
      const path = s.rounds.tracerSegments(streakAt);
      return { drawn: built.drawn[0], ribbons: tracerRibbons(built), tailFlown: path.flown[0] - lengthOf({ tail: Array.from(path.tail), head: Array.from(path.head) }) };
    };
    for (const [aimed, igniteM] of [[false, hipM], [true, aimedM]] as const) {
      const what = aimed ? 'aimed' : 'from the hip';
      const { drawn, ribbons, tailFlown } = firstFrame(aimed);
      // A tick out (some 14.6 m), its whole flight its streak (21.1 m asked): drawn from the muzzle.
      expect(tailFlown, what).toBeCloseTo(0, 3);
      // Two ribbons along the one streak: the ramp from nothing at the muzzle up to where it is lit,
      // then the rest.
      expect(ribbons, what).toHaveLength(2);
      const [ramp, rest] = ribbons;
      close(ramp.tail, drawn.tail, 5, `${what}: from the muzzle`);
      close(ramp.head, rest.tail, 5, `${what}: one streak`);
      close(rest.head, drawn.head, 5, `${what}: to its head`);
      // Where it is lit: igniteM of its flight, along the streak as drawn.
      expect(tailFlown + (lengthOf(ramp) / lengthOf(drawn)) * (drawn.flown - tailFlown), what).toBeCloseTo(igniteM, 3);
      // From there on as the streak's own fade, tracer_tail_alpha at the muzzle to all of it at the
      // head, as a round lit from the muzzle draws it; nothing at the muzzle.
      const fade = (f: number) => t.tracerTailAlpha + (1 - t.tracerTailAlpha) * ((f - tailFlown) / (drawn.flown - tailFlown));
      expect(ramp.alphaTail, what).toBeCloseTo(0, 6);
      expect(ramp.alphaHead, what).toBeCloseTo(fade(igniteM), 6);
      expect(rest.alphaTail, what).toBeCloseTo(fade(igniteM), 6);
      expect(rest.alphaHead, what).toBe(1);
    }
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
    // The player's in solo: red [1.0, 0.04, 0.018] at 70, by night.
    close(tracer.rgb, [70, 2.8, 1.26], 4, 'red');
    // The star's three rays after the tracer's ribbons (in its first frame two: lit in part way along).
    for (let i = built.frame.ribbonCount - 3; i < built.frame.ribbonCount; i++) {
      const star = ribbon(built.frame.ribbons, i);
      expect(star.style, `ray ${i}`).toBe(0);
      expect(star.width, `ray ${i}`).toBeCloseTo(0.06, 6);
    }
    expect(tracerRibbons(built).every((r) => r.width === tracer.width && r.coreShare === tracer.coreShare)).toBe(true);
  });

  it("each tracer's head is an emissive billboard from 1.5 m flown, none before", () => {
    const s = stand();
    // An aimed shot's, lit in over tracer_ignite_m (4 m).
    s.rounds.fire([10, 2, 2], [0, 0, 880], steady('assault_rifle'), 0, TRACER_KIND.red, { igniteM: tun.f('effects.tracer_ignite_m') });
    const b = new EffectsFrameBuilder(t);
    // Seen from where it left, so its distance from the eye is its flight.
    const eye: V3 = [10, 2, 2];
    s.rounds.step(1.4 / 880);
    let built = b.build(s, none(), null, eye);
    expect(built.counts.tracers).toBe(1);
    expect(built.counts.heads).toBe(0);
    expect(built.frame.billboardCount).toBe(0);
    s.rounds.step(0.6 / 880);
    built = b.build(s, none(), null, eye);
    expect(built.counts.heads).toBe(1);
    // 2 m out, lit in as its streak is: half as bright as it will burn.
    const [early] = billboards(built);
    // Its colour the core's: red at 70, [70, 2.8, 1.26], mixed toward white [70, 70, 70] (0.65 within
    // 6 m of the eye), 1.6 times as bright, over the light pass's particle_glow (20) for emissive
    // billboards; its alpha how near the eye it is (all of it within 6 m), for the draw to keep its hue.
    close(early.slice(4, 7), [70, 2.8 + 67.2 * 0.65, 1.26 + 68.74 * 0.65].map((c) => c * 0.08 * 0.5), 4, 'lit in');
    expect(early[7]).toBe(1);
    s.rounds.step(8 / 880);
    built = b.build(s, none(), null, eye);
    const [head] = billboards(built);
    close(head.slice(0, 3), s.rounds.position(0), 4, 'at the round');
    // 0.09 m across.
    expect(head[3]).toBeCloseTo(0.045, 6);
    // 10 m from the eye: mixed 0.65 × (1 − smoothstep(6, 40, 10)) = 0.6251 toward white.
    const near = 1 - (3 * (4 / 34) ** 2 - 2 * (4 / 34) ** 3);
    close(head.slice(4, 7), [70, 2.8 + (70 - 2.8) * 0.65 * near, 1.26 + (70 - 1.26) * 0.65 * near].map((c) => c * 0.08), 4, 'burning');
    expect(head[7]).toBeCloseTo(near, 6);
    // Emissive, and held as a ribbon is to the pixels it is drawn over (kind 3, effects.wgsl): no
    // smaller than three, nor wider than its share of a tracer's glow at its widest.
    expect(head[8]).toBe(3);
  });

  it("a tracer's head is white-hot near the eye and its team's colour far from it: all of tracer_core_white within 6 m, half at 23 m, none past 40 m", () => {
    // The ribbon carries tracer_core_white and effects.wgsl takes it down by the same law at the
    // ribbon's middle; the head is mixed here, at its own distance.
    const eye: V3 = [0, 10, 0];
    const b = new EffectsFrameBuilder(t);
    const headAt = (m: number) => {
      b.debugTracers = [{ tail: [0, 10, m - 5], head: [0, 10, m], kind: TRACER_KIND.red }];
      const built = b.build(stand(), none(), null, eye);
      expect(ribbon(built.frame.ribbons, 0).white).toBeCloseTo(0.65, 6);
      const [head] = billboards(built).filter((q) => q[8] === 3);
      return head.slice(4, 7);
    };
    // Red at 70, its head 1.6 times as bright over particle_glow (20): [5.6, 0.224, 0.1008] as its own.
    const own = [5.6, 0.224, 0.1008];
    const mixed = (w: number) => own.map((c) => c + (5.6 - c) * w);
    close(headAt(3), mixed(0.65), 4, '3 m');
    close(headAt(6), mixed(0.65), 4, '6 m');
    close(headAt(23), mixed(0.325), 4, '23 m');
    close(headAt(40), own, 4, '40 m');
    close(headAt(90), own, 4, '90 m');
    // The law the heads are mixed by: by day at least the floor's share of it, however far.
    expect(tracerWhiteAt(3, t)).toBeCloseTo(0.65, 6);
    expect(tracerWhiteAt(23, t)).toBeCloseTo(0.325, 6);
    expect(tracerWhiteAt(90, t)).toBe(0);
    expect(tracerWhiteAt(90, t, 0.5)).toBeCloseTo(0.325, 6);
    expect(tracerWhiteAt(3, t, 0.5)).toBeCloseTo(0.65, 6);
  });

  it('an ember burns brighter by day, as its tracer does: daylight 1 gives 4× the radiance of night', () => {
    const hit = { position: [10, 4, 5] as V3, normal: [0, 1, 0] as V3, cell: [10, 3, 5] as V3, material: P.SOD, speed: 800, distance: 60, energyJ: 3000, owner: 0, spec: 'ak', dir: [0, -1, 0] as V3, kind: TRACER_KIND.red, tick: 1 };
    const ember = (daylight: number) => {
      const built = new EffectsFrameBuilder(t).build(stand(), { ...none(), impacts: [hit] }, null, undefined, NO_BATTLE, 1, [], daylight);
      expect(built.counts.embers).toBe(1);
      // An ember: emissive, kept at its hue (EMBER_BILLBOARD), its alpha its whiteness: none by
      // night, all of it by day (tracer_white_by_day), as a tracer's core.
      const [q] = billboards(built).filter((b) => b[8] === 4);
      expect(q[7]).toBeCloseTo(t.tracerWhiteByDay * daylight, 6);
      return q.slice(4, 7);
    };
    const night = ember(0);
    // Red at 70, 1.6 times as bright over particle_glow (20), newly struck.
    close(night, [5.6, 0.224, 0.1008], 4, 'night');
    close(ember(1), night.map((c) => c * 4), 4, 'noon');
  });

  it("a tracer joins its round's path where the shot was aimed: all of its muzzle's offset at 0 m, half at half way, none from there", () => {
    const s = stand();
    const origin: V3 = [12.8, 2.0, 2];
    const from: V3 = [12.98, 1.79, 2.6];
    const offset = [from[0] - origin[0], from[1] - origin[1], from[2] - origin[2]];
    // Aimed 40 m out.
    s.rounds.fire(origin, [0, 0, 880], steady('assault_rifle'), 0, TRACER_KIND.red, { from, convergeM: 40 });
    const b = new EffectsFrameBuilder(t);
    let flown = 0;
    const drawnAt = (m: number) => {
      s.rounds.step((m - flown) / 880);
      flown = m;
      const built = b.build(s, none());
      const seg = s.rounds.tracerSegments((speed) => Math.min(t.tracerMaxM, Math.max(t.tracerMinM, speed * t.tracerStreakS)));
      expect(seg.converge[0]).toBe(40);
      return { drawn: built.drawn[0], head: Array.from(seg.head.slice(0, 3)), tail: Array.from(seg.tail.slice(0, 3)) };
    };
    // A metre out: its tail at the muzzle, its whole offset.
    const young = drawnAt(1);
    close(young.drawn.tail, from, 4, 'tail at the muzzle');
    close(young.drawn.head, young.head.map((v, k) => v + offset[k] * (1 - 1 / 40)), 4, '1 m');
    const half = drawnAt(20);
    close(half.drawn.head, half.head.map((v, k) => v + offset[k] * 0.5), 4, 'half way');
    const there = drawnAt(40);
    close(there.drawn.head, there.head, 4, 'there');
    // Past it (the open ground ends 49 m on), its tail too: on its round's path.
    const past = drawnAt(47);
    close(past.drawn.head, past.head, 4, 'past it');
    close(past.drawn.tail, past.tail.map((v, k) => v + offset[k] * Math.max(0, 1 - (47 - 21.12) / 40)), 4, 'its tail, 25.9 m out');
  });

  it("a hip shot's tracer is lit in by 1 m, an aimed one's by 4 m, a half-aimed one's between: by its share aimed as it was fired", () => {
    const [hipM, aimedM] = [tun.f('effects.tracer_ignite_hip_m'), tun.f('effects.tracer_ignite_m')];
    expect([hipM, aimedM]).toEqual([1, 4]);
    // The session keeps each round's as it fires it: from the hip, the sights coming up, and aimed.
    const fired = (aimedAtLeast: number) => {
      const s = stand();
      s.intent = { ...s.intent, aim: aimedAtLeast > 0 };
      while (s.aimed < aimedAtLeast) s.tick();
      s.drainEvents();
      shoot(s);
      const seg = s.rounds.tracerSegments(t.tracerMaxM);
      expect(seg.ignite.length).toBe(1);
      return { share: s.aimed, igniteM: seg.ignite[0] };
    };
    const hip = fired(0);
    expect(hip.share).toBe(0);
    expect(hip.igniteM).toBeCloseTo(hipM, 6);
    const aimed = fired(1);
    expect(aimed.share).toBe(1);
    expect(aimed.igniteM).toBeCloseTo(aimedM, 6);
    const half = fired(0.4);
    expect(half.share).toBeGreaterThan(0.4);
    expect(half.share).toBeLessThan(0.6);
    expect(half.igniteM).toBeCloseTo(hipM + (aimedM - hipM) * half.share, 5);
    // Drawn a 60 Hz tick after it was fired, each lit in over its own: its first frame's streak, back to
    // the muzzle, ramps up to where it is fully lit, igniteM out, and is drawn as two ribbons there.
    const litFrom = (igniteM: number | undefined) => {
      const s = stand();
      const ak = steady('assault_rifle');
      s.rounds.fire([10, 2, 2], [0, 0, ak.muzzleVelocity], ak, 0, TRACER_KIND.red, igniteM === undefined ? {} : { igniteM });
      s.rounds.step(1 / TICK_HZ);
      const ribbons = tracerRibbons(new EffectsFrameBuilder(t).build(s, none()));
      expect(ribbons.length).toBeLessThanOrEqual(2);
      // Lit from the muzzle: one ribbon, as bright at its tail as the streak's own fade.
      return { from: ribbons.length === 2 ? lengthOf(ribbons[0]) : 0, ramp: ribbons[0] };
    };
    expect(litFrom(hip.igniteM).from).toBeCloseTo(hipM, 3);
    expect(litFrom(aimed.igniteM).from).toBeCloseTo(aimedM, 3);
    expect(litFrom(half.igniteM).from).toBeCloseTo(half.igniteM, 3);
    for (const igniteM of [hip.igniteM, aimed.igniteM, half.igniteM]) expect(litFrom(igniteM).ramp.alphaTail).toBeCloseTo(0, 6);
    // A round fired without one (another player's, the front's) is lit in as a hip shot's, by 1 m;
    // one fired with none at all, from the muzzle: a ribbon whose tail at the muzzle is the streak's
    // own fade there.
    expect(litFrom(undefined).from).toBeCloseTo(hipM, 3);
    const lit = litFrom(0);
    expect(lit.from).toBe(0);
    expect(lit.ramp.alphaTail).toBeCloseTo(t.tracerTailAlpha, 6);
    expect(lit.ramp.alphaHead).toBe(1);
  });

  it('a shot is aimed at the first thing on its line: a wall 30 m out, past the map (the sky) the farthest, nearer than 8 m held at 8', () => {
    const [near, far] = [tun.f('effects.tracer_converge_min_m'), tun.f('effects.tracer_converge_max_m')];
    // A shot into the wall: its round (and its tracer) joins its path there, cast once as it leaves.
    const walled = facing(30);
    expect(walled.aimRange(0, eyeOf(walled), [0, 0, 1])).toBeCloseTo(30, 0);
    shoot(walled);
    const seg = walled.rounds.tracerSegments(t.tracerMaxM);
    expect(seg.converge.length).toBe(1);
    expect(seg.converge[0]).toBeCloseTo(30, 0);
    // Nothing on its line before the map's end, as into the sky: the farthest.
    const open = facing(null);
    expect(open.aimRange(0, eyeOf(open), [0, 0, 1])).toBe(far);
    shoot(open);
    expect(open.rounds.tracerSegments(t.tracerMaxM).converge[0]).toBe(far);
    expect(open.aimRange(0, eyeOf(open), [0, 0.5, 0.866])).toBe(far);
    // A wall 2 m off: held at the nearest.
    const close2 = facing(2);
    expect(close2.aimRange(0, eyeOf(close2), [0, 0, 1])).toBe(near);
  });

  it("a body on the line is the first thing on it, if the shooter's round would strike it: a target 20 m out in front of a wall 30 m out gives 20", () => {
    const s = facing(30);
    // A target standing 20 m out from the eye, facing back: the range's (200 on), struck by the player's rounds alone.
    const feet: V3 = [12.8, 0.4, 22];
    const frames = pose({ position: feet, yaw: 180, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null });
    s.targets = [{ id: 200, frames, feet }];
    const eye = eyeOf(s);
    const chest = toWorld(frames.torso, [0, 0.28, 0]);
    const to = [chest[0] - eye[0], chest[1] - eye[1], chest[2] - eye[2]];
    const n = Math.hypot(to[0], to[1], to[2]);
    const dir: V3 = [to[0] / n, to[1] / n, to[2] / n];
    // The player's (owner 0): at the target's chest, its front some 20 m out.
    expect(s.aimRange(0, eye, dir)).toBeCloseTo(20, 0);
    // The front's (owner 1), which a target does not stop: on to the wall.
    expect(s.aimRange(1, eye, dir)).toBeCloseTo(30 / dir[2], 0);
    // The player's shot at it, aimed (its cone tight): its tracer joins its path at the target. A tick
    // out (14.7 m) the round is still on its way to it.
    s.player.yaw = (Math.atan2(dir[0], dir[2]) * 180) / Math.PI;
    s.player.pitch = (Math.asin(dir[1]) * 180) / Math.PI;
    s.intent = { ...s.intent, aim: true };
    while (s.aimed < 1) s.tick();
    s.drainEvents();
    shoot(s);
    expect(s.rounds.count).toBe(1);
    expect(s.rounds.tracerSegments(t.tracerMaxM).converge[0]).toBeCloseTo(20, 0);
    // With others: another player's shot (owner 2 + their seat) at a soldier of another seat stops at
    // him; at their own, it goes on; and the round they fire joins its path there.
    // (This player stands aside, off the line: another's round would strike them too.)
    const room = facing(30);
    room.teleport([3, 0.4, 2], 0, 0);
    room.together = true;
    room.bodies = [{ id: 1, frames, feet }];
    expect(room.aimRange(2, eye, dir)).toBeCloseTo(20, 0);
    expect(room.aimRange(3, eye, dir)).toBeCloseTo(30 / dir[2], 0);
    room.fireRemote(2, eye, dir, true, eye);
    expect(room.rounds.tracerSegments(t.tracerMaxM).converge[0]).toBeCloseTo(20, 0);
  });

  it("a battle tracer is drawn as the session's are, its streak at most the battle's trail_m, its head from 1.5 m", () => {
    const tracers: TracerState[] = [
      { id: 1, position: [50, 30, 80], velocity: [400, 0, 300], flown: 100 },
      { id: 2, position: [60, 31, 90], velocity: [0, 0, 2000], flown: 100 },
      { id: 3, position: [40, 32, 70], velocity: [0, 0, 820], flown: 0.5 },
    ];
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, [50, 20, 70], { ...NO_BATTLE, tracers });
    expect(built.counts.battleTracers).toBe(3);
    const at = (p: readonly number[]) => [0, 1, 2].map((i) => ribbon(built.frame.ribbons, i)).find((r) => r.head.every((v, k) => Math.abs(v - p[k]) < 1e-4))!;
    // 500 m/s: 12 m back along its way, lit through, a tracer's style.
    const first = at(tracers[0].position);
    close(first.tail, [50 - 0.8 * 12, 30, 80 - 0.6 * 12], 4, 'tail');
    expect(first.style).toBe(1);
    expect(first.alphaHead).toBe(1);
    // The battle's amber [1.0, 0.45, 0.0] at 70.
    close(first.rgb, [70, 31.5, 0], 3, 'amber');
    // 2000 m/s would be 48 m: held at the battle's 24.
    expect(lengthOf(at(tracers[1].position))).toBeCloseTo(24, 3);
    // Lit in as a hip shot's (tracer_ignite_hip_m): half a metre out, half lit, and no head yet.
    expect(at(tracers[2].position).alphaHead).toBeCloseTo(0.5, 6);
    expect(built.counts.heads).toBe(2);
    const heads = billboards(built).filter((q) => q[8] === 3);
    expect(heads.map((q) => q[0]).sort()).toEqual([50, 60]);
  });

  it('a battle tracer after a strike stays lit: its ignition is the muzzle\'s, not the ricochet\'s', () => {
    const tracers: TracerState[] = [{ id: 1, position: [50, 30, 80], velocity: [0, 0, 300], flown: 1, carried: 120 }];
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, [50, 20, 70], { ...NO_BATTLE, tracers });
    expect(ribbon(built.frame.ribbons, 0).alphaHead).toBe(1);
    expect(built.counts.heads).toBe(1);
  });

  it('a tracer that strikes leaves an ember and, grazing, a ricochet: drawn as a tracer, lit, then gone', () => {
    const s = stand();
    // Grazing the ground at 800 m/s; corrugate rings every one off.
    const hit = (n: number) => ({ position: [10 + n, 4, 5] as V3, normal: [0, 1, 0] as V3, cell: [n, 3, 0] as V3, material: P.CORRUGATE, speed: 800, distance: 60, energyJ: 3000, owner: 0, spec: 'ak', dir: [0.9848, -0.1736, 0] as V3, kind: TRACER_KIND.red, tick: n });
    const tun2 = { ...t, ricochet: { ...t.ricochet, chanceHard: 1 } };
    const b = new EffectsFrameBuilder(tun2);
    const events = { ...none(), impacts: [hit(0), hit(1)] };
    const first = b.build(s, events);
    expect(first.counts.embers).toBe(2);
    expect(first.counts.ricochets).toBe(0); // at the strike they have not flown
    // Embers are emissive, their tracer's colour; none is a head.
    expect(billboards(first).filter((q) => q[8] === 3)).toHaveLength(0);
    s.tick();
    const later = b.build(s, none());
    expect(later.counts.ricochets).toBe(2);
    expect(later.counts.heads).toBe(2);
    expect(ribbon(later.frame.ribbons, 0).alphaHead).toBeGreaterThan(0.9);
    expect(ribbon(later.frame.ribbons, 0).alphaHead).toBeLessThanOrEqual(1);
    for (let k = 0; k < 120; k++) s.tick();
    const gone = b.build(s, none());
    expect(gone.counts.ricochets + gone.counts.embers).toBe(0);
  });

  it("embers and ricochets are counted by their tracer's kind, so a capture can tell the player's from the front's", () => {
    const s = stand();
    const hit = (n: number, kind: number) => ({ position: [10 + n, 4, 5] as V3, normal: [0, 1, 0] as V3, cell: [n, 3, 0] as V3, material: P.CORRUGATE, speed: 800, distance: 60, energyJ: 3000, owner: kind === TRACER_KIND.amber ? 1 : 0, spec: 'ak', dir: [0.9848, -0.1736, 0] as V3, kind, tick: n });
    const b = new EffectsFrameBuilder({ ...t, ricochet: { ...t.ricochet, chanceHard: 1 } });
    const first = b.build(s, { ...none(), impacts: [hit(0, TRACER_KIND.amber), hit(1, TRACER_KIND.red), hit(2, TRACER_KIND.red)] });
    // Indexed by TRACER_KIND: none, amber, red, blue.
    expect(first.counts.embersByKind).toEqual([0, 1, 2, 0]);
    expect(first.counts.ricochetsByKind).toEqual([0, 0, 0, 0]);
    s.tick();
    const later = b.build(s, none());
    expect(later.counts.ricochetsByKind).toEqual([0, 1, 2, 0]);
    expect(later.counts.ricochets).toBe(3);
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
    expect(noon.frame.ribbonCount).toBe(night.frame.ribbonCount);
    for (let i = 0; i < night.frame.ribbonCount; i++) close(ribbon(noon.frame.ribbons, i).rgb, ribbon(night.frame.ribbons, i).rgb.map((c) => c * 4), 3, `ribbon ${i}`);
    // The blue at night: [0.05, 0.32, 1.0] at 70.
    close(ribbon(night.frame.ribbons, 0).rgb, [3.5, 22.4, 70], 4, 'blue');
    // Its heads 4 times as bright, and by day as white as near the eye (tracer_white_by_day): against
    // sunlit ground white-hot reads where a pure colour does not.
    const heads = (b: ReturnType<typeof built>) => billboards(b).map((q) => q.slice(4, 8));
    expect(heads(noon).length).toBe(2);
    // The session's blue round's head first, the battle's amber's after.
    const own = [t.tracerColourBlue, t.tracerColour];
    heads(noon).forEach((q, i) => {
      const c = own[i].map((v) => v * t.tracerIntensity * 4);
      const hottest = Math.max(...c);
      close(q.slice(0, 3), c.map((v) => (v + (hottest - v) * t.tracerCoreWhite) * (t.tracerHeadGain / t.particleGlow)), 3, `head ${i}`);
      expect(q[3]).toBe(1);
    });
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

  it("a tracer's light covers what is behind it while the sun is up, all of it by 17:35, none from dusk on", () => {
    // tracer_cover_deg [-6, 2]: the sun at noon (32.8°) and at 17:35, solo's opening hour (4.5°), is
    // up, the haze behind a tracer bright; at 19:30 (13.8° down) and at night the sky is dark behind
    // it, and its light added alone reads brighter, as approved.
    expect(t.tracerCoverDeg).toEqual([-6, 2]);
    expect(coverAt(32.8, t)).toBe(1);
    expect(coverAt(4.5, t)).toBe(1);
    expect(coverAt(2, t)).toBe(1);
    expect(coverAt(-13.8, t)).toBe(0);
    expect(coverAt(-39.4, t)).toBe(0);
    expect(coverAt(-6, t)).toBe(0);
    // At the sunset, 0°: (6 / 8)² (3 − 2 · 6 / 8).
    expect(coverAt(0, t)).toBeCloseTo(0.84375, 6);
  });

  it("the frame carries the sun's share of the cover (none if not given), and where the tracers' own billboards start, to be drawn over the ribbons", () => {
    const s = stand();
    shoot(s);
    s.rounds.step(1 / 60);
    const battle = { ...NO_BATTLE, flames: [{ centre: [5, 1, 30] as V3, sizeM: 0.5, glow: 1, ember: false }], tracers: [{ id: 1, position: [50, 30, 80] as V3, velocity: [0, 0, 820] as V3, flown: 100 }] };
    const b = new EffectsFrameBuilder(t);
    const night = b.build(s, none(), null, undefined, battle, 1, [], 0);
    expect(night.frame.cover).toBe(0);
    const day = b.build(s, none(), null, undefined, battle, 1, [], 1, 1);
    expect(day.frame.cover).toBe(1);
    expect(b.build(s, none(), null, undefined, battle, 1, [], 0.29, 0.5).frame.cover).toBe(0.5);
    // Every billboard from there on is a tracer's head or another emissive one; the flame before it.
    const from = day.frame.tracerBillboardsFrom ?? -1;
    const all = billboards(day);
    expect(day.counts.heads).toBe(2);
    expect(from).toBe(all.length - day.counts.heads);
    expect(all.slice(from).every((q) => q[8] === HEAD_BILLBOARD)).toBe(true);
    expect(all.slice(0, from).some((q) => q[8] === HEAD_BILLBOARD)).toBe(false);
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
    // The session's own ribbons: in its first frame each of its tracers is lit in part way along, two.
    const own = new EffectsFrameBuilder(t).build(s, none()).frame.ribbonCount;
    expect(own).toBe(2 * 256);
    // Room left for ten heads, and for ten of the battle's ribbons after the session's own.
    b.debug = Array.from({ length: MAX_BILLBOARDS - 10 }, (_, k) => ({ position: [k * 0.001, 2, 5] as V3, size: 0.1, colour: [1, 1, 1] as V3 }));
    b.debugRibbons = Array.from({ length: MAX_RIBBONS - own - 10 }, (_, k) => ({ tail: [k * 0.001, 2, 5] as V3, head: [k * 0.001, 3, 5] as V3, width: 0.06, colour: [1, 1, 1] as V3 }));
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

describe("a round that strikes within the frame's ticks", () => {
  // A round is retired at its strike, inside the tick: one whose whole flight fits in the frame's
  // ticks (an AK round's under 14.7 m at 60 Hz, a pellet's under 6.7 m, twice that when a frame runs
  // two ticks) would never be drawn, and a longer stream would stop a tick short of what it struck. The
  // strike carries the round's draw, and the frame that drains it draws the last of its flight once,
  // by the law the live rounds are drawn by, ending where it struck.
  const length = (d: { tail: readonly number[]; head: readonly number[] }) => Math.hypot(d.head[0] - d.tail[0], d.head[1] - d.tail[1], d.head[2] - d.tail[2]);

  it('a wall 10 m out: one AK shot draws one tracer, its head at the wall and its tail at the drawn muzzle', () => {
    const s = facing(10);
    const { events, built } = frameOf(s, new EffectsFrameBuilder(t), 1, true);
    expect(events.shots).toHaveLength(1);
    expect(events.impacts).toHaveLength(1);
    expect(s.rounds.count).toBe(0);
    expect(built.counts.tracers).toBe(1);
    expect(built.drawn).toHaveLength(1);
    const [d] = built.drawn;
    const hit = events.impacts[0];
    expect(d.struck).toBe(true);
    expect(d.kind).toBe(TRACER_KIND.red);
    expect(d.flown).toBeCloseTo(hit.distance, 4);
    // Its head where it struck, held off the face (toward the eye, its normal) by its own radius, so the
    // wall does not hide half of it.
    expect(hit.normal).toEqual([0, 0, -1]);
    close(d.head, [hit.position[0], hit.position[1], hit.position[2] - t.tracerHeadM / 2], 4, 'head');
    // Its whole 10 m flight its streak (21.1 m asked for): back to where it left, drawn from the muzzle.
    close(d.tail, events.shots[0].muzzle, 2, 'tail');
    // Its ribbons written, as a tracer's, and its head.
    expect(built.frame.ribbonCount).toBeGreaterThan(built.counts.stars);
    expect(ribbon(built.frame.ribbons, 0).style).toBe(1);
    expect(built.counts.heads).toBe(1);
  });

  it('a wall 25 m out: the round is drawn twice, in flight and then ending at the wall', () => {
    const s = facing(25);
    const b = new EffectsFrameBuilder(t);
    const first = frameOf(s, b, 1, true);
    expect(first.events.impacts).toHaveLength(0);
    expect(first.built.drawn.map((d) => d.struck)).toEqual([false]);
    const second = frameOf(s, b);
    expect(second.events.impacts).toHaveLength(1);
    expect(s.rounds.count).toBe(0);
    expect(second.built.drawn.map((d) => d.struck)).toEqual([true]);
    const [d] = second.built.drawn;
    const hit = second.events.impacts[0];
    close(d.head, [hit.position[0], hit.position[1], hit.position[2] - t.tracerHeadM / 2], 4, 'at the wall');
    // Its streak the law's at the speed it struck at (some 20.5 m of its 25) back along its way from
    // the wall, its tail drawn off its path by its share of the muzzle's offset, shrinking to none where
    // it joins its path: where it was aimed (the wall, cast from the eye), or where it struck if nearer.
    const shot = first.events.shots[0];
    const reach = Math.min(first.built.drawn[0].joinsM, hit.distance);
    expect(d.joinsM).toBeCloseTo(reach, 6);
    const back = Math.min(streakAt(hit.speed), hit.distance);
    expect(back).toBeGreaterThan(20);
    const share = 1 - (hit.distance - back) / reach;
    close(d.tail, [0, 1, 2].map((k) => hit.position[k] - hit.dir[k] * back + (shot.muzzle[k] - shot.origin[k]) * share), 4, 'tail');
    expect(length(d)).toBeLessThan(back);
    // Drawn once: the next frame has nothing.
    expect(frameOf(s, b).built.drawn).toHaveLength(0);
  });

  it("an M870 shot at 5 m: all 9 pellets drawn", () => {
    const s = shotgun(facing(5));
    const { events, built } = frameOf(s, new EffectsFrameBuilder(t), 1, true);
    expect(events.shots).toHaveLength(1);
    expect(events.impacts).toHaveLength(9);
    expect(built.counts.tracers).toBe(9);
    expect(built.drawn.every((d) => d.struck && d.kind === TRACER_KIND.red)).toBe(true);
    for (const [i, d] of built.drawn.entries()) {
      const hit = events.impacts[i];
      close(d.head, [hit.position[0], hit.position[1], hit.position[2] - t.tracerHeadM / 2], 4, `pellet ${i}`);
    }
  });

  it('a round that strikes a body is drawn to it, its head held off the body back along its way', () => {
    const s = facing(null);
    // A body across the line 6 m out from the eye (z 8 m): a stub, as a soldier's or a target's parts.
    s.rounds.bodies = (_owner, from, dir, length) => {
      const m = (8 - from[2]) / dir[2];
      return dir[2] > 0 && m >= 0 && m <= length ? { t: m, body: 200, zone: 'torso' } : null;
    };
    const { events, built } = frameOf(s, new EffectsFrameBuilder(t), 1, true);
    expect(events.hits).toHaveLength(1);
    expect(events.impacts).toHaveLength(0);
    expect(built.drawn).toHaveLength(1);
    const [d] = built.drawn;
    const hit = events.hits[0];
    expect(d.struck).toBe(true);
    close(d.head, [0, 1, 2].map((k) => hit.position[k] - hit.dir[k] * (t.tracerHeadM / 2)), 4, 'head');
    close(d.tail, events.shots[0].muzzle, 2, 'tail');
  });

  it('a strike the frame drained without a draw (a round that burns no tracer) draws nothing', () => {
    const s = facing(10);
    s.rounds.fire([12.8, 2, 2], [0, 0, 880], projectileSpec(tun, 'assault_rifle'), 0, false);
    const { events, built } = frameOf(s, new EffectsFrameBuilder(t));
    expect(events.impacts).toHaveLength(1);
    expect(events.impacts[0].draw).toBeUndefined();
    expect(built.counts.tracers).toBe(0);
  });
});

describe("every round fired is drawn (the shots spec's done row 1)", () => {
  it("an AK shot's round and all 9 of an M870's pellets, into walls 10 m and 25 m out and into the open, a tick a frame or two: each drawn in the frame it was fired in, every live round and every strike drawn in every frame", () => {
    for (const gun of ['ak74', 'm870'] as const) {
      for (const wallM of [10, 25, null]) {
        for (const ticks of [1, 2]) {
          const what = `${gun}, ${wallM === null ? 'the open' : `a wall ${wallM} m out`}, ${ticks} a frame`;
          const s = gun === 'm870' ? shotgun(facing(wallM)) : facing(wallM);
          const b = new EffectsFrameBuilder(t);
          const rounds = gun === 'm870' ? 9 : 1;
          let frame = frameOf(s, b, ticks, true);
          expect(frame.events.shots, what).toHaveLength(1);
          // Each round still flying after the frame's ticks, or struck within them: drawn either way.
          expect(frame.built.drawn, what).toHaveLength(rounds);
          let strikes = 0;
          let struck = 0;
          for (let f = 0; f < 60; f++) {
            const ended = frame.events.impacts.filter((i) => i.draw).length + frame.events.hits.filter((h) => h.draw).length;
            strikes += ended;
            struck += frame.built.drawn.filter((d) => d.struck).length;
            // Every round in the air drawn, and every one struck in the frame's ticks.
            expect(frame.built.counts.tracers, `${what}, frame ${f}`).toBe(s.rounds.count + ended);
            if (s.rounds.count === 0) break;
            frame = frameOf(s, b, ticks);
          }
          expect(s.rounds.count, what).toBe(0);
          // Each strike drawn once; into a wall, every round's flight ends at it.
          expect(struck, what).toBe(strikes);
          if (wallM !== null) expect(strikes, what).toBe(rounds);
        }
      }
    }
  });
});
