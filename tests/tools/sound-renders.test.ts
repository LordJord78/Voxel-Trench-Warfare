import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hitFeedbackTunables } from '../../src/app/hit-feedback';
import { audioTunables, planFeedback, planVoices, type VoiceKind } from '../../src/audio/plan';
import { reportShape, voiceLength } from '../../src/audio/voices';
import { armSpec } from '../../src/combat/arsenal';
import { rangeTunables } from '../../src/combat/range';
import { loadTunables } from '../../src/core/tunables';
import { BARE } from '../../src/net/gear';
import { FRAME_S, FRONT_M, LEAD_S, MUZZLE, RATE, renders, TAIL_S } from '../../tools/sounds/renders';

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
const list = renders(tun);
const byName = (name: string) => list.find((r) => r.name === name)!;
const EARS = ['hit', 'head', 'gush', 'kill', 'ding', 'hurt'] as const;
/** The hands' cues (combat/handling.ts), each heard at the ear (audio/plan.ts). */
const CUES = ['mag-out', 'mag-in', 'bolt', 'cover', 'shell', 'pump', 'dry'] as const;
/** The reports (the shots spec's §6): the front's, and the player's own from four guns, the SVD bare and suppressed. */
const REPORTS = ['report', 'report-ak', 'report-svd', 'report-svd-suppressed', 'report-m870', 'report-pistol'] as const;
/** Every voice's kind: a missing one is a type error here, so a kind added to audio/plan.ts is rendered too. */
const EVERY_KIND: Record<VoiceKind, true> = {
  report: true, crack: true, 'impact-soil': true, 'impact-timber': true, 'impact-metal': true, whistle: true, blast: true, scrape: true, flare: true, rumble: true, thump: true, chatter: true, crackle: true, splash: true,
  hit: true, head: true, gush: true, kill: true, ding: true, hurt: true,
  'mag-out': true, 'mag-in': true, bolt: true, cover: true, shell: true, pump: true, dry: true,
};
/** The kinds neither a hit's, a cue nor a report: each its own render, by its name. */
const OTHERS = ['crack', 'impact-soil', 'impact-timber', 'impact-metal', 'whistle', 'blast', 'scrape', 'flare', 'rumble', 'thump', 'chatter', 'crackle', 'splash'] as const;
/** How long a render's plans sound, from its start: each from its delay, a report's tail as well. */
const sounding = (plans: readonly { delayS: number; send?: number }[]) => Math.max(...plans.map((p) => p.delayS + voiceLength(p as never, report) + ((p.send ?? 0) > 0 ? report.tailS : 0)));

