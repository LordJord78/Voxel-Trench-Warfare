// G2's proof (npm run range-captures; the shots spec's §5): the range photographed from the firing step at
// the spawn bay (the step view: the eye its layout sighted every target from, app/main.ts's raise), at
// the hours G1's proof photographed its tracers (tools/lib/range-measures.mjs CAPTURES): noon (12:00),
// 17:35 (solo's opening hour: a visitor's first sight of it), dusk (19:30) and night (22:30), on the
// Ravine (noon, 1735, dusk, night: solo's map) and on the Corridor (corridor-noon …).
//
// A still scene: the camera flown to the step view (the session does not tick, so nothing fires and the
// movers stand at the middle of their walks, where the layout sighted them), the lights held still as
// the plan placed them (no battle: the approved views' and the e2e's), the front's fire off, the high
// preset at its full 1.5 MP, the HUD and the gun out of the frame (they are not drawn flying). Each
// capture is photographed twice, settled each time: the range up, then down, the same frame without
// it, so what the range changes is read pixel by pixel in each target's box (its projection by the
// camera the frame was drawn from), against the noise between two frames of a still scene.
//
//   npm run range-captures [-- --only dusk,corridor-night]
//
// Writes artifacts/sp7/range/<name>.png (the range up, as displayed), <name>-down.png (the same frame
// with it down), <name>-marked.png (a 1 px magenta box round each target), <name>-targets.png (each
// target's box magnified, up beside down, labelled D a dummy, M a mover, T a torso plate, H a head
// plate, and its distance out) and report.json (merged with what a run of a few captures left, each
// entry stamped with the commit and the time it was taken). A capture that fails to finish leaves its
// failure as its entry and none of its pictures.
//
// Exits 1 if the hooks report fewer dummies (listed, standing, drawn) or plates (listed, their steel in
// the world) up than rangeLayout lays for the map, or a layout of none: the layout called in the page
// with the app's own eye (views.step.position) before the range goes up; or if a capture does not
// finish, the range does not go down for its second frame, a page error is seen, or a hook is missing.
// Whether a target shows (SHOW_PIXELS pixels of its box changed by DELTA) is reported, not gated: the
// pictures are for the eye.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { decode, encode } from './lib/image.mjs';
import { CAPTURES, countFailures, DELTA, laidOf, MARGIN_PX, marked, noiseFloor, sheet, shows, SHOW_PIXELS, targetBox } from './lib/range-measures.mjs';
import { failedEntry, readReport, removePictures, stamp, writeReport } from './lib/report.mjs';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

const PORT = 5315;
const OUT = 'artifacts/sp7/range';
const SIZE = { width: 1600, height: 1000 };
/** The longest a settle, a read or a screenshot may take before the run fails, ms. */
const STEP_TIMEOUT_MS = 60_000;
/** Frames drawn for the exposure, the lights, the TAA and the denoiser to settle after the hour is set and the range goes up or down. */
const SETTLE_FRAMES = 180;
/** The maps' pages. */
const PAGES = { ravine: '/', corridor: '/?map=corridor' };
/** The hooks the run needs. */
const HOOKS = ['range', 'rangeState', 'flyTo', 'camera', 'soldiersDrawn', 'holdLights', 'setTimeOfDay', 'waitFrames', 'setIntensity', 'setShelling'];
/** A capture's four pictures. */
const picturesOf = (name) => ['', '-down', '-marked', '-targets'].map((s) => `${OUT}/${name}${s}.png`);
/** A target's letter on the sheet. */
const LETTER = { dummy: 'D', mover: 'M', torso: 'T', head: 'H' };

