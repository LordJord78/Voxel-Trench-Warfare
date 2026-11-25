import { describe, expect, it } from 'vitest';
import { CameraRig, rigTunables } from '../../src/app/camera-rig';
import { EffectsFrameBuilder, effectsTunables, flashDraw, NO_BATTLE, type ShownBattle } from '../../src/app/effects-frame';
import { farShellTunables } from '../../src/battle/far-shells';
import { fireFlames, firePlume, fireTunables, type Fire } from '../../src/battle/fires';
import { Wind, windTunables } from '../../src/battle/wind';
import { tracerTunables, type TracerState } from '../../src/battle/tracers';
import { flareTunables, type FlareState } from '../../src/battle/flares';
import { projectileSpec } from '../../src/combat/ballistics';
import { BILLBOARD_FLOATS, BLOOD_BILLBOARD, CASING_BILLBOARD, particleSpec, SMOKE_BILLBOARD } from '../../src/combat/particles';
import { RIFLE_MUZZLE, RIFLE_PORT } from '../../src/combat/rifle-model';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { BARE, decodeShotMark, encodeShotMark, GUNS, TRACER_KIND } from '../../src/net/gear';
import { GUN_DEFS, sightOf } from '../../src/combat/arsenal';
import { FLASH_CORE_BILLBOARD, MAX_BILLBOARDS, RIBBON_FLOATS } from '../../src/render/effects';
import { cameraBasis, projectToPixel } from '../../src/render/camera';
import { MAX_PUFFS } from '../../src/render/frame-uniforms';
import { HAZE_PUFFS } from '../../src/render/quality';
import { throughPose, type RiflePose } from '../../src/render/rifle';
import { Session, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// A frame's effects, built from the session and the events it drained: each shot's flash star and
// light for flash_s of the world's time, at the drawn rifle's muzzle; the tracers, drawn from the
// muzzle for the player's and joining the round's path; and the particles, the shot's own leaving
// the drawn rifle.
const tun = loadTunables();
const t = effectsTunables(tun);
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [], harms: [] });
type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: readonly number[]): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const close = (got: readonly number[], want: readonly number[], digits: number, what = '') => [0, 1, 2].forEach((k) => expect(got[k], `${what}[${k}]`).toBeCloseTo(want[k], digits));
/** A tracer's streak at `speed` (m/s): tracer_streak_s of its flight, between tracer_min_m and tracer_max_m. */
const streak = (speed: number) => Math.min(t.tracerMaxM, Math.max(t.tracerMinM, speed * t.tracerStreakS));

/** 25.6 × 6.4 × 51.2 m of open ground. */
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

/**
 * Walking at 144 frames a second, as the game draws it, until a shot leaves: that frame's events
 * and its drawn rifle (the review's case: the tick's muzzle centimetres from the drawn one).
 */
function walkAndShoot(): { s: Session; events: CombatEvents; rifle: RiflePose } {
  const s = stand();
  const rig = new CameraRig(rigTunables(tun));
  const frame = () => {
    s.advance(1 / 144);
    const rifle = rig.rifle(s, rig.pose(s, 1 / 144));
    return { rifle, events: s.drainEvents() };
  };
  s.intent = { ...s.intent, forward: 1 };
  for (let f = 0; f < 100; f++) frame();
  s.intent = { ...s.intent, fire: true };
  for (let f = 0; f < 30; f++) {
    const { rifle, events } = frame();
    if (events.shots.length > 0) {
      s.intent = { ...s.intent, fire: false };
      return { s, events, rifle };
    }
  }
  throw new Error('no shot');
}

/** The ribbon `i`'s tail and head. */
function ribbon(r: Float32Array, i: number): { tail: number[]; head: number[] } {
  const o = i * RIBBON_FLOATS;
  return { tail: [r[o], r[o + 1], r[o + 2]], head: [r[o + 4], r[o + 5], r[o + 6]] };
}

/** A shot's flash as its event says to draw it: from its tick and muzzle, a compensator's if its mark says so. */
const drawOf = (shot: CombatEvents['shots'][number]) => flashDraw(shot.tick, shot.muzzle, shot.mark !== undefined && decodeShotMark(shot.mark).comp, t);
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The flash's prongs, the frame's last `n` ribbons: each its way from the muzzle (unit) and its length. */
const prongsOf = (built: { frame: { ribbons: Float32Array; ribbonCount: number } }, n: number) =>
  Array.from({ length: n }, (_, k) => {
    const r = ribbon(built.frame.ribbons, built.frame.ribbonCount - n + k);
    const d = sub(r.head, r.tail);
    return { tail: r.tail, dir: unit(d), lengthM: Math.hypot(...d) };
  });

