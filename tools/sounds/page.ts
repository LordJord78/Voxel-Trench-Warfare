/**
 * The sounds' proof's page (tools/render-sounds.mjs serves it through Vite): each render of renders.ts
 * played through audio/voices.ts's own playVoice into the engine's own mix (audio/engine.ts mixInto:
 * the master gain and the compressor) in an OfflineAudioContext at RATE, and read there with both ears
 * together (tools/lib/sound-measures.mjs: its peak, RMS and loudest 50 ms, its shares by an FFT, and a
 * band rule's own share). The context has four channels: 0 and 1 are what the game puts out, left and
 * right; 2 and 3 the mix before the compressor, left and right: how hard the voice drives it.
 *
 * Its noise and its draws (a noise's offset, the gush's flutter) come from Math.random, seeded here for
 * each render by its name, so a file renders the same every run.
 */

import { audioTunables } from '../../src/audio/plan';
import { mixInto, whiteNoise } from '../../src/audio/engine';
import { playVoice, reportShape } from '../../src/audio/voices';
import { loadTunables } from '../../src/core/tunables';
import { measure, ruleShare, type Measured } from '../lib/sound-measures.mjs';
import { LEAD_S, RATE, renders, type Render } from './renders';

/** A render done: its file's samples (base64 of float32, left and right), and both mixes read. */
export interface Rendered {
  name: string;
  rate: number;
  lengthS: number;
  gated: boolean;
  rules: Render['rules'] | null;
  plans: Render['plans'];
  /** What the game puts out: base64 of each ear's float32 samples, left then right. */
  samples: [string, string];
  /** What the game puts out, read; with the band rule's own share if it has one. */
  heard: Measured;
  /** The mix before the compressor, read. */
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
      const ctx = new OfflineAudioContext({ numberOfChannels: 4, length: Math.ceil(r.lengthS * RATE), sampleRate: RATE });
      ctx.destination.channelInterpretation = 'discrete';
      // Channels 0 and 1, what the game puts out (left, right); 2 and 3, the mix before the compressor.
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 4 });
      merger.connect(ctx.destination);
      const heardEars = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      const intoEars = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      for (const [ears, first] of [[heardEars, 0], [intoEars, 2]] as const) for (const ear of [0, 1]) ears.connect(merger, ear, first + ear);
      const mix = mixInto(ctx, t.masterGain, heardEars);
      mix.connect(intoEars);
      const noise = whiteNoise(ctx);
      for (const v of r.plans) playVoice(ctx, mix, noise, v, LEAD_S + v.delayS, report);
      const buffer = await ctx.startRendering();
      const heard = [buffer.getChannelData(0), buffer.getChannelData(1)];
      const into = [buffer.getChannelData(2), buffer.getChannelData(3)];
      const band = r.rules?.band;
      out.push({
        name: r.name,
        rate: RATE,
        lengthS: r.lengthS,
        gated: r.gated,
        rules: r.rules ?? null,
        plans: r.plans,
        samples: [base64(heard[0]), base64(heard[1])],
        heard: { ...measure(heard, RATE), ...(band ? { ruleShare: ruleShare(heard, RATE, band) } : {}) },
        into: measure(into, RATE),
      });
    }
  } finally {
    Math.random = random;
  }
  return out;
}

/** The renders, in order: each one's name, and the render its level is held to, if any (for --only). */
const list = (): { name: string; near: string | null }[] => renders(loadTunables()).map((r) => ({ name: r.name, near: r.rules?.near?.of ?? null }));

(window as unknown as { sounds: { render: typeof render; list: typeof list; ready: boolean } }).sounds = { render, list, ready: true };
