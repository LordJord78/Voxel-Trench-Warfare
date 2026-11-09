import { describe, expect, it } from 'vitest';
import { rangeAllowed, RangeView } from '../../src/app/range';
import { projectileSpec } from '../../src/combat/ballistics';
import { FIRST_DUMMY, plateCentre, plateVoxels, rangeLayout, rangeTunables, type RangeEvent, type RangeSpot } from '../../src/combat/range';
import { toWorld, type Zone } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { GUNS } from '../../src/net/gear';
import { idleIntent, Session, type CombatEvents } from '../../src/sim/session';
import { Readout, readoutLines, readoutText } from '../../src/ui/readout';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The range in the app (the shots spec's §5): written into the world at the click and taken out
// exactly, its dummies drawn as soldiers and given to the session as targets, the player's rounds
// into them and into its plates read as the range's events, and the HUD's readout of them.
const tun = loadTunables();
const t = rangeTunables(tun);
const AK = projectileSpec(tun, 'assault_rifle');
const VOXEL = 0.1;

/** The spawn: in a bay along x, facing +z. */
const SPAWN = { position: [16, 0.4, 5] as [number, number, number], bay: { longAxis: 0 as const, facing: 1 as const } };
/** The eye the range is sighted from: a standing player's over the spawn (the field has no step). */
const EYE: [number, number, number] = [16, 0.4 + 1.62, 5];

/**
 * 32 × 6.4 × 166.4 m of sod 0.4 m deep, the spawn at (16, 0.4, 5) facing +z: every spot of the range
 * lies on it, as far as 150 m out and 15 m either side. The player stands at the spawn, settled.
 */
function field(edit?: (map: BrickMap) => void): Session {
  const map = new BrickMap({ x: 320, y: 64, z: 1664 });
  map.fillBox(0, 0, 0, 320, 4, 1664, P.SOD);
  edit?.(map);
  map.takeDirty();
  const s = Session.create({ map, plan: null, spawn: { position: SPAWN.position } }, tun, 7, 0);
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

const now = (s: Session) => s.ticks * s.clock.dt;

/** The plates as the range lays them on `s`'s world: their spots, in its order. */
function platesOf(s: Session): RangeSpot[] {
  return rangeLayout(s.map, VOXEL, SPAWN, t, null, EYE).filter((p) => p.kind === 'torso' || p.kind === 'head');
}

/** Every voxel in a plate's box, a voxel round it, as [x, y, z]. */
function boxOf(spot: RangeSpot): [number, number, number][] {
  const v = plateVoxels(spot, VOXEL, t, SPAWN.bay);
  const lo = [0, 1, 2].map((k) => Math.min(...v.map((q) => q[k])) - 1);
  const hi = [0, 1, 2].map((k) => Math.max(...v.map((q) => q[k])) + 1);
  const out: [number, number, number][] = [];
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) out.push([x, y, z]);
  return out;
}

/** `ticks` ticks of `s`: what combat did over them. */
function run(s: Session, ticks: number): CombatEvents {
  for (let k = 0; k < ticks; k++) s.tick();
  return s.drainEvents();
}

/**
 * The view turned from the eye onto `at`, less the muzzle's recoil as the last tick left it: a held
 * trigger's rounds stay on it.
 */
function holdOn(s: Session, at: readonly number[]): void {
  const p = s.player;
  const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
  const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
  p.yaw = (Math.atan2(d[0], d[2]) * 180) / Math.PI - s.recoil.yaw;
  p.pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI - s.recoil.pitch;
}

/** One pull of the player's trigger aimed from the eye at `at`, and the ticks the round needs: what combat did. */
function shoot(s: Session, at: readonly number[], ticks = 20): CombatEvents {
  const p = s.player;
  const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
  const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
  p.yaw = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
  p.pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  s.intent = { ...idleIntent(), fire: true };
  s.tick();
  s.intent = idleIntent();
  return run(s, ticks);
}

describe('the range in the app', () => {
  it('the range is allowed in solo only: not in a room, a check run, or with ?range=0', () => {
    expect(rangeAllowed({ room: false, check: false, param: null })).toBe(true);
    expect(rangeAllowed({ room: true, check: false, param: null })).toBe(false);
    expect(rangeAllowed({ room: false, check: true, param: null })).toBe(false);
    expect(rangeAllowed({ room: false, check: false, param: '0' })).toBe(false);
    // Any other ?range= leaves solo play as it is.
    expect(rangeAllowed({ room: false, check: false, param: '1' })).toBe(true);
    expect(rangeAllowed({ room: false, check: false, param: '' })).toBe(true);
    expect(rangeAllowed({ room: true, check: true, param: '0' })).toBe(false);
  });

  it('raise writes the plates; lower restores every voxel it wrote', () => {
    // A sandbag stands where the first plate's top corner goes: what a plate replaces is kept, not
    // taken for air. Granular, it moves no spot (the layout is the same with it and without).
    const plain = platesOf(field());
    const corner = plateVoxels(plain[0], VOXEL, t, SPAWN.bay).filter((q) => q[3] === P.TARGET_STEEL).at(-1)!;
    const s = field((map) => map.set(corner[0], corner[1], corner[2], P.SANDBAG));
    const spots = platesOf(s);
    expect(spots).toEqual(plain);
    expect(spots.map((p) => p.kind)).toEqual(['torso', 'torso', 'torso', 'head', 'head']);
    const boxes = spots.flatMap(boxOf);
    const before = boxes.map(([x, y, z]) => s.map.get(x, y, z));
    expect(before).toContain(P.SANDBAG);

    const view = new RangeView(tun);
    view.raise(s, SPAWN, EYE);
    expect(view.up).toBe(true);
    // Each plate said to stand at its steel's middle, the point the layout sighted it at (plateCentre).
    expect(view.state().plates.map((p) => p.at)).toEqual(spots.map((spot) => plateCentre(plateVoxels(spot, VOXEL, t, SPAWN.bay), VOXEL)));
    // Each plate's steel and post, as plateVoxels lays them; and the renderer is told of every brick.
    const dirty = new Set(s.map.takeDirty());
    for (const spot of spots) {
      for (const [x, y, z, p] of plateVoxels(spot, VOXEL, t, SPAWN.bay)) {
        expect(s.map.get(x, y, z)).toBe(p);
        expect(dirty.has(s.map.brickIndex(x >> 3, y >> 3, z >> 3))).toBe(true);
      }
    }
    expect(s.map.get(corner[0], corner[1], corner[2])).toBe(P.TARGET_STEEL);
    // Raised again while it stands, nothing is written over what it keeps.
    view.raise(s, SPAWN, EYE);

    // While it stands: a plate struck (its voxel lead-grey), a post spattered, and blood on the
    // ground at a post's foot, which is the world's (the range never wrote it).
    const [hx, hy, hz] = plateVoxels(spots[1], VOXEL, t, SPAWN.bay).find((q) => q[3] === P.TARGET_STEEL)!;
    s.map.set(hx, hy, hz, P.TARGET_STEEL_HIT);
    const [px, py, pz] = plateVoxels(spots[2], VOXEL, t, SPAWN.bay).find((q) => q[3] === P.TIMBER)!;
    s.map.set(px, py, pz, P.BLOOD_TIMBER);
    const foot: [number, number, number] = [px, py - 1, pz + 1];
    s.map.set(foot[0], foot[1], foot[2], P.BLOOD_SOIL);

    view.lower(s);
    expect(view.up).toBe(false);
    const after = boxes.map(([x, y, z]) => s.map.get(x, y, z));
    const blood = boxes.findIndex(([x, y, z]) => x === foot[0] && y === foot[1] && z === foot[2]);
    expect(after[blood]).toBe(P.BLOOD_SOIL);
    expect(after.filter((_, i) => i !== blood)).toEqual(before.filter((_, i) => i !== blood));
    expect(s.map.get(corner[0], corner[1], corner[2])).toBe(P.SANDBAG);
    // The renderer is told again.
    const undone = new Set(s.map.takeDirty());
    for (const spot of spots) for (const [x, y, z] of plateVoxels(spot, VOXEL, t, SPAWN.bay)) expect(undone.has(s.map.brickIndex(x >> 3, y >> 3, z >> 3))).toBe(true);
    // Down, it is down: lowered again, nothing moves.
    view.lower(s);
    expect(boxes.map(([x, y, z]) => s.map.get(x, y, z))).toEqual(after);
  });

  it("a round of the player's into a plate is a plate event and repaints the voxel lead-grey", () => {
    const s = field();
    // As the range lays them, before its plates stand on the ground.
    const spots = platesOf(s);
    const view = new RangeView(tun);
    view.raise(s, SPAWN, EYE);
    const plates = view.state().plates;
    expect(plates.map((p) => [p.index, p.hits])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    // The 30 m torso plate, at its steel's middle, from the spawn.
    const at = plates[0].at;
    const first = shoot(s, at);
    expect(first.impacts).toHaveLength(1);
    const struck = first.impacts[0];
    expect(struck).toMatchObject({ owner: 0, material: P.TARGET_STEEL });
    const events = view.after(first, now(s));
    expect(events).toEqual([{ kind: 'plate', index: 0, distanceM: struck.distance }]);
    const p = s.player;
    expect(Math.abs(struck.distance - Math.hypot(at[0] - p.position.x, at[1] - p.position.y - s.controller.eyeHeight(p), at[2] - p.position.z))).toBeLessThan(0.1);
    const [x, y, z] = struck.cell;
    expect(s.map.get(x, y, z)).toBe(P.TARGET_STEEL_HIT);
    expect(view.state().plates[0].hits).toBe(1);

    // A struck voxel struck again: still the plate's, still lead-grey.
    run(s, 90);
    const again = shoot(s, [(x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL]);
    expect(again.impacts.map((i) => i.material)).toEqual([P.TARGET_STEEL_HIT]);
    expect(view.after(again, now(s))).toEqual([{ kind: 'plate', index: 0, distanceM: again.impacts[0].distance }]);
    expect(view.state().plates[0].hits).toBe(2);

    // The front's round only sparks off it: no event, and its voxel stays white.
    const other = plateVoxels(spots[3], VOXEL, t, SPAWN.bay).find((q) => q[3] === P.TARGET_STEEL)!;
    s.rounds.fire([(other[0] + 0.5) * VOXEL, (other[1] + 0.5) * VOXEL, (other[2] - 30.5) * VOXEL], [0, 0, AK.muzzleVelocity], AK, 1, true);
    const front = run(s, 10);
    expect(front.impacts.map((i) => [i.owner, i.material, i.cell])).toEqual([[1, P.TARGET_STEEL, [other[0], other[1], other[2]]]]);
    expect(view.after(front, now(s))).toEqual([]);
    expect(s.map.get(other[0], other[1], other[2])).toBe(P.TARGET_STEEL);
    expect(view.state().plates[3].hits).toBe(0);
  });

  it('the readout reads TORSO 58 · 47 m, HEAD 105 · 46 m, PLATE · 55 m, DOWN IN 3 · 47 m', () => {
    const shown: RangeEvent[] = [
      { kind: 'hit', id: 200, zone: 'torso', damage: 58, distanceM: 47.2 },
      { kind: 'hit', id: 201, zone: 'head', damage: 105, distanceM: 45.5 },
      { kind: 'plate', index: 1, distanceM: 54.6 },
      { kind: 'kill', id: 202, zone: 'torso', damage: 58, distanceM: 46.8, shots: 3 },
      { kind: 'hit', id: 203, zone: 'limb', damage: 32, distanceM: 24.49 },
    ];
    expect(shown.map(readoutText)).toEqual(['TORSO 58 · 47 m', 'HEAD 105 · 46 m', 'PLATE · 55 m', 'DOWN IN 3 · 47 m', 'LIMB 32 · 24 m']);
    // A kill's own line under its round's, so a kill says its zone and damage too; the rest, their own.
    expect(shown.map(readoutLines)).toEqual([['TORSO 58 · 47 m'], ['HEAD 105 · 46 m'], ['PLATE · 55 m'], ['TORSO 58 · 47 m', 'DOWN IN 3 · 47 m'], ['LIMB 32 · 24 m']]);

    // On the HUD for readout_s (1.5 s), a frame's kill over the hits that came with it.
    const el = { textContent: '' as string | null, hidden: true };
    const readout = new Readout(el, t.readoutS);
    expect(t.readoutS).toBe(1.5);
    readout.show([], 10);
    expect([readout.text, el.hidden]).toEqual([null, true]);
    readout.show([shown[0], shown[3], shown[1]], 10);
    const down = 'TORSO 58 · 47 m\nDOWN IN 3 · 47 m';
    expect([readout.text, el.textContent, el.hidden]).toEqual([down, down, false]);
    readout.tick(11.4);
    expect(readout.text).toBe(down);
    // A new one starts its time afresh.
    readout.show([shown[2]], 11);
    readout.tick(12.4);
    expect(readout.text).toBe('PLATE · 55 m');
    readout.tick(12.5);
    expect([readout.text, el.hidden]).toEqual([null, true]);
    // Cleared at once (the range taken down).
    readout.show([shown[0]], 13);
    readout.clear();
    expect([readout.text, el.hidden]).toEqual([null, true]);
  });

  it('the dummies stand as soldiers in hunter orange, the standing ones targets; an SVD round to the head drops one, which lies 4 s and is no target', () => {
    const s = field();
    s.equip({ primary: 'svd', secondary: 'm17', fits: {} });
    const view = new RangeView(tun);
    view.raise(s, SPAWN, EYE);
    const draws = view.frame(s, now(s));
    // Six standing and two walking, as Blue's soldiers in TAPE_RANGE with the bare AK at rest, and
    // a vest of it over the tunic, so they read at 17:35 against the low sun's haze.
    const ids = Array.from({ length: 8 }, (_, i) => FIRST_DUMMY + i);
    expect(draws.map((d) => d.seat)).toEqual(ids);
    for (const d of draws) expect([d.team, d.tape, d.vest, d.gear]).toEqual(['blue', P.TAPE_RANGE, P.TAPE_RANGE, 0]);
    expect(s.targets.map((b) => b.id)).toEqual(ids);
    expect(view.figures(now(s)).every((f) => f.team === 'blue' && f.tape === P.TAPE_RANGE && f.vest === P.TAPE_RANGE && f.gear === 0 && f.height === 1.8)).toBe(true);

    // The 25 m dummy, standing first: an SVD round at its head (its feet + 1.62 m) kills it.
    const dummy = view.state().dummies[0];
    expect(dummy).toMatchObject({ id: FIRST_DUMMY, hp: 100, down: false });
    const head = [dummy.position[0], dummy.position[1] + 1.62, dummy.position[2]];
    const fired = shoot(s, head);
    expect(fired.hits).toMatchObject([{ owner: 0, body: FIRST_DUMMY, zone: 'head' }]);
    const events = view.after(fired, now(s));
    const fell = now(s);
    expect(events).toEqual([{ kind: 'kill', id: FIRST_DUMMY, zone: 'head', damage: 190, distanceM: fired.hits[0].distance, shots: 1 }]);
    expect(view.state().dummies[0]).toMatchObject({ id: FIRST_DUMMY, hp: 0, down: true });

    // Down, it is drawn lying, but it is no target.
    const lying = view.frame(s, now(s));
    expect(lying.map((d) => d.seat)).toEqual(ids);
    expect(s.targets.map((b) => b.id)).toEqual(ids.slice(1));
    // A second on it lies on the ground where it stood: a round at its torso's middle, where it lies.
    run(s, 60);
    const lain = view.frame(s, now(s)).find((d) => d.seat === FIRST_DUMMY)!;
    const torso = toWorld(lain.frames.torso, [0, 0.28, 0]);
    expect(torso[1] - dummy.position[1]).toBeLessThan(0.5);
    expect(Math.hypot(torso[0] - dummy.position[0], torso[2] - dummy.position[2])).toBeLessThan(1.5);
    // Were it a target, that round would strike it ...
    const standing = s.targets;
    s.targets = [...standing, { id: FIRST_DUMMY, frames: lain.frames, feet: lain.feet }];
    const would = shoot(s, torso, 30);
    s.targets = standing;
    expect(would.shots).toHaveLength(1);
    expect(would.hits.map((h) => h.body)).toEqual([FIRST_DUMMY]);
    // ... but it is none: the round meets nothing, and the range has nothing to say of it.
    run(s, 60);
    view.frame(s, now(s));
    expect(s.targets.map((b) => b.id)).toEqual(ids.slice(1));
    const through = shoot(s, torso, 30);
    expect(through.shots).toHaveLength(1);
    expect(through.hits).toEqual([]);
    expect(view.after(through, now(s))).toEqual([]);

    // Still down just short of down_s; after it, it stands again at full health, a target again.
    while (now(s) < fell + t.downS - 0.1) run(s, 1);
    view.frame(s, now(s));
    expect(s.targets.map((b) => b.id)).toEqual(ids.slice(1));
    expect(view.state().dummies[0]).toMatchObject({ id: FIRST_DUMMY, hp: 0, down: true });
    run(s, 12);
    view.frame(s, now(s));
    expect(s.targets.map((b) => b.id)).toEqual(ids);
    expect(view.state().dummies[0]).toMatchObject({ id: FIRST_DUMMY, hp: 100, down: false });
  });

  it("shots are counted by the pulls that fired the rounds: each pull that strikes is one, a shotgun's nine pellets one", () => {
    for (const primary of ['ak74', 'm870'] as const) {
      const s = field();
      s.equip({ primary, secondary: 'm17', fits: {} });
      const view = new RangeView(tun);
      view.raise(s, SPAWN, EYE);
      view.frame(s, now(s));
      // 4 m in front of the 25 m dummy, at its chest: every pellet of a shotgun's into it.
      const dummy = view.state().dummies[0];
      s.teleport([dummy.position[0], dummy.position[1], dummy.position[2] - 4], 0, 0);
      run(s, 30);
      const chest = [dummy.position[0], dummy.position[1] + 1.3, dummy.position[2]];
      const events: RangeEvent[] = [];
      /** Each pull's rounds that struck the dummy. */
      const struck: number[] = [];
      for (let k = 0; k < 6 && !events.some((e) => e.kind === 'kill'); k++) {
        view.frame(s, now(s));
        const fired = shoot(s, chest);
        struck.push(fired.hits.filter((h) => h.body === FIRST_DUMMY).length);
        events.push(...view.after(fired, now(s)));
        // The gun ready again, its recoil settled.
        events.push(...view.after(run(s, 60), now(s)));
      }
      const kill = events.find((e) => e.kind === 'kill');
      expect(kill, primary).toMatchObject({ kind: 'kill', id: FIRST_DUMMY });
      // The kill's shots: the pulls whose rounds struck it, however many of each struck.
      expect(kill?.kind === 'kill' && kill.shots, primary).toBe(struck.filter((n) => n > 0).length);
      if (primary === 'ak74') expect(struck.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
      else expect(struck).toEqual([expect.any(Number)]);
      if (primary === 'm870') expect(struck[0]).toBeGreaterThan(4);
      // The hits before the kill are events; a downed dummy takes nothing more: the kill is the last.
      expect(events.at(-1)).toBe(kill);
    }
  });

  it("a round still in the air as the next pull leaves counts for its own pull: the AK held on the 80 m dummy, two of its rounds at 110 m, three of the MP5's at 40 m", () => {
    const cases = [
      { primary: 'ak74', m: 80, pulls: Infinity, struck: 2 },
      { primary: 'ak74', m: 110, pulls: 2, struck: 2 },
      { primary: 'mp5', m: 40, pulls: 3, struck: 3 },
    ] as const;
    for (const c of cases) {
      const label = `${c.primary} at ${c.m} m`;
      const s = field();
      s.equip({ primary: c.primary, secondary: 'm17', fits: {} });
      const view = new RangeView(tun);
      view.raise(s, SPAWN, EYE);
      view.frame(s, now(s));
      const id = FIRST_DUMMY + t.dummiesM.indexOf(c.m);
      const feet = view.state().dummies.find((d) => d.id === id)!.position;
      const chest = [feet[0], feet[1] + 1.2, feet[2]];
      /** The ticks the pulls left on, and the ticks the dummy was struck on. */
      const pulls: number[] = [];
      const struck: number[] = [];
      const events: RangeEvent[] = [];
      for (let k = 0; k < 40; k++) {
        view.frame(s, now(s));
        holdOn(s, chest);
        // The trigger held for the burst's pulls, or until the dummy drops.
        s.intent = { ...idleIntent(), fire: pulls.length < c.pulls && !events.some((e) => e.kind === 'kill') };
        s.tick();
        const fired = s.drainEvents();
        pulls.push(...fired.shots.map((sh) => sh.tick));
        struck.push(...fired.hits.filter((h) => h.body === id).map((h) => h.tick));
        events.push(...view.after(fired, now(s)));
      }
      expect(struck, label).toHaveLength(c.struck);
      // Rounds still in the air as the next pull left: told by the ticks alone (the latest pull at or
      // before each strike), two of the strikes would be one pull's.
      const latest = (tick: number) => Math.max(...pulls.filter((p) => p <= tick));
      expect(new Set(struck.map(latest)).size, label).toBeLessThan(struck.length);
      // One round a pull: each that struck is a pull that struck.
      const kill = events.find((e) => e.kind === 'kill');
      expect(kill, label).toMatchObject({ kind: 'kill', id, shots: c.struck });
      expect(events.at(-1), label).toBe(kill);
    }
  });

  it("a kill's shots are the pulls its rounds left on, whatever ticks they struck on", () => {
    const s = field();
    const view = new RangeView(tun);
    view.raise(s, SPAWN, EYE);
    view.frame(s, now(s));
    const [a, b] = view.state().dummies;
    /** A round of the player's into dummy `body` (no gun's: 55 to the torso), struck on `tick`, from the pull on tick `shot`. */
    const round = (body: number, tick: number, shot: number): CombatEvents['hits'][number] => ({ owner: 0, body, zone: 'torso', position: [0, 0, 0], dir: [0, 0, 1], distance: 25, shot, tick });
    // One pull's two rounds struck on two ticks (a shotgun's pellets either side of one): one shot,
    // and one event, the pull's (55 + 55 kills). Two pulls' rounds struck on one tick: two.
    const hits = [round(a.id, 50, 44), round(a.id, 51, 44), round(b.id, 52, 45), round(b.id, 52, 48)];
    const events = view.after({ ...s.drainEvents(), hits }, now(s));
    expect(events.map((e) => [e.kind, e.kind === 'kill' ? e.shots : null])).toEqual([['kill', 1], ['hit', null], ['kill', 2]]);
  });

  describe("a pull's pellets are one event, the pull's (the readout reads the shot, not one pellet)", () => {
    const M870 = GUNS.indexOf('m870');
    /** The range up on the field, its dummies posed: the view, the session and its first two dummies. */
    const up = () => {
      const s = field();
      const view = new RangeView(tun);
      view.raise(s, SPAWN, EYE);
      view.frame(s, now(s));
      const [a, b] = view.state().dummies;
      return { s, view, a, b };
    };
    /** A pellet of the player's M870 into dummy `body`'s `zone`, `distance` m out, from the pull on tick `shot`, struck on `tick` (that pull's, unless told). */
    const pellet = (body: number, zone: Zone, distance: number, shot: number, tick = shot): CombatEvents['hits'][number] => ({ owner: 0, body, zone, gun: M870, position: [0, 0, 0], dir: [0, 0, 1], distance, shot, tick });
    const shown = (events: readonly RangeEvent[]) => {
      const readout = new Readout(null, t.readoutS);
      readout.show(events, 1);
      return readout.text;
    };

    it('four limb pellets of one pull into one dummy: one event, LIMB 52 · 25 m (13 a pellet), the latest pellet\'s distance', () => {
      const { s, view, a } = up();
      const hits = [pellet(a.id, 'limb', 24.6, 40), pellet(a.id, 'limb', 25.4, 40), pellet(a.id, 'limb', 26.1, 40), pellet(a.id, 'limb', 25.2, 40)];
      const events = view.after({ ...s.drainEvents(), hits }, now(s));
      expect(events).toEqual([{ kind: 'hit', id: a.id, zone: 'limb', damage: 52, distanceM: 25.2 }]);
      expect(shown(events)).toBe('LIMB 52 · 25 m');
      // Its health is the four pellets' (Range.hit still counts each).
      expect(view.state().dummies[0].hp).toBe(48);
    });

    it('a pull that kills reads its sum over DOWN IN 1: two pellets in the head and one in the torso, HEAD 107, whichever pellet killed', () => {
      const { s, view, a } = up();
      // Torso 23, head 42 (65), head 42 (107: the kill); two more after it find the dummy down.
      const hits = [pellet(a.id, 'torso', 25.3, 60), pellet(a.id, 'head', 25.1, 60), pellet(a.id, 'head', 24.8, 60), pellet(a.id, 'torso', 25.6, 60), pellet(a.id, 'limb', 25.0, 60)];
      const events = view.after({ ...s.drainEvents(), hits }, now(s));
      expect(events).toEqual([{ kind: 'kill', id: a.id, zone: 'head', damage: 107, distanceM: 24.8, shots: 1 }]);
      expect(shown(events)).toBe('HEAD 107 · 25 m\nDOWN IN 1 · 25 m');
      // Five torso pellets: the fifth kills (115), and TORSO is the pull's zone.
      const again = up();
      const torso = Array.from({ length: 9 }, (_, k) => pellet(again.a.id, 'torso', 25, 70, 70 + (k > 4 ? 1 : 0)));
      const killed = again.view.after({ ...again.s.drainEvents(), hits: torso }, now(again.s));
      expect(killed).toEqual([{ kind: 'kill', id: again.a.id, zone: 'torso', damage: 115, distanceM: 25, shots: 1 }]);
      expect(shown(killed)).toBe('TORSO 115 · 25 m\nDOWN IN 1 · 25 m');
    });

    it('a pellet in the head makes the pull HEAD though the torso took more: HEAD 88 · 25 m, not TORSO', () => {
      const { s, view, a } = up();
      // Torso 23, head 42, torso 23: the torso's 46 outscores the head's 42, and the pull is still the head's.
      // The head pellet comes neither first nor last, so neither pellet's own zone is the answer.
      const hits = [pellet(a.id, 'torso', 25, 110), pellet(a.id, 'head', 25, 110), pellet(a.id, 'torso', 25, 110)];
      const events = view.after({ ...s.drainEvents(), hits }, now(s));
      expect(events).toEqual([{ kind: 'hit', id: a.id, zone: 'head', damage: 88, distanceM: 25 }]);
      expect(shown(events)).toBe('HEAD 88 · 25 m');
    });

    it('no pellet in the head: the zone that took the most damage, a limb over a torso when the limbs took more', () => {
      const { s, view, a } = up();
      // A torso pellet's 23 against two limbs' 26.
      const hits = [pellet(a.id, 'torso', 25, 80), pellet(a.id, 'limb', 25, 80), pellet(a.id, 'limb', 25, 80)];
      expect(view.after({ ...s.drainEvents(), hits }, now(s))).toEqual([{ kind: 'hit', id: a.id, zone: 'limb', damage: 49, distanceM: 25 }]);
    });

    it('one pull into two dummies gives two events, each its own; and two pulls into one dummy, two', () => {
      const { s, view, a, b } = up();
      const hits = [pellet(a.id, 'torso', 25, 90), pellet(b.id, 'limb', 40, 90), pellet(a.id, 'torso', 25.2, 90), pellet(b.id, 'limb', 40.1, 90), pellet(b.id, 'torso', 40, 90)];
      const events = view.after({ ...s.drainEvents(), hits }, now(s));
      expect(events).toEqual([
        { kind: 'hit', id: a.id, zone: 'torso', damage: 46, distanceM: 25.2 },
        { kind: 'hit', id: b.id, zone: 'limb', damage: 49, distanceM: 40 },
      ]);
      // A frame's two pulls into one dummy: one event a pull, oldest first.
      const two = up();
      const pulls = [pellet(two.a.id, 'limb', 25, 100), pellet(two.a.id, 'limb', 25, 100), pellet(two.a.id, 'torso', 25, 101), pellet(two.a.id, 'limb', 25, 100, 101)];
      expect(two.view.after({ ...two.s.drainEvents(), hits: pulls }, now(two.s))).toEqual([
        { kind: 'hit', id: two.a.id, zone: 'limb', damage: 39, distanceM: 25 },
        { kind: 'hit', id: two.a.id, zone: 'torso', damage: 23, distanceM: 25 },
      ]);
    });
  });

  it("raise keeps the front's shells range_shell_clear_m off every spot, a mover's walk too; lower lets them back", () => {
    const s = field();
    const view = new RangeView(tun);
    expect(s.artillery.exclusion).toEqual([]);
    // As the range lays them, before its plates stand on the ground.
    const spots = rangeLayout(s.map, VOXEL, SPAWN, t, null, EYE);
    view.raise(s, SPAWN, EYE);
    const clearM = tun.f('range.range_shell_clear_m');
    expect(clearM).toBe(6);
    expect(s.artillery.exclusion).toEqual(spots.map((p) => ({ x: p.at[0], z: p.at[2], r: clearM + (p.kind === 'mover' ? t.moverSpanM / 2 : 0) })));
    view.lower(s);
    expect(s.artillery.exclusion).toEqual([]);
    expect(s.targets).toEqual([]);
    expect(view.frame(s, now(s))).toEqual([]);
    expect(view.state()).toEqual({ up: false, dummies: [], plates: [] });
  });

  it('raises only what its eye sees: a wall across every place the 25 m dummy might stand leaves it out, the rest as laid', () => {
    // Half way out to the 25 m dummy (9 m left), 2.1 m high, across the lines from the eye to its
    // chest wherever it is tried, 3 m either way.
    const s = field((map) => map.fillBox(95, 4, 175, 132, 25, 176, P.BRICK));
    const is25 = (p: RangeSpot) => p.kind === 'dummy' && p.distanceM === 25;
    const unsighted = rangeLayout(s.map, VOXEL, SPAWN, t, null, null);
    const sighted = rangeLayout(s.map, VOXEL, SPAWN, t, null, EYE);
    expect(unsighted.some(is25)).toBe(true);
    expect(sighted).toEqual(unsighted.filter((p) => !is25(p)));
    const view = new RangeView(tun);
    view.raise(s, SPAWN, EYE);
    // Seven dummies and the five plates: every spot as sighted, each one's circle kept from the shells.
    expect(view.state().dummies.map((d) => d.id)).toEqual([200, 201, 202, 203, 204, 205, 206]);
    expect(view.state().plates).toHaveLength(5);
    expect(s.artillery.exclusion.map((c) => [c.x, c.z])).toEqual(sighted.map((p) => [p.at[0], p.at[2]]));
  });

  it("a range whose session does not tick stands still: frame after frame with no tick between (paused, or flying without the session), every dummy's pose is as it was, the movers' strides too", () => {
    const s = field();
    const view = new RangeView(tun);
    view.raise(s, SPAWN, EYE);
    // The movers a second into their walks, mid-stride.
    for (let k = 0; k < 60; k++) {
      view.frame(s, now(s));
      run(s, 1);
    }
    const pose = () => view.frame(s, now(s)).map((d) => d.frames);
    const still = pose();
    for (let k = 0; k < 5; k++) expect(pose()).toEqual(still);
    // A tick, and they walk on.
    run(s, 1);
    expect(pose()).not.toEqual(still);
  });

  it("a frame's events come oldest first, a tick's dummies before its plates", () => {
    const s = field();
    const spots = platesOf(s);
    const view = new RangeView(tun);
    view.raise(s, SPAWN, EYE);
    view.frame(s, now(s));
    const [a, b] = view.state().dummies;
    /** A round of the player's into dummy `body` on `tick` (no gun's, into a limb: 30, a hit). */
    const round = (body: number, tick: number): CombatEvents['hits'][number] => ({ owner: 0, body, zone: 'limb', position: [0, 0, 0], dir: [0, 0, 1], distance: 25, shot: tick, tick });
    /** A round of the player's into plate `index`'s first steel voxel on `tick`. */
    const ring = (index: number, tick: number): CombatEvents['impacts'][number] => {
      const [x, y, z] = plateVoxels(spots[index], VOXEL, t, SPAWN.bay).find((q) => q[3] === P.TARGET_STEEL)!;
      return { position: [0, 0, 0], normal: [0, 0, -1], cell: [x, y, z], material: P.TARGET_STEEL, speed: 800, distance: 30, energyJ: 1000, owner: 0, spec: 'assault_rifle', dir: [0, 0, 1], kind: 0, tick };
    };
    // The dummies struck on ticks 11 and 12, the plates on ticks 10 and 11.
    const events = view.after({ ...s.drainEvents(), hits: [round(a.id, 11), round(b.id, 12)], impacts: [ring(0, 10), ring(1, 11)] }, now(s));
    expect(events.map((e) => (e.kind === 'plate' ? `plate ${e.index}` : `${e.kind} ${e.id}`))).toEqual(['plate 0', `hit ${a.id}`, 'plate 1', `hit ${b.id}`]);
  });

  it("a frame's ticks that did nothing on the range give one shared empty list of events, the range up or down", () => {
    const s = field();
    const view = new RangeView(tun);
    const down = view.after(run(s, 3), now(s));
    expect(down).toEqual([]);
    expect(view.after(run(s, 3), now(s))).toBe(down);
    view.raise(s, SPAWN, EYE);
    view.frame(s, now(s));
    // Ticks with no round of the player's into a dummy or a plate (the front's, if any, are not the range's).
    const quiet = view.after(run(s, 3), now(s));
    expect(quiet).toEqual([]);
    expect(view.after(run(s, 3), now(s))).toBe(quiet);
  });

  it('the frame keeps its lists: down, one frozen empty list of draws; up, one figure a dummy and one list of targets, one body a dummy, updated in place', () => {
    const s = field();
    const view = new RangeView(tun);
    const none = view.frame(s, now(s));
    expect(none).toEqual([]);
    expect(Object.isFrozen(none)).toBe(true);
    expect(view.frame(s, now(s))).toBe(none);
    view.raise(s, SPAWN, EYE);
    view.frame(s, now(s));
    const targets = s.targets;
    const bodies = [...targets];
    const figures = view.figures(now(s));
    const each = [...figures];
    // The first mover's feet, as its figure and its body had them.
    const mover = figures.findIndex((f) => f.velocity[0] !== 0 || f.velocity[2] !== 0);
    expect(mover).toBeGreaterThanOrEqual(0);
    const walked = [...figures[mover].position];
    run(s, 30);
    view.frame(s, now(s));
    expect(s.targets).toBe(targets);
    expect(s.targets.length).toBe(bodies.length);
    s.targets.forEach((b, i) => expect(b).toBe(bodies[i]));
    const again = view.figures(now(s));
    expect(again).toBe(figures);
    again.forEach((f, i) => expect(f).toBe(each[i]));
    // Updated: the mover has walked on, its figure and its body with it.
    expect(figures[mover].position).not.toEqual(walked);
    expect(bodies[mover].feet).toEqual(figures[mover].position);
  });
});
