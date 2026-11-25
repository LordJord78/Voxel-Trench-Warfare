/**
 * What a frame's combat sounds like, before WebAudio makes it (engine.ts): a
 * voice for each shot, crack and strike, placed where it happened (the
 * listener's panner turns it about the head), late by its distance at the
 * speed of sound, quieter and duller with it. The player's own report is at
 * their muzzle, at once and whole; a crack is heard where the round passed, as
 * it passes, louder the nearer. Strikes sound by what they hit — soil thuds,
 * timber knocks, metal rings — and further than `impact_within_m` not at all.
 * A shell whistles from when it is announced until it lands, where it will
 * land, falling in pitch; its blast is heard at any distance, late by it. Each
 * scoop dug scrapes where it was dug, and each flare the battle fires pops and
 * hisses at its post. A fire crackles, each pop heard within `crackle_within_m`. A round into
 * water plips, as near as an impact is heard; a shell landing on it rushes, at any distance.
 *
 * A report (the shots spec's §6) carries its gun's body (`report_body_hz`, its [viewkick.<gun>]'s, by
 * the shot's word; the defaults' for the front's and a word not known) and its weight (`report_gain`,
 * likewise; the front's, none), whether a suppressor muffled it, and its send to the one shared tail
 * (engine.ts): `report_tail_send` of the player's own, half that suppressed, and of one afar less by
 * its distance's share of far_m, the share that dulls it, never under a quarter.
 *
 * A hit's feedback (app/hit-feedback.ts says which; planFeedback places them): the shooter's thwack,
 * crack, gush and kill at the ear, at once and whole; another's hit on a body where it struck, and a
 * steel plate's ring at the plate, each as any voice afar is.
 *
 * The hands' cues (combat/handling.ts: a reload's magazine out and in, its bolt, the machine gun's
 * feed cover, the shotgun's shells and pump, an empty trigger's click) at the ear, at once and whole,
 * at `hands_gain`: the gun is in the player's own hands.
 */

import type { BattleEvents } from '../battle/director';
import { GUN_DEFS } from '../combat/arsenal';
import type { HandlingCue } from '../combat/handling';
import type { Tunables } from '../core/tunables';
import { decodeShotMark, GUNS, type GunKey } from '../net/gear';
import type { CombatEvents, ShotEvent } from '../sim/session';
import { K, kindOf } from '../world/materials';

/** A hit's feedback (the shots spec's §4): a body hit's thwack, a headshot's crack and its gush, a kill's thud and chime, a steel plate's ring, being hit. */
export type FeedbackKind = 'hit' | 'head' | 'gush' | 'kill' | 'ding' | 'hurt';

export type VoiceKind = 'report' | 'crack' | 'impact-soil' | 'impact-timber' | 'impact-metal' | 'whistle' | 'blast' | 'scrape' | 'flare' | 'rumble' | 'thump' | 'chatter' | 'crackle' | 'splash' | FeedbackKind | HandlingCue;

/** A hit's feedback to sound (app/hit-feedback.ts): where (metres; null, at the ear) and how loud there. */
export interface FeedbackVoice {
  kind: FeedbackKind;
  at: [number, number, number] | null;
  gain: number;
}

export interface VoicePlan {
  kind: VoiceKind;
  /** Where it happened, metres. */
  at: [number, number, number];
  /** Seconds after now it is heard. */
  delayS: number;
  gain: number;
  /** What distance leaves of it. */
  lowpassHz: number;
  /** A whistle's time to its landing; a blast's rumble; a distant shell's rumble or thump. */
  lengthS?: number;
  /** A whistle's pitch, falling from and to. */
  fromHz?: number;
  toHz?: number;
  /** A machine gun's burst: its rounds and their rate. */
  rounds?: number;
  rpm?: number;
  /** A report's body (Hz): its gun's report_body_hz. */
  bodyHz?: number;
  /** A report through a suppressor: its body muffled, its crack kept (voices.ts). */
  suppressed?: boolean;
  /** A report's send to the shared tail (engine.ts), a share of it. */
  send?: number;
}

