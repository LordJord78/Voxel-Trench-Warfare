import { describe, expect, it } from 'vitest';
import { noBattleEvents } from '../../src/battle/director';
import { audioTunables, planFeedback, planVoices } from '../../src/audio/plan';
import { armSpec, GUN_DEFS } from '../../src/combat/arsenal';
import type { Impact } from '../../src/combat/ballistics';
import { loadTunables } from '../../src/core/tunables';
import { BARE, encodeShotMark, GUNS, type GunKey } from '../../src/net/gear';
import type { CombatEvents, ShotEvent } from '../../src/sim/session';
import { P } from '../../src/world/materials';

// What a frame's combat sounds like, before WebAudio makes it: a voice per shot, crack and impact,
// placed where it happened, late by its distance at the speed of sound, quieter and duller with it.
const t = audioTunables(loadTunables());
const ear: [number, number, number] = [10, 2, 10];
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [], harms: [] });
const shot = (at: [number, number, number]): ShotEvent => ({ tick: 1, origin: at, dir: [0, 0, 1], tracer: false, muzzle: at });
const impact = (at: [number, number, number], material: number, owner = 0): Impact & { tick: number } => ({
  tick: 1,
  position: at,
  normal: [0, 1, 0],
  cell: [0, 0, 0],
  material,
  speed: 800,
  distance: 50,
  energyJ: 1100,
  owner,
  spec: '5.45',
  dir: [0, -1, 0],
  kind: 0,
});

