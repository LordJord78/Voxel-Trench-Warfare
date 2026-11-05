import { describe, expect, it } from 'vitest';
import { rangeAllowed, RangeView } from '../../src/app/range';
import { projectileSpec } from '../../src/combat/ballistics';
import { FIRST_DUMMY, plateVoxels, rangeLayout, rangeTunables, type RangeEvent, type RangeSpot } from '../../src/combat/range';
import { loadTunables } from '../../src/core/tunables';
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
const DT = 1 / 60;
const VOXEL = 0.1;

/** The spawn: in a bay along x, facing +z. */
const SPAWN = { position: [16, 0.4, 5] as [number, number, number], bay: { longAxis: 0 as const, facing: 1 as const } };

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
  return rangeLayout(s.map, VOXEL, SPAWN, t, null).filter((p) => p.kind === 'torso' || p.kind === 'head');
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
    view.raise(s, SPAWN);
    expect(view.up).toBe(true);
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
    view.raise(s, SPAWN);

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
    view.raise(s, SPAWN);
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
    view.raise(s, SPAWN);
    const draws = view.frame(s, DT, now(s));
    // Six standing and two walking, as Blue's soldiers in TAPE_RANGE with the bare AK at rest.
    const ids = Array.from({ length: 8 }, (_, i) => FIRST_DUMMY + i);
    expect(draws.map((d) => d.seat)).toEqual(ids);
    for (const d of draws) expect([d.team, d.tape, d.gear]).toEqual(['blue', P.TAPE_RANGE, 0]);
    expect(s.targets.map((b) => b.id)).toEqual(ids);
    expect(view.figures(s, now(s)).every((f) => f.team === 'blue' && f.tape === P.TAPE_RANGE && f.gear === 0 && f.height === 1.8)).toBe(true);

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

    // Down, it is drawn lying, but it is no target: the same round flies past it.
    const lying = view.frame(s, DT, now(s));
    expect(lying.map((d) => d.seat)).toEqual(ids);
    expect(s.targets.map((b) => b.id)).toEqual(ids.slice(1));
    run(s, 60);
    const through = shoot(s, head, 30);
    expect(through.hits).toEqual([]);
    expect(view.after(through, now(s))).toEqual([]);

    // Still down just short of down_s; after it, it stands again at full health, a target again.
    while (now(s) < fell + t.downS - 0.1) run(s, 1);
    view.frame(s, DT, now(s));
    expect(s.targets.map((b) => b.id)).toEqual(ids.slice(1));
    expect(view.state().dummies[0]).toMatchObject({ id: FIRST_DUMMY, hp: 0, down: true });
    run(s, 12);
    view.frame(s, DT, now(s));
    expect(s.targets.map((b) => b.id)).toEqual(ids);
    expect(view.state().dummies[0]).toMatchObject({ id: FIRST_DUMMY, hp: 100, down: false });
  });

  it("shots are counted by the player's shots' ticks: each pull that strikes is one, a shotgun's nine pellets one", () => {
    for (const primary of ['ak74', 'm870'] as const) {
      const s = field();
      s.equip({ primary, secondary: 'm17', fits: {} });
      const view = new RangeView(tun);
      view.raise(s, SPAWN);
      view.frame(s, DT, now(s));
      // 4 m in front of the 25 m dummy, at its chest: every pellet of a shotgun's into it.
      const dummy = view.state().dummies[0];
      s.teleport([dummy.position[0], dummy.position[1], dummy.position[2] - 4], 0, 0);
      run(s, 30);
      const chest = [dummy.position[0], dummy.position[1] + 1.3, dummy.position[2]];
      const events: RangeEvent[] = [];
      /** Each pull's rounds that struck the dummy. */
      const struck: number[] = [];
      for (let k = 0; k < 6 && !events.some((e) => e.kind === 'kill'); k++) {
        view.frame(s, DT, now(s));
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

  it("raise keeps the front's shells range_shell_clear_m off every spot, a mover's walk too; lower lets them back", () => {
    const s = field();
    const view = new RangeView(tun);
    expect(s.artillery.exclusion).toEqual([]);
    // As the range lays them, before its plates stand on the ground.
    const spots = rangeLayout(s.map, VOXEL, SPAWN, t, null);
    view.raise(s, SPAWN);
    const clearM = tun.f('range.range_shell_clear_m');
    expect(clearM).toBe(6);
    expect(s.artillery.exclusion).toEqual(spots.map((p) => ({ x: p.at[0], z: p.at[2], r: clearM + (p.kind === 'mover' ? t.moverSpanM / 2 : 0) })));
    view.lower(s);
    expect(s.artillery.exclusion).toEqual([]);
    expect(s.targets).toEqual([]);
    expect(view.frame(s, DT, now(s))).toEqual([]);
    expect(view.state()).toEqual({ up: false, dummies: [], plates: [] });
  });
});
