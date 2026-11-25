import { describe, expect, it } from 'vitest';
import { fallbackLine, fallbackReason, PHONE } from '../../src/app/fallback';

// Where the game cannot run (the showcase spec's §3): why the page shows the video instead.
describe('the fallback', () => {
  it('the page falls back without WebGPU, without an adapter, on a failure to start, and on touch alone', () => {
    const desktop = { gpu: true, coarse: false, fine: true };
    expect(fallbackReason({ ...desktop, gpu: false })).toBe('no-webgpu');
    expect(fallbackReason({ ...desktop, adapter: false })).toBe('no-adapter');
    expect(fallbackReason({ ...desktop, adapter: true, failed: true })).toBe('failed');
    expect(fallbackReason({ gpu: true, coarse: true, fine: false })).toBe('touch');
    // A tablet with a mouse or trackpad plays; so does a desktop, asked or not.
    expect(fallbackReason({ gpu: true, coarse: true, fine: true })).toBeNull();
    expect(fallbackReason(desktop)).toBeNull();
    expect(fallbackReason({ ...desktop, adapter: true })).toBeNull();
    // A phone without WebGPU is told it is played on a computer (below).
    expect(fallbackReason({ gpu: false, coarse: true, fine: false })).toBe('phone');
  });

  it('says what would run it, or how it is played, without repeating the failure', () => {
    // Without WebGPU the failure itself names the browsers: the line under it does not again.
    expect(fallbackLine('no-webgpu')).toBe('Here it is in motion.');
    for (const reason of ['no-adapter', 'failed'] as const) expect(fallbackLine(reason)).toMatch(/Chrome or Edge, or Safari 26/);
    expect(fallbackLine('touch')).toMatch(/keyboard and mouse/);
  });

  const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

  it("tells Chrome or Edge without an adapter to turn on hardware acceleration, or update the graphics driver; other browsers what would run it", () => {
    for (const ua of [CHROME, EDGE]) expect(fallbackLine('no-adapter', ua)).toBe("Here it is in motion. Turn on hardware acceleration in your browser's settings, or update your graphics driver.");
    expect(fallbackLine('no-adapter', SAFARI)).toMatch(/Chrome or Edge, or Safari 26/);
    // Without WebGPU, today's line, in any browser.
    expect(fallbackLine('no-webgpu', CHROME)).toBe('Here it is in motion.');
  });

  it('tells a phone or tablet, with WebGPU or without, that TRENCHLINE is played with a keyboard and mouse on a computer', () => {
    // A phone without WebGPU is a phone first: no browser would make it a computer.
    expect(fallbackReason({ gpu: false, coarse: true, fine: false })).toBe('phone');
    expect(fallbackReason({ gpu: false, coarse: true, fine: true })).toBe('no-webgpu');
    expect(PHONE).toBe('TRENCHLINE is played with a keyboard and mouse on a computer.');
    expect(fallbackLine('touch')).toBe(`${PHONE} Here it is in motion.`);
    expect(fallbackLine('phone')).toBe('Here it is in motion.');
  });
});
