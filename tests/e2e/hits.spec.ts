import { expect, test, type Page } from '@playwright/test';
import { BLOOD_BILLBOARD } from '../../src/combat/particles';
import { P } from '../../src/world/materials';
import { audioRenders, hooks, openGame, type Hooks } from './support/app';

// Hit feedback on the range (the shots spec's §4): a round into a dummy marks the crosshair white and
// thwacks at the ear, and the dummy bleeds; a headshot marks it gold and cracks and gushes, and a kill
// marks it red over that at once, says HEADSHOT under it, thuds and chimes, and the ground behind the
// dummy takes its blood; a dummy that is down is not hit, and nothing says it was; a plate rings; an
// M870's pull that kills says KILL, its pellets that struck the dummy dead saying nothing. What the
// feedback made and showed is checked everywhere; what was heard has its own test, which skips (and
// says so) where the page's audio does not render (audioRenders), as the audio specs' do.
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

type Fed = Hooks & {
  setLoadout(l: unknown): void;
  aim(held: boolean): void;
  session: {
    coneDeg(): number;
    player: { position: { x: number; y: number; z: number }; yaw: number; pitch: number };
    controller: { eyeHeight(p: unknown): number };
    weapon: { shotsFired: number; semi: boolean };
    particles: { capacity: number; floats: number; billboards(out: Float32Array): number };
  };
};

