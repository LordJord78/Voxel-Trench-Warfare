/**
 * Each voice's sound, made from noise and oscillators: no samples, nothing
 * loaded (spec §5). A voice's sources run through a low-pass for its distance
 * and an HRTF panner where it happened, into the engine's mix.
 *
 * - The report (the shots spec's §6), in layers: a click of broadband noise (2 ms); its body, a sine
 *   at its gun's `report_body_hz` falling a third over 60 ms, each shot's pitch and level drawn a little
 *   about it; its crack, noise in 1.5–4 kHz over 25 ms; and the action, a click in 3–6 kHz 15 ms on,
 *   over 10 ms. Its tail is the engine's, shared by every report (engine.ts): each sends its share
 *   there. Suppressed, its click and body lose their highs (over [attachment.suppressor] blast_hz) and
 *   fall to its blast_share, and its crack and action are kept.
 * - A crack: a few milliseconds of high noise and a snap.
 * - Strikes: soil a low thud; timber a knock and its ring; metal a ping and an
 *   inharmonic partial over a tick of noise.
 * - A shell's whistle: a tone and a band of noise falling in pitch until it
 *   lands; its blast: a sub-bass thump, a rumble, and soil raining down.
 * - A scoop: the blade's scrape, a band of noise, and the shovelful landing.
 * - A flare fired: the pistol's pop, and the flare's hiss rising as it climbs.
 * - A hit's feedback (the shots spec's §4): a body hit's thwack, a falling sine and a click; a
 *   headshot's crack of two inharmonic partials, and its wet gush of swept, fluttering noise over a
 *   low splat; a kill's thud and its low chime; a steel plate's ring of four partials, each dying
 *   at its own rate; and being hit, a low thump and a high ring in the ears.
 * - The hands' cues (combat/handling.ts), each a few tens of milliseconds of filtered noise and a
 *   clipped tone, mostly over 400 Hz so a laptop plays them: the magazine out, a dull click and a
 *   scrape (60 ms); in, a sharp clack (40 ms); the bolt, a two-part rack (120 ms); the machine gun's
 *   feed cover, a clap (50 ms); a shotgun's shell, a click (30 ms); its pump, chk-chk, two clacks
 *   90 ms apart; and an empty trigger, a thin click (15 ms).
 */

import type { Tunables } from '../core/tunables';
import type { VoicePlan } from './plan';

/**
 * What every report shares: the body of one whose gun is not known (the defaults', the front's rifles'),
 * its tail, one reverb (engine.ts) on an impulse `tailS` seconds long, and what a suppressor leaves of
 * its blast (its click and body): what is under `suppressedHz`, at `suppressedBlast` of its level.
 */
export interface ReportShape {
  bodyHz: number;
  tailS: number;
  suppressedHz: number;
  suppressedBlast: number;
}

/**
 * The reports' shape the engine is given (app/main.ts), and the sounds' proof renders with (tools/sounds).
 * A tail of no length is refused here, at boot: the engine could not build it, and would go silent.
 */
export function reportShape(tun: Tunables): ReportShape {
  const tailS = tun.f('viewkick.defaults.report_tail_s');
  if (!(tailS > 0)) throw new Error(`[viewkick.defaults] report_tail_s (${tailS}) must be over 0: the reports' tail is an impulse that long`);
  return {
    bodyHz: tun.f('viewkick.defaults.report_body_hz'),
    tailS,
    suppressedHz: tun.f('attachment.suppressor.blast_hz'),
    suppressedBlast: tun.f('attachment.suppressor.blast_share'),
  };
}

/** The report's layers (the shots spec's §6): its click's length (s); its body's, the share of its pitch it falls to, and of its peak; its crack's length; the action's, and when it comes. */
const CLICK_S = 0.002;
const BODY_S = 0.06;
const BODY_FALL = 2 / 3;
const BODY_FADE = 0.1;
const CRACK_S = 0.025;
const ACTION_AT_S = 0.015;
const ACTION_S = 0.01;
/**
 * The crack's band (1.5–4 kHz) and the action's (3–6 kHz), each a highpass and a lowpass, a pair of
 * each: steep enough that little leaks past. Made once, not each report.
 */