export interface AudioTunables {
  speedOfSound: number;
  masterGain: number;
  referenceM: number;
  rolloff: number;
  /** A steel plate's ring falls off as (reference / distance)^this: gentler than rolloff, as steel rings far. */
  dingRolloff: number;
  farM: number;
  farLowpassHz: number;
  openLowpassHz: number;
  crackGain: number;
  crackRadiusM: number;
  impactGain: number;
  impactWithinM: number;
  frontReportGain: number;
  whistleGain: number;
  whistleFromHz: number;
  whistleToHz: number;
  blastGain: number;
  blastRumbleS: number;
  scrapeGain: number;
  flareGain: number;
  /** The hands' cues, at the ear. */
  handsGain: number;
  /** Each gun's report's body (Hz), its [viewkick.<gun>] report_body_hz; the front's, the defaults'. */
  reportBodyHz: Record<GunKey, number>;
  /** Each gun's report's weight, its [viewkick.<gun>] report_gain: a share of its level (the front's, 1). */
  reportGain: Record<GunKey, number>;
  frontBodyHz: number;
  /** A report's send to the shared tail, the player's own and bare; a suppressed one sends half. */
  reportTailSend: number;
  /** A distant shell heard: its gain at the near end of its shells' range (metres), its lowpass and length over that range. */
  rumble: DistantVoice;
  thump: DistantVoice;
  /** A machine gun's burst heard: its gain at the near end of its range (metres), its lowpass over that range. */
  chatter: { gain: number; rangeM: [number, number]; lowpassHz: [number, number] };
  /** A fire's pop heard: at the fire's full strength, and as far as it is. */
  crackleGain: number;
  crackleWithinM: number;
  /** A splash heard: a round's (as near as an impact is), a shell's (at any distance), and how long a shell's rushes. */
  splashGain: number;
  splashShellGain: number;
  splashShellS: number;
  /** The most voices sounding or waiting to (cap.ts). */
  maxVoices: number;
}

export interface DistantVoice {
  gain: number;
  rangeM: [number, number];
  lowpassHz: [number, number];
  lengthS: [number, number];
}

export function audioTunables(tun: Tunables): AudioTunables {
  const f = (k: string) => tun.f(`audio.${k}`);
  return {
    speedOfSound: f('speed_of_sound'),
    masterGain: f('master_gain'),
    referenceM: f('reference_m'),
    rolloff: f('rolloff'),
    dingRolloff: f('ding_rolloff'),
    farM: f('far_m'),
    farLowpassHz: f('far_lowpass_hz'),
    openLowpassHz: f('open_lowpass_hz'),
    crackGain: f('crack_gain'),
    // A crack is heard as far as it suppresses.
    crackRadiusM: tun.f('suppression.crack_radius_m'),
    impactGain: f('impact_gain'),
    impactWithinM: f('impact_within_m'),
    frontReportGain: f('front_report_gain'),
    whistleGain: f('whistle_gain'),
    whistleFromHz: f('whistle_from_hz'),
    whistleToHz: f('whistle_to_hz'),
    blastGain: f('blast_gain'),
    blastRumbleS: f('blast_rumble_s'),
    scrapeGain: f('scrape_gain'),
    flareGain: f('flare_gain'),
    handsGain: f('hands_gain'),
    reportBodyHz: Object.fromEntries(GUNS.map((g) => [g, tun.f(`viewkick.${GUN_DEFS[g].table}.report_body_hz`)])) as Record<GunKey, number>,
    reportGain: Object.fromEntries(GUNS.map((g) => [g, tun.f(`viewkick.${GUN_DEFS[g].table}.report_gain`)])) as Record<GunKey, number>,
    frontBodyHz: tun.f('viewkick.defaults.report_body_hz'),
    reportTailSend: tun.f('viewkick.defaults.report_tail_send'),
    rumble: { gain: f('rumble_gain'), rangeM: tun.pair('battle.barrages.distance_m'), lowpassHz: tun.pair('audio.rumble_lowpass_hz'), lengthS: tun.pair('audio.rumble_length_s') },
    thump: { gain: f('thump_gain'), rangeM: tun.pair('battle.far_shells.distance_m'), lowpassHz: tun.pair('audio.thump_lowpass_hz'), lengthS: tun.pair('audio.thump_length_s') },
    chatter: { gain: f('chatter_gain'), rangeM: tun.pair('audio.chatter_range_m'), lowpassHz: tun.pair('audio.chatter_lowpass_hz') },
    crackleGain: f('crackle_gain'),
    crackleWithinM: f('crackle_within_m'),
    splashGain: f('splash_gain'),
    splashShellGain: f('splash_shell_gain'),
    splashShellS: f('splash_shell_s'),
    maxVoices: tun.i('audio.max_voices'),
  };
}

