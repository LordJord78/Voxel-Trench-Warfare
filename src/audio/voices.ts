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

export function playVoice(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, v: VoicePlan, when: number, report: ReportShape): void {
  const panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0, positionX: v.at[0], positionY: v.at[1], positionZ: v.at[2] });
  const dull = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: v.lowpassHz });
  dull.connect(panner).connect(out);
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
  }
}