describe('a frame of effects', () => {
  it("a shot's flash star and light show for flash_s of the world's time, at 30, 60 or 144 frames a second, then not", () => {
    // The review's case: flash_frames frames were 33 ms at 60 Hz and 14 ms at 144 Hz.
    for (const rate of [30, 60, 144]) {
      const s = stand();
      const events = shoot(s);
      expect(events.shots.length).toBe(1);
      const b = new EffectsFrameBuilder(t);
      let built = b.build(s, events);
      // No rifle drawn: where the shot left it.
      expect(built.lights[0].position).toEqual(events.shots[0].muzzle);
      expect(built.lights[0].radiusM).toBe(t.flashLightRadiusM);
      expect(built.lights[0].intensity).toBe(t.flashLightIntensity);
      const prongs = drawOf(events.shots[0]).prongs.length;
      let frames = 0;
      while (built.lights.length > 0 && frames < 100) {
        expect(built.counts.stars).toBe(prongs);
        expect(built.counts.cores).toBe(1);
        frames++;
        s.advance(1 / rate);
        built = b.build(s, s.drainEvents());
      }
      expect(frames, `${rate} Hz`).toBe(Math.ceil(t.flashS * rate));
      expect(built.counts.stars).toBe(0);
      expect(built.counts.cores).toBe(0);
    }
  });

  it('a paused world holds its flash', () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    b.build(s, shoot(s));
    for (let k = 0; k < 10; k++) expect(b.build(s, none()).lights.length).toBe(1);
  });

  it("the flash's star and light are at the drawn rifle's muzzle, about its bore, and follow it while they show", () => {
    const { s, events, rifle } = walkAndShoot();
    const drawn = throughPose(rifle.toWorld, RIFLE_MUZZLE);
    const gap = Math.hypot(...sub(events.shots[0].muzzle, drawn));
    expect(gap).toBeGreaterThan(0.005);
    const b = new EffectsFrameBuilder(t);
    let built = b.build(s, events, rifle);
    expect(built.lights.length).toBe(1);
    close(built.lights[0].position, drawn, 5, 'light');
    const draw = drawOf(events.shots[0]);
    expect(built.counts.stars).toBe(draw.prongs.length);
    // Each prong from the drawn muzzle, its own length, at its own angle off the drawn bore.
    const bore = unit([rifle.toWorld[6], rifle.toWorld[7], rifle.toWorld[8]]);
    prongsOf(built, draw.prongs.length).forEach((p, k) => {
      close(p.tail, drawn, 5, `prong ${k}`);
      expect(p.lengthM, `prong ${k}`).toBeCloseTo(draw.prongs[k].lengthM, 4);
      expect(Math.acos(Math.min(1, dot(p.dir, bore))), `prong ${k}`).toBeCloseTo(draw.prongs[k].splay, 3);
    });
    // Its core: emissive, of its own kind (effects.wgsl draws it a peaked glow, white-hot in the middle and
    // gone at its rim, not a firm white ball), just out along the bore from the drawn muzzle, as wide as drawn.
    expect(FLASH_CORE_BILLBOARD).toBe(8);
    const out = built.frame.billboards;
    const cores = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS))).filter((q) => q[8] === FLASH_CORE_BILLBOARD && Math.abs(q[3] - draw.coreM / 2) < 1e-6);
    expect(cores.length).toBe(1);
    const ahead = sub(cores[0].slice(0, 3), drawn);
    expect(dot(ahead, bore)).toBeGreaterThan(0);
    expect(Math.hypot(...ahead)).toBeLessThan(draw.coreM / 2);
    expect(Math.hypot(...sub(ahead, bore.map((v) => v * dot(ahead, bore))))).toBeLessThan(1e-5);
    // Drawn elsewhere the next frame, the flash goes with it.
    const moved = new Float32Array(rifle.toWorld);
    moved[9] += 0.05;
    moved[10] -= 0.04;
    moved[11] += 0.03;
    built = b.build(s, none(), { toWorld: moved, prevToWorld: rifle.toWorld });
    expect(built.lights.length).toBe(1);
    close(built.lights[0].position, throughPose(moved, RIFLE_MUZZLE), 5, 'moved');
  });

  it("the shot's flash, brass and smoke leave the drawn rifle wherever it is drawn now, less where they were thrown: the flash and brass joining their own paths over particle_attach_s, the smoke kept where it was first drawn", () => {
    const { s, events, rifle } = walkAndShoot();
    // Where the simulation holds them: a twin's frame drawn with no rifle (the smoke takes its drift
    // when it is first drawn, so the same session is not drawn twice).
    const twin = walkAndShoot();
    const loose = new EffectsFrameBuilder(t).build(twin.s, twin.events).frame;
    const free = Array.from(loose.billboards.slice(0, loose.billboardCount * BILLBOARD_FLOATS));
    const b = new EffectsFrameBuilder(t);
    const built = b.build(s, events, rifle);
    const held = built.frame;
    // The shot's flash, casing and smoke, and after them its tracer's head and its flash's core.
    expect(built.counts.heads).toBe(1);
    expect(built.counts.cores).toBe(1);
    expect(held.billboardCount).toBe(5);
    // Thrown in the shot's tick and stepped once with it: 1 − smootherstep of its age over particle_attach_s.
    const u = 1 / 60 / t.particleAttachS;
    const share = 1 - u * u * u * (u * (u * 6 - 15) + 10);
    const drawnAt = (m: Float32Array) => ({ 1: throughPose(m, RIFLE_MUZZLE), [CASING_BILLBOARD]: throughPose(m, RIFLE_PORT), [SMOKE_BILLBOARD]: throughPose(m, RIFLE_MUZZLE) }) as Record<number, V3>;
    const want = (m: Float32Array, i: number, kind: number) => sub(drawnAt(m)[kind], s.particles.thrown(i)).map((d) => (kind === SMOKE_BILLBOARD ? d : d * share));
    const kinds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const o = i * BILLBOARD_FLOATS;
      const kind = held.billboards[o + 8];
      kinds.push(kind);
      const what = kind === 1 ? 'flash' : kind === CASING_BILLBOARD ? 'brass' : 'smoke';
      // The flash and the smoke were thrown where the shot left, its muzzle before its kick.
      if (kind !== CASING_BILLBOARD) close(s.particles.thrown(i), events.shots[0].muzzle, 9, what);
      expect(Math.hypot(...want(rifle.toWorld, i, kind)), what).toBeGreaterThan(0.005);
      close(sub(Array.from(held.billboards.slice(o, o + 3)), free.slice(o, o + 3)), want(rifle.toWorld, i, kind), 5, what);
    }
    expect(kinds).toEqual([1, CASING_BILLBOARD, SMOKE_BILLBOARD]);
    // The gun drawn elsewhere the next frame: the flash and brass go with it, the smoke stays.
    const moved = new Float32Array(rifle.toWorld);
    moved[9] += 0.05;
    moved[10] -= 0.04;
    moved[11] += 0.03;
    const next = b.build(s, none(), { toWorld: moved, prevToWorld: rifle.toWorld }).frame;
    for (let i = 0; i < 3; i++) {
      const o = i * BILLBOARD_FLOATS;
      close(sub(Array.from(next.billboards.slice(o, o + 3)), free.slice(o, o + 3)), want(kinds[i] === SMOKE_BILLBOARD ? rifle.toWorld : moved, i, kinds[i]), 5, `moved ${i}`);
    }
  });

  it("the SVD's kick (17 cm at its muzzle the frame its shot leaves) takes the shot's flash, brass and smoke and its tracer's start with the drawn gun: each leaves the drawn muzzle (the brass the port) within a few millimetres", () => {
    /** The SVD's shot's frame: a tick a frame, each drawn 0.99 of the way to the latest tick, so its kick is all but whole in it. */
    const svdShot = () => {
      const s = stand();
      s.equip({ primary: 'svd', secondary: 'm17', fits: {} });
      for (let k = 0; k < 120; k++) s.tick();
      s.drainEvents();
      const rig = new CameraRig(rigTunables(tun));
      s.advance(0.99 / 60);
      const frame = () => {
        s.advance(1 / 60);
        return { rifle: rig.rifle(s, rig.pose(s, 1 / 60)), events: s.drainEvents() };
      };
      for (let f = 0; f < 10; f++) frame();
      s.intent = { ...s.intent, fire: true };
      const shot = frame();
      s.intent = { ...s.intent, fire: false };
      return { s, ...shot };
    };
    const { s, rifle, events } = svdShot();
    expect(s.arm.spec.gun.key).toBe('svd');
    expect(events.shots).toHaveLength(1);
    const shot = events.shots[0];
    const muzzle = throughPose(rifle.toWorld, s.arm.spec.muzzle);
    const port = throughPose(rifle.toWorld, s.arm.spec.port);
    // The kick: the drawn muzzle far from where the shot left.
    const kick = Math.hypot(...sub(muzzle, shot.muzzle));
    expect(kick).toBeGreaterThan(0.12);
    // Where the simulation holds them: its twin's, drawn with no rifle.
    const twin = svdShot();
    const loose = new EffectsFrameBuilder(t).build(twin.s, twin.events).frame.billboards;
    const built = new EffectsFrameBuilder(t).build(s, events, rifle);
    const held = built.frame.billboards;
    const at = (b: Float32Array, i: number) => Array.from(b.slice(i * BILLBOARD_FLOATS, i * BILLBOARD_FLOATS + 3));
    const kinds = [0, 1, 2].map((i) => held[i * BILLBOARD_FLOATS + 8]);
    expect(kinds).toEqual([1, CASING_BILLBOARD, SMOKE_BILLBOARD]);
    const off: Record<string, number> = {};
    kinds.forEach((kind, i) => {
      // Its own flight since it was thrown, from where it is drawn from.
      const flight = sub(at(loose, i), s.particles.thrown(i));
      const from = kind === CASING_BILLBOARD ? port : muzzle;
      off[kind === 1 ? 'flash' : kind === CASING_BILLBOARD ? 'brass' : 'smoke'] = Math.hypot(...sub(at(held, i), from.map((v, k) => v + flight[k])));
    });
    // The tracer: its streak back to the muzzle in its first frame, drawn from the drawn muzzle.
    const path = s.rounds.tracerSegments(streak);
    const ahead = [0, 1, 2].map((k) => path.tail[k] - path.origin[k]);
    expect(built.drawn).toHaveLength(1);
    off.tracer = Math.hypot(...sub(built.drawn[0].tail, muzzle.map((v, k) => v + ahead[k])));
    expect(off, JSON.stringify({ kick, off })).toEqual({ flash: expect.any(Number), brass: expect.any(Number), smoke: expect.any(Number), tracer: expect.any(Number) });
    for (const [what, m] of Object.entries(off)) expect(m, `${what}: ${JSON.stringify({ kick, off })}`).toBeLessThan(0.003);
  });

  it('two shots in one frame show two stars and two lights', () => {
    const s = stand();
    const one = shoot(s);
    const two: CombatEvents = { ...none(), shots: [one.shots[0], { ...one.shots[0], tick: one.shots[0].tick + 1 }] };
    const built = new EffectsFrameBuilder(t).build(s, two);
    expect(built.counts.stars).toBe(drawOf(two.shots[0]).prongs.length + drawOf(two.shots[1]).prongs.length);
    expect(built.counts.cores).toBe(2);
    expect(built.lights.length).toBe(2);
  });

  it("a shot's flash is drawn from a hash of the shot (its tick and muzzle): a core 0.10–0.16 m across and 3 to 5 forward prongs 0.15–0.30 m long, each at its own roll, anywhere round the bore", () => {
    expect([t.flashCoreM, t.flashProngs, t.flashProngM]).toEqual([
      [0.1, 0.16],
      [3, 5],
      [0.15, 0.3],
    ]);
    const TAU = 2 * Math.PI;
    const seen = new Set<number>();
    const lengths = new Set<string>();
    // How many prongs roll into each twelfth of the turn about the bore.
    const sectors: number[] = new Array(12).fill(0);
    for (let tick = 0; tick < 300; tick++) {
      const d = flashDraw(tick, [12.8, 1.5, 2.3], false, t);
      expect(d.coreM).toBeGreaterThanOrEqual(0.1);
      expect(d.coreM).toBeLessThanOrEqual(0.16);
      expect(d.prongs.length).toBeGreaterThanOrEqual(3);
      expect(d.prongs.length).toBeLessThanOrEqual(5);
      seen.add(d.prongs.length);
      // Each its own roll about the bore, from the hash alone: spread round it (none bunched on another),
      // the spread itself turned at random.
      const rolls = d.prongs.map((p) => ((p.roll % TAU) + TAU) % TAU).sort((a, b) => a - b);
      const spacing = TAU / rolls.length;
      for (let k = 0; k < rolls.length; k++) {
        const next = k + 1 < rolls.length ? rolls[k + 1] : rolls[0] + TAU;
        expect(next - rolls[k], `tick ${tick}`).toBeGreaterThan(0.5 * spacing);
        sectors[Math.min(11, Math.floor(rolls[k] / (TAU / 12)))]++;
      }
      for (const p of d.prongs) {
        expect(p.lengthM).toBeGreaterThanOrEqual(0.15);
        expect(p.lengthM).toBeLessThanOrEqual(0.3);
        expect(p.splay).toBeGreaterThanOrEqual((t.flashProngSplayDeg[0] * Math.PI) / 180 - 1e-9);
        expect(p.splay).toBeLessThanOrEqual((t.flashProngSplayDeg[1] * Math.PI) / 180 + 1e-9);
        lengths.add(p.lengthM.toFixed(4));
      }
    }
    // Every count drawn, and lengths of every kind.
    expect([...seen].sort()).toEqual([3, 4, 5]);
    expect(lengths.size).toBeGreaterThan(200);
    // Every way round the bore, nothing kept clear: some 100 prongs in each twelfth of the turn.
    for (const [k, n] of sectors.entries()) expect(n, `rolls ${k * 30}°–${k * 30 + 30}°`).toBeGreaterThan(50);
    // Forward prongs (the spec's: a compensator's go to the sides "instead of the forward ones"): nearer
    // the bore than across it.
    expect(t.flashProngSplayDeg[0]).toBeGreaterThan(0);
    expect(t.flashProngSplayDeg[1]).toBeLessThan(45);
  });

  it("a bare gun's prongs roll about the drawn bore from the gun's own side toward its up, as the shot's hash drew them, wherever the eye is", () => {
    const { s, events, rifle } = walkAndShoot();
    const bore = unit([rifle.toWorld[6], rifle.toWorld[7], rifle.toWorld[8]]);
    const side = unit([rifle.toWorld[0], rifle.toWorld[1], rifle.toWorld[2]]);
    const up = unit([rifle.toWorld[3], rifle.toWorld[4], rifle.toWorld[5]]);
    const drawn = throughPose(rifle.toWorld, RIFLE_MUZZLE);
    const across = (v: readonly number[]) => unit(sub(v, bore.map((b) => b * dot(v, bore))));
    // The eye as the hip holds the gun (the session's, behind the muzzle and off its left), and as the
    // sights do (straight behind it and over it).
    const hip = [s.player.position.x, s.player.position.y + s.controller.eyeHeight(s.player), s.player.position.z];
    const aimed = [0, 1, 2].map((k) => drawn[k] - bore[k] * 0.4 + up[k] * 0.06);
    const towardHip = across(sub(hip, drawn));
    let nearHip = 0;
    for (let tick = 0; tick < 40; tick++) {
      const shot = { ...events.shots[0], tick };
      const draw = drawOf(shot);
      const n = draw.prongs.length;
      const fromHip = prongsOf(new EffectsFrameBuilder(t).build(s, { ...events, shots: [shot] }, rifle, hip), n);
      const fromSights = prongsOf(new EffectsFrameBuilder(t).build(s, { ...events, shots: [shot] }, rifle, aimed), n);
      fromHip.forEach((p, k) => {
        // The same prong from either eye.
        close(fromSights[k].dir, p.dir, 6, `tick ${tick}, prong ${k} aimed`);
        // Its roll, from the gun's side toward its up, the hash's.
        const a = across(p.dir);
        const roll = Math.atan2(dot(a, up), dot(a, side));
        const off = Math.abs(Math.atan2(Math.sin(roll - draw.prongs[k].roll), Math.cos(roll - draw.prongs[k].roll)));
        expect(off, `tick ${tick}, prong ${k}`).toBeLessThan(1e-4);
        // Nothing keeps a prong off the eye's line.
        if (Math.acos(Math.max(-1, Math.min(1, dot(a, towardHip)))) < (20 * Math.PI) / 180) nearHip++;
      });
    }
    expect(nearHip).toBeGreaterThan(0);
  });

  it("the forward prongs keep off the tracer's line from 3 m out (where G1's gate (a) measures its width), rolled any way: from the hip, the longest at the widest splay", () => {
    const s = stand();
    s.handsStill = true;
    const rig = new CameraRig(rigTunables(tun));
    let pose = rig.pose(s, 1 / 60);
    for (let f = 0; f < 30; f++) {
      s.advance(1 / 60);
      pose = rig.pose(s, 1 / 60);
    }
    const rifle = rig.rifle(s, pose);
    const muzzle = throughPose(rifle.toWorld, RIFLE_MUZZLE);
    const bore = unit([rifle.toWorld[6], rifle.toWorld[7], rifle.toWorld[8]]);
    const side = unit([rifle.toWorld[0], rifle.toWorld[1], rifle.toWorld[2]]);
    const up = unit([rifle.toWorld[3], rifle.toWorld[4], rifle.toWorld[5]]);
    // As npm run tracers photographs it: 1600 × 1000.
    const res: [number, number] = [1600, 1000];
    const px = (p: readonly number[]) => projectToPixel(pose, res, [p[0], p[1], p[2]])!;
    const { forward } = cameraBasis(pose.yaw, pose.pitch, pose.roll ?? 0);
    // Whether the round's path is joined at a man 30 m out (the tracers' near burst) or at the sky's
    // 150 m (tracer_converge_max_m): the tracer from the muzzle toward it, 3 to 10 m out.
    const splay = (t.flashProngSplayDeg[1] * Math.PI) / 180;
    const longest = t.flashProngM[1];
    let nearest = Infinity;
    for (const joinM of [30, tun.f('effects.tracer_converge_max_m')]) {
      const aim = [0, 1, 2].map((k) => pose.position[k] + forward[k] * joinM);
      const way = unit(sub(aim, muzzle));
      const a = px(muzzle.map((v, k) => v + way[k] * 3));
      const b = px(muzzle.map((v, k) => v + way[k] * 10));
      const toLine = (q: readonly number[]) => {
        const ab = [b[0] - a[0], b[1] - a[1]];
        const u = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1])));
        return Math.hypot(q[0] - a[0] - ab[0] * u, q[1] - a[1] - ab[1] * u);
      };
      for (let deg = 0; deg < 360; deg += 1) {
        const roll = (deg * Math.PI) / 180;
        const dir = [0, 1, 2].map((k) => bore[k] * Math.cos(splay) + (Math.cos(roll) * side[k] + Math.sin(roll) * up[k]) * Math.sin(splay));
        for (let u = 0.05; u <= 1.0001; u += 0.05) nearest = Math.min(nearest, toLine(px(muzzle.map((v, k) => v + dir[k] * longest * u))));
      }
    }
    // Twice the gate's widest (14 px): a run across the tracer that reached a prong would be at least that.
    expect(nearest).toBeGreaterThan(2 * 14);
  });

  it("a shot's flash is the same for the same shot, every frame it shows and in any builder, and another shot's is its own", () => {
    const at: V3 = [12.8, 1.5, 2.3];
    expect(flashDraw(40, at, false, t)).toEqual(flashDraw(40, at, false, t));
    const other = (d: ReturnType<typeof flashDraw>) => JSON.stringify(d) !== JSON.stringify(flashDraw(40, at, false, t));
    expect(other(flashDraw(41, at, false, t))).toBe(true);
    expect(other(flashDraw(40, [12.81, 1.5, 2.3], false, t))).toBe(true);
    // Built: the same ribbons from two builders, and from one frame to the next while it shows.
    const s = stand();
    const events = shoot(s);
    const a = new EffectsFrameBuilder(t);
    const first = a.build(s, events);
    const n = first.counts.stars;
    const rays = (built: typeof first) => prongsOf(built, n).map((p) => [...p.tail, ...p.dir, p.lengthM]);
    const once = rays(first);
    expect(rays(new EffectsFrameBuilder(t).build(s, events))).toEqual(once);
    s.advance(1 / 144);
    const next = a.build(s, s.drainEvents());
    expect(next.counts.stars).toBe(n);
    expect(rays(next)).toEqual(once);
  });

  it("a compensator's flash: two short prongs, 0.08–0.12 m, out to the gun's sides instead of the forward ones", () => {
    expect(t.flashCompProngM).toEqual([0.08, 0.12]);
    for (let tick = 0; tick < 50; tick++) {
      const d = flashDraw(tick, [12.8, 1.5, 2.3], true, t);
      expect(d.prongs.length).toBe(2);
      for (const p of d.prongs) {
        expect(p.lengthM).toBeGreaterThanOrEqual(0.08);
        expect(p.lengthM).toBeLessThanOrEqual(0.12);
      }
    }
    const { s, events, rifle } = walkAndShoot();
    const shot = events.shots[0];
    const mark = encodeShotMark({ tracer: true, kind: TRACER_KIND.red, suppressed: false, gun: 'm4', comp: true });
    const built = new EffectsFrameBuilder(t).build(s, { ...events, shots: [{ ...shot, mark, flash: 1.4 }] }, rifle);
    expect(built.counts.stars).toBe(2);
    expect(built.counts.cores).toBe(1);
    const bore = unit([rifle.toWorld[6], rifle.toWorld[7], rifle.toWorld[8]]);
    const side = unit([rifle.toWorld[0], rifle.toWorld[1], rifle.toWorld[2]]);
    const [left, right] = prongsOf(built, 2);
    for (const p of [left, right]) {
      // Out to the side more than along the bore, and not up or down off the gun's sides.
      expect(Math.abs(dot(p.dir, side))).toBeGreaterThan(0.9);
      expect(Math.abs(dot(p.dir, bore))).toBeLessThan(0.45);
      expect(p.lengthM).toBeLessThanOrEqual(0.12 + 1e-6);
    }
    // One to each side.
    expect(dot(left.dir, side) * dot(right.dir, side)).toBeLessThan(0);
    // Most of each lies inside the core: they keep flash_comp_tip of their light to their tips, where a
    // bare gun's prongs fade to nothing.
    const alphas = (built: { frame: { ribbons: Float32Array; ribbonCount: number } }, n: number) =>
      Array.from({ length: n }, (_, k) => {
        const o = (built.frame.ribbonCount - n + k) * RIBBON_FLOATS;
        return [built.frame.ribbons[o + 7], built.frame.ribbons[o + 11]];
      });
    expect(t.flashCompTip).toBeGreaterThan(0);
    for (const [tail, tip] of alphas(built, 2)) expect([tail, tip]).toEqual([1, expect.closeTo(t.flashCompTip, 6)]);
    const bare = new EffectsFrameBuilder(t).build(s, events, rifle);
    for (const [tail, tip] of alphas(bare, bare.counts.stars)) expect([tail, tip]).toEqual([1, 0]);
  });

  it("aimed down the sights, no prong's tip rises over the line of sight (the sight's height over the bore, in the gun's frame): the rolls skip the arc about the gun's up, flash_aimed_gap_deg (45°) either way or as wide as the shot's farthest-reaching prong needs, drawn from the same hash", () => {
    expect(t.flashAimedGapDeg).toBe(45);
    const TAU = 2 * Math.PI;
    const least = (t.flashAimedGapDeg * Math.PI) / 180;
    // Every sight the guns take: the AK's irons 0.0675 m over its bore (viewmodel.ts RIFLE_HOLDING), the
    // M870's 0.0375, a dot's 0.105, a pistol's.
    const sights = new Set<number>();
    for (const gun of GUNS) for (const optic of GUN_DEFS[gun].fits.optic) sights.add(sightOf(gun, { ...BARE, optic }).y);
    expect([...sights].sort()).toContain(0.0675);
    let widened = 0;
    for (const sight of sights) {
      for (let tick = 0; tick < 300; tick++) {
        const at: V3 = [12.8, 1.5 + tick * 0.003, 2.3];
        const hip = flashDraw(tick, at, false, t);
        const aimed = flashDraw(tick, at, false, t, sight);
        // The same shot: its core, its count, each prong's length and splay; only the rolls are moved.
        expect(aimed.coreM).toBe(hip.coreM);
        expect(aimed.prongs.map((p) => [p.lengthM, p.splay])).toEqual(hip.prongs.map((p) => [p.lengthM, p.splay]));
        const reach = Math.max(...hip.prongs.map((p) => p.lengthM * Math.sin(p.splay)));
        const gap = Math.max(least, reach > sight ? Math.acos(sight / reach) : 0);
        if (gap > least + 1e-9) widened++;
        const fromUp = (roll: number) => Math.abs(Math.atan2(Math.sin(roll - Math.PI / 2), Math.cos(roll - Math.PI / 2)));
        for (const p of aimed.prongs) {
          // Its tip, over the bore along the gun's up: under the line of sight.
          expect(p.lengthM * Math.sin(p.splay) * Math.sin(p.roll), `sight ${sight}, tick ${tick}`).toBeLessThanOrEqual(sight + 1e-12);
          expect(fromUp(p.roll), `sight ${sight}, tick ${tick}`).toBeGreaterThanOrEqual(gap - 1e-9);
        }
        // Still spread round the rest of the turn in the hash's order, none bunched on another.
        const order = (rolls: number[]) => rolls.map((r, k) => [((r - Math.PI / 2 - gap) % TAU + TAU) % TAU, k]).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
        expect(order(aimed.prongs.map((p) => p.roll))).toEqual(order(hip.prongs.map((p) => p.roll)));
        const spread = (TAU - 2 * gap) / aimed.prongs.length;
        const sorted = aimed.prongs.map((p) => ((p.roll - Math.PI / 2 - gap) % TAU + TAU) % TAU).sort((a, b) => a - b);
        for (let k = 1; k < sorted.length; k++) expect(sorted[k] - sorted[k - 1]).toBeGreaterThan(0.5 * spread);
      }
    }
    // The AK's irons widen it for its farthest-reaching prongs (0.30 m at 25°: 0.127 m out from the bore).
    expect(widened).toBeGreaterThan(100);
    // A compensator's side prongs are as they were: level with the bore.
    expect(flashDraw(7, [12.8, 1.5, 2.3], true, t, 0.0675)).toEqual(flashDraw(7, [12.8, 1.5, 2.3], true, t));
  });

  it("the shot's flash built aimed (the sights' blend 0.5 or more) keeps its prongs' tips under the line of sight in the drawn gun's frame; less aimed, the hash's rolls whole", () => {
    const s = stand();
    const rig = new CameraRig(rigTunables(tun));
    s.advance(0.99 / 60);
    const frame = () => {
      s.advance(1 / 60);
      return { rifle: rig.rifle(s, rig.pose(s, 1 / 60)), events: s.drainEvents() };
    };
    s.intent = { ...s.intent, aim: true };
    for (let f = 0; f < 90; f++) frame();
    expect(s.aimed).toBe(1);
    const sight = s.arm.spec.sight.y;
    expect(sight).toBe(0.0675);
    let shots = 0;
    for (let n = 0; n < 12; n++) {
      s.intent = { ...s.intent, fire: true };
      const { rifle, events } = frame();
      s.intent = { ...s.intent, fire: false };
      expect(events.shots).toHaveLength(1);
      const shot = events.shots[0];
      const muzzle = throughPose(rifle.toWorld, s.arm.spec.muzzle);
      const side = unit([rifle.toWorld[0], rifle.toWorld[1], rifle.toWorld[2]]);
      const up = unit([rifle.toWorld[3], rifle.toWorld[4], rifle.toWorld[5]]);
      const rollsOf = (aimed: number) => {
        s.aimed = aimed;
        const built = new EffectsFrameBuilder(t).build(s, events, rifle);
        s.aimed = 1;
        return built.flashes[0].tips.map((tip) => {
          const d = sub(tip, muzzle);
          // Its tip over the bore along the drawn gun's up.
          return { rise: dot(d, up), roll: Math.atan2(dot(d, up), dot(d, side)) };
        });
      };
      const want = (aimedSight?: number) => flashDraw(shot.tick, shot.muzzle, false, t, aimedSight).prongs.map((p) => p.roll);
      const angleOff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      for (const [aimed, rolls] of [[1, want(sight)], [0.5, want(sight)], [0.49, want()]] as const) {
        const got = rollsOf(aimed);
        expect(got.map((g, k) => angleOff(g.roll, rolls[k]))).toEqual(rolls.map(() => expect.closeTo(0, 6)));
        if (aimed >= 0.5) for (const g of got) expect(g.rise, `shot ${n}`).toBeLessThanOrEqual(sight + 1e-9);
      }
      shots++;
      for (let f = 0; f < 20; f++) frame();
    }
    expect(shots).toBe(12);
  });

  it("aimed, on the screen as the camera draws the flash's frames, no prong comes near the reticle: the shot's kick lifts the drawn gun over the eye's line (a tip at the line of sight in the gun's frame shows a few pixels over the screen's middle), but every prong passes 3% of the screen's height or more from its middle, where the hash's own rolls lay one across it", () => {
    // The hands' capture's aimed AK at 1600 × 1000: of 12 shots one tip showed 9.6 px over the middle.
    // That is the kick, not a prong up the tracer: aimed, it still lifts and pitches the drawn gun
    // (viewmodel.ts heldPose: kick.up × 0.6, kick.pitch × 0.5), so a tip held at the sight's height over
    // the bore in the gun's frame rises over the eye's line for the flash's frames, well aside of it.
    const res: [number, number] = [1600, 1000];
    const run = (tunables: typeof t) => {
      const s = stand();
      const rig = new CameraRig(rigTunables(tun));
      const b = new EffectsFrameBuilder(tunables);
      s.advance(0.5 / 60);
      const frame = () => {
        s.advance(1 / 60);
        const pose = rig.pose(s, 1 / 60);
        const events = s.drainEvents();
        return { pose, events, built: b.build(s, events, rig.rifle(s, pose)) };
      };
      s.intent = { ...s.intent, aim: true };
      for (let f = 0; f < 90; f++) frame();
      expect(s.aimed).toBe(1);
      let nearest = Infinity;
      let highest = -Infinity;
      let frames = 0;
      for (let n = 0; n < 24; n++) {
        s.intent = { ...s.intent, fire: true };
        let f = frame();
        for (let k = 0; k < 10 && f.events.shots.length === 0; k++) f = frame();
        s.intent = { ...s.intent, fire: false };
        expect(f.events.shots, `shot ${n}`).toHaveLength(1);
        // Each frame the shot's flash is drawn in (flash_s: two at 60 Hz).
        for (let own = f.built.flashes.find((x) => !x.remote); own; own = (f = frame()).built.flashes.find((x) => !x.remote)) {
          frames++;
          const a = projectToPixel(f.pose, res, own.at)!;
          const c = [res[0] / 2, res[1] / 2];
          for (const tip of own.tips) {
            const q = projectToPixel(f.pose, res, tip)!;
            highest = Math.max(highest, c[1] - q[1]);
            // The prong's drawn segment's nearest to the screen's middle.
            const d = [q[0] - a[0], q[1] - a[1]];
            const u = Math.max(0, Math.min(1, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1])));
            nearest = Math.min(nearest, Math.hypot(a[0] + d[0] * u - c[0], a[1] + d[1] * u - c[1]));
          }
        }
        for (let k = 0; k < 20; k++) frame();
        // A magazine's worth, then a fresh one (its reload run out aimed down).
        if (s.weapon.rounds === 0) for (let k = 0; k < 300 && s.weapon.rounds === 0; k++) frame();
      }
      return { nearest, highest, frames };
    };
    const aimed = run(t);
    expect(aimed.frames).toBeGreaterThanOrEqual(48);
    expect(aimed.nearest, JSON.stringify(aimed)).toBeGreaterThanOrEqual(0.03 * res[1]);
    // The kick's lift over the line: a little, for the flash's two frames.
    expect(aimed.highest, JSON.stringify(aimed)).toBeLessThan(0.03 * res[1]);
    // The hash's rolls whole (as from the hip), aimed: a prong lies across the reticle, far over the line.
    const whole = run({ ...t, flashAimedBlend: 2 });
    expect(whole.nearest, JSON.stringify(whole)).toBeLessThan(0.01 * res[1]);
    expect(whole.highest, JSON.stringify(whole)).toBeGreaterThan(0.03 * res[1]);
  });

  it("the flash's look numbers are [effects]'s: a prong's roll strays flash_prong_jitter (0.2) of a spread from its place, and the core is drawn flash_core_ahead (0.25) of its size out along the bore", () => {
    expect([t.flashProngJitter, t.flashCoreAhead]).toEqual([0.2, 0.25]);
    const TAU = 2 * Math.PI;
    // No stray: an even spread from the hash's turn.
    for (let tick = 0; tick < 50; tick++) {
      const rolls = flashDraw(tick, [12.8, 1.5, 2.3], false, { ...t, flashProngJitter: 0 }).prongs.map((p) => p.roll);
      for (let k = 1; k < rolls.length; k++) expect(rolls[k] - rolls[k - 1]).toBeCloseTo(TAU / rolls.length, 12);
    }
    const s = stand();
    const events = shoot(s);
    const shot = events.shots[0];
    const coreM = drawOf(shot).coreM;
    for (const ahead of [0.25, 0.6]) {
      const built = new EffectsFrameBuilder({ ...t, flashCoreAhead: ahead }).build(s, events);
      const out = built.frame.billboards;
      const core = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS))).find((q) => q[8] === FLASH_CORE_BILLBOARD)!;
      expect(Math.hypot(...sub(core.slice(0, 3), shot.muzzle))).toBeCloseTo(coreM * ahead, 5);
    }
  });

  it("a suppressed shot's flash is today's wisp: no core and no prongs, a glimmer of its light", () => {
    const s = stand();
    const events = shoot(s);
    const built = new EffectsFrameBuilder(t).build(s, { ...events, shots: [{ ...events.shots[0], flash: 0.12 }] });
    expect(built.counts.stars).toBe(0);
    expect(built.counts.cores).toBe(0);
    expect(built.lights.length).toBe(1);
    expect(built.lights[0].intensity).toBeCloseTo(t.flashLightIntensity * 0.12, 9);
  });

  it("the player's smoke, kept at the drawn muzzle a hand from the eye, takes own_smoke_flash_share (0.15, [effects]) of the shots' flash light: the frame gives its billboard that share for the light pass, and another's smoke takes it whole", () => {
    expect(t.ownSmokeFlashShare).toBe(0.15);
    const { s, events, rifle } = walkAndShoot();
    // Another's smoke, thrown where it is and not kept (Session.throwSmoke's, for a remote shot).
    s.particles.emit([12.8, 1.5, 8], [0, 0, 0], particleSpec(tun, 'muzzle_smoke'), 1);
    const smokes = (look: typeof t) => {
      const f = new EffectsFrameBuilder(look).build(s, events, rifle).frame;
      const out: number[] = [];
      for (let i = 0; i < f.billboardCount; i++) if (f.billboards[i * BILLBOARD_FLOATS + 8] === SMOKE_BILLBOARD) out.push(f.billboards[i * BILLBOARD_FLOATS + 9]);
      return out;
    };
    // The shot's own (thrown kept) first, then the other.
    const [own, other] = smokes(t);
    expect(own).toBeCloseTo(0.15, 6);
    expect(other).toBe(1);
    // The share is the tunable's.
    expect(smokes({ ...t, ownSmokeFlashShare: 0.6 })[0]).toBeCloseTo(0.6, 6);
    expect(smokes({ ...t, ownSmokeFlashShare: 1 })).toEqual([1, 1]);
  });

  it("a shot's flash under flash_star_min_share (0.5, [effects]) of a whole one draws no core and no star: the suppressor's 0.12 is under it, and the line moves with the tunable", () => {
    expect(t.flashStarMinShare).toBe(0.5);
    const s = stand();
    const events = shoot(s);
    const at = (share: number, least: number) => new EffectsFrameBuilder({ ...t, flashStarMinShare: least }).build(s, { ...events, shots: [{ ...events.shots[0], flash: share }] }).counts;
    // Today's line: 0.5 draws its star and core, a hair under it neither.
    expect(at(0.5, 0.5).cores).toBe(1);
    expect(at(0.5, 0.5).stars).toBeGreaterThanOrEqual(3);
    expect(at(0.49, 0.5)).toMatchObject({ cores: 0, stars: 0, lights: 1 });
    // The line moved: the suppressor's wisp drawn whole under 0.1, none over 0.13.
    expect(at(0.12, 0.1).cores).toBe(1);
    expect(at(0.12, 0.1).stars).toBeGreaterThanOrEqual(3);
    expect(at(0.12, 0.13)).toMatchObject({ cores: 0, stars: 0, lights: 1 });
  });

  it("the player's tracer leaves the muzzle and joins the round's path where it was aimed", () => {
    const s = stand();
    const origin: [number, number, number] = [12.8, 2.0, 2];
    const from: [number, number, number] = [12.98, 1.79, 3.16];
    // Aimed at something 20 m out.
    const aimedM = 20;
    s.rounds.fire(origin, [0, 0, 880], projectileSpec(tun, 'assault_rifle'), 0, true, { from, convergeM: aimedM });
    s.rounds.step(1 / 60);
    const b = new EffectsFrameBuilder(t);
    let built = b.build(s, none());
    expect(built.counts.tracers).toBe(1);
    const path = s.rounds.tracerSegments(streak);
    const offset = [from[0] - origin[0], from[1] - origin[1], from[2] - origin[2]];
    // Its ends, as its ribbons draw them: in its first frame lit in part way along, so two, one streak.
    const ribbons = Array.from({ length: built.frame.ribbonCount }, (_, i) => ribbon(built.frame.ribbons, i));
    const drawn = { tail: ribbons[0].tail, head: ribbons[ribbons.length - 1].head };
    const flown = path.flown[0];
    const length = Math.hypot(path.head[0] - path.tail[0], path.head[1] - path.tail[1], path.head[2] - path.tail[2]);
    for (const [end, at] of [['head', flown], ['tail', flown - length]] as const) {
      const share = Math.max(0, 1 - at / aimedM);
      const round = end === 'head' ? path.head : path.tail;
      for (let k = 0; k < 3; k++) expect(drawn[end][k]).toBeCloseTo(round[k] + offset[k] * share, 3);
    }
    // Past the convergence, on the round's path, its streak a frame's flight at its speed.
    for (let k = 0; k < 2; k++) s.rounds.step(1 / 60);
    built = b.build(s, none());
    const late = s.rounds.tracerSegments(streak);
    const on = ribbon(built.frame.ribbons, 0);
    for (let k = 0; k < 3; k++) {
      expect(on.head[k]).toBeCloseTo(late.head[k], 4);
      expect(on.tail[k]).toBeCloseTo(late.tail[k], 4);
    }
    const speed = Math.hypot(...s.rounds.velocity(0));
    expect(Math.hypot(on.head[0] - on.tail[0], on.head[1] - on.tail[1], on.head[2] - on.tail[2])).toBeCloseTo(speed * t.tracerStreakS, 3);
  });

  it("a blast's light flares and dies over blast_light_s of the world's time, a metre over where it landed", () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    const blast: CombatEvents = { ...none(), blasts: [{ tick: s.ticks, at: [12.8, 0.4, 20], radiusM: 3, material: P.SOD, crater: null }] };
    let built = b.build(s, blast);
    expect(built.blasts).toEqual([{ position: [12.8, 1.4, 20], radiusM: t.blastLightRadiusM, colour: t.blastLightColour, intensity: t.blastLightIntensity }]);
    // Half way, a quarter as bright; at the end, gone.
    const half = Math.round((t.blastLightS / 2) * 60);
    for (let k = 0; k < half; k++) s.tick();
    built = b.build(s, none());
    expect(built.blasts.length).toBe(1);
    expect(built.blasts[0].intensity).toBeCloseTo(t.blastLightIntensity * 0.25, 6);
    for (let k = 0; k < half; k++) s.tick();
    expect(b.build(s, none()).blasts).toEqual([]);
  });

  it("a paused world holds a blast's light", () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    b.build(s, { ...none(), blasts: [{ tick: s.ticks, at: [12.8, 0.4, 20], radiusM: 3, material: P.SOD, crater: null }] });
    for (let k = 0; k < 10; k++) expect(b.build(s, none()).blasts[0].intensity).toBe(t.blastLightIntensity);
  });

  it("a blast's smoke rises, spreads and thins, and is gone by smoke_s", () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    const crater = 3;
    let built = b.build(s, { ...none(), blasts: [{ tick: s.ticks, at: [12.8, 0.4, 20], radiusM: crater, material: P.SOD, crater: null }] });
    expect(built.smoke.length).toBe(t.smokePuffs);
    const start = built.smoke.map((p) => ({ ...p, centre: [...p.centre] }));
    for (const p of start) {
      expect(p.radiusM).toBeCloseTo(t.smokeRadiusScale * crater, 9);
      expect(p.density).toBeCloseTo(t.smokeDensity, 9);
      expect(Math.hypot(p.centre[0] - 12.8, p.centre[2] - 20)).toBeLessThanOrEqual(crater / 3 + 1e-9);
    }
    for (let k = 0; k < 5 * 60; k++) s.tick();
    built = b.build(s, none());
    expect(built.smoke.length).toBe(t.smokePuffs);
    built.smoke.forEach((p, i) => {
      expect(p.centre[1] - start[i].centre[1]).toBeCloseTo(t.smokeRiseMS * 5, 6);
      expect(p.radiusM - start[i].radiusM).toBeCloseTo(t.smokeSpreadMS * 5, 6);
      expect(p.density).toBeCloseTo(t.smokeDensity * (1 - 5 / t.smokeS) ** 2, 6);
    });
    for (let k = 0; k < (t.smokeS - 5) * 60; k++) s.tick();
    expect(b.build(s, none()).smoke).toEqual([]);
  });

  it("the haze takes 64 puffs, the nearest the eye, the blasts' and the fires' plumes together; the low preset 32", () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    // Farthest first, so the first 64 are not the nearest: 20 blasts' puffs, and 20 puffs of plumes between them.
    const blasts = Array.from({ length: 20 }, (_, k) => ({ tick: s.ticks, at: [12.8, 0.4, 100 - 4 * k] as V3, radiusM: 2.5, material: P.SOD, crater: null }));
    const plumes = Array.from({ length: 20 }, (_, k) => ({ centre: [15, 4, 98 - 4 * k] as V3, radiusM: 2, density: 0.15, alpha: 0.5 }));
    const eye: V3 = [12.8, 2, 0];
    const built = b.build(s, { ...none(), blasts }, null, eye, { ...NO_BATTLE, plumes });
    expect(MAX_PUFFS).toBe(64);
    expect(HAZE_PUFFS).toEqual({ high: 64, low: 32 });
    expect(built.smoke.length).toBe(MAX_PUFFS);
    const far = (p: { centre: readonly number[] }) => Math.hypot(p.centre[0] - eye[0], p.centre[1] - eye[1], p.centre[2] - eye[2]);
    const drawn = built.smoke.map(far);
    // Nearest first, and every plume puff nearer than the farthest taken is taken.
    expect(drawn).toEqual([...drawn].sort((x, y) => x - y));
    const taken = built.smoke.filter((p) => p.density === 0.15);
    expect(taken.length).toBe(plumes.filter((p) => far(p) <= Math.max(...drawn)).length);
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.length).toBeLessThan(plumes.length);
  });

  it("a fire's flames and embers are emissive billboards by its strength", () => {
    const ft = fireTunables(tun);
    const wind = new Wind(windTunables(tun), Rng.root(7).derive('battle.wind'));
    const fire: Fire = { id: 3, at: [14, 0.4, 20], t0: 0, burnS: 180, size: 0.8, hamlet: false };
    const drawn = (seconds: number) => {
      const flames = fireFlames(fire, seconds, wind, ft);
      const built = new EffectsFrameBuilder(t).build(stand(), none(), null, undefined, { ...NO_BATTLE, seconds, flames });
      const out = built.frame.billboards;
      const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
      return { flames, quads: flames.map((q) => all.find((b) => b[0] === Math.fround(q.centre[0]) && b[1] === Math.fround(q.centre[1]) && b[2] === Math.fround(q.centre[2]))!) };
    };
    // Half grown, and forty seconds on at full strength: the same moment of every flame's and ember's cycle.
    const half = drawn(ft.growS / 2);
    const full = drawn(ft.growS / 2 + 40);
    expect(full.flames).toHaveLength(ft.flames + ft.embers);
    full.flames.forEach((q, i) => {
      const b = full.quads[i];
      expect(b, `quad ${i}`).toBeDefined();
      expect(b[3]).toBeCloseTo(q.sizeM / 2, 6);
      for (let c = 0; c < 3; c++) expect(b[4 + c]).toBeCloseTo(ft.flameColour[c] * q.glow, 5);
      expect(b[7]).toBe(1);
      // Emissive: its own light.
      expect(b[8]).toBe(1);
      // By its strength: half as bright half grown.
      if (q.glow > 1e-3) expect(half.quads[i][4] / b[4]).toBeCloseTo(0.5, 4);
    });
  });

  it("a fire's plume is drawn as discs of dark smoke, lit, by its strength", () => {
    const fs = farShellTunables(tun);
    const plumes = [
      { centre: [14, 3, 20] as V3, radiusM: 1.5, density: 0.15, alpha: 0.5 },
      { centre: [15, 9, 21] as V3, radiusM: 3.5, density: 0.075, alpha: 0.25 },
    ];
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, undefined, { ...NO_BATTLE, plumes });
    const out = built.frame.billboards;
    const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    for (const p of plumes) {
      const [b] = all.filter((q) => q[0] === p.centre[0] && q[1] === p.centre[1] && q[2] === p.centre[2]);
      expect(b).toBeDefined();
      expect(b[3]).toBeCloseTo(p.radiusM, 6);
      for (let c = 0; c < 3; c++) expect(b[4 + c]).toBeCloseTo(fs.smokeColour[c] * p.alpha, 6);
      expect(b[7]).toBeCloseTo(p.alpha, 6);
      // Lit, as the far shells' smoke is.
      expect(b[8]).toBe(0);
    }
    // And in the haze.
    expect(built.smoke.map((p) => p.centre)).toEqual(plumes.map((p) => p.centre));
    // Drawn before the flames, so its smoke covers what is behind it and not a flame drawn earlier.
    const ft = fireTunables(tun);
    const wind = new Wind(windTunables(tun), Rng.root(7).derive('battle.wind'));
    const flames = fireFlames({ id: 1, at: [14, 0.4, 20], t0: 0, burnS: 180, size: 0.8, hamlet: false }, 60, wind, ft);
    const both = new EffectsFrameBuilder(t).build(stand(), none(), null, undefined, { ...NO_BATTLE, seconds: 60, plumes, flames });
    const kinds = Array.from({ length: both.frame.billboardCount }, (_, i) => both.frame.billboards[i * BILLBOARD_FLOATS + 8]);
    expect(kinds.lastIndexOf(0)).toBeLessThan(kinds.indexOf(1));
  });

  it("a burst hidden (hideBurst, the capture tool's control: the same frame without its burst): the particles' blood and sparks (a helmet's, the shots spec's blood) left out, everything else as it was, in order", () => {
    const s = stand();
    s.particles.emit([12.8, 1, 20], [0, 0, 0], particleSpec(tun, 'dust'), 2);
    s.bleed([12.8, 1.5, 20], [0, 0, 1], true, true);
    s.particles.emit([12.8, 1, 21], [0, 0, 0], particleSpec(tun, 'brass'), 1);
    const kindsOf = (b: EffectsFrameBuilder) => {
      const built = b.build(s, none(), null, undefined, { ...NO_BATTLE, flares: [{ position: [10, 30, 60], stage: 'burn', colour: [1, 0.9, 0.7], glow: 1 } as unknown as FlareState] });
      return Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(built.frame.billboards.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    };
    const shown = kindsOf(new EffectsFrameBuilder(t));
    expect(shown.filter((q) => q[8] === BLOOD_BILLBOARD)).toHaveLength(18 + 3);
    // Four sparks off the helmet, and the flare's disc after the particles: emissive both.
    expect(shown.filter((q) => q[8] === 1)).toHaveLength(4 + 1);
    const hiding = new EffectsFrameBuilder(t);
    hiding.hideBurst = true;
    const hidden = kindsOf(hiding);
    // The dust, the brass (a casing) and the flare's disc, as they were.
    expect(hidden).toEqual([...shown.slice(0, 2), shown[shown.length - 2], shown[shown.length - 1]]);
    expect(hidden.map((q) => q[8])).toEqual([0, 0, CASING_BILLBOARD, 1]);
  });

  it("the battle's billboards keep their allowance under a full pool", () => {
    const s = stand();
    s.particles.emit([12.8, 1, 20], [0, 0, 0], { ...particleSpec(tun, 'dust'), lifeS: 60 }, s.particles.capacity);
    expect(s.particles.count).toBe(s.particles.capacity);
    const b = new EffectsFrameBuilder(t);
    b.debug = Array.from({ length: 64 }, (_, k) => ({ position: [k * 0.2, 2, 5] as V3, size: 0.1, colour: [1, 1, 1] as V3 }));
    const ft = fireTunables(tun);
    const wind = new Wind(windTunables(tun), Rng.root(7).derive('battle.wind'));
    // Twelve fires at full strength and twelve dying down past the cap, sixteen flares burning, a
    // dozen far shells' columns of smoke.
    const fires = Array.from({ length: 24 }, (_, k) => ({ id: k, at: [k * 2, 0.4, 30] as V3, t0: 0, burnS: 180, size: 0.8, hamlet: false }));
    const flames = fires.flatMap((f) => fireFlames(f, 60, wind, ft));
    const plumes = fires.flatMap((f) => firePlume(f, 60, wind, ft));
    const flares: FlareState[] = Array.from({ length: 16 }, (_, k) => ({ id: k, position: [k * 3, 35, 120], glow: 1, stage: 'burning', colour: [1, 0.88, 0.7] }));
    const smoke = Array.from({ length: 96 }, (_, k) => ({ centre: [500 + k, 10 + 10 * (k % 8), 700] as V3, radiusM: 8, alpha: 0.85 }));
    const built = b.build(s, none(), null, undefined, { ...NO_BATTLE, seconds: 60, flares, smoke, flames, plumes });
    // The pool, the test quads, the battle's allowance, and a head for each tracer drawn.
    expect(MAX_BILLBOARDS).toBe(4096 + 64 + 1024 + 2048);
    expect(built.counts.billboards).toBe(s.particles.capacity + 64 + flares.length + smoke.length + flames.length + plumes.length);
    expect(b.debugAt).toBe(s.particles.capacity);
  });

  it("the session's particles are the frame's billboards, and its tracers' heads after them, then its flash's core", () => {
    const s = stand();
    const built = new EffectsFrameBuilder(t).build(s, shoot(s));
    expect(built.counts.heads).toBe(1);
    expect(built.counts.cores).toBe(1);
    expect(built.counts.billboards).toBe(s.particles.count + 2);
    expect(built.frame.billboardCount).toBe(s.particles.count + 2);
    // The head last, emissive and held to its pixels (kind 3), at its tracer's head as drawn (still
    // joining the round's path).
    const head = Array.from(built.frame.billboards.slice(s.particles.count * BILLBOARD_FLOATS, (s.particles.count + 1) * BILLBOARD_FLOATS));
    expect(head[8]).toBe(3);
    close(head, built.drawn[0].head, 5, 'head');
  });
  it('a flare climbing is a spark where it is, a burning flare a bright disc by its glow; one out is nothing', () => {
    const ft = flareTunables(tun);
    const b = new EffectsFrameBuilder(t);
    const s = stand();
    const flares: FlareState[] = [
      { id: 1, position: [10, 20, 30], glow: 0, stage: 'climb', colour: [1, 0.88, 0.7] },
      { id: 2, position: [40, 35, 60], glow: 0.5, stage: 'burning', colour: [1, 0.25, 0.15] },
      { id: 3, position: [70, 30, 90], glow: 0, stage: 'out', colour: [1, 0.88, 0.7] },
    ];
    const built = b.build(s, none(), null, undefined, { ...NO_BATTLE, flares });
    const out = built.frame.billboards;
    const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    const at = (p: readonly number[]) => all.filter((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2]);
    const [spark] = at(flares[0].position);
    expect(spark[3]).toBeCloseTo(ft.sparkSizeM / 2, 6);
    expect(spark[8]).toBe(1);
    expect(spark[4]).toBeCloseTo(ft.sparkGlow, 6);
    const [disc] = at(flares[1].position);
    expect(disc[3]).toBeCloseTo(ft.discSizeM / 2, 6);
    expect(disc[8]).toBe(1);
    expect(disc[4]).toBeCloseTo(ft.discGlow * 0.5, 6);
    expect(disc[5]).toBeCloseTo(ft.discGlow * 0.5 * 0.25, 6);
    expect(at(flares[2].position)).toEqual([]);
  });
  it("a far shell's flash is an emissive disc growing from 6 to 12 m over 0.2 s, gone after; a shell beyond the map draws none", () => {
    const fs = farShellTunables(tun);
    const shown = (seconds: number): ShownBattle => ({
      ...NO_BATTLE,
      seconds,
      flashes: [
        { id: 2, position: [3000, 16, 4000], t: 10.05, power: 1, far: false },
        { id: 1, position: [500, 20, 700], t: 10, power: 1, far: true },
      ],
    });
    const all = (seconds: number) => {
      const built = new EffectsFrameBuilder(t).build(stand(), none(), null, undefined, shown(seconds));
      const out = built.frame.billboards;
      return Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    };
    // 0.1 s in, halfway: 9 m across, standing on the ground, emissive, half as bright as it began.
    const half = all(10.1);
    expect(half.filter((q) => q[0] === 3000)).toEqual([]);
    const [flash] = half.filter((q) => q[0] === 500);
    expect(flash[3]).toBeCloseTo(4.5, 5);
    expect(flash[1]).toBeCloseTo(20 + 4.5, 5);
    expect(flash[2]).toBe(700);
    expect(flash[8]).toBe(1);
    for (let c = 0; c < 3; c++) expect(flash[4 + c]).toBeCloseTo(t.distantColour[c] * fs.flashGlow * 0.5, 5);
    expect(all(10.25).filter((q) => q[0] === 500)).toEqual([]);
    expect(fs.flashSizeM).toEqual([6, 12]);
  });

  it("its column's puffs are lit discs, premultiplied by their alpha", () => {
    const fs = farShellTunables(tun);
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, undefined, { ...NO_BATTLE, smoke: [{ centre: [510, 40, 705], radiusM: 5, alpha: 0.4 }] });
    const out = built.frame.billboards;
    const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    const [puff] = all.filter((q) => q[0] === 510);
    expect(puff.slice(0, 4)).toEqual([510, 40, 705, 5]);
    for (let c = 0; c < 3; c++) expect(puff[4 + c]).toBeCloseTo(fs.smokeColour[c] * 0.4, 6);
    expect(puff[7]).toBeCloseTo(0.4, 6);
    expect(puff[8]).toBe(0);
  });

  it("a battle tracer is a ribbon from its trail to its head, as the session's are", () => {
    const tracers: TracerState[] = [
      { id: 1, position: [50, 30, 80], velocity: [400, 0, 300], flown: 100 },
      { id: 2, position: [60, 31, 90], velocity: [0, 0, 500], flown: 3 },
    ];
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, [50, 20, 70], { ...NO_BATTLE, tracers });
    const r = built.frame.ribbons;
    expect(built.counts.battleTracers).toBe(2);
    const at = (i: number) => Array.from(r.slice(i * RIBBON_FLOATS, (i + 1) * RIBBON_FLOATS));
    // The nearer the eye first: the first, 10.4 m off; its streak a frame's flight at its 500 m/s
    // (as the session's, but at most the battle's trail_m) back along its way.
    const tt = tracerTunables(tun);
    expect(tt.trailM).toBe(24);
    const first = at(0);
    close(first.slice(4, 7), [50, 30, 80], 6, 'head');
    const back = streak(500);
    close(first.slice(0, 3), [50 - 0.8 * back, 30, 80 - 0.6 * back], 5, 'tail');
    // As wide as a tracer's glow.
    expect(first[3]).toBeCloseTo(t.tracerGlowWidthM, 6);
    expect(first[7]).toBeCloseTo(t.tracerTailAlpha, 6);
    expect(first[11]).toBe(1);
    for (let c = 0; c < 3; c++) expect(first[8 + c]).toBeCloseTo(t.tracerColour[c] * t.tracerIntensity, 4);
    // One just fired: its trail only as long as its flight.
    close(at(1).slice(0, 3), [60, 31, 87], 5, 'short tail');
  });

  it("at most max_drawn battle tracers, the nearest the eye, after the session's own", () => {
    const tt = tracerTunables(tun);
    const { s, events, rifle } = walkAndShoot();
    const eye: V3 = [0, 20, 0];
    const tracers: TracerState[] = Array.from({ length: tt.maxDrawn + 100 }, (_, i) => ({ id: i, position: [10 + i, 30, 0], velocity: [0, 0, 500], flown: 50 }));
    const built = new EffectsFrameBuilder(t).build(s, events, rifle, eye, { ...NO_BATTLE, tracers });
    expect(built.counts.battleTracers).toBe(tt.maxDrawn);
    // The session's own ribbons first: its tracer's (two in its first frame) and the star's.
    const own = built.frame.ribbonCount - built.counts.battleTracers;
    expect(own).toBeGreaterThan(built.counts.tracers + built.counts.stars - 1);
    const heads = Array.from({ length: built.counts.battleTracers }, (_, i) => ribbon(built.frame.ribbons, own + i).head[0]);
    expect(Math.max(...heads)).toBeLessThan(10 + tt.maxDrawn);
    expect(tt.maxDrawn).toBe(900);
  });

  it("a flare's spark and disc are dimmed by the sky's flares key, as its light is", () => {
    const ft = flareTunables(tun);
    const b = new EffectsFrameBuilder(t);
    const flares: FlareState[] = [
      { id: 1, position: [10, 20, 30], glow: 0, stage: 'climb', colour: [1, 0.88, 0.7] },
      { id: 2, position: [40, 35, 60], glow: 1, stage: 'burning', colour: [1, 0.88, 0.7] },
    ];
    const built = b.build(stand(), none(), null, undefined, { ...NO_BATTLE, flares }, 0.2);
    const out = built.frame.billboards;
    const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    const at = (p: readonly number[]) => all.find((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2])!;
    expect(at(flares[0].position)[4]).toBeCloseTo(ft.sparkGlow * 0.2, 6);
    expect(at(flares[1].position)[4]).toBeCloseTo(ft.discGlow * 0.2, 6);
  });
});
