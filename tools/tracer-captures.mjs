// G1's proof (npm run tracers; the shots spec's §1 and its done-table rows 1-3): a 30-round burst on full
// auto from the AK on the firing step, aimed at a point 30 m out over no man's land, at 12:00, 19:30 and
// 22:30 (and at 19:30 aimed down the sights), photographed mid-burst with the game frozen and stepped one
// frame (a sixtieth of a second) at a time.
//
//   npm run tracers [-- --only noon,dusk]
//
// Writes artifacts/sp7/tracers/<name>.png, <name>-marked.png (a 1 px magenta box round every head
// measured) and report.json (merged with what a run of a few captures left). Exits 1 if a threshold
// fails, a page error is seen, the hook is missing or a measurement is null.
//
// Two halves, kept apart so more metrics can be built on them: captureAt() fires and photographs
// (the PNG as displayed, with the player's tracers projected onto it by the frame's own camera, from
// the hook window.__trenchline.tracerPixels), and measure() reads the displayed pixels.
//
// The measure, in displayed values (sRGB-encoded 0-255 luminance, Rec. 709 weights): each drawn
// tracer head's brightest pixel within HEAD_PX of its projected point, over the mean of a RING_PX
// annulus round it, left out of the ring: the gun's drawn box, and any pixel brighter than the sky's
// 99th percentile (the flash, the sun, other tracers). Fewer than RING_MIN_PIXELS left fails.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { createServer } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

const PORT = 5314;
const OUT = 'artifacts/sp7/tracers';
const SIZE = { width: 1600, height: 1000 };
/** The page's wait for a frame, ms: the longest a step, a settle or a read may take before the run fails. */
const FRAME_TIMEOUT_MS = 20_000;
/** Frames drawn thawed for the lights, the TAA and the hands to settle after the clock, the pose and the sights are set. */
const SETTLE_FRAMES = 120;
/** The target, metres out along the line of sight over no man's land; and how far below the eye it is (a man's chest from the step). */
const TARGET_M = 30;
const TARGET_DROP_M = 0.4;
/** The photograph: the first frame this many frames after the first round leaves (an AK's 650 rpm is a round every 5.5 frames: some round 15 of 30) with a tracer's head drawn (a round lives only a few frames, so not every frame has one). */
const SHOT_AFTER_FIRST = 80;
/** The longest a burst is stepped before it fails, frames (30 rounds is some 166 frames, and the last round's flight after). */
const BURST_MAX_FRAMES = 500;
/** The head: its brightest pixel within this many pixels of where it projects (Chebyshev). */
const HEAD_PX = 2;
/** The background ring round it, pixels: the brief's 40 px, an annulus this wide (the glow is drawn at most 28 px). */
const RING_PX = [30, 40];
/** The gun's drawn box is left out of the ring, grown by this many pixels for its flash and the sight's glow. */
const GUN_PAD_PX = 12;
/** A gun box covering more of the image than this is not a mask (aimed, it is the whole view). */
const GUN_BOX_MAX_SHARE = 0.5;
/** The sky, for the brightness a ring pixel may not pass: the image's top rows, and the percentile of them. */
const SKY_ROWS = 0.3;
const SKY_PERCENTILE = 0.99;
/** The least ring pixels left; fewer fails. */
const RING_MIN_PIXELS = 200;
/** The brief's head-over-ring (displayed luminance), at least. */
const MIN_RATIO = 3;
/** The least GPU samples inside the burst, else the p95 is not trusted. */
const MIN_GPU_SAMPLES = 60;
/** A ring mean under this (0-255) is read as this, so a black ring does not divide by zero. */
const RING_FLOOR = 1;
const CAPTURES = [
  { name: 'noon', hours: 12, aimed: false },
  { name: 'dusk', hours: 19.5, aimed: false },
  { name: 'night', hours: 22.5, aimed: false },
  { name: 'dusk-aimed', hours: 19.5, aimed: true },
];

// ---- capture -----------------------------------------------------------------------------------

