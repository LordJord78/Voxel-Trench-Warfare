import { describe, expect, it, vi } from 'vitest';
import { aimedMoa, armSpec, type Loadout } from '../../src/combat/arsenal';
import { loadTunables } from '../../src/core/tunables';
import { BARE, decodeShotMark, encodeShotMark, SHOT_SHARES, TRACER_KIND, type Optic } from '../../src/net/gear';
import { decodeShot } from '../../src/net/protocol';
import { Stance, type MoveIntent } from '../../src/physics/character';
import { fromYawPitch } from '../../src/physics/vec';
import { idleIntent, Session, type ShotEvent } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { K, kindOf, P } from '../../src/world/materials';
import { sameWorld } from '../support/worlds';

// One shot, one set of chips (the shared-battle spec's "Edits: chips", and the plan's spec note 7):
// in a room the shooter flies its shot as its words say, and every other client flies those words;
// a shotgun's pellets come from the shot's seed, (its shooter's seat, the tick it left on), so the
// shooter's world and a receiver's take the same chips; and a suppressed round flies at the
// suppressor's velocity on both. A shotgun's pattern is about the aim (Task 5b): its first pellet
// leaves along it, the others within the gun's cone times the shot's share (aimed, the stance,
// suppression), put to the step its word carries, so the receiver spreads them alike.
const tun = loadTunables();
const TICK = 1 / 60;

/**
 * 25.6 × 6.4 × `lengthM` m: a sod floor 0.4 m deep under the player's first 6.4 m, and, if asked, a
 * sod wall from z 7 to 10 m, 5 m ahead of the player at (12.8, 0.4, 2) facing +z. Not clay: an m870
 * pellet carries at most 280 J (½ × 3.5 g × (400 m/s)²), and clay needs 286 (260 J × its 1.1).
 */
function arena(wall: boolean, lengthM = 51.2): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: Math.round(lengthM * 10) });
  map.fillBox(0, 0, 0, 256, 4, 64, P.SOD);
  if (wall) map.fillBox(0, 4, 70, 256, 64, 100, P.SOD);
  map.takeDirty();
  return map;
}

/** How the player holds the gun: a stance, the sights up or not, and suppression's level, set just before each shot. */
interface Posture {
  stance?: Stance;
  aim?: boolean;
  level?: number;
}

/** Idle, held as `p` says. */
function holding(p: Posture = {}): MoveIntent {
  return { ...idleIntent(), stance: p.stance ?? Stance.STANDING, aim: p.aim ?? false };
}

/** The M870 with `optic` fitted, the pistol second. */
function shotgun(optic: Optic = 'iron'): Loadout {
  return { primary: 'm870', secondary: 'm17', fits: { m870: { ...BARE, optic } } };
}

/**
 * A player on `map` (in a room unless `solo`; `seat` theirs, if given), settled a second held as
 * `posture`, with `loadout` in the hands. They stand off the millimetre grid, so a round that left
 * from their eye and not from their shot's words would show it.
 */
function stand(map: BrickMap, loadout: Loadout, seat?: number, at: { seed?: number; posture?: Posture; solo?: boolean } = {}): Session {
  const s = Session.create({ map, plan: null, spawn: { position: [12.8004, 0.4, 2.0007] }, waterTable: -1 }, tun, at.seed ?? 7, 0);
  s.room = !at.solo;
  if (seat !== undefined) s.seat = seat;
  s.equip(loadout);
  s.intent = holding(at.posture);
  for (let k = 0; k < 60; k++) s.tick();
  s.drainEvents();
  return s;
}

/** A pulls the trigger once, held as `posture` (suppression set to its level first): their shot's event and its aim, from that tick. */
function pull(a: Session, posture: Posture = {}): { shot: ShotEvent; aim: [number, number] } {
  if (posture.level !== undefined) a.suppression.level = posture.level;
  a.intent = { ...holding(posture), fire: true };
  a.tick();
  a.intent = holding(posture);
  const shots = a.drainEvents().shots;
  expect(shots).toHaveLength(1);
  expect(a.shots).toHaveLength(1);
  return { shot: shots[0], aim: a.shots[0].aim };
}