describe("the sounds' proof: what it renders", () => {
  it('48 kHz, a voice 10 ms in and its file 100 ms past its end; a frame at 60 Hz', () => {
    expect([RATE, LEAD_S, TAIL_S, FRAME_S]).toEqual([48000, 0.01, 0.1, 1 / 60]);
  });

  it("one report shape (the reports' shared tail), src/audio's, the engine is given (app/main.ts) and the renders read", () => {
    expect(report).toEqual({ bodyHz: tun.f('viewkick.defaults.report_body_hz'), tailS: tun.f('viewkick.defaults.report_tail_s') });
    const main = readFileSync('src/app/main.ts', 'utf8');
    expect(main).toMatch(/new AudioEngine\(hearing, reportShape\(tun\)\)/);
    expect(main).not.toContain('report_tail_s');
    expect(readFileSync('tools/sounds/renders.ts', 'utf8')).not.toContain('report_tail_s');
    expect(readFileSync('tools/sounds/page.ts', 'utf8')).not.toContain('report_tail_s');
  });

  it("each hit's voice, by its kind's name, at the ear: placed as planFeedback places it, whole and at once, at its [hits] gain", () => {
    for (const kind of EARS) {
      const r = byName(kind);
      const placed = planFeedback(t, [{ kind, at: null, gain: gains[kind] }], [0, 0, 0]);
      expect(r.plans, kind).toEqual(placed);
      expect(r.plans[0], kind).toMatchObject({ kind, at: [0, 0, 0], delayS: 0, gain: gains[kind], lowpassHz: t.openLowpassHz });
      expect(r.lengthS, kind).toBeCloseTo(LEAD_S + voiceLength(placed[0], report) + TAIL_S, 9);
    }
  });

  it('every render is held, none only reported: the voices, the far rings, the headshot that kills, the hands\' cues, the reports and every other kind', () => {
    expect(list.map((r) => r.name)).toEqual([...EARS, 'ding-30m', 'ding-85m', 'headshot-kill', 'headshot-kill-dry', ...CUES, ...REPORTS, ...OTHERS]);
    for (const r of list) expect(r.gated, r.name).toBe(true);
  });

  it("each of the hands' cues, by its name, at the ear: placed as planVoices places a cue, whole and at once, at hands_gain", () => {
    for (const cue of CUES) {
      const r = byName(cue);
      const placed = planVoices(t, { shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [{ tick: 1, cue, at: [0.2, -0.1, -0.5] }], harms: [] }, [0, 0, 0]);
      expect(r.plans, cue).toEqual(placed);
      expect(r.plans[0], cue).toMatchObject({ kind: cue, at: [0, 0, 0], delayS: 0, gain: t.handsGain, lowpassHz: t.openLowpassHz });
      expect(r.lengthS, cue).toBeCloseTo(LEAD_S + voiceLength(placed[0], report) + TAIL_S, 9);
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
      expect(r.lengthS).toBeCloseTo(LEAD_S + r.plans[0].delayS + voiceLength(placed[0], report) + TAIL_S, 9);
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
    expect(r.lengthS).toBeCloseTo(LEAD_S + Math.max(...r.plans.map((p) => p.delayS + voiceLength(p, report))) + TAIL_S, 9);
    // The same without the gush: the crack, and the kill a frame later; held to its peak's range alone.
    const dry = byName('headshot-kill-dry');
    expect(dry.plans).toEqual([now[0], { ...kill, delayS: FRAME_S }]);
    expect(dry.plans.map((p) => p.kind)).toEqual(['head', 'kill']);
    expect([dry.gated, dry.rules]).toEqual([true, undefined]);
    expect(dry.lengthS).toBeCloseTo(LEAD_S + Math.max(...dry.plans.map((p) => p.delayS + voiceLength(p, report))) + TAIL_S, 9);
    // No other render is held over another's.
    for (const x of list) if (x.name !== 'headshot-kill') expect(x.rules?.over, x.name).toBeUndefined();
  });

  it('every name is its own (a file each), and a render held to another names one rendered', () => {
    expect(new Set(list.map((r) => r.name)).size).toBe(list.length);
    for (const r of list) if (r.rules?.near) expect(list.map((x) => x.name), r.name).toContain(r.rules.near.of);
    for (const r of list) if (r.rules?.over) expect(list.map((x) => x.name), r.name).toContain(r.rules.over.of);
  });
});

// The reports and every other voice (the shots spec's §6, G5's Task 2): every VoiceKind rendered to
// <kind>.wav, each as the game plans it, held to the peak's range; and the reports, the front's and the
// player's own, each heard with its tail (its file runs the tail's length past its dry layers).
describe("the sounds' proof: the reports, and every kind", () => {
  it('every VoiceKind has a render by its name, playing that kind alone', () => {
    const names = list.map((r) => r.name);
    for (const kind of Object.keys(EVERY_KIND)) {
      expect(names, kind).toContain(kind);
      const r = byName(kind);
      expect(r.plans.length, kind).toBeGreaterThan(0);
      for (const p of r.plans) expect(p.kind, kind).toBe(kind);
    }
  });

  it("the player's own reports at the muzzle, as planVoices plans the shot: the AK, the SVD bare and suppressed, the M870 and the pistol, each its gun's body", () => {
    const own = [
      ['report-ak', 'ak74', false, 140],
      ['report-svd', 'svd', false, 110],
      ['report-svd-suppressed', 'svd', true, 110],
      ['report-m870', 'm870', false, 95],
      ['report-pistol', 'm17', false, 210],
    ] as const;
    for (const [name, gun, suppressed, bodyHz] of own) {
      const r = byName(name);
      expect(r.plans, name).toHaveLength(1);
      const [p] = r.plans;
      // Placed as the player's own: at the muzzle, at once, whole and undulled; at its gun's report share.
      expect(p, name).toMatchObject({ kind: 'report', at: MUZZLE, delayS: 0, lowpassHz: t.openLowpassHz, bodyHz, suppressed });
      expect(p.gain, name).toBe(armSpec(tun, gun, { ...BARE, muzzle: suppressed ? 'suppressor' : 'none' }).report);
      expect(p.send, name).toBe(suppressed ? t.reportTailSend / 2 : t.reportTailSend);
      expect(r.lengthS, name).toBeCloseTo(LEAD_S + voiceLength(p, report) + report.tailS + TAIL_S, 9);
    }
    // The muzzle half a metre ahead, a little right and under the eye.
    expect(MUZZLE).toEqual([0.1, -0.1, -0.6]);
    // The suppressed SVD, quieter by its suppressor's report_gain.
    expect(byName('report-svd-suppressed').plans[0].gain).toBe(tun.f('attachment.suppressor.report_gain'));
  });

  it("the front's report, FRONT_M (20 m) straight ahead: late, quieter and duller by it, its send less by the lowpass's share, the defaults' body", () => {
    expect(FRONT_M).toBe(20);
    const r = byName('report');
    const [p] = r.plans;
    expect(r.plans).toHaveLength(1);
    expect(p).toMatchObject({ kind: 'report', at: [0, 0, -FRONT_M], bodyHz: tun.f('viewkick.defaults.report_body_hz'), suppressed: false });
    expect(p.delayS).toBeCloseTo(FRONT_M / t.speedOfSound, 12);
    expect(p.gain).toBeLessThan(t.frontReportGain);
    expect(p.lowpassHz).toBeLessThan(t.openLowpassHz);
    expect(p.send).toBeGreaterThan(0);
    expect(p.send).toBeLessThan(t.reportTailSend);
    expect(r.lengthS).toBeCloseTo(LEAD_S + p.delayS + voiceLength(p, report) + report.tailS + TAIL_S, 9);
  });

  it("the suppressed SVD's report is held to a peak 6 dB or more under the bare SVD's; no other report to more than its peak's range", () => {
    expect(byName('report-svd-suppressed').rules).toEqual({ under: { of: 'report-svd', db: 6 } });
    for (const name of REPORTS) if (name !== 'report-svd-suppressed') expect(byName(name).rules, name).toBeUndefined();
    for (const r of list) if (r.name !== 'report-svd-suppressed') expect(r.rules?.under, r.name).toBeUndefined();
  });

  it("every other kind as planVoices plans it from its event where the game plays it whole, held to its peak's range alone, its file as long as it sounds", () => {
    for (const name of OTHERS) {
      const r = byName(name);
      expect(r.gated, name).toBe(true);
      expect(r.rules, name).toBeUndefined();
      expect(r.lengthS, name).toBeCloseTo(LEAD_S + sounding(r.plans) + TAIL_S, 9);
      for (const p of r.plans) expect(p.send, name).toBeUndefined();
    }
    // One heard afar where the game plays it whole: reference_m off, late by it, at its [audio] gain.
    const whole: [string, number][] = [['impact-soil', t.impactGain], ['impact-timber', t.impactGain], ['impact-metal', t.impactGain], ['whistle', t.whistleGain], ['blast', t.blastGain], ['flare', t.flareGain], ['crackle', t.crackleGain], ['splash', t.splashGain]];
    for (const [name, gain] of whole) {
      const [p] = byName(name).plans;
      expect(Math.hypot(...p.at), name).toBeCloseTo(t.referenceM, 12);
      expect(p.gain, name).toBeCloseTo(gain, 12);
      // A whistle is heard from its announcing, at once; the rest late by their distance.
      expect(p.delayS, name).toBeCloseTo(name === 'whistle' ? 0 : t.referenceM / t.speedOfSound, 12);
    }
    // A distant gun at its range's nearest, whole there: a barrage's shell 1 km off, a far shell 200 m, a burst 60 m.
    for (const [name, d, gain] of [['rumble', 1000, t.rumble.gain], ['thump', 200, t.thump.gain], ['chatter', 60, t.chatter.gain]] as const) {
      const [p] = byName(name).plans;
      expect(p.delayS, name).toBeCloseTo(d / t.speedOfSound, 12);
      expect(p.gain, name).toBeCloseTo(gain, 12);
    }
    // A round passing a metre off; a scoop at the feet, within the reference, whole.
    expect(byName('crack').plans[0].gain).toBeCloseTo(t.crackGain * (1 - 1 / t.crackRadiusM), 12);
    expect(byName('scrape').plans[0].gain).toBeCloseTo(t.scrapeGain, 12);
  });
});
