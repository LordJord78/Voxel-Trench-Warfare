// The game's video (npm run video; the showcase spec's §3), for where the game cannot run.
//
// It is recorded from the live renderer in Chrome, at 1280 × 720 and the high preset. The game is
// frozen and stepped two frames (a sixtieth of a second each) per video frame, so the battle runs in
// real time whatever a frame takes to read back.
//
// There are five shots. Each is set up with the flying camera (its histories started afresh) and held
// 20 frames before it is recorded. It is then flown with glide, which moves the camera without starting
// those histories again.
//
// The frames are encoded by ffmpeg as VP9 (CRF 36) and H.264 (CRF 26, faststart) into public/video/.
// Each file is at most 6 MB: the CRF is raised until it fits. Run it again when the look changes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';
const SIZE = { width: 1280, height: 720 };
const FPS = 30;
const HOLD_FRAMES = 20;
const MAX_BYTES = 6 * 1024 * 1024;
const PORT = 5312;
const DUSK = 17 + 35 / 60;
const OUT = 'public/video';

/**
 * The shots: how each is set up (in the page: views, clock, battle), and the camera along it, u from 0
 * to 1 (in the page, from the pose it was set up at). Seconds each.
 */
const SHOTS = [
  // Over the parapet at dusk: rising 0.4 m to the step's eye in its first 3 s (eased), then turning 12°.
  { name: 'over the parapet at dusk', seconds: 10, setup: { view: 'step', hours: DUSK, intensity: 'light', at: 120, below: 0.4 }, path: { kind: 'rise-pan', m: 0.4, deg: 12, rise: 0.3 } },
  { name: "no man's land at night under the flares", seconds: 5, setup: { view: 'nml-night', hours: 21, intensity: 'heavy', flares: true }, path: { kind: 'pan', deg: 8 } },
  { name: 'the hamlet burning', seconds: 5, setup: { view: 'hamlet', hours: 22, intensity: 'light', at: 60 }, path: { kind: 'approach', m: 3 } },
  { name: 'the field from above at night', seconds: 4, setup: { view: 'overview', hours: 21, intensity: 'heavy', flares: true }, path: { kind: 'sink', m: 4 } },
];

const server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
const frames = mkdtempSync(join(tmpdir(), 'trenchline-video-'));
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  await page.evaluate(() => window.__trenchline.setQuality({ preset: 'high', dynres: false }));
  let n = 0;
  for (const shot of SHOTS) {
    // Set up: the view, the clock and the battle; for the night's shots, the battle sought to its flares' most and the eye turned to them.
    const start = await page.evaluate(async (setup) => {
      const h = window.__trenchline;
      h.thaw();
      h.setTimeOfDay(setup.hours);
      h.setIntensity(setup.intensity);
      const v = h.views[setup.view];
      let pose = { position: [...v.position], yaw: v.yaw, pitch: v.pitch };
      // Below the view by this much, to rise to it (over the parapet).
      if (setup.below) pose.position[1] -= setup.below;
      if (setup.flares) {
        for (let at = 120; at < 900; at += 5) {
          h.runLights(at);
          await h.waitFrames(1);
          if (h.battle().flares.filter((f) => f.stage === 'burning').length >= 15) break;
        }
        // Turned to where the flares hang, raised to 10° under their mean height (0–25°).
        const burning = h.battle().flares.filter((f) => f.stage === 'burning');
        let across = 0;
        let along = 0;
        let up = 0;
        for (const f of burning) {
          const dx = f.position[0] - v.position[0];
          const dz = f.position[2] - v.position[2];
          const d = Math.hypot(dx, dz);
          across += dx / d;
          along += dz / d;
          up += Math.atan2(f.position[1] - v.position[1], d);
        }
        if (setup.view !== 'overview') {
          pose.yaw = (Math.atan2(across, along) * 180) / Math.PI;
          pose.pitch = Math.min(25, Math.max(0, ((up / burning.length) * 180) / Math.PI - 10));
        }
      } else {
        h.runLights(setup.at);
      }
      h.flyTo(pose);
      h.freeze();
      return pose;
    }, shot.setup);
    // The way to the nearest fire, for the hamlet's shot.
    const toward = shot.path.kind === 'approach' ? await page.evaluate((p) => {
      const fires = window.__trenchline.battle().fires;
      const near = (a) => Math.hypot(a[0] - p.position[0], a[2] - p.position[2]);
      const f = [...fires].sort((x, y) => near(x.at) - near(y.at))[0];
      return f ? f.at : null;
    }, start) : null;
    await page.evaluate((k) => window.__trenchline.stepFrames(k), HOLD_FRAMES);
    const count = Math.round(shot.seconds * FPS);
    for (let f = 0; f < count; f++) {
      const u = f / (count - 1);
      await page.evaluate(({ start, path, u, toward }) => {
        const h = window.__trenchline;
        const p = [...start.position];
        let yaw = start.yaw;
        if (path.kind === 'rise-pan') {
          const r = Math.min(1, u / path.rise);
          p[1] += path.m * r * r * (3 - 2 * r);
          yaw = start.yaw + path.deg * Math.max(0, (u - path.rise) / (1 - path.rise));
        }
        if (path.kind === 'pan') yaw = start.yaw + path.deg * u;
        if (path.kind === 'approach' && toward) {
          const d = [toward[0] - start.position[0], toward[2] - start.position[2]];
          const l = Math.hypot(d[0], d[1]) || 1;
          p[0] += (d[0] / l) * path.m * u;
          p[2] += (d[1] / l) * path.m * u;
        }
        if (path.kind === 'sink') p[1] -= path.m * u;
        h.glide({ position: p, yaw, pitch: start.pitch });
        return h.stepFrames(2);
      }, { start, path: shot.path, u, toward });
      await page.screenshot({ path: join(frames, `${String(++n).padStart(4, '0')}.png`) });
    }
    console.log(`${shot.name}: ${count} frames`);
  }
  mkdirSync(OUT, { recursive: true });
  const encode = (file, args) => {
    for (let crf = args.crf; ; crf += 2) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(frames, '%04d.png'), ...args.codec(crf), file]);
      const size = statSync(file).size;
      console.log(`${file}: ${(size / 1024 / 1024).toFixed(2)} MB at CRF ${crf}`);
      if (size <= MAX_BYTES) return;
    }
  };
  encode(`${OUT}/trenchline.webm`, { crf: 36, codec: (crf) => ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p'] });
  encode(`${OUT}/trenchline.mp4`, { crf: 26, codec: (crf) => ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] });
} finally {
  rmSync(frames, { recursive: true, force: true });
  await browser.close();
  await server.close();
}
