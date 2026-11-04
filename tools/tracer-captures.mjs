// G1's proof (npm run tracers; the shots spec's §1 and its done-table rows 1-3): a 30-round burst on full
// auto from the AK on the firing step, at 12:00, 19:30 and 22:30 (and at 19:30 aimed down the sights),
// photographed mid-burst with the game frozen and stepped a frame (a sixtieth of a second) at a time.
// It writes artifacts/sp7/tracers/{noon,dusk,night,dusk-aimed}.png and report.json: for each capture
// the brightest tracer head's luminance over the mean luminance of a ring round it (a 30 to 40 px
// annulus of the internal image, outside the glow's 28 px cap), and the burst's GPU p95. The head is
// sought in the image's middle (20 to 75% across) above its lowest quarter, clear of the gun's lower
// body and of the sun, which sits to the right in the dusk and night views.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';
const PORT = 5314;
const OUT = 'artifacts/sp7/tracers';
const SIZE = { width: 1600, height: 1000 };
const RING = [30, 40];
/** The frame of the burst that is photographed: some 18 rounds out, tracers in flight. */
const SHOT_AT = 100;
const FRAMES = 170;
const CAPTURES = [
  { name: 'noon', hours: 12, aimed: false },
  { name: 'dusk', hours: 19.5, aimed: false },
  { name: 'night', hours: 22.5, aimed: false },
  { name: 'dusk-aimed', hours: 19.5, aimed: true },
];

const server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
mkdirSync(OUT, { recursive: true });
const report = {};
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.setQuality({ preset: 'high', dynres: false });
    document.getElementById('loading').hidden = true;
    h.play();
  });
  for (const c of CAPTURES) {
    // Set up thawed: the clock, the AK, the firing step's view, the sights; then frozen for the burst.
    await page.evaluate(async ({ hours, aimed }) => {
      const h = window.__trenchline;
      h.thaw();
      h.trigger(false);
      h.setTimeOfDay(hours);
      h.setLoadout({ primary: 'assault_rifle', secondary: 'm17', fits: {} });
      const v = h.views.step;
      h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: -2 });
      h.aim(aimed);
      await h.waitFrames(120);
    }, c);
    // The burst to the photographed frame; the head is measured, the frame photographed (frozen); the rest follows.
    const first = await page.evaluate(async ({ shotAt, ring }) => {
      const h = window.__trenchline;
      h.freeze();
      h.trigger(true);
      const gpu = [];
      let maxHeads = 0;
      for (let k = 1; k <= shotAt; k++) {
        await h.stepFrames(1);
        const g = h.stats().gpuLastMs;
        if (g != null) gpu.push(g);
        maxHeads = Math.max(maxHeads, h.effects().heads);
      }
      const [w, ht] = h.stats().res;
      const px = await h.sharpAt([0, 0, w, ht]);
      const lum = (i) => 0.2126 * px[i * 3] + 0.7152 * px[i * 3 + 1] + 0.0722 * px[i * 3 + 2];
      let best = -1;
      let bi = 0;
      for (let y = 0; y < ht * 0.75; y++) for (let x = Math.floor(w * 0.2); x < w * 0.75; x++) {
        const l = lum(y * w + x);
        if (l > best) { best = l; bi = y * w + x; }
      }
      const bx = bi % w;
      const by = (bi - bx) / w;
      let sum = 0;
      let n = 0;
      for (let y = Math.max(0, by - ring[1]); y <= Math.min(ht - 1, by + ring[1]); y++) {
        for (let x = Math.max(0, bx - ring[1]); x <= Math.min(w - 1, bx + ring[1]); x++) {
          const d = Math.hypot(x - bx, y - by);
          if (d >= ring[0] && d <= ring[1]) { sum += lum(y * w + x); n++; }
        }
      }
      return { gpu, maxHeads, shot: { res: [w, ht], head: [bx, by], headLum: best, ringMean: sum / n, ringPixels: n, ratio: best / (sum / n) } };
    }, { shotAt: SHOT_AT, ring: RING });
    await page.screenshot({ path: `${OUT}/${c.name}.png` });
    const rest = await page.evaluate(async (frames) => {
      const h = window.__trenchline;
      const gpu = [];
      let maxHeads = 0;
      for (let k = 0; k < frames; k++) {
        await h.stepFrames(1);
        const g = h.stats().gpuLastMs;
        if (g != null) gpu.push(g);
        maxHeads = Math.max(maxHeads, h.effects().heads);
      }
      h.trigger(false);
      return { gpu, maxHeads, effects: h.effects() };
    }, FRAMES - SHOT_AT);
    const gpu = [...first.gpu, ...rest.gpu].sort((x, y) => x - y);
    const result = { shot: first.shot, gpuP95: gpu[Math.floor(gpu.length * 0.95)] ?? null, gpuSamples: gpu.length, maxHeads: Math.max(first.maxHeads, rest.maxHeads), effects: rest.effects };
    report[c.name] = { hours: c.hours, aimed: c.aimed, ...result };
    console.log(c.name, JSON.stringify(result.shot), 'gpu p95', result.gpuP95);
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await server.close();
}