const TIMBER = new Set<number>([K.DUCKBOARD, K.TIMBER, K.TRUNK, K.BRANCH]);
const METAL = new Set<number>([K.CORRUGATE, K.WIRE, K.HULL, K.PICKET]);

function struck(material: number): VoiceKind {
  const kind = kindOf(material);
  if (METAL.has(kind)) return 'impact-metal';
  if (TIMBER.has(kind)) return 'impact-timber';
  return 'impact-soil';
}

/** How far `d` metres is from reference_m to far_m, as a share (0 within the reference, 1 from far_m on): what dulls a voice afar. */
function farShare(t: AudioTunables, d: number): number {
  return Math.min(1, Math.max(0, (d - t.referenceM) / (t.farM - t.referenceM)));
}

/**
 * A voice of `kind` at `at` heard from `listener`: late by the distance, quieter as
 * (reference / distance)^rolloff past the reference (`rolloff`, [audio]'s unless told another), and
 * duller toward far_lowpass_hz by far_m.
 */
function heardAfar(t: AudioTunables, listener: readonly number[], at: [number, number, number], gain: number, kind: VoiceKind, rolloff = t.rolloff): VoicePlan {
  const d = Math.hypot(at[0] - listener[0], at[1] - listener[1], at[2] - listener[2]);
  const share = farShare(t, d);
  return {
    kind,
    at,
    delayS: d / t.speedOfSound,
    gain: gain * Math.min(1, Math.pow(t.referenceM / Math.max(t.referenceM, d), rolloff)),
    lowpassHz: t.openLowpassHz * Math.pow(t.farLowpassHz / t.openLowpassHz, share),
  };
}

/**
 * A hit's feedback placed (the shots spec's §4): a voice at the ear (`at` null) where the listener
 * is, at once, whole and undulled, as the player's own report is; one where something was struck heard
 * from afar as any voice there is, and a plate that rings likewise but falling off by ding_rolloff:
 * steel rings far, and at the range's far plates its ring is the shooter's only word of a hit.
 */
export function planFeedback(t: AudioTunables, voices: readonly FeedbackVoice[], listener: readonly number[]): VoicePlan[] {
  return voices.map((v) =>
    v.at === null
      ? { kind: v.kind, at: [listener[0], listener[1], listener[2]], delayS: 0, gain: v.gain, lowpassHz: t.openLowpassHz }
      : heardAfar(t, listener, v.at, v.gain, v.kind, v.kind === 'ding' ? t.dingRolloff : t.rolloff),
  );
}

