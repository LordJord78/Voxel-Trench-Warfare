import { describe, expect, it } from 'vitest';
import { audioTunables, planVoices } from '../../src/audio/plan';
import type { Impact } from '../../src/combat/ballistics';
import { loadTunables } from '../../src/core/tunables';
import type { CombatEvents, ShotEvent } from '../../src/sim/session';
import { P } from '../../src/world/materials';

// What a frame's combat sounds like, before WebAudio makes it: a voice per shot, crack and impact,
// placed where it happened, late by its distance at the speed of sound, quieter and duller with it.
const t = audioTunables(loadTunables());
const ear: [number, number, number] = [10, 2, 10];
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [] });
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
    const v = planVoices(t, none(), ear, { launches: [launch] });
    expect(v.map((x) => x.kind)).toEqual(['flare']);
    expect(v[0].at).toEqual(launch.post);
    expect(v[0].delayS).toBeCloseTo(Math.hypot(0, 4, 80) / 343, 9);
    expect(v[0].gain).toBeLessThan(t.flareGain);
    expect(planVoices(t, none(), ear)).toEqual([]);
  });

  it('a scoop is a scrape where it was dug, at scrape_gain', () => {
    expect(t.scrapeGain).toBe(0.5);
    const scoop = { tick: 1, voxels: 24, at: [10.6, 1.4, 10.8] as [number, number, number] };
    const v = planVoices(t, { ...none(), scoops: [scoop, { ...scoop, voxels: 3 }] }, ear);
    expect(v.map((x) => x.kind)).toEqual(['scrape', 'scrape']);
    expect(v[0].at).toEqual(scoop.at);
    expect(v[0].gain).toBeCloseTo(t.scrapeGain, 9);
    expect(v[0].delayS).toBeCloseTo(Math.hypot(0.6, 0.6, 0.8) / 343, 9);
  });

  it('a blast is late by its distance at 343 m/s, quieter and duller with it, and heard past impact_within_m', () => {
    const blast = (z: number) => ({ tick: 1, at: [10, 2, 10 + z] as [number, number, number], radiusM: 3, material: P.SOD });
    const v = planVoices(t, { ...none(), blasts: [blast(20), blast(200)] }, ear);
    expect(v.map((x) => x.kind)).toEqual(['blast', 'blast']);
    expect(v[0].delayS).toBeCloseTo(20 / 343, 9);
    expect(v[1].delayS).toBeCloseTo(200 / 343, 9);
    expect(v[1].gain).toBeLessThan(v[0].gain);
    expect(v[1].lowpassHz).toBeLessThan(v[0].lowpassHz);
    expect(200).toBeGreaterThan(t.impactWithinM);
    expect(v[0].lengthS).toBe(t.blastRumbleS);
  });
});
