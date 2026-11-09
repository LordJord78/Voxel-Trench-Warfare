// The sounds' proof (npm run sounds; the shots spec's §6, G3's Task 5): every voice rendered to a stereo
// WAV in headless Chrome (an OfflineAudioContext), for the user to hear. The page (tools/sounds/page.ts,
// served through Vite as tools/stills.mjs serves the game) plays each render of tools/sounds/renders.ts
// through audio/voices.ts's own playVoice into the engine's own mix (the master gain and its
// compressor), and reads it there with both ears together: its peak, RMS and loudest 50 ms, its body's
// loudest 50 ms (under 400 Hz alone), its energy's share in 400 Hz–2 kHz and over 400 Hz by an FFT,
// a band rule's own share, and an `over` rule's energy in its band (tools/lib/sound-measures.mjs).
//
//   npm run sounds [-- --only gush,ding]   (or --only=gush,ding)
//
// Writes artifacts/sp7/sounds/<name>.wav (48 kHz stereo, 16-bit) and report.json (merged with what a run
// of a few left, each entry stamped with the commit and the time it was rendered), and prints a table of
// each file's peak, RMS and loudest 50 ms (dBFS) and its shares. Exits 1 if a held file fails: its peak
// outside −30 to −1 dBFS, or silent; or, by its rules, under its floor, too little in its band or over
// 400 Hz (the small speaker), its loudest 50 ms too far from another render's or its body's (the
// kill's thud), or its energy in a band too little over another's (a headshot's kill over the same
// without its gush); the other rendered too, if --only left it out; or if the page fails. Exits 2, with the
// usage, if --only has no list or names no render. A render reported and not held says what fails of
// it, and does not fail the run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { parseOnly } from './lib/cli.mjs';
import { readReport, stamp, writeReport } from './lib/report.mjs';
import { checkSound, table, wav } from './lib/sound-measures.mjs';

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING ??= 'true';

const PORT = 5316;
const OUT = 'artifacts/sp7/sounds';
const PAGE = '/tools/sounds/index.html';
const USAGE = 'usage: npm run sounds [-- --only <names>]   (or --only=<names>; names comma-separated, of the renders in tools/sounds/renders.ts)';

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x === -Infinity ? '-inf' : null);
const round3 = (x) => Math.round(x * 1000) / 1000;
const read = (m) => ({
  peakDb: round2(m.peakDb),
  rmsDb: round2(m.rmsDb),
  loudestDb: round2(m.loudestDb),
  loudestAtS: round3(m.loudestAtS),
  lowLoudestDb: round2(m.lowLoudestDb),
  bandShare: round3(m.bandShare),
  highShare: round3(m.highShare),
  ...(m.ruleShare !== undefined ? { ruleShare: round3(m.ruleShare) } : {}),
  ...(m.overDb !== undefined ? { overDb: round2(m.overDb) } : {}),
});
const samplesOf = (b64) => new Float32Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer);

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
  // The renders it knows, and what each is held to, for --only and its levels' references.
  const known = await page.evaluate(() => window.sounds.list());
  const asked = parseOnly(process.argv.slice(2), known.map((k) => k.name), 'render');
  if ('error' in asked) {
    console.error(asked.error);
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    // A render held to another's level, or over its energy, needs the other rendered too.
    const only = asked.only && [...new Set([...asked.only, ...known.filter((k) => asked.only.includes(k.name)).flatMap((k) => [k.near, k.over].filter((x) => x !== null))])];
    const rendered = await page.evaluate((o) => window.sounds.render(o), only);
    const heard = Object.fromEntries(rendered.map((r) => [r.name, r.heard]));
    const rows = [];
    for (const r of rendered) {
      writeFileSync(`${OUT}/${r.name}.wav`, wav(r.samples.map(samplesOf), r.rate));
      const found = checkSound(r.heard, r.rules ?? {}, heard);
      rows.push({ name: r.name, ...r.heard, failures: found, gated: r.gated });
      if (r.gated) for (const f of found) failures.push(`${r.name}: ${f}`);
      report[r.name] = {
        ...stamp(),
        file: `${OUT}/${r.name}.wav`,
        rate: r.rate,
        channels: 2,
        lengthS: round3(r.lengthS),
        gated: r.gated,
        rules: r.rules,
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
    for (const r of rendered) console.log(`${r.name}: into the compressor ${round2(r.into.peakDb)} dBFS peak, ${round2(r.into.rmsDb)} RMS; out of it, the peak ${report[r.name].compressorDb ?? '-'} dB; its loudest 50 ms from ${Math.round(r.heard.loudestAtS * 1000)} ms; its loudest 50 ms under 400 Hz alone ${round2(r.heard.lowLoudestDb)} dBFS${r.heard.ruleShare !== undefined ? `; its band rule's share ${Math.round(r.heard.ruleShare * 1000) / 10}%` : ''}${r.heard.overDb !== undefined ? `; its energy in its over rule's band ${round2(r.heard.overDb)} dB` : ''}`);
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
  console.log(failures.length ? `${failures.length} failure(s)` : `every held render passes: its peak within -30 to -1 dBFS, none silent, and each held to its rules; written to ${OUT}`);
  process.exitCode = failures.length ? 1 : 0;
}
