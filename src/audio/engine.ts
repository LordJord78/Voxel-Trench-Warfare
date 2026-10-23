/**
 * The sound (spec §5): a WebAudio context made and started by the click that
 * starts play (a browser lets a context start only in a click), suspended
 * while paused and started again on resuming. The listener stands at the
 * camera, facing as it faces, so each voice's HRTF panner turns it about the
 * head. A frame's voices (plan.ts) start at their delays into one mix through
 * a compressor, which keeps a burst's reports from clipping.
 */

import { cameraBasis, type CameraPose } from '../render/camera';
import type { AudioTunables, VoicePlan } from './plan';
import { playVoice, type ReportShape } from './voices';

const NOISE_S = 2;

export class AudioEngine {
  /** Voices started, for the tests. */
  voices = 0;
  private ctx: AudioContext | null = null;
  private mix: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  constructor(
    private readonly t: AudioTunables,
    private readonly report: ReportShape,
  ) {}

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
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
        const mix = new GainNode(ctx, { gain: this.t.masterGain });
        mix.connect(new DynamicsCompressorNode(ctx, { threshold: -14, knee: 12, ratio: 6, attack: 0.002, release: 0.15 })).connect(ctx.destination);
        const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_S), ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        this.mix = mix;
        this.noise = noise;
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
    for (const v of plans) {
      playVoice(ctx, this.mix, this.noise, v, now + v.delayS, this.report);
      this.voices++;
    }
  }
}
