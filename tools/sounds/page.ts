/**
 * The sounds' proof's page (tools/render-sounds.mjs serves it through Vite): each render of renders.ts
 * played through audio/voices.ts's own playVoice into the engine's own mix (audio/engine.ts mixInto:
 * the master gain and the compressor) in an OfflineAudioContext, mono at RATE, and read there
 * (tools/lib/sound-measures.mjs: its peak, RMS and band share, by an FFT). Each render's channel 0 is
 * what the game puts out, its channel 1 the mix before the compressor: how hard the voice drives it.
 *
 * Its noise and its draws (a noise's offset, the gush's flutter) come from Math.random, seeded here for
 * each render by its name, so a file renders the same every run.
 */

import { audioTunables } from '../../src/audio/plan';
import { mixInto, whiteNoise } from '../../src/audio/engine';
import { playVoice } from '../../src/audio/voices';
import { loadTunables } from '../../src/core/tunables';
import { measure, type Measured } from '../lib/sound-measures.mjs';
import { LEAD_S, RATE, renders, reportShape, type Render } from './renders';

/** A render done: its file's samples (base64 of float32), and both channels read. */
export interface Rendered {
  name: string;
  rate: number;
  lengthS: number;
  gated: boolean;
  band: Render['band'] | null;
  plans: Render['plans'];
  /** What the game puts out: base64 of its float32 samples. */
  samples: string;
  heard: Measured;
  /** The mix before the compressor. */
  into: Measured;
}

/** A 32-bit seed from `s` (FNV-1a). */
function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: uniform in [0, 1) from `seed`. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Render each of renders.ts's list (those named in `only`, if given), in its order. */
async function render(only: string[] | null = null): Promise<Rendered[]> {
  const tun = loadTunables();
  const t = audioTunables(tun);
  const report = reportShape(tun);
  const out: Rendered[] = [];
  const random = Math.random;
  try {
    for (const r of renders(tun)) {
      if (only && !only.includes(r.name)) continue;
      Math.random = seeded(seedOf(r.name));
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(r.lengthS * RATE), sampleRate: RATE });
      // Channel 0, what the game puts out; channel 1, the mix before the compressor (each down to mono).
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      merger.connect(ctx.destination);
      const mix = mixInto(ctx, t.masterGain, merger);
      mix.connect(merger, 0, 1);
      const noise = whiteNoise(ctx);
      for (const v of r.plans) playVoice(ctx, mix, noise, v, LEAD_S + v.delayS, report);
      const buffer = await ctx.startRendering();
      const heard = buffer.getChannelData(0);
      const band = r.band?.band;
      out.push({ name: r.name, rate: RATE, lengthS: r.lengthS, gated: r.gated, band: r.band ?? null, plans: r.plans, samples: base64(heard), heard: measure(heard, RATE, band), into: measure(buffer.getChannelData(1), RATE, band) });
    }
  } finally {
    Math.random = random;
  }
  return out;
}

/** The renders' names, in order. */
const names = (): string[] => renders(loadTunables()).map((r) => r.name);

(window as unknown as { sounds: { render: typeof render; names: typeof names; ready: boolean } }).sounds = { render, names, ready: true };