describe('the sound of a frame', () => {
  it('reads [audio]', () => {
    expect(t.speedOfSound).toBe(343);
  });

  it("the player's own report is at the muzzle, at once and whole", () => {
    const [v] = planVoices(t, { ...none(), shots: [shot([10.2, 1.8, 11.1])] }, ear);
    expect(v.kind).toBe('report');
    expect(v.at).toEqual([10.2, 1.8, 11.1]);
    expect(v.delayS).toBe(0);
    expect(v.gain).toBe(1);
  });

  it("the front's reports come late by their distance at 343 m/s, quieter and duller the further", () => {
    const near = planVoices(t, { ...none(), frontShots: [shot([10, 2, 50])] }, ear)[0];
    const far = planVoices(t, { ...none(), frontShots: [shot([10, 2, 150])] }, ear)[0];
    expect(near.kind).toBe('report');
    expect(near.delayS).toBeCloseTo(40 / 343, 9);
    expect(far.delayS).toBeCloseTo(140 / 343, 9);
    expect(far.gain).toBeLessThan(near.gain);
    expect(far.lowpassHz).toBeLessThan(near.lowpassHz);
  });

  it('a crack is louder the nearer it passed, and is heard where it passed, at once', () => {
    const plan = (missM: number) => planVoices(t, { ...none(), cracks: [{ tick: 1, missM, at: [11, 2, 10] }] }, ear)[0];
    expect(plan(0.5).kind).toBe('crack');
    expect(plan(0.5).at).toEqual([11, 2, 10]);
    expect(plan(0.5).delayS).toBe(0);
    expect(plan(0.5).gain).toBeGreaterThan(plan(2.5).gain);
  });

  it('impacts sound by what they hit: soil thuds, timber knocks, metal rings', () => {
    const kind = (material: number) => planVoices(t, { ...none(), impacts: [impact([12, 2, 10], material)] }, ear)[0].kind;
    expect(kind(P.SOD)).toBe('impact-soil');
    expect(kind(P.SANDBAG)).toBe('impact-soil');
    expect(kind(P.TIMBER)).toBe('impact-timber');
    expect(kind(P.DUCKBOARD)).toBe('impact-timber');
    expect(kind(P.PICKET)).toBe('impact-metal');
    expect(kind(P.CORRUGATE)).toBe('impact-metal');
  });

  it('impacts further than impact_within_m are not heard', () => {
    const beyond = planVoices(t, { ...none(), impacts: [impact([10, 2, 10 + t.impactWithinM + 1], P.SOD)] }, ear);
    expect(beyond).toEqual([]);
  });

  it("a silent round's impact (another's shot long overdue) is not heard", () => {
    const near = impact([12, 2, 10], P.SOD);
    expect(planVoices(t, { ...none(), impacts: [near] }, ear)).toHaveLength(1);
    expect(planVoices(t, { ...none(), impacts: [{ ...near, silent: true }] }, ear)).toEqual([]);
  });

  it("a frame's events make one voice each", () => {
    const events: CombatEvents = {
      shots: [shot([10.2, 1.8, 11]), shot([10.2, 1.8, 11])],
      frontShots: [shot([10, 2, 60])],
      impacts: [impact([12, 2, 30], P.SOD), impact([9, 2, 15], P.TIMBER), impact([10, 3, 20], P.PICKET, 1)],
      cracks: [{ tick: 1, missM: 1, at: [11, 2, 10] }],
      cuts: [],
      craters: [],
      incoming: [],
      blasts: [],
      scoops: [],
      splashes: [],
      remoteShots: [],
      hits: [],
      handling: [],
      harms: [],
    };
    expect(planVoices(t, events, ear).map((v) => v.kind).sort()).toEqual(['crack', 'impact-metal', 'impact-soil', 'impact-timber', 'report', 'report', 'report']);
  });

  it("a shell's whistle starts when it is announced, where it will land, and lasts until it lands", () => {
    const at: [number, number, number] = [10, 2, 60];
    const v = planVoices(t, { ...none(), incoming: [{ tick: 1, at, landsInS: 1.5 }] }, ear);
    expect(v.length).toBe(1);
    const d = Math.hypot(0, 0, 50);
    expect(v[0]).toEqual({
      kind: 'whistle',
      at,
      delayS: 0,
      gain: t.whistleGain * Math.pow(t.referenceM / d, t.rolloff),
      lowpassHz: expect.any(Number),
      lengthS: 1.5,
      fromHz: t.whistleFromHz,
      toHz: t.whistleToHz,
    });
  });

  it("a flare's launch is a pop and a hiss at its post, late by its distance", () => {
    expect(t.flareGain).toBe(0.4);
    const launch = { id: 3, post: [10, 6, 90] as [number, number, number], t0: 12, bearing: 0, elevation: 1.4, burstM: 40, colour: [1, 0.88, 0.7] as [number, number, number] };
    const v = planVoices(t, none(), ear, { ...noBattleEvents(), launches: [launch], distant: [], bursts: [] });
    expect(v.map((x) => x.kind)).toEqual(['flare']);
    expect(v[0].at).toEqual(launch.post);
    expect(v[0].delayS).toBeCloseTo(Math.hypot(0, 4, 80) / 343, 9);
    expect(v[0].gain).toBeLessThan(t.flareGain);
    expect(planVoices(t, none(), ear)).toEqual([]);
  });

  it("a barrage's shell rumbles distance ÷ 343 m/s later, quieter, duller and longer the farther", () => {
    const shell = (id: number, metres: number) => ({ id, position: [ear[0] + metres, ear[1], ear[2]] as [number, number, number], t: 5, power: 1, far: false });
    const v = planVoices(t, none(), ear, { ...noBattleEvents(), launches: [], distant: [shell(1, 1000), shell(2, 8000)], bursts: [] });
    expect(v.map((x) => x.kind)).toEqual(['rumble', 'rumble']);
    const [near, far] = v;
    expect(near.delayS).toBeCloseTo(1000 / 343, 9);
    expect(far.delayS).toBeCloseTo(8000 / 343, 9);
    expect(near.gain).toBeCloseTo(t.rumble.gain, 9);
    expect(far.gain / near.gain).toBeCloseTo(1 / 8, 9);
    expect(near.lowpassHz).toBeCloseTo(300, 6);
    expect(far.lowpassHz).toBeCloseTo(80, 6);
    expect(near.lengthS).toBeCloseTo(1.5, 9);
    expect(far.lengthS).toBeCloseTo(5, 9);
    expect(near.at).toEqual(shell(1, 1000).position);
  });

  it('a far shell thumps after its distance', () => {
    const shell = (id: number, metres: number) => ({ id, position: [ear[0], ear[1], ear[2] + metres] as [number, number, number], t: 5, power: 1, far: true });
    const [near, far] = planVoices(t, none(), ear, { ...noBattleEvents(), launches: [], distant: [shell(1, 200), shell(2, 800)], bursts: [] });
    expect([near.kind, far.kind]).toEqual(['thump', 'thump']);
    expect(near.delayS).toBeCloseTo(200 / 343, 9);
    expect(far.delayS).toBeCloseTo(800 / 343, 9);
    expect(near.gain).toBeCloseTo(t.thump.gain, 9);
    expect(far.gain / near.gain).toBeCloseTo(1 / 4, 9);
    expect(near.lowpassHz).toBeCloseTo(1200, 6);
    expect(far.lowpassHz).toBeCloseTo(500, 6);
    expect(near.lengthS).toBeCloseTo(0.8, 9);
    expect(far.lengthS).toBeCloseTo(1.5, 9);
  });

  it('a burst chatters at its gun, late by its distance, quieter and duller the farther', () => {
    const burst = (id: number, metres: number) => ({ id, gun: [ear[0] + metres, ear[1], ear[2]] as [number, number, number], t: 3, rounds: 12, rpm: 600 });
    const [near, far] = planVoices(t, none(), ear, { ...noBattleEvents(), launches: [], distant: [], bursts: [burst(1, 60), burst(2, 300)] });
    expect([near.kind, far.kind]).toEqual(['chatter', 'chatter']);
    expect(near.delayS).toBeCloseTo(60 / 343, 9);
    expect(far.delayS).toBeCloseTo(300 / 343, 9);
    expect(near.gain).toBeCloseTo(t.chatter.gain, 9);
    expect(far.gain / near.gain).toBeCloseTo(1 / 5, 9);
    expect(near.lowpassHz).toBeCloseTo(2000, 6);
    expect(far.lowpassHz).toBeCloseTo(400, 6);
    expect([near.rounds, near.rpm]).toEqual([12, 600]);
    expect(near.lengthS).toBeCloseTo((11 * 60) / 600, 9);
  });

  it("a fire's crackle is heard within 30 m, quieter with distance, and not past it", () => {
    expect([t.crackleGain, t.crackleWithinM]).toEqual([0.4, 30]);
    const pop = (metres: number, gain = 1) => ({ at: [ear[0] + metres, ear[1], ear[2]] as [number, number, number], gain });
    const v = planVoices(t, none(), ear, { ...noBattleEvents(), crackles: [pop(2), pop(12), pop(29), pop(31), pop(2, 0.5)] });
    expect(v.map((x) => x.kind)).toEqual(['crackle', 'crackle', 'crackle', 'crackle']);
    const [near, mid, edge, weak] = v;
    expect(near.delayS).toBeCloseTo(2 / 343, 9);
    expect(edge.delayS).toBeCloseTo(29 / 343, 9);
    expect(near.gain).toBeCloseTo(t.crackleGain * Math.min(1, Math.pow(t.referenceM / Math.max(t.referenceM, 2), t.rolloff)), 9);
    expect(mid.gain).toBeLessThan(near.gain);
    expect(edge.gain).toBeLessThan(mid.gain);
    expect(edge.lowpassHz).toBeLessThanOrEqual(near.lowpassHz);
    // A fire not yet at its full burn pops as loud as its strength.
    expect(weak.gain).toBeCloseTo(0.5 * near.gain, 9);
  });

  it("a round's splash is heard within impact_within_m, a shell's at any distance, late by it", () => {
    expect([t.splashGain, t.splashShellGain]).toEqual([0.6, 1.2]);
    const splash = (z: number, kind: 'round' | 'shell') => ({ tick: 1, at: [10, 2, 10 + z] as [number, number, number], energyJ: kind === 'round' ? 1500 : 3e6, kind });
    const v = planVoices(t, { ...none(), splashes: [splash(3, 'round'), splash(t.impactWithinM + 5, 'round'), splash(200, 'shell')] }, ear);
    expect(v.map((x) => x.kind)).toEqual(['splash', 'splash']);
    const [round, shell] = v;
    expect(round.delayS).toBeCloseTo(3 / 343, 9);
    expect(round.gain).toBeCloseTo(t.splashGain * Math.min(1, Math.pow(t.referenceM / Math.max(t.referenceM, 3), t.rolloff)), 9);
    expect(round.lengthS).toBeUndefined();
    // A shell's: a long rush, late by its distance, heard far off as a blast is.
    expect(shell.delayS).toBeCloseTo(200 / 343, 9);
    expect(shell.lengthS).toBeGreaterThan(0.5);
    expect(shell.gain).toBeGreaterThan(0);
  });

  it('a scoop is a scrape where it was dug, at scrape_gain', () => {
    expect(t.scrapeGain).toBe(0.5);
    const scoop = { tick: 1, voxels: 24, at: [10.6, 1.4, 10.8] as [number, number, number], cells: [] };
    const v = planVoices(t, { ...none(), scoops: [scoop, { ...scoop, voxels: 3 }] }, ear);
    expect(v.map((x) => x.kind)).toEqual(['scrape', 'scrape']);
    expect(v[0].at).toEqual(scoop.at);
    expect(v[0].gain).toBeCloseTo(t.scrapeGain, 9);
    expect(v[0].delayS).toBeCloseTo(Math.hypot(0.6, 0.6, 0.8) / 343, 9);
  });

  it('a blast is late by its distance at 343 m/s, quieter and duller with it, and heard past impact_within_m', () => {
    const blast = (z: number) => ({ tick: 1, at: [10, 2, 10 + z] as [number, number, number], radiusM: 3, material: P.SOD, crater: null });
    const v = planVoices(t, { ...none(), blasts: [blast(20), blast(200)] }, ear);
    expect(v.map((x) => x.kind)).toEqual(['blast', 'blast']);
    expect(v[0].delayS).toBeCloseTo(20 / 343, 9);
    expect(v[1].delayS).toBeCloseTo(200 / 343, 9);
    expect(v[1].gain).toBeLessThan(v[0].gain);
    expect(v[1].lowpassHz).toBeLessThan(v[0].lowpassHz);
    expect(200).toBeGreaterThan(t.impactWithinM);
    expect(v[0].lengthS).toBe(t.blastRumbleS);
  });

  it("the hands' cues (handling.ts) are heard at the ear, at once and whole, at [audio] hands_gain (0.5), one voice each of its own kind", () => {
    const tun = loadTunables();
    expect(t.handsGain).toBe(tun.f('audio.hands_gain'));
    expect(t.handsGain).toBe(0.5);
    const cues = ['mag-out', 'mag-in', 'bolt', 'cover', 'shell', 'pump', 'dry'] as const;
    const muzzle: [number, number, number] = [10.3, 1.7, 10.6];
    const plans = planVoices(t, { ...none(), handling: cues.map((cue, k) => ({ tick: 3 + k, cue, at: muzzle })) }, ear);
    expect(plans.map((v) => v.kind)).toEqual([...cues]);
    for (const v of plans) {
      // Its sound's shape with it, [audio.cues]'s (voices.ts plays it).
      expect(v).toEqual({ kind: v.kind, at: ear, delayS: 0, gain: 0.5, lowpassHz: t.openLowpassHz, cue: t.cues[v.kind as (typeof cues)[number]] });
      expect(v.at).not.toBe(ear);
    }
    // None without a cue.
    expect(planVoices(t, none(), ear)).toEqual([]);
  });

  it("a round of the player's into a body is the hit feedback's to sound (app/hit-feedback.ts): planVoices knocks no more", () => {
    const hit = { tick: 1, owner: 0, body: 3, zone: 'torso' as const, position: [12, 2, 20] as [number, number, number], dir: [0, 0, 1] as const, distance: 10 };
    expect(planVoices(t, { ...none(), hits: [hit, { ...hit, body: 200, zone: 'head' }] }, ear)).toEqual([]);
  });

  it('planFeedback puts ear voices at the listener with no delay, and a ding 85 m off 0.25 s late and quieter', () => {
    const plate: [number, number, number] = [ear[0], ear[1], ear[2] + 85];
    const plans = planFeedback(t, [{ kind: 'hit', at: null, gain: 0.75 }, { kind: 'gush', at: null, gain: 0.8 }, { kind: 'ding', at: plate, gain: 1.5 }], ear);
    expect(plans.map((v) => v.kind)).toEqual(['hit', 'gush', 'ding']);
    const [hit, gush, ding] = plans;
    // At the ear: where the listener is, at once, whole, undulled.
    expect(hit).toEqual({ kind: 'hit', at: ear, delayS: 0, gain: 0.75, lowpassHz: t.openLowpassHz });
    expect(gush).toEqual({ kind: 'gush', at: ear, delayS: 0, gain: 0.8, lowpassHz: t.openLowpassHz });
    expect(hit.at).not.toBe(ear);
    // At the plate: late by its distance at 343 m/s, quieter and duller with it, as any voice afar is.
    expect(ding.at).toEqual(plate);
    expect(ding.delayS).toBeCloseTo(0.25, 2);
    expect(ding.delayS).toBeCloseTo(85 / 343, 9);
    expect(ding.gain).toBeCloseTo(1.5 * Math.pow(t.referenceM / 85, t.dingRolloff), 9);
    expect(ding.lowpassHz).toBeLessThan(t.openLowpassHz);
    expect(planFeedback(t, [], ear)).toEqual([]);
  });

  it("a plate's ring falls off more gently than any other voice (steel rings far): by ding_rolloff, a body's hit afar by rolloff", () => {
    const tun = loadTunables();
    expect(t.dingRolloff).toBe(tun.f('audio.ding_rolloff'));
    expect(t.dingRolloff).toBeGreaterThan(0);
    expect(t.dingRolloff).toBeLessThan(t.rolloff);
    const at = (d: number): [number, number, number] => [ear[0], ear[1], ear[2] + d];
    const [ding, hit, gush] = planFeedback(t, [{ kind: 'ding', at: at(85), gain: 1.5 }, { kind: 'hit', at: at(20), gain: 0.75 }, { kind: 'gush', at: at(20), gain: 0.8 }], ear);
    expect(ding.gain).toBeCloseTo(1.5 * Math.pow(t.referenceM / 85, t.dingRolloff), 9);
    expect(ding.gain).toBeGreaterThan(1.5 * Math.pow(t.referenceM / 85, t.rolloff));
    expect(hit.gain).toBeCloseTo(0.75 * Math.pow(t.referenceM / 20, t.rolloff), 9);
    expect(gush.gain).toBeCloseTo(0.8 * Math.pow(t.referenceM / 20, t.rolloff), 9);
    // Within the reference, whole, as any voice is; its delay and dulling as any voice afar's.
    expect(planFeedback(t, [{ kind: 'ding', at: at(1.5), gain: 1.5 }], ear)[0].gain).toBe(1.5);
    expect(ding.delayS).toBeCloseTo(85 / t.speedOfSound, 9);
    expect(ding.lowpassHz).toBeCloseTo(planFeedback(t, [{ kind: 'hit', at: at(85), gain: 0.75 }], ear)[0].lowpassHz, 9);
  });
});

