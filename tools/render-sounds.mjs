// The sounds' proof (npm run sounds; the shots spec's §6): every voice rendered to WAV in headless Chrome
// (an OfflineAudioContext), for the user to hear. The page (tools/sounds/page.ts, served through Vite as
// tools/stills.mjs serves the game) plays each render of tools/sounds/renders.ts through audio/voices.ts's
// own playVoice into the engine's own mix (the master gain and its compressor), and reads it there: its
// peak and RMS, and its energy's share in 400 Hz–2 kHz by an FFT (tools/lib/sound-measures.mjs).
//
//   npm run sounds [-- --only gush,ding]   (or --only=gush,ding)
//
// Writes artifacts/sp7/sounds/<name>.wav (48 kHz mono, 16-bit) and report.json (merged with what a run of
// a few left, each entry stamped with the commit and the time it was rendered), and prints a table of
// each file's peak dBFS, RMS and band share. Exits 1 if a held file's peak is outside −30 to −1 dBFS,
// it is silent, or a voice held to a band (the gush's 400 Hz–2 kHz) has no more than half its energy
// in it; or if the page fails. Exits 2, with the usage, if --only has no list or names no render. A
// render reported and not held (a plate's ring as heard from far off) says what fails of it, and does
// not fail the run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { parseOnly } from './lib/range-measures.mjs';
import { readReport, stamp, writeReport } from './lib/report.mjs';
import { checkSound, table, wav } from './lib/sound-measures.mjs';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

const PORT = 5316;
const OUT = 'artifacts/sp7/sounds';
const PAGE = '/tools/sounds/index.html';
const USAGE = 'usage: npm run sounds [-- --only <names>]   (or --only=<names>; names comma-separated, of the renders in tools/sounds/renders.ts)';

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x === -Infinity ? '-inf' : null);
const read = (m) => ({ peakDb: round2(m.peakDb), rmsDb: round2(m.rmsDb), bandShare: Math.round(m.bandShare * 1000) / 1000 });

let server;
let browser;
const failures = [];
const pageErrors = [];
mkdirSync(OUT, { recursive: true });
const report = readReport(`${OUT}/report.json`);
try {
  server = await (await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })).listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.log(`[page error] ${e.message}`);
  });
  await page.goto(`http://localhost:${PORT}${PAGE}`);
  await page.waitForFunction(() => window.sounds?.ready === true, null, { timeout: 60_000 });
  // The names it knows, for --only.
  const names = await page.evaluate(() => window.sounds.names());
  const asked = parseOnly(process.argv.slice(2), names);
  if ('error' in asked) {
    console.error(asked.error.replace(/capture/g, 'render'));
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const rendered = await page.evaluate((only) => window.sounds.render(only), asked.only);
    const rows = [];
    for (const r of rendered) {
      const samples = new Float32Array(Uint8Array.from(Buffer.from(r.samples, 'base64')).buffer);
      writeFileSync(`${OUT}/${r.name}.wav`, wav(samples, r.rate));
      const found = checkSound(r.heard, r.band ?? {});
      rows.push({ name: r.name, ...r.heard, failures: found, gated: r.gated });
      if (r.gated) for (const f of found) failures.push(`${r.name}: ${f}`);
      report[r.name] = {
        ...stamp(),
        file: `${OUT}/${r.name}.wav`,
        rate: r.rate,
        lengthS: Math.round(r.lengthS * 1000) / 1000,
        gated: r.gated,
        band: r.band,
        plans: r.plans,
        heard: read(r.heard),
        intoCompressor: read(r.into),
        // The compressor's change to the peak (dB): under 0 it took that off; over 0, its make-up gain lifted a quiet voice.
        compressorDb: Number.isFinite(r.into.peakDb) && Number.isFinite(r.heard.peakDb) ? round2(r.heard.peakDb - r.into.peakDb) : null,
        failures: found,
      };
    }
    console.log(table(rows));
    console.log('');
      for (const r of rendered) console.log(`${r.name}: into the compressor ${round2(r.into.peakDb)} dBFS peak, ${round2(r.into.rmsDb)} RMS; out of it, the peak ${report[r.name].compressorDb ?? '-'} dB`);
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
if (process.exitCode !== 2) {
  console.log(failures.length ? `${failures.length} failure(s)` : `every held voice's peak is within -30 to -1 dBFS, and none is silent; written to ${OUT}`);
  process.exitCode = failures.length ? 1 : 0;
}
