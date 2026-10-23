import { expect, test } from '@playwright/test';
import { useManyLights } from './many-lights';
import { hooks, openGame } from './support/app';

// 1600 × 1000 CSS pixels at a device scale of 1: a 1.6 MP canvas, so the
// internal image is the high preset's 1.5 MP.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const VIEWS = ['bay', 'step', 'nml-night', 'overview', 'dugout', 'hamlet'];
// The clock's four keys: each view at dusk and at night, as before, at noon, the sky's brightest,
// and at dawn.
const TIMES: Record<string, number> = { dusk: 17 + 35 / 60, night: 21, noon: 12, dawn: 6 + 50 / 60 };
// The overview through the day: every second hour, and round sunrise and sunset, where the sun 0–2°
// up makes the lighting pass's key rays skim the ground (07:10 0.1°, 17:55 1.4°, 18:00 0.6°).
const DAY_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 6 + 40 / 60, 7 + 10 / 60, 17 + 50 / 60, 17 + 55 / 60];
const BUDGET_MS = 14;
// Frames for the histories and the GPU's clocks to settle at a view, then frames whose GPU times
// are read: one frame's time wanders by a millisecond or two, their median does not.
const SETTLE = 90;
const SAMPLES = 31;

/** Each standard view's median GPU time of SAMPLES frames at each key, at `preset` (1.5 MP, dynamic resolution off); null without timestamp queries. */
async function standardViews(page: import('@playwright/test').Page, preset: 'high' | 'low'): Promise<Record<string, Record<string, number>> | null> {
  await hooks(page, (h, p) => h.setQuality({ preset: p as 'high' | 'low', dynres: false }), preset);
  const first = await hooks(page, (h) => h.stats());
  if (first.gpuMs === null && (await hooks(page, async (h) => (await h.waitFrames(30), h.stats().gpuMs))) === null) return null;
  const medians: Record<string, Record<string, number>> = {};
  for (const name of VIEWS) {
    medians[name] = {};
    for (const [time, t] of Object.entries(TIMES)) {
      await hooks(page, (h, n) => h.view(n as string), name);
      await hooks(page, (h, v) => h.setTimeOfDay(v as number), t);
      await hooks(page, (h, n) => h.waitFrames(n as number), SETTLE);
      const times = await hooks(
        page,
        async (h, n) => {
          const out: number[] = [];
          for (let i = 0; i < (n as number); i++) {
            await h.waitFrames(1);
            const s = h.stats();
            if (s.gpuMs !== null) out.push(s.gpuMs);
          }
          return out;
        },
        SAMPLES,
      );
      const s = await hooks(page, (h) => h.stats());
      expect(s.res[0] * s.res[1]).toBeGreaterThan(1.48e6);
      expect(s.preset).toBe(preset);
      expect(times.length).toBeGreaterThan(SAMPLES / 2);
      times.sort((a, b) => a - b);
      medians[name][time] = times[times.length >> 1];
    }
  }
  return medians;
}

test('every standard view renders within the GPU budget at 1.5 MP, at dusk, at night, at noon and at dawn', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = await openGame(page);
  // Measured at the high preset's full 1.5 MP: dynamic resolution would hide a slow view.
  const medians = await standardViews(page, 'high');
  test.skip(medians === null, 'no timestamp queries on this GPU');
  console.log(`GPU ms per view, median of ${SAMPLES} frames (dusk/night/noon/dawn): ${VIEWS.map((v) => `${v} ${Object.keys(TIMES).map((t) => medians![v][t].toFixed(2)).join('/')}`).join(', ')}`);
  expect(errors).toEqual([]);
  for (const name of VIEWS) for (const time of Object.keys(TIMES)) expect(medians![name][time], `${name} at ${time}`).toBeLessThanOrEqual(BUDGET_MS);
});

test('every standard view renders within the GPU budget on the low preset, at the four keys', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = await openGame(page);
  const medians = await standardViews(page, 'low');
  test.skip(medians === null, 'no timestamp queries on this GPU');
  console.log(`GPU ms per view on low, median of ${SAMPLES} frames (dusk/night/noon/dawn): ${VIEWS.map((v) => `${v} ${Object.keys(TIMES).map((t) => medians![v][t].toFixed(2)).join('/')}`).join(', ')}`);
  expect(errors).toEqual([]);
  for (const name of VIEWS) for (const time of Object.keys(TIMES)) expect(medians![name][time], `${name} at ${time}`).toBeLessThanOrEqual(BUDGET_MS);
});