// The reports (the shots spec's §6): each gun's report its own, layered (audio/voices.ts), and every
// one sending to the one shared tail (audio/engine.ts). The plan says which gun's body it has, by the
// shot's word (net/gear.ts ShotMark: its gun, whether suppressed), and how much it sends.
describe('a report as planned', () => {
  const tun = loadTunables();
  const muzzle: [number, number, number] = [10.2, 1.8, 11.1];
  /** The player's shot from `gun`, bare or suppressed, its word and its report's share as the session gives them. */
  const fired = (gun: GunKey, suppressed = false, at: [number, number, number] = muzzle): ShotEvent => ({
    ...shot(at),
    mark: encodeShotMark({ tracer: false, kind: 0, suppressed, gun }),
    report: armSpec(tun, gun, { ...BARE, muzzle: suppressed ? 'suppressor' : 'none' }).report,
  });
  /** The share of the way from reference_m to far_m a voice `d` metres off is, by which heardAfar dulls it. */
  const farShare = (d: number) => Math.min(1, Math.max(0, (d - t.referenceM) / (t.farM - t.referenceM)));
  /** What the front's report `d` metres straight ahead is planned as. */
  const front = (d: number) => planVoices(t, { ...none(), frontShots: [shot([ear[0], ear[1], ear[2] + d])] }, ear)[0];

  it("each gun's report has its own body, report_body_hz in its [viewkick.<gun>]: AK 140, M4 150, MP5 190, SVD 110, M249 135, M870 95, the pistols 210", () => {
    const pinned: Record<GunKey, number> = { ak74: 140, m4: 150, mp5: 190, svd: 110, m249: 135, m870: 95, m17: 210, pm: 210 };
    for (const gun of GUNS) {
      expect(tun.f(`viewkick.${GUN_DEFS[gun].table}.report_body_hz`), gun).toBe(pinned[gun]);
      expect(t.reportBodyHz[gun], gun).toBe(pinned[gun]);
      const [v] = planVoices(t, { ...none(), shots: [fired(gun)] }, ear);
      expect(v, gun).toMatchObject({ kind: 'report', at: muzzle, delayS: 0, gain: t.reportGain[gun], lowpassHz: t.openLowpassHz, bodyHz: pinned[gun], suppressed: false });
    }
  });

  it("each gun's report has its own weight, report_gain in its [viewkick.<gun>]: the SVD heaviest, then the M870, the M4, the MP5, the AK and M249, the pistols lightest, the PM (0.61) a step under the M17 (0.62) (tuned on the heard renders: npm run sounds orders them as heard, the AK and the M4 over each pistol)", () => {
    const pinned: Record<GunKey, number> = { svd: 1.43, m870: 1.35, m4: 0.76, mp5: 0.66, ak74: 0.65, m249: 0.65, m17: 0.62, pm: 0.61 };
    for (const gun of GUNS) {
      expect(tun.f(`viewkick.${GUN_DEFS[gun].table}.report_gain`), gun).toBe(pinned[gun]);
      expect(t.reportGain[gun], gun).toBe(pinned[gun]);
      // The player's own: its report's share (a suppressor's, the kit's) times its gun's weight.
      for (const suppressed of [false, true]) {
        const s = fired(gun, suppressed);
        expect(planVoices(t, { ...none(), shots: [s] }, ear)[0].gain, `${gun} ${suppressed}`).toBeCloseTo(s.report! * pinned[gun], 12);
      }
      // Another's, as heard from afar: the same weight on the front's level.
      const at: [number, number, number] = [ear[0], ear[1], ear[2] + 40];
      const [remote] = planVoices(t, { ...none(), remoteShots: [{ ...fired(gun, false, at), owner: 3 }] }, ear);
      expect(remote.gain, gun).toBeCloseTo(t.frontReportGain * pinned[gun] * Math.pow(t.referenceM / 40, t.rolloff), 12);
    }
    // The front's (no word, no gun known), and a shot whose word is not known: no weight but their own.
    expect(front(40).gain).toBeCloseTo(t.frontReportGain * Math.pow(t.referenceM / 40, t.rolloff), 12);
    expect(planVoices(t, { ...none(), shots: [shot(muzzle)] }, ear)[0].gain).toBe(1);
    // In the order they weigh, heaviest first: on paper the SVD over the M870, as their peaks cap them
    // (the compressor passes a third of a paper dB on them), though no gate orders the two as heard.
    const order = [...GUNS].sort((a, b) => t.reportGain[b] - t.reportGain[a]);
    expect(order.slice(0, 2)).toEqual(['svd', 'm870']);
    expect(order.slice(-2).sort()).toEqual(['m17', 'pm']);
  });

  it("the front's report has the defaults' body (report_body_hz in [viewkick.defaults], the front's rifles'), and so has a shot whose word is not known", () => {
    expect(t.frontBodyHz).toBe(tun.f('viewkick.defaults.report_body_hz'));
    expect(t.frontBodyHz).toBe(140);
    expect(front(40)).toMatchObject({ kind: 'report', bodyHz: 140, suppressed: false });
    expect(planVoices(t, { ...none(), shots: [shot(muzzle)] }, ear)[0]).toMatchObject({ bodyHz: 140, suppressed: false });
    expect(planVoices(t, { ...none(), remoteShots: [{ ...shot([10, 2, 40]), owner: 3 }] }, ear)[0]).toMatchObject({ bodyHz: 140, suppressed: false });
  });

  it("the player's own report sends report_tail_send (0.35) to the shared tail, a suppressed one half as much; both whole and undulled, so a suppressed one keeps its crack", () => {
    expect(t.reportTailSend).toBe(tun.f('viewkick.defaults.report_tail_send'));
    expect(t.reportTailSend).toBe(0.35);
    const [bare] = planVoices(t, { ...none(), shots: [fired('svd')] }, ear);
    const [quiet] = planVoices(t, { ...none(), shots: [fired('svd', true)] }, ear);
    expect(bare).toEqual({ kind: 'report', at: muzzle, delayS: 0, gain: t.reportGain.svd, lowpassHz: t.openLowpassHz, bodyHz: 110, suppressed: false, send: 0.35 });
    // Quieter by its report's share (a suppressor's report_gain), the voice muffling its own body (voices.ts).
    expect(quiet).toEqual({ kind: 'report', at: muzzle, delayS: 0, gain: tun.f('attachment.suppressor.report_gain') * t.reportGain.svd, lowpassHz: t.openLowpassHz, bodyHz: 110, suppressed: true, send: 0.175 });
  });

  it("afar reports keep their delay and lowpass, and send less to the tail the farther they are, by the lowpass's share: all of it within reference_m, never under a quarter of it (a far report keeps a trace of tail)", () => {
    for (const d of [1, 2, 20, 76, 120, 150, 400]) {
      const v = front(d);
      const share = farShare(d);
      expect(v.delayS, `${d} m`).toBeCloseTo(d / t.speedOfSound, 12);
      expect(v.lowpassHz, `${d} m`).toBeCloseTo(t.openLowpassHz * Math.pow(t.farLowpassHz / t.openLowpassHz, share), 9);
      expect(v.gain, `${d} m`).toBeCloseTo(t.frontReportGain * Math.min(1, Math.pow(t.referenceM / Math.max(t.referenceM, d), t.rolloff)), 12);
      expect(v.send, `${d} m`).toBeCloseTo(t.reportTailSend * Math.max(0.25, 1 - share), 12);
    }
    expect(front(2).send).toBe(0.35);
    expect(front(76).send).toBeCloseTo(0.175, 12);
    expect(front(150).send).toBeCloseTo(0.0875, 12);
    expect(front(400).send).toBeCloseTo(0.0875, 12);
    // Where the floor takes over: three quarters of the way to far_m.
    expect(front(t.referenceM + 0.8 * (t.farM - t.referenceM)).send).toBeCloseTo(0.0875, 12);
    expect(front(t.referenceM + 0.7 * (t.farM - t.referenceM)).send).toBeCloseTo(0.35 * 0.3, 12);
    // A far suppressed report: half the floor.
    const far: [number, number, number] = [ear[0], ear[1], ear[2] + 400];
    expect(planVoices(t, { ...none(), remoteShots: [{ ...fired('pm', true, far), owner: 4 }] }, ear)[0].send).toBeCloseTo(0.04375, 12);
  });

  it("another player's report: their gun's body, suppressed as their word says, sending half as much then, as heard from afar, and dulled by the distance alone", () => {
    const at: [number, number, number] = [ear[0], ear[1], ear[2] + 40];
    const share = farShare(40);
    const dulled = t.openLowpassHz * Math.pow(t.farLowpassHz / t.openLowpassHz, share);
    const [bare, quiet] = planVoices(t, { ...none(), remoteShots: [{ ...fired('m4', false, at), owner: 3 }, { ...fired('pm', true, at), owner: 4 }] }, ear);
    expect(bare).toMatchObject({ kind: 'report', at, bodyHz: 150, suppressed: false });
    expect(quiet).toMatchObject({ kind: 'report', at, bodyHz: 210, suppressed: true });
    expect(bare.send).toBeCloseTo(0.35 * (1 - share), 12);
    expect(quiet.send).toBeCloseTo(0.175 * (1 - share), 12);
    expect(bare.lowpassHz).toBeCloseTo(dulled, 9);
    expect(quiet.lowpassHz).toBeCloseTo(dulled, 9);
    expect(bare.gain).toBeCloseTo(t.frontReportGain * t.reportGain.m4 * Math.pow(t.referenceM / 40, t.rolloff), 12);
    expect(quiet.gain).toBeCloseTo(t.frontReportGain * tun.f('attachment.suppressor.report_gain') * t.reportGain.pm * Math.pow(t.referenceM / 40, t.rolloff), 12);
  });

  it('no other voice has a body, a suppressor or a send', () => {
    const events: CombatEvents = { ...none(), cracks: [{ tick: 1, missM: 1, at: [11, 2, 10] }], impacts: [impact([12, 2, 20], P.SOD)], scoops: [{ tick: 1, voxels: 24, at: [10.6, 1.4, 10.8], cells: [] }] };
    const plans = planVoices(t, events, ear);
    expect(plans).toHaveLength(3);
    for (const v of plans) expect([v.bodyHz, v.suppressed, v.send], v.kind).toEqual([undefined, undefined, undefined]);
  });
});
