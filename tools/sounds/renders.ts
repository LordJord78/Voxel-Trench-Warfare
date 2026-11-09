/**
 * What the sounds' proof renders (npm run sounds; the shots spec's §6), each to its own WAV: a list of
 * renders, each the voices it plays as the game plans them (audio/plan.ts) for a listener at the origin
 * facing −z, how long its file is, whether its peak is held to the range (tools/lib/sound-measures.mjs),
 * and any band its energy must lie mostly in. The page (page.ts) plays each through audio/voices.ts's
 * own playVoice into the engine's own mix (audio/engine.ts mixInto), offline.
 *
 * The hits' voices (the shots spec's §4): each at the ear, as the shooter hears it, at its [hits] gain,
 * held to the range; the gush held to 400 Hz–2 kHz. A steel plate rings at the plate, so it is heard
 * from the spawn at the range's nearest and farthest plates too; and a headshot that kills as its
 * shooter hears it, the crack, the gush and the kill at once. Those are reported (what distance leaves
 * of a ring; how the gush stands in the mix), not held. More kinds (the reports, the hands' cues) join
 * the list as theirs are made.
 */

import { hitFeedbackTunables } from '../../src/app/hit-feedback';
import { audioTunables, planFeedback, type FeedbackKind, type VoicePlan } from '../../src/audio/plan';
import { voiceLength, type ReportShape } from '../../src/audio/voices';
import { rangeTunables } from '../../src/combat/range';
import type { Tunables } from '../../src/core/tunables';

/** Every file's rate (Hz). */
export const RATE = 48000;
/** Silence before a voice starts (s). */
export const LEAD_S = 0.01;
/** A file runs this far past its last voice's end (s). */
export const TAIL_S = 0.1;

export interface Render {
  /** Its file's name, `<name>.wav`. */
  name: string;
  /** What it plays, as the game plans it, from LEAD_S on. */
  plans: VoicePlan[];
  /** Its file's length (s). */
  lengthS: number;
  /** Its peak held to the range (a failure fails the run), or only reported. */
  gated: boolean;
  /** A band (Hz) more than `share` of its energy must lie in. */
  band?: { band: [number, number]; share: number };
}

/** The report's body the engine is given (app/main.ts): voiceLength needs it, and the reports will. */
export function reportShape(tun: Tunables): ReportShape {
  return { lowHz: tun.f('viewkick.defaults.report_low_hz'), lengthS: tun.f('viewkick.defaults.report_length_s') };
}

const FEEDBACK: readonly FeedbackKind[] = ['hit', 'head', 'gush', 'kill', 'ding', 'hurt'];
/** What the shooter hears of a headshot that kills (app/hit-feedback.ts), all at once at the ear. */
const HEADSHOT_KILL: readonly FeedbackKind[] = ['head', 'gush', 'kill'];
/** The gush's band, and the share of its energy that must lie in it (the spec's "mostly"). */
const GUSH_BAND = { band: [400, 2000] as [number, number], share: 0.5 };

export function renders(tun: Tunables): Render[] {
  const t = audioTunables(tun);
  const gains = hitFeedbackTunables(tun).gains;
  const report = reportShape(tun);
  const ear: [number, number, number] = [0, 0, 0];
  /** A render of `plans`: as long as the last of them sounds, from its delay, and the tail. */
  const of = (name: string, plans: VoicePlan[], gated: boolean, band?: Render['band']): Render => ({
    name,
    plans,
    lengthS: LEAD_S + Math.max(...plans.map((p) => p.delayS + voiceLength(p, report))) + TAIL_S,
    gated,
    ...(band ? { band } : {}),
  });
  const out = FEEDBACK.map((kind) => of(kind, planFeedback(t, [{ kind, at: null, gain: gains[kind] }], ear), true, kind === 'gush' ? GUSH_BAND : undefined));
  // A plate's ring heard from the spawn, straight ahead, at the nearest and farthest plates.
  const r = rangeTunables(tun);
  const plates = [...r.torsoPlatesM, ...r.headPlatesM];
  for (const d of [Math.min(...plates), Math.max(...plates)]) out.push(of(`ding-${d}m`, planFeedback(t, [{ kind: 'ding', at: [0, 0, -d], gain: gains.ding }], ear), false));
  // A headshot that kills, as its shooter hears it: the crack, the gush, and the kill's thud and chime at once.
  out.push(of('headshot-kill', planFeedback(t, HEADSHOT_KILL.map((kind) => ({ kind, at: null, gain: gains[kind] })), ear), false));
  return out;
}
