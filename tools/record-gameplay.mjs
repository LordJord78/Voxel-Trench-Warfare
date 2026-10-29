// The game played (npm run gameplay): a first-person video for the portfolio, beside the fallback
// video (npm run video), which shows the world alone.
//
// It is recorded from the live renderer in Chrome at 1920 × 1080, the high preset, without dynamic
// resolution. The game is frozen and stepped one frame (a sixtieth of a second) per video frame, so
// the play runs in real time at 60 fps whatever a frame takes to read back. The HUD, the rifle and the
// periscope's frame are in the picture, as a player sees them; the loading screen, the still, the
// note and the pause menu are checked hidden.
//
// The play is scripted through the test hooks and the keyboard, as the end-to-end tests play it: the
// player stood at a standard view, turned by setting their yaw and pitch, the trigger held through
// the hooks, shells dropped where they should land. Every cut is held (stepped, not recorded) until
// the renderer's histories have settled.
//
// Each take starts unsuppressed, the player placed as they are. The night's flares are sought under
// heavy fire, and the take is played under light fire: heavy fire takes the player off the firing
// step within a second (suppression's eject_from_step_at), and the shot would be the trench wall.
//
// The frames are encoded by ffmpeg as H.264 (CRF 20, faststart), BT.709 as in record-video.mjs, at
// most 8 MB (the CRF is raised until it fits), with a poster from the frame POSTER_AT.
// PREVIEW=1 records every fourth frame (15 fps) to check the shots quickly. MASTER=<file.mp4> also
// writes a near-lossless copy (CRF 12), to encode other sizes from.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';
const PREVIEW = process.env.PREVIEW === '1';
const SIZE = { width: 1920, height: 1080 };
const STRIDE = PREVIEW ? 4 : 1;
const FPS = 60 / STRIDE;
const HOLD = 60;
const MAX_BYTES = 8 * 1024 * 1024;
const PORT = 5313;
const DUSK = 17 + 35 / 60;
const NIGHT = 21;
const OUT = process.env.OUT ?? 'showcase/gameplay';
/** Seconds into the video for the poster. */
const POSTER_AT = Number(process.env.POSTER_AT ?? 24.5);

const ease = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;

/**
 * The shots. `setup` runs in the page (thawed) before the hold; `frames` is the count at 60 fps;
 * `at(f, u)` returns, for frame f (u from 0 to 1), the look (yaw, pitch, relative to the setup's) and
 * what to do on that frame: keys to press or release, the trigger, a shell.
 */
/** Frame `f` is `s` seconds in. */
const at = (f, s) => f === Math.round(s * 60);