export function planVoices(t: AudioTunables, events: CombatEvents, listener: readonly number[], battle?: BattleEvents): VoicePlan[] {
  const out: VoicePlan[] = [];
  const distance = (at: readonly number[]) => Math.hypot(at[0] - listener[0], at[1] - listener[1], at[2] - listener[2]);
  const afar = (at: [number, number, number], gain: number, kind: VoiceKind): VoicePlan => heardAfar(t, listener, at, gain, kind);
  // A report: its gun's body and weight and whether it was suppressed, by the shot's word (the front's,
  // and a word not known, the defaults' body and no weight); quieter by its `report` share (a
  // suppressor's). It sends to the tail report_tail_send, half that suppressed (the voice muffles its
  // own body and keeps its crack), and from afar less by the share of far_m that dulls it, but never
  // under a quarter: a far report keeps a trace of tail. That floor does not make a far front ring
  // aloud: the send is taken after the voice's level, so its tail already falls with the distance
  // (at 150 m, near −70 dBFS).
  const report = (s: ShotEvent, v: VoicePlan): VoicePlan => {
    const word = s.mark === undefined ? null : decodeShotMark(s.mark);
    const suppressed = word?.suppressed ?? false;
    return {
      ...v,
      gain: v.gain * (word ? t.reportGain[word.gun] : 1),
      bodyHz: word ? t.reportBodyHz[word.gun] : t.frontBodyHz,
      suppressed,
      send: t.reportTailSend * (suppressed ? 0.5 : 1) * Math.max(0.25, 1 - farShare(t, distance(v.at))),
    };
  };
  // The player's own: at their muzzle (within reference_m, so its whole send), at once and whole.
  for (const s of events.shots) out.push(report(s, { kind: 'report', at: s.muzzle, delayS: 0, gain: s.report ?? 1, lowpassHz: t.openLowpassHz }));
  for (const s of events.frontShots) out.push(report(s, afar(s.origin, t.frontReportGain, 'report')));
  // Another player's gun: heard where it is, as the front's are.
  for (const s of events.remoteShots) out.push(report(s, afar(s.muzzle, t.frontReportGain * (s.report ?? 1), 'report')));
  // A round into a body is heard by its feedback (planFeedback), not here.
  for (const c of events.cracks) {
    out.push({ kind: 'crack', at: c.at, delayS: 0, gain: t.crackGain * Math.max(0, 1 - c.missM / t.crackRadiusM), lowpassHz: t.openLowpassHz });
  }
  for (const i of events.impacts) {
    // A silent round's (another's shot long overdue: Session.fireRemote) is not heard.
    if (i.silent || distance(i.position) > t.impactWithinM) continue;
    out.push(afar(i.position, t.impactGain, struck(i.material)));
  }
  for (const s of events.incoming) out.push({ ...afar(s.at, t.whistleGain, 'whistle'), delayS: 0, lengthS: s.landsInS, fromHz: t.whistleFromHz, toHz: t.whistleToHz });
  for (const b of events.blasts) out.push({ ...afar(b.at, t.blastGain, 'blast'), lengthS: t.blastRumbleS });
  for (const s of events.scoops) out.push(afar(s.at, t.scrapeGain, 'scrape'));
  // The hands' cues: the gun is in the player's own hands, heard at the ear, at once and whole.
  for (const h of events.handling) out.push({ kind: h.cue, at: [listener[0], listener[1], listener[2]], delayS: 0, gain: t.handsGain, lowpassHz: t.openLowpassHz });
  for (const w of events.splashes) {
    if (w.kind === 'shell') out.push({ ...afar(w.at, t.splashShellGain, 'splash'), lengthS: t.splashShellS });
    else if (distance(w.at) <= t.impactWithinM) out.push(afar(w.at, t.splashGain, 'splash'));
  }
  for (const l of battle?.launches ?? []) out.push(afar(l.post, t.flareGain, 'flare'));
  // A fire's pops, as loud as it is strong, near enough.
  for (const c of battle?.crackles ?? []) {
    if (distance(c.at) > t.crackleWithinM) continue;
    out.push(afar(c.at, t.crackleGain * c.gain, 'crackle'));
  }
  // A distant shell, late by its distance: quieter as the near end of its range over the distance,
  // duller and longer across the range.
  const distant = (at: [number, number, number], kind: VoiceKind, v: DistantVoice): VoicePlan => {
    const d = distance(at);
    const share = Math.min(1, Math.max(0, (d - v.rangeM[0]) / (v.rangeM[1] - v.rangeM[0])));
    return {
      kind,
      at,
      delayS: d / t.speedOfSound,
      gain: (v.gain * v.rangeM[0]) / Math.max(v.rangeM[0], d),
      lowpassHz: v.lowpassHz[1] * Math.pow(v.lowpassHz[0] / v.lowpassHz[1], share),
      lengthS: v.lengthS[0] + (v.lengthS[1] - v.lengthS[0]) * share,
    };
  };
  for (const s of battle?.distant ?? []) out.push(s.far ? distant(s.position, 'thump', t.thump) : distant(s.position, 'rumble', t.rumble));
  // A machine gun's burst, its rounds rattling at its rate: late by its distance, quieter as the near
  // end of its range over the distance, duller across the range.
  for (const b of battle?.bursts ?? []) {
    const c = t.chatter;
    const d = distance(b.gun);
    const share = Math.min(1, Math.max(0, (d - c.rangeM[0]) / (c.rangeM[1] - c.rangeM[0])));
    out.push({
      kind: 'chatter',
      at: b.gun,
      delayS: d / t.speedOfSound,
      gain: (c.gain * c.rangeM[0]) / Math.max(c.rangeM[0], d),
      lowpassHz: c.lowpassHz[1] * Math.pow(c.lowpassHz[0] / c.lowpassHz[1], share),
      lengthS: ((b.rounds - 1) * 60) / b.rpm,
      rounds: b.rounds,
      rpm: b.rpm,
    });
  }
  return out;
}