test('a thousand lights at night, 256 of them moving, render within the GPU budget from the overview and in no man\'s land', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await useManyLights(page);
  await hooks(page, (h) => h.runLights());
  const medians: Record<string, number> = {};
  for (const name of ['overview', 'nml-night']) {
    await hooks(page, (h, n) => {
      h.view(n as string);
      h.setTimeOfDay(21);
    }, name);
    await hooks(page, (h, n) => h.waitFrames(n as number), SETTLE);
    const times = await hooks(
      page,
      async (h, n) => {
        const out: number[] = [];
        for (let i = 0; i < (n as number); i++) {
          await h.waitFrames(1);
          const s = h.stats();
          if (s.gpuMs !== null) out.push(s.gpuMs);
        }
        return out;
      },
      SAMPLES,
    );
    test.skip(times.length === 0, 'no timestamp queries on this GPU');
    times.sort((a, b) => a - b);
    medians[name] = times[times.length >> 1];
  }
  console.log(`GPU ms under a thousand lights at night, median of ${SAMPLES} frames: ${Object.entries(medians).map(([v, ms]) => `${v} ${ms.toFixed(2)}`).join(', ')}`);
  expect(errors).toEqual([]);
  for (const [name, ms] of Object.entries(medians)) expect(ms, name).toBeLessThanOrEqual(BUDGET_MS);
});

// Each frame's GPU time and its primary and froxel passes, the medians of SAMPLES frames after
// SETTLE; the clock stepped a sixth of a game minute each frame from `from` if given, else left be.
function sample(page: import('@playwright/test').Page, from: number | null) {
  return hooks(
    page,
    async (h, a) => {
      const [start, settle, n] = a as [number | null, number, number];
      const out: { gpu: number; primary: number; froxels: number; lighting: number; maps: number }[] = [];
      for (let k = 0; k < settle + n; k++) {
        if (start !== null) h.setTimeOfDay(start + k / 360);
        await h.waitFrames(1);
        const s = h.stats();
        // Each pass's own time (not its share of the frame, which a pass run beside another hides);
        // the flares' maps in a pass of their own, on a frame the key's has nothing to trace.
        if (k >= settle && s.gpuMs !== null) out.push({ gpu: s.gpuMs, primary: s.own.primary, froxels: s.own.froxels, lighting: s.own.lighting, maps: s.own.maps ?? 0 });
      }
      const median = (key: 'gpu' | 'primary' | 'froxels' | 'lighting' | 'maps') => out.map((o) => o[key]).sort((x, y) => x - y)[out.length >> 1];
      return { gpu: median('gpu'), primary: median('primary'), froxels: median('froxels'), lighting: median('lighting'), maps: median('maps'), count: out.length };
    },
    [from, SETTLE, SAMPLES],
  );
}

// The shafts while the light moves. With the clock running (ten game minutes a second), the key
// light's height map is traced a sixteenth a frame in front of the primary rays (key-shadow.ts),
// which a held clock never does: the overview at dusk and at dawn, its hardest hours, within the
// budget so; and the shafts all told (the froxels, and what the map adds to the primary pass over
// a still frame) within 0.6 ms.
test('with the clock running, the overview renders within the budget, the shafts within 0.6 ms', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  const lines: string[] = [];
  for (const [time, t] of [['dusk', TIMES.dusk], ['dawn', TIMES.dawn]] as const) {
    await hooks(page, (h, v) => {
      h.view('overview');
      h.setTimeOfDay(v as number);
    }, t);
    const still = await sample(page, null);
    test.skip(still.count === 0, 'no timestamp queries on this GPU');
    // Running through the hour: the frames read lie within five game minutes of it either side.
    const running = await sample(page, t - (SETTLE + SAMPLES / 2) / 360);
    const shafts = running.froxels + running.primary - still.primary;
    lines.push(`${time}: ${running.gpu.toFixed(2)} ms running (${still.gpu.toFixed(2)} still), the shafts ${shafts.toFixed(3)} ms (froxels ${running.froxels.toFixed(3)}, the map ${(running.primary - still.primary).toFixed(3)})`);
    expect(running.gpu, `${time}, running`).toBeLessThanOrEqual(BUDGET_MS);
    expect(shafts, `${time}, the shafts`).toBeLessThanOrEqual(0.6);
  }
  console.log(`The overview with the clock running: ${lines.join('; ')}`);
  expect(errors).toEqual([]);
});