const SHOTS = [
  {
    // On the firing step at dusk: looking over the parapet across no man's land, turning toward the
    // sun as a shell lands out in it; then a magazine on full auto at the far line, and a reload.
    name: 'over the parapet at dusk: a shell out front, a magazine and a reload',
    seconds: 7,
    setup: { view: 'step', hours: DUSK, intensity: 'off', yaw: -20, pitch: 1 },
    at: (f) => {
      const t = f / 60;
      const look = { yaw: lerp(0, 17, ease(Math.min(1, t / 2.4))) + (t > 2.6 ? Math.sin((t - 2.6) * 1.4) * 1.2 : 0), pitch: t > 2.6 ? 0.5 : 0 };
      const act = {};
      if (at(f, 0.9)) act.shell = { ahead: 26, right: -4, radius: 2.6 };
      if (at(f, 2.6)) act.trigger = true;
      if (at(f, 5.4)) act.trigger = false;
      if (at(f, 5.7)) act.press = 'KeyR';
      return { look, act };
    },
  },
  {
    // In the bay at dusk, looking along the trench: a shell lands in the bay ahead and the walls come
    // in; the player goes up to the spoil and digs it out.
    name: 'a shell in the bay, and digging out',
    seconds: 7.5,
    setup: { view: 'bay', hours: DUSK, intensity: 'off', yaw: 0, pitch: 2 },
    at: (f) => {
      const t = f / 60;
      const act = {};
      if (at(f, 0.8)) act.shell = { ahead: 7.5, radius: 2.4 };
      if (at(f, 2.7)) act.down = 'KeyW';
      if (at(f, 4.3)) act.up = 'KeyW';
      if (at(f, 4.5)) act.down = 'KeyF';
      if (at(f, 7.4)) act.up = 'KeyF';
      const look = { yaw: 0, pitch: t < 4.2 ? 0 : -lerp(0, 16, ease(Math.min(1, (t - 4.2) / 0.7))) };
      return { look, act };
    },
  },
  {
    // Night on the firing step under the flares: a shell out in no man's land lights it, then a long
    // burst into the dark while another lands, the front's fire coming back over the line.
    name: 'night under the flares: shells out front and a burst into the dark',
    seconds: 10,
    setup: { view: 'step', hours: NIGHT, intensity: 'heavy', fire: 'light', shelling: 'off', flares: true, yaw: 0, pitch: 3 },
    at: (f) => {
      const t = f / 60;
      const act = {};
      if (at(f, 0.7)) act.shell = { ahead: 30, right: 3, radius: 2.8 };
      if (at(f, 1.9)) act.trigger = true;
      if (at(f, 3.6)) act.shell = { ahead: 20, right: -7, radius: 2.4 };
      if (at(f, 4.8)) act.trigger = false;
      if (at(f, 5.2)) act.press = 'KeyR';
      if (at(f, 7.6)) act.trigger = true;
      if (at(f, 9.2)) act.trigger = false;
      const look = { yaw: lerp(4, -10, ease(Math.min(1, t / 10))) + (t > 1.9 && t < 4.8 ? Math.sin(t * 2.1) * 0.8 : 0), pitch: lerp(0, 2, ease(Math.min(1, t / 10))) };
      return { look, act };
    },
  },
];