function fireOnce(a: Session, posture: Posture = {}): ShotEvent {
  return pull(a, posture).shot;
}

/** The shot's words, as the room relays them, fired on B as Together fires another's: owner 2 + their seat, at the shot's tick. */
function receive(b: Session, seat: number, shot: ShotEvent): void {
  const heard = decodeShot(shot.wire);
  expect(heard).not.toBeNull();
  const h = heard!;
  b.fireRemote(2 + seat, h.origin, h.dir, h.tracer, h.origin, h.mark, decodeShotMark(h.mark ?? 0).kind, h.tick);
}

/** The angle between two directions (minutes of arc). */
function moa(u: readonly number[], v: readonly number[]): number {
  const dot = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]));
  return (Math.acos(Math.min(1, dot)) * 180 * 60) / Math.PI;
}

/**
 * `shots` pulls of a solo M870 (`optic` fitted) held as `posture`, each a fresh press once the pump
 * lets it: each shot's share as its word says; how far (MOA) each shot's first pellet left from its
 * aim, as it left the muzzle; and each other pellet's, from the aim and from the first.
 */
function pattern(posture: Posture, optic: Optic = 'iron', shots = 6): { shares: number[]; first: number[]; others: number[]; fromFirst: number[] } {
  const s = stand(arena(false), shotgun(optic), undefined, { posture, solo: true });
  expect(s.aimed).toBe(posture.aim ? 1 : 0);
  expect(s.player.stance).toBe(posture.stance ?? Stance.STANDING);
  const fire = vi.spyOn(s.rounds, 'fire');
  const out = { shares: [] as number[], first: [] as number[], others: [] as number[], fromFirst: [] as number[] };
  for (let k = 0; k < shots; k++) {
    // Past the pump's 0.8 s.
    for (let t = 0; t < 50; t++) s.tick();
    fire.mockClear();
    const { shot, aim } = pull(s, posture);
    const v = fire.mock.calls.filter((c) => c[3] === 0).map((c) => c[1]);
    expect(v).toHaveLength(9);
    const along = fromYawPitch(aim[0], aim[1]);
    const a = [along.x, along.y, along.z];
    // Solo, the shot flies its aim itself: the first pellet exactly along it.
    expect(shot.dir).toEqual(a);
    out.shares.push(decodeShotMark(shot.mark!).share);
    out.first.push(moa(v[0], a));
    for (const d of v.slice(1)) {
      out.others.push(moa(d, a));
      out.fromFirst.push(moa(d, v[0]));
    }
  }
  s.drainEvents();
  return out;
}

const M870_MOA = 160;

