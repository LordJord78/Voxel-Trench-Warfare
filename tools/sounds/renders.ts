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
 * of a voice's energy lies over it. The shooter's own under the gun (MIX): the kill's loudest 50 ms at
 * or under the AK report's, the hit's, the head's and the gush's 2 dB or more under it, on the mean of
 * their draws. The gush gushes: most of it in 400 Hz–2 kHz, and as loud over its
 * loudest 50 ms as the kill's thud, within 3 dB (the kill's part under 400 Hz: its chime, louder, is
 * not the thud). A steel plate rings at the plate, so it is heard from the
 * spawn at the range's nearest and farthest plates too, the farthest held to a floor: its ring is the
 * shooter's only word of a hit there. And a headshot that kills, as its shooter hears it on the range,
 * the crack and the gush and a frame later the kill: a good share of its first 300 ms in 400 Hz–2 kHz
 * (which the kill's chime alone gives it), and its energy there over the same kill without the gush
 * (rendered as well, held to its peak alone), so the gush is not lost in the mix. The hands' cues (combat/handling.ts), each at the ear as planVoices
 * places it, at hands_gain, held to the peak range and the small speaker. The reports (the shots spec's
 * §6, G5's Task 2 and its final review): the front's, FRONT_M ahead, the player's own at the muzzle from
 * every gun (the SVD bare and suppressed), an AK burst and a long M249 burst, each heard with the shared
 * tail (its file runs the tail's length past its own layers). Their weight is held in order, by 0.5 dB
 * on the mean of their draws (the M870 and the SVD over the AK, the AK and the M4 over both pistols); the
 * M870's and the SVD's tails, and the AK burst's
 * after its last report, from both sides (TailRule); the M870's and the pistol's own bodies in their
 * bands; the suppressed SVD's loudest 50 ms under the bare one's, its tone brighter than it, and over
 * its own reload's mag-out; and the M249's burst under the peak's ceiling, its twenty noise draws
 * reaching hotter than one report's over its stacking tail. And
 * every other voice's kind, each as planVoices plans it from its event where the game plays it whole
 * (one heard afar within reference_m; a distant gun at its range's nearest), held to the peak's range:
 * every VoiceKind has its <kind>.wav. One only reported (`gated` false)
 * says what fails of it and does not fail the run.
 *
 * Each shot's body and every noise are drawn (audio/voices.ts), so one render is one shot. Those the
 * rules read on the mean (DRAWN) are rendered DRAWS times: their rules hold on the mean of their draws,
 * what a player hears over many shots, and their peaks on every draw (tools/lib/sound-measures.mjs
 * checkDraws).
 */

import { hitFeedbackTunables } from '../../src/app/hit-feedback';
import { noBattleEvents, type BattleEvents } from '../../src/battle/director';
import { CUE_NAMES } from '../../src/audio/cues';
import { audioTunables, planFeedback, planVoices, type FeedbackKind, type VoicePlan } from '../../src/audio/plan';
import { armSpec } from '../../src/combat/arsenal';
import type { Impact } from '../../src/combat/ballistics';
import type { HandlingCue } from '../../src/combat/handling';
import { REPORT_S, reportShape, voiceLength } from '../../src/audio/voices';
import { rangeTunables } from '../../src/combat/range';
import type { Tunables } from '../../src/core/tunables';
import { BARE, encodeShotMark, type GunKey } from '../../src/net/gear';
import type { CombatEvents, ShotEvent } from '../../src/sim/session';
import { P } from '../../src/world/materials';
import type { SoundRules, TailRule } from '../lib/sound-measures.mjs';

/** Every file's rate (Hz). */
export const RATE = 48000;
/**
 * How many times a render in DRAWN is rendered (G5's fix wave, resumed a second time: the controller's
 * ruling E): its named seed and eight more (page.ts seeds draw k by `<name>~k`). Each shot's body is
 * drawn a little about its gun's (item 8) and its noise afresh, as the game plays a magazine, so a gate
 * read on one draw reads one shot: the reports' order spread over 2 dB across nine. Their mean is what a
 * player hears over many shots.
 */
export const DRAWS = 9;
/**
 * How long each render's context runs before its file starts (s), silent, cut from the file: the
 * master compressor settling. Chrome's DynamicsCompressorNode starts from its reset state, and over its
 * first 0.15 s it cuts what a settled one passes (a tone into it at -27.5 dBFS, its first 5 ms: cut
 * 7.0 dB at 10 ms and 1.5 dB at 30 ms, lifted 1.2 dB at 50 ms, and by its whole make-up, 4.28 dB, from
 * 0.15 s on; one at +0.4 dBFS cut 8.9 dB at 10 ms, 3.1 dB settled). The game's context runs from the
 * click that starts play, so no shot is heard so. Over three times what it takes.
 */
export const SETTLE_S = 0.5;
/** Silence before a voice starts in its file (s). */
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
  /** How many times it is rendered: DRAWS for those in DRAWN, held on their mean and their peaks on every draw; 1 for the rest. */
  draws: number;
  /** What it is held to besides its peak's range: a band, the small speaker, a floor, another render's level, or over another's energy in a band. */
  rules?: SoundRules;
}

const EARS: readonly FeedbackKind[] = ['hit', 'head', 'gush', 'kill', 'ding', 'hurt'];
/** The small speaker: at least this share of a voice's energy over 400 Hz. */
const SMALL_SPEAKER = 0.25;
/**
 * The hits' voices under the gun (the controller's ruling, resumed a second time): each one's loudest
 * 50 ms at least so many dB under the AK report's, on the mean of their draws. Settled, the kill
 * (-10.7 dBFS) and the gush (-13.6) were heard over every report. Being hit, and a plate's ring afar,
 * are not held to it.
 */
const MIX: Partial<Record<FeedbackKind, SoundRules>> = {
  hit: { under: { of: 'report-ak', db: 2 } },
  head: { under: { of: 'report-ak', db: 2 } },
  gush: { under: { of: 'report-ak', db: 2 } },
  kill: { under: { of: 'report-ak', db: 0 } },
};
/**
 * The renders drawn DRAWS times: those a rule read on the mean reads (the reports' order, the suppressed
 * SVD's against the bare one and its mag-out, the gush's band and its kill, the hits' voices under the AK
 * report), and the bursts, whose peaks hold on every draw. Every other render is drawn once.
 */
const DRAWN: readonly string[] = ['hit', 'head', 'gush', 'kill', 'mag-out', 'report-ak', 'report-svd', 'report-svd-suppressed', 'report-m870', 'report-pistol', 'report-m4', 'report-pm', 'report-ak-burst', 'report-m249-burst'];
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
/** The player's own gun's muzzle as the listener hears it (metres): half a metre ahead of the ear, a little right and under. */
export const MUZZLE: [number, number, number] = [0.1, -0.1, -0.6];
/** The front's report, this far straight ahead (metres): a rifle across a short stretch of the line. */
export const FRONT_M = 20;
/** The player's own reports: each render's name, its gun, and whether it is suppressed. */
const OWN_REPORTS: readonly (readonly [string, GunKey, boolean])[] = [
  ['report-ak', 'ak74', false],
  ['report-svd', 'svd', false],
  ['report-svd-suppressed', 'svd', true],
  ['report-m870', 'm870', false],
  ['report-pistol', 'm17', false],
  ['report-m4', 'm4', false],
  ['report-mp5', 'mp5', false],
  ['report-m249', 'm249', false],
  ['report-pm', 'pm', false],
];
/** An AK burst: this many reports, this far apart (s; 600 rpm), its last at BURST_LAST_S. */
const BURST = 10;
const BURST_GAP_S = 0.1;
const BURST_LAST_S = 0.9;
/**
 * The reports' weight in order (G5's final review): each held over the next lighter by 0.5 dB on the mean
 * of their draws (the controller's ruling, resumed a second time), its first 80 ms's energy across the
 * band. All read alike, as page.ts reads one over-reading a render.
 */
const ORDER = { band: [20, 20000] as const, firstS: 0.08, db: 0.5 };
/** Over both pistols, each held on its own draws (the ruling asks the AK and the M4 over the pistols): the M17's report and the PM's. */
const OVER_PISTOLS = [{ of: 'report-pistol', ...ORDER }, { of: 'report-pm', ...ORDER }];
/**
 * A long M249 burst (G5's fix wave): this many of its reports at the gun's own rate, held to the peak's
 * range alone. Each report peaks about as a single one does (the compressor settled: 1.6 to 3.5 dB
 * under full scale in the AK's), but twenty draws over the stacking tail reach the hottest, so its
 * −1 dBFS ceiling is what holds the rifles' report_gain.
 */
const LONG_BURST = 20;
/** A single report's tail: its loudest 50 ms after its own layers 3 to 24 dB under its report's (over 24, it is missing). */
const TAIL: TailRule = { afterS: REPORT_S, underDb: [3, 24] };
/**
 * Each gun's own body heard (G5's final review): the share of the first 80 ms in its body's band,
 * halfway between the share with the gun's own body and with the defaults' 140 Hz in its place,
 * measured with the compressor settled (the M870's under 120 Hz 0.726 and 0.458; the pistol's in
 * 130-400 Hz 0.835 and 0.159). A voice that played every gun at 140 Hz fails both.
 */
const M870_BODY = 0.59;
const PISTOL_BODY = 0.5;
/**
 * What each of the player's own reports is held to besides its peak's range: the order (the AK and the
 * M4 over each pistol); the tails of the two the hot tail outweighed; each body in its band; and the
 * suppressed SVD's loudest 50 ms 6 dB or more under the bare one's (G5's review focus), its tone
 * brighter, and its first 50 ms 2 dB over its mag-out's.
 */
const OWN_RULES: Readonly<Record<string, SoundRules>> = {
  'report-ak': { over: OVER_PISTOLS },
  'report-m4': { over: OVER_PISTOLS },
  'report-svd': { over: { of: 'report-ak', ...ORDER }, tail: TAIL },
  'report-svd-suppressed': { under: { of: 'report-svd', db: 6 }, highOver: { of: 'report-svd', by: 0.1 }, over: { of: 'mag-out', band: [20, 20000], firstS: 0.05, db: 2 } },
  'report-m870': { over: { of: 'report-ak', ...ORDER }, tail: TAIL, band: { hz: [20, 120], share: M870_BODY, firstS: 0.08 } },
  'report-pistol': { band: { hz: [130, 400], share: PISTOL_BODY, firstS: 0.08 } },
};

export function renders(tun: Tunables): Render[] {
  const t = audioTunables(tun);
  const gains = hitFeedbackTunables(tun).gains;
  const report = reportShape(tun);
  const ear: [number, number, number] = [0, 0, 0];
  /** A render of `plans`, held: as long as the last of them sounds, from its delay (with the shared tail's length, if it sends there), and the tail. */
  const of = (name: string, plans: VoicePlan[], rules?: SoundRules): Render => ({
    name,
    plans,
    lengthS: LEAD_S + Math.max(...plans.map((p) => p.delayS + voiceLength(p) + ((p.send ?? 0) > 0 ? report.tailS : 0))) + TAIL_S,
    gated: true,
    draws: DRAWN.includes(name) ? DRAWS : 1,
    ...(rules ? { rules } : {}),
  });
  const atEar = (kinds: readonly FeedbackKind[]) => planFeedback(t, kinds.map((kind) => ({ kind, at: null, gain: gains[kind] })), ear);
  const out = EARS.map((kind) => of(kind, atEar([kind]), { high: SMALL_SPEAKER, ...(kind === 'gush' ? GUSH : {}), ...MIX[kind] }));
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
  // The hands' cues (audio/cues.ts), each its own render, as planVoices places it (at the ear, whatever the muzzle it came from).
  for (const cue of CUE_NAMES) {
    const events = cueEvents(cue);
    out.push(of(cue, planVoices(t, events, ear), { high: SMALL_SPEAKER }));
  }
  // The reports and every other kind, each from its event as planVoices hears it (the battle's too).
  const quiet: CombatEvents = { ...cueEvents('dry'), handling: [] };
  const heard = (events: Partial<CombatEvents>, battle?: Partial<BattleEvents>) => planVoices(t, { ...quiet, ...events }, ear, battle && { ...noBattleEvents(), ...battle });
  const shot = (at: [number, number, number]): ShotEvent => ({ tick: 1, origin: at, dir: [0, 0, -1], tracer: false, muzzle: at });
  // The front's report, FRONT_M ahead; the player's own at the muzzle, its word and its report's share as the session gives them.
  out.push(of('report', heard({ frontShots: [shot([0, 0, -FRONT_M])] })));
  for (const [name, gun, suppressed] of OWN_REPORTS) {
    const arm = armSpec(tun, gun, { ...BARE, muzzle: suppressed ? 'suppressor' : 'none' });
    const fired: ShotEvent = { ...shot(MUZZLE), mark: encodeShotMark({ tracer: false, kind: 0, suppressed: arm.suppressed, gun }), report: arm.report };
    out.push(of(name, heard({ shots: [fired] }), OWN_RULES[name]));
  }
  // An AK burst: its report, BURST times BURST_GAP_S apart, the tail stacking; held after the last.
  const [ak] = out.find((r) => r.name === 'report-ak')!.plans;
  out.push(of('report-ak-burst', Array.from({ length: BURST }, (_, k) => ({ ...ak, delayS: k * BURST_GAP_S })), { tail: { afterS: BURST_LAST_S + REPORT_S, underDb: [6, 24] } }));
  // A long M249 burst: its report LONG_BURST times at its own rate, held to the peak's range alone.
  const [m249] = out.find((r) => r.name === 'report-m249')!.plans;
  const m249GapS = 60 / armSpec(tun, 'm249', BARE).weapon.rpm;
  out.push(of('report-m249-burst', Array.from({ length: LONG_BURST }, (_, k) => ({ ...m249, delayS: k * m249GapS }))));
  // Every other kind where the game plays it whole, so its file is the voice itself (farther, the plan
  // only makes it quieter and duller): one heard afar, reference_m off (ahead and under, on the ground),
  // within which its gain is whole; a distant gun's at its range's nearest (a barrage's shell 1 km off,
  // a far shell 200 m, a machine gun's burst 60 m); a round passing a metre off; a scoop at the feet.
  const close: [number, number, number] = [0, -0.6 * t.referenceM, -0.8 * t.referenceM];
  const strike = (material: number): Impact & { tick: number } => ({ tick: 1, position: close, normal: [0, 1, 0], cell: [0, -12, -16], material, speed: 700, distance: 60, energyJ: 1500, owner: 2, spec: 'assault_rifle', dir: [0, 0, -1], kind: 0 });
  out.push(of('crack', heard({ cracks: [{ tick: 1, missM: 1, at: [1, 0, -2] }] })));
  out.push(of('impact-soil', heard({ impacts: [strike(P.SOD)] })));
  out.push(of('impact-timber', heard({ impacts: [strike(P.TIMBER)] })));
  out.push(of('impact-metal', heard({ impacts: [strike(P.PICKET)] })));
  out.push(of('whistle', heard({ incoming: [{ tick: 1, at: close, landsInS: 1.5 }] })));
  out.push(of('blast', heard({ blasts: [{ tick: 1, at: close, radiusM: 3, material: P.SOD, crater: null }] })));
  out.push(of('scrape', heard({ scoops: [{ tick: 1, voxels: 24, at: [0, -1.2, -0.8], cells: [] }] })));
  out.push(of('flare', heard({}, { launches: [{ id: 1, post: close, t0: 0, bearing: 0, elevation: 1.4, burstM: 40, colour: [1, 0.88, 0.7] }] })));
  out.push(of('rumble', heard({}, { distant: [{ id: 1, position: [0, 0, -1000], t: 0, power: 1, far: false }] })));
  out.push(of('thump', heard({}, { distant: [{ id: 2, position: [0, 0, -200], t: 0, power: 1, far: true }] })));
  out.push(of('chatter', heard({}, { bursts: [{ id: 1, gun: [0, 0, -60], t: 0, rounds: 10, rpm: 600 }] })));
  out.push(of('crackle', heard({}, { crackles: [{ at: close, gain: 1 }] })));
  out.push(of('splash', heard({ splashes: [{ tick: 1, at: close, energyJ: 1500, kind: 'round' }] })));
  return out;
}

/**
 * A frame's events with nothing in them but one of the hands' `cue`s, by the gun's muzzle (planVoices
 * places it at the ear wherever it came from): the one such frame this tool builds by hand, which its
 * test shares.
 */
export function cueEvents(cue: HandlingCue): Parameters<typeof planVoices>[1] {
  return { shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [{ tick: 1, cue, at: [0.2, -0.1, -0.5] }], harms: [] };
}
