import { expect, test, type Page } from '@playwright/test';
import { P } from '../../src/world/materials';
import { audioRenders, hooks, openGame, type Hooks } from './support/app';

// Hit feedback on the range (the shots spec's §4): a round into a dummy marks the crosshair white and
// thwacks at the ear, and the dummy bleeds; a headshot marks it gold and cracks and gushes, and a kill
// marks it red over that at once, says HEADSHOT under it, thuds and chimes, and the ground behind the
// dummy takes its blood; a dummy that is down is not hit, and nothing says it was; a plate rings.
// Sound is counted as heard only where the page's audio renders (audioRenders): elsewhere what the
// feedback made is counted, and what was heard is not.
test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

type Fed = Hooks & {
  setLoadout(l: unknown): void;
  session: {
    player: { position: { x: number; y: number; z: number }; yaw: number; pitch: number };
    controller: { eyeHeight(p: unknown): number };
    weapon: { shotsFired: number; semi: boolean };
    particles: { capacity: number; billboards(out: Float32Array): number };
  };
};

const fed = <T>(page: Page, fn: (h: Fed, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> => hooks(page, fn as unknown as (h: Hooks, arg: unknown) => T | Promise<T>, arg);

/** The blood shades, by name (ids 83 on, as the palette appends them). */
const BLOOD = Object.entries(P)
  .filter(([name]) => name.startsWith('BLOOD_'))
  .map(([, id]) => id);

/**
 * Solo play from the click that starts it (and its sound), the range asked for, `primary` in the
 * hands, standing on the spawn bay's firing step: the page's errors, and whether its sound renders.
 */
async function onTheStep(page: Page, primary: 'svd' | 'm4'): Promise<{ errors: string[]; renders: boolean }> {
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

test('a torso hit on a dummy: the white marker, a hit voice, blood particles', async ({ page }) => {
  const { errors, renders } = await onTheStep(page, 'm4');
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
      const { chest, hits } = arg as { chest: number[]; hits: number };
      const t0 = performance.now();
      while (performance.now() - t0 < 1500 && h.hitFeedback().markers.hit === hits) await h.waitFrames(1);
      const tick = document.querySelector<HTMLElement>('#hud .marker i')!;
      // Blood is dark red and lit (not emissive): its droplets and mist within a metre and a half.
      const parts = h.session.particles;
      const out = new Float32Array(parts.capacity * 9);
      const n = parts.billboards(out);
      let blood = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 9;
        const a = out[o + 7];
        if (out[o + 8] !== 0 || a <= 0) continue;
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
    { chest, hits: before.markers.hit },
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
  // One thwack at the ear, made, and heard where sound renders; no crack, gush or kill.
  expect((after.voices.hit ?? 0) - (before.voices.hit ?? 0), said).toBe(1);
  for (const k of ['head', 'gush', 'kill']) expect(after.voices[k] ?? 0, said).toBe(before.voices[k] ?? 0);
  if (renders) expect((after.heard.hit ?? 0) - (before.heard.hit ?? 0), said).toBe(1);
  // Its 6 droplets and puff of mist.
  expect(seen.blood, said).toBeGreaterThanOrEqual(7);
  expect(errors).toEqual([]);
});

test('a headshot: the gold marker → the red kill marker, HEADSHOT, gush and kill heard, spatter behind it', async ({ page }) => {
  const { errors, renders } = await onTheStep(page, 'svd');
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
      const shown = { feedback: h.hitFeedback(), className: marker.className, colour: getComputedStyle(marker.querySelector('i')!).backgroundColor, ring: getComputedStyle(marker.querySelector('.ring')!).display };
      // The words popped in, and the readout under them: where each stands on the page.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await h.waitFrames(2);
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)!;
        const r = el.getBoundingClientRect();
        return { shown: !el.hidden, text: el.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return { ...shown, pop: box('#hud .hit-pop'), readout: box('#hud .readout'), word: getComputedStyle(document.querySelector('#hud .hit-pop .word')!).color, dummy: h.rangeState().dummies[0] };
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
  expect([seen.className, seen.colour, seen.ring], said).toEqual(['marker kill', 'rgb(255, 59, 47)', 'block']);
  expect(seen.feedback.pop, said).toBe('HEADSHOT');
  expect([seen.pop.shown, seen.pop.text, seen.word], said).toEqual([true, 'HEADSHOT', 'rgb(255, 200, 61)']);
  // The crack, the gush and the kill's thud and chime at the ear, made, and heard where sound renders.
  for (const k of ['head', 'gush', 'kill']) expect((after.voices[k] ?? 0) - (before.voices[k] ?? 0), `${k}: ${said}`).toBe(1);
  expect(after.voices.hit ?? 0, said).toBe(before.voices.hit ?? 0);
  if (renders) for (const k of ['gush', 'kill']) expect((after.heard[k] ?? 0) - (before.heard[k] ?? 0), `${k} heard: ${said}`).toBe(1);
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
  // Where it lies: fallen away from the eye, its head about a metre and a half beyond its feet.
  const lying = await fed(
    page,
    (h, arg) => {
      const feet = arg as number[];
      const p = h.session.player;
      const away = [feet[0] - p.position.x, feet[2] - p.position.z];
      const n = Math.hypot(away[0], away[1]);
      return [feet[0] + (away[0] / n) * 1.5, feet[1] + 0.2, feet[2] + (away[1] / n) * 1.5];
    },
    dummy.position,
  );
  expect(await shootAt(page, lying)).toBe(1);
  await fed(page, (h) => h.waitFrames(30));
  const after = await tallies(page);
  const state = await fed(page, (h) => h.rangeState().dummies[0]);
  const said = JSON.stringify({ before, after, state });
  expect(state, said).toMatchObject({ id: 200, hp: 0, down: true });
  // No marker, no words, no voice of a hit: a dead body is not hit.
  expect(after.markers, said).toEqual(before.markers);
  for (const k of ['hit', 'head', 'gush', 'kill']) expect(after.voices[k] ?? 0, said).toBe(before.voices[k] ?? 0);
  expect([after.marker, after.pop], said).toEqual([null, null]);
  expect(errors).toEqual([]);
});

test('a plate rings: a ding is heard', async ({ page }) => {
  const { errors, renders } = await onTheStep(page, 'svd');
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
  if (renders) expect((after.heard.ding ?? 0) - (before.heard.ding ?? 0), said).toBe(1);
  expect(errors).toEqual([]);
});
