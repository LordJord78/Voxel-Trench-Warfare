/**
 * The sounds' proof's page (tools/render-sounds.mjs serves it through Vite): each render of renders.ts
 * played through audio/voices.ts's own playVoice into the engine's own mix (audio/engine.ts mixInto:
 * the master gain and the compressor; and its shared tail, engine.ts tailInto, which a report sends to)
 * in an OfflineAudioContext at RATE, and read there with both ears
 * together (tools/lib/sound-measures.mjs: its peak, RMS and loudest 50 ms, its shares by an FFT, a
 * band rule's own share, an `over` rule's reading, of the render held over another and of that
 * other alike, and a `tail` rule's, its report's loudest 50 ms and its tail's). The context has four
 * channels: 0 and 1 are what the game puts out, left and right; 2 and 3 the mix before the compressor,
 * left and right: how hard the voice drives it. It runs SETTLE_S silent first, while the compressor
 * settles from its start as the game's has by its first shot, and the file is what follows.
 *
 * Its noise and its draws (a noise's offset, the gush's flutter, each report's body) come from
 * Math.random, seeded here for each render by its name, so a file renders the same every run. A render
 * drawn more than once (renders.ts DRAWS) is rendered again for each further draw k, seeded by
 * `<name>~k`, and each draw read alike; its file is its named seed's.
 */

import { audioTunables, type AudioTunables } from '../../src/audio/plan';
import { mixInto, tailInto, whiteNoise } from '../../src/audio/engine';
import { playVoice, reportShape, type ReportShape } from '../../src/audio/voices';
import { loadTunables } from '../../src/core/tunables';
import { measure, ruleEnergyDb, ruleShare, ruleTail, type Measured, type OverRule } from '../lib/sound-measures.mjs';
import { LEAD_S, RATE, renders, SETTLE_S, type Render } from './renders';

/** A render done: its file's samples (base64 of float32, left and right), and both mixes read. */
export interface Rendered {
  name: string;
  rate: number;
  lengthS: number;
  gated: boolean;
  rules: Render['rules'] | null;
  plans: Render['plans'];
  /** How many draws it asks (renders.ts). */
  draws: number;
  /** What the game puts out on its named seed: base64 of each ear's float32 samples, left then right. */
  samples: [string, string];
  /** What the game puts out on its named seed, read; with the band rule's own share if it has one, an `over` rule's reading if it has one or another's names it, and a `tail` rule's if it has one. */
  heard: Measured;
  /** The mix before the compressor on its named seed, read. */
  into: Measured;
  /** Each draw, its named seed's first: what the game puts out, and the mix before the compressor, each read as `heard` and `into` are. */
  drawn: { heard: Measured; into: Measured }[];
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

/** Draw `k` of render `name`'s seed: its name for the named draw, `<name>~k` for each further one. */
const drawSeed = (name: string, k: number) => (k === 0 ? name : `${name}~${k}`);

/**
 * One draw of `r`, Math.random seeded by `seed`: rendered after SETTLE_S of silence, cut from its file,
 * and read; `over`, the `over` rule its reading is taken for, if any.
 */
async function renderDraw(r: Render, seed: string, t: AudioTunables, report: ReportShape, over: OverRule | undefined): Promise<{ ears: [Float32Array, Float32Array]; heard: Measured; into: Measured }> {
  Math.random = seeded(seedOf(seed));
  // SETTLE_S of silence first, while the compressor settles, cut from the file: its voices from SETTLE_S + LEAD_S.
  const from = Math.round(SETTLE_S * RATE);
  const length = Math.ceil(r.lengthS * RATE);
  const ctx = new OfflineAudioContext({ numberOfChannels: 4, length: from + length, sampleRate: RATE });
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
  const tail = tailInto(ctx, mix, report);
  for (const v of r.plans) playVoice(ctx, mix, noise, v, from / RATE + LEAD_S + v.delayS, report, tail);
  const buffer = await ctx.startRendering();
  const file = (k: number) => buffer.getChannelData(k).subarray(from, from + length);
  const heard: [Float32Array, Float32Array] = [file(0), file(1)];
  const into = [file(2), file(3)];
  const band = r.rules?.band;
  const tailRule = r.rules?.tail;
  return {
    ears: heard,
    heard: {
      ...measure(heard, RATE),
      ...(band ? { ruleShare: ruleShare(heard, RATE, band) } : {}),
      ...(over ? { overDb: ruleEnergyDb(heard, RATE, { hz: over.band, firstS: over.firstS }) } : {}),
      ...(tailRule ? ruleTail(heard, RATE, tailRule) : {}),
    },
    into: measure(into, RATE),
  };
}

/** Render each of renders.ts's list (those named in `only`, if given), in its order, each as many times as it is drawn. */
async function render(only: string[] | null = null): Promise<Rendered[]> {
  const tun = loadTunables();
  const t = audioTunables(tun);
  const report = reportShape(tun);
  const out: Rendered[] = [];
  const random = Math.random;
  const all = renders(tun);
  // A render another is held over is read as that rule reads it.
  const under = new Map<string, OverRule>();
  for (const r of all) if (r.rules?.over) under.set(r.rules.over.of, r.rules.over);
  try {
    for (const r of all) {
      if (only && !only.includes(r.name)) continue;
      const over = r.rules?.over ?? under.get(r.name);
      const drawn: Rendered['drawn'] = [];
      let ears: [Float32Array, Float32Array] | null = null;
      for (let k = 0; k < r.draws; k++) {
        const d = await renderDraw(r, drawSeed(r.name, k), t, report, over);
        if (k === 0) ears = d.ears;
        drawn.push({ heard: d.heard, into: d.into });
      }
      out.push({
        name: r.name,
        rate: RATE,
        lengthS: r.lengthS,
        gated: r.gated,
        rules: r.rules ?? null,
        plans: r.plans,
        draws: r.draws,
        samples: ears ? [base64(ears[0]), base64(ears[1])] : ['', ''],
        heard: drawn[0]?.heard,
        into: drawn[0]?.into,
        drawn,
      });
    }
  } finally {
    Math.random = random;
  }
  return out;
}

/** The renders, in order: each one's name, and the renders its level is held to, over and under, and its tone over, if any (for --only). */
const list = (): { name: string; near: string | null; over: string | null; under: string | null; highOver: string | null }[] =>
  renders(loadTunables()).map((r) => ({ name: r.name, near: r.rules?.near?.of ?? null, over: r.rules?.over?.of ?? null, under: r.rules?.under?.of ?? null, highOver: r.rules?.highOver?.of ?? null }));

(window as unknown as { sounds: { render: typeof render; list: typeof list; ready: boolean } }).sounds = { render, list, ready: true };