const withTimeout = (promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out (${STEP_TIMEOUT_MS} ms): ${what}`)), STEP_TIMEOUT_MS))]);

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The map's page opened, its range laid out as the app lays it, then stood up in a still scene at the
 * step view: what rangeLayout lays (called in the page, before the range is up, with the app's eye) and
 * the steel's palette ids.
 */
async function openMap(page, map) {
  await page.goto(`http://localhost:${PORT}${PAGES[map]}`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  const missing = await page.evaluate((names) => names.filter((n) => typeof window.__trenchline[n] !== 'function'), HOOKS);
  if (missing.length) throw new Error(`the page has no ${missing.join(', ')} hook`);
  const layout = await withTimeout(
    page.evaluate(async () => {
      const h = window.__trenchline;
      // The game's own modules (the page's, as Vite serves them): the layout's rules and the [range] table.
      const { rangeLayout, rangeTunables } = await import('/src/combat/range.ts');
      const { loadTunables } = await import('/src/core/tunables.ts');
      const { P } = await import('/src/world/materials.ts');
      const eye = [...h.views.step.position];
      const up = h.rangeState().up;
      const spots = rangeLayout(h.session.map, h.session.voxel, h.world.spawn, rangeTunables(loadTunables()), h.session.plan, eye);
      return { map: h.map, eye, upBefore: up, spots: spots.map((s) => ({ kind: s.kind, distanceM: s.distanceM, at: s.at })), steel: [P.TARGET_STEEL, P.TARGET_STEEL_HIT] };
    }),
    `${map}: laying out the range`,
  );
  if (layout.map !== map) throw new Error(`the page is the ${layout.map}, not the ${map}`);
  if (layout.upBefore) throw new Error(`${map}: the range stood before play: the layout would see its own plates`);
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.setQuality({ preset: 'high', dynres: false });
    document.getElementById('loading').hidden = true;
    // Still: the lights as the plan placed them (no battle), no rifle fire, no shells.
    h.holdLights();
    h.setIntensity('off');
    h.setShelling('off');
    // Up, as a visitor's click into solo play raises it; then the camera at the step view, flying, so
    // the session does not tick: the movers stand where the layout sighted them, at their walks' middles.
    h.range(true);
    h.play();
    const v = h.views.step;
    h.flyTo({ position: [...v.position], yaw: v.yaw, pitch: v.pitch });
  });
  return layout;
}

/** The hour set and the range up or down, settled: what the hooks say of it, and the camera the frame is drawn from. */
const settle = (page, c, up, steel) =>
  withTimeout(
    page.evaluate(
      async ({ hours, up, frames, steel }) => {
        const h = window.__trenchline;
        h.setTimeOfDay(hours);
        h.range(up);
        await h.waitFrames(frames);
        const s = h.rangeState();
        const v = h.session.voxel;
        const map = h.world.map;
        const steelAt = (p) => steel.includes(map.get(Math.floor(p.at[0] / v), Math.floor(p.at[1] / v), Math.floor(p.at[2] / v)));
        return {
          seen: { up: s.up, dummies: s.dummies.length, standing: s.dummies.filter((d) => !d.down).length, drawn: h.soldiersDrawn().length, plates: s.plates.length, steel: s.plates.filter(steelAt).length },
          dummies: s.dummies,
          plates: s.plates,
          pose: h.camera(),
          mode: h.mode(),
          sunElevationDeg: h.sunElevation(),
          exposure: await h.exposure(),
          gpuErrors: h.gpuErrors(),
        };
      },
      { hours: c.hours, up, frames: SETTLE_FRAMES, steel },
    ),
    `${c.name}: settling with the range ${up ? 'up' : 'down'}`,
  );

/** The range's targets as they stand: its dummies (by id: the standing ones, then the movers) and its plates (torso, then head), each with its kind and distance from the layout. */
function targetsOf(layout, state) {
  const dummies = [...layout.spots.filter((s) => s.kind === 'dummy'), ...layout.spots.filter((s) => s.kind === 'mover')];
  const plates = layout.spots.filter((s) => s.kind === 'torso' || s.kind === 'head');
  const eyeM = (at) => Math.hypot(at[0] - layout.eye[0], at[1] - layout.eye[1], at[2] - layout.eye[2]);
  return [
    ...state.dummies.map((d, i) => ({ kind: dummies[i]?.kind ?? 'dummy', id: d.id, distanceM: dummies[i]?.distanceM ?? null, at: d.position, eyeM: round2(eyeM(d.position)) })),
    ...state.plates.map((p, i) => ({ kind: plates[i]?.kind ?? 'torso', index: p.index, distanceM: plates[i]?.distanceM ?? null, at: p.at, eyeM: round2(eyeM(p.at)) })),
  ];
}

