import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, tailImpulse } from '../../src/audio/engine';
import { audioTunables } from '../../src/audio/plan';
import { reportShape } from '../../src/audio/voices';
import { loadTunables, Tunables } from '../../src/core/tunables';
import { bandShare, ruleEnergyDb } from '../../tools/lib/sound-measures.mjs';
import { install, madeOf } from '../support/fake-web-audio';

const tun = loadTunables();

// Without sound the game still plays: here there is no AudioContext at all, as in a browser that
// refuses one.
describe('the sound engine without sound', () => {
  it('starts, hears and plays nothing, and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new AudioEngine(audioTunables(tun), reportShape(tun));
    expect(() => engine.start()).not.toThrow();
    expect(() => engine.start()).not.toThrow();
    expect(engine.state).toBe('none');
    expect(() => engine.listen({ position: [0, 2, 0], yaw: 0, pitch: 0 })).not.toThrow();
    expect(() => engine.play([{ kind: 'report', at: [0, 2, 1], delayS: 0, gain: 1, lowpassHz: 18000, bodyHz: 140, suppressed: false, send: 0.35 }])).not.toThrow();
    expect(() => engine.suspend()).not.toThrow();
    expect(engine.voices).toBe(0);
    // No tail either: nothing to send to, and no convolver made.
    expect(engine.tail).toBeNull();
    expect(engine.convolvers).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[audio] no sound'));
    warn.mockRestore();
  });
});

// The reports' one shared tail (the shots spec's §6): a ConvolverNode the engine makes once, as it
// starts, on an impulse it generates then: report_tail_s of decaying noise, its highs falling faster,
// drawn from a seeded stream, so it is the same tail every start and in every render of it.
describe("the reports' shared tail", () => {
  const RATE = 48000;
  const [left, right] = tailImpulse(RATE, reportShape(tun).tailS);
  const energy = (x: Float32Array, from = 0, to = x.length) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += x[i] * x[i];
    return sum;
  };
  const at = (s: number) => Math.round(s * RATE);

  it('is report_tail_s (1.2 s) long: [viewkick.defaults], beside the reports\' other numbers', () => {
    expect(reportShape(tun)).toEqual({
      bodyHz: tun.f('viewkick.defaults.report_body_hz'),
      tailS: tun.f('viewkick.defaults.report_tail_s'),
      suppressedHz: tun.f('attachment.suppressor.blast_hz'),
      suppressedBlast: tun.f('attachment.suppressor.blast_share'),
    });
    expect(reportShape(tun).tailS).toBe(1.2);
    expect([left.length, right.length]).toEqual([at(1.2), at(1.2)]);
  });

  it('is seeded: the same impulse every time it is made, each ear its own draw', () => {
    const [l2, r2] = tailImpulse(RATE, 1.2);
    expect(l2).toEqual(left);
    expect(r2).toEqual(right);
    // The ears barely correlate: the tail is wide, not a point between them.
    let cross = 0;
    for (let i = 0; i < left.length; i++) cross += left[i] * right[i];
    expect(Math.abs(cross) / Math.sqrt(energy(left) * energy(right))).toBeLessThan(0.1);
    // Noise: no run of silence at its start, and no sample at full scale.
    expect(Math.abs(left[0]) + Math.abs(left[1]) + Math.abs(left[2])).toBeGreaterThan(0);
    for (const x of [left, right]) expect(Math.max(...x.map(Math.abs))).toBeLessThan(1);
  });

  it("each ear returns a report's body at about the send squared (G5's final review), as the renders hold it with the compressor settled: its energy in the bodies' band (60-210 Hz) against a unit-energy white noise's there, within 1 dB of it", () => {
    // What a sine in the band sent at `send` comes back as: its energy times the send squared times
    // this return, the impulse's energy in the band over a unit-energy white noise's there (dB). Held
    // from both sides: hotter, the tail outweighs a low report (958c940's unit-energy impulse returned
    // the body 7.0 dB over this, and the M870's loudest 50 ms was its tail); colder, the reports go dry.
    const BODIES: [number, number] = [60, 210];
    for (const x of [left, right]) {
      const back = ruleEnergyDb(x, RATE, { hz: BODIES }) - 10 * Math.log10((BODIES[1] - BODIES[0]) / (RATE / 2));
      expect(Math.abs(back)).toBeLessThan(1);
    }
    // Its highs, which its lowpass thins, come back less: all told it holds under a unit energy.
    expect(energy(left)).toBeLessThan(1);
    expect(energy(right)).toBeLessThan(1);
  });

  it('decays: its last 0.2 s 50 dB or more under its first 0.2 s', () => {
    for (const x of [left, right]) {
      const first = energy(x, 0, at(0.2));
      const last = energy(x, at(1.0), at(1.2));
      expect(10 * Math.log10(last / first)).toBeLessThan(-50);
    }
  });

  it('its highs fall faster than its lows: over 2 kHz, most of its first 0.1 s, and under half that share of its last half; falling 5 dB further than under 500 Hz over its first 0.6 s', () => {
    for (const x of [left, right]) {
      const early = bandShare(x.subarray(0, at(0.1)), RATE, 2000, Infinity);
      const late = bandShare(x.subarray(at(0.6), at(1.2)), RATE, 2000, Infinity);
      expect(early).toBeGreaterThan(0.5);
      expect(late).toBeLessThan(early / 2);
      // Each band's energy from its first 0.2 s to 0.4–0.6 s (dB): the highs' fall over the lows'.
      const band = (from: number, to: number, lo: number, hi: number) => energy(x, at(from), at(to)) * bandShare(x.subarray(at(from), at(to)), RATE, lo, hi);
      const fall = (lo: number, hi: number) => 10 * Math.log10(band(0.4, 0.6, lo, hi) / band(0, 0.2, lo, hi));
      expect(fall(2000, Infinity)).toBeLessThan(fall(0, 500) - 5);
    }
  });
});

