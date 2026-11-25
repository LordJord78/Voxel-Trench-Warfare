import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoicePlan } from '../../src/audio/plan';
import { playVoice, reportShape, type ReportShape } from '../../src/audio/voices';
import { loadTunables } from '../../src/core/tunables';
import { Biquad, BufferSource, FakeContext, fakeBuffer, FakeParam, Gain, install, madeOf, Oscillator } from '../support/fake-web-audio';

// A report as WebAudio is asked to make it (audio/voices.ts; the shots spec's §6), on a stand-in for
// WebAudio whose AudioParams refuse what a browser's refuse: its four layers (a click, a body, a crack
// and the action), their filters and their curves; a report at no gain plays and never throws; and each
// shot's body is its own, its pitch and its level drawn about its gun's.
const tun = loadTunables();
const shape = reportShape(tun);
const ctx = new FakeContext() as unknown as BaseAudioContext;
const noise = fakeBuffer(1, 96000, 48000) as unknown as AudioBuffer;
const out = new Gain(null) as unknown as AudioNode;

/** A report of the player's own, `gain` loud, its body at `bodyHz`. */
const fired = (gain: number, bodyHz = 140, suppressed = false): VoicePlan => ({ kind: 'report', at: [0.1, -0.1, -0.6], delayS: 0, gain, lowpassHz: 18000, bodyHz, suppressed, send: 0.35 });
/** Play `v` at `when` on the stand-in, with `s` its report shape. */
const play = (v: VoicePlan, when = 1, s: ReportShape = shape) => playVoice(ctx, out, noise, v, when, s, null);
/** The body: the report's one oscillator, and the gain that shapes it. */
const body = () => {
  const [osc] = madeOf('Oscillator') as Oscillator[];
  return { osc, shape: osc.outs[0] as Gain };
};

beforeEach(() => install());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a report made', () => {
  it("the stand-in refuses what a browser refuses: an exponential ramp to 0 throws a RangeError", () => {
    expect(() => new FakeParam(1).exponentialRampToValueAtTime(0, 1)).toThrow(RangeError);
    expect(() => new FakeParam(1).exponentialRampToValueAtTime(1e-4, 1)).not.toThrow();
  });

  it('at no gain plays, and never throws: a layer that falls to a share of a peak of 0 falls to nothing in a line (a report_gain of 0 would stop the game)', () => {
    expect(() => play(fired(0))).not.toThrow();
    expect(() => play(fired(0, 110, true))).not.toThrow();
    // Each layer's shape still rises and falls to nothing, in lines, as it was asked.
    const shapes = (madeOf('Gain') as Gain[]).filter((g) => g.gain.calls.length > 0);
    expect(shapes.length).toBeGreaterThanOrEqual(8);
    for (const g of shapes) expect(g.gain.calls.at(-1)?.[1]).toBeLessThanOrEqual(1e-4);
  });

  it('at any gain over 0 keeps its curves: the body rises in 2 ms, falls exponentially to a tenth of its peak by 60 ms, then to nothing in 4 ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    play(fired(0.8, 140), 1);
    const { shape: g } = body();
    const peak = 0.45 * 0.8;
    expect(g.gain.calls).toEqual([
      ['set', 0, 1],
      ['linear', peak, 1 + 0.002],
      ['exponential', peak * 0.1, 1 + 0.06],
      ['linear', 0, 1 + 0.06 + 0.004],
    ]);
  });

  it('its click takes no filter (no allpass); its crack and its action each pass two highpasses and two lowpasses at their band, the same options every report', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    play(fired(1));
    const first = madeOf('Biquad') as Biquad[];
    // The voice's own lowpass for its distance, then the layers' filters.
    expect(first.map((b) => [b.type, b.frequency.value])).toEqual([
      ['lowpass', 18000],
      ['highpass', 1500], ['highpass', 1500], ['lowpass', 4000], ['lowpass', 4000],
      ['highpass', 3000], ['highpass', 3000], ['lowpass', 6000], ['lowpass', 6000],
    ]);
    // The click's noise goes straight to its shape: the first source, into a gain.
    const [click] = madeOf('BufferSource') as BufferSource[];
    expect(click.outs[0]).toBeInstanceOf(Gain);
    // A second report's band filters are made from the same option objects: none made a report.
    const before = first.length;
    play(fired(1));
    const second = (madeOf('Biquad') as Biquad[]).slice(before);
    expect(second.slice(1).map((b) => b.given)).toEqual(first.slice(1).map((b) => b.given));
    for (let k = 1; k < first.length; k++) expect(second[k].given, `filter ${k}`).toBe(first[k].given);
  });

  it("suppressed, its click and body pass a lowpass at the shape's suppressedHz into a gain at its suppressedBlast ([attachment.suppressor]); its crack and action are whole", () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    play(fired(1, 110, true), 1, { ...shape, suppressedHz: 700, suppressedBlast: 0.4 });
    const [, blast] = madeOf('Biquad') as Biquad[];
    expect([blast.type, blast.frequency.value]).toEqual(['lowpass', 700]);
    expect((blast.outs[0] as Gain).gain.value).toBe(0.4);
    // The body goes through it; the crack's filters do not.
    expect(body().shape.outs[0]).toBe(blast);
  });
});

describe("a report's body, each shot its own (the machine-gun effect)", () => {
  it('its pitch drawn within 3% of its gun\'s, and its peak within 1 dB, from Math.random (seeded in the renders)', () => {
    const at = (r: number) => {
      install();
      vi.spyOn(Math, 'random').mockReturnValue(r);
      play(fired(0.8, 140), 1);
      const { osc, shape: g } = body();
      vi.restoreAllMocks();
      return { from: osc.frequency.calls[0][1], to: osc.frequency.calls[1][1], peak: g.gain.calls[1][1] };
    };
    const low = at(0);
    const mid = at(0.5);
    const high = at(1 - 1e-12);
    expect(mid.from).toBeCloseTo(140, 9);
    expect(mid.peak).toBeCloseTo(0.45 * 0.8, 12);
    expect(low.from).toBeCloseTo(140 * 0.97, 9);
    expect(high.from).toBeCloseTo(140 * 1.03, 6);
    expect(low.peak).toBeCloseTo(0.45 * 0.8 * 10 ** (-1 / 20), 9);
    expect(high.peak).toBeCloseTo(0.45 * 0.8 * 10 ** (1 / 20), 6);
    // It still falls a third, whatever its pitch.
    for (const b of [low, mid, high]) expect(b.to / b.from).toBeCloseTo(2 / 3, 9);
  });

  it('only the body is drawn: the click, crack and action peak at their shares of the gain whatever Math.random gives', () => {
    const peaks = (r: number) => {
      install();
      vi.spyOn(Math, 'random').mockReturnValue(r);
      play(fired(1), 1);
      const own = body().shape;
      vi.restoreAllMocks();
      return (madeOf('Gain') as Gain[]).filter((g) => g !== own && g.gain.calls.length > 0).map((g) => g.gain.calls[1][1]);
    };
    expect(peaks(0)).toEqual([0.35, 1.1, 0.55]);
    expect(peaks(1 - 1e-12)).toEqual([0.35, 1.1, 0.55]);
  });

  it('two shots in a row differ', () => {
    const drawn = () => {
      install();
      play(fired(1, 140), 1);
      return body().osc.frequency.calls[0][1];
    };
    const a = drawn();
    const b = drawn();
    expect(a).not.toBe(b);
    for (const f of [a, b]) expect(Math.abs(f / 140 - 1)).toBeLessThanOrEqual(0.03);
  });
});
