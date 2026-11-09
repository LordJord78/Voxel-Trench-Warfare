import { describe, expect, it } from 'vitest';
import { hitFeedbackTunables } from '../../src/app/hit-feedback';
import { audioTunables, planFeedback } from '../../src/audio/plan';
import { voiceLength } from '../../src/audio/voices';
import { rangeTunables } from '../../src/combat/range';
import { loadTunables } from '../../src/core/tunables';
import { LEAD_S, RATE, renders, reportShape, TAIL_S } from '../../tools/sounds/renders';

// The sounds' proof (npm run sounds; the shots spec's §6): what is rendered. Each hit's voice at the
// ear as the shooter hears it (planFeedback's placing, its [hits] gain), held to the peak range, the
// gush to its band; and a steel plate's ring as heard from the spawn at the range's nearest and
// farthest plates, and a headshot's kill as its shooter hears it (the crack, the gush and the kill at
// once), reported, not held.

const tun = loadTunables();
const t = audioTunables(tun);
const gains = hitFeedbackTunables(tun).gains;
const report = reportShape(tun);
const list = renders(tun);
const byName = (name: string) => list.find((r) => r.name === name)!;

describe("the sounds' proof: what it renders", () => {
  it('48 kHz, a voice 10 ms in and its file 100 ms past its end; the report shape the engine is given', () => {
    expect([RATE, LEAD_S, TAIL_S]).toEqual([48000, 0.01, 0.1]);
    expect(report).toEqual({ lowHz: tun.f('viewkick.defaults.report_low_hz'), lengthS: tun.f('viewkick.defaults.report_length_s') });
  });

  it("each hit's voice, by its kind's name, at the ear: placed as planFeedback places it, whole and at once, at its [hits] gain; held to the peak range", () => {
    const kinds = ['hit', 'head', 'gush', 'kill', 'ding', 'hurt'] as const;
    expect(list.filter((r) => r.gated).map((r) => r.name)).toEqual([...kinds]);
    for (const kind of kinds) {
      const r = byName(kind);
      const placed = planFeedback(t, [{ kind, at: null, gain: gains[kind] }], [0, 0, 0]);
      expect(r.plans, kind).toEqual(placed);
      expect(r.plans[0], kind).toMatchObject({ kind, at: [0, 0, 0], delayS: 0, gain: gains[kind], lowpassHz: t.openLowpassHz });
      expect(r.lengthS, kind).toBeCloseTo(LEAD_S + voiceLength(placed[0], report) + TAIL_S, 9);
    }
  });

  it("the gush is held to 400 Hz–2 kHz, more than half its energy in it; no other voice is held to a band", () => {
    expect(byName('gush').band).toEqual({ band: [400, 2000], share: 0.5 });
    for (const r of list) if (r.name !== 'gush') expect(r.band, r.name).toBeUndefined();
  });

  it("a plate's ring heard from the spawn at the range's nearest and farthest plates, straight ahead: late, quieter and duller by its distance; reported, not held", () => {
    const rt = rangeTunables(tun);
    const all = [...rt.torsoPlatesM, ...rt.headPlatesM];
    const [near, far] = [Math.min(...all), Math.max(...all)];
    expect([near, far]).toEqual([30, 85]);
    const reported = list.filter((r) => !r.gated);
    expect(reported.map((r) => r.name)).toEqual([`ding-${near}m`, `ding-${far}m`, 'headshot-kill']);
    for (const [r, d] of [[reported[0], near], [reported[1], far]] as const) {
      const placed = planFeedback(t, [{ kind: 'ding', at: [0, 0, -d], gain: gains.ding }], [0, 0, 0]);
      expect(r.plans).toEqual(placed);
      // As heard: late by the distance, at reference / distance of its gain.
      expect(r.plans[0].delayS).toBeCloseTo(d / t.speedOfSound, 9);
      expect(r.plans[0].gain).toBeCloseTo((gains.ding * t.referenceM) / d, 9);
      expect(r.plans[0].lowpassHz).toBeLessThan(t.openLowpassHz);
      expect(r.lengthS).toBeCloseTo(LEAD_S + r.plans[0].delayS + voiceLength(placed[0], report) + TAIL_S, 9);
    }
  });

  it("a headshot that kills as its shooter hears it, the crack, the gush and the kill's thud and chime at once at the ear: reported, not held", () => {
    const r = byName('headshot-kill');
    const placed = planFeedback(t, (['head', 'gush', 'kill'] as const).map((kind) => ({ kind, at: null, gain: gains[kind] })), [0, 0, 0]);
    expect(r.plans).toEqual(placed);
    expect(r.gated).toBe(false);
    expect(r.lengthS).toBeCloseTo(LEAD_S + Math.max(...placed.map((p) => voiceLength(p, report))) + TAIL_S, 9);
  });

  it('every name is its own (a file each)', () => {
    expect(new Set(list.map((r) => r.name)).size).toBe(list.length);
  });
});
