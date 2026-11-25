import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hitFeedbackTunables } from '../../src/app/hit-feedback';
import { audioTunables, planFeedback, planVoices } from '../../src/audio/plan';
import { cueShapes, reportShape, voiceLength } from '../../src/audio/voices';
import { rangeTunables } from '../../src/combat/range';
import { loadTunables } from '../../src/core/tunables';
import { Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';
import { cueEvents, FRAME_S, LEAD_S, RATE, renders, TAIL_S } from '../../tools/sounds/renders';

// The sounds' proof (npm run sounds; the shots spec's §6, G3's Task 5): what is rendered, and what each
// render is held to. Each hit's voice at the ear as the shooter hears it (planFeedback's placing, its
// [hits] gain), held to the peak range and to the small speaker; the gush to its band and to the kill's
// thud's level; a steel plate's ring as heard from the spawn at the range's nearest and farthest plates, the
// farthest to a floor; and a headshot's kill as its shooter hears it, to its band over its first 300 ms
// and over the same kill without its gush, so the gush is not lost in it.

const tun = loadTunables();
const t = audioTunables(tun);
const gains = hitFeedbackTunables(tun).gains;
const report = reportShape(tun);
const cues = cueShapes(tun);
const list = renders(tun);
const byName = (name: string) => list.find((r) => r.name === name)!;
const EARS = ['hit', 'head', 'gush', 'kill', 'ding', 'hurt'] as const;
/** The hands' cues (combat/handling.ts), each heard at the ear (audio/plan.ts). */
const CUES = ['mag-out', 'mag-in', 'bolt', 'cover', 'shell', 'pump', 'dry'] as const;

describe("the sounds' proof: what it renders", () => {
  it('48 kHz, a voice 10 ms in and its file 100 ms past its end; a frame at 60 Hz', () => {
    expect([RATE, LEAD_S, TAIL_S, FRAME_S]).toEqual([48000, 0.01, 0.1, 1 / 60]);
  });

  it("one report shape and one set of cue shapes, src/audio's, the engine is given (app/main.ts) and the renders read", () => {
    expect(report).toEqual({ lowHz: tun.f('viewkick.defaults.report_low_hz'), lengthS: tun.f('viewkick.defaults.report_length_s') });
    const main = readFileSync('src/app/main.ts', 'utf8');
    expect(main).toMatch(/new AudioEngine\(hearing, reportShape\(tun\), cueShapes\(tun\)\)/);
    expect(main).not.toContain('report_low_hz');
    expect(readFileSync('tools/sounds/renders.ts', 'utf8')).not.toContain('report_low_hz');
  });

  it("each hit's voice, by its kind's name, at the ear: placed as planFeedback places it, whole and at once, at its [hits] gain", () => {
    for (const kind of EARS) {
      const r = byName(kind);
      const placed = planFeedback(t, [{ kind, at: null, gain: gains[kind] }], [0, 0, 0]);
      expect(r.plans, kind).toEqual(placed);
      expect(r.plans[0], kind).toMatchObject({ kind, at: [0, 0, 0], delayS: 0, gain: gains[kind], lowpassHz: t.openLowpassHz });
      expect(r.lengthS, kind).toBeCloseTo(LEAD_S + voiceLength(placed[0], report, cues) + TAIL_S, 9);
    }
  });

  it('every render is held, none only reported: the voices, the far rings, the headshot that kills and the hands\' cues', () => {
    expect(list.map((r) => r.name)).toEqual([...EARS, 'ding-30m', 'ding-85m', 'headshot-kill', 'headshot-kill-dry', ...CUES]);
    for (const r of list) expect(r.gated, r.name).toBe(true);
  });

  it("a cue's frame of events, the one hand-built CombatEvents the renders and this test share: nothing but the cue, by the gun's muzzle", () => {
    for (const cue of CUES) {
      const e = cueEvents(cue);
      expect(e.handling).toEqual([{ tick: 1, cue, at: [0.2, -0.1, -0.5] }]);
      for (const [key, list] of Object.entries(e)) if (key !== 'handling') expect(list, key).toEqual([]);
    }
    // Every kind of event a frame drains (a fresh session's drain), each empty but the cue.
    const map = new BrickMap({ x: 64, y: 32, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.SOD);
    const drained = Session.create({ map, plan: null, spawn: { position: [3.2, 0.4, 3.2] } }, tun, 7, 0).drainEvents();
    expect(Object.keys(cueEvents('dry')).sort()).toEqual(Object.keys(drained).sort());
  });

  it("each of the hands' cues, by its name, at the ear: placed as planVoices places a cue, whole and at once, at hands_gain", () => {
    for (const cue of CUES) {
      const r = byName(cue);
      const placed = planVoices(t, cueEvents(cue), [0, 0, 0]);
      expect(r.plans, cue).toEqual(placed);
      expect(r.plans[0], cue).toMatchObject({ kind: cue, at: [0, 0, 0], delayS: 0, gain: t.handsGain, lowpassHz: t.openLowpassHz });
      expect(r.lengthS, cue).toBeCloseTo(LEAD_S + voiceLength(placed[0], report, cues) + TAIL_S, 9);
    }
  });

  it('every voice at the ear is held to the small speaker: at least a quarter of its energy over 400 Hz', () => {
    for (const kind of [...EARS, ...CUES]) expect(byName(kind).rules?.high, kind).toBe(0.25);
    for (const name of ['ding-30m', 'ding-85m', 'headshot-kill', 'headshot-kill-dry']) expect(byName(name).rules?.high, name).toBeUndefined();
  });

  it("the gush gushes: at least 55% of its energy in 400 Hz–2 kHz, and its loudest 50 ms within 3 dB of the kill's thud's (the kill under 400 Hz, apart from its chime)", () => {
    expect(byName('gush').rules).toEqual({ high: 0.25, band: { hz: [400, 2000], share: 0.55 }, near: { of: 'kill', withinDb: 3, low: true } });
    // No other render is held to another's level, and only the gush and the headshot that kills to a band.
    for (const r of list) if (r.name !== 'gush') expect(r.rules?.near, r.name).toBeUndefined();
    expect(list.filter((r) => r.rules?.band).map((r) => r.name)).toEqual(['gush', 'headshot-kill']);
  });

  it("a plate's ring heard from the spawn at the range's nearest and farthest plates, straight ahead: late, quieter by the dings' own rolloff, duller; the farthest held to −24 dBFS", () => {
    const rt = rangeTunables(tun);
    const all = [...rt.torsoPlatesM, ...rt.headPlatesM];
    const [near, far] = [Math.min(...all), Math.max(...all)];
    expect([near, far]).toEqual([30, 85]);
    for (const [r, d] of [[byName(`ding-${near}m`), near], [byName(`ding-${far}m`), far]] as const) {
      const placed = planFeedback(t, [{ kind: 'ding', at: [0, 0, -d], gain: gains.ding }], [0, 0, 0]);
      expect(r.plans).toEqual(placed);
      // As heard: late by the distance, at (reference / distance)^ding_rolloff of its gain.
      expect(r.plans[0].delayS).toBeCloseTo(d / t.speedOfSound, 9);
      expect(r.plans[0].gain).toBeCloseTo(gains.ding * Math.pow(t.referenceM / d, t.dingRolloff), 9);
      expect(r.plans[0].lowpassHz).toBeLessThan(t.openLowpassHz);
      expect(r.lengthS).toBeCloseTo(LEAD_S + r.plans[0].delayS + voiceLength(placed[0], report, cues) + TAIL_S, 9);
    }
    expect(byName(`ding-${near}m`).rules).toBeUndefined();
    expect(byName(`ding-${far}m`).rules).toEqual({ floorDb: -24 });
  });

  it("a headshot that kills as its shooter hears it on the range: the crack and the gush at the ear, the kill's thud and chime a frame later (its voice with the next frame's); at least 35% of its first 300 ms in 400 Hz–2 kHz, and its first 300 ms there at least 1.5 dB over the same kill without the gush (its chime alone fills the band: the share holds without the gush)", () => {
    const r = byName('headshot-kill');
    const now = planFeedback(t, (['head', 'gush'] as const).map((kind) => ({ kind, at: null, gain: gains[kind] })), [0, 0, 0]);
    const [kill] = planFeedback(t, [{ kind: 'kill', at: null, gain: gains.kill }], [0, 0, 0]);
    expect(r.plans).toEqual([...now, { ...kill, delayS: FRAME_S }]);
    expect(r.rules).toEqual({ band: { hz: [400, 2000], share: 0.35, firstS: 0.3 }, over: { of: 'headshot-kill-dry', band: [400, 2000], firstS: 0.3, db: 1.0 } });
    expect(r.lengthS).toBeCloseTo(LEAD_S + Math.max(...r.plans.map((p) => p.delayS + voiceLength(p, report, cues))) + TAIL_S, 9);
    // The same without the gush: the crack, and the kill a frame later; held to its peak's range alone.
    const dry = byName('headshot-kill-dry');
    expect(dry.plans).toEqual([now[0], { ...kill, delayS: FRAME_S }]);
    expect(dry.plans.map((p) => p.kind)).toEqual(['head', 'kill']);
    expect([dry.gated, dry.rules]).toEqual([true, undefined]);
    expect(dry.lengthS).toBeCloseTo(LEAD_S + Math.max(...dry.plans.map((p) => p.delayS + voiceLength(p, report, cues))) + TAIL_S, 9);
    // No other render is held over another's.
    for (const x of list) if (x.name !== 'headshot-kill') expect(x.rules?.over, x.name).toBeUndefined();
  });

  it('every name is its own (a file each), and a render held to another names one rendered', () => {
    expect(new Set(list.map((r) => r.name)).size).toBe(list.length);
    for (const r of list) if (r.rules?.near) expect(list.map((x) => x.name), r.name).toContain(r.rules.near.of);
    for (const r of list) if (r.rules?.over) expect(list.map((x) => x.name), r.name).toContain(r.rules.over.of);
  });
});
