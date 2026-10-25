import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The Pages workflow (the showcase spec's §1), read as text: it tests, builds and deploys the site on
// a push to main and by hand; the GPU suites stay local, as they need a GPU.
const FILE = '.github/workflows/pages.yml';

describe('the Pages workflow', () => {
  it('tests, builds and deploys on a push to main, and by hand', () => {
    expect(existsSync(FILE)).toBe(true);
    const yml = readFileSync(FILE, 'utf8');
    // Its triggers.
    expect(yml).toMatch(/push:\s*\n\s+branches:\s*\[\s*main\s*\]/);
    expect(yml).toMatch(/workflow_dispatch:/);
    // What Pages asks for, one deploy at a time.
    expect(yml).toMatch(/permissions:[\s\S]*pages:\s*write/);
    expect(yml).toMatch(/permissions:[\s\S]*id-token:\s*write/);
    expect(yml).toMatch(/concurrency:\s*\n\s+group:/);
    // Node 22 from the lockfile; the unit tests and the type check before the build.
    expect(yml).toMatch(/node-version:\s*22/);
    expect(yml).toMatch(/npm ci/);
    const tests = yml.indexOf('npx vitest run');
    const types = yml.indexOf('npx tsc --noEmit -p .');
    const build = yml.indexOf('npm run build');
    expect(tests).toBeGreaterThan(0);
    expect(types).toBeGreaterThan(tests);
    expect(build).toBeGreaterThan(types);
    // The build told the site's address, from the Pages configuration.
    expect(yml).toMatch(/actions\/configure-pages@v\d+/);
    expect(yml).toMatch(/VITE_SITE_URL:\s*\$\{\{\s*steps\.\w+\.outputs\.base_url\s*\}\}/);
    // The build's dist uploaded, and deployed by a second job that needs the first.
    expect(yml).toMatch(/actions\/upload-pages-artifact@v\d+[\s\S]*path:\s*\.?\/?dist/);
    expect(yml).toMatch(/deploy:[\s\S]*needs:\s*build[\s\S]*actions\/deploy-pages@v\d+/);
  });
});