describe("another's shot on every client", () => {
  it("another's shotgun shot chips the same voxels on the shooter's world and a receiver's", () => {
    const a = stand(arena(true), shotgun(), 2);
    // B is another page: its own session's seed, and it has heard another M870 shot first (seat 3,
    // another tick, straight up and away), so what it draws for A's depends on A's seat and tick alone.
    const b = stand(arena(true), shotgun(), undefined, { seed: 8 });
    const other = encodeShotMark({ tracer: true, kind: TRACER_KIND.blue, suppressed: false, gun: 'm870', share: 2 });
    b.fireRemote(5, [12.8, 2, 2], [0, 1, 0], true, [12.8, 2, 2], other, TRACER_KIND.blue, 17);
    for (let k = 0; k < 2; k++) b.tick();
    b.drainEvents();
    const shot = fireOnce(a);
    // Its words go with it, and its rounds left from what they say.
    expect(shot.wire).toBeDefined();
    const said = decodeShot(shot.wire)!;
    expect(shot.origin).toEqual(said.origin);
    expect(shot.dir).toEqual(said.dir);
    expect(shot.tick).toBe(said.tick);
    receive(b, 2, shot);
    for (let k = 0; k < 60; k++) {
      a.tick();
      b.tick();
    }
    // A pellet changes at most one voxel and the first flies along the shot's own direction, so a
    // second voxel changed is a seeded pellet's chip.
    const untouched = arena(true);
    const changed: number[] = [];
    for (let z = 0; z < 512; z++) {
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 256; x++) {
          if (a.map.get(x, y, z) !== untouched.get(x, y, z)) changed.push(a.map.get(x, y, z));
        }
      }
    }
    expect(changed.length).toBeGreaterThanOrEqual(2);
    expect(changed.every((p) => kindOf(p) === K.SPOIL)).toBe(true);
    expect(sameWorld(a.map, b.map)).toBe(true);
  });

  it('a suppressed rifle shot flies on the receiver\'s world as on the shooter\'s', () => {
    // 410 m of open air beyond the floor: the round's first 20 ticks (a third of a second) are 290 m.
    const kitted: Loadout = { primary: 'm4', secondary: 'm17', fits: { m4: { optic: 'reddot', muzzle: 'suppressor', under: 'none', side: 'none' } } };
    const a = stand(arena(false, 409.6), kitted, 3);
    const b = stand(arena(false, 409.6), kitted);
    const shot = fireOnce(a);
    expect(decodeShotMark(shot.mark!)).toMatchObject({ gun: 'm4', suppressed: true });
    // The shooter's round stepped once in the tick it left on; the receiver's steps once in its next.
    receive(b, 3, shot);
    b.tick();
    expect(a.rounds.count).toBe(1);
    expect(b.rounds.count).toBe(1);
    expect(b.rounds.position(0)).toEqual(a.rounds.position(0));
    expect(b.rounds.velocity(0)).toEqual(a.rounds.velocity(0));
    // At the suppressor's velocity, 0.97 of the bare gun's 905 m/s, less a tick's drag (under 2%).
    const v = b.rounds.velocity(0);
    expect(Math.hypot(v[0], v[1], v[2])).toBeLessThan(0.97 * 905);
    expect(Math.hypot(v[0], v[1], v[2])).toBeGreaterThan(0.98 * 0.97 * 905);
    for (const [upTo, steps] of [[5, 4], [20, 15]]) {
      for (let k = 0; k < steps; k++) {
        a.tick();
        b.tick();
      }
      expect(b.rounds.count, `${upTo} ticks`).toBe(1);
      expect(b.rounds.position(0), `${upTo} ticks`).toEqual(a.rounds.position(0));
      expect(b.rounds.velocity(0), `${upTo} ticks`).toEqual(a.rounds.velocity(0));
    }
  });
});

