import { expect, test, type Page } from '@playwright/test';
import { P } from '../../src/world/materials';
import { hooks, openGame, type Hooks } from './support/app';

// The range (the shots spec's §5): in solo play, dummies and steel plates out in front of the spawn
// bay, from the click that starts play. A dummy takes a match's damage, falls and stands again; a
// plate rings and shows where it was struck; a readout says what each hit did. A test's world has
// one only when it asks (openGame turns it off), and a page asked with ?range=0 has none.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

/** The hooks these tests use past what Hooks types: the map's name, the loadout, the soldiers drawn, and the session's eye, clock, targets and shells' exclusion. */
type Ranged = Hooks & {
  map: string;
  setLoadout(l: unknown): void;
  soldiersDrawn(): unknown[];
  session: {
    player: { position: { x: number; y: number; z: number }; yaw: number; pitch: number };
    controller: { eyeHeight(p: unknown): number };
    ticks: number;
    clock: { dt: number };
    targets: { id: number }[];
    artillery: { exclusion: { x: number; z: number; r: number }[] };
    weapon: { shotsFired: number };
  };
};

const ranged = <T>(page: Page, fn: (h: Ranged, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> => hooks(page, fn as unknown as (h: Hooks, arg: unknown) => T | Promise<T>, arg);

/** Solo play with the range asked for, the SVD in the hands, standing on the spawn bay's firing step. */
async function onTheStep(page: Page): Promise<string[]> {
  const errors = await openGame(page);
  await ranged(page, async (h) => {
    h.setLoadout({ primary: 'svd', secondary: 'm17', fits: {} });
    h.range(true);
    h.play();
    h.standAt('step');
    await h.waitFrames(30);
  });
  return errors;
}

/** One press of the trigger, aimed from the eye at `at` (metres): the shots it fired. */
async function shootAt(page: Page, at: readonly number[]): Promise<number> {
  return ranged(
    page,
    async (h, arg) => {
      const target = arg as number[];
      const s = h.session;
      const p = s.player;
      const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
      const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
      p.yaw = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
      p.pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
      await h.waitFrames(5);
      const before = s.weapon.shotsFired;
      h.trigger(true);
      await h.waitFrames(3);
      h.trigger(false);
      return s.weapon.shotsFired - before;
    },
    at,
  );
}

test('with the range asked for, solo play raises every dummy and plate it lays in front of the spawn bay: on the Ravine the 5 dummies and 4 plates its firing step sees', async ({ page }) => {
  const errors = await openGame(page);
  const seen = await ranged(page, async (h) => {
    h.range(true);
    // Not before the click that starts play: the page's still holds.
    await h.waitFrames(2);
    const before = h.rangeState().up;
    h.play();
    h.standAt('step');
    await h.waitFrames(5);
    const s = h.rangeState();
    const { position, bay } = h.world.spawn;
    const v = 0.1;
    const map = h.world.map;
    // Out along the bay's facing from the spawn, and right of it as one faces out (metres).
    const along = (p: number[]) => {
      const dx = p[0] - position[0];
      const dz = p[2] - position[2];
      return bay.longAxis === 0 ? { out: dz * bay.facing, right: dx * bay.facing } : { out: dx * bay.facing, right: -dz * bay.facing };
    };
    const session = h.session;
    return {
      before,
      up: s.up,
      map: h.map,
      dummies: s.dummies.map((d) => ({
        id: d.id,
        hp: d.hp,
        down: d.down,
        ...along(d.position),
        // What is under its feet, and at them.
        under: map.get(Math.floor(d.position[0] / v), Math.round(d.position[1] / v) - 1, Math.floor(d.position[2] / v)),
        at: map.get(Math.floor(d.position[0] / v), Math.round(d.position[1] / v), Math.floor(d.position[2] / v)),
      })),
      plates: s.plates.map((p) => ({ index: p.index, hits: p.hits, ...along(p.at), steel: map.get(Math.floor(p.at[0] / v), Math.floor(p.at[1] / v), Math.floor(p.at[2] / v)) })),
      targets: session.targets.map((b) => b.id),
      shellsKept: session.artillery.exclusion.length,
      drawn: h.soldiersDrawn().length,
      gpuErrors: h.gpuErrors(),
    };
  });
  const said = JSON.stringify(seen);
  expect(seen.before, said).toBe(false);
  expect(seen.up, said).toBe(true);
  // What rangeLayout lays on the Ravine (tests/combat/range.test.ts), sighted from the firing step:
  // its map ends 149 m out from its spawn, so its 150 m dummy has no ground, and the enemy's parapet
  // some 54 m out hides the 110 m dummy, the 90 m mover and the 85 m plate (G2's ledger).
  expect(seen.map).toBe('ravine');
  const ids = [200, 201, 202, 203, 204];
  expect(seen.dummies.map((d) => d.id), said).toEqual(ids);
  // Four standing at their distances, then the one walking; each within 1 m of its distance out,
  // within the bay's frontage across, at full health, standing on the ground.
  const out = [25, 40, 60, 80, 50];
  seen.dummies.forEach((d, i) => {
    expect(Math.abs(d.out - out[i]), said).toBeLessThanOrEqual(1);
    expect(Math.abs(d.right), said).toBeLessThanOrEqual(12);
    expect([d.hp, d.down], said).toEqual([100, false]);
    if (i < 4) expect([d.under !== 0, d.at], said).toEqual([true, 0]);
  });
  // Torso plates at 30 and 55 m, head plates at 45 and 70 m: white steel at each one's middle.
  const plates = [30, 55, 45, 70];
  expect(seen.plates.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  seen.plates.forEach((p, i) => {
    expect(Math.abs(p.out - plates[i]), said).toBeLessThanOrEqual(1);
    expect(Math.abs(p.right), said).toBeLessThanOrEqual(12);
    expect([p.steel, p.hits], said).toEqual([80, 0]);
  });
  // The standing ones are the session's targets, the renderer draws all five (all in view from the
  // step), and no shell lands near any of the nine spots.
  expect(seen.targets, said).toEqual(ids);
  expect(seen.drawn, said).toBe(5);
  expect(seen.shellsKept, said).toBe(9);
  expect(seen.gpuErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test("an SVD round to the 25 m dummy's head drops it; the readout says HEAD; it stands again after 4 s", async ({ page }) => {
  const errors = await onTheStep(page);
  const dummy = await hooks(page, (h) => h.rangeState().dummies.find((d) => d.id === 200)!);
  expect(dummy).toMatchObject({ hp: 100, down: false });
  // The head: its feet and 1.62 m.
  expect(await shootAt(page, [dummy.position[0], dummy.position[1] + 1.62, dummy.position[2]])).toBe(1);
  const fell = await ranged(page, async (h) => {
    const s = h.session;
    const now = () => s.ticks * s.clock.dt;
    // Down within a second of the shot.
    const t0 = performance.now();
    while (performance.now() - t0 < 1000 && !h.rangeState().dummies[0].down) await h.waitFrames(1);
    const state = h.rangeState();
    const at = now();
    const el = document.querySelector<HTMLElement>('#hud .readout');
    const shown = el && !el.hidden ? el.textContent : null;
    // From the next frame, before its ticks, it is no target.
    await h.waitFrames(1);
    return { at, dummy: state.dummies[0], readout: state.readout, shown, targets: s.targets.map((b) => b.id) };
  });
  const said = JSON.stringify(fell);
  expect(fell.dummy, said).toMatchObject({ id: 200, hp: 0, down: true });
  // The readout: the round's zone and damage over the shots it took, under the marker.
  expect(fell.readout, said).toContain('HEAD');
  expect(fell.readout, said).toMatch(/^HEAD 190 · 2\d m\nDOWN IN 1 · 2\d m$/);
  expect(fell.shown, said).toBe(fell.readout);
  // Down, it is no target: a dead body is not hit.
  expect(fell.targets, said).not.toContain(200);
  // Lying still at 3.8 s of the game's time; up at full health by 4.2 s.
  const stood = await ranged(
    page,
    async (h, arg) => {
      const at = arg as number;
      const s = h.session;
      const now = () => s.ticks * s.clock.dt;
      while (now() < at + 3.8) await h.waitFrames(1);
      const lying = h.rangeState().dummies[0];
      while (now() < at + 4.2) await h.waitFrames(1);
      return { lying, up: h.rangeState().dummies[0], targets: s.targets.map((b) => b.id), gpuErrors: h.gpuErrors() };
    },
    fell.at,
  );
  expect(stood.lying.down, JSON.stringify(stood)).toBe(true);
  expect(stood.up, JSON.stringify(stood)).toMatchObject({ id: 200, hp: 100, down: false });
  expect(stood.targets).toContain(200);
  expect(stood.gpuErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test('a round into a plate rings it: the readout says PLATE and the struck voxel turns lead-grey', async ({ page }) => {
  const errors = await onTheStep(page);
  // The 30 m torso plate, in sight of the step.
  const plate = await hooks(page, (h) => h.rangeState().plates[0]);
  expect(plate).toMatchObject({ index: 0, hits: 0 });
  /** The plate's steel round its middle: how many voxels white (80) and how many lead-grey (81). */
  const steel = () =>
    hooks(
      page,
      (h, arg) => {
        const at = arg as number[];
        const v = 0.1;
        const counts: Record<number, number> = {};
        for (let x = -4; x <= 4; x++) {
          for (let y = -5; y <= 5; y++) {
            for (let z = -4; z <= 4; z++) {
              const p = h.world.map.get(Math.floor(at[0] / v) + x, Math.floor(at[1] / v) + y, Math.floor(at[2] / v) + z);
              if (p === 80 || p === 81) counts[p] = (counts[p] ?? 0) + 1;
            }
          }
        }
        return counts;
      },
      plate.at,
    );
  expect(await steel()).toEqual({ 80: 30 });
  expect(await shootAt(page, plate.at)).toBe(1);
  const rung = await hooks(page, async (h) => {
    const t0 = performance.now();
    while (performance.now() - t0 < 1000 && h.rangeState().plates[0].hits === 0) await h.waitFrames(1);
    const state = h.rangeState();
    const el = document.querySelector<HTMLElement>('#hud .readout');
    return { hits: state.plates[0].hits, readout: state.readout, shown: el && !el.hidden ? el.textContent : null, gpuErrors: h.gpuErrors() };
  });
  const said = JSON.stringify(rung);
  expect(rung.hits, said).toBe(1);
  expect(rung.readout, said).toMatch(/^PLATE · (29|30) m$/);
  expect(rung.shown, said).toBe(rung.readout);
  // One voxel of its steel, the one struck, is lead-grey now.
  expect(await steel()).toEqual({ 80: 29, 81: 1 });
  expect(rung.gpuErrors).toEqual([]);
  expect(errors).toEqual([]);
});

for (const [name, path] of [['ravine', '/'], ['corridor', '/?map=corridor']] as const) {
  // On the Ravine the 30 m plate is rung from the step just before the range comes down: its voxel
  // struck lead-grey and the readout up, so the lowering is seen to put that voxel back and clear the
  // readout too.
  const ring = name === 'ravine';
  test(`on the ${name}, the range lowered through the app puts its world back${ring ? ', a plate rung from the step just before' : ''}: no steel or post left where its plates stood, no targets, no shells kept off, no readout; raised and lowered again, the same`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await openGame(page, path);
    const seen = await ranged(
      page,
      async (h, arg) => {
        const { ids, ring } = arg as { ids: number[]; ring: boolean };
        const [STEEL, HIT, POST] = ids;
        const v = 0.1;
        const map = h.world.map;
        // The SVD in the hands for the ring: a round a pull.
        if (ring) h.setLoadout({ primary: 'svd', secondary: 'm17', fits: {} });
        h.range(true);
        h.play();
        if (ring) h.standAt('step');
        await h.waitFrames(ring ? 30 : 3);
        let rung: { shots: number; hits: number } | null = null;
        if (ring) {
          // One pull from the eye at the 30 m torso plate's steel, then the frames until it rings: the
          // range comes down within the frame after, well inside the readout's 1.5 s.
          const at = h.rangeState().plates[0].at;
          const s = h.session;
          const p = s.player;
          const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
          const d = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
          p.yaw = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
          p.pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
          await h.waitFrames(5);
          const before = s.weapon.shotsFired;
          h.trigger(true);
          await h.waitFrames(3);
          h.trigger(false);
          const t0 = performance.now();
          while (performance.now() - t0 < 1000 && h.rangeState().plates[0].hits === 0) await h.waitFrames(1);
          rung = { shots: s.weapon.shotsFired - before, hits: h.rangeState().plates[0].hits };
        }
        const up = h.rangeState();
        // Each plate's box (voxels): 4 either way of its steel's middle across and along, from 20 under
        // it, past its post's foot, to 3 over it.
        const middles = up.plates.map((p) => p.at.map((c) => Math.floor(c / v)));
        const box = ([cx, cy, cz]: number[]) => {
          const out: number[][] = [];
          for (let x = cx - 4; x <= cx + 4; x++) for (let y = cy - 20; y <= cy + 3; y++) for (let z = cz - 4; z <= cz + 4; z++) out.push([x, y, z]);
          return out;
        };
        const read = () => middles.map((m) => box(m).map(([x, y, z]) => map.get(x, y, z)));
        // Up: each plate's steel in its box, struck or not, and its post, down its middle's column from
        // under the steel.
        const isSteel = (p: number) => p === STEEL || p === HIT;
        const steel = middles.map((m) => box(m).filter(([x, y, z]) => isSteel(map.get(x, y, z))));
        const posts = middles.map(([cx, cy, cz]) => {
          let y = cy;
          while (isSteel(map.get(cx, y, cz))) y--;
          const post: number[][] = [];
          for (; map.get(cx, y, cz) === POST; y--) post.push([cx, y, cz]);
          return post;
        });
        // Up, as it is lowered: what is read out, each box's struck voxels, the targets and the shells kept off.
        const raised = {
          readout: up.readout,
          struck: middles.map((m) => box(m).filter(([x, y, z]) => map.get(x, y, z) === HIT).length),
          targets: h.session.targets.length,
          exclusion: h.session.artillery.exclusion.length,
        };
        h.range(false);
        const first = read();
        const left = (cells: number[][][], ids: number[]) => cells.map((c) => c.filter(([x, y, z]) => ids.includes(map.get(x, y, z))).length);
        const lowered = {
          state: h.rangeState(),
          targets: h.session.targets.length,
          exclusion: h.session.artillery.exclusion.length,
          steelInBoxes: first.map((b) => b.filter((p) => p === STEEL || p === HIT).length),
          steelLeft: left(steel, [STEEL, HIT]),
          postLeft: left(posts, [POST]),
        };
        h.range(true);
        const again = h.rangeState().plates.map((p) => p.at);
        h.range(false);
        const second = read();
        return {
          map: h.map,
          plates: up.plates.map((p) => p.at),
          steel: steel.map((c) => c.length),
          posts: posts.map((c) => c.length),
          rung,
          raised,
          lowered,
          again,
          same: JSON.stringify(second) === JSON.stringify(first),
          gpuErrors: h.gpuErrors(),
        };
      },
      { ids: [P.TARGET_STEEL, P.TARGET_STEEL_HIT, P.TIMBER], ring },
    );
    const said = JSON.stringify(seen);
    expect(seen.map).toBe(name);
    const none = seen.plates.map(() => 0);
    expect(seen.plates.length, said).toBeGreaterThanOrEqual(4);
    // Up: each plate's steel (a torso plate's 30 voxels, a head plate's 9) over its timber post.
    for (const n of seen.steel) expect([30, 9], said).toContain(n);
    for (const n of seen.posts) expect(n, said).toBeGreaterThanOrEqual(10);
    // Up as it was lowered: dummies the session's targets, shells kept off them; and on the Ravine the
    // 30 m plate rung by one round, its voxel lead-grey in its box and the readout saying so.
    expect(seen.raised.targets, said).toBeGreaterThan(0);
    expect(seen.raised.exclusion, said).toBeGreaterThan(0);
    if (ring) {
      expect(seen.rung, said).toEqual({ shots: 1, hits: 1 });
      expect(seen.raised.readout, said).toMatch(/^PLATE · (29|30) m$/);
      expect(seen.raised.struck, said).toEqual([1, ...none.slice(1)]);
    } else {
      expect(seen.raised.readout, said).toBeNull();
      expect(seen.raised.struck, said).toEqual(none);
    }
    // Down: no steel left in any plate's box, nor timber where its post stood; no targets, no shells
    // kept off, nothing read out.
    expect(seen.lowered.steelInBoxes, said).toEqual(none);
    expect(seen.lowered.steelLeft, said).toEqual(none);
    expect(seen.lowered.postLeft, said).toEqual(none);
    expect(seen.lowered.state, said).toEqual({ up: false, dummies: [], plates: [], readout: null });
    expect([seen.lowered.targets, seen.lowered.exclusion], said).toEqual([0, 0]);
    // Raised again where it stood, and lowered again: every box as the first lowering left it.
    expect(seen.again, said).toEqual(seen.plates);
    expect(seen.same, said).toBe(true);
    expect(seen.gpuErrors).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("without asking, a test's world has no range", async ({ page }) => {
  const errors = await openGame(page);
  const seen = await ranged(page, async (h) => {
    h.play();
    h.standAt('step');
    await h.waitFrames(10);
    const s = h.session;
    return { state: h.rangeState(), targets: s.targets.length, drawn: h.soldiersDrawn().length, shellsKept: s.artillery.exclusion.length };
  });
  expect(seen).toEqual({ state: { up: false, dummies: [], plates: [], readout: null }, targets: 0, drawn: 0, shellsKept: 0 });
  expect(errors).toEqual([]);
});

test("a visitor's click into solo play raises the range; with ?range=0 it raises none", async ({ page }) => {
  test.setTimeout(300_000);
  const clickIn = async (path: string) => {
    await page.goto(path);
    await page.waitForFunction(() => (window as unknown as { __trenchline?: Hooks }).__trenchline?.ready === true, null, { timeout: 120_000 });
    const before = await hooks(page, (h) => h.rangeState().up);
    await page.locator('#play').click();
    await expect(page.locator('#loading')).toBeHidden();
    const after = await hooks(page, async (h) => {
      await h.waitFrames(5);
      const s = h.rangeState();
      return { up: s.up, dummies: s.dummies.length, plates: s.plates.length };
    });
    return { before, after };
  };
  expect(await clickIn('/')).toEqual({ before: false, after: { up: true, dummies: 5, plates: 4 } });
  expect(await clickIn('/?range=0')).toEqual({ before: false, after: { up: false, dummies: 0, plates: 0 } });
});
