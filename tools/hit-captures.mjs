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
// Then a nearer one (NEAR_BACKSTOP, 0.9 m past the feet: a trench's back wall), the range raised
// afresh, and the head shot again onto it.
//
// Each shot: aimed and settled, the game frozen, the trigger pressed, and the world stepped a frame (a
// sixtieth of a second) at a time; frame 0 is the first frame whose marker shows. Each frame stepped is
// read: the marker and the words, the kill's ring, the readout, the dummy's health, and the blood drawn
// round it (droplets and puffs of mist). At BURST.frame the same frame is drawn again with no time
// passing (the hook's redraw), the blood hidden and then shown again: the burst is the pixels about the
// crosshair it changes, and the shown frame against its first drawing the noise the redraws make. The
// spatter: the backstop and the ground photographed from beside the dummy, flying (no HUD, no gun),
// before the headshot and after it, and the blood voxels counted.
//
//   npm run hit-captures [-- --out artifacts/sp7/hits/before]
//
// Writes, under artifacts/sp7/hits (or --out): torso-{0,2,6}.png and head-{0,2,6,20}.png (each frame as
// displayed), torso-zoom.png and head-zoom.png (ZOOM about the crosshair, magnified, the frame before
// the shot and then each photographed frame, left to right), torso-burst.png and head-burst.png (the
// zoom at BURST.frame with its blood, without it, and with it again), spatter.png (after the headshot),
// spatter-before.png (the same view before it), spatter-marked.png (each blood voxel's middle marked
// magenta), spatter-near.png and spatter-near-marked.png (the nearer backstop after its headshot), and
// report.json (each frame stepped, as read; the gates' numbers; stamped with the commit and the time).
// Exits 1 if:
//   - a shot strikes another zone than it was aimed at (by its marker and the readout's word), the
//     torso hit kills or the headshot does not, or no marker shows within MAX_FRAMES;
//   - a burst changes fewer than BURST.px of its shot's pixels at BURST.frame;
//   - the kill's ring's inner edge has not cleared the dummy's box on the screen by GATES.ringFrame;
//   - the headshot leaves no new blood on the backstop's wall (the cone along the round), or on either
//     backstop the wall's marks hold no cluster of GATES.cluster voxels;
//   - a page error or a GPU error is seen, or a hook is missing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { project } from './lib/camera.mjs';
import { BACKSTOP, BURST, bloodDisc, bloodVoxels, changedPixels, clusters, crop, discMask, DUMMY, dummyCorners, GATES, magnify, NEAR_BACKSTOP, ringClear, screenBox, SHOTS, strip, wallBox, zoneOf, ZOOM } from './lib/hit-measures.mjs';
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
const HOOKS = ['range', 'rangeState', 'hitFeedback', 'standAt', 'setLoadout', 'trigger', 'freeze', 'thaw', 'stepFrames', 'redraw', 'hideBurst', 'waitFrames', 'holdLights', 'setTimeOfDay', 'setIntensity', 'setShelling', 'setQuality', 'play', 'camera', 'mode', 'flyTo', 'walk', 'frames', 'gpuErrors', 'hud'];

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
            // Blood: its own kind (particles.ts BLOOD_BILLBOARD, 5), or a lit disc before it had one.
            if ((out[o + 8] !== 5 && out[o + 8] !== 0) || a <= 0) continue;
            const [r, g, b] = [out[o + 4] / a, out[o + 5] / a, out[o + 6] / a];
            if (r < 0.2 || r < 5 * g || r < 5 * b) continue;
            if (Math.hypot(out[o] - chest[0], out[o + 1] - chest[1], out[o + 2] - chest[2]) > 2.5) continue;
            // A billboard's half-size: a droplet's is 1.5 cm at most, a puff of mist's 7.5 cm at least.
            if (out[o + 3] >= 0.05) {
              mist++;
              mistM = Math.max(mistM, 2 * out[o + 3]);
            } else droplets++;
          }
          // The kill's ring (ui/hit-marker.ts; before G3 Task 6, inside the marker): its middle, its outer
          // and inner edges' radii and its opacity, as drawn now (the bounding box takes its scale).
          const ringEl = document.querySelector('#hud .kill-ring') ?? document.querySelector('#hud .marker.kill .ring');
          let ring = null;
          if (ringEl && !ringEl.hidden && !ringEl.closest('[hidden]') && getComputedStyle(ringEl).display !== 'none') {
            const r = ringEl.getBoundingClientRect();
            const scale = ringEl.offsetWidth > 0 ? r.width / ringEl.offsetWidth : 1;
            const cs = getComputedStyle(ringEl);
            const marker = document.querySelector('#hud .marker');
            const opacity = Number(cs.opacity) * (ringEl.parentElement === marker ? Number(getComputedStyle(marker).opacity) : 1);
            ring = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, outer: r.width / 2, inner: r.width / 2 - parseFloat(cs.borderTopWidth) * scale, opacity };
          }
          return {
            frame: h.frames(),
            marker: fb.marker,
            ring,
            ammo: (h.hud().text.split('\n').find((l) => / \/ /.test(l)) ?? null),
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
  let burst = null;
  const last = Math.max(...shot.frames, BURST.frame);
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
    if (at !== null && (shot.frames.includes(at) || at === BURST.frame)) pngs.set(at, await withTimeout(page.screenshot(), `${shot.name}: frame ${at}`));
    if (at === BURST.frame) {
      // The same frame drawn again with no time passing, the TAA's jitter held: with its blood, without
      // it, and with it again (the noise the redraws make). And where the blood is drawn: each blood
      // billboard's middle and half its size, as the frame's camera saw it.
      const again = async (hidden, jitter) => {
        await page.evaluate(
          async ({ hidden, jitter }) => {
            const h = window.__trenchline;
            h.jitter(jitter);
            h.hideBurst(hidden);
            await h.redraw(1);
          },
          { hidden, jitter },
        );
        return withTimeout(page.screenshot(), `${shot.name}: frame ${at} again`);
      };
      const drawn = await page.evaluate((feet) => {
        const h = window.__trenchline;
        const parts = h.session.particles;
        const out = new Float32Array(parts.capacity * 9);
        const n = parts.billboards(out);
        const blood = [];
        for (let i = 0; i < n; i++) {
          const o = i * 9;
          const a = out[o + 7];
          const at = [out[o], out[o + 1], out[o + 2]];
          // The burst's: blood (its own kind, or a red lit disc before it had one) and a helmet's
          // sparks (emissive), within 2.5 m of the dummy's middle.
          if (Math.hypot(at[0] - feet[0], at[1] - feet[1] - 1, at[2] - feet[2]) > 2.5) continue;
          if (out[o + 8] === 1) {
            blood.push({ at, half: out[o + 3] });
            continue;
          }
          if ((out[o + 8] !== 5 && out[o + 8] !== 0) || a <= 0) continue;
          const [r, g, b] = [out[o + 4] / a, out[o + 5] / a, out[o + 6] / a];
          if (r < 0.2 || r < 5 * g || r < 5 * b) continue;
          blood.push({ at, half: out[o + 3] });
        }
        return { blood, pose: h.camera() };
      }, feet);
      const withHeld = await again(false, false);
      const without = await again(true, false);
      const withAgain = await again(false, false);
      await page.evaluate(() => window.__trenchline.jitter(true));
      burst = { with: withHeld, without, withAgain, drawn };
    }
    if (at === last) break;
    if (zero === null && k >= MAX_FRAMES) break;
  }
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.trigger(false);
    h.hideBurst(false);
    h.thaw();
  });
  return { before, pre, frames, pngs, zero, burst };
}