const server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1', args: ['--enable-unsafe-webgpu'] });
const frames = mkdtempSync(join(tmpdir(), 'trenchline-gameplay-'));
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  await page.evaluate(() => {
    const h = window.__trenchline;
    h.play();
    h.setQuality({ preset: 'high', dynres: false });
  });
  let n = 0;
  for (const shot of SHOTS) {
    // Set up, thawed: the clock, the front, the player at the view, the flares sought for the night.
    const start = await page.evaluate(async (setup) => {
      const h = window.__trenchline;
      h.thaw();
      h.trigger(false);
      h.setTimeOfDay(setup.hours);
      h.setIntensity(setup.intensity);
      if (setup.shelling) h.setShelling(setup.shelling);
      h.session.weapon.rounds = 30;
      const v = h.views[setup.view];
      let yaw = v.yaw + setup.yaw;
      if (setup.flares) {
        for (let at = 120; at < 900; at += 5) {
          h.runLights(at);
          await h.waitFrames(1);
          if (h.battle().flares.filter((f) => f.stage === 'burning').length >= 12) break;
        }
        // Turned to where the flares hang, within 30° of the view's own heading.
        let across = 0;
        let along = 0;
        for (const f of h.battle().flares.filter((f) => f.stage === 'burning')) {
          const d = Math.hypot(f.position[0] - v.position[0], f.position[2] - v.position[2]);
          across += (f.position[0] - v.position[0]) / d;
          along += (f.position[2] - v.position[2]) / d;
        }
        const toward = (Math.atan2(across, along) * 180) / Math.PI;
        const off = ((toward - v.yaw + 540) % 360) - 180;
        yaw = v.yaw + Math.max(-30, Math.min(30, off)) + setup.yaw;
      } else {
        h.runLights(120);
      }
      // The take's own fire, once the flares are up (the night's: light, so the player keeps the step).
      if (setup.fire) {
        h.setIntensity(setup.fire);
        if (setup.shelling) h.setShelling(setup.shelling);
      }
      h.standAt(setup.view);
      h.session.suppression.level = 0;
      h.session.player.yaw = yaw;
      h.session.player.pitch = v.pitch + setup.pitch;
      h.freeze();
      return { yaw, pitch: v.pitch + setup.pitch, position: v.position, feet: h.player().position };
    }, shot.setup);
    await page.evaluate((k) => window.__trenchline.stepFrames(k), HOLD);
    const shown = await page.evaluate(() => [
      ...['still', 'loading', 'note', 'pause'].filter((id) => {
        const e = document.getElementById(id);
        return e && !e.hidden && getComputedStyle(e).display !== 'none' && getComputedStyle(e).opacity !== '0';
      }),
      ...(window.__trenchline.error ? [`error: ${window.__trenchline.error}`] : []),
    ]);
    if (shown.length) throw new Error(`not the game alone: ${shown.join(', ')}`);
    const count = Math.round(shot.seconds * 60);
    const log = [];
    for (let f = 0; f < count; f++) {
      const { look, act } = shot.at(f, f / (count - 1), start);
      if (act.down) await page.keyboard.down(act.down);
      if (act.up) await page.keyboard.up(act.up);
      if (act.press) await page.keyboard.press(act.press);
      await page.evaluate(({ start, look, act }) => {
        const h = window.__trenchline;
        h.session.player.yaw = start.yaw + look.yaw;
        h.session.player.pitch = start.pitch + look.pitch;
        if (act.trigger !== undefined) h.trigger(act.trigger);
        if (act.shell) {
          // `ahead` along the view's heading and `right` across it, metres.
          const p = h.player().position;
          const yaw = (h.session.player.yaw * Math.PI) / 180;
          const right = act.shell.right ?? 0;
          void h.shell([p[0] + Math.sin(yaw) * act.shell.ahead + Math.cos(yaw) * right, 0, p[2] + Math.cos(yaw) * act.shell.ahead - Math.sin(yaw) * right], act.shell.radius);
        }
        return h.stepFrames(1);
      }, { start, look, act });
      if (act.down || act.up || act.press || act.trigger !== undefined || act.shell) {
        log.push(`${(f / 60).toFixed(2)}s ${JSON.stringify(act)} ${JSON.stringify(await page.evaluate(() => ({ hud: window.__trenchline.hud().text.replace(/\n/g, ' | '), digging: window.__trenchline.session.digging, inReach: window.__trenchline.session.entrenching.inReach, stance: window.__trenchline.player().stance })))}`);
      }
      if (f % STRIDE === 0) await page.screenshot({ path: join(frames, `${String(++n).padStart(5, '0')}.png`) });
    }
    console.log(`${shot.name}: ${count} frames`);
    for (const l of log) console.log(`  ${l}`);
    await page.evaluate(() => window.__trenchline.trigger(false));
    for (const k of ['KeyW', 'KeyF']) await page.keyboard.up(k);
  }
  mkdirSync(OUT, { recursive: true });
  const bt709 = ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  const mp4 = `${OUT}/trenchline-gameplay${PREVIEW ? '-preview' : ''}.mp4`;
  const encode = (crf, to) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(frames, '%05d.png'), ...bt709, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', to]);
  if (process.env.MASTER) {
    encode(12, process.env.MASTER);
    console.log(`${process.env.MASTER}: ${(statSync(process.env.MASTER).size / 1024 / 1024).toFixed(2)} MB at CRF 12`);
  }
  // Six steps of CRF halve the size, about: the step to the next try is taken from how far over it is.
  for (let crf = 20; ; ) {
    encode(crf, mp4);
    const size = statSync(mp4).size;
    console.log(`${mp4}: ${(size / 1024 / 1024).toFixed(2)} MB at CRF ${crf}`);
    if (size <= MAX_BYTES || PREVIEW) break;
    crf += Math.max(1, Math.ceil(6 * Math.log2(size / MAX_BYTES)));
  }
  const poster = String(Math.min(n, Math.max(1, Math.round(POSTER_AT * FPS)))).padStart(5, '0');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(frames, `${poster}.png`), '-q:v', '3', `${OUT}/trenchline-gameplay${PREVIEW ? '-preview' : ''}-poster.jpg`]);
  if (process.env.KEEP_FRAMES) execFileSync('powershell', ['-NoProfile', '-Command', `Copy-Item -Recurse -Force '${frames}' '${process.env.KEEP_FRAMES}'`]);
} finally {
  rmSync(frames, { recursive: true, force: true });
  await browser.close();
  await server.close();
}
