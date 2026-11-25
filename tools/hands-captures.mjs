// The gun in the hands, photographed (npm run hands-captures; the shots spec's §2, G4's Task 3): the
// drawn gun at rest, walking and sprinting; through a reload's curve (the long gun's and the pistol's);
// the shotgun's pump; each flash (the AK's bare, the M4's with a compensator, the SVD's, the AK's aimed); a casing in
// flight; the muzzle's smoke on the wind; and the deepest point of a landing's dip. Each from the
// game's own frames in headless Chrome, the loop frozen and stepped a sixtieth of a second a frame (so
// a phase is caught on its frame), the range down (h.range(false)), the front's fire and shells off.
//
//   npm run hands-captures [-- --only rest,flash-ak]   (or --only=rest,flash-ak)
//
// Writes artifacts/sp7/hands/<name>.png for each:
//   rest.png      the AK on the firing step at 14:00, still;
//   walk.png      walking along the bay at 14:00, at the stride's widest swing of the gun;
//   sprint.png    sprinting along the bay, the sprint's blend full;
//   reload-{12,28,62,82}.png  the AK's reload at those hundredths of its phase (the tilt, the magazine
//                 out, in, the bolt);
//   reload-m17-{12,30,62,86}.png  the pistol's (its tilt, the magazine out and in, the slide);
//   pump.png      the M870 0.24 s after a shot: the pump at its deepest;
//   flash-ak.png, flash-m4comp.png, flash-svd.png  the frame of a shot at night (22:30): the core and
//                 prongs, the compensator's side prongs, the casing lit by the flash;
//   flash-ak-aimed.png  the AK aimed down its iron sights at night: of 12 shots, the frame of the one
//                 whose prongs reach highest on the screen (the reticle's line of sight is its middle);
//   casing.png    the AK at 14:00, a twelfth of a second after a shot: its casing in flight;
//   smoke.png     the AK at 14:00, half a second after five shots, the lights' clock running so the
//                 battle's wind blows;
//   land.png      the gun at the deepest point of its landing dip after a jump on the bay's flat floor;
// and report.json (merged with what a run of a few left, each entry stamped with the commit and the
// time): each capture's hands, its gun as the camera saw it (its axes and place along the camera's right,
// up and forward, metres), the effects counted, and for the reloads, the pump and the landing, the
// curve frame by frame. Exits 1 if a capture fails to finish or a page error is seen; 2, with the usage,
// if --only names none of them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { parseOnly } from './lib/cli.mjs';
import { failedEntry, readReport, removePictures, stamp, writeReport } from './lib/report.mjs';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

const PORT = 5318;
const OUT = 'artifacts/sp7/hands';
const SIZE = { width: 1600, height: 1000 };
/** The page's wait for a step, ms. */
const STEP_TIMEOUT_MS = 30_000;
/** Frames drawn thawed for the lights, the TAA and the hands to settle after the clock, the pose and the gun are set. */
const SETTLE_FRAMES = 90;
const DAY = 14;
const NIGHT = 22.5;
const USAGE = 'usage: npm run hands-captures [-- --only <names>]   (or --only=<names>; names comma-separated)';

