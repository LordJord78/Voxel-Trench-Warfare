/**
 * Each voice's sound, made from noise and oscillators: no samples, nothing
 * loaded (spec §5). A voice's sources run through a low-pass for its distance
 * and an HRTF panner where it happened, into the engine's mix.
 *
 * - The report: a high crack of noise, a thump at the reference's
 *   `report_low_hz` falling over `report_length_s`, and a low tail.
 * - A crack: a few milliseconds of high noise and a snap.
 * - Strikes: soil a low thud; timber a knock and its ring; metal a ping and an
 *   inharmonic partial over a tick of noise.
 * - A shell's whistle: a tone and a band of noise falling in pitch until it
 *   lands; its blast: a sub-bass thump, a rumble, and soil raining down.
 * - A scoop: the blade's scrape, a band of noise, and the shovelful landing.
 * - A flare fired: the pistol's pop, and the flare's hiss rising as it climbs.
 */

import type { VoicePlan } from './plan';

/** The report's body, from the reference's WeaponReport. */
export interface ReportShape {
  lowHz: number;
  lengthS: number;
}

/** Noise filtered and shaped: up to `peak` in `attack` seconds, then down by `decay`. */
function burst(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, filter: BiquadFilterOptions, peak: number, attack: number, decay: number): void {
  const source = new AudioBufferSourceNode(ctx, { buffer: noise });
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  shape.gain.linearRampToValueAtTime(peak, when + attack);
  shape.gain.exponentialRampToValueAtTime(1e-4, when + attack + decay);
  source.connect(new BiquadFilterNode(ctx, filter)).connect(shape).connect(into);
  const length = attack + decay + 0.05;
  source.start(when, Math.random() * Math.max(0, noise.duration - length), length);
}

/** Noise rolling in over `attack` and away over the rest of `length` seconds, through a lowpass: looped, as a distant rumble outlasts the noise buffer. */
function roll(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, lowpassHz: number, peak: number, attack: number, length: number): void {
  const source = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  shape.gain.linearRampToValueAtTime(peak, when + attack);
  shape.gain.exponentialRampToValueAtTime(1e-4, when + length);
  source.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: lowpassHz })).connect(shape).connect(into);
  source.start(when, Math.random() * noise.duration);
  source.stop(when + length + 0.05);
}

/** A machine gun's burst far off: one looped noise through a lowpass, a sharp pop for each of `rounds` rounds `interval` apart. */
function rattle(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, lowpassHz: number, peak: number, rounds: number, interval: number): void {
  const source = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  for (let k = 0; k < rounds; k++) {
    const at = when + k * interval;
    shape.gain.setValueAtTime(0, at);
    shape.gain.linearRampToValueAtTime(peak, at + 0.003);
    shape.gain.exponentialRampToValueAtTime(1e-4, at + Math.min(0.05, interval * 0.8));
  }
  source.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: lowpassHz })).connect(shape).connect(into);
  source.start(when, Math.random() * noise.duration);
  source.stop(when + (rounds - 1) * interval + 0.1);
}

/** A shell coming in: a tone and a narrow band of noise falling from `from` to `to` Hz over `length` seconds, louder as it nears, cut off as it lands. */
function whistle(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, from: number, to: number, peak: number, length: number): void {
  const end = when + Math.max(0.05, length);
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(peak * 0.05, when);
  shape.gain.exponentialRampToValueAtTime(peak, end);
  shape.gain.setValueAtTime(0, end);
  shape.connect(into);
  const osc = new OscillatorNode(ctx, { type: 'sine', frequency: from });
  osc.frequency.setValueAtTime(from, when);
  osc.frequency.exponentialRampToValueAtTime(to, end);
  osc.connect(shape);
  osc.start(when);
  osc.stop(end + 0.01);
  const air = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: from, Q: 8 });
  band.frequency.setValueAtTime(from, when);
  band.frequency.exponentialRampToValueAtTime(to, end);
  air.connect(band).connect(new GainNode(ctx, { gain: 0.6 })).connect(shape);
  air.start(when);
  air.stop(end + 0.01);
}

/** Noise in a band rising from `from` to `to` Hz over `length` seconds, swelling for a fifth of it and fading after. */
function hiss(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, from: number, to: number, peak: number, length: number): void {
  const end = when + length;
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  shape.gain.linearRampToValueAtTime(peak, when + length * 0.2);
  shape.gain.exponentialRampToValueAtTime(1e-4, end);
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: from, Q: 4 });
  band.frequency.setValueAtTime(from, when);
  band.frequency.exponentialRampToValueAtTime(to, end);
  const air = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  air.connect(band).connect(shape).connect(into);
  air.start(when);
  air.stop(end + 0.01);
}