// The flares' shadows: at night the scene's flares burn and sink (the lights' clock running), so
// their maps are traced every frame, in a pass of their own while the key's map has nothing to
// trace; held at rest, they are traced once. The overview at night within the budget so, and the
// shafts all told (the froxels, the flares' maps, and anything they add to the primary pass) within
// 0.6 ms.
test('at night with the flares sinking, the overview renders within the budget, the shafts within 0.6 ms', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openGame(page);
  await hooks(page, (h) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.view('overview');
    h.setTimeOfDay(21);
    h.holdLights();
  });
  const held = await sample(page, null);
  test.skip(held.count === 0, 'no timestamp queries on this GPU');
  await hooks(page, (h) => h.runLights());
  const running = await sample(page, null);
  const shafts = running.froxels + running.maps + running.primary - held.primary;
  console.log(`The overview at night: ${running.gpu.toFixed(2)} ms, the flares sinking (${held.gpu.toFixed(2)} held), the shafts ${shafts.toFixed(3)} ms (froxels ${running.froxels.toFixed(3)}, the flares' maps ${running.maps.toFixed(3)}, the primary ${(running.primary - held.primary).toFixed(3)} more)`);
  expect(errors).toEqual([]);
  expect(running.maps).toBeGreaterThan(0);
  expect(running.gpu).toBeLessThanOrEqual(BUDGET_MS);
  expect(shafts).toBeLessThanOrEqual(0.6);
});

// The overview through the day at the high preset's 1.5 MP, the clock held at each hour.
test('the overview renders within the budget through the day', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  const lines: string[] = [];
  const medians: number[] = [];
  for (const t of DAY_HOURS) {
    await hooks(page, (h, v) => {
      h.view('overview');
      h.setTimeOfDay(v as number);
    }, t);
    const s = await sample(page, null);
    test.skip(s.count === 0, 'no timestamp queries on this GPU');
    medians.push(s.gpu);
    lines.push(`${hhmm(t)} ${s.gpu.toFixed(2)} (lighting ${s.lighting.toFixed(2)})`);
  }
  console.log(`The overview through the day, GPU ms, median of ${SAMPLES} frames: ${lines.join(', ')}`);
  expect(errors).toEqual([]);
  DAY_HOURS.forEach((t, k) => expect(medians[k], hhmm(t)).toBeLessThanOrEqual(BUDGET_MS));
});

// A magazine on full auto, playing at the step view (over the parapet) and along the bay, at dusk and
// at night: the rifle drawn, each shot's flash lighting the trench, tracers, brass and dust. Combat
// milestone 6's gate adds shells and heavy fire to this; here the rifle and its effects alone.
test('firing a magazine stays within the frame budget', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await hooks(page, (h) => h.play());
  const lines: string[] = [];
  for (const view of ['step', 'bay'] as const) {
    for (const [label, hours] of [['dusk', TIMES.dusk], ['night', TIMES.night]] as const) {
      const r = await hooks(
        page,
        async (h, arg) => {
          const { view, hours } = arg as { view: 'step' | 'bay'; hours: number };
          const v = h.views[view];
          h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
          h.setTimeOfDay(hours);
          await h.waitFrames(90);
          (h.session.weapon as { rounds: number }).rounds = 30;
          h.trigger(true);
          const gpu: number[] = [];
          const rifle: number[] = [];
          const effects: number[] = [];
          let frames = 0;
          while (h.session.weapon.rounds > 0 && frames < 400) {
            await h.waitFrames(1);
            frames++;
            const s = h.stats();
            if (s.gpuMs === null) continue;
            gpu.push(s.gpuMs);
            rifle.push(s.own.rifle ?? 0);
            effects.push((s.own.effects ?? 0) + (s.own['effects-light'] ?? 0));
          }
          h.trigger(false);
          const at = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
          return { count: gpu.length, frames, p95: at(gpu, 0.95), median: at(gpu, 0.5), rifle: at(rifle, 0.5), effects: at(effects, 0.5) };
        },
        { view, hours },
      );
      if (r.count === 0) test.skip(true, 'no GPU timestamps');
      lines.push(`${view} ${label}: p95 ${r.p95.toFixed(2)} ms, median ${r.median.toFixed(2)} (the rifle ${r.rifle.toFixed(2)}, the effects ${r.effects.toFixed(2)}) over ${r.frames} frames`);
      expect(r.p95, lines.join('; ')).toBeLessThanOrEqual(BUDGET_MS);
    }
  }
  console.log(`Firing a magazine, GPU ms: ${lines.join('; ')}`);
  expect(errors).toEqual([]);
});