const withTimeout = (promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out (${STEP_TIMEOUT_MS} ms): ${what}`)), STEP_TIMEOUT_MS))]);

/** In the page: stand `where` ('step', the firing step looking out; 'bay', the spawn bay looking along it, the longer way) with `primary` (and its `fit`) in the hands at `hours`, settled; the pistol up if `pistol`. */
async function stand(page, { where, primary, fit = {}, hours, pistol = false }) {
  return withTimeout(
    page.evaluate(
      async ({ where, primary, fit, hours, pistol, settle }) => {
        const h = window.__trenchline;
        h.thaw();
        h.trigger(false);
        h.aim(false);
        h.turn(0);
        h.holdLights();
        h.setTimeOfDay(hours);
        h.setLoadout({ primary, secondary: 'm17', fits: { [primary]: fit } });
        if (where === 'step') {
          const v = h.views.step;
          h.teleport({ position: [v.position[0], v.position[1] - 1.62, v.position[2]], yaw: v.yaw, pitch: -2 });
        } else {
          // Along the spawn bay's long axis, the way with the more floor before a wall at the chest.
          const sp = h.world.spawn;
          const vx = h.session.voxel;
          const axis = sp.bay.longAxis;
          const room = (sign) => {
            for (let d = 0.1; d < 30; d += 0.1) {
              const p = [...sp.position];
              p[axis] += sign * d;
              if (h.world.map.get(Math.floor(p[0] / vx), Math.floor((p[1] + 1.0) / vx), Math.floor(p[2] / vx)) !== 0) return d;
            }
            return 30;
          };
          const sign = room(1) >= room(-1) ? 1 : -1;
          const yaw = axis === 0 ? (sign > 0 ? 90 : -90) : sign > 0 ? 0 : 180;
          h.teleport({ position: sp.position, yaw, pitch: 0 });
        }
        if (pistol) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
          window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit2' }));
        }
        await h.waitFrames(settle);
        return { hands: h.hands(), player: h.player(), sun: h.sunElevation() };
      },
      { where, primary, fit, hours, pistol, settle: SETTLE_FRAMES },
    ),
    `standing ${where}`,
  );
}

/** In the page: the frozen loop stepped `n` frames, and the last one's gun as the camera saw it, the hands and the effects counted. */
const step = (page, n = 1) =>
  withTimeout(
    page.evaluate(async (n) => {
      const h = window.__trenchline;
      const seen = h.gunFrames(n);
      await h.stepFrames(n);
      const frames = await seen;
      const fx = h.effects();
      return { gun: frames[frames.length - 1].m, hands: h.hands(), player: h.player(), shots: h.session.weapon.shotsFired, fx: { stars: fx.stars, cores: fx.cores, billboards: fx.billboards, lights: fx.lights } };
    }, n),
    'a step',
  );

const press = (page, code, down) => page.evaluate(({ code, down }) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code })), { code, down });
const freeze = (page) => page.evaluate(() => window.__trenchline.freeze());
const shoot = (page) => withTimeout(page.screenshot(), 'a screenshot');
const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const rollOf = (m) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
/** The gun's place and roll as the camera sees it: right, up, forward (m), its roll (degrees). */
const placeOf = (m) => (m ? { right: round4(m[9]), up: round4(m[10]), forward: round4(m[11]), rollDeg: round4(rollOf(m)) } : null);

// ---- the captures --------------------------------------------------------------------------------

/** Still on the step. */
async function rest(page) {
  const at = await stand(page, { where: 'step', primary: 'ak74', hours: DAY });
  await freeze(page);
  const s = await step(page, 2);
  return { pictures: { rest: await shoot(page) }, info: { hours: DAY, sun: at.sun, gun: placeOf(s.gun), hands: s.hands } };
}

/** Walking along the bay: the frame of the stride's widest swing of the gun aside from where it rests. */
async function walk(page) {
  const at = await stand(page, { where: 'bay', primary: 'ak74', hours: DAY });
  await freeze(page);
  const still = await step(page, 2);
  await press(page, 'KeyW', true);
  await step(page, 30);
  let best = null;
  for (let k = 0; k < 40; k++) {
    const s = await step(page);
    const aside = Math.abs(s.gun[9] - still.gun[9]) + Math.abs(s.gun[10] - still.gun[10]);
    if (!best || aside > best.aside) best = { aside, png: await shoot(page), s };
  }
  await press(page, 'KeyW', false);
  return { pictures: { walk: best.png }, info: { hours: DAY, sun: at.sun, still: placeOf(still.gun), gun: placeOf(best.s.gun), offFromStillM: round4(best.aside), speed: round4(Math.hypot(best.s.player.velocity[0], best.s.player.velocity[2])) } };
}

/** Sprinting along the bay, the sprint's blend full. */
async function sprint(page) {
  const at = await stand(page, { where: 'bay', primary: 'ak74', hours: DAY });
  await freeze(page);
  const still = await step(page, 2);
  await press(page, 'ShiftLeft', true);
  await press(page, 'KeyW', true);
  let s = await step(page);
  for (let k = 0; k < 60 && s.hands.sprint < 1; k++) s = await step(page);
  s = await step(page, 4);
  const png = await shoot(page);
  await press(page, 'KeyW', false);
  await press(page, 'ShiftLeft', false);
  if (s.hands.sprint < 1) throw new Error(`the sprint's blend never filled: ${s.hands.sprint}`);
  return { pictures: { sprint: png }, info: { hours: DAY, sun: at.sun, still: placeOf(still.gun), gun: placeOf(s.gun), box: s.hands.box, stillBox: still.hands.box } };
}

