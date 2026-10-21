// One-off milestone check: generate the world in headless Chrome and print
// what the page reports. `node tools/preview-gen.mjs` runs the dev server;
// `--prod` serves the production build in dist/ instead.
import { chromium } from '@playwright/test';
import { createServer, preview } from 'vite';

const prod = process.argv.includes('--prod');
const port = 5310;
const server = prod
  ? await preview({ preview: { port, strictPort: true } })
  : await (await createServer({ server: { port, strictPort: true } })).listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.__trenchline?.ready === true, null, { timeout: 180_000 });
  const report = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    error: window.__trenchline.error,
    ms: window.__trenchline.ms,
    promptMs: window.__trenchline.promptMs,
    timings: window.__trenchline.world?.timings,
  }));
  // The dev server serves sources, so the page can fingerprint its own world.
  const print = prod || report.error ? null : await page.evaluate(async () => {
    const { fingerprint } = await import('/src/world/fingerprint.ts');
    return fingerprint(window.__trenchline.world.map);
  });
  console.log(report.status);
  if (report.error) process.exitCode = 1;
  else {
    const t = report.timings;
    const core = t.fill + t.assemble + t.events;
    console.log(`fill + assemble + events: ${Math.round(core)} ms; click to play at ${report.promptMs} ms (${report.promptMs <= 4000 ? 'within' : 'OVER'} 4 s)`);
    // The spec's measure: navigation to the click-to-play prompt.
    if (!(report.promptMs <= 4000)) process.exitCode = 1;
    if (print) console.log(`fingerprint: ${print}`);
  }
} finally {
  await browser.close();
  await server.close();
}
