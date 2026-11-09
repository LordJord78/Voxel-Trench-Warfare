import { describe, expect, it } from 'vitest';
import { BAND, bandShare, checkSound, dbfs, LOUDEST_S, loudest, loudestUnder, measure, ONSET_DB, onset, PEAK_DB, ruleEnergyDb, ruleShare, SILENT_DB, SMALL_SPEAKER_HZ, table, wav } from '../../tools/lib/sound-measures.mjs';

// The sounds' proof (tools/render-sounds.mjs, npm run sounds; the shots spec's §6, G3's Task 5): each
// voice rendered to a stereo WAV, its peak held between −30 and −1 dBFS, nothing silent; a voice held
// to a band, to a small speaker (its share over 400 Hz), to a floor, to another render's loudest
// 50 ms, or over another render's energy in a band (a headshot's kill over the same without its
// gush). Read on synthetic signals, both ears together.

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
    // A list of one channel is the same file.
    expect(wav([samples], RATE)).toEqual(bytes);
  });

  it('a stereo WAV: two channels, four bytes a frame, the left and right samples interleaved', () => {
    const left = Float32Array.from([0, 0.5, 1, -2]);
    const right = Float32Array.from([0.25, -0.5, 0, 0.75]);
    const bytes = wav([left, right], RATE);
    const r = reader(bytes);
    expect(bytes.length).toBe(44 + 4 * 4);
    expect([r.u32(4), r.u16(20), r.u16(22), r.u32(24), r.u32(28), r.u16(32), r.u16(34)]).toEqual([bytes.length - 8, 1, 2, RATE, RATE * 4, 4, 16]);
    expect([r.text(36, 4), r.u32(40)]).toEqual(['data', 16]);
    expect(Array.from({ length: 8 }, (_, i) => r.i16(44 + i * 2))).toEqual([0, 8192, 16384, -16384, 32767, 0, -32767, 24575]);
    expect(() => wav([left, right.subarray(1)], RATE)).toThrow(/length/);
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
    expect([quiet.peakDb, quiet.rmsDb, quiet.loudestDb, quiet.bandShare, quiet.highShare]).toEqual([-Infinity, -Infinity, -Infinity, 0, 0]);
  });

  it('both ears together: the peak the louder ear\'s, the RMS over both, a list of one channel the same as the channel', () => {
    const left = signal(0.5, sine(1000, 0.5));
    const right = signal(0.5, sine(1000, 0.25));
    const m = measure([left, right], RATE);
    expect(m.peakDb).toBeCloseTo(dbfs(0.5), 2);
    // Mean power (0.125 + 0.03125) / 2.
    expect(m.rmsDb).toBeCloseTo(10 * Math.log10((0.125 + 0.03125) / 2), 2);
    expect(measure([left], RATE)).toEqual(measure(left, RATE));
    // Either ear may be the louder.
    expect(measure([right, left], RATE).peakDb).toBeCloseTo(dbfs(0.5), 2);
  });

  it("the share of a signal's energy in a band, by an FFT: all of a sine inside it, none of one outside, half of two equal sines either side of its edge", () => {
    expect(BAND).toEqual([400, 2000]);
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
    // Both ears' energy summed: a chime in one ear and a thud as loud in the other is half in the band.
    expect(bandShare([signal(0.5, sine(1000)), signal(0.5, sine(100))], RATE, 400, 2000)).toBeCloseTo(0.5, 2);
    // measure() reads it for BAND, always.
    expect(measure(signal(0.5, sine(1000)), RATE).bandShare).toBeGreaterThan(0.99);
    expect(measure(signal(0.5, sine(5000)), RATE).bandShare).toBeLessThan(0.01);
  });

  it("the small speaker's share: a voice's energy over 400 Hz, which a laptop plays, both ears together", () => {
    expect(SMALL_SPEAKER_HZ).toBe(400);
    expect(measure(signal(0.5, sine(100)), RATE).highShare).toBeLessThan(0.01);
    expect(measure(signal(0.5, sine(5000)), RATE).highShare).toBeGreaterThan(0.99);
    // A thud with a chime a quarter as loud in power (half the amplitude): a fifth over 400 Hz.
    expect(measure(signal(0.5, (t) => sine(80)(t) + sine(1500, 0.5)(t)), RATE).highShare).toBeCloseTo(0.2, 2);
    expect(measure([signal(0.5, sine(80)), signal(0.5, sine(9000))], RATE).highShare).toBeCloseTo(0.5, 2);
  });

  it('the loudest 50 ms: the RMS of the loudest window, both ears together, and where it starts', () => {
    expect(LOUDEST_S).toBe(0.05);
    // 50 ms of a half-scale sine 0.2 s in, quiet elsewhere.
    const burst = signal(0.5, (t) => (t >= 0.2 && t < 0.25 ? sine(1000, 0.5)(t) : 0.001 * sine(1000)(t)));
    const l = loudest(burst, RATE);
    expect(l.db).toBeCloseTo(dbfs(0.5) - 3.01, 1);
    expect(l.atS).toBeCloseTo(0.2, 2);
    expect(measure(burst, RATE).loudestDb).toBeCloseTo(l.db, 9);
    expect(measure(burst, RATE).loudestAtS).toBeCloseTo(l.atS, 9);
    // A thud of 30 ms at full scale is louder over 50 ms than its peak's 3 dB under: 30/50 of its power.
    const thud = signal(0.3, (t) => (t < 0.03 ? sine(100)(t) : 0));
    expect(loudest(thud, RATE).db).toBeCloseTo(10 * Math.log10(0.5 * 0.6), 1);
    // Both ears: the window's mean power over them.
    expect(loudest([burst, new Float32Array(burst.length)], RATE).db).toBeCloseTo(dbfs(0.5) - 3.01 - 3.01, 1);
    // A file shorter than the window is read whole.
    expect(loudest(signal(0.02, sine(1000, 0.5)), RATE).db).toBeCloseTo(dbfs(0.5) - 3.01, 1);
    expect(loudest(new Float32Array(100), RATE).db).toBe(-Infinity);
  });

  it("a voice's body: its loudest 50 ms under 400 Hz alone, a kill's thud apart from its louder chime, both ears together", () => {
    // A thud of 6 cycles at 60 Hz, a fifth of full scale, from 10 ms; from 70 ms a chime at 1 kHz three times as loud, for 0.2 s.
    const at = (t: number, from: number, s: number, hz: number, amp: number) => (t >= from && t < from + s ? amp * Math.sin(2 * Math.PI * hz * (t - from)) : 0);
    const kill = signal(0.4, (t) => at(t, 0.01, 0.1, 60, 0.2) + at(t, 0.07, 0.2, 1000, 0.6));
    const m = measure(kill, RATE);
    // The whole voice's loudest 50 ms is the chime's; under 400 Hz, it is the thud's alone.
    expect(m.loudestDb).toBeGreaterThan(dbfs(0.6) - 3.1);
    expect(m.lowLoudestDb).toBeCloseTo(dbfs(0.2) - 3.01, 1);
    expect(loudestUnder(kill, RATE, SMALL_SPEAKER_HZ).db).toBeCloseTo(m.lowLoudestDb, 9);
    expect(loudestUnder(kill, RATE, SMALL_SPEAKER_HZ).atS).toBeGreaterThan(0.005);
    expect(loudestUnder(kill, RATE, SMALL_SPEAKER_HZ).atS).toBeLessThan(0.065);
    // Both ears: the window's mean power over them.
    expect(measure([kill, new Float32Array(kill.length)], RATE).lowLoudestDb).toBeCloseTo(dbfs(0.2) - 3.01 - 3.01, 1);
    // A chime alone has next to nothing under 400 Hz (its abrupt edges leak a little: 30 dB under it); silence nothing at all.
    const chime = measure(signal(0.4, (t) => at(t, 0.07, 0.2, 1000, 0.6)), RATE);
    expect(chime.lowLoudestDb).toBeLessThan(chime.loudestDb - 25);
    expect(measure(new Float32Array(4800), RATE).lowLoudestDb).toBe(-Infinity);
  });

  it("a rule's own band, measured apart from the table's: over the whole file, or its first seconds from its onset", () => {
    expect(ONSET_DB).toBe(-60);
    // A chime for 0.3 s after 22 ms of silence (a render's lead, the compressor's look-ahead and the HRTF's delay), then a thud as loud for 0.3 s.
    const lead = 0.022;
    const s = signal(0.65, (t) => (t >= lead && t < lead + 0.3 ? sine(1000)(t) : t >= lead + 0.3 && t < lead + 0.6 ? sine(100)(t) : 0));
    expect(onset(s, RATE)).toBeCloseTo(lead, 3);
    expect(ruleShare(s, RATE, { hz: [400, 2000], share: 0.5 })).toBeCloseTo(0.5, 1);
    expect(ruleShare(s, RATE, { hz: [400, 2000], share: 0.5, firstS: 0.3 })).toBeGreaterThan(0.95);
    expect(ruleShare(s, RATE, { hz: [50, 200], share: 0.5, firstS: 0.3 })).toBeLessThan(0.05);
    // Either ear's onset, the earlier: a sound in the right ear first starts the window there.
    const late = signal(0.65, (t) => (t >= 0.1 && t < 0.4 ? sine(100)(t) : 0));
    expect(onset([late, s], RATE)).toBeCloseTo(lead, 3);
    expect(ruleShare([s, s], RATE, { hz: [400, 2000], share: 0.5, firstS: 0.3 })).toBeCloseTo(ruleShare(s, RATE, { hz: [400, 2000], share: 0.5, firstS: 0.3 }), 9);
    // Under −60 dBFS is not yet the sound; silence has no onset (and no share).
    const faint = signal(0.65, (t) => (t < lead ? sine(1000, 0.0005)(t) : sine(1000)(t)));
    expect(onset(faint, RATE)).toBeCloseTo(lead, 3);
    expect(onset(new Float32Array(480), RATE)).toBe(null);
    expect(ruleShare(new Float32Array(480), RATE, { hz: [400, 2000], share: 0.5, firstS: 0.3 })).toBe(0);
  });

  it("an `over` rule's own reading: a file's energy in a band (the sum of its squares there, both ears together), over its first seconds from its onset if asked, in dB", () => {
    const lead = 0.022;
    // A chime at full scale for 0.3 s after the lead, then a thud as loud for 0.3 s.
    const of = (amp: number) => signal(0.65, (t) => (t >= lead && t < lead + 0.3 ? sine(1000, amp)(t) : t >= lead + 0.3 && t < lead + 0.6 ? sine(100)(t) : 0));
    const first = { hz: [400, 2000] as [number, number], firstS: 0.3 };
    // 0.3 s of a full-scale sine: 14,400 samples of mean square 1/2, so 7,200: 38.6 dB.
    expect(ruleEnergyDb(of(1), RATE, first)).toBeCloseTo(10 * Math.log10(7200), 1);
    // Half as loud, 6 dB under; both ears, 3 dB over one; the thud after it is outside the band.
    expect(ruleEnergyDb(of(1), RATE, first) - ruleEnergyDb(of(0.5), RATE, first)).toBeCloseTo(20 * Math.log10(2), 2);
    expect(ruleEnergyDb([of(1), of(1)], RATE, first) - ruleEnergyDb(of(1), RATE, first)).toBeCloseTo(10 * Math.log10(2), 6);
    expect(ruleEnergyDb(of(1), RATE, { hz: [50, 200], firstS: 0.3 })).toBeLessThan(ruleEnergyDb(of(1), RATE, first) - 30);
    // Over the whole file, the thud's in its band.
    expect(ruleEnergyDb(of(1), RATE, { hz: [50, 200] })).toBeCloseTo(10 * Math.log10(7200), 1);
    // Silence: nothing.
    expect(ruleEnergyDb(new Float32Array(480), RATE, first)).toBe(-Infinity);
  });

  /** A file read, ok by every rule but those a test changes. */
  const read = (m: Partial<Parameters<typeof checkSound>[0]> = {}) => ({ peakDb: -6, rmsDb: -18, loudestDb: -12, loudestAtS: 0.01, lowLoudestDb: -20, bandShare: 0.2, highShare: 0.6, ...m });

  it('a file passes with its peak between −30 and −1 dBFS; over −1 it may clip, under −30 it is too quiet, and nothing at all is silent', () => {
    expect(PEAK_DB).toEqual([-30, -1]);
    expect(SILENT_DB).toBe(-90);
    expect(checkSound(read())).toEqual([]);
    expect(checkSound(read({ peakDb: -1 }))).toEqual([]);
    expect(checkSound(read({ peakDb: -30 }))).toEqual([]);
    expect(checkSound(read({ peakDb: -0.4 }))).toEqual(['its peak, -0.4 dBFS, is over -1 dBFS: it may clip']);
    expect(checkSound(read({ peakDb: -34.26 }))).toEqual(['its peak, -34.3 dBFS, is under -30 dBFS: too quiet']);
    expect(checkSound(read({ peakDb: -Infinity, rmsDb: -Infinity, bandShare: 0 }))).toEqual(['it is silent']);
    expect(checkSound(read({ peakDb: -95, rmsDb: -110, bandShare: 0.1 }), { high: 0.25 })).toEqual(['it is silent']);
  });

  it("a voice held to a band passes with at least its share there, read on the rule's own band; the share comes with the band, or is half", () => {
    const rule = { hz: [400, 2000] as [number, number], share: 0.55 };
    expect(checkSound(read({ ruleShare: 0.62 }), { band: rule })).toEqual([]);
    expect(checkSound(read({ ruleShare: 0.55 }), { band: rule })).toEqual([]);
    // The table's band column is not the rule's: a rule is read on its own measure.
    expect(checkSound(read({ bandShare: 0.9, ruleShare: 0.45 }), { band: rule })).toEqual(['only 45.0% of its energy is in 400-2000 Hz, not 55% or more']);
    expect(checkSound(read({ bandShare: 0.1, ruleShare: 0.6 }), { band: rule })).toEqual([]);
    expect(checkSound(read({ ruleShare: 0.549 }), { band: rule })).toEqual(['only 54.9% of its energy is in 400-2000 Hz, not 55% or more']);
    expect(checkSound(read({ peakDb: 0.2, ruleShare: 0.31 }), { band: rule })).toEqual(['its peak, 0.2 dBFS, is over -1 dBFS: it may clip', 'only 31.0% of its energy is in 400-2000 Hz, not 55% or more']);
    // Over its first seconds, said so.
    expect(checkSound(read({ ruleShare: 0.3 }), { band: { ...rule, share: 0.35, firstS: 0.3 } })).toEqual(['only 30.0% of its first 300 ms\'s energy is in 400-2000 Hz, not 35% or more']);
    // A band with no share asked is held to half: never "NaN%".
    expect(checkSound(read({ ruleShare: 0.4 }), { band: { hz: [400, 2000] } as never })).toEqual(['only 40.0% of its energy is in 400-2000 Hz, not 50% or more']);
    // Unmeasured is a failure, not a pass.
    expect(checkSound(read(), { band: rule })).toEqual(["its energy's share in 400-2000 Hz was not measured"]);
  });

  it("a voice held to the small speaker passes with at least its share over 400 Hz", () => {
    expect(checkSound(read({ highShare: 0.25 }), { high: 0.25 })).toEqual([]);
    expect(checkSound(read({ highShare: 0.031 }), { high: 0.25 })).toEqual(['only 3.1% of its energy is over 400 Hz, not 25% or more: a small speaker barely plays it']);
  });

  it('a voice held to a floor passes with its peak at it or over it', () => {
    expect(checkSound(read({ peakDb: -24 }), { floorDb: -24 })).toEqual([]);
    expect(checkSound(read({ peakDb: -27.36 }), { floorDb: -24 })).toEqual(['its peak, -27.4 dBFS, is under its floor of -24 dBFS']);
  });

  it("a voice held to another's level passes with its loudest 50 ms within so many dB of the other's, either way", () => {
    const near = { of: 'kill', withinDb: 3 };
    const kill = read({ loudestDb: -16.2 });
    expect(checkSound(read({ loudestDb: -18.9 }), { near }, { kill })).toEqual([]);
    expect(checkSound(read({ loudestDb: -13.5 }), { near }, { kill })).toEqual([]);
    expect(checkSound(read({ loudestDb: -27.2 }), { near }, { kill })).toEqual(["its loudest 50 ms, -27.2 dBFS, is 11.0 dB under kill's (-16.2 dBFS), not within 3 dB"]);
    expect(checkSound(read({ loudestDb: -12.0 }), { near }, { kill })).toEqual(["its loudest 50 ms, -12.0 dBFS, is 4.2 dB over kill's (-16.2 dBFS), not within 3 dB"]);
    expect(checkSound(read({ loudestDb: -18 }), { near }, {})).toEqual(["its level is held to kill's, which was not rendered"]);
  });

  it("a voice held to another's body (`low`) is read against the other's loudest 50 ms under 400 Hz alone: the gush against the kill's thud, never its louder chime", () => {
    const near = { of: 'kill', withinDb: 3, low: true };
    // The kill as heard: its chime's window −14.5, its thud's −16.0.
    const kill = read({ loudestDb: -14.5, lowLoudestDb: -16.0 });
    expect(checkSound(read({ loudestDb: -16.9 }), { near }, { kill })).toEqual([]);
    expect(checkSound(read({ loudestDb: -13.0 }), { near }, { kill })).toEqual([]);
    // 2 dB over the whole kill but 3.5 over its thud: too loud.
    expect(checkSound(read({ loudestDb: -12.5 }), { near }, { kill })).toEqual(["its loudest 50 ms, -12.5 dBFS, is 3.5 dB over kill's under 400 Hz (-16.0 dBFS), not within 3 dB"]);
    // 4 dB under the whole kill but 2.5 under its thud: near enough.
    expect(checkSound(read({ loudestDb: -18.5 }), { near }, { kill })).toEqual([]);
    expect(checkSound(read({ loudestDb: -19.5 }), { near }, { kill })).toEqual(["its loudest 50 ms, -19.5 dBFS, is 3.5 dB under kill's under 400 Hz (-16.0 dBFS), not within 3 dB"]);
    // Unmeasured is a failure, not a pass.
    const { lowLoudestDb: _, ...unread } = kill;
    expect(checkSound(read({ loudestDb: -16.9 }), { near }, { kill: unread as never })).toEqual(["its level is held to kill's under 400 Hz, which was not measured"]);
    // Without `low`, the whole kill as before.
    expect(checkSound(read({ loudestDb: -12.5 }), { near: { of: 'kill', withinDb: 3 } }, { kill })).toEqual([]);
  });

  it("a render held over another (`over`) passes with its energy in the rule's band, over its first seconds, at least so many dB over the other's, read alike: a headshot's kill over the same without its gush", () => {
    const over = { of: 'dry', band: [400, 2000] as [number, number], firstS: 0.3, db: 1.5 };
    const dry = read({ overDb: 40 });
    expect(checkSound(read({ overDb: 42.3 }), { over }, { dry })).toEqual([]);
    expect(checkSound(read({ overDb: 41.5 }), { over }, { dry })).toEqual([]);
    // The gush lost in the mix: barely over the kill without it, or under it.
    expect(checkSound(read({ overDb: 40.4 }), { over }, { dry })).toEqual(["its first 300 ms's energy in 400-2000 Hz is 0.4 dB over dry's, not 1.5 dB or more over it"]);
    expect(checkSound(read({ overDb: 39.2 }), { over }, { dry })).toEqual(["its first 300 ms's energy in 400-2000 Hz is 0.8 dB under dry's, not 1.5 dB or more over it"]);
    // Over the whole file, said so.
    expect(checkSound(read({ overDb: 40 }), { over: { of: 'dry', band: [400, 2000], db: 1.5 } }, { dry })).toEqual(["its energy in 400-2000 Hz is 0.0 dB over dry's, not 1.5 dB or more over it"]);
    // Unmeasured, either, or the other not rendered, is a failure, not a pass.
    expect(checkSound(read(), { over }, { dry })).toEqual(["its first 300 ms's energy in 400-2000 Hz over dry's was not measured"]);
    expect(checkSound(read({ overDb: 42 }), { over }, { dry: read() })).toEqual(["its first 300 ms's energy in 400-2000 Hz over dry's was not measured"]);
    expect(checkSound(read({ overDb: 42 }), { over }, {})).toEqual(["its energy is held over dry's, which was not rendered"]);
  });

  it('a table of each file: its name, peak, RMS, loudest 50 ms, its share in BAND and over 400 Hz, and what failed of it', () => {
    const out = table([
      { ...read({ peakDb: -3.14159, rmsDb: -17.5, loudestDb: -11.04, bandShare: 0.123, highShare: 0.456, ruleShare: 0.9 }), name: 'hit', failures: [] },
      { ...read({ peakDb: -38.04, rmsDb: -52.25, loudestDb: -44.4, bandShare: 0.4, highShare: 0.99 }), name: 'ding-85m', failures: ['its peak, -38.0 dBFS, is under -30 dBFS: too quiet'], gated: false },
      { ...read({ peakDb: -Infinity, rmsDb: -Infinity, loudestDb: -Infinity, bandShare: 0, highShare: 0 }), name: 'gush', failures: ['it is silent'] },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^name\s+peak dBFS\s+RMS dBFS\s+loudest 50 ms\s+400-2000 Hz\s+over 400 Hz\s+$/);
    // The band column is BAND's, never a rule's.
    expect(lines[1]).toMatch(/^hit\s+-3\.1\s+-17\.5\s+-11\.0\s+12%\s+46%\s+ok$/);
    expect(lines[2]).toMatch(/^ding-85m\s+-38\.0\s+-52\.3\s+-44\.4\s+40%\s+99%\s+\(reported\) its peak, -38\.0 dBFS, is under -30 dBFS: too quiet$/);
    expect(lines[3]).toMatch(/^gush\s+-inf\s+-inf\s+-inf\s+0%\s+0%\s+FAIL it is silent$/);
  });
});
