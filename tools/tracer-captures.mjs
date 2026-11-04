// G1's proof (npm run tracers; the shots spec's §1 and its done-table rows 1-3): bursts of 30 rounds on
// full auto from the AK on the firing step, at noon (12:00), dusk (19:30) and night (22:30), each stepped
// one frame (a sixtieth of a second) at a time with the game frozen and photographed over 8 frames mid-
// burst:
//   - near (30 m): at a man's chest 30 m out, from the hip at the three hours, and aimed at dusk (a
//     picture: aimed at 30 m the round is behind the front post);
//   - far (rounds that fly past 90 m: level, over the enemy parapet 52 m out): from the hip at the three
//     hours, aimed at dusk, and seen from the side (a witness 8 m aside, as a man along the trench sees
//     the stream; from the shooter's eye a round's path past tracer_converge_m is seen end on);
//   - graze: at the parapet's crest just in front, at night, for the rounds that glance off.
// The front's shelling is off (a crater in the step would move the shooter between captures); its
// rifle fire goes on. A burst whose shooter is not on the firing step fails.
//
//   npm run tracers [-- --only noon,far-night]
//
// Writes artifacts/sp7/tracers/<name>.png (the shot: the first of the 8 frames clear of the flash with
// the player's head drawn), <name>-marked.png (a 1 px magenta box round each head measured),
// <name>-persist.png (the per-pixel maximum of the 8 frames, as the eye holds a stream),
// <name>-persist-marked.png (what the measures below read, marked) and report.json (merged with what a
// run of a few captures left). Exits 1 if a threshold fails, a page error is seen, the hook is missing
// or a measurement is null.
//
// GPU time in the burst (its first shot to its last round's end, a new sample each frame): the
// frame's p95, and the effects' own passes' (the cost of the tracers' look, apart from the frame's).
//
// Two halves, kept apart: captureAt() fires and photographs (each frame's PNG as displayed, with the
// player's tracers as the frame drew them, from the hook window.__trenchline.tracerPixels), and the
// measures read the displayed pixels (sRGB-encoded 0-255, luminance by Rec. 709 weights):
//   - head over ring (the shot): the player's brightest drawn head within HEAD_PX of where it projects,
//     over the mean of a RING_PX annulus round it, the gun's box and anything brighter than the sky's
//     99th percentile left out. Noon: the head at display max and NOON_MIN_RATIO over its ring (a sunlit
//     ring caps any head near 2.5 in display); dusk and night: MIN_RATIO.
//   - (a) near width: the widest run across the player's tracer within NEAR_M of the muzzle (from
//     NEAR_FROM_M, clear of the flash's star), at half its height over each side's surroundings: the
//     line's own band, not the bloom's halo nor the parapet its shot's flash lights (the looser width,
//     every pixel LIT_RATIO over them, is reported beside it).
//   - (b) far colour: the mean HSV saturation of the 20 brightest pixels of the player's tracers past
//     FAR_M of flight.
//   - (c) path cover: in the persistence composite, the share of a round's path (PATH_M of flight)
//     whose pixels are lit, over those the world does not hide (a tree in front, by the G-buffer's
//     depth); aimed, over those the gun does not cover either. From the shooter's eye a path past
//     convergence projects to a point: reported, not gated.
//   - (d) noon contrast: the brightest pixel of the player's tracer at NOON_AT_M of flight over its
//     NOON_RING_PX ring.
// "Lit": LIT_RATIO times the background and LIT_MIN over it, the background the pixel's least over
// the 8 frames (a round lights a pixel of its path in 2 of them).
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
/** The window: the first frame this many frames after the first round leaves (an AK's 650 rpm is a round every 5.5 frames: some round 15 of 30) in which a round leaves, and the PERSIST_FRAMES from it. */
const SHOT_AFTER_FIRST = 80;
const PERSIST_FRAMES = 8;
/** The longest a burst is stepped before it fails, frames (30 rounds is some 166 frames, and the last round's flight after). */
const BURST_MAX_FRAMES = 500;
/** The shot's flash and its light last flash_s (0.03 s): its first two frames. The head is measured clear of them, the flash not being the head's background. */
const FLASH_FRAMES = 2;
/** The player's tracers' kind (net/gear.ts TRACER_KIND): red, in solo (the front's rounds are amber). */
const PLAYER_KIND = 2;
/** The head: its brightest pixel within this many pixels of where it projects (Chebyshev). */
const HEAD_PX = 2;
/** The background ring round it, pixels: the brief's 40 px, an annulus this wide. */
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
/** Head over ring (displayed luminance): dusk's and night's at least; noon's head at display max, and over its ring at least. */
const MIN_RATIO = 3;
const NOON_HEAD_MIN = 250;
const NOON_MIN_RATIO = 2.2;
/** The least GPU samples inside the burst, else the p95 is not trusted. */
const MIN_GPU_SAMPLES = 60;
/** A ring mean under this (0-255) is read as this, so a black ring does not divide by zero. */
const RING_FLOOR = 1;
/** A pixel lit by a tracer: this many times its background in displayed luminance, and this many steps over it (night's grain is 3). */
const LIT_RATIO = 1.5;
const LIT_MIN = 6;
/**
 * (a): the run across the tracer within NEAR_M of the muzzle, from NEAR_FROM_M: nearer, its first
 * metres lie along the flash's star on the image (its forward ray is the bore's), and a run across
 * them is the star's; from 3 m the glow's projected width is 17 px and more, so its cap is what shows.
 * Walked to WALK_PX each side; its surroundings BG_PX out.
 */
