import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VoicePlan } from '../../src/audio/plan';
import { cueShapes, playVoice, reportShape, voiceLength, type CueShapes } from '../../src/audio/voices';
import type { HandlingCue } from '../../src/combat/handling';
import { loadTunables, Tunables } from '../../src/core/tunables';

// The hands' cues' sounds (combat/handling.ts's cues, audio/voices.ts) from [audio.cues]: each a few
// parts (a clack, a burst of filtered noise, a tone), each at its own time into the cue, and how long
// the cue sounds; played as their shapes say, so every number of theirs is the tunables'.

const tun = loadTunables();
const report = reportShape(tun);
const CUES: readonly HandlingCue[] = ['mag-out', 'mag-in', 'bolt', 'cover', 'shell', 'pump', 'dry'];

/** What a voice made of WebAudio: each node made (its kind and options), and each source or oscillator started (when). */
interface Made {
  node: string;
  opts: Record<string, unknown>;
  started?: number;
}
let made: Made[] = [];
const saved: Record<string, unknown> = {};

/** A stand-in for the WebAudio nodes playVoice makes: it records them and what is started when. */
function stubAudio(): void {
  class Param {
    setValueAtTime() {}
    linearRampToValueAtTime() {}
    exponentialRampToValueAtTime() {}
    cancelScheduledValues() {}
  }
  class Node {
    readonly record: Made;
    constructor(_ctx: unknown, opts: Record<string, unknown> = {}) {
      this.record = { node: new.target.name, opts };
      made.push(this.record);
    }
    connect<T>(to: T): T {
      return to;
    }
    start(when = 0) {
      this.record.started = when;
    }
    stop() {}
  }
  class GainNode extends Node {
    gain = new Param();
  }
  class BiquadFilterNode extends Node {
    frequency = new Param();
  }
  class OscillatorNode extends Node {
    frequency = new Param();
  }
  class AudioBufferSourceNode extends Node {}
  class PannerNode extends Node {}
  class PeriodicWave {}
  const stubs = { GainNode, BiquadFilterNode, OscillatorNode, AudioBufferSourceNode, PannerNode, PeriodicWave };
  for (const [name, value] of Object.entries(stubs)) {
    saved[name] = (globalThis as Record<string, unknown>)[name];
    (globalThis as Record<string, unknown>)[name] = value;
  }
}

/** The nodes `cue` makes, played at 0 from `shapes`. */
function play(cue: HandlingCue, shapes: CueShapes): Made[] {
  made = [];
  const plan: VoicePlan = { kind: cue, at: [0, 0, 0], delayS: 0, gain: 1, lowpassHz: 18000 };
  playVoice({} as BaseAudioContext, {} as AudioNode, { duration: 2 } as AudioBuffer, plan, 0, report, shapes);
  // Past the panner, the distance's lowpass and the voice's level, which every voice has.
  return made.slice(3);
}

