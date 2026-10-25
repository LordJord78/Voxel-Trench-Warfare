import { describe, expect, it } from 'vitest';
import { fallbackLine, fallbackReason } from '../../src/app/fallback';

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
    // A phone without WebGPU is told what would run it.
    expect(fallbackReason({ gpu: false, coarse: true, fine: false })).toBe('no-webgpu');
  });

  it('says what would run it, or how it is played, without repeating the failure', () => {
    // Without WebGPU the failure itself names the browsers: the line under it does not again.
    expect(fallbackLine('no-webgpu')).toBe('Here it is in motion.');
    for (const reason of ['no-adapter', 'failed'] as const) expect(fallbackLine(reason)).toMatch(/Chrome or Edge, or Safari 26/);
    expect(fallbackLine('touch')).toMatch(/keyboard and mouse/);
  });
});
