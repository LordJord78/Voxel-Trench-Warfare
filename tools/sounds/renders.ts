/**
 * What the sounds' proof renders (npm run sounds; the shots spec's §6, G3's Task 5), each to its own
 * stereo WAV: a list of renders, each the voices it plays as the game plans them (audio/plan.ts) for a
 * listener at the origin facing −z, how long its file is, whether a failure of it fails the run
 * (`gated`), and what it is held to besides its peak's range (tools/lib/sound-measures.mjs checkSound).
 * The page (page.ts) plays each through audio/voices.ts's own playVoice into the engine's own mix
 * (audio/engine.ts mixInto), offline.
 *
 * The hits' voices (the shots spec's §4), each at the ear as the shooter hears it, at its [hits] gain,
 * and each held to the small speaker: a laptop barely plays what is under 400 Hz, so at least a quarter
 * of a voice's energy lies over it. The gush gushes: most of it in 400 Hz–2 kHz, and as loud over its
 * loudest 50 ms as the kill's thud, within 3 dB (the kill's part under 400 Hz: its chime, louder, is
 * not the thud). A steel plate rings at the plate, so it is heard from the
 * spawn at the range's nearest and farthest plates too, the farthest held to a floor: its ring is the
 * shooter's only word of a hit there. And a headshot that kills, as its shooter hears it on the range,
 * the crack and the gush and a frame later the kill: a good share of its first 300 ms in 400 Hz–2 kHz
 * (which the kill's chime alone gives it), and its energy there over the same kill without the gush
 * (rendered as well, held to its peak alone), so the gush is not lost in the mix. The hands' cues (combat/handling.ts), each at the ear as planVoices
 * places it, at hands_gain, held to the peak range and the small speaker. More kinds (the reports) join
 * the list as theirs are made; one only reported (`gated` false) says what fails of it and does not
 * fail the run.
 */

import { hitFeedbackTunables } from '../../src/app/hit-feedback';
import { audioTunables, planFeedback, planVoices, type FeedbackKind, type VoicePlan } from '../../src/audio/plan';
import type { HandlingCue } from '../../src/combat/handling';
import { reportShape, voiceLength } from '../../src/audio/voices';
import { rangeTunables } from '../../src/combat/range';
import type { Tunables } from '../../src/core/tunables';
import type { SoundRules } from '../lib/sound-measures.mjs';

/** Every file's rate (Hz). */
export const RATE = 48000;
/** Silence before a voice starts (s). */
export const LEAD_S = 0.01;
/** A file runs this far past its last voice's end (s). */
export const TAIL_S = 0.1;
/**
 * A frame at 60 Hz (s): the range's kill is fed back after the frame's hits, and its voice plays with
 * the next frame's (app/main.ts), a frame after the headshot's crack and gush. A room's kill comes later
 * still, by the round trip; the range's is the nearest, where the kill's thud masks the gush the most.
 */
export const FRAME_S = 1 / 60;

export interface Render {
  /** Its file's name, `<name>.wav`. */
  name: string;
  /** What it plays, as the game plans it, from LEAD_S on. */
  plans: VoicePlan[];
  /** Its file's length (s). */
  lengthS: number;
  /** A failure of it fails the run, or it is only reported. */
  gated: boolean;
  /** What it is held to besides its peak's range: a band, the small speaker, a floor, another render's level, or over another's energy in a band. */
  rules?: SoundRules;
}

const EARS: readonly FeedbackKind[] = ['hit', 'head', 'gush', 'kill', 'ding', 'hurt'];
/** The hands' cues, each its own render. */
const CUES: readonly HandlingCue[] = ['mag-out', 'mag-in', 'bolt', 'cover', 'shell', 'pump', 'dry'];
/** The small speaker: at least this share of a voice's energy over 400 Hz. */
const SMALL_SPEAKER = 0.25;
/** The gush gushes: at least this share of its energy in 400 Hz–2 kHz, and its loudest 50 ms within 3 dB of the kill thud's (the kill's part under 400 Hz, apart from its chime). */
const GUSH: SoundRules = { band: { hz: [400, 2000], share: 0.55 }, near: { of: 'kill', withinDb: 3, low: true } };
/**
 * A headshot that kills: at least this share of its first 300 ms's energy in 400 Hz–2 kHz; and its
 * energy there at least 1.0 dB over the same kill's without the gush, read alike (the controller's ruling: a missing gush
 * reads 0.0 dB, and 1.0 leaves room for a chime lift at the playtest), so the gush is not
 * lost under the kill. The share alone can't tell: the kill's chime (880 and 1320 Hz) fills the band
 * (0.527 without the gush, 0.532 with it).
 */
const HEADSHOT_KILL: SoundRules = { band: { hz: [400, 2000], share: 0.35, firstS: 0.3 }, over: { of: 'headshot-kill-dry', band: [400, 2000], firstS: 0.3, db: 1.0 } };
/** The farthest plate's ring heard from the spawn: its peak at least this (dBFS). */
const FAR_DING_DB = -24;

export function renders(tun: Tunables): Render[] {
  const t = audioTunables(tun);
  const gains = hitFeedbackTunables(tun).gains;
  const report = reportShape(tun);
  const ear: [number, number, number] = [0, 0, 0];
  /** A render of `plans`, held: as long as the last of them sounds, from its delay, and the tail. */
  const of = (name: string, plans: VoicePlan[], rules?: SoundRules): Render => ({
    name,
    plans,
    lengthS: LEAD_S + Math.max(...plans.map((p) => p.delayS + voiceLength(p, report))) + TAIL_S,
    gated: true,
    ...(rules ? { rules } : {}),
  });
  const atEar = (kinds: readonly FeedbackKind[]) => planFeedback(t, kinds.map((kind) => ({ kind, at: null, gain: gains[kind] })), ear);
  const out = EARS.map((kind) => of(kind, atEar([kind]), { high: SMALL_SPEAKER, ...(kind === 'gush' ? GUSH : {}) }));
  // A plate's ring heard from the spawn, straight ahead, at the nearest and farthest plates.
  const r = rangeTunables(tun);
  const plates = [...r.torsoPlatesM, ...r.headPlatesM];
  const [near, far] = [Math.min(...plates), Math.max(...plates)];
  for (const d of [near, far]) out.push(of(`ding-${d}m`, planFeedback(t, [{ kind: 'ding', at: [0, 0, -d], gain: gains.ding }], ear), d === far ? { floorDb: FAR_DING_DB } : undefined));
  // A headshot that kills, as its shooter hears it on the range: the crack and the gush, and a frame later the kill's thud and chime.
  const [kill] = atEar(['kill']);
  out.push(of('headshot-kill', [...atEar(['head', 'gush']), { ...kill, delayS: FRAME_S }], HEADSHOT_KILL));
  // The same without the gush: what headshot-kill is held over.
  out.push(of('headshot-kill-dry', [...atEar(['head']), { ...kill, delayS: FRAME_S }]));
  // The hands' cues, each as planVoices places it (at the ear, whatever the muzzle it came from).
  for (const cue of CUES) {
    const events = { shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [{ tick: 1, cue, at: [0.2, -0.1, -0.5] as [number, number, number] }], harms: [] };
    out.push(of(cue, planVoices(t, events, ear), { high: SMALL_SPEAKER }));
  }
  return out;
}