describe("another's shot flown silent (a backlog, more than SILENT_STEP_S old)", () => {
  it('draws no tracer, flashes and says nothing, cracks nothing and suppresses no one; it chips and strikes as one flown aloud', () => {
    // Another's AK round passing half a metre from B's eye, into the sod wall 5 m ahead: once flown
    // aloud, once silent, each on a page of its own.
    const page = (silent: boolean) => {
      const b = stand(arena(true), shotgun());
      const p = b.player;
      const eye = [p.position.x, p.position.y + b.controller.eyeHeight(p), p.position.z];
      const origin: [number, number, number] = [eye[0] + 0.5, eye[1], 0.5];
      const mark = encodeShotMark({ tracer: true, kind: TRACER_KIND.blue, suppressed: false, gun: 'ak74' });
      const particles = b.particles.count;
      b.fireRemote(5, origin, [0, 0, 1], true, origin, mark, TRACER_KIND.blue, 40, silent);
      const flashed = b.particles.count - particles;
      const tracer = b.rounds.count === 1 && b.rounds.isTracer(0);
      const events = [];
      for (let k = 0; k < 30; k++) {
        b.tick();
        events.push(b.drainEvents());
      }
      return { b, flashed, tracer, events };
    };
    const aloud = page(false);
    const silent = page(true);
    expect(aloud.tracer).toBe(true);
    expect(aloud.flashed).toBeGreaterThan(0);
    expect(aloud.events.flatMap((e) => e.remoteShots)).toHaveLength(1);
    expect(aloud.events.flatMap((e) => e.cracks).length).toBeGreaterThan(0);
    expect(aloud.b.suppression.level).toBeGreaterThan(0);
    expect(aloud.events.flatMap((e) => e.impacts)).toHaveLength(1);
    expect(silent.tracer).toBe(false);
    expect(silent.flashed).toBe(0);
    expect(silent.events.flatMap((e) => e.remoteShots)).toEqual([]);
    expect(silent.events.flatMap((e) => e.cracks)).toEqual([]);
    expect(silent.b.suppression.level).toBe(0);
    // Its strike is there, unheard (the audio plan skips it); and the same chip in the same world.
    const [impact] = silent.events.flatMap((e) => e.impacts);
    expect(impact).toMatchObject({ silent: true, kind: TRACER_KIND.none });
    expect(sameWorld(aloud.b.map, silent.b.map)).toBe(true);
    expect(sameWorld(silent.b.map, arena(true))).toBe(false);
  });

  it("the round pool's room for others' shots, up to three quarters of it (the rest the player's own and the front's), and the rounds another's shot takes: its gun's pellets, one without a word", () => {
    const b = stand(arena(true), shotgun());
    const capacity = tun.i('ballistics.pool_capacity');
    expect(tun.f('ballistics.others_fill')).toBe(0.75);
    const share = Math.floor(0.75 * capacity);
    expect(b.roundRoom()).toBe(share);
    expect(b.shotRounds()).toBe(1);
    expect(b.shotRounds(encodeShotMark({ tracer: false, kind: 0, suppressed: false, gun: 'ak74' }))).toBe(1);
    expect(b.shotRounds(encodeShotMark({ tracer: false, kind: 0, suppressed: true, gun: 'm870', share: 1 }))).toBe(tun.i('weapon.m870.pellets'));
    b.fireRemote(5, [12.8, 2, 2], [0, 1, 0], false, [12.8, 2, 2], encodeShotMark({ tracer: false, kind: 0, suppressed: false, gun: 'm870', share: 1 }), undefined, 17);
    expect(b.roundRoom()).toBe(share - tun.i('weapon.m870.pellets'));
    // Every round in the pool counts against it (the player's own and the front's too): past three
    // quarters full, it is none, never less; the pool itself still has the rest.
    for (let k = b.rounds.count; k < share + 10; k++) b.fireRemote(5, [12.8, 2, 2], [0, 1, 0], false, [12.8, 2, 2]);
    expect(b.rounds.count).toBe(share + 10);
    expect(b.roundRoom()).toBe(0);
    expect(b.rounds.room).toBe(capacity - share - 10);
  });
});

