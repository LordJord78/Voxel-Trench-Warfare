// G1's proof (npm run tracers; the shots spec's §1 and its done-table rows 1-3): bursts of 30 rounds on
// full auto from the AK on the firing step, at noon (12:00), 17:35 (solo's opening hour, its sun 4.5
// degrees up), dusk (19:30) and night (22:30), each stepped one frame (a sixtieth of a second) at a time
// with the game frozen and photographed over 8 frames mid-burst:
//   - near (30 m): at a man's chest 30 m out, from the hip at the four hours, and aimed at dusk (a
//     picture: aimed at 30 m the round is behind the front post);
//   - far (rounds that fly past 90 m: level, over the enemy parapet 52 m out): from the hip at the four
//     hours, aimed at dusk, and seen from the side (a witness 8 m aside, as a man along the trench sees
//     the stream; from the shooter's eye a round is seen end on once its tracer has joined its path,
//     where the shot was aimed: Session.aimRange); and at night far and side on as Blue (Session.team);
//   - graze: at the parapet's crest just in front, at night, for the rounds that glance off;
//   - wall: at a wall of timber built 10 m out (and the ground put back after), at night: each round
//     strikes within its first tick, so it is drawn once, from the muzzle to the wall.
// 17:35 is seen side on as Blue too, and with the enemy line's rifle fire heavy (its amber in the frame:
// the battle does not fire by day), set once the shooter has settled on the step; the shooter's
// suppression is held at none through that burst, its flinch with it (Suppression.calm before each
// tick: the line's heavy fire pins a man off the step within it, and his stream with him, and its near
// misses drag his muzzle up, toward the low sun), each frame's level after its tick reported, and the
// burst fails if a round leaves with a flinch.
// The front's shelling is off (a crater in the step would move the shooter between captures); its
// rifle fire goes on, and each window frame's suppression is reported. A burst whose shooter is not on
// the firing step fails.
//
//   npm run tracers [-- --only noon,far-night]
//
// Writes artifacts/sp7/tracers/<name>.png (the shot: the first of the 8 frames clear of the flash with
// the player's head drawn), <name>-marked.png (a 1 px magenta box round each head measured),
// <name>-persist.png (the per-pixel maximum of the 8 frames, as the eye holds a stream),
// <name>-persist-marked.png (what the measures read, marked) and report.json (merged with what a run of
// a few captures left, each entry stamped with the commit and the time it was taken). A capture that
// fails to finish leaves its failure as its entry and none of its pictures. Exits 1 if a threshold
// fails, a page error is seen, the hook is missing or a measurement is null.
//
// GPU time in the burst (its first shot to its last round's end, a new sample each frame): the
// frame's p95, and the effects' own passes' (the cost of the tracers' look, apart from the frame's).
//
// Two halves, kept apart: captureAt() here fires and photographs (each frame's PNG as displayed, with
// the player's tracers as the frame drew them, from the hook window.__trenchline.tracerPixels); the
// captures, their measures over the displayed pixels and their gates are tools/lib/tracer-measures.mjs's,
// on the capture tools' own image measures and camera (tools/lib/image.mjs, camera.mjs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { encode, p95, round3 } from './lib/image.mjs';
import { failedEntry, readReport, removePictures, stamp, writeReport } from './lib/report.mjs';
import { CAPTURES, gateCapture, kindOf, LIT, marked, markedComposite, measureCapture, MIN_GPU_SAMPLES, MIN_RATIO, NOON_HEAD_MIN, pathSamples, RING_MIN_PIXELS, SMOKE_KIND, STREAM_AIM_PX, STREAM_FROM_M, TARGET, TEAM, TINT, trackRound, WALL } from './lib/tracer-measures.mjs';

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
/** Aimed, the G-buffer's depth is read over this box round the middle (CSS pixels each way), for what of the path the gun covers. */
const CENTRE_BOX_PX = 64;

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
  // A wall built WALL.outM out across the view, level: each round strikes it within its first tick.
  wall: { pitch: 0, what: `a wall ${WALL.outM} m out`, wall: true },
};
/** The witness's place beside the shooter (m): aside along the trench to the left, up, back; looking at the round's path this far out. */
const WITNESS = { aside: 8, up: 1.5, back: 2, lookAtM: 50 };
/** A capture's four pictures. */
const picturesOf = (name) => ['', '-marked', '-persist', '-persist-marked'].map((s) => `${OUT}/${name}${s}.png`);

// ---- capture -----------------------------------------------------------------------------------

