import { describe, expect, it } from 'vitest';
import { lineSource, type FrontSource } from '../../src/combat/front';
import type { ViewmodelPose } from '../../src/combat/viewmodel';
import { loadTunables, Tunables } from '../../src/core/tunables';
import { GUNS, type GunKey } from '../../src/net/gear';
import { idleIntent, Session, type CombatEvents, type ViewOffsets } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The camera's roll and shake (the shots spec's §3): felt with every shot, and honest. A round leaves
// the eye along the player's yaw and pitch plus the recoil's aim (and suppression's flinch), never
// along the view's roll or the shake, which are the camera's alone and drawn from a stream of their
// own: with them at their values or at 0, every round lands in the same voxel.
const TICK = 1 / 60;
const tun = loadTunables();
const PISTOLS: readonly GunKey[] = ['m17', 'pm'];

/** The tunables with the camera's roll and shake at 0 in every [viewkick.*] table. */
function cameraStill(): Tunables {
  const raw = tun.raw();
  for (const table of Object.values(raw.viewkick as Record<string, Record<string, unknown>>)) {
    for (const key of ['cam_roll_deg', 'cam_shake_m', 'cam_shake_deg', 'cam_shake_s']) if (key in table) table[key] = 0;
  }
  return new Tunables(raw);
}

/**
 * The tunables with a camera rolling and shaking through every shot: 20° a shot, settling over a
 * second, and a shake of 5 cm and 3° that lasts a second. At their values a shot's shake is over
 * before the next round leaves (0.06 s; the quickest gun fires every 0.075 s) and little of its roll
 * is left: here the camera is never still as a round leaves, so any of it in a round would show.
 */
function cameraWild(): Tunables {
  const raw = tun.raw();
  const wild: Record<string, number> = { cam_roll_deg: 20, cam_roll_settle_s: 1, cam_shake_m: 0.05, cam_shake_deg: 3, cam_shake_s: 1 };
  for (const table of Object.values(raw.viewkick as Record<string, Record<string, unknown>>)) {
    for (const [key, value] of Object.entries(wild)) if (key in table) table[key] = value;
  }
  return new Tunables(raw);
}

/** 25.6 × 6.4 × 51.2 m: a floor 0.4 m deep, and a clay wall at z 10–13 m (or none). */
function arena(wall: boolean): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  if (wall) map.fillBox(0, 4, 100, 256, 64, 130, P.CLAY);
  return map;
}

/** A player settled at the near end facing +z, `gun` up in the hands: a long gun carried first, a pistol second and brought up. */
function armed(gun: GunKey, t: Tunables = tun, at: { seed?: number; front?: FrontSource; wall?: boolean } = {}): Session {
  const s = Session.create({ map: arena(at.wall ?? true), plan: null, spawn: { position: [12.8, 0.4, 2] }, front: at.front }, t, at.seed ?? 7, 0);
  const pistol = PISTOLS.includes(gun);
  s.equip({ primary: pistol ? 'ak74' : gun, secondary: pistol ? gun : 'm17', fits: {} });
  s.intent = { ...idleIntent(), swap: pistol ? 1 : 0 };
  for (let k = 0; k < 60; k++) s.tick();
  s.intent = idleIntent();
  expect([s.arm.spec.gun.key, s.ready]).toEqual([gun, 1]);
  s.drainEvents();
  return s;
}

/** The trigger on tick `k`, as fast as the gun in the hands fires: held for an automatic, pressed every other tick for the rest. */
const pulled = (s: Session, k: number) => s.weapon.spec.automatic || k % 2 === 0;