describe("a shotgun's pattern is the aim's", () => {
  // The M870's cone is 160 MOA; aimed, its share is ads_spread 0.8, put to the step 0.7. Before Task
  // 5b the first pellet carried the stance's cone and the other eight spread about it by the whole
  // 160 MOA, whatever the aim: from the hip up to 320 MOA off it, and aiming tightened nothing.
  it('aimed and standing: the first pellet leaves along the aim, and every other within 128 MOA of it (its step, 0.7 of 160)', () => {
    expect(tun.f('weapon.m870.dispersion_moa')).toBe(M870_MOA);
    expect(tun.f('weapon.m870.ads_spread')).toBe(0.8);
    const p = pattern({ aim: true });
    expect(p.shares).toEqual(Array(6).fill(0.7));
    for (const f of p.first) expect(f).toBeLessThan(1e-3);
    expect(Math.max(...p.others)).toBeLessThanOrEqual(128);
    expect(Math.max(...p.others)).toBeLessThanOrEqual(M870_MOA * 0.7);
    // Its edge reached: 48 pellets uniform over the cone's disc.
    expect(Math.max(...p.others)).toBeGreaterThan(0.9 * M870_MOA * 0.7);
  });

  it("from the hip: every pellet within the gun's 160 MOA of the aim", () => {
    const p = pattern({});
    expect(p.shares).toEqual(Array(6).fill(1));
    for (const f of p.first) expect(f).toBeLessThan(1e-3);
    expect(Math.max(...p.others)).toBeLessThanOrEqual(M870_MOA);
    expect(Math.max(...p.others)).toBeGreaterThan(0.9 * M870_MOA);
  });

  it('prone and aimed: tighter than standing and aimed (0.38 × 0.8, put to 0.35)', () => {
    const prone = pattern({ stance: Stance.PRONE, aim: true });
    const standing = pattern({ aim: true });
    expect(prone.shares).toEqual(Array(6).fill(0.35));
    for (const f of prone.first) expect(f).toBeLessThan(1e-3);
    expect(Math.max(...prone.others)).toBeLessThanOrEqual(M870_MOA * 0.35);
    expect(Math.max(...prone.others)).toBeLessThan(0.6 * Math.max(...standing.others));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(prone.others)).toBeLessThan(0.6 * mean(standing.others));
  });

  it("suppressed: wider than unsuppressed, the whole pattern about the aim and not its first pellet alone", () => {
    // Suppression's level 0.32 (less a tick's decay) makes its cone's scale 2.0 of the calm one's.
    const p = pattern({ level: 0.32 });
    const calm = pattern({});
    expect(p.shares).toEqual(Array(6).fill(2));
    for (const f of p.first) expect(f).toBeLessThan(1e-3);
    expect(Math.max(...p.others)).toBeLessThanOrEqual(2 * M870_MOA);
    // Past the calm hip's whole cone, about the aim and about the first pellet alike.
    expect(Math.max(...p.others)).toBeGreaterThan(M870_MOA);
    expect(Math.max(...p.fromFirst)).toBeGreaterThan(M870_MOA);
    expect(Math.max(...p.others)).toBeGreaterThan(1.5 * Math.max(...calm.others));
  });

  it('a single-round gun keeps its own cone: the round is drawn within it, and its word says no share', () => {
    const s = stand(arena(false), { primary: 'm4', secondary: 'm17', fits: {} }, undefined, { solo: true });
    let off = 0;
    for (let k = 0; k < 8; k++) {
      for (let t = 0; t < 10; t++) s.tick();
      const { shot, aim } = pull(s);
      expect((shot.mark! >> 9) & 7).toBe(0);
      const along = fromYawPitch(aim[0], aim[1]);
      const m = moa(shot.dir, [along.x, along.y, along.z]);
      expect(m).toBeLessThanOrEqual(s.weapon.spec.dispersionMoa * armSpec(tun, 'm4', BARE).hipSpread + 1e-9);
      off = Math.max(off, m);
    }
    expect(off).toBeGreaterThan(0);
  });

  it('a receiver flies the same pellets as the shooter at every step of the share, to the last bit after 1, 5 and 20 ticks', () => {
    // A held eight ways, one for each step: prone and aimed through the holo (0.38 × 0.8 × 0.9), and
    // through the irons; crouched and aimed; standing and aimed; from the hip; and from the hip under
    // suppression's 1.4, 2.0 and full 4.2 (past the top: 2.8).
    const ways: [number, Posture, Optic][] = [
      [0.25, { stance: Stance.PRONE, aim: true }, 'holo'],
      [0.35, { stance: Stance.PRONE, aim: true }, 'iron'],
      [0.5, { stance: Stance.CROUCHED, aim: true }, 'iron'],
      [0.7, { aim: true }, 'iron'],
      [1, {}, 'iron'],
      [1.4, { level: 0.14 }, 'iron'],
      [2, { level: 0.32 }, 'iron'],
      [2.8, { level: 1 }, 'iron'],
    ];
    expect(ways.map((w) => w[0]).sort()).toEqual([...SHOT_SHARES].sort());
    for (const [share, posture, optic] of ways) {
      // 128 m of open air beyond the floor: a pellet's first 20 ticks are about 105 m.
      const a = stand(arena(false, 128), shotgun(optic), 2, { posture });
      const b = stand(arena(false, 128), shotgun(optic), undefined, { seed: 8 });
      const shot = fireOnce(a, posture);
      expect(decodeShotMark(shot.mark!).share, `${share}`).toBe(share);
      receive(b, 2, shot);
      b.tick();
      const flown = (s: Session) => Array.from({ length: s.rounds.count }, (_, k) => [s.rounds.position(k), s.rounds.velocity(k)]);
      expect(a.rounds.count, `${share}`).toBe(9);
      expect(flown(b), `${share}, 1 tick`).toEqual(flown(a));
      for (const [upTo, steps] of [[5, 4], [20, 15]]) {
        for (let k = 0; k < steps; k++) {
          a.tick();
          b.tick();
        }
        expect(b.rounds.count, `${share}, ${upTo} ticks`).toBeGreaterThan(0);
        expect(flown(b), `${share}, ${upTo} ticks`).toEqual(flown(a));
      }
    }
  });
});