const fed = <T>(page: Page, fn: (h: Fed, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> => hooks(page, fn as unknown as (h: Hooks, arg: unknown) => T | Promise<T>, arg);

/** The player's shots, and what their rounds struck, as `record` keeps them on the page: into bodies, and into the world. */
type Struck = { shots: { origin: number[]; tick: number }[]; hits: { body: number; zone: string; tick: number }[]; impacts: { position: number[]; material: number; tick: number }[] };

/** The blood shades, by name (ids 83 on, as the palette appends them). */
const BLOOD = Object.entries(P)
  .filter(([name]) => name.startsWith('BLOOD_'))
  .map(([, id]) => id);

/**
 * Solo play from the click that starts it (and its sound), the range asked for, `primary` in the
 * hands, standing on the spawn bay's firing step: the page's errors, and whether its sound renders.
 */
async function onTheStep(page: Page, primary: 'svd' | 'm4' | 'm870'): Promise<{ errors: string[]; renders: boolean }> {
  const errors = await openGame(page);
  await page.locator('#play').click();
  const renders = await audioRenders(page);
  await fed(
    page,
    async (h, arg) => {
      h.setLoadout({ primary: arg as string, secondary: 'm17', fits: {} });
      // One round a press.
      h.session.weapon.semi = true;
      h.range(true);
      h.standAt('step');
      await h.waitFrames(30);
    },
    primary,
  );
  if (!renders) console.log('the audio clock stands still here (no output renders): what is played is not counted as heard');
  return { errors, renders };
}

/** One press of the trigger, aimed from the eye at `at` (metres): the shots it fired. */
async function shootAt(page: Page, at: readonly number[]): Promise<number> {
  return fed(
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

/** What the feedback has made and the sound has played, by kind, now. */
const tallies = (page: Page) => fed(page, (h) => ({ ...h.hitFeedback(), heard: { ...h.audio().kinds } }));

/**
 * From now, each frame's combat events as the page drains them: the player's shots (from where), and
 * their rounds into bodies and into the world, kept on the page (`struck` reads them). The game's own
 * drain, watched.
 */
async function record(page: Page): Promise<void> {
  await fed(page, (h) => {
    const s = h.session as unknown as {
      drainEvents(): { shots: { origin: number[]; tick: number }[]; hits: { owner: number; body: number; zone: string; tick: number }[]; impacts: { owner: number; position: number[]; material: number; tick: number }[] };
    };
    const w = window as unknown as { __struck: Struck };
    w.__struck = { shots: [], hits: [], impacts: [] };
    const drain = s.drainEvents.bind(s);
    s.drainEvents = () => {
      const e = drain();
      for (const x of e.shots) w.__struck.shots.push({ origin: [...x.origin], tick: x.tick });
      for (const x of e.hits) if (x.owner === 0) w.__struck.hits.push({ body: x.body, zone: x.zone, tick: x.tick });
      for (const i of e.impacts) if (i.owner === 0) w.__struck.impacts.push({ position: [...i.position], material: i.material, tick: i.tick });
      return e;
    };
  });
}

const struck = (page: Page) => page.evaluate(() => (window as unknown as { __struck: Struck }).__struck);

/** The top of what stops a round at (x, z), metres: the first voxel down from `fromY` that is not air or wire. */
const groundAt = (page: Page, x: number, z: number, fromY: number) =>
  fed(
    page,
    (h, arg) => {
      const { x, z, fromY, through } = arg as { x: number; z: number; fromY: number; through: number[] };
      const v = 0.1;
      const [ix, iz] = [Math.floor(x / v), Math.floor(z / v)];
      let iy = Math.floor(fromY / v);
      while (iy > 0 && through.includes(h.world.map.get(ix, iy, iz))) iy--;
      return (iy + 1) * v;
    },
    { x, z, fromY, through: [P.AIR, P.WIRE] },
  );

test('a torso hit on a dummy: the white marker, a hit voice, blood particles', async ({ page }) => {
  const { errors } = await onTheStep(page, 'm4');
  const dummy = await fed(page, (h) => h.rangeState().dummies.find((d) => d.id === 200)!);
  expect(dummy).toMatchObject({ hp: 100, down: false });
  // The chest: the feet and 1.2 m.
  const chest = [dummy.position[0], dummy.position[1] + 1.2, dummy.position[2]];
  const before = await tallies(page);
  expect(await shootAt(page, chest)).toBe(1);
  // The frame the marker comes: what it is and how it looks, and the blood round the chest.
  const seen = await fed(
    page,
    async (h, arg) => {
      const { chest, hits, bloodKind } = arg as { chest: number[]; hits: number; bloodKind: number };
      const t0 = performance.now();
      while (performance.now() - t0 < 1500 && h.hitFeedback().markers.hit === hits) await h.waitFrames(1);
      const tick = document.querySelector<HTMLElement>('#hud .marker i')!;
      // Blood is dark red and lit (not emissive), its own kind: its droplets and mist within a metre and a half.
      const parts = h.session.particles;
      const out = new Float32Array(parts.capacity * parts.floats);
      const n = parts.billboards(out);
      let blood = 0;
      for (let i = 0; i < n; i++) {
        const o = i * parts.floats;
        const a = out[o + 7];
        if (out[o + 8] !== bloodKind || a <= 0) continue;
        const [r, g, b] = [out[o + 4] / a, out[o + 5] / a, out[o + 6] / a];
        if (r < 0.2 || r < 5 * g || r < 5 * b) continue;
        if (Math.hypot(out[o] - chest[0], out[o + 1] - chest[1], out[o + 2] - chest[2]) < 1.5) blood++;
      }
      return {
        feedback: h.hitFeedback(),
        className: document.querySelector('#hud .marker')!.className,
        colour: getComputedStyle(tick).backgroundColor,
        shown: !document.querySelector<HTMLElement>('#hud .marker')!.hidden,
        blood,
        dummy: h.rangeState().dummies[0],
        readout: h.rangeState().readout,
      };
    },
    { chest, hits: before.markers.hit, bloodKind: BLOOD_BILLBOARD },
  );
  await fed(page, (h) => h.waitFrames(3));
  const after = await tallies(page);
  const said = JSON.stringify({ seen, before, after });
  // A hit, not a kill: an M4's chest round, 55.
  expect(seen.dummy, said).toMatchObject({ id: 200, hp: 45, down: false });
  expect(seen.readout, said).toMatch(/^TORSO 55 · 2\d m$/);
  expect(seen.feedback.marker, said).toBe('hit');
  expect([seen.shown, seen.className, seen.colour], said).toEqual([true, 'marker hit', 'rgb(255, 255, 255)']);
  expect(seen.feedback.pop, said).toBeNull();
  expect(after.markers.hit - before.markers.hit, said).toBe(1);
  expect([after.markers.head - before.markers.head, after.markers.kill - before.markers.kill], said).toEqual([0, 0]);
  // One thwack at the ear, made (its hearing is the heard test's); no crack, gush or kill.
  expect((after.voices.hit ?? 0) - (before.voices.hit ?? 0), said).toBe(1);
  for (const k of ['head', 'gush', 'kill']) expect(after.voices[k] ?? 0, said).toBe(before.voices[k] ?? 0);
  // Its 6 droplets, its puff of mist and its entry puff.
  expect(seen.blood, said).toBeGreaterThanOrEqual(8);
  expect(errors).toEqual([]);
});

test('a headshot: the gold marker → the red kill marker, HEADSHOT, the crack, gush and kill made, spatter behind it', async ({ page }) => {
  const { errors } = await onTheStep(page, 'svd');
  const dummy = await fed(page, (h) => h.rangeState().dummies.find((d) => d.id === 200)!);
  const head = [dummy.position[0], dummy.position[1] + 1.62, dummy.position[2]];
  /**
   * Blood on the world behind the dummy: a box from its own line 6 m on, away from the eye, 2 m either
   * side, from a metre under its feet to 2.5 m over them.
   */
  const spattered = () =>
    fed(
      page,
      (h, arg) => {
        const { feet, ids } = arg as { feet: number[]; ids: number[] };
        const blood = new Set(ids);
        const s = h.session;
        const p = s.player;
        const v = 0.1;
        const away = [feet[0] - p.position.x, feet[2] - p.position.z];
        const n = Math.hypot(away[0], away[1]);
        const [ux, uz] = [away[0] / n, away[1] / n];
        const corners = [
          [-0.2, -2],
          [-0.2, 2],
          [6, -2],
          [6, 2],
        ].map(([a, c]) => [feet[0] + ux * a - uz * c, feet[2] + uz * a + ux * c]);
        const lo = [Math.min(...corners.map((q) => q[0])), Math.min(...corners.map((q) => q[1]))].map((m) => Math.floor(m / v));
        const hi = [Math.max(...corners.map((q) => q[0])), Math.max(...corners.map((q) => q[1]))].map((m) => Math.ceil(m / v));
        let count = 0;
        for (let x = lo[0]; x <= hi[0]; x++) {
          for (let z = lo[1]; z <= hi[1]; z++) {
            const dx = (x + 0.5) * v - feet[0];
            const dz = (z + 0.5) * v - feet[2];
            const along = dx * ux + dz * uz;
            const across = -dx * uz + dz * ux;
            if (along < -0.2 || along > 6 || Math.abs(across) > 2) continue;
            for (let y = Math.floor(feet[1] / v) - 10; y <= Math.floor(feet[1] / v) + 25; y++) if (blood.has(h.world.map.get(x, y, z))) count++;
          }
        }
        return count;
      },
      { feet: dummy.position, ids: BLOOD },
    );
  const clean = await spattered();
  const before = await tallies(page);
  expect(await shootAt(page, head)).toBe(1);
  const seen = await fed(
    page,
    async (h, arg) => {
      const kills = arg as number;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500 && h.hitFeedback().markers.kill === kills) await h.waitFrames(1);
      const marker = document.querySelector<HTMLElement>('#hud .marker')!;
      const ringEl = document.querySelector<HTMLElement>('#hud .kill-ring')!;
      /** The kill's ring: shown, how wide it stands on the page, and how opaque. */
      const ring = () => ({ shown: !ringEl.hidden, width: ringEl.getBoundingClientRect().width, opacity: Number(getComputedStyle(ringEl).opacity), colour: getComputedStyle(ringEl).borderTopColor });
      const shown = { feedback: h.hitFeedback(), className: marker.className, colour: getComputedStyle(marker.querySelector('i')!).backgroundColor, ring: ring() };
      // The words popped in, and the readout under them: where each stands on the page.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await h.waitFrames(2);
      const ringLater = ring();
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)!;
        const r = el.getBoundingClientRect();
        return { shown: !el.hidden, text: el.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return { ...shown, ringLater, pop: box('#hud .hit-pop'), readout: box('#hud .readout'), word: getComputedStyle(document.querySelector('#hud .hit-pop .word')!).color, dummy: h.rangeState().dummies[0] };
    },
    before.markers.kill,
  );
  await fed(page, (h) => h.waitFrames(3));
  const after = await tallies(page);
  const said = JSON.stringify({ seen, before, after });
  expect(seen.dummy, said).toMatchObject({ id: 200, hp: 0, down: true });
  // The gold marker as the round struck, and the red kill marker over it at once (the range's own
  // word), ringed; HEADSHOT under it in gold.
  expect([after.markers.head - before.markers.head, after.markers.kill - before.markers.kill, after.markers.hit - before.markers.hit], said).toEqual([1, 1, 0]);
  expect(seen.feedback.marker, said).toBe('kill');
  expect([seen.className, seen.colour, seen.ring.shown, seen.ring.colour], said).toEqual(['marker kill', 'rgb(255, 59, 47)', true, 'rgb(255, 59, 47)']);
  // Its ring going out from the marker and fading, so it frames the dummy: some 200 ms on, wider and fainter.
  expect(seen.ringLater.shown, said).toBe(true);
  expect(seen.ringLater.width, said).toBeGreaterThan(seen.ring.width * 1.2);
  expect(seen.ringLater.opacity, said).toBeLessThan(seen.ring.opacity);
  expect(seen.feedback.pop, said).toBe('HEADSHOT');
  expect([seen.pop.shown, seen.pop.text, seen.word], said).toEqual([true, 'HEADSHOT', 'rgb(255, 200, 61)']);
  // The crack, the gush and the kill's thud and chime at the ear, made (their hearing is the heard test's).
  for (const k of ['head', 'gush', 'kill']) expect((after.voices[k] ?? 0) - (before.voices[k] ?? 0), `${k}: ${said}`).toBe(1);
  expect(after.voices.hit ?? 0, said).toBe(before.voices.hit ?? 0);
  // The words and the readout's two lines under them do not meet.
  expect(seen.readout.shown, said).toBe(true);
  expect(seen.readout.text, said).toMatch(/^HEAD 190 · 2\d m\nDOWN IN 1 · 2\d m$/);
  expect(seen.pop.bottom, said).toBeGreaterThan(seen.pop.top);
  const apart = seen.pop.bottom <= seen.readout.top || seen.readout.bottom <= seen.pop.top || seen.pop.right <= seen.readout.left || seen.readout.right <= seen.pop.left;
  expect(apart, said).toBe(true);
  // Its blood on the ground behind it.
  const marked = await spattered();
  console.log(`spatter behind the 25 m dummy: ${clean} blood voxels before the headshot, ${marked} after`);
  expect(marked, said).toBeGreaterThan(clean);
  expect(errors).toEqual([]);
});

test('a round into a downed dummy gives nothing', async ({ page }) => {
  const { errors } = await onTheStep(page, 'svd');
  const dummy = await fed(page, (h) => h.rangeState().dummies.find((d) => d.id === 200)!);
  // Down with a chest round (an SVD's, 105), and given the time to fall and for the marker and the words to go.
  expect(await shootAt(page, [dummy.position[0], dummy.position[1] + 1.2, dummy.position[2]])).toBe(1);
  await fed(page, async (h) => {
    const t0 = performance.now();
    while (performance.now() - t0 < 1500 && !h.rangeState().dummies[0].down) await h.waitFrames(1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await h.waitFrames(2);
  });
  const before = await tallies(page);
  expect(before.markers.kill, JSON.stringify(before)).toBe(1);
  expect([before.marker, before.pop], JSON.stringify(before)).toEqual([null, null]);
  // Where it lies: fallen away from the eye, its head about a metre and a half beyond its feet, on
  // the ground: the round goes through where its head lies, 10 cm over the ground.
  const head = await fed(
    page,
    (h, arg) => {
      const feet = arg as number[];
      const p = h.session.player;
      const away = [feet[0] - p.position.x, feet[2] - p.position.z];
      const n = Math.hypot(away[0], away[1]);
      return [feet[0] + (away[0] / n) * 1.5, feet[2] + (away[1] / n) * 1.5];
    },
    dummy.position,
  );
  const lying = [head[0], (await groundAt(page, head[0], head[1], dummy.position[1] + 1)) + 0.1, head[1]];
  await record(page);
  expect(await shootAt(page, lying)).toBe(1);
  await fed(page, (h) => h.waitFrames(30));
  const after = await tallies(page);
  const state = await fed(page, (h) => h.rangeState().dummies[0]);
  // It reached the body: its round went by within half a metre of where the head lies, nothing
  // stopping it short, and struck the world beyond it. (From the step it runs about 4° down, over
  // ground that is not level: it may skim on a few metres before it meets the ground.)
  const { shots, hits, impacts } = await struck(page);
  expect([shots.length, impacts.length], JSON.stringify({ shots, impacts })).toEqual([1, 1]);
  const o = shots[0].origin;
  const hit = impacts[0].position;
  const flown = Math.hypot(hit[0] - o[0], hit[1] - o[1], hit[2] - o[2]);
  const way = [0, 1, 2].map((k) => (hit[k] - o[k]) / flown);
  const along = [0, 1, 2].reduce((sum, k) => sum + (lying[k] - o[k]) * way[k], 0);
  const by = Math.hypot(...[0, 1, 2].map((k) => lying[k] - (o[k] + way[k] * along)));
  const said = JSON.stringify({ before, after, state, lying, shots, hits, impacts, along, by, flown });
  console.log(`the round at the lying dummy went by ${by.toFixed(3)} m from where its head lies, ${along.toFixed(2)} m out, and struck the world ${flown.toFixed(2)} m out`);
  expect(hits, said).toEqual([]);
  expect(by, said).toBeLessThan(0.5);
  expect(flown, said).toBeGreaterThan(along);
  expect(state, said).toMatchObject({ id: 200, hp: 0, down: true });
  // No marker, no words, no voice of a hit: a dead body is not hit.
  expect(after.markers, said).toEqual(before.markers);
  for (const k of ['hit', 'head', 'gush', 'kill']) expect(after.voices[k] ?? 0, said).toBe(before.voices[k] ?? 0);
  expect([after.marker, after.pop], said).toEqual([null, null]);
  expect(errors).toEqual([]);
});

test('a plate rings: the hit marker, and a ding made', async ({ page }) => {
  const { errors } = await onTheStep(page, 'svd');
  const plate = await fed(page, (h) => h.rangeState().plates[0]);
  expect(plate).toMatchObject({ index: 0, hits: 0 });
  const before = await tallies(page);
  expect(await shootAt(page, plate.at)).toBe(1);
  const seen = await fed(page, async (h) => {
    const t0 = performance.now();
    while (performance.now() - t0 < 1500 && h.rangeState().plates[0].hits === 0) await h.waitFrames(1);
    const marker = h.hitFeedback().marker;
    // Its ring goes out with the next frame's voices.
    await h.waitFrames(3);
    return { hits: h.rangeState().plates[0].hits, marker };
  });
  const after = await tallies(page);
  const said = JSON.stringify({ seen, before, after });
  expect(seen, said).toEqual({ hits: 1, marker: 'hit' });
  expect(after.markers.hit - before.markers.hit, said).toBe(1);
  expect((after.voices.ding ?? 0) - (before.voices.ding ?? 0), said).toBe(1);
  // Nothing of a body's.
  for (const k of ['hit', 'head', 'gush', 'kill']) expect(after.voices[k] ?? 0, said).toBe(before.voices[k] ?? 0);
  expect(errors).toEqual([]);
});

test("an M870's kill at 15 m says KILL, as the readout says, and the pellets that struck the dummy dead say nothing", async ({ page }) => {
  const { errors } = await onTheStep(page, 'm870');
  // No fire from the front, out in the open.
  await fed(page, (h) => h.setIntensity('off'));
  const dummy = await fed(page, (h) => h.rangeState().dummies.find((d) => d.id === 200)!);
  // Out on the ground 15 m short of it, on the line from the step, facing it.
  const spot = await fed(
    page,
    (h, arg) => {
      const feet = arg as number[];
      const p = h.session.player;
      const away = [feet[0] - p.position.x, feet[2] - p.position.z];
      const n = Math.hypot(away[0], away[1]);
      return { x: feet[0] - (away[0] / n) * 15, z: feet[2] - (away[1] / n) * 15, yaw: (Math.atan2(away[0], away[1]) * 180) / Math.PI };
    },
    dummy.position,
  );
  const ground = await groundAt(page, spot.x, spot.z, dummy.position[1] + 3);
  await fed(
    page,
    async (h, arg) => {
      const a = arg as { x: number; z: number; yaw: number; y: number };
      h.teleport({ position: [a.x, a.y + 0.05, a.z], yaw: a.yaw, pitch: 0 });
      await h.waitFrames(30);
    },
    { ...spot, y: ground },
  );
  const stood = await fed(page, (h) => h.player().position);
  const range = Math.hypot(dummy.position[0] - stood[0], dummy.position[2] - stood[2]);
  expect(range, JSON.stringify({ stood, dummy })).toBeGreaterThan(14);
  expect(range, JSON.stringify({ stood, dummy })).toBeLessThan(16);
  await record(page);
  // One pull at its pelvis, aimed down the sights, so its pellets keep out of the head. Where a pull's
  // pellets go is its own (combat/weapon.ts pelletDirs: the first on the aim, the rest within the cone
  // about it, drawn from the shot's seat and tick, so from the moment it leaves), so the cone itself
  // keeps out of the head: aimed, the M870's pattern is 0.7 of its 160 MOA (net/gear.ts stepShare),
  // 0.49 m out at 15 m, and from 0.9 m up it reaches 1.39 m, under the neck at 1.47 m
  // (combat/soldier-rig.ts: the hips at 0.92, the torso 0.55 over them). The dummy stands at 10 hp
  // first (the rangeHp hook, a test's), under a limb pellet's 13: the pull's first pellet into it kills
  // it, whatever zone, and every one after that strikes it dead, which is what the test is about.
  const pelvis = [dummy.position[0], dummy.position[1] + 0.9, dummy.position[2]];
  const hp = 10;
  await fed(page, async (h) => {
    h.aim(true);
    await h.waitFrames(30);
  });
  await fed(page, (h, hp) => h.rangeHp(200, hp as number), hp);
  expect(await fed(page, (h) => h.rangeState().dummies[0])).toMatchObject({ id: 200, hp, down: false });
  const damage: Record<string, number> = { torso: 23, head: 42, limb: 13 };
  const before = await tallies(page);
  const coneDeg = await fed(page, (h) => h.session.coneDeg());
  expect(0.9 + range * Math.tan((coneDeg * Math.PI) / 180), `the pattern's top, aimed at the pelvis: ${JSON.stringify({ coneDeg, range })}`).toBeLessThan(1.47 - 0.05);
  expect(await shootAt(page, pelvis)).toBe(1);
  const seen = await fed(
    page,
    async (h, kills) => {
      const t0 = performance.now();
      while (performance.now() - t0 < 600 && h.hitFeedback().markers.kill === kills) await h.waitFrames(1);
      const feedback = { ...h.hitFeedback(), heard: {} };
      const state = h.rangeState();
      return { feedback, readout: state.readout, down: state.dummies[0].down };
    },
    before.markers.kill,
  );
  // The pump worked, the recoil settled.
  await fed(page, (h) => h.waitFrames(50));
  const after = await tallies(page);
  const { hits } = await struck(page);
  // The pull's pellets into the dummy, by tick (the pull's alone: none struck it before): those that
  // struck it alive, the one that killed it (the range's damage, 23 to the torso, 42 to the head, 13
  // to a limb), and those that struck it dead.
  const pull = hits.filter((x) => x.body === 200);
  let left = hp;
  const lethal = pull.findIndex((x) => (left -= damage[x.zone]) <= 0);
  const said = JSON.stringify({ seen, before, after, hits });
  console.log(`the M870 at ${range.toFixed(1)} m: its pellets into the dummy ${pull.map((x) => x.zone).join(', ')}: pellet ${lethal + 1} of ${pull.length} killing it from ${hp} hp, ${pull.length - lethal - 1} striking it dead`);
  expect(seen.down, said).toBe(true);
  expect(pull.length, said).toBeGreaterThan(0);
  // What the test is about holds: the pull's first pellet into it killed it, and at least one after it struck it dead.
  expect(lethal, said).toBe(0);
  expect(pull.length - lethal - 1, said).toBeGreaterThanOrEqual(1);
  // The readout's line is the pull's: not HEAD, its pellets into the head (if any) all after the kill.
  expect(seen.readout, said).toMatch(/^(TORSO|LIMB) \d+ · 1\d m\nDOWN IN \d · 1\d m$/);
  expect(pull.slice(0, lethal + 1).some((x) => x.zone === 'head'), said).toBe(false);
  // KILL under the red marker; nothing of a headshot from the pull, whatever struck the dummy dead.
  expect([seen.feedback.marker, seen.feedback.pop], said).toEqual(['kill', 'KILL']);
  expect([after.markers.kill - before.markers.kill, after.markers.head - before.markers.head], said).toEqual([1, 0]);
  for (const k of ['head', 'gush']) expect(after.voices[k] ?? 0, `${k}: ${said}`).toBe(before.voices[k] ?? 0);
  expect((after.voices.kill ?? 0) - (before.voices.kill ?? 0), said).toBe(1);
  expect(errors).toEqual([]);
});

test("the HUD's count is each shot's own, in play: the frame a round leaves, the count says it has gone", async ({ page }) => {
  const { errors } = await onTheStep(page, 'm4');
  // In play, not stepped: three single shots at the ground before the step, each read the frame it leaves.
  const seen = await fed(page, async (h) => {
    const s = h.session;
    const p = s.player;
    p.pitch = -8;
    await h.waitFrames(10);
    const reads: { rounds: number; line: string }[] = [];
    for (let k = 0; k < 3; k++) {
      const fired = s.weapon.shotsFired;
      h.trigger(true);
      for (let f = 0; f < 30 && s.weapon.shotsFired === fired; f++) await h.waitFrames(1);
      h.trigger(false);
      reads.push({ rounds: s.weapon.rounds, line: h.hud().text.split('\n').find((l) => / \/ /.test(l)) ?? '' });
      await h.waitFrames(12);
    }
    return { reads, magazine: (s.weapon as unknown as { spec: { magazine: number } }).spec.magazine };
  });
  const said = JSON.stringify(seen);
  expect(seen.reads, said).toHaveLength(3);
  for (const r of seen.reads) expect(r.line, said).toBe(`${r.rounds} / ${seen.magazine}`);
  expect(seen.reads.map((r) => r.rounds), said).toEqual([seen.magazine - 1, seen.magazine - 2, seen.magazine - 3]);
  expect(errors).toEqual([]);
});

test("what the range's hits make is heard: a hit's thwack, a headshot's gush and the kill's thud, a plate's ding", async ({ page }) => {
  const { errors, renders } = await onTheStep(page, 'm4');
  test.skip(!renders, 'the audio clock stands still here (no output renders): what is played cannot be counted as heard');
  const dummy = await fed(page, (h) => h.rangeState().dummies.find((d) => d.id === 200)!);
  const plate = await fed(page, (h) => h.rangeState().plates[0]);
  /** One press at `at`, a few frames on for its voices, and what was heard of each kind meanwhile. */
  const heard = async (at: readonly number[]) => {
    const before = await tallies(page);
    expect(await shootAt(page, at)).toBe(1);
    await fed(page, (h) => h.waitFrames(30));
    const after = await tallies(page);
    const kinds = new Set([...Object.keys(before.heard), ...Object.keys(after.heard)]);
    return Object.fromEntries([...kinds].map((k) => [k, (after.heard[k] ?? 0) - (before.heard[k] ?? 0)]).filter(([, n]) => n !== 0));
  };
  // An M4's chest round (55): the thwack. Then its head (100, the kill): the crack, the gush, and the kill's thud and chime.
  expect(await heard([dummy.position[0], dummy.position[1] + 1.2, dummy.position[2]])).toMatchObject({ hit: 1 });
  expect(await heard([dummy.position[0], dummy.position[1] + 1.62, dummy.position[2]])).toMatchObject({ head: 1, gush: 1, kill: 1 });
  expect(await heard(plate.at)).toMatchObject({ ding: 1 });
  expect(errors).toEqual([]);
});
