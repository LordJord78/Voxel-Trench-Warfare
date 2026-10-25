import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteHtml } from '../../tools/vite-plugin-site';

// The page's head (the showcase spec's §2): what a shared link previews, and the site's address where
// a preview needs it whole.
const HTML = readFileSync('index.html', 'utf8');
const meta = (attr: 'name' | 'property', key: string) => HTML.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];

describe("the page's head", () => {
  it('describes the game for link previews', () => {
    expect(HTML).toMatch(/<title>TRENCHLINE<\/title>/);
    expect(meta('name', 'description')).toMatch(/voxel/i);
    expect(meta('property', 'og:title')).toBe('TRENCHLINE');
    expect(meta('property', 'og:description')).toBe(meta('name', 'description'));
    expect(meta('property', 'og:type')).toBe('website');
    expect(meta('property', 'og:image')).toBe('%SITE%stills/og.jpg');
    expect(meta('property', 'og:image:width')).toBe('1200');
    expect(meta('property', 'og:image:height')).toBe('630');
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
    expect(meta('name', 'twitter:image')).toBe('%SITE%stills/og.jpg');
    expect(meta('name', 'theme-color')).toBe('#17141f');
    expect(HTML).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\.\/favicon\.svg" \/>/);
    expect(readFileSync('public/favicon.svg', 'utf8')).toMatch(/^<svg [^>]*viewBox=/);
  });

  it("the preview image's address is whole when the site's is known, and relative otherwise", () => {
    const html = '<meta property="og:image" content="%SITE%stills/og.jpg" /><meta name="twitter:image" content="%SITE%stills/og.jpg" />';
    expect(siteHtml(html, 'https://lordjord78.github.io/Voxel-Trench-Warfare')).toBe(
      '<meta property="og:image" content="https://lordjord78.github.io/Voxel-Trench-Warfare/stills/og.jpg" /><meta name="twitter:image" content="https://lordjord78.github.io/Voxel-Trench-Warfare/stills/og.jpg" />',
    );
    expect(siteHtml(html, 'https://example.org/trenchline/')).toContain('content="https://example.org/trenchline/stills/og.jpg"');
    expect(siteHtml(html, undefined)).toBe('<meta property="og:image" content="./stills/og.jpg" /><meta name="twitter:image" content="./stills/og.jpg" />');
    expect(siteHtml(html, '')).toContain('content="./stills/og.jpg"');
  });
});
