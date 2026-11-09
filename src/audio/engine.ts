/**
 * The sound (spec §5): a WebAudio context made and started by the click that
 * starts play (a browser lets a context start only in a click), suspended
 * while paused and started again on resuming. The listener stands at the
 * camera, facing as it faces, so each voice's HRTF panner turns it about the
 * head. A frame's voices (plan.ts) start at their delays into one mix through
 * a compressor, which keeps a burst's reports from clipping.
 *
 * Every report's tail (the shots spec's §6) is one reverb, made as the context
 * is and shared by every voice that sends to it: a ConvolverNode on an impulse
 * generated then, from a seeded stream. A magazine on full auto makes no more
 * convolvers than a single shot: each report adds only its own send to it.
 */

import { Rng } from '../core/rng';
import { cameraBasis, type CameraPose } from '../render/camera';
import { VoiceCap } from './cap';
import type { AudioTunables, VoiceKind, VoicePlan } from './plan';
import { playVoice, voiceLength, type ReportShape, type VoiceHandle } from './voices';

const NOISE_S = 2;

/** The tail's impulse: falling this far over its length (dB), its corner falling from TAIL_OPEN_HZ to TAIL_DULL_HZ over it (its highs dying first). */
const TAIL_FALL_DB = 60;
const TAIL_OPEN_HZ = 8000;
const TAIL_DULL_HZ = 400;

/**
 * The reports' tail's impulse at `rate`: `lengthS` of noise in each ear (each its own draw, so the
 * tail is wide), falling TAIL_FALL_DB over it, through a lowpass of two one-pole stages (12 dB an
 * octave) whose corner falls geometrically from TAIL_OPEN_HZ to TAIL_DULL_HZ, so its highs die faster
 * than its lows (over 2 kHz, about 9 dB further over its first 0.6 s than under 500 Hz). Each ear
 * scaled to unit energy: what a voice sends comes back as its energy times the send squared. Drawn
 * from one seeded stream (core/rng, 'audio.tail'), so it is the same every start and in every render.
 */
export function tailImpulse(rate: number, lengthS: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const n = Math.round(lengthS * rate);
  const rng = Rng.root(0).derive('audio.tail');
  const ears: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(n), new Float32Array(n)];
  for (const [k, ear] of ears.entries()) {
    const draw = rng.derive(`ear.${k}`);
    let y1 = 0;
    let y2 = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const along = i / n;
      const corner = TAIL_OPEN_HZ * Math.pow(TAIL_DULL_HZ / TAIL_OPEN_HZ, along);
      const a = Math.exp((-2 * Math.PI * corner) / rate);
      y1 = (1 - a) * draw.uniform(-1, 1) + a * y1;
      y2 = (1 - a) * y1 + a * y2;
      ear[i] = y2 * Math.pow(10, (-TAIL_FALL_DB * along) / 20);
      sum += ear[i] * ear[i];
    }
    const scale = 1 / Math.sqrt(sum);
    for (let i = 0; i < n; i++) ear[i] *= scale;
  }
  return ears;
}

/** The reports' one shared tail into `mix`: a ConvolverNode on tailImpulse at the context's rate, as the engine makes it, and the sounds' proof (tools/sounds) too. */
export function tailInto(ctx: BaseAudioContext, mix: AudioNode, shape: ReportShape): ConvolverNode {
  const ears = tailImpulse(ctx.sampleRate, shape.tailS);
  const buffer = ctx.createBuffer(2, ears[0].length, ctx.sampleRate);
  for (const [k, ear] of ears.entries()) buffer.copyToChannel(ear, k);
  const tail = new ConvolverNode(ctx, { buffer, disableNormalization: true });
  tail.connect(mix);
  return tail;
}

/**
 * The mix every voice plays into: `masterGain`, through a compressor that keeps a burst's reports from
 * clipping, into `out` (the context's output). The sounds' proof (tools/sounds) renders into the same.
 */
export function mixInto(ctx: BaseAudioContext, masterGain: number, out: AudioNode = ctx.destination): GainNode {
  const mix = new GainNode(ctx, { gain: masterGain });
  mix.connect(new DynamicsCompressorNode(ctx, { threshold: -14, knee: 12, ratio: 6, attack: 0.002, release: 0.15 })).connect(out);
  return mix;
}