/** A tone gliding from `from` to `to` Hz as it dies away over `decay` seconds. */
function tone(ctx: BaseAudioContext, into: AudioNode, when: number, type: OscillatorType, from: number, to: number, peak: number, decay: number): void {
  const osc = new OscillatorNode(ctx, { type, frequency: from });
  osc.frequency.setValueAtTime(from, when);
  osc.frequency.exponentialRampToValueAtTime(to, when + decay);
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  shape.gain.linearRampToValueAtTime(peak, when + 0.002);
  shape.gain.exponentialRampToValueAtTime(1e-4, when + decay);
  osc.connect(shape).connect(into);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

/** A voice played: cut, it falls silent over 20 ms from `at` (seconds on its context's clock), whether sounding yet or not. */
export interface VoiceHandle {
  cut(at: number): void;
}

/** How long a voice sounds from its start, in seconds: when it frees its place under the cap (cap.ts). */
export function voiceLength(v: VoicePlan, report: ReportShape): number {
  switch (v.kind) {
    case 'report':
      return Math.max(report.lengthS, 0.47);
    case 'crack':
      return 0.02;
    case 'impact-soil':
    case 'impact-timber':
      return 0.1;
    case 'impact-metal':
      return 0.4;
    case 'whistle':
      return v.lengthS ?? 1.5;
    case 'blast':
      return Math.max(v.lengthS ?? 1.8, 1.4) + 0.05;
    case 'flare':
      return 3.1;
    case 'scrape':
      return 0.35;
    case 'rumble':
      return v.lengthS ?? 3;
    case 'thump':
      return Math.max(v.lengthS ?? 1, 0.3);
    case 'chatter':
      return (v.lengthS ?? 1) + 0.1;
  }
}

export function playVoice(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, v: VoicePlan, when: number, report: ReportShape): VoiceHandle {
  const panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0, positionX: v.at[0], positionY: v.at[1], positionZ: v.at[2] });
  const dull = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: v.lowpassHz });
  // Its own level, so the cap can cut it.
  const level = new GainNode(ctx, { gain: 1 });
  dull.connect(panner).connect(level).connect(out);
  const g = v.gain;
  switch (v.kind) {
    case 'report':
      burst(ctx, noise, dull, when, { type: 'highpass', frequency: 1000 }, 0.9 * g, 0.001, 0.025);
      tone(ctx, dull, when, 'sine', report.lowHz, report.lowHz * 0.55, 0.8 * g, report.lengthS);
      burst(ctx, noise, dull, when, { type: 'lowpass', frequency: 900 }, 0.25 * g, 0.005, 0.45);
      break;
    case 'crack':
      burst(ctx, noise, dull, when, { type: 'highpass', frequency: 3000 }, g, 0.0005, 0.004);
      tone(ctx, dull, when, 'square', 1800, 900, 0.3 * g, 0.012);
      break;
    case 'impact-soil':
      burst(ctx, noise, dull, when, { type: 'lowpass', frequency: 350 }, g, 0.002, 0.09);
      break;
    case 'impact-timber':
      burst(ctx, noise, dull, when, { type: 'bandpass', frequency: 900, Q: 3 }, g, 0.001, 0.06);
      tone(ctx, dull, when, 'triangle', 320, 260, 0.4 * g, 0.08);
      break;
    case 'impact-metal':
      tone(ctx, dull, when, 'sine', 2400, 2380, 0.5 * g, 0.35);
      tone(ctx, dull, when, 'sine', 3710, 3690, 0.3 * g, 0.25);
      burst(ctx, noise, dull, when, { type: 'highpass', frequency: 4000 }, 0.4 * g, 0.0005, 0.01);
      break;
    case 'whistle':
      whistle(ctx, noise, dull, when, v.fromHz ?? 1400, v.toHz ?? 450, 0.35 * g, v.lengthS ?? 1.5);
      break;
    case 'blast':
      // A sub-bass thump falling 60 to 30 Hz, a rumble of low noise, then soil raining down.
      tone(ctx, dull, when, 'sine', 60, 30, g, 0.4);
      burst(ctx, noise, dull, when, { type: 'lowpass', frequency: 200 }, 0.8 * g, 0.01, v.lengthS ?? 1.8);
      for (let k = 0; k < 8; k++) burst(ctx, noise, dull, when + 0.3 + k * 0.12 + Math.random() * 0.08, { type: 'highpass', frequency: 2500 }, 0.12 * g, 0.002, 0.05);
      break;
    case 'flare':
      // The pistol: a low pop and its crack; then the flare hissing up, rising 2 to 5 kHz over 3 s.
      burst(ctx, noise, dull, when, { type: 'lowpass', frequency: 400 }, 0.8 * g, 0.002, 0.08);
      burst(ctx, noise, dull, when, { type: 'highpass', frequency: 2500 }, 0.5 * g, 0.001, 0.02);
      hiss(ctx, noise, dull, when + 0.05, 2000, 5000, 0.25 * g, 3);
      break;
    case 'rumble':
      // A barrage's shell far off: low noise rolling in over 0.1 s and away over its length, under a 40 Hz sine.
      roll(ctx, noise, dull, when, v.lowpassHz, g, 0.1, v.lengthS ?? 3);
      tone(ctx, dull, when, 'sine', 45, 35, 0.5 * g, v.lengthS ?? 3);
      break;
    case 'thump':
      // A far shell: a sine dropping 90 to 40 Hz, and a short burst of low noise.
      tone(ctx, dull, when, 'sine', 90, 40, g, v.lengthS ?? 1);
      burst(ctx, noise, dull, when, { type: 'lowpass', frequency: v.lowpassHz }, 0.6 * g, 0.005, 0.25);
      break;
    case 'chatter':
      // A machine gun far off: its rounds popping at its rate, under the distance's lowpass.
      rattle(ctx, noise, dull, when, 1500, g, v.rounds ?? 10, 60 / (v.rpm ?? 600));
      break;
    case 'scrape':
      // The blade into the earth, rising for 0.04 s and falling over 0.18 s; then the shovelful thrown, landing low.
      burst(ctx, noise, dull, when, { type: 'bandpass', frequency: 1200, Q: 2 }, 0.7 * g, 0.04, 0.18);
      burst(ctx, noise, dull, when + 0.24, { type: 'lowpass', frequency: 300 }, 0.5 * g, 0.004, 0.08);
      break;
  }
  return {
    cut(at: number) {
      level.gain.cancelScheduledValues(at);
      level.gain.setValueAtTime(1, at);
      level.gain.linearRampToValueAtTime(0, at + 0.02);
    },
  };
}