const NEAR_M = 10;
const NEAR_FROM_M = 3;
const WALK_PX = 32;
const BG_PX = [34, 48];
/** A sample's centre this many steps over the brighter side's surroundings at least, or its run is not a line's (a ribbon's fading tail; a half-height on the haze's noise). */
const NEAR_CONTRAST = 40;
/** (b): past this much of its flight; pixels within FAR_RADIUS_PX of the ribbon, FAR_HEAD_PX of a head; the brightest FAR_PIXELS. */
const FAR_M = 60;
const FAR_RADIUS_PX = 2;
const FAR_HEAD_PX = 3;
const FAR_PIXELS = 20;
/** (c): a round's path, metres of its flight; its pixels read PATH_ACROSS_PX either side; under DEGENERATE_PX on the image it is seen end on. */
const PATH_M = [20, 80];
const PATH_ACROSS_PX = 1.5;
const DEGENERATE_PX = 10;
/** Aimed, a pixel whose G-buffer depth is nearer than this is the gun (its post is half a metre out); read over CENTRE_BOX_PX round the middle. */
const GUN_DEPTH_M = 0.9;
const CENTRE_BOX_PX = 64;
/** A path sample whose G-buffer depth is under this share of the path's own distance is behind the world (a tree, the parapet): left out, as the gun is. */
const HIDDEN_SHARE = 0.97;
/** (d): the point at this much flight, its ring, ring pixels within NOON_CLEAR_PX of a drawn tracer left out, and the least ring left. */
const NOON_AT_M = 40;
const NOON_RING_PX = [16, 20];
const NOON_CLEAR_PX = 8;
const NOON_RING_MIN = 100;
/** The brief's targets (Task 5). */
const TARGET = { nearWidthPx: 12, farSaturation: 0.5, pathCover: 0.85, aimedCover: 0.6, noonContrast: 1.4 };

const deg = (r) => (r * 180) / Math.PI;
const BURSTS = {
  // A man's chest 30 m out, 0.4 m under the eye.
  near: { pitch: deg(Math.atan2(-0.4, 30)), what: 'a man 30 m out' },
  // Rounds that fly long, past 90 m. The brief's point 90 m out at about a degree under the level is
  // behind the enemy line: from the step its parapet stands some 52 m out across the whole view, and a
  // degree down a round strikes it. Level, the burst's climb (some 1.7 degrees by its middle) carries
  // the rounds of the window over it, out past 100 m.
  far: { pitch: 0, what: 'level, over the enemy parapet 52 m out' },
  // The parapet's crest just in front, struck at a few degrees (tracers.spec's graze).
  graze: { pitch: -6, what: "the parapet's crest" },
};
/** The witness's place beside the shooter (m): aside along the trench to the left, up, back; looking at the round's path this far out. */
const WITNESS = { aside: 8, up: 1.5, back: 2, lookAtM: 50 };
const CAPTURES = [
  { name: 'noon', hours: 12, burst: 'near' },
  { name: 'dusk', hours: 19.5, burst: 'near' },
  { name: 'night', hours: 22.5, burst: 'near' },
  { name: 'dusk-aimed', hours: 19.5, burst: 'near', aimed: true },
  { name: 'far-noon', hours: 12, burst: 'far' },
  { name: 'far-dusk', hours: 19.5, burst: 'far' },
  { name: 'far-night', hours: 22.5, burst: 'far' },
  { name: 'far-dusk-aimed', hours: 19.5, burst: 'far', aimed: true },
  { name: 'side-noon', hours: 12, burst: 'far', side: true },
  { name: 'side-dusk', hours: 19.5, burst: 'far', side: true },
  { name: 'side-night', hours: 22.5, burst: 'far', side: true },
  { name: 'graze-night', hours: 22.5, burst: 'graze' },
];

// ---- geometry (camera.ts's projectToPixel, here) -------------------------------------------------

const RAD = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };

function basis(pose) {
  const y = pose.yaw * RAD;
  const p = pose.pitch * RAD;
  const forward = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const up = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]];
  const roll = (pose.roll ?? 0) * RAD;
  if (roll === 0) return { forward, right, up };
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return { forward, right: [0, 1, 2].map((k) => right[k] * c + up[k] * s), up: [0, 1, 2].map((k) => up[k] * c - right[k] * s) };
}

/** Where a point (m) lands on a `res` image (CSS pixels, continuous), or null behind the camera. */
function project(pose, res, p) {
  const { forward, right, up } = basis(pose);
  const d = sub(p, pose.position);
  const depth = dot(d, forward);
  if (depth <= 0) return null;
  const t = pose.fov === undefined || pose.fov === 90 ? 1 : Math.tan((pose.fov * RAD) / 2);
  const x = dot(d, right) / (depth * t);
  const y = (dot(d, up) / (depth * t)) * (res[0] / res[1]);
  return [((x + 1) * res[0]) / 2, ((1 - y) * res[1]) / 2];
}

// ---- capture -----------------------------------------------------------------------------------