const withTimeout = (promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out (${FRAME_TIMEOUT_MS} ms): ${what}`)), FRAME_TIMEOUT_MS))]);

/** Fire the burst for `c` and photograph it; returns the PNG as displayed, the projected tracers and the burst's own numbers. */
async function captureAt(page, c) {
  await withTimeout(
    page.evaluate(
      async ({ hours, aimed, settle, targetM, drop }) => {
        const h = window.__trenchline;
        h.thaw();
        h.trigger(false);
        h.setTimeOfDay(hours);
        h.setLoadout({ primary: 'assault_rifle', secondary: 'm17', fits: {} });
        const v = h.views.step;
        // The eye is the step's view; aimed at a point targetM out along the view's yaw, drop below the eye.
        const pitch = (Math.atan2(-drop, targetM) * 180) / Math.PI;
        h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch });
        h.aim(aimed);
        await h.waitFrames(settle);
      },
      { hours: c.hours, aimed: c.aimed, settle: SETTLE_FRAMES, targetM: TARGET_M, drop: TARGET_DROP_M },
    ),
    `${c.name}: setting up`,
  );
  const step = () =>
    withTimeout(
      page.evaluate(async () => {
        const h = window.__trenchline;
        await h.stepFrames(1);
        const s = h.stats();
        return { frame: h.frames(), gpu: s.gpuLastMs, gpuSamples: s.gpuSamples, ...(({ weapon, tracers }) => ({ rounds: weapon.rounds, live: tracers.length, heads: tracers.filter((t) => t.headDrawn).length }))(h.tracerPixels()) };
      }),
      `${c.name}: a frame`,
    );
  const first = await withTimeout(page.evaluate(() => {
    const h = window.__trenchline;
    h.freeze();
    const t = h.tracerPixels();
    h.trigger(true);
    return { rounds: t.weapon.rounds, weapon: t.weapon, frame: h.frames() };
  }), `${c.name}: freezing`);
  if (!first.weapon.automatic || first.weapon.semi) throw new Error(`${c.name}: the gun is not on full auto: ${JSON.stringify(first.weapon)}`);
  if (first.rounds !== first.weapon.magazine) throw new Error(`${c.name}: the magazine is not full: ${first.rounds}/${first.weapon.magazine}`);
  const gpu = [];
  let lastSamples = -1;
  let firstShotAt = null;
  let lastShotAt = null;
  let shot = null;
  let retired = null;
  let rounds = first.rounds;
  let frame0 = first.frame;
  for (let k = 1; k <= BURST_MAX_FRAMES; k++) {
    const s = await step();
    if (firstShotAt === null && s.rounds < rounds) firstShotAt = k;
    if (s.rounds < rounds) lastShotAt = k;
    rounds = s.rounds;
    // Samples inside the burst only: from the first shot to the last round's retirement; a new sample, never a repeat.
    if (firstShotAt !== null && retired === null && s.gpu != null && s.gpuSamples !== lastSamples) gpu.push(s.gpu);
    lastSamples = s.gpuSamples;
    if (firstShotAt !== null && shot === null && k >= firstShotAt + SHOT_AFTER_FIRST && s.heads > 0) {
      const info = await withTimeout(page.evaluate(() => window.__trenchline.tracerPixels()), `${c.name}: reading the tracers`);
      if (info.frame !== s.frame && info.frame !== s.frame + 1) throw new Error(`${c.name}: the tracers read are of frame ${info.frame}, the step ${s.frame}`);
      // The HUD's crosshair and reticle are white at the middle, where the converged rounds are: out of the measured picture.
      await page.addStyleTag({ content: '#hud .crosshair, #hud .reticle { visibility: hidden !important; }' }).then((el) => el.evaluate((n) => (n.id = 'tracer-captures-hide')));
      const png = await withTimeout(page.screenshot(), `${c.name}: the screenshot`);
      await page.evaluate(() => document.getElementById('tracer-captures-hide')?.remove());
      shot = { png, info, k, roundsLeft: s.rounds };
    }
    if (s.rounds === 0 && s.live === 0) { retired = k; break; }
  }
  await page.evaluate(() => window.__trenchline.trigger(false));
  if (firstShotAt === null || shot === null || retired === null) throw new Error(`${c.name}: the burst did not run: first shot ${firstShotAt}, photographed ${shot !== null}, retired ${retired}`);
  return {
    png: shot.png,
    info: shot.info,
    burst: { firstShotFrame: firstShotAt, lastShotFrame: lastShotAt, framesFor30Rounds: lastShotAt - firstShotAt + 1, shotFrame: shot.k, roundsLeftAtShot: shot.roundsLeft, retiredFrame: retired, frameBase: frame0 },
    gpu,
  };
}

// ---- measure -----------------------------------------------------------------------------------

/** The displayed luminance (Rec. 709 weights on the sRGB-encoded 0-255 values) of a decoded PNG, and its size. */
function displayed(buffer) {
  const png = PNG.sync.read(buffer);
  const lum = new Float32Array(png.width * png.height);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
  }
  return { png, lum, w: png.width, h: png.height };
}

/** Head-over-ring for each drawn head of `info.tracers`, and the headline (the head brightest in display). */
function measure(buffer, info) {
  const { lum, w, h } = displayed(buffer);
  if (w !== info.res[0] || h !== info.res[1]) throw new Error(`the screenshot is ${w}x${h}, the canvas ${info.res.join('x')}`);
  const skyN = Math.floor(w * h * SKY_ROWS);
  const sky = Array.from(lum.subarray(0, skyN)).sort((a, b) => a - b);
  const skyP99 = sky[Math.min(skyN - 1, Math.floor(skyN * SKY_PERCENTILE))];
  const boxed = info.gun ? [info.gun[0] - GUN_PAD_PX, info.gun[1] - GUN_PAD_PX, info.gun[0] + info.gun[2] + GUN_PAD_PX, info.gun[1] + info.gun[3] + GUN_PAD_PX] : null;
  // Aimed down the sights the rifle's box is the whole image (its sights and receiver fill the view): no mask then, and the ring takes the gun's pixels with it, which is flagged in the report.
  const gun = boxed && (boxed[2] - boxed[0]) * (boxed[3] - boxed[1]) <= GUN_BOX_MAX_SHARE * w * h ? boxed : null;
  const inGun = (x, y) => gun !== null && x >= gun[0] && x < gun[2] && y >= gun[1] && y < gun[3];
  const heads = [];
  const skipped = [];
  for (const t of info.tracers) {
    if (!t.headDrawn || !t.head) continue;
    const [px, py] = t.head;
    const cx = Math.round(px - 0.5);
    const cy = Math.round(py - 0.5);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) { skipped.push({ at: t.head, why: 'off the image' }); continue; }
    if (inGun(cx, cy)) { skipped.push({ at: t.head, why: 'inside the gun box', gun }); continue; }
    let head = 0;
    for (let y = Math.max(0, cy - HEAD_PX); y <= Math.min(h - 1, cy + HEAD_PX); y++) {
      for (let x = Math.max(0, cx - HEAD_PX); x <= Math.min(w - 1, cx + HEAD_PX); x++) head = Math.max(head, lum[y * w + x]);
    }
    let sum = 0;
    let n = 0;
    let dropped = 0;
    for (let y = Math.max(0, cy - RING_PX[1]); y <= Math.min(h - 1, cy + RING_PX[1]); y++) {
      for (let x = Math.max(0, cx - RING_PX[1]); x <= Math.min(w - 1, cx + RING_PX[1]); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < RING_PX[0] || d > RING_PX[1]) continue;
        if (inGun(x, y) || lum[y * w + x] > skyP99) { dropped++; continue; }
        sum += lum[y * w + x];
        n++;
      }
    }
    const ringMean = n > 0 ? sum / n : null;
    heads.push({ at: [Math.round(px * 10) / 10, Math.round(py * 10) / 10], flownM: Math.round(t.flown * 10) / 10, headLum: head, ringMean, ringPixels: n, ringDropped: dropped, ratio: ringMean === null ? null : head / Math.max(ringMean, RING_FLOOR) });
  }
  const valid = heads.filter((x) => x.ringPixels >= RING_MIN_PIXELS);
  valid.sort((a, b) => b.headLum - a.headLum);
  return { size: [w, h], skyP99, tracersProjected: info.tracers.length, headsDrawn: info.tracers.filter((t) => t.headDrawn).length, headsMeasured: heads.length, headsValid: valid.length, gunMasked: gun !== null, skipped, headline: valid[0] ?? null, heads };
}

/** A copy of the PNG with a 1 px magenta box round each measured head (the headline's larger). */
function marked(buffer, m) {
  const png = PNG.sync.read(buffer);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const i = (y * png.width + x) * 4;
    png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 255; png.data[i + 3] = 255;
  };
  for (const hd of m.heads) {
    const r = hd === m.headline ? 14 : 8;
    const cx = Math.round(hd.at[0] - 0.5);
    const cy = Math.round(hd.at[1] - 0.5);
    for (let d = -r; d <= r; d++) { put(cx + d, cy - r); put(cx + d, cy + r); put(cx - r, cy + d); put(cx + r, cy + d); }
  }
  return PNG.sync.write(png);
}

const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.95)] : null; };

// ---- run ---------------------------------------------------------------------------------------

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const chosen = CAPTURES.filter((c) => !only || only.includes(c.name));
if (chosen.length === 0) { console.error(`--only: none of ${CAPTURES.map((c) => c.name).join(', ')}`); process.exit(2); }
const failures = [];
const pageErrors = [];
const report = existsSync(`${OUT}/report.json`) ? JSON.parse(readFileSync(`${OUT}/report.json`, 'utf8')) : {};
let server;
let browser;
try {
  server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log(`[page error] ${e.message}`); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  if (!(await page.evaluate(() => typeof window.__trenchline.tracerPixels === 'function'))) throw new Error('the page has no tracerPixels hook');
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.setQuality({ preset: 'high', dynres: false });
    document.getElementById('loading').hidden = true;
    h.play();
  });
  for (const c of chosen) {
    try {
      const cap = await captureAt(page, c);
      writeFileSync(`${OUT}/${c.name}.png`, cap.png);
      const m = measure(cap.png, cap.info);
      writeFileSync(`${OUT}/${c.name}-marked.png`, marked(cap.png, m));
      const gpuP95 = p95(cap.gpu);
      report[c.name] = { hours: c.hours, aimed: c.aimed, weapon: cap.info.weapon, burst: cap.burst, gpuSamples: cap.gpu.length, gpuP95, thresholds: { minRatio: MIN_RATIO, minGpuSamples: MIN_GPU_SAMPLES, ringMinPixels: RING_MIN_PIXELS }, ...m };
      const hl = m.headline;
      console.log(`${c.name}: heads ${m.headsMeasured} measured of ${m.headsDrawn} drawn; headline ${hl ? `lum ${hl.headLum.toFixed(1)} over ring ${hl.ringMean.toFixed(1)} (n ${hl.ringPixels}) = ${hl.ratio.toFixed(2)}` : 'none'}; gpu p95 ${gpuP95 === null ? 'n/a' : gpuP95.toFixed(2)} ms over ${cap.gpu.length} samples; 30 rounds in ${cap.burst.framesFor30Rounds} frames`);
      if (m.headsDrawn < 1) failures.push(`${c.name}: no tracer head drawn at the shot frame`);
      else if (!hl) failures.push(`${c.name}: no head measured with a ring of ${RING_MIN_PIXELS}+ pixels (${m.headsMeasured} measured)`);
      else if (!(hl.ratio >= MIN_RATIO)) failures.push(`${c.name}: head over ring ${hl.ratio.toFixed(2)} < ${MIN_RATIO}`);
      if (cap.gpu.length < MIN_GPU_SAMPLES) failures.push(`${c.name}: ${cap.gpu.length} GPU samples in the burst < ${MIN_GPU_SAMPLES}`);
    } catch (e) {
      failures.push(`${c.name}: ${e.message}`);
      console.log(`${c.name}: FAILED ${e.message}`);
    }
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
} catch (e) {
  failures.push(`run: ${e.message}`);
} finally {
  await browser?.close();
  await server?.close();
}
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
for (const f of failures) console.error(`FAIL ${f}`);
console.log(failures.length ? `${failures.length} failure(s)` : 'all thresholds met');
process.exit(failures.length ? 1 : 0);
