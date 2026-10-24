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
 * hisses at its post.
 */

import type { BattleEvents } from '../battle/director';
import type { Tunables } from '../core/tunables';
import type { CombatEvents } from '../sim/session';
import { K, kindOf } from '../world/materials';

export type VoiceKind = 'report' | 'crack' | 'impact-soil' | 'impact-timber' | 'impact-metal' | 'whistle' | 'blast' | 'scrape' | 'flare';

export interface VoicePlan {
  kind: VoiceKind;
  /** Where it happened, metres. */
  at: [number, number, number];
  /** Seconds after now it is heard. */
  delayS: number;
  gain: number;
  /** What distance leaves of it. */
  lowpassHz: number;
  /** A whistle's time to its landing; a blast's rumble. */
  lengthS?: number;
  /** A whistle's pitch, falling from and to. */
  fromHz?: number;
  toHz?: number;
}

export interface AudioTunables {
  speedOfSound: number;
  masterGain: number;
  referenceM: number;
  rolloff: number;
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
}

export function audioTunables(tun: Tunables): AudioTunables {
  const f = (k: string) => tun.f(`audio.${k}`);
  return {
    speedOfSound: f('speed_of_sound'),
    masterGain: f('master_gain'),
    referenceM: f('reference_m'),
    rolloff: f('rolloff'),
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

export function planVoices(t: AudioTunables, events: CombatEvents, listener: readonly number[], battle?: BattleEvents): VoicePlan[] {
  const out: VoicePlan[] = [];
  const distance = (at: readonly number[]) => Math.hypot(at[0] - listener[0], at[1] - listener[1], at[2] - listener[2]);
  // Late by the distance, quieter as (reference / distance)^rolloff past the reference, and duller
  // toward far_lowpass_hz by far_m.
  const afar = (at: [number, number, number], gain: number, kind: VoiceKind): VoicePlan => {
    const d = distance(at);
    const share = Math.min(1, Math.max(0, (d - t.referenceM) / (t.farM - t.referenceM)));
    return {
      kind,
      at,
      delayS: d / t.speedOfSound,
      gain: gain * Math.min(1, Math.pow(t.referenceM / Math.max(t.referenceM, d), t.rolloff)),
      lowpassHz: t.openLowpassHz * Math.pow(t.farLowpassHz / t.openLowpassHz, share),
    };
  };
  for (const s of events.shots) out.push({ kind: 'report', at: s.muzzle, delayS: 0, gain: 1, lowpassHz: t.openLowpassHz });
  for (const s of events.frontShots) out.push(afar(s.origin, t.frontReportGain, 'report'));
  for (const c of events.cracks) {
    out.push({ kind: 'crack', at: c.at, delayS: 0, gain: t.crackGain * Math.max(0, 1 - c.missM / t.crackRadiusM), lowpassHz: t.openLowpassHz });
  }
  for (const i of events.impacts) {
    if (distance(i.position) > t.impactWithinM) continue;
    out.push(afar(i.position, t.impactGain, struck(i.material)));
  }
  for (const s of events.incoming) out.push({ ...afar(s.at, t.whistleGain, 'whistle'), delayS: 0, lengthS: s.landsInS, fromHz: t.whistleFromHz, toHz: t.whistleToHz });
  for (const b of events.blasts) out.push({ ...afar(b.at, t.blastGain, 'blast'), lengthS: t.blastRumbleS });
  for (const s of events.scoops) out.push(afar(s.at, t.scrapeGain, 'scrape'));
  for (const l of battle?.launches ?? []) out.push(afar(l.post, t.flareGain, 'flare'));
  return out;
}
