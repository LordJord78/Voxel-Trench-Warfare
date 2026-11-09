// G3's proof (npm run hit-captures; the shots spec's §4): a torso hit and a headshot on the range's
// nearest dummy (the 25 m one, laid on both maps) at dusk (19:30), seen from the shooter's eye frame by
// frame, and the spatter the headshot leaves on a backstop behind the dummy and the ground under it.
//
// The Ravine in solo play, the range up (it is the subject) and the rest held still as the tracer
// captures hold it (tools/tracer-captures.mjs): the lights as the plan placed them, the front's fire and
// shells off, the high preset at its full 1.5 MP. The player stands on the spawn bay's firing step with
// an M4 on single shots, aimed from the hip (lib/hit-measures.mjs SHOTS): first at the dummy's chest (55
// of its 100, a hit), then, once the first's blood has gone, at its head (the kill). A sandbag
// backstop is built behind the dummy first (BACKSTOP; the world put back after): the spatter's cone
// along the round needs something within its 2.5 m to land on, and the falling rays mark the ground.
//
// Each shot: aimed and settled, the game frozen, the trigger pressed, and the world stepped a frame (a
// sixtieth of a second) at a time; frame 0 is the first frame whose marker shows. Each frame stepped is
// read: the marker and the words, the readout, the dummy's health, and the blood drawn round it
// (droplets and puffs of mist). The spatter: the backstop and the ground photographed from beside the
// dummy, flying (no HUD, no gun), before the headshot and after it, and the blood voxels counted.
//
//   npm run hit-captures [-- --out artifacts/sp7/hits/before]
//
// Writes, under artifacts/sp7/hits (or --out): torso-{0,2,6}.png and head-{0,2,6,20}.png (each frame as
// displayed), torso-zoom.png and head-zoom.png (ZOOM about the crosshair, magnified, the frame before
// the shot and then each photographed frame, left to right), spatter.png (after the headshot),
// spatter-before.png (the same view before it), spatter-marked.png (each blood voxel's middle marked
// magenta) and report.json (each frame stepped, as read; stamped with the commit and the time). Exits 1
// if a shot does not strike the zone it was aimed at, the torso hit kills or the headshot does not,
// no marker shows within MAX_FRAMES, the headshot marks no blood, a page error or a GPU error is seen,
// or a hook is missing. The look is for the eye: the pictures are read, not gated.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { project } from './lib/camera.mjs';
import { BACKSTOP, bloodVoxels, crop, magnify, SHOTS, strip, wallBox, ZOOM } from './lib/hit-measures.mjs';
import { decode, encode } from './lib/image.mjs';
import { stamp, writeReport } from './lib/report.mjs';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

const PORT = 5317;
const outAt = process.argv.indexOf('--out');
const OUT = outAt >= 0 && process.argv[outAt + 1] ? process.argv[outAt + 1] : 'artifacts/sp7/hits';
const SIZE = { width: 1600, height: 1000 };
/** Dusk. */
const HOURS = 19.5;
/** Frames drawn thawed for the lights, the TAA and the hands to settle after the aim, the clock or the camera is set. */
const SETTLE_FRAMES = 120;
/** Frames stepped from the press before the run fails for want of a marker. */
const MAX_FRAMES = 40;
/** The longest a step, a settle or a read may take before the run fails, ms. */
const STEP_TIMEOUT_MS = 60_000;
/** The spatter's view: from beside the dummy on the shooter's side, `backM` short of its feet along the line of fire and `asideM` to its right, `upM` over them; looking at a point `lookM` past the feet and `lookUpM` over them. */
const VANTAGE = { backM: 2.6, asideM: 1.8, upM: 1.9, lookM: 1.6, lookUpM: 0.5 };
/** Blood voxels are looked for this far round the dummy's feet (m), and from a metre under them to 3 m over. */
const SEARCH_M = 4;
const HOOKS = ['range', 'rangeState', 'hitFeedback', 'standAt', 'setLoadout', 'trigger', 'freeze', 'thaw', 'stepFrames', 'waitFrames', 'holdLights', 'setTimeOfDay', 'setIntensity', 'setShelling', 'setQuality', 'play', 'camera', 'mode', 'flyTo', 'walk', 'frames', 'gpuErrors'];