/** The zoom's box about the crosshair on a frame `w` × `h`: [x0, y0, w, h]. */
const zoomBox = (w, h) => [Math.round(w / 2 - ZOOM.w / 2), Math.round(h / 2 - (ZOOM.h - ZOOM.below) / 2), ZOOM.w, ZOOM.h];

/**
 * A burst measured, on the frame drawn again with its blood, without it, and with it again: the pixels
 * it changes where its blood is drawn (each billboard's disc on the screen, at least a pixel across and
 * BURST's margin round it), and the redraws' noise there (with it against with it again); and over the
 * whole zoom, for the record.
 */
function burstOf(b) {
  const [a, none, again] = [decode(b.with), decode(b.without), decode(b.withAgain)];
  const box = zoomBox(a.w, a.h);
  const discs = b.drawn.blood.map((d) => bloodDisc(b.drawn.pose, [a.w, a.h], d)).filter((d) => d !== null);
  const mask = discMask(discs, a.w, a.h);
  return {
    px: changedPixels(a, none, box, BURST.threshold, mask),
    noise: changedPixels(a, again, box, BURST.threshold, mask),
    againPx: changedPixels(again, none, box, BURST.threshold, mask),
    masked: mask.count,
    billboards: b.drawn.blood.length,
    zoom: { px: changedPixels(a, none, box, BURST.threshold), noise: changedPixels(a, again, box, BURST.threshold) },
  };
}