const band = (lo: number, hi: number): readonly BiquadFilterOptions[] => {
  const high: BiquadFilterOptions = { type: 'highpass', frequency: lo };
  const low: BiquadFilterOptions = { type: 'lowpass', frequency: hi };
  return [high, high, low, low];
};
const CRACK_FILTERS = band(1500, 4000);
const ACTION_FILTERS = band(3000, 6000);
/** Each layer's peak, as a share of the report's gain. */
const CLICK_PEAK = 0.35;
const BODY_PEAK = 0.45;
const CRACK_PEAK = 1.1;
const ACTION_PEAK = 0.55;
/**
 * Each shot's body its own (a magazine is not one tone thirty times): its pitch drawn within this share
 * of its gun's, and its peak within this many dB of its share, each from Math.random as a noise's
 * offset is (the sounds' proof seeds it, so its files are the same every run).
 */
const BODY_PITCH_JITTER = 0.03;
const BODY_LEVEL_JITTER_DB = 1;
/** How long a report's own layers sound (s): its body's, the longest, and its fade. */
export const REPORT_S = BODY_S + 0.01;

/** A voice that falls to a share of its peak (`fall`) fades from there to nothing over this (s). */
const FALL_FADE_S = 0.004;

/**
 * A gain at `peak` falling away by `to`: to 1e-4 (inaudible), or, given `fall`, to `fall` × `peak` and
 * then to nothing over FALL_FADE_S: a gentler fall, heard to its end. A peak of nothing falls to nothing
 * in a line: an exponential ramp to 0 throws (WebAudio), and would stop the game.
 */
function fallAway(gain: AudioParam, peak: number, to: number, fall?: number): void {
  if (fall === undefined) {
    gain.exponentialRampToValueAtTime(1e-4, to);
    return;
  }
  if (!(peak * fall > 0)) {
    gain.linearRampToValueAtTime(0, to);
    return;
  }
  gain.exponentialRampToValueAtTime(peak * fall, to);
  gain.linearRampToValueAtTime(0, to + FALL_FADE_S);
}

/**
 * Noise filtered and shaped: through `filters` in turn (one, a list, or none), up to `peak` in `attack`
 * seconds, then down by `decay` (to `fall` × `peak` and away, if given).
 */
function burst(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, filters: BiquadFilterOptions | readonly BiquadFilterOptions[], peak: number, attack: number, decay: number, fall?: number): void {
  const source = new AudioBufferSourceNode(ctx, { buffer: noise });
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  shape.gain.linearRampToValueAtTime(peak, when + attack);
  fallAway(shape.gain, peak, when + attack + decay, fall);
  let chain: AudioNode = source;
  for (const filter of Array.isArray(filters) ? filters : [filters]) chain = chain.connect(new BiquadFilterNode(ctx, filter));
  chain.connect(shape).connect(into);
  const length = attack + decay + 0.05;
  source.start(when, Math.random() * Math.max(0, noise.duration - length), length);
}

/** A draw from Math.random, uniform in [−1, 1). */
const drawn = () => Math.random() * 2 - 1;

/**
 * A report (the shots spec's §6) into `into`, `g` loud: its click, its body about `bodyHz` (this shot's
 * pitch and level drawn within BODY_PITCH_JITTER and BODY_LEVEL_JITTER_DB), its crack and its action.
 * Suppressed, the click and the body pass a lowpass at the shape's suppressedHz first, at its
 * suppressedBlast of their level.
 */
function report(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, g: number, bodyHz: number, suppressed: boolean, shape: ReportShape): void {
  let blast: AudioNode = into;
  if (suppressed) {
    blast = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: shape.suppressedHz });
    blast.connect(new GainNode(ctx, { gain: shape.suppressedBlast })).connect(into);
  }
  // The click: broadband, unfiltered, 2 ms.
  burst(ctx, noise, blast, when, [], CLICK_PEAK * g, 0.0002, CLICK_S - 0.0002);
  // The body: a sine about its gun's pitch falling a third over 60 ms, to a tenth of its peak and away.
  const hz = bodyHz * (1 + drawn() * BODY_PITCH_JITTER);
  const level = Math.pow(10, (drawn() * BODY_LEVEL_JITTER_DB) / 20);
  tone(ctx, blast, when, 'sine', hz, hz * BODY_FALL, BODY_PEAK * g * level, BODY_S, BODY_FADE);
  // The crack, 1.5–4 kHz over 25 ms; the action's click, 3–6 kHz, 15 ms on, over 10 ms.
  burst(ctx, noise, into, when, CRACK_FILTERS, CRACK_PEAK * g, 0.0005, CRACK_S - 0.0005, 0.05);
  burst(ctx, noise, into, when + ACTION_AT_S, ACTION_FILTERS, ACTION_PEAK * g, 0.0003, ACTION_S - 0.0003, 0.05);
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