test('shells landing 20–50 m off at one a second, with a magazine fired, stay within the frame budget', async ({ page }) => {
  // Done-table row 3's main thread (no frame over 20 ms while shells land) and the GPU's budget,
  // by each frame's own GPU time (stats' gpuMs is smoothed, and would hide a crater's frame).
  test.setTimeout(300_000);
  const errors = await openGame(page);
  await hooks(page, (h) => h.setQuality({ preset: 'high', dynres: false }));
  await hooks(page, (h) => h.play());
  const lines: string[] = [];
  for (const view of ['step', 'bay'] as const) {
    for (const [label, hours] of [['dusk', TIMES.dusk], ['night', TIMES.night]] as const) {
      const r = await hooks(
        page,
        async (h, arg) => {
          const { view, hours } = arg as { view: 'step' | 'bay'; hours: number };
          const v = h.views[view];
          h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: 0 });
          h.setTimeOfDay(hours);
          await h.waitFrames(90);
          const from = h.frames();
          (h.session.weapon as { rounds: number }).rounds = 30;
          h.trigger(true);
          const gpu: number[] = [];
          const landings: Promise<{ ms: number; bricks: number }>[] = [];
          let seen = h.stats().gpuSamples;
          const p = h.player().position;
          const t0 = performance.now();
          let dropped = 0;
          while (performance.now() - t0 < 6000) {
            if (dropped < 5 && performance.now() - t0 >= dropped * 1000) {
              const angle = 0.7 + dropped * 1.9;
              const d = 20 + dropped * 7;
              landings.push(h.shell([p[0] + Math.cos(angle) * d, 0, p[2] + Math.sin(angle) * d], 2.2 + dropped * 0.3));
              dropped++;
            }
            await h.waitFrames(1);
            const s = h.stats();
            if (s.gpuSamples > seen && s.gpuLastMs !== null) gpu.push(s.gpuLastMs);
            seen = s.gpuSamples;
          }
          h.trigger(false);
          const landed = await Promise.all(landings);
          const frames = h.frames() - from;
          const main = h.mainMs().slice(-frames);
          const at = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
          return { count: gpu.length, frames, p95: at(gpu, 0.95), median: at(gpu, 0.5), max: Math.max(...gpu), mainMax: Math.max(...main), mainP99: at(main, 0.99), landed };
        },
        { view, hours },
      );
      if (r.count === 0) test.skip(true, 'no GPU timestamps');
      lines.push(
        `${view} ${label}: GPU p95 ${r.p95.toFixed(2)} ms, median ${r.median.toFixed(2)}, worst ${r.max.toFixed(2)}; main thread worst ${r.mainMax.toFixed(1)} ms, p99 ${r.mainP99.toFixed(1)}, over ${r.frames} frames; landed in ${r.landed.map((l) => l.ms.toFixed(0)).join('/')} ms`,
      );
      expect(r.landed.length).toBe(5);
      expect(r.p95, lines.join('; ')).toBeLessThanOrEqual(BUDGET_MS);
      expect(r.mainMax, lines.join('; ')).toBeLessThanOrEqual(20);
    }
  }
  console.log(`Shells at one a second and a magazine: ${lines.join('; ')}`);
  expect(errors).toEqual([]);
});

/** An hour of the clock as HH:MM. */
function hhmm(hours: number): string {
  const m = Math.round(hours * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