/** A reload of `primary` (or the pistol), photographed as its phase crosses each of `marks`, its curve kept frame by frame. */
async function reloadOf(page, { primary, pistol, marks, prefix }) {
  const at = await stand(page, { where: 'step', primary, hours: DAY, pistol });
  await page.evaluate(() => (window.__trenchline.session.weapon.rounds = 3));
  await freeze(page);
  const still = await step(page, 2);
  await press(page, 'KeyR', true);
  await press(page, 'KeyR', false);
  const pictures = {};
  const curve = [];
  const left = [...marks];
  for (let k = 0; k < 400 && left.length > 0; k++) {
    const s = await step(page);
    const phase = s.hands.reload;
    curve.push({ phase: round4(phase), ...placeOf(s.gun) });
    while (left.length > 0 && phase !== null && phase >= left[0] / 100) pictures[`${prefix}-${left.shift()}`] = await shoot(page);
    if (phase === null && curve.length > 5) break;
  }
  if (left.length > 0) throw new Error(`the reload never reached ${left.join(', ')} hundredths`);
  // The rest of the curve, to its end.
  for (let k = 0; k < 300; k++) {
    const s = await step(page);
    curve.push({ phase: round4(s.hands.reload), ...placeOf(s.gun) });
    if (s.hands.reload === null) break;
  }
  return { pictures, info: { hours: DAY, sun: at.sun, gun: at.hands.gun, still: placeOf(still.gun), curve } };
}

const reload = (page) => reloadOf(page, { primary: 'ak74', pistol: false, marks: [12, 28, 62, 82], prefix: 'reload' });
const reloadPistol = (page) => reloadOf(page, { primary: 'ak74', pistol: true, marks: [12, 30, 62, 86], prefix: 'reload-m17' });

/** The shotgun 0.24 s after a shot: the pump back at its deepest. */
async function pump(page) {
  const at = await stand(page, { where: 'step', primary: 'm870', hours: DAY });
  await freeze(page);
  const still = await step(page, 2);
  await page.evaluate(() => window.__trenchline.trigger(true));
  let s = await step(page);
  for (let k = 0; k < 10 && s.shots === still.shots; k++) s = await step(page);
  await page.evaluate(() => window.__trenchline.trigger(false));
  if (s.shots === still.shots) throw new Error('the shotgun did not fire');
  const curve = [{ s: 0, ...placeOf(s.gun) }];
  let png = null;
  for (let k = 1; k <= 30; k++) {
    const f = await step(page);
    curve.push({ s: round4(k / 60), ...placeOf(f.gun) });
    if (k === Math.round(0.24 * 60)) png = await shoot(page);
  }
  return { pictures: { pump: png }, info: { hours: DAY, sun: at.sun, still: placeOf(still.gun), curve } };
}

/** The frame of one shot of `primary` with `fit`, at `hours`; or `after` frames after it. */
async function shot(page, { name, primary, fit = {}, hours, after = 0 }) {
  const at = await stand(page, { where: 'step', primary, fit, hours });
  await freeze(page);
  const still = await step(page, 2);
  await page.evaluate(() => window.__trenchline.trigger(true));
  let s = await step(page);
  for (let k = 0; k < 10 && s.shots === still.shots; k++) s = await step(page);
  await page.evaluate(() => window.__trenchline.trigger(false));
  if (s.shots === still.shots) throw new Error(`${primary} did not fire`);
  if (after > 0) s = await step(page, after);
  return { pictures: { [name]: await shoot(page) }, info: { hours, sun: at.sun, gun: placeOf(s.gun), afterFrames: after, effects: s.fx } };
}

/** Shots taken aimed down the AK's iron sights, a press each, for flash-ak-aimed. */
const AIMED_SHOTS = 12;

/**
 * The AK aimed down its sights at night: AIMED_SHOTS shots, a press each, and the frame of the one whose
 * prongs reach highest on the screen photographed (the worst for the reticle: a prong over the line of
 * sight, the canvas's middle, crosses it along the tracer). Each shot's highest tip is kept, in pixels
 * over that line (over it: positive), how far aside of the middle that tip is (px), the nearest any
 * prong's drawn segment comes to the middle, the reticle (px), and the highest tip over the bore in
 * the drawn gun's frame (m; under the sight's height, 0.0675 m). The shot's kick lifts the drawn gun
 * over the eye's line for the flash's frames, so a tip at the line in the gun's frame shows a few
 * pixels over the middle, well aside of the reticle.
 */