/** A tone gliding from `from` to `to` Hz as it dies away over `decay` seconds (to `fall` × `peak` and away, if given). */
function tone(ctx: BaseAudioContext, into: AudioNode, when: number, type: OscillatorType, from: number, to: number, peak: number, decay: number, fall?: number): void {
  const osc = new OscillatorNode(ctx, { type, frequency: from });
  osc.frequency.setValueAtTime(from, when);
  osc.frequency.exponentialRampToValueAtTime(to, when + decay);
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  shape.gain.linearRampToValueAtTime(peak, when + 0.002);
  fallAway(shape.gain, peak, when + decay, fall);
  osc.connect(shape).connect(into);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

/** The gush's way in and out (s), and how far it falls over its way out: to a hundredth of its peak, so its flutter is heard to the end. */
const GUSH_IN_S = 0.015;
const GUSH_OUT_S = 0.5;
const GUSH_FALL = 1e-2;
/** Its bandpass's Q: narrow enough that most of it stays in 400 Hz–2 kHz as it sweeps (npm run sounds holds 55% there). */
const GUSH_Q = 3;
/** Its last fade to nothing (s), before its noise stops. */
const GUSH_END_S = 0.05;

/**
 * A wet gush: noise through a bandpass sweeping 1.8 kHz down to 500 Hz over 0.45 s, its loudness
 * fluttering at a rate drawn from 8 to 20 Hz, coming in over 15 ms and dying away over 0.5 s to a
 * hundredth of its peak, then to nothing; under it, a splat of noise below 400 Hz for 80 ms.
 */
function gush(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, peak: number): void {
  const length = GUSH_IN_S + GUSH_OUT_S + GUSH_END_S;
  const source = new AudioBufferSourceNode(ctx, { buffer: noise });
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1800, Q: GUSH_Q });
  band.frequency.setValueAtTime(1800, when);
  band.frequency.exponentialRampToValueAtTime(500, when + 0.45);
  // The flutter: a gain swung between 0.25 and 1 at its rate, from 1 (a cosine), so every gush comes in
  // whole whatever its rate: a sine from its middle came in at anywhere from half to all of its peak.
  const flutter = new GainNode(ctx, { gain: 0.625 });
  const cosine = new PeriodicWave(ctx, { real: [0, 1], imag: [0, 0], disableNormalization: true });
  const rate = new OscillatorNode(ctx, { type: 'custom', frequency: 8 + Math.random() * 12, periodicWave: cosine });
  rate.connect(new GainNode(ctx, { gain: 0.375 })).connect(flutter.gain);
  const shape = new GainNode(ctx, { gain: 0 });
  shape.gain.setValueAtTime(0, when);
  shape.gain.linearRampToValueAtTime(peak, when + GUSH_IN_S);
  shape.gain.exponentialRampToValueAtTime(peak * GUSH_FALL, when + GUSH_IN_S + GUSH_OUT_S);
  shape.gain.linearRampToValueAtTime(0, when + length);
  source.connect(band).connect(flutter).connect(shape).connect(into);
  source.start(when, Math.random() * Math.max(0, noise.duration - length), length);
  rate.start(when);
  rate.stop(when + length);
  burst(ctx, noise, into, when, { type: 'lowpass', frequency: 400 }, 0.7 * peak, 0.002, 0.08);
}

/** A steel plate struck: each partial (Hz), how long it rings (s), and its share of the voice. */
const DING: readonly (readonly [number, number, number])[] = [
  [690, 1.2, 0.3],
  [1640, 0.7, 0.2],
  [2780, 0.4, 0.12],
  [4100, 0.25, 0.08],
];

/** The pump's two clacks, this far apart (s); the bolt's two parts. */
const PUMP_GAP_S = 0.09;
const BOLT_GAP_S = 0.075;

/** A clack of metal on metal: a burst of noise about `hz` and a clipped square tone falling from `toneHz`, `peak` loud, dying over `decay` seconds. */
function clack(ctx: BaseAudioContext, noise: AudioBuffer, into: AudioNode, when: number, hz: number, toneHz: number, peak: number, decay: number): void {
  burst(ctx, noise, into, when, { type: 'bandpass', frequency: hz, Q: 1.2 }, 2.2 * peak, 0.0005, decay, 0.05);
  tone(ctx, into, when, 'square', toneHz, toneHz * 0.7, 0.18 * peak, decay * 0.8, 0.05);
}

