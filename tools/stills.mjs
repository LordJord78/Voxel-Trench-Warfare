// The game's stills (npm run stills; the showcase spec's §2): the first view the live world draws (the
// firing step's over the parapet, at the clock's dusk key, at a first visit's defaults), photographed in
// Chrome with the loading screen hidden once its histories have settled. They are written as the page's still
// (public/stills/dusk.webp, 1920 × 1440, by cwebp) and the link previews' image (public/stills/og.jpg,
// the still's middle 1200 × 630, by ffmpeg). Run it again when the look changes. The still is 4:3: the
// camera's field of view is horizontal, so its middle rows are what any wider window draws, and the
// page fits it to the window's width.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';
const SIZE = { width: 1920, height: 1440 };
/** Frames drawn after the world is first drawn, for the denoiser's and TAA's histories to settle. */
const SETTLE_FRAMES = 240;
const PORT = 5311;
const STILL = 'public/stills/dusk.webp';
const OG = 'public/stills/og.jpg';

const server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
const scratch = mkdtempSync(join(tmpdir(), 'trenchline-stills-'));
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__trenchline.error);
  if (error) throw new Error(`the game stopped: ${error}`);
  // The high preset at its full image (a first visit's on a machine that holds it), the loading screen
  // out of the way, the world as it is first drawn behind it.
  await page.evaluate(async (frames) => {
    const h = window.__trenchline;
    h.setQuality({ preset: 'high', dynres: false });
    document.getElementById('loading').hidden = true;
    await h.waitFrames(frames);
  }, SETTLE_FRAMES);
  const png = join(scratch, 'still.png');
  await page.screenshot({ path: png });
  mkdirSync('public/stills', { recursive: true });
  execFileSync('cwebp', ['-quiet', '-q', '72', '-m', '6', png, '-o', STILL]);
  // Scaled to 1200 wide (900 high), its middle 630.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', 'scale=1200:-1,crop=1200:630', '-q:v', '4', OG]);
  for (const file of [STILL, OG]) console.log(`${file}: ${(statSync(file).size / 1024).toFixed(0)} KB`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  await browser.close();
  await server.close();
}
