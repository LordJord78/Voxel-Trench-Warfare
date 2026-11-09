import { describe, expect, it } from 'vitest';
import { bandShare, checkSound, dbfs, measure, PEAK_DB, SILENT_DB, table, wav } from '../../tools/lib/sound-measures.mjs';

// The sounds' proof (tools/render-sounds.mjs, npm run sounds; the shots spec's §6): each voice rendered
// to WAV, its peak held between −30 and −1 dBFS, nothing silent, and the gush's energy mostly in
// 400 Hz–2 kHz. Read on synthetic signals.

const RATE = 48000;

/** `seconds` of `f(t)` (t in seconds) at RATE. */
function signal(seconds: number, f: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = f(i / RATE);
  return out;
}

const sine = (hz: number, amp = 1) => (t: number) => amp * Math.sin(2 * Math.PI * hz * t);

/** A little-endian reader over a WAV's bytes. */
function reader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    text: (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n)),
    u32: (at: number) => view.getUint32(at, true),
    u16: (at: number) => view.getUint16(at, true),
    i16: (at: number) => view.getInt16(at, true),
  };
}

describe("the sounds' measures", () => {
  it('a WAV of mono 16-bit PCM at the rate: RIFF, its fmt and data chunks, each sample scaled to 32767 and clipped at full scale', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.7, -2.2, 0.25]);
    const bytes = wav(samples, RATE);
    const r = reader(bytes);
    expect(bytes.length).toBe(44 + samples.length * 2);
    expect([r.text(0, 4), r.u32(4), r.text(8, 4)]).toEqual(['RIFF', bytes.length - 8, 'WAVE']);
    // fmt: PCM, one channel, the rate, its bytes a second, two bytes a frame, 16 bits.
    expect([r.text(12, 4), r.u32(16), r.u16(20), r.u16(22), r.u32(24), r.u32(28), r.u16(32), r.u16(34)]).toEqual(['fmt ', 16, 1, 1, RATE, RATE * 2, 2, 16]);
    expect([r.text(36, 4), r.u32(40)]).toEqual(['data', samples.length * 2]);
    const read = Array.from(samples, (_, i) => r.i16(44 + i * 2));
    expect(read).toEqual([0, 16384, -16384, 32767, -32767, 32767, -32767, 8192]);
  });

  it('dBFS: full scale is 0, half is about −6, silence is −Infinity', () => {
    expect(dbfs(1)).toBe(0);
    expect(dbfs(0.5)).toBeCloseTo(-6.0206, 3);
    expect(dbfs(0.1)).toBeCloseTo(-20, 9);
    expect(dbfs(0)).toBe(-Infinity);
  });

  it("a signal's peak and RMS in dBFS: a sine at half scale peaks at −6 and its RMS is 3 dB under", () => {
    const m = measure(signal(0.5, sine(1000, 0.5)), RATE);
    expect(m.peakDb).toBeCloseTo(-6.02, 1);
    expect(m.rmsDb).toBeCloseTo(-6.02 - 3.01, 1);
    // The loudest sample, either way: a negative spike counts.
    const spike = signal(0.1, () => 0.01);
    spike[100] = -0.9;
    expect(measure(spike, RATE).peakDb).toBeCloseTo(dbfs(0.9), 5);
    // Silence.
    const quiet = measure(new Float32Array(4800), RATE);
    expect([quiet.peakDb, quiet.rmsDb, quiet.bandShare]).toEqual([-Infinity, -Infinity, 0]);
  });

  it("the share of a signal's energy in a band, by an FFT: all of a sine inside it, none of one outside, half of two equal sines either side of its edge", () => {
    expect(bandShare(signal(0.5, sine(1000)), RATE, 400, 2000)).toBeGreaterThan(0.99);
    expect(bandShare(signal(0.5, sine(100)), RATE, 400, 2000)).toBeLessThan(0.01);
    expect(bandShare(signal(0.5, sine(5000)), RATE, 400, 2000)).toBeLessThan(0.01);
    expect(bandShare(signal(0.5, (t) => sine(1000)(t) + sine(5000)(t)), RATE, 400, 2000)).toBeCloseTo(0.5, 2);
    // White noise spreads evenly to the Nyquist: the band's width over 24 kHz of it.
    let seed = 7;
    const noise = signal(1, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 31 - 1;
    });
    expect(bandShare(noise, RATE, 400, 2000)).toBeCloseTo(1600 / 24000, 2);
    // Wherever in the file the energy lies: a voice's thud at its start counts as much as a chime in its
    // middle (no window over the whole file to weigh its middle over its ends).
    const early = signal(0.4, (t) => (t >= 0.01 && t < 0.05 ? sine(100)(t) : t >= 0.2 && t < 0.24 ? sine(1000)(t) : 0));
    expect(bandShare(early, RATE, 400, 2000)).toBeCloseTo(0.5, 1);
    // measure() reads it for 400 Hz–2 kHz unless told another band.
    expect(measure(signal(0.5, sine(1000)), RATE).bandShare).toBeGreaterThan(0.99);
    expect(measure(signal(0.5, sine(1000)), RATE, [2000, 8000]).bandShare).toBeLessThan(0.01);
  });

  it('a file passes with its peak between −30 and −1 dBFS; over −1 it may clip, under −30 it is too quiet, and nothing at all is silent', () => {
    expect(PEAK_DB).toEqual([-30, -1]);
    expect(SILENT_DB).toBe(-90);
    const ok = { peakDb: -6, rmsDb: -18, bandShare: 0.2 };
    expect(checkSound(ok)).toEqual([]);
    expect(checkSound({ ...ok, peakDb: -1 })).toEqual([]);
    expect(checkSound({ ...ok, peakDb: -30 })).toEqual([]);
    expect(checkSound({ ...ok, peakDb: -0.4 })).toEqual(['its peak, -0.4 dBFS, is over -1 dBFS: it may clip']);
    expect(checkSound({ ...ok, peakDb: -34.26 })).toEqual(['its peak, -34.3 dBFS, is under -30 dBFS: too quiet']);
    expect(checkSound({ peakDb: -Infinity, rmsDb: -Infinity, bandShare: 0 })).toEqual(['it is silent']);
    expect(checkSound({ peakDb: -95, rmsDb: -110, bandShare: 0.1 })).toEqual(['it is silent']);
  });

  it("a voice held to a band (the gush's 400 Hz–2 kHz) passes with more than the share asked of its energy in it", () => {
    const ok = { peakDb: -6, rmsDb: -18, bandShare: 0.62 };
    expect(checkSound(ok, { band: [400, 2000], share: 0.5 })).toEqual([]);
    expect(checkSound({ ...ok, bandShare: 0.5 }, { band: [400, 2000], share: 0.5 })).toEqual(['only 50% of its energy is in 400-2000 Hz, not over 50%']);
    expect(checkSound({ ...ok, peakDb: 0.2, bandShare: 0.31 }, { band: [400, 2000], share: 0.5 })).toEqual(['its peak, 0.2 dBFS, is over -1 dBFS: it may clip', 'only 31% of its energy is in 400-2000 Hz, not over 50%']);
  });

  it('a table of each file: its name, peak, RMS and band share, and what failed of it', () => {
    const out = table([
      { name: 'hit', peakDb: -3.14159, rmsDb: -17.5, bandShare: 0.123, failures: [] },
      { name: 'ding-85m', peakDb: -38.04, rmsDb: -52.25, bandShare: 0.4, failures: ['its peak, -38.0 dBFS, is under -30 dBFS: too quiet'], gated: false },
      { name: 'gush', peakDb: -Infinity, rmsDb: -Infinity, bandShare: 0, failures: ['it is silent'] },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^name\s+peak dBFS\s+RMS dBFS\s+400-2000 Hz\s+$/);
    expect(lines[1]).toMatch(/^hit\s+-3\.1\s+-17\.5\s+12%\s+ok$/);
    expect(lines[2]).toMatch(/^ding-85m\s+-38\.0\s+-52\.3\s+40%\s+\(reported\) its peak, -38\.0 dBFS, is under -30 dBFS: too quiet$/);
    expect(lines[3]).toMatch(/^gush\s+-inf\s+-inf\s+0%\s+FAIL it is silent$/);
  });
});