/** The dummy whose feet are at `feet`, as `pose` drew it on a `res` frame: its box on the screen. */
const dummyOnScreen = (pose, res, feet) => screenBox(dummyCorners(feet, DUMMY).map((p) => project(pose, res, p)));

/** The frame's zoom about the crosshair, magnified. */
function zoomOf(png) {
  const img = decode(png);
  // (h − below) / 2 over the middle, (h + below) / 2 under it.
  const [x0, y0] = zoomBox(img.w, img.h);
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
const said = (f) => `marker ${f.marker ?? '-'}, pop ${f.pop ?? '-'}, readout ${JSON.stringify(f.readout)}, dummy ${f.dummy.hp}${f.dummy.down ? ' down' : ''}, blood ${f.blood.droplets} droplets ${f.blood.mist} mist (to ${f.blood.mistM} m), ammo ${f.ammo ?? '-'}${f.ring ? `, ring ${f.ring.inner.toFixed(1)}–${f.ring.outer.toFixed(1)} px at ${f.ring.opacity.toFixed(2)}` : ''}`;

// ---- run ---------------------------------------------------------------------------------------

const failures = [];
const pageErrors = [];
mkdirSync(OUT, { recursive: true });
const report = { ...stamp(), hours: HOURS, backstop: BACKSTOP, nearBackstop: NEAR_BACKSTOP, vantage: VANTAGE, burstGate: BURST, gates: GATES, shots: {} };
let server;
let browser;

/**
 * One shot fired and read: its frames written, the zone it struck checked by its marker and the
 * readout's word (and the kill or none asked), the burst measured at BURST.frame. What it read.
 */
async function shoot(page, shot, scene, feet) {
  const shotAt = await fire(page, shot, scene.dummy.id, feet);
  const { before, frames, pngs, zero, burst } = shotAt;
  const marked = frames.filter((f) => f.at !== null);
  const entry = { ...shot, before: { ...before, pose: undefined }, zeroStep: zero, frames: frames.map((f) => ({ ...f, pose: { position: f.pose.position.map(round3), yaw: round3(f.pose.yaw), pitch: round3(f.pose.pitch) } })) };
  report.shots[shot.name] = entry;
  if (zero === null) {
    failures.push(`${shot.name}: no marker within ${MAX_FRAMES} frames of the press (${frames.at(-1) ? said(frames.at(-1)) : 'no frame'})`);
    return { entry, marked, frames };
  }
  const at0 = marked[0];
  const end = marked.at(-1);
  // The zone struck, by the marker it gave and the readout's word; and the kill, or none, as asked.
  const zone = zoneOf(at0.readout);
  entry.zone = zone;
  if (shot.kills) {
    if (zone !== 'head' || at0.markers.head <= before.markers.head || !end.dummy.down) failures.push(`${shot.name}: not a headshot that kills: ${said(at0)}; head markers ${before.markers.head} → ${at0.markers.head}`);
  } else if (zone !== 'torso' || at0.marker !== 'hit' || end.dummy.down) failures.push(`${shot.name}: not a torso hit that leaves it standing: ${said(at0)}`);
  for (const f of frames) if (f.gpuErrors.length) failures.push(`${shot.name}: GPU errors: ${f.gpuErrors.join(' | ')}`);
  for (const k of shot.frames) {
    const png = pngs.get(k);
    if (!png) {
      failures.push(`${shot.name}: frame ${k} not photographed`);
      continue;
    }
    writeFileSync(`${OUT}/${shot.name}-${k}.png`, png);
  }
  if (shot.frames.length > 1) {
    const zoom = strip([zoomOf(shotAt.pre), ...shot.frames.filter((k) => pngs.has(k)).map((k) => zoomOf(pngs.get(k)))]);
    writeFileSync(`${OUT}/${shot.name}-zoom.png`, encode(zoom.data, zoom.w, zoom.h));
  }
  if (burst) {
    entry.burst = burstOf(burst);
    const zoom = strip([zoomOf(burst.with), zoomOf(burst.without), zoomOf(burst.withAgain)]);
    writeFileSync(`${OUT}/${shot.name}-burst.png`, encode(zoom.data, zoom.w, zoom.h));
  }
  console.log(`${shot.name}: shot on step ${frames.find((f) => f.shots > before.shots)?.step ?? '-'}, its marker on step ${zero}, the zone ${zone ?? '-'}`);
  for (const f of marked) if (shot.frames.includes(f.at)) console.log(`  frame ${f.at}: ${said(f)}`);
  if (entry.burst) {
    const b = entry.burst;
    console.log(`  the burst at frame ${BURST.frame}: ${b.px} px changed by its blood where its ${b.billboards} billboards are drawn (${b.masked} px; the redraws' noise there ${b.noise} px; shown again, ${b.againPx} px); over the whole zoom ${b.zoom.px} px (noise ${b.zoom.noise} px)`);
  }
  return { entry, marked, frames };
}

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
      const { entry, marked } = await shoot(page, shot, scene, feet);
      if (entry.burst && entry.burst.px < BURST.px[shot.name]) failures.push(`${shot.name}: its burst changed ${entry.burst.px} px at frame ${BURST.frame}, under ${BURST.px[shot.name]}`);
      if (shot.kills) {
        // The kill's ring clear of the dummy's box on the screen by GATES.ringFrame.
        const f = marked.find((x) => x.at === GATES.ringFrame);
        const onScreen = f ? dummyOnScreen(f.pose, [SIZE.width, SIZE.height], feet) : null;
        const ring = f?.ring ?? null;
        const clear = ring && onScreen ? ringClear(ring, onScreen) : null;
        entry.ringGate = { frame: GATES.ringFrame, ring, dummyBox: onScreen, ...(clear ?? {}) };
        const each = marked.filter((x) => x.at !== null && x.at <= 12).map((x) => (x.ring ? `${x.at}: ${x.ring.inner.toFixed(0)}–${x.ring.outer.toFixed(0)} px at ${x.ring.opacity.toFixed(2)}` : `${x.at}: none`));
        console.log(`  the kill's ring by frame (its inner and outer edges' radii): ${each.join('; ')}`);
        if (onScreen) console.log(`  the dummy's box on the screen at frame ${GATES.ringFrame}: x ${onScreen.x0.toFixed(0)}–${onScreen.x1.toFixed(0)}, y ${onScreen.y0.toFixed(0)}–${onScreen.y1.toFixed(0)}; its farthest corner ${clear ? clear.far.toFixed(1) : '-'} px from the ring's middle`);
        if (!clear?.clear) failures.push(`${shot.name}: the kill's ring has not cleared the dummy by frame ${GATES.ringFrame}: ${JSON.stringify(entry.ringGate)}`);
      }
      if (shot.name === 'torso') {
        // Its blood gone and its flinch settled before the headshot.
        await page.evaluate((frames) => window.__trenchline.waitFrames(frames), 2 * SETTLE_FRAMES);
      }
    }
    // After the headshot: the backstop and the ground, and the blood counted.
    const after = await bloodAround(page, feet, scene.voxel, scene.blood);
    const counted = bloodVoxels(after, box);
    const inBox = (b) => ([x, y, z]) => x >= b[0] && y >= b[1] && z >= b[2] && x < b[3] && y < b[4] && z < b[5];
    const wallMarks = after.filter(inBox(box));
    counted.clusters = clusters(wallMarks);
    const view = await spatterView(page, scene.eye, feet);
    writeFileSync(`${OUT}/spatter.png`, view.png);
    writeFileSync(`${OUT}/spatter-marked.png`, markVoxels(view.png, view.pose, after, scene.voxel));
    report.spatter = { pose: view.pose, voxels: counted, list: after };
    const was = report.spatterBefore?.voxels ?? { wall: 0, ground: 0 };
    console.log(`spatter at ${BACKSTOP.behindM} m: ${after.length} blood voxels round the dummy (${counted.wall} on the backstop, ${counted.ground} off it; by shade ${JSON.stringify(counted.byShade)}), ${was.wall + was.ground} before the headshot; the backstop's clusters ${JSON.stringify(counted.clusters)}`);
    // The cone along the round marks the wall: the ground's marks alone are not the spatter's proof.
    if (counted.wall <= was.wall) failures.push(`the headshot marked no new blood on the backstop at ${BACKSTOP.behindM} m (${was.wall} → ${counted.wall}; the ground ${was.ground} → ${counted.ground})`);
    if ((counted.clusters[0] ?? 0) < GATES.cluster) failures.push(`the spatter on the backstop at ${BACKSTOP.behindM} m holds no cluster of ${GATES.cluster}: ${JSON.stringify(counted.clusters)}`);
    if (view.gpuErrors.length) failures.push(`GPU errors: ${view.gpuErrors.join(' | ')}`);

    // The nearer backstop: the first put back, the near one built, the range raised afresh (its dummy
    // standing again, whole), and the head shot again.
    await removeBackstop(page);
    const near = wallBox(scene.eye, feet, NEAR_BACKSTOP, scene.voxel);
    report.nearBackstopBox = near;
    await buildBackstop(page, near, scene.sandbag);
    const again = await page.evaluate(async (settle) => {
      const h = window.__trenchline;
      h.range(false);
      h.range(true);
      await h.waitFrames(settle);
      return h.rangeState().dummies.find((d) => d.id === 200) ?? null;
    }, SETTLE_FRAMES);
    if (!again || again.hp !== 100 || again.down || Math.hypot(again.position[0] - feet[0], again.position[2] - feet[2]) > 0.05) throw new Error(`the range raised again has no whole dummy where the first stood: ${JSON.stringify(again)}`);
    const nearBefore = (await bloodAround(page, feet, scene.voxel, scene.blood)).filter(inBox(near));
    await shoot(page, { ...SHOTS[1], name: 'head-near', frames: [0, 6] }, scene, feet);
    const nearAfter = (await bloodAround(page, feet, scene.voxel, scene.blood)).filter(inBox(near));
    const nearClusters = clusters(nearAfter);
    const nearView = await spatterView(page, scene.eye, feet);
    writeFileSync(`${OUT}/spatter-near.png`, nearView.png);
    writeFileSync(`${OUT}/spatter-near-marked.png`, markVoxels(nearView.png, nearView.pose, nearAfter, scene.voxel));
    report.spatterNear = { pose: nearView.pose, before: nearBefore.length, wall: nearAfter.length, clusters: nearClusters, list: nearAfter };
    console.log(`spatter at ${NEAR_BACKSTOP.behindM} m: ${nearAfter.length} blood voxels on the backstop (${nearBefore.length} before its headshot); its clusters ${JSON.stringify(nearClusters)}`);
    if (nearAfter.length <= nearBefore.length) failures.push(`the headshot marked no new blood on the backstop at ${NEAR_BACKSTOP.behindM} m`);
    if ((nearClusters[0] ?? 0) < GATES.cluster) failures.push(`the spatter on the backstop at ${NEAR_BACKSTOP.behindM} m holds no cluster of ${GATES.cluster}: ${JSON.stringify(nearClusters)}`);
    if (nearView.gpuErrors.length) failures.push(`GPU errors: ${nearView.gpuErrors.join(' | ')}`);
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