async function aimedFlash(page) {
  const at = await stand(page, { where: 'step', primary: 'ak74', hours: NIGHT });
  const aimed = await page.evaluate(async () => {
    const h = window.__trenchline;
    h.aim(true);
    await h.waitFrames(60);
    return h.hands().aimed;
  });
  if (aimed < 1) throw new Error(`the sights never came up: ${aimed}`);
  await freeze(page);
  let last = await step(page, 2);
  const shots = [];
  let best = null;
  for (let k = 0; k < AIMED_SHOTS; k++) {
    await page.evaluate(() => window.__trenchline.trigger(true));
    let s = await step(page);
    for (let j = 0; j < 10 && s.shots === last.shots; j++) s = await step(page);
    await page.evaluate(() => window.__trenchline.trigger(false));
    if (s.shots === last.shots) throw new Error(`shot ${k} did not leave`);
    const f = await page.evaluate(() => window.__trenchline.flashPixels());
    const own = f.flashes.find((x) => !x.remote);
    if (!own) throw new Error(`shot ${k}: no flash drawn`);
    const c = [f.res[0] / 2, f.res[1] / 2];
    const tips = own.tips.filter((p) => p !== null);
    const top = tips.reduce((a, b) => (b[1] < a[1] ? b : a));
    const over = c[1] - top[1];
    // Each prong's drawn segment's nearest to the middle (the reticle).
    let near = Infinity;
    for (const q of tips) {
      const a = own.at;
      const d = [q[0] - a[0], q[1] - a[1]];
      const u = Math.max(0, Math.min(1, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1)));
      near = Math.min(near, Math.hypot(a[0] + d[0] * u - c[0], a[1] + d[1] * u - c[1]));
    }
    const riseM = Math.max(...own.tipsM.map((tip) => (tip[0] - own.atM[0]) * own.up[0] + (tip[1] - own.atM[1]) * own.up[1] + (tip[2] - own.atM[2]) * own.up[2]));
    shots.push({ overPx: round4(over), asidePx: round4(Math.abs(top[0] - c[0])), nearPx: round4(near), riseM: round4(riseM), prongs: own.tips.length, aimed: round4(s.hands.aimed) });
    if (!best || over > best.over) best = { over, k, png: await shoot(page), s };
    // The kick settled before the next.
    last = await step(page, 20);
  }
  await page.evaluate(() => window.__trenchline.aim(false));
  const nearPx = round4(Math.min(...shots.map((x) => x.nearPx)));
  return { pictures: { 'flash-ak-aimed': best.png }, info: { hours: NIGHT, sun: at.sun, shot: best.k, overPx: round4(best.over), asidePx: shots[best.k].asidePx, nearPx, gun: placeOf(best.s.gun), shots } };
}

/** Half a second after five shots, the battle's wind blowing (the lights' clock run). */
async function smoke(page) {
  const at = await stand(page, { where: 'step', primary: 'ak74', hours: DAY });
  const wind = await page.evaluate(async () => {
    const h = window.__trenchline;
    h.runLights();
    await h.waitFrames(10);
    return h.session.particles.wind;
  });
  await freeze(page);
  const still = await step(page, 2);
  await page.evaluate(() => window.__trenchline.trigger(true));
  let s = still;
  for (let k = 0; k < 60 && s.shots - still.shots < 5; k++) s = await step(page);
  await page.evaluate(() => window.__trenchline.trigger(false));
  s = await step(page, 30);
  const png = await shoot(page);
  await page.evaluate(() => window.__trenchline.holdLights());
  return { pictures: { smoke: png }, info: { hours: DAY, sun: at.sun, wind: wind.map(round4), shots: s.shots - still.shots, gun: placeOf(s.gun) } };
}