// A tuning experiment must never silence the game: a tail of no length is refused as the tunables are
// read (reportShape, at boot, as handlingTunables refuses a bad overshoot), and a tail that fails to
// build all the same leaves the rest of the sound playing.
describe('a tail that cannot be made', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reportShape refuses report_tail_s at or under 0, naming it', () => {
    const withTail = (s: number) => {
      const raw = tun.raw();
      ((raw.viewkick as Record<string, unknown>).defaults as Record<string, unknown>).report_tail_s = s;
      return new Tunables(raw);
    };
    for (const s of [0, -0.5]) expect(() => reportShape(withTail(s)), `${s}`).toThrow(`[viewkick.defaults] report_tail_s (${s}) must be over 0: the reports' tail is an impulse that long`);
    expect(reportShape(withTail(0.4)).tailS).toBe(0.4);
  });

  it('the engine started where the tail fails to build warns, makes no tail and keeps the rest of the sound: a report still plays, sending nothing', () => {
    install();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A shape that slipped past reportShape: an impulse of no length, which createBuffer refuses.
    const engine = new AudioEngine(audioTunables(tun), { ...reportShape(tun), tailS: 0 });
    engine.start();
    expect(engine.state).toBe('running');
    expect(engine.tail).toBeNull();
    expect(engine.convolvers).toBe(0);
    expect(madeOf('Convolver')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[audio] no tail'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('[audio] no sound'));
    engine.play([{ kind: 'report', at: [0, 0, 0], delayS: 0, gain: 1, lowpassHz: 18000, bodyHz: 140, suppressed: false, send: 0.35 }]);
    expect(engine.voices).toBe(1);
    expect(engine.kinds.report).toBe(1);
  });

  it('the engine started where the tail builds makes it once', () => {
    install();
    const engine = new AudioEngine(audioTunables(tun), reportShape(tun));
    engine.start();
    engine.start();
    expect([engine.state, engine.convolvers, madeOf('Convolver').length]).toEqual(['running', 1, 1]);
    expect(engine.tail).not.toBeNull();
  });
});