/** A voice played: cut, it falls silent over 20 ms from `at` (seconds on its context's clock), whether sounding yet or not. */
export interface VoiceHandle {
  cut(at: number): void;
}

/** How long a voice sounds from its start, in seconds: when it frees its place under the cap (cap.ts). */
export function voiceLength(v: VoicePlan): number {
  switch (v.kind) {
    case 'report':
      // Its own layers: its tail is the engine's, shared.
      return REPORT_S;
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
    case 'crackle':
      return 0.05;
    case 'splash':
      return (v.lengthS ?? 0.06) + 0.05;
    case 'hit':
      return 0.07;
    case 'head':
      return 0.13;
    case 'gush':
      return GUSH_IN_S + GUSH_OUT_S + GUSH_END_S;
    case 'kill':
      return 0.06 + 0.2 + 0.01;
    case 'ding':
      return 1.2 + 0.05;
    case 'hurt':
      return 0.6 + 0.05;
    case 'mag-out':
      return 0.06 + 0.01;
    case 'mag-in':
      return 0.04 + 0.01;
    case 'bolt':
      return BOLT_GAP_S + 0.045 + 0.01;
    case 'cover':
      return 0.05 + 0.01;
    case 'shell':
      return 0.03 + 0.01;
    case 'pump':
      return PUMP_GAP_S + 0.03 + 0.01;
    case 'dry':
      return 0.015 + 0.005;
  }
}

/**
 * Play `v` at `when` into `out`, the mix: its sources through a lowpass for its distance and an HRTF
 * panner where it happened, at its own level. A voice with a send (a report's) sends that share of
 * itself, after its level (so a voice cut sends no more), to `tail`, the engine's shared reverb, if
 * there is one.
 */
