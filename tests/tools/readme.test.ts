import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The repository's front page (the showcase spec's §6): it leads with the web game, and what it links
// to is there.
const README = readFileSync('README.md', 'utf8');

describe('the README', () => {
  it('leads with the web game, and every link it holds exists', () => {
    // Before the Python reference: what runs it, and how to play.
    const web = README.slice(0, README.indexOf('## Python reference'));
    expect(README.indexOf('## Python reference')).toBeGreaterThan(0);
    for (const words of ['WebGPU', 'Chrome', 'Edge 113', 'Safari 26', '## Controls', 'Move', 'Fire', 'Reload', 'Pause']) expect(web, words).toContain(words);
    // Where to play it: the site the Pages workflow publishes.
    expect(web.slice(web.indexOf('## Play'))).toContain('](https://lordjord78.github.io/Voxel-Trench-Warfare/)');
    // Relative links (not the web's, not a page's anchors) name files in the repository.
    const links = [...README.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^(https?:|mailto:|#)/.test(l));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(decodeURIComponent(link.split('#')[0])), link).toBe(true);
  });
});