const withTimeout = (promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out (${FRAME_TIMEOUT_MS} ms): ${what}`)), FRAME_TIMEOUT_MS))]);

const HIDE_HUD_MARK = '#hud .crosshair, #hud .reticle { visibility: hidden !important; }';

/** Fire the burst for `c` and photograph its window: each frame's PNG as displayed, the player's tracers as drawn, and the burst's own numbers. */
async function captureAt(page, c) {
  const b = BURSTS[c.burst];
  const kind = kindOf(c);
  const shooter = await withTimeout(
    page.evaluate(
      async ({ hours, aimed, settle, pitch, side, witness, team, wall }) => {
        const h = window.__trenchline;
        h.thaw();
        h.trigger(false);
        h.spectate(null);
        h.aim(false);
        h.setTimeOfDay(hours);
        // The shooter's team, and so their tracers' colour (solo's is red).
        h.session.team = team;
        h.setLoadout({ primary: 'assault_rifle', secondary: 'm17', fits: {} });
        const v = h.views.step;
        if (wall) {
          // A wall across the view `outM` out from the eye, square to the axis nearest the view: what was
          // there kept, to be put back.
          const R = Math.PI / 180;
          const f = [Math.sin(v.yaw * R), 0, Math.cos(v.yaw * R)];
          const thin = Math.abs(f[0]) > Math.abs(f[2]) ? 0 : 2;
          const wide = thin === 0 ? 2 : 0;
          const c = [v.position[0] + f[0] * wall.outM, v.position[1], v.position[2] + f[2] * wall.outM];
          const lo = [0, c[1] - wall.belowM, 0];
          const hi = [0, c[1] + wall.aboveM, 0];
          lo[thin] = c[thin] - wall.thickM / 2;
          hi[thin] = c[thin] + wall.thickM / 2;
          lo[wide] = c[wide] - wall.halfWidthM;
          hi[wide] = c[wide] + wall.halfWidthM;
          const vx = h.session.voxel;
          const box = [...lo.map((m) => Math.floor(m / vx)), ...hi.map((m) => Math.ceil(m / vx))];
          const map = h.world.map;
          const saved = [];
          for (let z = box[2]; z < box[5]; z++) for (let y = box[1]; y < box[4]; y++) for (let x = box[0]; x < box[3]; x++) saved.push(map.get(x, y, z));
          window.__tracerWall = { box, saved };
          map.fillBox(box[0], box[1], box[2], box[3], box[4], box[5], wall.material);
        }
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
        return { ...h.player(), team: h.session.team, sunElevation: h.sunElevation() };
      },
      { hours: c.hours, aimed: !!c.aimed, settle: SETTLE_FRAMES, pitch: b.pitch, side: !!c.side, witness: WITNESS, team: c.team ?? 'red', wall: b.wall ? WALL : null },
    ),
    `${c.name}: setting up`,
  );
  if (!shooter.onFiringStep) throw new Error(`${c.name}: the shooter is not on the firing step: ${JSON.stringify(shooter)}`);
  if (shooter.team !== (c.team ?? 'red')) throw new Error(`${c.name}: the shooter fights for ${shooter.team}, not ${c.team ?? 'red'}`);
  // The enemy line's rifle fire for the burst, once the shooter has settled on the step (its shells off).
  if (c.front) {
    await page.evaluate((front) => {
      const h = window.__trenchline;
      h.setIntensity(front);
      h.setShelling('off');
    }, c.front);
  }
  const step = () =>
    withTimeout(
      page.evaluate(async ({ kind, hold }) => {
        const h = window.__trenchline;
        // Held, the shooter's suppression is none as each tick begins, the flinch too: a near miss drags
        // the muzzle up by flinch_deg, and the front's heavy fire took a followed round's path into the
        // low sun's glare, its pixels washed pale.
        if (hold) h.session.suppression.calm();
        // The flinch this tick's round leaves with (a near miss's drag on the muzzle, degrees).
        const flinch = Math.hypot(h.session.suppression.flinchPitch, h.session.suppression.flinchYaw);
        await h.stepFrames(1);
        const s = h.stats();
        const t = h.tracerPixels();
        const own = t.tracers.filter((x) => x.kind === kind);
        const fx = h.effects();
        // The effects' own passes (the billboards' light and the draw), the latest measured frame's: what the tracers' look costs.
        const fxMs = (s.ownLast?.['effects-light'] ?? 0) + (s.ownLast?.effects ?? 0);
        // The enemy line's rounds drawn (the session's amber, TRACER_KIND 1).
        const amber = t.tracers.filter((x) => x.kind === 1 && x.head && x.tail).length;
        return { flinch, frame: h.frames(), gpu: s.gpuLastMs, gpuSamples: s.gpuSamples, fxMs, rounds: t.weapon.rounds, live: own.length, heads: own.filter((x) => x.headDrawn).length, amber, ricochets: fx.ricochets, embers: fx.embers, ricochetsByKind: fx.ricochetsByKind, embersByKind: fx.embersByKind };
      }, { kind, hold: !!c.front }),
      `${c.name}: a frame`,
    );
  /** The frame just stepped, read whole: the tracers drawn, the drawn muzzle, the internal image's size, the shooter's suppression, the muzzle's smoke drawn ((a) reads round it); aimed, the G-buffer's depth round the middle. */
  const readFrame = () =>
    withTimeout(
      page.evaluate(
        async ({ aimed, half, smokeKind }) => {
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
          const battle = h.battle().tracers.map((b) => ({ p: b.position, v: b.velocity, flown: b.flown }));
          const smoke = h.particleBillboards().filter((b) => b.kind === smokeKind).map((b) => ({ at: b.at, half: b.half }));
          return { info, internal, muzzle: h.rifleMuzzle(), exposure: await h.exposure(), suppression: h.session.suppression.level, fx: { ricochets: fx.ricochets, embers: fx.embers, heads: fx.heads, battleTracers: fx.battleTracers }, depth, battle, smoke };
        },
        { aimed: !!c.aimed, half: CENTRE_BOX_PX, smokeKind: SMOKE_KIND },
      ),
      `${c.name}: reading a frame`,
    );
  const first = await withTimeout(
    page.evaluate(() => {
      const h = window.__trenchline;
      h.freeze();
      const t = h.tracerPixels();
      h.trigger(true);
      return { rounds: t.weapon.rounds, weapon: t.weapon, frame: h.frames() };
    }),
    `${c.name}: freezing`,
  );
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
  /** Held, the flinch of each round that left with one (degrees). */
  const flinched = [];
  let shots = 0;
  // The most drawn in a frame: of every kind (the front's amber too), and by kind (TRACER_KIND).
  const most = { ricochets: 0, embers: 0, ricochetsByKind: [0, 0, 0, 0], embersByKind: [0, 0, 0, 0] };
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
      if (fired) shots++;
      if (fired && c.front && s.flinch > 0) flinched.push(s.flinch);
      most.ricochets = Math.max(most.ricochets, s.ricochets);
      most.embers = Math.max(most.embers, s.embers);
      for (let j = 0; j < 4; j++) {
        most.ricochetsByKind[j] = Math.max(most.ricochetsByKind[j], s.ricochetsByKind[j]);
        most.embersByKind[j] = Math.max(most.embersByKind[j], s.embersByKind[j]);
      }
      // Samples inside the burst only: from the first shot to the last round's retirement; a new sample, never a repeat.
      if (firstShotAt !== null && retired === null && s.gpu != null && s.gpuSamples !== lastSamples) {
        gpu.push(s.gpu);
        effectsGpu.push(s.fxMs);
      }
      lastSamples = s.gpuSamples;
      // With the front's fire heavy, the window opens on a frame the enemy line's amber is drawn in too.
      if (windowAt === null && firstShotAt !== null && k >= firstShotAt + SHOT_AFTER_FIRST && fired && (!c.front || s.amber > 0)) {
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
          const samples = pathSamples(frames, trackRound(frames, kind));
          if (samples) {
            const scale = read.internal[0] / read.info.res[0];
            const points = samples.points.map((q) => [Math.floor(q[0] * scale), Math.floor(q[1] * scale)]);
            pathDepth = await withTimeout(page.evaluate((p) => window.__trenchline.depthAt(p), points), `${c.name}: the depth along the path`);
          }
        }
      }
      if (s.rounds === 0 && s.live === 0) {
        retired = k;
        break;
      }
    }
  } finally {
    if (hidden) await hidden.evaluate((n) => n.remove()).catch(() => {});
    await page.evaluate(() => {
      const h = window.__trenchline;
      h.trigger(false);
      h.spectate(null);
      h.session.team = 'red';
      // The enemy line's rifle fire back to solo's light, its shells off; a wall's place put back.
      h.setIntensity('light');
      h.setShelling('off');
      const w = window.__tracerWall;
      if (w) {
        const [x0, y0, z0, x1, y1, z1] = w.box;
        let i = 0;
        for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) h.world.map.set(x, y, z, w.saved[i++]);
        delete window.__tracerWall;
      }
    });
  }
  if (firstShotAt === null || frames.length < PERSIST_FRAMES || retired === null) throw new Error(`${c.name}: the burst did not run: first shot ${firstShotAt}, ${frames.length} frames photographed, retired ${retired}`);
  if (flinched.length) throw new Error(`${c.name}: the shooter's suppression was not held at none: ${flinched.length} of ${shots} rounds left with a flinch, up to ${Math.max(...flinched).toFixed(2)} degrees`);
  return {
    frames,
    pathDepth,
    burst: { at: b.what, pitchDeg: Math.round(b.pitch * 1000) / 1000, sunElevationDeg: round3(shooter.sunElevation), firstShotFrame: firstShotAt, lastShotFrame: lastShotAt, framesFor30Rounds: lastShotAt - firstShotAt + 1, window: [windowAt, windowAt + PERSIST_FRAMES - 1], retiredFrame: retired, frameBase: first.frame },
    gpu,
    effectsGpu,
    most,
  };
}