describe("the camera's roll and shake", () => {
  it('move no round: a 30-round burst lands in the same voxels with them at their values, at 0, and rolling and shaking through every shot', () => {
    // The AK's magazine on full auto (the plan's burst), and the shotgun's tube and the SVD's
    // magazine, whose rolls are the heaviest (1.8° and 1.4°), each pressed as fast as it fires.
    for (const gun of ['ak74', 'm870', 'svd'] as const) {
      const fire = (t: Tunables) => {
        const s = armed(gun, t, { seed: 11 });
        const mag = s.weapon.spec.magazine;
        const shots: CombatEvents['shots'] = [];
        const impacts: string[] = [];
        const views: ViewOffsets[] = [];
        const muzzles: number[][] = [];
        const held: ViewmodelPose[] = [];
        /** The ticks (of the 400) that fired. */
        const fired: number[] = [];
        for (let k = 0; k < 400; k++) {
          s.intent = { ...idleIntent(), fire: s.weapon.shotsFired < mag && pulled(s, k) };
          s.tick();
          const e = s.drainEvents();
          shots.push(...e.shots);
          if (e.shots.length > 0) fired.push(k);
          for (const i of e.impacts) if (i.owner === 0) impacts.push(`${i.cell.join()}@${i.position.map((v) => v.toFixed(9)).join()}`);
          views.push(s.viewAt(1));
          muzzles.push(s.muzzle());
          held.push(s.viewmodelAt(1));
        }
        expect(s.weapon.shotsFired, gun).toBe(mag);
        return { s, shots, impacts, views, muzzles, held, fired };
      };
      const on = fire(tun);
      const off = fire(cameraStill());
      const wild = fire(cameraWild());
      // Every round leaves the same way, along the same aim, and strikes the same voxel at the same point.
      expect(on.shots.map((e) => [e.origin, e.dir]), gun).toEqual(off.shots.map((e) => [e.origin, e.dir]));
      expect(wild.shots.map((e) => [e.origin, e.dir]), gun).toEqual(off.shots.map((e) => [e.origin, e.dir]));
      expect(on.s.weapon.shotsFired, gun).toBe(on.shots.length);
      expect(on.impacts.length, gun).toBeGreaterThanOrEqual(on.shots.length * on.s.weapon.spec.pellets);
      expect(on.impacts, gun).toEqual(off.impacts);
      expect(wild.impacts, gun).toEqual(off.impacts);
      // The wild camera was shaking, and well rolled, whenever a round left after the first.
      const firing = wild.views.slice(wild.fired[0], wild.fired[wild.fired.length - 1] + 1);
      expect(wild.fired, gun).toHaveLength(wild.shots.length);
      expect(firing.length, gun).toBeGreaterThan(wild.shots.length);
      for (const v of firing) expect(v.shake.some((x) => x !== 0), gun).toBe(true);
      expect(firing.reduce((a, v) => a + Math.abs(v.roll), 0) / firing.length, gun).toBeGreaterThan(2);
      // All the while one camera rolled, a shot's whole roll on its tick, and shook; the other did neither.
      const rollDeg = on.s.viewKick.profile.camRollDeg;
      expect(rollDeg, gun).toBeGreaterThan(0);
      expect(Math.max(...on.views.map((v) => Math.abs(v.roll))), gun).toBeGreaterThan(0.99 * rollDeg);
      expect(on.views.filter((v) => v.shake.some((x) => x !== 0)).length, gun).toBeGreaterThanOrEqual(on.shots.length);
      for (const v of off.views) {
        expect(v.roll, gun).toBe(0);
        expect(v.shake, gun).toEqual([0, 0, 0]);
      }
      // The drawn gun is held in the view, so its muzzle (where a tracer and the flash start) rolls and
      // shakes with it: the rounds, from the eye, do not. Its pose in the view (the punch, the hands)
      // is the same either way: the camera's draws are its own stream's, and shift no other.
      expect(on.muzzles, gun).not.toEqual(off.muzzles);
      expect(on.held, gun).toEqual(off.held);
      expect(wild.held, gun).toEqual(off.held);
    }
  });

  it("under the heavy front, a whole magazine as fast as each gun fires (the automatics' on full auto): the view's roll is suppression's shake, the blast's and the camera's roll added, and stays within 3°", () => {
    for (const gun of GUNS) {
      const s = armed(gun, tun, { front: lineSource(22, 0.4), wall: false });
      s.front.intensity = 'heavy';
      for (let k = 0; k < 360 && s.suppression.level < 0.9; k++) s.tick();
      expect(s.suppression.level, gun).toBeGreaterThanOrEqual(0.9);
      const mag = s.weapon.spec.magazine;
      let worst = 0;
      let camera = 0;
      let shaken = 0;
      let calmest = 1;
      for (let k = 0; s.weapon.shotsFired < mag; k++) {
        expect(k, gun).toBeLessThan(1200);
        s.intent = { ...idleIntent(), fire: pulled(s, k) };
        s.tick();
        const v = s.viewAt(1);
        expect(v.roll, `${gun}, tick ${k}`).toBeCloseTo(s.suppression.shake.roll + s.blastShake.roll + s.viewKick.camRoll, 12);
        worst = Math.max(worst, Math.abs(v.roll));
        camera = Math.max(camera, Math.abs(s.viewKick.camRoll));
        shaken = Math.max(shaken, Math.abs(s.suppression.shake.roll));
        calmest = Math.min(calmest, s.suppression.level);
      }
      expect(worst, gun).toBeLessThanOrEqual(3);
      // Both shares were in it: the gun's whole roll, and suppression's shake, the magazine long under heavy fire.
      expect(camera, gun).toBeGreaterThanOrEqual(0.99 * s.viewKick.profile.camRollDeg);
      expect(shaken, gun).toBeGreaterThan(0.3);
      expect(calmest, gun).toBeGreaterThan(0.5);
    }
  });

  it("beside a shell's blast, an M870 firing at its rate under the heavy front: the camera is given its roll held within 3° on every tick and between them, though the shares add past it, and no round moves", () => {
    // A shell lands 2.2 m from the eye just before each shot, 1.5 m from the feet on fresh ground
    // about them. Its blast rolls the camera up to 1.4° either way at 11 Hz as it dies away; the shot
    // rolls it its whole 1.8° on its tick, to a side of its own; and suppression's shake adds up to
    // 0.6°. When they line up, as here (seed 11), they pass the spec's 3°. The camera is given their
    // sum held to [camera] roll_max_deg, which is the camera's alone: without it, every round leaves
    // and lands alike.
    const bound = tun.f('camera.roll_max_deg');
    expect(bound).toBe(3);
    /** viewAt's interpolation between two ticks' rolls, to its rounding. */
    const rounding = 1e-12;
    const fire = (t: Tunables) => {
      const s = armed('m870', t, { seed: 11, front: lineSource(22, 0.4), wall: false });
      // Looking 10° down, so the pellets strike the floor ahead (there is no wall, for the front's fire).
      s.player.pitch = -10;
      s.front.intensity = 'heavy';
      for (let k = 0; k < 360 && s.suppression.level < 0.9; k++) s.tick();
      expect(s.suppression.level).toBeGreaterThanOrEqual(0.9);
      const interval = 60 / s.weapon.spec.rpm;
      const mag = s.weapon.spec.magazine;
      const rolls: number[] = [];
      const sums: number[] = [];
      const shots: CombatEvents['shots'] = [];
      const impacts: string[] = [];
      // The tube, and a second more as the camera settles and the last pellets land.
      for (let k = 0; k < 400; k++) {
        // Pressed the tick the pump lets it fire, a shell landing beside the player just before.
        const pull = s.weapon.shotsFired < mag && s.weapon.sinceShot + TICK + 1e-9 >= interval;
        if (pull) {
          const around = (2 * Math.PI * s.weapon.shotsFired) / mag;
          const p = s.player.position;
          expect(s.land(p.x + 1.5 * Math.cos(around), p.z + 1.5 * Math.sin(around), 0.6, k), `shot ${s.weapon.shotsFired}`).not.toBeNull();
        }
        s.intent = { ...idleIntent(), fire: pull };
        s.tick();
        const e = s.drainEvents();
        shots.push(...e.shots);
        for (const i of e.impacts) if (i.owner === 0) impacts.push(`${i.cell.join()}@${i.position.map((v) => v.toFixed(9)).join()}`);
        sums.push(s.suppression.shake.roll + s.blastShake.roll + s.viewKick.camRoll);
        rolls.push(s.viewAt(1).roll);
        if (t === tun) for (const alpha of [0.25, 0.5, 0.75]) expect(Math.abs(s.viewAt(alpha).roll), `tick ${k}, ${alpha} on`).toBeLessThanOrEqual(bound + rounding);
      }
      expect(s.weapon.shotsFired).toBe(mag);
      return { shots, impacts, rolls, sums };
    };
    const held = fire(tun);
    // Every tick: the shares' sum, held to ±3°, the bound itself wherever the sum is past it.
    held.rolls.forEach((roll, k) => {
      expect(Math.abs(roll), `tick ${k}`).toBeLessThanOrEqual(bound + rounding);
      expect(roll, `tick ${k}`).toBeCloseTo(Math.max(-bound, Math.min(bound, held.sums[k])), 12);
    });
    // The shares did add past it: the bound was needed.
    expect(Math.max(...held.sums.map(Math.abs))).toBeGreaterThan(bound);
    expect(held.rolls.filter((r) => Math.abs(r) > bound - rounding).length).toBeGreaterThan(0);
    // Unbounded, the camera rolls past 3°, and every round leaves and lands as with the bound.
    const raw = tun.raw();
    (raw.camera as Record<string, unknown>).roll_max_deg = 1000;
    const free = fire(new Tunables(raw));
    free.rolls.forEach((roll, k) => expect(roll, `tick ${k}`).toBeCloseTo(free.sums[k], 12));
    expect(Math.max(...free.rolls.map(Math.abs))).toBeGreaterThan(bound);
    expect(free.shots.map((e) => [e.origin, e.dir])).toEqual(held.shots.map((e) => [e.origin, e.dir]));
    // Its pellets, about the aim within the gun's cone times its share, which suppression widens
    // (past the top step, 2.8): many strike the floor ahead, the rest leave the map.
    expect(held.shots).toHaveLength(7);
    expect(held.impacts.length).toBeGreaterThan(3 * held.shots.length);
    expect(free.impacts).toEqual(held.impacts);
  });

  it('the shake is gone 0.06 s after the last shot: the eye back where the view puts it, turned by the aim and suppression alone', () => {
    const s = armed('ak74');
    const still = { offset: [0, 0, 0], pitch: 0, yaw: 0 };
    // Three rounds on full auto, let go on the third's tick.
    s.intent = { ...idleIntent(), fire: true };
    let fired = 0;
    for (let k = 0; k < 60 && fired < 3; k++) {
      s.tick();
      fired += s.shots.length;
    }
    expect(fired).toBe(3);
    const last = s.ticks;
    expect(s.viewKick.shake).not.toEqual(still);
    s.intent = idleIntent();
    let shaking = 0;
    for (let k = 0; k < 30; k++) {
      s.tick();
      expect(s.shots).toHaveLength(0);
      const since = (s.ticks - last) * TICK;
      const v = s.viewAt(1);
      if (since < 0.06) {
        expect(v.shake, `${since} s after`).not.toEqual([0, 0, 0]);
        expect(s.viewKick.shake).not.toEqual(still);
        shaking++;
        continue;
      }
      expect(s.viewKick.shake, `${since} s after`).toEqual(still);
      expect(v.shake, `${since} s after`).toEqual([0, 0, 0]);
      const shake = s.suppression.shake;
      expect(v.yaw).toBeCloseTo(s.recoil.yaw + s.suppression.flinchYaw, 12);
      expect(v.pitch).toBeCloseTo(s.recoil.pitch + s.suppression.flinchPitch + shake.pitch + s.blastShake.pitch, 12);
    }
    // The ticks under 0.06 s after the last shot, at 60 Hz: three after its own.
    expect(shaking).toBe(3);
  });

  it('two sessions with the same intents give the same views, on the ticks and between them', () => {
    const run = () => {
      const s = armed('ak74', tun, { front: lineSource(22, 0.4), wall: false });
      s.front.intensity = 'heavy';
      const views: ViewOffsets[] = [];
      for (let k = 0; k < 300; k++) {
        s.intent = { ...idleIntent(), fire: k % 90 < 45, aim: k >= 180 };
        s.player.yaw = (s.player.yaw + 0.25) % 360;
        s.tick();
        for (const alpha of [0, 0.4, 1]) views.push(s.viewAt(alpha));
      }
      return views;
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(a.some((v) => v.shake.some((x) => x !== 0))).toBe(true);
    expect(a.some((v) => v.roll !== 0)).toBe(true);
  });
});