const withTimeout = (promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out (${STEP_TIMEOUT_MS} ms): ${what}`)), STEP_TIMEOUT_MS))]);
const round3 = (x) => Math.round(x * 1000) / 1000;

/** The page opened, the scene held still at dusk with the range up, the player on the step with an M4: the eye, the nearest dummy, the voxel size, the blood shades. */
async function open(page) {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  const missing = await page.evaluate((names) => names.filter((n) => typeof window.__trenchline[n] !== 'function'), HOOKS);
  if (missing.length) throw new Error(`the page has no ${missing.join(', ')} hook`);
  return withTimeout(
    page.evaluate(
      async ({ hours, settle }) => {
        const h = window.__trenchline;
        const { P } = await import('/src/world/materials.ts');
        h.setQuality({ preset: 'high', dynres: false });
        document.getElementById('loading').hidden = true;
        // Still: the lights as the plan placed them, no rifle fire, no shells; the range up, as solo's click raises it.
        h.holdLights();
        h.setIntensity('off');
        h.setShelling('off');
        h.range(true);
        h.play();
        h.setLoadout({ primary: 'm4', secondary: 'm17', fits: {} });
        h.session.weapon.semi = true;
        h.standAt('step');
        h.setTimeOfDay(hours);
        await h.waitFrames(settle);
        const s = h.session;
        const p = s.player;
        const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
        const flat = (d) => Math.hypot(d.position[0] - eye[0], d.position[2] - eye[2]);
        const dummy = [...h.rangeState().dummies].sort((a, b) => flat(a) - flat(b))[0] ?? null;
        const blood = Object.entries(P)
          .filter(([name]) => name.startsWith('BLOOD_'))
          .map(([, id]) => id);
        // Each frame read: the feedback, the readout, the dummy, and the blood drawn within 2.5 m of its chest.
        window.__hitState = (id) => {
          const fb = h.hitFeedback();
          const st = h.rangeState();
          const d = st.dummies.find((x) => x.id === id);
          const chest = [d.position[0], d.position[1] + 1.3, d.position[2]];
          const parts = h.session.particles;
          const out = new Float32Array(parts.capacity * 9);
          const n = parts.billboards(out);
          let droplets = 0;
          let mist = 0;
          let mistM = 0;
          for (let i = 0; i < n; i++) {
            const o = i * 9;
            const a = out[o + 7];
            if (out[o + 8] !== 0 || a <= 0) continue;
            const [r, g, b] = [out[o + 4] / a, out[o + 5] / a, out[o + 6] / a];
            if (r < 0.2 || r < 5 * g || r < 5 * b) continue;
            if (Math.hypot(out[o] - chest[0], out[o + 1] - chest[1], out[o + 2] - chest[2]) > 2.5) continue;
            // A billboard's half-size: a droplet's is 1.5 cm at most, a puff of mist's 7.5 cm at least.
            if (out[o + 3] >= 0.05) {
              mist++;
              mistM = Math.max(mistM, 2 * out[o + 3]);
            } else droplets++;
          }
          return {
            frame: h.frames(),
            marker: fb.marker,
            pop: fb.pop,
            markers: { ...fb.markers },
            voices: { ...fb.voices },
            readout: st.readout,
            dummy: { hp: d.hp, down: d.down },
            shots: h.session.weapon.shotsFired,
            blood: { droplets, mist, mistM: Math.round(mistM * 100) / 100 },
            pose: h.camera(),
            mode: h.mode(),
            gpuErrors: h.gpuErrors(),
          };
        };
        return { eye, dummy, voxel: s.voxel, map: h.map, sandbag: P.SANDBAG, blood, onStep: h.player().onFiringStep };
      },
      { hours: HOURS, settle: SETTLE_FRAMES },
    ),
    'opening the range',
  );
}

/** The backstop built: what was in its box kept on the page, to be put back. */
const buildBackstop = (page, box, material) =>
  page.evaluate(
    ({ box, material }) => {
      const map = window.__trenchline.world.map;
      const saved = [];
      for (let z = box[2]; z < box[5]; z++) for (let y = box[1]; y < box[4]; y++) for (let x = box[0]; x < box[3]; x++) saved.push(map.get(x, y, z));
      window.__backstop = { box, saved };
      map.fillBox(box[0], box[1], box[2], box[3], box[4], box[5], material);
    },
    { box, material },
  );

const removeBackstop = (page) =>
  page.evaluate(() => {
    const w = window.__backstop;
    if (!w) return;
    const map = window.__trenchline.world.map;
    const [x0, y0, z0, x1, y1, z1] = w.box;
    let i = 0;
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) map.set(x, y, z, w.saved[i++]);
    delete window.__backstop;
  });

/** The blood voxels within SEARCH_M of the feet, from a metre under them to 3 m over: [x, y, z, shade] each. */
const bloodAround = (page, feet, voxel, blood) =>
  page.evaluate(
    ({ feet, voxel, blood, r }) => {
      const map = window.__trenchline.world.map;
      const ids = new Set(blood);
      const found = [];
      const [x0, x1] = [Math.floor((feet[0] - r) / voxel), Math.ceil((feet[0] + r) / voxel)];
      const [z0, z1] = [Math.floor((feet[2] - r) / voxel), Math.ceil((feet[2] + r) / voxel)];
      const [y0, y1] = [Math.floor((feet[1] - 1) / voxel), Math.ceil((feet[1] + 3) / voxel)];
      for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) {
        const v = map.get(x, y, z);
        if (ids.has(v)) found.push([x, y, z, v]);
      }
      return found;
    },
    { feet, voxel, blood, r: SEARCH_M },
  );

/** The view of the backstop and the ground behind the dummy, flown to and settled: its PNG and the pose it was drawn from. Then back to the player. */
async function spatterView(page, eye, feet) {
  const u = [feet[0] - eye[0], feet[2] - eye[2]];
  const n = Math.hypot(u[0], u[1]);
  const [ux, uz] = [u[0] / n, u[1] / n];
  // Right of the line of fire (yaw from +z toward +x): (uz, −ux).
  const at = [feet[0] - ux * VANTAGE.backM + uz * VANTAGE.asideM, feet[1] + VANTAGE.upM, feet[2] - uz * VANTAGE.backM - ux * VANTAGE.asideM];
  const look = [feet[0] + ux * VANTAGE.lookM - at[0], feet[1] + VANTAGE.lookUpM - at[1], feet[2] + uz * VANTAGE.lookM - at[2]];
  const pose = { position: at, yaw: (Math.atan2(look[0], look[2]) * 180) / Math.PI, pitch: (Math.atan2(look[1], Math.hypot(look[0], look[2])) * 180) / Math.PI };
  const seen = await withTimeout(
    page.evaluate(
      async ({ pose, settle }) => {
        const h = window.__trenchline;
        h.thaw();
        h.flyTo(pose);
        await h.waitFrames(settle);
        h.freeze();
        return { pose: h.camera(), mode: h.mode(), gpuErrors: h.gpuErrors() };
      },
      { pose, settle: SETTLE_FRAMES },
    ),
    'flying to the spatter view',
  );
  const png = await withTimeout(page.screenshot(), 'a screenshot of the spatter view');
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.thaw();
    h.walk();
  });
  return { png, ...seen };
}

/**
 * One press at the dummy's `shot.aimM` from the eye, stepped a frame at a time from frozen: each frame
 * read, and a PNG of the frame before the press and of each of `shot.frames` after the marker's.
 */
async function fire(page, shot, dummyId, feet) {
  const target = [feet[0], feet[1] + shot.aimM, feet[2]];
  await withTimeout(
    page.evaluate(
      async ({ target, settle }) => {
        const h = window.__trenchline;
        h.thaw();
        const s = h.session;
        const p = s.player;
        const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
        const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
        p.yaw = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
        p.pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
        await h.waitFrames(settle);
        h.freeze();
      },
      { target, settle: SETTLE_FRAMES },
    ),
    `${shot.name}: aiming`,
  );
  const before = await page.evaluate((id) => window.__hitState(id), dummyId);
  const pre = await withTimeout(page.screenshot(), `${shot.name}: the frame before`);
  const seen = before.markers.hit + before.markers.head + before.markers.kill;
  await page.evaluate(() => window.__trenchline.trigger(true));
  const frames = [];
  const pngs = new Map();
  let zero = null;
  const last = Math.max(...shot.frames);
  for (let k = 1; k <= MAX_FRAMES + last; k++) {
    const s = await withTimeout(
      page.evaluate(async (id) => {
        const h = window.__trenchline;
        await h.stepFrames(1);
        return window.__hitState(id);
      }, dummyId),
      `${shot.name}: a frame`,
    );
    if (s.shots > before.shots) await page.evaluate(() => window.__trenchline.trigger(false));
    const shown = s.markers.hit + s.markers.head + s.markers.kill;
    if (zero === null && shown > seen) zero = k;
    const at = zero === null ? null : k - zero;
    frames.push({ step: k, at, ...s });
    if (at !== null && shot.frames.includes(at)) pngs.set(at, await withTimeout(page.screenshot(), `${shot.name}: frame ${at}`));
    if (at === last) break;
    if (zero === null && k >= MAX_FRAMES) break;
  }
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.trigger(false);
    h.thaw();
  });
  return { before, pre, frames, pngs, zero };
}

/** The frame's zoom about the crosshair, magnified. */
function zoomOf(png) {
  const img = decode(png);
  // (h − below) / 2 over the middle, (h + below) / 2 under it.
  const x0 = Math.round(img.w / 2 - ZOOM.w / 2);
  const y0 = Math.round(img.h / 2 - (ZOOM.h - ZOOM.below) / 2);
  return magnify(crop(img, x0, y0, ZOOM.w, ZOOM.h), ZOOM.scale);
}

/** `png` with a magenta box round each blood voxel's middle, by the pose it was drawn from. */
function markVoxels(png, pose, voxels, voxel) {
  const img = decode(png);
  const data = Uint8Array.from(img.data);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    data.set([255, 0, 255, 255], (y * img.w + x) * 4);
  };
  for (const [x, y, z] of voxels) {
    const q = project(pose, [img.w, img.h], [(x + 0.5) * voxel, (y + 0.5) * voxel, (z + 0.5) * voxel]);
    if (!q) continue;
    const [cx, cy] = [Math.round(q[0]), Math.round(q[1])];
    for (let d = -3; d <= 3; d++) {
      put(cx + d, cy - 3);
      put(cx + d, cy + 3);
      put(cx - 3, cy + d);
      put(cx + 3, cy + d);
    }
  }
  return encode(data, img.w, img.h);
}

/** What a frame read says, for the log. */
const said = (f) => `marker ${f.marker ?? '-'}, pop ${f.pop ?? '-'}, readout ${JSON.stringify(f.readout)}, dummy ${f.dummy.hp}${f.dummy.down ? ' down' : ''}, blood ${f.blood.droplets} droplets ${f.blood.mist} mist (to ${f.blood.mistM} m)`;

// ---- run ---------------------------------------------------------------------------------------

const failures = [];
const pageErrors = [];
mkdirSync(OUT, { recursive: true });
const report = { ...stamp(), hours: HOURS, backstop: BACKSTOP, vantage: VANTAGE, shots: {} };
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
  const scene = await open(page);
  if (!scene.dummy) throw new Error('the range laid no dummy');
  if (!scene.onStep) throw new Error('the player is not on the firing step');
  const feet = scene.dummy.position;
  const distanceM = Math.hypot(feet[0] - scene.eye[0], feet[1] - scene.eye[1], feet[2] - scene.eye[2]);
  console.log(`${scene.map}: the nearest dummy, ${scene.dummy.id}, ${distanceM.toFixed(1)} m from the eye at (${feet.map((v) => v.toFixed(2)).join(', ')})`);
  report.map = scene.map;
  report.dummy = { id: scene.dummy.id, feet, distanceM: round3(distanceM) };
  const box = wallBox(scene.eye, feet, BACKSTOP, scene.voxel);
  report.backstopBox = box;
  await buildBackstop(page, box, scene.sandbag);
  try {
    for (const shot of SHOTS) {
      if (shot.name === 'head') {
        // Before the headshot: the backstop and the ground as they are.
        const view = await spatterView(page, scene.eye, feet);
        writeFileSync(`${OUT}/spatter-before.png`, view.png);
        report.spatterBefore = { pose: view.pose, voxels: bloodVoxels(await bloodAround(page, feet, scene.voxel, scene.blood), box) };
        if (view.mode !== 'fly') failures.push(`the spatter view was ${view.mode}, not flying`);
      }
      const shotAt = await fire(page, shot, scene.dummy.id, feet);
      const { before, frames, pngs, zero } = shotAt;
      const marked = frames.filter((f) => f.at !== null);
      const entry = { ...shot, before: { ...before, pose: undefined }, zeroStep: zero, frames: frames.map((f) => ({ ...f, pose: { position: f.pose.position.map(round3), yaw: round3(f.pose.yaw), pitch: round3(f.pose.pitch) } })) };
      report.shots[shot.name] = entry;
      if (zero === null) {
        failures.push(`${shot.name}: no marker within ${MAX_FRAMES} frames of the press (${frames.at(-1) ? said(frames.at(-1)) : 'no frame'})`);
        continue;
      }
      const at0 = marked[0];
      const end = marked.at(-1);
      // The zone struck, by the marker it gave and the dummy's health: a torso round leaves it standing at 45, a headshot drops it.
      if (shot.kills) {
        if (!end.dummy.down || at0.markers.head <= before.markers.head) failures.push(`${shot.name}: not a headshot that kills: ${said(at0)}; head markers ${before.markers.head} → ${at0.markers.head}`);
      } else if (end.dummy.down || at0.marker !== 'hit' || before.dummy.hp - at0.dummy.hp !== 55) failures.push(`${shot.name}: not a torso hit of 55: ${said(at0)} from ${before.dummy.hp}`);
      for (const f of frames) if (f.gpuErrors.length) failures.push(`${shot.name}: GPU errors: ${f.gpuErrors.join(' | ')}`);
      for (const k of shot.frames) {
        const png = pngs.get(k);
        if (!png) {
          failures.push(`${shot.name}: frame ${k} not photographed`);
          continue;
        }
        writeFileSync(`${OUT}/${shot.name}-${k}.png`, png);
      }
      const zoom = strip([zoomOf(shotAt.pre), ...shot.frames.filter((k) => pngs.has(k)).map((k) => zoomOf(pngs.get(k)))]);
      writeFileSync(`${OUT}/${shot.name}-zoom.png`, encode(zoom.data, zoom.w, zoom.h));
      console.log(`${shot.name}: shot on step ${frames.find((f) => f.shots > before.shots)?.step ?? '-'}, its marker on step ${zero}`);
      for (const f of marked) if (shot.frames.includes(f.at)) console.log(`  frame ${f.at}: ${said(f)}`);
      if (shot.name === 'torso') {
        // Its blood gone and its flinch settled before the headshot.
        await page.evaluate((frames) => window.__trenchline.waitFrames(frames), 2 * SETTLE_FRAMES);
      }
    }
    // After the headshot: the backstop and the ground, and the blood counted.
    const after = await bloodAround(page, feet, scene.voxel, scene.blood);
    const counted = bloodVoxels(after, box);
    const view = await spatterView(page, scene.eye, feet);
    writeFileSync(`${OUT}/spatter.png`, view.png);
    writeFileSync(`${OUT}/spatter-marked.png`, markVoxels(view.png, view.pose, after, scene.voxel));
    report.spatter = { pose: view.pose, voxels: counted, list: after };
    console.log(`spatter: ${after.length} blood voxels round the dummy (${counted.wall} on the backstop, ${counted.ground} off it; by shade ${JSON.stringify(counted.byShade)}), ${report.spatterBefore?.voxels ? `${report.spatterBefore.voxels.wall + report.spatterBefore.voxels.ground} before the headshot` : ''}`);
    if (counted.wall + counted.ground <= (report.spatterBefore?.voxels ? report.spatterBefore.voxels.wall + report.spatterBefore.voxels.ground : 0)) failures.push('the headshot marked no blood');
    if (view.gpuErrors.length) failures.push(`GPU errors: ${view.gpuErrors.join(' | ')}`);
  } finally {
    await removeBackstop(page).catch(() => {});
  }
} catch (e) {
  failures.push(`run: ${e.message}`);
} finally {
  report.failures = [...failures];
  writeReport(`${OUT}/report.json`, report);
  await browser?.close();
  await server?.close();
}
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
for (const f of failures) console.error(`FAIL ${f}`);
console.log(failures.length ? `${failures.length} failure(s)` : `written to ${OUT}`);
process.exit(failures.length ? 1 : 0);