/** The noise every voice's noise is drawn from: NOISE_S seconds of it, white. */
export function whiteNoise(ctx: BaseAudioContext): AudioBuffer {
  const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_S), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

export class AudioEngine {
  /** Voices started, for the tests. */
  voices = 0;
  /** Voices started, by kind. */
  readonly kinds: Partial<Record<VoiceKind, number>> = {};
  /** Voices the cap did not play: farther than all it held. */
  dropped = 0;
  /** Convolvers made: the reports' one shared tail, made as the context is (for the tests). */
  convolvers = 0;
  private readonly cap: VoiceCap<VoiceHandle>;
  /** Where the listener stands (metres): a voice's distance, for the cap. */
  private ear: readonly number[] = [0, 0, 0];
  private ctx: AudioContext | null = null;
  private mix: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private reverb: ConvolverNode | null = null;

  constructor(
    private readonly t: AudioTunables,
    private readonly report: ReportShape,
  ) {
    this.cap = new VoiceCap(t.maxVoices);
  }

  /** The voices sounding or waiting to. */
  get held(): number {
    return this.cap.count;
  }

  /** The context's clock (seconds), or null without one: it stands still where no output renders. */
  get time(): number | null {
    return this.ctx?.currentTime ?? null;
  }

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  /** The reports' one shared tail, into the mix: every voice with a send sends to it. Null without sound. */
  get tail(): ConvolverNode | null {
    return this.reverb;
  }

  /**
   * In the click that starts or resumes play: make the context the first time, and start it. A
   * browser that refuses sound leaves the game silent, never stopped: the click goes on to lock the
   * pointer.
   */
  start(): void {
    if (!this.ctx) {
      let ctx: AudioContext | null = null;
      try {
        ctx = new AudioContext({ latencyHint: 'interactive' });
        const mix = mixInto(ctx, this.t.masterGain);
        const noise = whiteNoise(ctx);
        const reverb = tailInto(ctx, mix, this.report);
        this.convolvers++;
        this.mix = mix;
        this.noise = noise;
        this.reverb = reverb;
        this.ctx = ctx;
      } catch (e) {
        void ctx?.close().catch(() => {});
        console.warn(`[audio] no sound: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    this.ctx.resume().catch(() => {});
  }

  suspend(): void {
    this.ctx?.suspend().catch(() => {});
  }

  /** Hear from the camera: where it is, which way it faces, which way is up. */
  listen(pose: CameraPose): void {
    this.ear = pose.position;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const { forward, up } = cameraBasis(pose.yaw, pose.pitch, pose.roll ?? 0);
    const l = ctx.listener;
    const now = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pose.position[0], now);
      l.positionY.setValueAtTime(pose.position[1], now);
      l.positionZ.setValueAtTime(pose.position[2], now);
      l.forwardX.setValueAtTime(forward[0], now);
      l.forwardY.setValueAtTime(forward[1], now);
      l.forwardZ.setValueAtTime(forward[2], now);
      l.upX.setValueAtTime(up[0], now);
      l.upY.setValueAtTime(up[1], now);
      l.upZ.setValueAtTime(up[2], now);
    } else {
      l.setPosition(pose.position[0], pose.position[1], pose.position[2]);
      l.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }
  }

  play(plans: readonly VoicePlan[]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.mix || !this.noise) return;
    const now = ctx.currentTime;
    const mix = this.mix;
    const noise = this.noise;
    const tail = this.reverb;
    for (const v of plans) {
      // Under the cap: the farthest dropped first, a nearer voice cutting the farthest held.
      const when = now + v.delayS;
      const distance = Math.hypot(v.at[0] - this.ear[0], v.at[1] - this.ear[1], v.at[2] - this.ear[2]);
      const r = this.cap.admit(distance, when + voiceLength(v, this.report), now, () => playVoice(ctx, mix, noise, v, when, this.report, tail));
      r.cut?.cut(now);
      if (!r.play) {
        this.dropped++;
        continue;
      }
      this.voices++;
      this.kinds[v.kind] = (this.kinds[v.kind] ?? 0) + 1;
    }
  }
}