describe('what the player is shown of a shotgun', () => {
  it("the reticle's cone is the pattern's, the gun's cone times its share's step, and the loadout's aimed figure is the same pattern's", () => {
    const cone = M870_MOA / 60;
    const hip = stand(arena(false), shotgun(), undefined, { solo: true });
    expect(hip.coneDeg()).toBeCloseTo(cone, 12);
    // Suppression's 2.02 is put to the step 2.0, as its next shot's word would say.
    hip.suppression.level = 0.32;
    expect(hip.coneDeg()).toBeCloseTo(cone * 2, 12);
    const aimed = stand(arena(false), shotgun(), undefined, { posture: { aim: true }, solo: true });
    expect(aimed.aimed).toBe(1);
    expect(aimed.coneDeg()).toBeCloseTo(cone * 0.7, 12);
    expect(aimed.coneDeg() * 60).toBeCloseTo(aimedMoa(armSpec(tun, 'm870', BARE)), 9);
    const prone = stand(arena(false), shotgun(), undefined, { posture: { stance: Stance.PRONE, aim: true }, solo: true });
    expect(prone.coneDeg()).toBeCloseTo(cone * 0.35, 12);
    // A bullet's stays its own, unstepped: the M4's 3.0 MOA times its ads_spread.
    const m4 = stand(arena(false), { primary: 'm4', secondary: 'm17', fits: {} }, undefined, { posture: { aim: true }, solo: true });
    expect(m4.coneDeg()).toBeCloseTo((m4.weapon.spec.dispersionMoa / 60) * armSpec(tun, 'm4', BARE).adsSpread, 12);
    expect(m4.coneDeg() * 60).toBeCloseTo(aimedMoa(armSpec(tun, 'm4', BARE)), 9);
  });
});

describe("another's suppressed shot heard", () => {
  it("at the suppressor's report_gain ([attachment.suppressor]), as the player's own suppressed gun is: never a number of the session's own", () => {
    const b = stand(arena(false), shotgun());
    const origin: [number, number, number] = [12.8, 1.9, 0.5];
    for (const suppressed of [false, true]) {
      const mark = encodeShotMark({ tracer: false, kind: TRACER_KIND.none, suppressed, gun: 'svd' });
      b.fireRemote(5, origin, [0, 0, 1], false, origin, mark, TRACER_KIND.none, 40, false);
    }
    const [bare, quiet] = b.drainEvents().remoteShots;
    expect(bare.report).toBe(1);
    expect(quiet.report).toBe(tun.f('attachment.suppressor.report_gain'));
    expect(quiet.report).toBe(armSpec(tun, 'svd', { ...BARE, muzzle: 'suppressor' }).report);
  });
});