/** Capture `c`: the range up, then down, photographed; the counts held to the layout; each target's box measured. */
async function captureAt(page, c, layout) {
  const laid = laidOf(layout.spots);
  const upState = await settle(page, c, true, layout.steel);
  const upPng = await withTimeout(page.screenshot(), `${c.name}: a screenshot, the range up`);
  const downState = await settle(page, c, false, layout.steel);
  const downPng = await withTimeout(page.screenshot(), `${c.name}: a screenshot, the range down`);
  const failures = countFailures(laid, upState.seen).map((f) => `the range up: ${f}`);
  if (downState.seen.up || downState.seen.drawn > 0 || downState.seen.steel > 0) failures.push(`the range did not go down for the second frame: ${JSON.stringify(downState.seen)}`);
  for (const s of [upState, downState]) {
    if (s.mode !== 'fly') failures.push(`the camera is ${s.mode}, not flying: the scene is not still`);
    const off = Math.hypot(...s.pose.position.map((p, k) => p - layout.eye[k]));
    if (off > 0.01) failures.push(`the camera is ${off.toFixed(3)} m from the step view's eye`);
    if (s.gpuErrors.length) failures.push(`GPU errors: ${s.gpuErrors.join(' | ')}`);
  }
  const up = decode(upPng);
  const down = decode(downPng);
  const targets = targetsOf(layout, upState);
  const boxes = targets.map((t) => targetBox(t, upState.pose, [up.w, up.h]));
  const inFront = targets.filter((_, i) => boxes[i] !== null);
  if (inFront.length < targets.length) failures.push(`${targets.length - inFront.length} target(s) behind the camera`);
  const kept = boxes.filter((b) => b !== null);
  const noise = noiseFloor(up, down, kept);
  const measured = inFront.map((t, i) => {
    const m = shows(up, down, kept[i]);
    return { ...t, at: t.at.map(round2), box: kept[i], heightPx: kept[i][3] - kept[i][1] - 2 * MARGIN_PX, ...m, shows: m.pixels >= SHOW_PIXELS };
  });
  const labels = measured.map((t) => `${LETTER[t.kind]}${t.distanceM === null ? '' : Math.round(t.distanceM)}`);
  const frame = marked(up, kept);
  const pairs = sheet(up, down, kept, labels);
  return {
    pictures: [upPng, downPng, encode(frame.data, frame.w, frame.h), encode(pairs.data, pairs.w, pairs.h)],
    entry: { map: c.map, hours: c.hours, sunElevationDeg: round2(upState.sunElevationDeg), exposure: { up: upState.exposure, down: downState.exposure }, eye: layout.eye, laid, seen: upState.seen, down: downState.seen, noiseP99: noise, delta: DELTA, showPixels: SHOW_PIXELS, sheet: labels, targets: measured, failures },
    failures,
    labels,
    measured,
    noise,
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
  for (const map of Object.keys(PAGES)) {
    const ofMap = chosen.filter((c) => c.map === map);
    if (ofMap.length === 0) continue;
    const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => {
      pageErrors.push(`${map}: ${e.message}`);
      console.log(`[page error] ${map}: ${e.message}`);
    });
    try {
      const layout = await openMap(page, map);
      const laid = laidOf(layout.spots);
      console.log(`${map}: rangeLayout lays ${laid.dummies} dummies and ${laid.plates} plates from the step view's eye (${layout.eye.map((v) => v.toFixed(2)).join(', ')}): ${layout.spots.map((s) => `${s.kind} ${s.distanceM}`).join(', ')}`);
      for (const c of ofMap) {
        try {
          const cap = await captureAt(page, c, layout);
          picturesOf(c.name).forEach((path, i) => writeFileSync(path, cap.pictures[i]));
          report[c.name] = { ...stamp(), ...cap.entry };
          written.add(c.name);
          const bits = cap.measured.map((t, i) => `${cap.labels[i]} ${t.shows ? 'shows' : 'FAINT'} ${t.pixels}/${t.area} px (peak ${t.peak}, ${t.heightPx} px high, ${t.eyeM} m)`);
          console.log(`${c.name}: sun ${cap.entry.sunElevationDeg}°, up ${JSON.stringify(cap.entry.seen)}, noise p99 ${cap.noise}; ${bits.join('; ')}`);
          for (const f of cap.failures) failures.push(`${c.name}: ${f}`);
        } catch (e) {
          failCapture(c, e.message);
        }
      }
    } catch (e) {
      for (const c of ofMap) if (!written.has(c.name)) failCapture(c, `not taken: ${e.message}`);
    } finally {
      await page.close();
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
console.log(failures.length ? `${failures.length} failure(s)` : 'every target laid is up, on every capture');
process.exit(failures.length ? 1 : 0);