export function playVoice(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, v: VoicePlan, when: number, shape: ReportShape, tail: AudioNode | null = null): VoiceHandle {
  const panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0, positionX: v.at[0], positionY: v.at[1], positionZ: v.at[2] });
  const dull = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: v.lowpassHz });
  // Its own level, so the cap can cut it.
  const level = new GainNode(ctx, { gain: 1 });
  dull.connect(panner).connect(level).connect(out);
  if (tail && v.send !== undefined && v.send > 0) level.connect(new GainNode(ctx, { gain: v.send })).connect(tail);
  const g = v.gain;
  switch (v.kind) {
    case 'report':
      report(ctx, noise, dull, when, g, v.bodyHz ?? shape.bodyHz, v.suppressed ?? false, shape);
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
    case 'crackle':
      // A fire's pop: a snap of highpassed noise, and a click.
      burst(ctx, noise, dull, when, { type: 'highpass', frequency: 2500 }, 0.7 * g, 0.0005, 0.03);
      tone(ctx, dull, when, 'square', 1700, 1100, 0.2 * g, 0.012);
      break;
    case 'splash':
      if (v.lengthS === undefined) {
        // A round into water: a short plip of bandpassed noise, falling.
        burst(ctx, noise, dull, when, { type: 'bandpass', frequency: 1800, Q: 4 }, 0.8 * g, 0.002, 0.06);
        tone(ctx, dull, when, 'sine', 1400, 600, 0.15 * g, 0.05);
      } else {
        // A shell on water: a thump, and the water thrown up rushing down over its length.
        tone(ctx, dull, when, 'sine', 70, 40, 0.7 * g, 0.3);
        burst(ctx, noise, dull, when, { type: 'lowpass', frequency: 1200 }, 0.6 * g, 0.05, v.lengthS);
      }
      break;
    case 'scrape':
      // The blade into the earth, rising for 0.04 s and falling over 0.18 s; then the shovelful thrown, landing low.
      burst(ctx, noise, dull, when, { type: 'bandpass', frequency: 1200, Q: 2 }, 0.7 * g, 0.04, 0.18);
      burst(ctx, noise, dull, when + 0.24, { type: 'lowpass', frequency: 300 }, 0.5 * g, 0.004, 0.08);
      break;
    case 'hit':
      // A thwack: a sine falling 160 to 90 Hz over 60 ms, and a 12 ms click of noise about 2.5 kHz. A
      // laptop's speakers barely play the sine, so the click carries the hit there: wide, held near its
      // peak through its 12 ms, and louder than the sine (npm run sounds holds a quarter of it over 400 Hz).
      tone(ctx, dull, when, 'sine', 160, 90, 0.65 * g, 0.06);
      burst(ctx, noise, dull, when, { type: 'bandpass', frequency: 2500, Q: 0.6 }, 2.6 * g, 0.0005, 0.012, 0.25);
      break;
    case 'head':
      // A crack: two inharmonic partials, at 2.9 and 4.6 kHz, over 0.12 s.
      tone(ctx, dull, when, 'sine', 2900, 2860, 0.6 * g, 0.12);
      tone(ctx, dull, when, 'sine', 4600, 4540, 0.4 * g, 0.12);
      break;
    case 'gush':
      gush(ctx, noise, dull, when, g);
      break;
    case 'kill':
      // A thud, a sine falling 70 to 45 Hz over 0.25 s; and 60 ms on, a low chime of 880 and 1320 Hz over
      // 0.2 s, ringing over the thud's tail: on a laptop's speakers the chime is the kill.
      tone(ctx, dull, when, 'sine', 70, 45, g, 0.25);
      tone(ctx, dull, when + 0.06, 'sine', 880, 878, 0.7 * g, 0.2);
      tone(ctx, dull, when + 0.06, 'sine', 1320, 1317, 0.5 * g, 0.2);
      break;
    case 'ding':
      // A steel plate: its partials, each ringing its own while.
      for (const [hz, ringS, share] of DING) tone(ctx, dull, when, 'sine', hz, hz, share * g, ringS);
      break;
    case 'hurt':
      // Being hit: a low thump, and a 3 kHz ring in the ears fading over 0.6 s to a hundredth: on a
      // laptop's speakers the ring is what is heard of it (npm run sounds holds a quarter of it over
      // 400 Hz, the compressor settled: the thump's start no longer cut).
      tone(ctx, dull, when, 'sine', 95, 50, 0.85 * g, 0.18);
      burst(ctx, noise, dull, when, { type: 'lowpass', frequency: 250 }, 0.6 * g, 0.003, 0.1);
      tone(ctx, dull, when, 'sine', 3000, 2990, 0.33 * g, 0.6, 1e-2);
      break;
    case 'mag-out':
      // A dull click as the catch lets go, and the magazine scraping out over 60 ms.
      clack(ctx, noise, dull, when, 1100, 520, 0.8 * g, 0.018);
      burst(ctx, noise, dull, when + 0.012, { type: 'bandpass', frequency: 2600, Q: 2 }, 1.1 * g, 0.012, 0.036, 0.05);
      break;
    case 'mag-in':
      // A sharp clack, seated: bright, over 40 ms, a knock of the body under it.
      clack(ctx, noise, dull, when, 2200, 1150, g, 0.035);
      tone(ctx, dull, when, 'sine', 260, 180, 0.35 * g, 0.03, 0.05);
      break;
    case 'bolt':
      // A two-part rack: the bolt back with a scrape, and home.
      clack(ctx, noise, dull, when, 1600, 820, 0.85 * g, 0.03);
      burst(ctx, noise, dull, when + 0.01, { type: 'bandpass', frequency: 3200, Q: 2.5 }, 0.9 * g, 0.015, 0.045, 0.05);
      clack(ctx, noise, dull, when + BOLT_GAP_S, 2000, 1000, g, 0.045);
      break;
    case 'cover':
      // The feed cover slapped shut: a broad clap over 50 ms.
      burst(ctx, noise, dull, when, { type: 'bandpass', frequency: 1300, Q: 0.7 }, 2.4 * g, 0.001, 0.049, 0.05);
      tone(ctx, dull, when, 'triangle', 420, 300, 0.3 * g, 0.04, 0.05);
      break;
    case 'shell':
      // A shell thumbed into the tube: a click over 30 ms.
      clack(ctx, noise, dull, when, 2600, 1400, 0.8 * g, 0.03);
      break;
    case 'pump':
      // Chk-chk: the fore-end back and forward, two clacks PUMP_GAP_S apart.
      clack(ctx, noise, dull, when, 1500, 640, g, 0.03);
      clack(ctx, noise, dull, when + PUMP_GAP_S, 1900, 760, g, 0.03);
      break;
    case 'dry':
      // An empty trigger: a thin click over 15 ms.
      burst(ctx, noise, dull, when, { type: 'highpass', frequency: 3000 }, 1.4 * g, 0.0005, 0.0145, 0.05);
      tone(ctx, dull, when, 'square', 2600, 2100, 0.12 * g, 0.012, 0.05);
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