describe("the hands' cues' sounds", () => {
  beforeAll(stubAudio);
  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[name] = value;
  });

  it('[audio.cues] holds each cue: its parts and how long it sounds, as they were drawn in voices.ts', () => {
    const shapes = cueShapes(tun);
    expect(Object.keys(shapes.cues).sort()).toEqual([...CUES].sort());
    expect(shapes.fall).toBe(0.05);
    expect(shapes.clack).toEqual({ q: 1.2, noise: 2.2, attackS: 0.0005, tone: 0.18, glide: 0.7, toneDecay: 0.8 });
    // How long each sounds (for the cap), as before: the magazine out 60 ms, in 40 ms, the bolt's rack
    // over 120 ms, the cover 50 ms, a shell 30 ms, the pump's two clacks 90 ms apart, a dry click 15 ms.
    expect(Object.fromEntries(CUES.map((c) => [c, shapes.cues[c].lengthS]))).toEqual({ 'mag-out': 0.07, 'mag-in': 0.05, bolt: 0.13, cover: 0.06, shell: 0.04, pump: 0.13, dry: 0.02 });
    expect(shapes.cues.pump.parts).toEqual([
      { part: 'clack', atS: 0, hz: 1500, toneHz: 640, peak: 1, decayS: 0.03 },
      { part: 'clack', atS: 0.09, hz: 1900, toneHz: 760, peak: 1, decayS: 0.03 },
    ]);
    expect(shapes.cues.dry.parts).toEqual([
      { part: 'burst', atS: 0, filter: 'highpass', hz: 3000, peak: 1.4, attackS: 0.0005, decayS: 0.0145 },
      { part: 'tone', atS: 0, wave: 'square', fromHz: 2600, toHz: 2100, peak: 0.12, decayS: 0.012 },
    ]);
    for (const cue of CUES) {
      const plan: VoicePlan = { kind: cue, at: [0, 0, 0], delayS: 0, gain: 0.5, lowpassHz: 18000 };
      expect(voiceLength(plan, report, shapes), cue).toBe(shapes.cues[cue].lengthS);
      // Every part sounds within it.
      for (const p of shapes.cues[cue].parts) expect(p.atS + ('attackS' in p ? p.attackS : 0) + p.decayS, cue).toBeLessThanOrEqual(shapes.cues[cue].lengthS);
    }
  });

  it('a cue is played as its shape says: the pump two clacks, each a band of noise and a square tone, the second 90 ms on; moved in the tunables, moved in the sound', () => {
    const shapes = cueShapes(tun);
    const nodes = play('pump', shapes);
    const bands = nodes.filter((n) => n.node === 'BiquadFilterNode').map((n) => [n.opts.type, n.opts.frequency, n.opts.Q]);
    expect(bands).toEqual([
      ['bandpass', 1500, 1.2],
      ['bandpass', 1900, 1.2],
    ]);
    const tones = nodes.filter((n) => n.node === 'OscillatorNode').map((n) => [n.opts.type, n.opts.frequency, n.started]);
    expect(tones).toEqual([
      ['square', 640, 0],
      ['square', 760, 0.09],
    ]);
    // The same cue drawn otherwise: a third clack, later and higher; a tone of its own.
    const pump = shapes.cues.pump;
    const other: CueShapes = {
      ...shapes,
      clack: { ...shapes.clack, q: 3 },
      cues: { ...shapes.cues, pump: { lengthS: 0.3, parts: [...pump.parts, { part: 'clack', atS: 0.2, hz: 2500, toneHz: 900, peak: 0.5, decayS: 0.05 }, { part: 'tone', atS: 0.1, wave: 'sine', fromHz: 300, toHz: 200, peak: 0.2, decayS: 0.04 }] } },
    };
    const again = play('pump', other);
    expect(again.filter((n) => n.node === 'BiquadFilterNode').map((n) => [n.opts.frequency, n.opts.Q])).toEqual([
      [1500, 3],
      [1900, 3],
      [2500, 3],
    ]);
    expect(again.filter((n) => n.node === 'OscillatorNode').map((n) => [n.opts.type, n.opts.frequency, n.started])).toEqual([
      ['square', 640, 0],
      ['square', 760, 0.09],
      ['square', 900, 0.2],
      ['sine', 300, 0.1],
    ]);
    expect(voiceLength({ kind: 'pump', at: [0, 0, 0], delayS: 0, gain: 1, lowpassHz: 18000 }, report, other)).toBe(0.3);
    // Every cue makes something, and only from its shape: a burst's filter as its part says.
    for (const cue of CUES) expect(play(cue, shapes).length, cue).toBeGreaterThan(0);
    const dry = play('dry', shapes);
    expect(dry.filter((n) => n.node === 'BiquadFilterNode').map((n) => [n.opts.type, n.opts.frequency])).toEqual([['highpass', 3000]]);
  });

  it('refuses a cue part it cannot play, naming it', () => {
    const raw = tun.raw();
    const audio = raw.audio as Record<string, Record<string, Record<string, unknown>>>;
    (audio.cues.pump.parts as Record<string, unknown>[])[1] = { part: 'whistle', at_s: 0 };
    expect(() => cueShapes(new Tunables(raw))).toThrow(/audio\.cues\.pump\.parts\[1\]/);
    const missing = tun.raw();
    delete (missing.audio as Record<string, Record<string, unknown>>).cues.dry;
    expect(() => cueShapes(new Tunables(missing))).toThrow(/audio\.cues\.dry/);
  });
});
