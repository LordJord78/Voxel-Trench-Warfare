/**
 * The hands' cues' sounds ([audio.cues]; the cues are combat/handling.ts's): each a few tens of
 * milliseconds of filtered noise and clipped tones, made of parts, each at its own time into the cue.
 * audioTunables reads them (plan.ts), planVoices gives each cue's plan its shape, and voices.ts plays
 * the plan as its shape says, so every number of a cue's sound is the tunables'.
 */

import type { HandlingCue } from '../combat/handling';
import type { Tunables } from '../core/tunables';

/**
 * A part of a hands' cue, `atS` into it and `peak` loud (of the voice's gain): a clack, metal on metal
 * (noise in a band about `hz` and a clipped square tone falling from `toneHz`, dying over `decayS`); a
 * burst of noise through a filter (a band's `q`), up to its peak in `attackS` and down over `decayS`; or
 * a tone gliding `fromHz` to `toHz` as it dies over `decayS`.
 */
export type CuePart =
  | { part: 'clack'; atS: number; hz: number; toneHz: number; peak: number; decayS: number }
  | { part: 'burst'; atS: number; filter: 'lowpass' | 'highpass' | 'bandpass'; hz: number; q?: number; peak: number; attackS: number; decayS: number }
  | { part: 'tone'; atS: number; wave: 'sine' | 'square' | 'triangle' | 'sawtooth'; fromHz: number; toHz: number; peak: number; decayS: number };

/** How every clack is made: its noise's band Q, peak and attack; its tone's peak, where it glides to and its decay, each of the clack's own. */
export interface ClackShape {
  q: number;
  noise: number;
  attackS: number;
  tone: number;
  glide: number;
  toneDecay: number;
}

/**
 * A hands' cue's sound, whole: its parts; how long it sounds (s: when it frees its place under the
 * cap); the share of its peak each part falls to before it fades away (voices.ts FALL_FADE_S); and how
 * a clack is made (the last two [audio.cues]'s own, every cue's alike).
 */
export interface CueShape {
  lengthS: number;
  fall: number;
  clack: ClackShape;
  parts: CuePart[];
}

/** Every hands' cue, as combat/handling.ts names them. */
export const CUE_NAMES: readonly HandlingCue[] = ['mag-out', 'mag-in', 'bolt', 'cover', 'shell', 'pump', 'dry'];
const FILTERS = ['lowpass', 'highpass', 'bandpass'] as const;
const WAVES = ['sine', 'square', 'triangle', 'sawtooth'] as const;

/** [audio.cues]: every cue's shape, refusing (by its key) a part it cannot play. */
export function cueShapes(tun: Tunables): Record<HandlingCue, CueShape> {
  const f = (k: string) => tun.f(`audio.cues.${k}`);
  const fall = f('fall');
  const clack: ClackShape = { q: f('clack_q'), noise: f('clack_noise'), attackS: f('clack_attack_s'), tone: f('clack_tone'), glide: f('clack_glide'), toneDecay: f('clack_tone_decay') };
  const cues = {} as Record<HandlingCue, CueShape>;
  for (const cue of CUE_NAMES) {
    const key = `audio.cues.${cue}`;
    const lengthS = tun.f(`${key}.length_s`);
    const raw = tun.get(`${key}.parts`);
    if (!Array.isArray(raw) || raw.length === 0) throw new TypeError(`tunable '${key}.parts' is not a list of parts`);
    const parts = raw.map((r: unknown, i): CuePart => {
      const where = `${key}.parts[${i}]`;
      const o = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
      const n = (name: string): number => {
        const v = o[name];
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`tunable '${where}.${name}' is not a finite number: ${String(v)}`);
        return v;
      };
      const one = <T extends string>(name: string, of: readonly T[]): T => {
        const v = o[name];
        if (!of.includes(v as T)) throw new TypeError(`tunable '${where}.${name}' is not one of ${of.join(', ')}: ${String(v)}`);
        return v as T;
      };
      switch (o.part) {
        case 'clack':
          return { part: 'clack', atS: n('at_s'), hz: n('hz'), toneHz: n('tone_hz'), peak: n('peak'), decayS: n('decay_s') };
        case 'burst':
          return { part: 'burst', atS: n('at_s'), filter: one('filter', FILTERS), hz: n('hz'), ...(o.q === undefined ? {} : { q: n('q') }), peak: n('peak'), attackS: n('attack_s'), decayS: n('decay_s') };
        case 'tone':
          return { part: 'tone', atS: n('at_s'), wave: one('wave', WAVES), fromHz: n('from_hz'), toHz: n('to_hz'), peak: n('peak'), decayS: n('decay_s') };
        default:
          throw new TypeError(`tunable '${where}.part' is not a clack, a burst or a tone: ${String(o.part)}`);
      }
    });
    cues[cue] = { lengthS, fall, clack, parts };
  }
  return cues;
}
