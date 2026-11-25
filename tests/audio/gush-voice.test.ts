import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoicePlan } from '../../src/audio/plan';
import { playVoice, reportShape } from '../../src/audio/voices';
import { loadTunables } from '../../src/core/tunables';
import { Biquad, FakeContext, fakeBuffer, Gain, install, madeOf } from '../support/fake-web-audio';

// A headshot's wet gush as WebAudio is asked to make it (audio/voices.ts), on the stand-in for WebAudio:
// its band of noise sweeping down at the voice's gain, and under it a splat of noise below 400 Hz at
// half of that. Settled, the master compressor no longer takes the splat's start, so at 0.7 of the band
// it outweighed the band once the gush was turned down under the gun (npm run sounds' mix gate).
const shape = reportShape(loadTunables());
const ctx = new FakeContext() as unknown as BaseAudioContext;
const noise = fakeBuffer(1, 96000, 48000) as unknown as AudioBuffer;
const out = new Gain(null) as unknown as AudioNode;

/** The shooter's gush, `gain` loud, at the ear. */
const gush = (gain: number): VoicePlan => ({ kind: 'gush', at: [0, 0, 0], delayS: 0, gain, lowpassHz: 18000 });

beforeEach(() => install());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a headshot's gush made", () => {
  it('its splat under 400 Hz peaks at half its band: the band rises to the gain over 15 ms, the splat to 0.5 × it over 2 ms and away over 80 ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    playVoice(ctx, out, noise, gush(2.8), 1, shape, null);
    const filters = madeOf('Biquad') as Biquad[];
    const band = filters.find((b) => b.type === 'bandpass');
    const splat = filters.find((b) => b.type === 'lowpass' && b.frequency.value === 400);
    expect(band, 'the band').toBeDefined();
    expect(splat, 'the splat').toBeDefined();
    // The band: its bandpass, then the flutter, then its shape.
    const bandShape = (band!.outs[0] as Gain).outs[0] as Gain;
    expect(bandShape.gain.calls.slice(0, 2)).toEqual([
      ['set', 0, 1],
      ['linear', 2.8, 1 + 0.015],
    ]);
    // The splat: its lowpass, then its shape.
    const splatShape = splat!.outs[0] as Gain;
    expect(splatShape.gain.calls).toEqual([
      ['set', 0, 1],
      ['linear', 0.5 * 2.8, 1 + 0.002],
      ['exponential', 1e-4, 1 + 0.002 + 0.08],
    ]);
  });
});