const withTimeout = (promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out (${FRAME_TIMEOUT_MS} ms): ${what}`)), FRAME_TIMEOUT_MS))]);

const HIDE_HUD_MARK = '#hud .crosshair, #hud .reticle { visibility: hidden !important; }';

/** Fire the burst for `c` and photograph its window: each frame's PNG as displayed, the player's tracers as drawn, and the burst's own numbers. */
async function captureAt(page, c) {
  const b = BURSTS[c.burst];
  const shooter = await withTimeout(
    page.evaluate(
      async ({ hours, aimed, settle, pitch, side, witness }) => {
        const h = window.__trenchline;
        h.thaw();
        h.trigger(false);
        h.spectate(null);
        h.aim(false);
        h.setTimeOfDay(hours);
        h.setLoadout({ primary: 'assault_rifle', secondary: 'm17', fits: {} });
        const v = h.views.step;
        const stand = (p) => h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: p });
        stand(pitch);
        h.aim(aimed);
        if (side) {
          // A witness along the trench to the shooter's left, a little up and back, looking at the path.
          const R = Math.PI / 180;
          const f = [Math.sin(v.yaw * R) * Math.cos(pitch * R), Math.sin(pitch * R), Math.cos(v.yaw * R) * Math.cos(pitch * R)];
          const level = [Math.sin(v.yaw * R), 0, Math.cos(v.yaw * R)];
          const right = [Math.cos(v.yaw * R), 0, -Math.sin(v.yaw * R)];
          const at = [0, 1, 2].map((k) => v.position[k] - right[k] * witness.aside - level[k] * witness.back + (k === 1 ? witness.up : 0));
          const look = [0, 1, 2].map((k) => v.position[k] + f[k] * witness.lookAtM - at[k]);
          h.spectate({ position: at, yaw: (Math.atan2(look[0], look[2]) * 180) / Math.PI, pitch: (Math.atan2(look[1], Math.hypot(look[0], look[2])) * 180) / Math.PI });
        }
        await h.waitFrames(settle);
        return h.player();
      },
      { hours: c.hours, aimed: !!c.aimed, settle: SETTLE_FRAMES, pitch: b.pitch, side: !!c.side, witness: WITNESS },
    ),
    `${c.name}: setting up`,
  );
  if (!shooter.onFiringStep) throw new Error(`${c.name}: the shooter is not on the firing step: ${JSON.stringify(shooter)}`);
  const step = () =>
    withTimeout(
      page.evaluate(async (kind) => {
        const h = window.__trenchline;
        await h.stepFrames(1);
        const s = h.stats();
        const t = h.tracerPixels();
        const own = t.tracers.filter((x) => x.kind === kind);
        const fx = h.effects();
        // The effects' own passes (the billboards' light and the draw), the latest measured frame's: what the tracers' look costs.
        const fxMs = (s.ownLast?.['effects-light'] ?? 0) + (s.ownLast?.effects ?? 0);
        return { frame: h.frames(), gpu: s.gpuLastMs, gpuSamples: s.gpuSamples, fxMs, rounds: t.weapon.rounds, live: own.length, heads: own.filter((x) => x.headDrawn).length, ricochets: fx.ricochets, embers: fx.embers };
      }, PLAYER_KIND),
      `${c.name}: a frame`,
    );
  /** The frame just stepped, read whole: the tracers drawn, the drawn muzzle, the internal image's size; aimed, the G-buffer's depth round the middle. */
  const readFrame = () =>
    withTimeout(
      page.evaluate(
        async ({ aimed, half }) => {
          const h = window.__trenchline;
          const info = h.tracerPixels();
          const internal = h.stats().res;
          const fx = h.effects();
          let depth = null;
          if (aimed) {
            const k = internal[0] / info.res[0];
            const cx = Math.floor(internal[0] / 2);
            const cy = Math.floor(internal[1] / 2);
            const r = Math.ceil(half * k);
            const points = [];
            for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) points.push([x, y]);
            depth = { x0: cx - r, y0: cy - r, n: 2 * r + 1, scale: k, metres: await h.depthAt(points) };
          }
          return { info, internal, muzzle: h.rifleMuzzle(), exposure: await h.exposure(), fx: { ricochets: fx.ricochets, embers: fx.embers, heads: fx.heads, battleTracers: fx.battleTracers }, depth };
        },
        { aimed: !!c.aimed, half: CENTRE_BOX_PX },
      ),
      `${c.name}: reading a frame`,
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
  const effectsGpu = [];
  let lastSamples = -1;
  let firstShotAt = null;
  let lastShotAt = null;
  let windowAt = null;
  let retired = null;
  let rounds = first.rounds;
  const most = { ricochets: 0, embers: 0 };
  const frames = [];
  let hidden = null;
  let pathDepth = null;
  try {
    for (let k = 1; k <= BURST_MAX_FRAMES; k++) {
      const s = await step();
      const fired = s.rounds < rounds;
      if (firstShotAt === null && fired) firstShotAt = k;
      if (fired) lastShotAt = k;
      rounds = s.rounds;
      most.ricochets = Math.max(most.ricochets, s.ricochets);
      most.embers = Math.max(most.embers, s.embers);
      // Samples inside the burst only: from the first shot to the last round's retirement; a new sample, never a repeat.
      if (firstShotAt !== null && retired === null && s.gpu != null && s.gpuSamples !== lastSamples) { gpu.push(s.gpu); effectsGpu.push(s.fxMs); }
      lastSamples = s.gpuSamples;
      if (windowAt === null && firstShotAt !== null && k >= firstShotAt + SHOT_AFTER_FIRST && fired) {
        windowAt = k;
        // The HUD's crosshair and reticle are white at the middle, where the rounds go: out of the measured pictures.
        hidden = await page.addStyleTag({ content: HIDE_HUD_MARK });
      }
      if (windowAt !== null && frames.length < PERSIST_FRAMES) {
        const read = await readFrame();
        if (read.info.frame !== s.frame && read.info.frame !== s.frame + 1) throw new Error(`${c.name}: the tracers read are of frame ${read.info.frame}, the step ${s.frame}`);
        const png = await withTimeout(page.screenshot(), `${c.name}: a screenshot`);
        frames.push({ k, png, roundsLeft: s.rounds, ...read });
        if (frames.length === PERSIST_FRAMES) {
          await hidden.evaluate((n) => n.remove());
          hidden = null;
          // The world's depth along the followed round's path, while the camera is where the window saw it from.
          const samples = pathSamples(frames, trackRound(frames));
          if (samples) {
            const scale = read.internal[0] / read.info.res[0];
            const points = samples.points.map((q) => [Math.floor(q[0] * scale), Math.floor(q[1] * scale)]);
            pathDepth = await withTimeout(page.evaluate((p) => window.__trenchline.depthAt(p), points), `${c.name}: the depth along the path`);
          }
        }
      }
      if (s.rounds === 0 && s.live === 0) { retired = k; break; }
    }
  } finally {
    if (hidden) await hidden.evaluate((n) => n.remove()).catch(() => {});
    await page.evaluate(() => { const h = window.__trenchline; h.trigger(false); h.spectate(null); });
  }
  if (firstShotAt === null || frames.length < PERSIST_FRAMES || retired === null) throw new Error(`${c.name}: the burst did not run: first shot ${firstShotAt}, ${frames.length} frames photographed, retired ${retired}`);
  return {
    frames,
    pathDepth,
    burst: { at: b.what, pitchDeg: Math.round(b.pitch * 1000) / 1000, firstShotFrame: firstShotAt, lastShotFrame: lastShotAt, framesFor30Rounds: lastShotAt - firstShotAt + 1, window: [windowAt, windowAt + PERSIST_FRAMES - 1], retiredFrame: retired, frameBase: first.frame },
    gpu,
    effectsGpu,
    most,
  };
}

// ---- measure -----------------------------------------------------------------------------------

/** A decoded PNG: its RGBA, its displayed luminance (Rec. 709 weights on the sRGB-encoded 0-255 values), its size. */
function decode(buffer) {
  const png = PNG.sync.read(buffer);
  const lum = new Float32Array(png.width * png.height);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
  return { data: png.data, lum, w: png.width, h: png.height };
}

/** The per-pixel maximum of the frames (each channel), its luminance, and each pixel's least luminance over them (its background). */
function composite(imgs) {
  const { w, h } = imgs[0];
  const data = Buffer.from(imgs[0].data);
  const least = Float32Array.from(imgs[0].lum);
  for (const img of imgs.slice(1)) {
    for (let i = 0; i < data.length; i++) if (img.data[i] > data[i]) data[i] = img.data[i];
    for (let i = 0; i < least.length; i++) if (img.lum[i] < least[i]) least[i] = img.lum[i];
  }
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  return { data, lum, least, w, h };
}

const encode = (data, w, h) => { const png = new PNG({ width: w, height: h }); data.copy(png.data); return PNG.sync.write(png); };
const at = (img, q) => { const x = Math.floor(q[0]); const y = Math.floor(q[1]); return x < 0 || y < 0 || x >= img.w || y >= img.h ? -1 : y * img.w + x; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const lit = (v, bg) => v >= Math.max(LIT_RATIO * bg, bg + LIT_MIN);
const own = (f) => f.info.tracers.filter((t) => t.kind === PLAYER_KIND && t.headM && t.tailM);
/** A drawn tracer's flight at its tail: its head's, less its length (exact past convergence). */
const tailFlown = (t) => t.flown - dist(t.headM, t.tailM);

/** The sky's 99th percentile and the gun's mask box (null when it is the whole view) of an image, for a ring. */
function ringContext(img, info) {
  const skyN = Math.floor(img.w * img.h * SKY_ROWS);
  const sky = Array.from(img.lum.subarray(0, skyN)).sort((a, b) => a - b);
  const skyP99 = sky[Math.min(skyN - 1, Math.floor(skyN * SKY_PERCENTILE))];
  const boxed = info.gun ? [info.gun[0] - GUN_PAD_PX, info.gun[1] - GUN_PAD_PX, info.gun[0] + info.gun[2] + GUN_PAD_PX, info.gun[1] + info.gun[3] + GUN_PAD_PX] : null;
  const gun = boxed && (boxed[2] - boxed[0]) * (boxed[3] - boxed[1]) <= GUN_BOX_MAX_SHARE * img.w * img.h ? boxed : null;
  return { skyP99, gun, inGun: (x, y) => gun !== null && x >= gun[0] && x < gun[2] && y >= gun[1] && y < gun[3] };
}

/** The mean of an annulus `radii` round (cx, cy), but where `drop(x, y, lum)` says. */
function ringMean(img, cx, cy, radii, drop) {
  let sum = 0;
  let n = 0;
  let dropped = 0;
  for (let y = Math.max(0, cy - radii[1]); y <= Math.min(img.h - 1, cy + radii[1]); y++) {
    for (let x = Math.max(0, cx - radii[1]); x <= Math.min(img.w - 1, cx + radii[1]); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < radii[0] || d > radii[1]) continue;
      if (drop(x, y, img.lum[y * img.w + x])) { dropped++; continue; }
      sum += img.lum[y * img.w + x];
      n++;
    }
  }
  return { mean: n > 0 ? sum / n : null, n, dropped };
}

/** The brightest pixel within `r` (Chebyshev) of (cx, cy). */
function brightest(img, cx, cy, r) {
  let best = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(img.h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(img.w - 1, cx + r); x++) best = Math.max(best, img.lum[y * img.w + x]);
  return best;
}

/**
 * Head over ring for each of the player's drawn heads in a frame (or, `anyKind`, every session tracer's:
 * the front's amber rounds too), and the headline (the head brightest in display).
 */
function headRing(img, info, anyKind = false) {
  if (img.w !== info.res[0] || img.h !== info.res[1]) throw new Error(`the screenshot is ${img.w}x${img.h}, the canvas ${info.res.join('x')}`);
  const { skyP99, gun, inGun } = ringContext(img, info);
  const heads = [];
  const skipped = [];
  const mine = info.tracers.filter((t) => anyKind || t.kind === PLAYER_KIND);
  for (const t of mine) {
    if (!t.headDrawn || !t.head) continue;
    const [px, py] = t.head;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    if (cx < 0 || cy < 0 || cx >= img.w || cy >= img.h) { skipped.push({ at: t.head, why: 'off the image' }); continue; }
    if (inGun(cx, cy)) { skipped.push({ at: t.head, why: 'inside the gun box', gun }); continue; }
    const head = brightest(img, cx, cy, HEAD_PX);
    const ring = ringMean(img, cx, cy, RING_PX, (x, y, v) => inGun(x, y) || v > skyP99);
    heads.push({ at: [Math.round(px * 10) / 10, Math.round(py * 10) / 10], kind: t.kind, flownM: Math.round(t.flown * 10) / 10, headLum: head, ringMean: ring.mean, ringPixels: ring.n, ringDropped: ring.dropped, ratio: ring.mean === null ? null : head / Math.max(ring.mean, RING_FLOOR) });
  }
  const valid = heads.filter((x) => x.ringPixels >= RING_MIN_PIXELS).sort((a, b) => b.headLum - a.headLum);
  return { skyP99, tracersProjected: mine.length, headsDrawn: mine.filter((t) => t.headDrawn).length, headsMeasured: heads.length, headsValid: valid.length, gunMasked: gun !== null, skipped, headline: valid[0] ?? null, heads };
}

/** (a): the widest run across the player's tracers, at half its height, within NEAR_M of the drawn muzzle (from NEAR_FROM_M), over the window's frames. */
function nearWidth(imgs, frames) {
  let best = null;
  let samples = 0;
  frames.forEach((f, i) => {
    const img = imgs[i];
    const { pose, res } = f.info;
    const muzzle = f.muzzle ?? pose.position;
    for (const t of own(f)) {
      const N = 400;
      for (let j = 0; j <= N; j++) {
        const u = j / N;
        const m = dist(lerp(t.tailM, t.headM, u), muzzle);
        if (m < NEAR_FROM_M || m > NEAR_M) continue;
        const q = project(pose, res, lerp(t.tailM, t.headM, u));
        const a = project(pose, res, lerp(t.tailM, t.headM, Math.max(0, u - 1e-3)));
        const b = project(pose, res, lerp(t.tailM, t.headM, Math.min(1, u + 1e-3)));
        if (!q || !a || !b || at(img, q) < 0) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!(len > 0)) continue;
        const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        const off = (o) => at(img, [q[0] + n[0] * o, q[1] + n[1] * o]);
        // Each side's own surroundings: a tracer along the horizon has the parapet under it and the haze over it.
        const side = (sign) => { const v = []; for (let o = BG_PX[0]; o <= BG_PX[1]; o++) { const k = off(sign * o); if (k >= 0) v.push(img.lum[k]); } return median(v); };
        const bgs = [side(-1), side(1)];
        if (bgs[0] === null || bgs[1] === null) continue;
        const centre = img.lum[at(img, q)];
        if (!(centre >= Math.max(bgs[0], bgs[1]) + NEAR_CONTRAST)) continue;
        samples++;
        // The first step either side short of `within(v, bg)`, less half a step: the run's extent that way.
        const reach = (sign, bg, within) => { for (let o = 0.5; o <= WALK_PX; o += 0.5) { const k = off(sign * o); if (k < 0 || !within(img.lum[k], bg)) return o - 0.25; } return WALK_PX; };
        // Its width at half its height over each side's surroundings (the line's own band: not the bloom's
        // halo round it, nor the parapet its shot's flash lights); and, as loosely as (c)'s, all of it lit.
        const half = (v, bg) => v - bg >= 0.5 * (centre - bg);
        const width = reach(-1, bgs[0], half) + reach(1, bgs[1], half);
        const loose = reach(-1, bgs[0], lit) + reach(1, bgs[1], lit);
        if (!best || width > best.px) best = { px: width, litPx: loose, frame: i, at: [Math.round(q[0]), Math.round(q[1])], normal: n, fromMuzzleM: Math.round(m * 10) / 10, background: bgs.map(Math.round), centre: Math.round(centre), flownM: Math.round(t.flown * 10) / 10 };
      }
    }
  });
  return { ...(best ?? { px: null }), samples };
}

/** (b): the mean HSV saturation (and luminance) of the brightest FAR_PIXELS pixels of the player's tracers past FAR_M of flight, over the window's frames. */
function farColour(imgs, frames) {
  const pixels = [];
  frames.forEach((f, i) => {
    const img = imgs[i];
    const { pose, res } = f.info;
    const taken = new Set();
    const take = (q, r) => {
      for (let y = Math.floor(q[1] - r); y <= Math.floor(q[1] + r); y++) {
        for (let x = Math.floor(q[0] - r); x <= Math.floor(q[0] + r); x++) {
          if (x < 0 || y < 0 || x >= img.w || y >= img.h || Math.hypot(x + 0.5 - q[0], y + 0.5 - q[1]) > r) continue;
          const k = y * img.w + x;
          if (taken.has(k)) continue;
          taken.add(k);
          const [R, G, B] = [img.data[k * 4], img.data[k * 4 + 1], img.data[k * 4 + 2]];
          const top = Math.max(R, G, B);
          pixels.push({ frame: i, x, y, lum: img.lum[k], saturation: top > 0 ? (top - Math.min(R, G, B)) / top : 0, rgb: [R, G, B] });
        }
      }
    };
    for (const t of own(f)) {
      if (t.flown < FAR_M) continue;
      const tail = tailFlown(t);
      const u0 = Math.max(0, Math.min(1, (FAR_M - tail) / Math.max(1e-6, t.flown - tail)));
      const N = 200;
      for (let j = 0; j <= N; j++) {
        const q = project(pose, res, lerp(t.tailM, t.headM, u0 + ((1 - u0) * j) / N));
        if (q) take(q, FAR_RADIUS_PX);
      }
      const h = t.headDrawn ? project(pose, res, t.headM) : null;
      if (h) take(h, FAR_HEAD_PX);
    }
  });
  pixels.sort((a, b) => b.lum - a.lum);
  const top = pixels.slice(0, FAR_PIXELS);
  if (top.length < FAR_PIXELS) return { saturation: null, candidates: pixels.length, pixels: top };
  const mean = (key) => top.reduce((a, p) => a + p[key], 0) / top.length;
  return { saturation: mean('saturation'), lum: mean('lum'), candidates: pixels.length, pixels: top.map((p) => ({ frame: p.frame, at: [p.x, p.y], rgb: p.rgb })) };
}

/** The round that left in the window's first frame, frame to frame by its flight (some 14.7 m a frame): its path, a line from where it left, fitted to its heads past convergence. */
function trackRound(frames) {
  const start = own(frames[0]);
  if (start.length === 0) return null;
  let cur = start.reduce((a, b) => (b.flown < a.flown ? b : a));
  const seen = [{ frame: 0, t: cur }];
  for (let i = 1; i < frames.length; i++) {
    const next = own(frames[i]).filter((t) => t.flown > cur.flown + 5 && t.flown < cur.flown + 25);
    if (next.length === 0) break;
    cur = next.reduce((a, b) => (Math.abs(b.flown - cur.flown - 14.5) < Math.abs(a.flown - cur.flown - 14.5) ? b : a));
    seen.push({ frame: i, t: cur });
  }
  const past = seen.filter((s) => tailFlown(s.t) >= PATH_M[0] - 0.5);
  const fit = past.length >= 2 ? [past[0].t.headM, past[past.length - 1].t.headM, past[0].t.flown, past[past.length - 1].t.flown] : past.length === 1 ? [past[0].t.tailM, past[0].t.headM, tailFlown(past[0].t), past[0].t.flown] : null;
  if (!fit) return { seen, path: null };
  const d = unit(sub(fit[1], fit[0]));
  const origin = [0, 1, 2].map((k) => fit[0][k] - d[k] * fit[2]);
  return { seen, path: { origin, dir: d, lastFlownM: seen[seen.length - 1].t.flown, point: (s) => [0, 1, 2].map((k) => origin[k] + d[k] * s) } };
}

/** The G-buffer's depth (m) at a CSS pixel, from a frame's box round the middle; null outside it. */
function depthAt(f, q) {
  const d = f.depth;
  if (!d) return null;
  const x = Math.floor(q[0] * d.scale) - d.x0;
  const y = Math.floor(q[1] * d.scale) - d.y0;
  return x < 0 || y < 0 || x >= d.n || y >= d.n ? null : d.metres[y * d.n + x];
}

/**
 * The followed round's path (PATH_M of flight) on the image by the window's middle frame's camera,
 * sampled a pixel apart: each sample's point and how far its point of the path is from the camera.
 */
function pathSamples(frames, track) {
  if (!track?.path) return null;
  const mid = frames[Math.floor(frames.length / 2)].info;
  const end = Math.min(PATH_M[1], track.path.lastFlownM);
  const P0 = track.path.point(PATH_M[0]);
  const P1 = track.path.point(end);
  const A = project(mid.pose, mid.res, P0);
  const B = project(mid.pose, mid.res, P1);
  if (!A || !B) return null;
  const lengthPx = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const n = lengthPx > 0 ? [-(B[1] - A[1]) / lengthPx, (B[0] - A[0]) / lengthPx] : [0, 1];
  const N = Math.max(1, Math.ceil(lengthPx));
  const points = [];
  const metres = [];
  for (let j = 0; j <= N; j++) {
    const q = [A[0] + ((B[0] - A[0]) * j) / N, A[1] + ((B[1] - A[1]) * j) / N];
    if (q[0] < 0 || q[1] < 0 || q[0] >= mid.res[0] || q[1] >= mid.res[1]) continue;
    // The path's point on this sample's ray: a line's projection is a line, its points found by their share of it in depth.
    const { forward } = basis(mid.pose);
    const d0 = dot(sub(P0, mid.pose.position), forward);
    const d1 = dot(sub(P1, mid.pose.position), forward);
    const u = j / N;
    const w = (u * d0) / ((1 - u) * d1 + u * d0);
    points.push(q);
    metres.push(dist(lerp(P0, P1, Number.isFinite(w) ? w : u), mid.pose.position));
  }
  return { points, metres, n, lengthPx, end };
}

/** (c): the share of the round's path (PATH_M of flight) lit in the composite, sampled a pixel apart on the image (by the window's middle frame's camera), over the samples the world does not hide (by `pathDepth`, the G-buffer's depth along them) and, aimed, the gun covers in no frame. */
function pathCover(comp, frames, track, aimed, pathDepth) {
  if (!track?.path) return { share: null, why: 'no round followed past convergence' };
  const ps = pathSamples(frames, track);
  if (!ps) return { share: null, why: 'the path is behind the camera or off the image' };
  const { n, lengthPx, end } = ps;
  const samples = [];
  for (let j = 0; j < ps.points.length; j++) {
    const q = ps.points[j];
    if (at(comp, q) < 0) continue;
    const gun = aimed ? frames.some((f) => { const m = depthAt(f, q); return m !== null && m < GUN_DEPTH_M; }) : false;
    const hidden = !gun && pathDepth && pathDepth.length === ps.points.length ? pathDepth[j] < HIDDEN_SHARE * ps.metres[j] : false;
    let best = 0;
    const bgs = [];
    for (let o = -PATH_ACROSS_PX; o <= PATH_ACROSS_PX + 1e-9; o += 0.5) {
      const k = at(comp, [q[0] + n[0] * o, q[1] + n[1] * o]);
      if (k < 0) continue;
      best = Math.max(best, comp.lum[k]);
      bgs.push(comp.least[k]);
    }
    const bg = median(bgs);
    samples.push({ at: q, gun, hidden, covered: bg !== null && lit(best, bg), lum: best, bg });
  }
  const counted = samples.filter((s) => !s.gun && !s.hidden);
  const share = counted.length ? counted.filter((s) => s.covered).length / counted.length : null;
  const behindGun = samples.filter((s) => s.gun).length;
  return { share, spanM: [PATH_M[0], Math.round(end * 10) / 10], lengthPx: Math.round(lengthPx * 10) / 10, endOn: lengthPx < DEGENERATE_PX, samples: samples.length, behindGun, hiddenByWorld: samples.filter((s) => s.hidden).length, depthRead: !!pathDepth, counted: counted.length, why: counted.length ? undefined : behindGun ? 'every sample is behind the gun' : 'every sample is hidden', marks: samples };
}

/** (d): the round's brightest pixel at NOON_AT_M of flight over its ring, in the frame whose head is nearest past that point. */
function noonContrast(imgs, frames, track) {
  if (!track?.path) return { ratio: null, why: 'no round followed past convergence' };
  const over = track.seen.filter((s) => tailFlown(s.t) <= NOON_AT_M && s.t.flown >= NOON_AT_M).sort((a, b) => a.t.flown - b.t.flown)[0];
  if (!over) return { ratio: null, why: `no frame drew the round across ${NOON_AT_M} m` };
  const f = frames[over.frame];
  const img = imgs[over.frame];
  const u = (NOON_AT_M - tailFlown(over.t)) / Math.max(1e-6, over.t.flown - tailFlown(over.t));
  const q = project(f.info.pose, f.info.res, lerp(over.t.tailM, over.t.headM, u));
  if (!q || at(img, q) < 0) return { ratio: null, why: 'the point is off the image' };
  const cx = Math.floor(q[0]);
  const cy = Math.floor(q[1]);
  const { skyP99, inGun } = ringContext(img, f.info);
  // Clear of every drawn tracer of the player's (its glow and bloom), the gun, and the sky's brightest.
  const segments = own(f).map((t) => [project(f.info.pose, f.info.res, t.tailM), project(f.info.pose, f.info.res, t.headM)]).filter(([a, b]) => a && b);
  const near = (x, y) => segments.some(([a, b]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const s = l2 > 0 ? Math.max(0, Math.min(1, ((x + 0.5 - a[0]) * dx + (y + 0.5 - a[1]) * dy) / l2)) : 0;
    return Math.hypot(x + 0.5 - a[0] - dx * s, y + 0.5 - a[1] - dy * s) < NOON_CLEAR_PX;
  });
  const head = brightest(img, cx, cy, HEAD_PX);
  const ring = ringMean(img, cx, cy, NOON_RING_PX, (x, y, v) => inGun(x, y) || v > skyP99 || near(x, y));
  const ratio = ring.mean === null || ring.n < NOON_RING_MIN ? null : head / Math.max(ring.mean, RING_FLOOR);
  return { ratio, frame: over.frame, headFlownM: Math.round(over.t.flown * 10) / 10, at: [cx, cy], head, ringMean: ring.mean, ringPixels: ring.n, why: ratio === null ? `a ring of ${ring.n} pixels` : undefined };
}

/** A copy of the PNG with a 1 px magenta box round each measured head (the headline's larger). */
function marked(img, m) {
  const data = Buffer.from(img.data);
  const put = (x, y, c = [255, 0, 255]) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    const i = (y * img.w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  };
  for (const hd of m.heads) {
    const r = hd === m.headline ? 14 : 8;
    const cx = Math.floor(hd.at[0]);
    const cy = Math.floor(hd.at[1]);
    for (let d = -r; d <= r; d++) { put(cx + d, cy - r); put(cx + d, cy + r); put(cx - r, cy + d); put(cx + r, cy + d); }
  }
  return encode(data, img.w, img.h);
}

/** The composite marked: (c)'s path a few pixels aside (green lit, red not, grey behind the gun), (a)'s run (cyan), (b)'s pixels (yellow), (d)'s point and ring (magenta). */
function markedComposite(comp, m) {
  const data = Buffer.from(comp.data);
  const put = (x, y, c) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= comp.w || y >= comp.h) return;
    const i = (y * comp.w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  };
  if (m.pathCover?.marks) for (const s of m.pathCover.marks) for (const o of [5, 6]) put(s.at[0], s.at[1] + o, s.gun || s.hidden ? [128, 128, 128] : s.covered ? [0, 255, 0] : [255, 0, 0]);
  const a = m.nearWidth;
  if (a?.px != null) for (let o = -a.px / 2; o <= a.px / 2; o += 0.5) put(a.at[0] + a.normal[0] * o, a.at[1] + a.normal[1] * o, [0, 255, 255]);
  if (m.farColour?.pixels) for (const p of m.farColour.pixels) { put(p.at[0] - 2, p.at[1], [255, 255, 0]); put(p.at[0] + 2, p.at[1], [255, 255, 0]); }
  const d = m.noonContrast;
  if (d?.at) {
    for (let t = 0; t < 360; t += 2) for (const r of NOON_RING_PX) put(d.at[0] + r * Math.cos(t * RAD), d.at[1] + r * Math.sin(t * RAD), [255, 0, 255]);
  }
  return encode(data, comp.w, comp.h);
}

const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.95)] : null; };
const round3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/** Every measure of a capture, and the failures its thresholds find. */
function measureCapture(c, cap) {
  const imgs = cap.frames.map((f) => decode(f.png));
  const comp = composite(imgs);
  // The shot: the first frame of the window clear of the flash with the player's head drawn (else the first with it).
  const headed = (f, i) => i >= FLASH_FRAMES && own(f).some((t) => t.headDrawn);
  const clear = cap.frames.findIndex(headed);
  const shotIndex = clear >= 0 ? clear : cap.frames.findIndex((f) => own(f).some((t) => t.headDrawn));
  const shot = shotIndex >= 0 ? shotIndex : 0;
  const hr = headRing(imgs[shot], cap.frames[shot].info);
  // For comparison with the first proof (Task 4's headline was any session tracer's head): the best of every kind's.
  const every = headRing(imgs[shot], cap.frames[shot].info, true).heads.filter((x) => x.ringPixels >= RING_MIN_PIXELS && x.ratio !== null).sort((a, b) => b.ratio - a.ratio)[0] ?? null;
  const track = trackRound(cap.frames);
  const hip = !c.aimed && !c.side;
  const m = {
    shotFrame: cap.frames[shot].k,
    ...hr,
    bestOfAnyKind: every,
    nearWidth: hip && c.burst !== 'graze' ? nearWidth(imgs, cap.frames) : null,
    farColour: c.burst === 'far' && c.hours !== 12 && !c.aimed ? farColour(imgs, cap.frames) : null,
    pathCover: c.burst === 'far' ? pathCover(comp, cap.frames, track, !!c.aimed, cap.pathDepth) : null,
    noonContrast: c.burst === 'far' && c.hours === 12 ? noonContrast(imgs, cap.frames, track) : null,
    followed: track ? track.seen.map((s) => Math.round(s.t.flown * 10) / 10) : null,
    window: cap.frames.map((f) => ({ k: f.k, exposure: round3(f.exposure), embers: f.fx.embers, ricochets: f.fx.ricochets, battleTracers: f.fx.battleTracers })),
  };
  const failures = [];
  const hl = m.headline;
  if (c.burst === 'near' && !c.aimed) {
    if (m.headsDrawn < 1) failures.push('no tracer head of the player drawn at the shot frame');
    else if (!hl) failures.push(`no head measured with a ring of ${RING_MIN_PIXELS}+ pixels (${m.headsMeasured} measured)`);
    else {
      if (c.hours === 12 && !(hl.headLum >= NOON_HEAD_MIN && hl.ratio >= NOON_MIN_RATIO)) failures.push(`noon: head ${hl.headLum.toFixed(1)} (>= ${NOON_HEAD_MIN}) over ring ${hl.ratio.toFixed(2)} (>= ${NOON_MIN_RATIO})`);
      if (c.hours !== 12 && !(hl.ratio >= MIN_RATIO)) failures.push(`head over ring ${hl.ratio.toFixed(2)} < ${MIN_RATIO}`);
    }
  }
  if (m.nearWidth && !(m.nearWidth.px <= TARGET.nearWidthPx)) failures.push(`(a) near width ${m.nearWidth.px} px > ${TARGET.nearWidthPx}`);
  if (m.farColour && !(m.farColour.saturation >= TARGET.farSaturation)) failures.push(`(b) far saturation ${round3(m.farColour.saturation)} < ${TARGET.farSaturation}`);
  if (m.pathCover && c.side && !(m.pathCover.share >= TARGET.pathCover)) failures.push(`(c) path cover ${round3(m.pathCover.share)} < ${TARGET.pathCover}${m.pathCover.why ? ` (${m.pathCover.why})` : ''}`);
  if (m.pathCover && c.aimed && !(m.pathCover.share >= TARGET.aimedCover)) failures.push(`aimed: path cover beside the gun ${round3(m.pathCover.share)} < ${TARGET.aimedCover}${m.pathCover.why ? ` (${m.pathCover.why})` : ''}`);
  if (m.noonContrast && !(m.noonContrast.ratio >= TARGET.noonContrast)) failures.push(`(d) noon contrast ${round3(m.noonContrast.ratio)} < ${TARGET.noonContrast}${m.noonContrast.why ? ` (${m.noonContrast.why})` : ''}`);
  if (c.burst === 'graze' && !(cap.most.ricochets > 0)) failures.push(`graze: no ricochet drawn in the burst (embers ${cap.most.embers})`);
  if (cap.gpu.length < MIN_GPU_SAMPLES) failures.push(`${cap.gpu.length} GPU samples in the burst < ${MIN_GPU_SAMPLES}`);
  return { m, failures, imgs, comp, shot };
}

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
    // No shells: a crater in the step would move the shooter between captures (the front's rifle fire goes on).
    h.setShelling('off');
  });
  for (const c of chosen) {
    try {
      const cap = await captureAt(page, c);
      const { m, failures: found, imgs, comp, shot } = measureCapture(c, cap);
      writeFileSync(`${OUT}/${c.name}.png`, cap.frames[shot].png);
      writeFileSync(`${OUT}/${c.name}-marked.png`, marked(imgs[shot], m));
      writeFileSync(`${OUT}/${c.name}-persist.png`, encode(comp.data, comp.w, comp.h));
      writeFileSync(`${OUT}/${c.name}-persist-marked.png`, markedComposite(comp, m));
      const gpuP95 = p95(cap.gpu);
      const effectsP95 = p95(cap.effectsGpu);
      const effectsMean = cap.effectsGpu.length ? cap.effectsGpu.reduce((a, b) => a + b, 0) / cap.effectsGpu.length : null;
      const { marks, ...cover } = m.pathCover ?? {};
      report[c.name] = {
        hours: c.hours, burst: c.burst, aimed: !!c.aimed, side: !!c.side, weapon: cap.frames[shot].info.weapon, burstFrames: cap.burst, gpuSamples: cap.gpu.length, gpuP95, effectsGpu: { p95: effectsP95, mean: effectsMean },
        most: cap.most, failures: found,
        thresholds: { minRatio: MIN_RATIO, noon: { headMin: NOON_HEAD_MIN, minRatio: NOON_MIN_RATIO }, minGpuSamples: MIN_GPU_SAMPLES, ringMinPixels: RING_MIN_PIXELS, lit: { ratio: LIT_RATIO, min: LIT_MIN }, targets: TARGET },
        ...m,
        pathCover: m.pathCover ? cover : null,
      };
      const hl = m.headline;
      const bits = [
        hl ? `head ${hl.headLum.toFixed(1)} / ring ${hl.ringMean.toFixed(1)} = ${hl.ratio.toFixed(2)}` : `no head (${m.headsDrawn} drawn)`,
        m.nearWidth ? `(a) ${m.nearWidth.px} px (lit ${m.nearWidth.litPx})` : null,
        m.farColour ? `(b) sat ${round3(m.farColour.saturation)} lum ${m.farColour.lum?.toFixed(0)}` : null,
        m.pathCover ? `(c) ${round3(m.pathCover.share)} over ${m.pathCover.lengthPx} px${m.pathCover.endOn ? ' (end on)' : ''}${m.pathCover.behindGun ? `, ${m.pathCover.behindGun} behind the gun` : ''}${m.pathCover.hiddenByWorld ? `, ${m.pathCover.hiddenByWorld} hidden` : ''}` : null,
        m.noonContrast ? `(d) ${round3(m.noonContrast.ratio)}` : null,
        `ricochets ${cap.most.ricochets} embers ${cap.most.embers}`,
        `gpu p95 ${gpuP95 === null ? 'n/a' : gpuP95.toFixed(2)} ms (${cap.gpu.length}), effects p95 ${effectsP95 === null ? 'n/a' : effectsP95.toFixed(3)} mean ${effectsMean === null ? 'n/a' : effectsMean.toFixed(3)} ms`,
      ].filter(Boolean);
      console.log(`${c.name}: ${bits.join('; ')}`);
      for (const f of found) failures.push(`${c.name}: ${f}`);
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