/** A jump on the bay's flat floor: the frame of the gun's deepest dip after it lands. */
async function land(page) {
  const at = await stand(page, { where: 'bay', primary: 'ak74', hours: DAY });
  await freeze(page);
  const still = await step(page, 2);
  await press(page, 'Space', true);
  let s = await step(page, 2);
  await press(page, 'Space', false);
  let airborne = false;
  for (let k = 0; k < 90; k++) {
    if (!s.player.onGround) airborne = true;
    if (airborne && s.player.onGround) break;
    s = await step(page);
  }
  if (!airborne || !s.player.onGround) throw new Error(`no jump and landing: ${JSON.stringify(s.player)}`);
  const curve = [];
  let best = null;
  for (let k = 0; k < 24; k++) {
    curve.push({ s: round4(k / 60), ...placeOf(s.gun) });
    if (!best || s.gun[10] < best.s.gun[10]) best = { s, k, png: await shoot(page) };
    s = await step(page);
  }
  return { pictures: { land: best.png }, info: { hours: DAY, sun: at.sun, still: placeOf(still.gun), deepest: placeOf(best.s.gun), deepestAfterS: round4(best.k / 60), dipM: round4(still.gun[10] - best.s.gun[10]), curve } };
}

const CAPTURES = [
  { name: 'rest', take: rest },
  { name: 'walk', take: walk },
  { name: 'sprint', take: sprint },
  { name: 'reload', take: reload, pictures: ['reload-12', 'reload-28', 'reload-62', 'reload-82'] },
  { name: 'reload-m17', take: reloadPistol, pictures: ['reload-m17-12', 'reload-m17-30', 'reload-m17-62', 'reload-m17-86'] },
  { name: 'pump', take: pump },
  { name: 'flash-ak', take: (page) => shot(page, { name: 'flash-ak', primary: 'ak74', hours: NIGHT }) },
  { name: 'flash-m4comp', take: (page) => shot(page, { name: 'flash-m4comp', primary: 'm4', fit: { optic: 'iron', muzzle: 'compensator', under: 'none', side: 'none' }, hours: NIGHT }) },
  { name: 'flash-svd', take: (page) => shot(page, { name: 'flash-svd', primary: 'svd', hours: NIGHT }) },
  { name: 'flash-ak-aimed', take: aimedFlash },
  { name: 'casing', take: (page) => shot(page, { name: 'casing', primary: 'ak74', hours: DAY, after: 5 }) },
  { name: 'smoke', take: smoke },
  { name: 'land', take: land },
];
const picturesOf = (c) => (c.pictures ?? [c.name]).map((p) => `${OUT}/${p}.png`);

// ---- the run -------------------------------------------------------------------------------------

const asked = parseOnly(process.argv.slice(2), CAPTURES.map((c) => c.name), 'capture');
if ('error' in asked) {
  console.error(asked.error);
  console.error(USAGE);
  process.exit(2);
}
const chosen = asked.only ? CAPTURES.filter((c) => asked.only.includes(c.name)) : CAPTURES;
mkdirSync(OUT, { recursive: true });
const report = readReport(`${OUT}/report.json`);
const failures = [];
const pageErrors = [];
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
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.setQuality({ preset: 'high', dynres: false });
    document.getElementById('loading').hidden = true;
    // No range: the hands, not the dummies; no front's fire or shells to move the view.
    h.range(false);
    h.play();
    h.setIntensity('off');
    h.setShelling('off');
  });
  for (const c of chosen) {
    try {
      const { pictures, info } = await c.take(page);
      for (const [name, png] of Object.entries(pictures)) {
        if (!png) throw new Error(`no picture ${name}`);
        writeFileSync(`${OUT}/${name}.png`, png);
      }
      report[c.name] = { ...stamp(), pictures: Object.keys(pictures).map((p) => `${OUT}/${p}.png`), ...info };
      console.log(`${c.name}: ${Object.keys(pictures).join(', ')} ${JSON.stringify({ ...info, curve: info.curve ? `${info.curve.length} frames` : undefined })}`);
    } catch (e) {
      failures.push(`${c.name}: ${e.message}`);
      console.log(`${c.name}: FAILED ${e.message}`);
      report[c.name] = failedEntry([e.message], stamp());
      removePictures(picturesOf(c));
      await page.evaluate(() => window.__trenchline.thaw()).catch(() => {});
    }
  }
} catch (e) {
  failures.push(`run: ${e.message}`);
} finally {
  writeReport(`${OUT}/report.json`, report);
  await browser?.close();
  await server?.close();
}
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
for (const f of failures) console.error(`FAIL ${f}`);
console.log(failures.length ? `${failures.length} failure(s)` : `every capture taken: ${OUT}`);
process.exit(failures.length ? 1 : 0);
