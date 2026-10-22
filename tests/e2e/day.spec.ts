import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The day on the clock, as the game shows it: the exposure at the approved keys, and a whole day
// passing without the frame jumping in brightness.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

const DUSK = 17 + 35 / 60;

test('dusk and night keep the exposures they were approved at', async ({ page }) => {
  const errors = await openGame(page);
  for (const [hours, want] of [[DUSK, 1.0], [21, 3.2]]) {
    await hooks(page, (h, t) => {
      h.view('nml-night');
      h.setTimeOfDay(t as number);
    }, hours);
    await hooks(page, (h) => h.waitFrames(10));
    const exposure = await hooks(page, (h) => h.exposure());
    expect(Math.abs(exposure / want - 1), `${hours} h: exposure ${exposure}`).toBeLessThan(0.1);
  }
  expect(errors).toEqual([]);
});

// Row 4 of the done table: the whole day plays without a jump, each frame's brightness changing by
// under 2% a game minute. The exposure is reckoned from the light (exposure.wgsl), and the haze that
// fills a level view glows with the key light, so the two follow each other through sunset and sunrise.
test('a whole day at time-lapse runs without a jump, and under 2% a game minute', async ({ page }) => {
  test.setTimeout(480_000);
  const errors = await openGame(page);
  await hooks(page, (h) => {
    h.setQuality({ preset: 'high', dynres: false });
    h.view('nml-night');
  });
  // Ten minutes a second at 60 frames a second, from dusk round to dusk: a frame every sixth of a
  // game minute, with its mean brightness and the sun's elevation it was lit at.
  const frames = await hooks(page, async (h, start) => {
    const out: [number, number][] = [];
    h.setTimeOfDay(start as number);
    await h.waitFrames(60);
    for (let k = 0; k <= 24 * 60 * 6; k++) {
      h.setTimeOfDay(((start as number) + k / 360) % 24);
      const s = await h.snapshot();
      out.push([s.mean, h.sunElevation()]);
    }
    return out;
  }, DUSK);
  const change = (k: number, back: number) => Math.abs(frames[k][0] - frames[k - back][0]) / Math.max(frames[k - back][0], 0.02);
  const clock = (k: number) => {
    const m = Math.round(DUSK * 60 + k / 6) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const worst = (back: number, keep: (k: number) => boolean) => {
    let w = [0, 0];
    for (let k = back; k < frames.length; k++) if (keep(k) && change(k, back) > w[0]) w = [change(k, back), k];
    return w;
  };
  // Within 6° of the horizon the key light comes and goes: the hardest hours, reported apart.
  const low = (k: number) => Math.abs(frames[k][1]) <= 6 || Math.abs(frames[k - 6][1]) <= 6;
  const [jump, jumpAt] = worst(1, () => true);
  const [minute, minuteAt] = worst(6, () => true);
  const [clear, clearAt] = worst(6, (k) => !low(k));
  console.log(
    `a day's frames: mean brightness ${Math.min(...frames.map((f) => f[0])).toFixed(3)} to ${Math.max(...frames.map((f) => f[0])).toFixed(3)}; ` +
      `worst frame to frame ${(jump * 100).toFixed(2)}% at ${clock(jumpAt)}; worst minute ${(minute * 100).toFixed(2)}% at ${clock(minuteAt)}, ` +
      `with the sun clear of the horizon ${(clear * 100).toFixed(2)}% at ${clock(clearAt)}`,
  );
  expect(errors).toEqual([]);
  expect(jump).toBeLessThan(0.02);
  expect(minute).toBeLessThan(0.02);
});