// ---- run ---------------------------------------------------------------------------------------

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const chosen = CAPTURES.filter((c) => !only || only.includes(c.name));
if (chosen.length === 0) {
  console.error(`--only: none of ${CAPTURES.map((c) => c.name).join(', ')}`);
  process.exit(2);
}
const failures = [];
const pageErrors = [];
mkdirSync(OUT, { recursive: true });
const report = readReport(`${OUT}/report.json`);
/** The captures this run has written an entry for, measured or failed. */
const written = new Set();
/** A capture that did not finish: its failure as its entry, stamped, and its pictures removed. */
const failCapture = (c, message) => {
  failures.push(`${c.name}: ${message}`);
  console.log(`${c.name}: FAILED ${message}`);
  report[c.name] = failedEntry([message], stamp());
  removePictures(picturesOf(c.name));
  written.add(c.name);
};
let server;
let browser;
try {
  server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.log(`[page error] ${e.message}`);
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  if (!(await page.evaluate(() => typeof window.__trenchline.tracerPixels === 'function'))) throw new Error('the page has no tracerPixels hook');
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.setQuality({ preset: 'high', dynres: false });
    document.getElementById('loading').hidden = true;
    // No range: G1's proof is of the world as it was approved, without dummies in frame or movers in
    // the far bursts (the range goes up at the first play, as a visitor's does).
    h.range(false);
    h.play();
    // No shells: a crater in the step would move the shooter between captures (the front's rifle fire goes on).
    h.setShelling('off');
  });
  for (const c of chosen) {
    try {
      const cap = await captureAt(page, c);
      const { m, imgs, comp, shot } = measureCapture(c, cap);
      const found = gateCapture(c, m, { most: cap.most, gpuSamples: cap.gpu.length });
      const [shotPng, markedPng, persistPng, persistMarkedPng] = picturesOf(c.name);
      writeFileSync(shotPng, cap.frames[shot].png);
      writeFileSync(markedPng, marked(imgs[shot], m));
      writeFileSync(persistPng, encode(comp.data, comp.w, comp.h));
      writeFileSync(persistMarkedPng, markedComposite(comp, m));
      const gpuP95 = p95(cap.gpu);
      const effectsP95 = p95(cap.effectsGpu);
      const effectsMean = cap.effectsGpu.length ? cap.effectsGpu.reduce((a, b) => a + b, 0) / cap.effectsGpu.length : null;
      const { marks, ...cover } = m.pathCover ?? {};
      const { marks: streamMarks, ...stream } = m.stream ?? {};
      const kind = kindOf(c);
      report[c.name] = {
        ...stamp(),
        hours: c.hours, burst: c.burst, aimed: !!c.aimed, side: !!c.side, team: c.team ?? 'red', kind, weapon: cap.frames[shot].info.weapon, burstFrames: cap.burst, gpuSamples: cap.gpu.length, gpuP95, effectsGpu: { p95: effectsP95, mean: effectsMean },
        most: cap.most, failures: found,
        thresholds: { minRatio: MIN_RATIO, minRatioIn: "the head's top channel over the ring's mean in it", battleGated: !!c.battle, noonHeadChannelMin: NOON_HEAD_MIN, stream: { fromM: STREAM_FROM_M, aimPx: STREAM_AIM_PX }, minGpuSamples: MIN_GPU_SAMPLES, ringMinPixels: RING_MIN_PIXELS, lit: LIT, tint: TINT, targets: TARGET, team: TEAM },
        front: c.front ?? 'light',
        ...m,
        pathCover: m.pathCover ? cover : null,
        stream: m.stream ? stream : null,
        farColour: m.farColour ? { ...m.farColour, pixels: undefined } : null,
      };
      written.add(c.name);
      const hl = m.headline;
      const levels = m.window.map((w) => w.suppression);
      const bits = [
        hl ? `head ${hl.headTop} ${hl.headChannel} / ring ${hl.headTop} ${hl.ringMeanTop.toFixed(1)} = ${hl.ratioTop.toFixed(2)} (V ${hl.ratioV.toFixed(2)}, luminance ${hl.headLum.toFixed(1)} / ${hl.ringMean.toFixed(1)} = ${hl.ratio.toFixed(2)})` : `no head (${m.headsDrawn} drawn)`,
        m.nearWidth ? `(a) ${m.nearWidth.px} px (lit ${m.nearWidth.litPx}; ${m.nearWidth.samples} samples${m.nearWidth.underSmoke?.samples ? `, ${m.nearWidth.underSmoke.samples} under smoke left out, widest ${m.nearWidth.underSmoke.px} px` : ''})` : null,
        m.farColour ? `(b) sat ${round3(m.farColour.saturation)} hue ${m.farColour.hueDeg?.toFixed(1)} (n ${m.farColour.n}; tinted sat ${round3(m.farColour.tint.saturation)} hue ${m.farColour.tint.hueDeg?.toFixed(1)} n ${m.farColour.tint.n})` : null,
        m.battleColour ? `battle sat ${round3(m.battleColour.saturation)} hue ${m.battleColour.hueDeg?.toFixed(1)} (n ${m.battleColour.n})` : null,
        m.stream ? `(e) ${m.stream.counts} ${round3(m.stream.share)} of ${m.stream.samples ?? 0}${m.stream.unread ? ` (${m.stream.unread} unread)` : ''}, reach ${m.stream.reachPx}/${m.stream.muzzlePx} = ${round3(m.stream.span)} [lit alone ${round3(m.stream.lit?.share)}, reach ${m.stream.lit?.reachPx ?? '-'} = ${round3(m.stream.lit?.span)}] (shown ${m.stream.innerPx}-${m.stream.reachPx} px: ${round3(m.stream.extent)}; ${STREAM_FROM_M} m at ${m.stream.atFromPx} px, 1 m ${m.stream.at1mPx}, 3 m ${m.stream.at3mPx})` : null,
        m.pathCover ? `(c) ${m.pathCover.counts} ${round3(m.pathCover.share)} [lit alone ${round3(m.pathCover.litShare)}] over ${m.pathCover.lengthPx} px of the ${m.pathCover.fit ?? '-'} line${m.pathCover.endOn ? ' (end on)' : ''}${m.pathCover.behindGun ? `, ${m.pathCover.behindGun} behind the gun` : ''}${m.pathCover.hiddenByWorld ? `, ${m.pathCover.hiddenByWorld} hidden` : ''} (tinted ${round3(m.pathCover.tint?.share)}, hue ${m.pathCover.tint?.hueDeg?.toFixed(1)} sat ${round3(m.pathCover.tint?.saturation)})` : null,
        m.frontColour?.drawn ? `the front's amber: ${m.frontColour.drawn} drawn, tinted n ${m.frontColour.n} hue ${m.frontColour.hueDeg?.toFixed(1)} sat ${round3(m.frontColour.saturation)}` : null,
        m.noonContrast ? `(d) ${round3(m.noonContrast.ratio)}` : null,
        `ricochets ${cap.most.ricochetsByKind[kind]} the player's of ${cap.most.ricochets}, embers ${cap.most.embersByKind[kind]} of ${cap.most.embers}`,
        `suppression ${levels.every((v) => v === 0) ? 'none' : levels.map((v) => v.toFixed(2)).join(' ')}`,
        `gpu p95 ${gpuP95 === null ? 'n/a' : gpuP95.toFixed(2)} ms (${cap.gpu.length}), effects p95 ${effectsP95 === null ? 'n/a' : effectsP95.toFixed(3)} mean ${effectsMean === null ? 'n/a' : effectsMean.toFixed(3)} ms`,
      ].filter(Boolean);
      console.log(`${c.name}: ${bits.join('; ')}`);
      for (const f of found) failures.push(`${c.name}: ${f}`);
    } catch (e) {
      failCapture(c, e.message);
    }
  }
} catch (e) {
  failures.push(`run: ${e.message}`);
  // The captures the run did not reach: their entries say so, and keep no pictures of an older run's.
  for (const c of chosen) if (!written.has(c.name)) failCapture(c, `not taken: ${e.message}`);
} finally {
  writeReport(`${OUT}/report.json`, report);
  await browser?.close();
  await server?.close();
}
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
for (const f of failures) console.error(`FAIL ${f}`);
console.log(failures.length ? `${failures.length} failure(s)` : 'all thresholds met');
process.exit(failures.length ? 1 : 0);
