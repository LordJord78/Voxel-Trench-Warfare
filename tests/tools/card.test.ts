import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../support/image-size';

// The portfolio's card (the showcase spec's §5): the user's site's own markup and classes, ready to
// paste, with its square thumbnail and a note on how.
describe("the portfolio's card", () => {
  it("is the portfolio's markup, with the square thumbnail and the links to the code and the site", () => {
    const html = readFileSync('showcase/portfolio/card.html', 'utf8');
    expect(html).toMatch(/<div class="details-container color-container">/);
    expect(html).toMatch(/<div class="article-container">\s*<img src="\.\/assets\/trenchline\.webp" alt="[^"]+" class="project-img">/);
    expect(html).toMatch(/<h2 class="experience-sub-title project-title">TRENCHLINE<\/h2>/);
    expect(html).toContain(`<button class="btn btn-color-2 project-btn" onclick="location.href='https://github.com/LordJord78/Voxel-Trench-Warfare'">Github</button>`);
    expect(html).toContain(`<button class="btn btn-color-2 project-btn" onclick="location.href='https://lordjord78.github.io/Voxel-Trench-Warfare/'">Live Demo</button>`);
    const thumbnail = 'showcase/portfolio/trenchline.webp';
    expect(imageSize(readFileSync(thumbnail))).toEqual({ width: 1080, height: 1080, type: 'webp' });
    expect(statSync(thumbnail).size).toBeLessThanOrEqual(120 * 1024);
    // How: the image into the site's assets/, the card first among its projects.
    const readme = readFileSync('showcase/portfolio/README.md', 'utf8');
    expect(readme).toMatch(/assets\//);
    expect(readme).toMatch(/id="projects"/);
  });
});
