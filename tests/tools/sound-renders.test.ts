import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hitFeedbackTunables } from '../../src/app/hit-feedback';
import { audioTunables, planFeedback, planVoices, type VoiceKind } from '../../src/audio/plan';
import { REPORT_S, reportShape, voiceLength } from '../../src/audio/voices';
import { armSpec } from '../../src/combat/arsenal';
import { rangeTunables } from '../../src/combat/range';
import { loadTunables } from '../../src/core/tunables';
import { BARE } from '../../src/net/gear';
import { PEAK_DB } from '../../tools/lib/sound-measures.mjs';
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
/** The reports (the shots spec's §6): the front's, the player's own from every gun (the SVD bare and suppressed), an AK burst and a long M249 burst. */
const REPORTS = ['report', 'report-ak', 'report-svd', 'report-svd-suppressed', 'report-m870', 'report-pistol', 'report-m4', 'report-mp5', 'report-m249', 'report-pm', 'report-ak-burst', 'report-m249-burst'] as const;
/** Every voice's kind: a missing one is a type error here, so a kind added to audio/plan.ts is rendered too. */
const EVERY_KIND: Record<VoiceKind, true> = {
  report: true, crack: true, 'impact-soil': true, 'impact-timber': true, 'impact-metal': true, whistle: true, blast: true, scrape: true, flare: true, rumble: true, thump: true, chatter: true, crackle: true, splash: true,
  hit: true, head: true, gush: true, kill: true, ding: true, hurt: true,
  'mag-out': true, 'mag-in': true, bolt: true, cover: true, shell: true, pump: true, dry: true,
};
/** The kinds neither a hit's, a cue nor a report: each its own render, by its name. */
const OTHERS = ['crack', 'impact-soil', 'impact-timber', 'impact-metal', 'whistle', 'blast', 'scrape', 'flare', 'rumble', 'thump', 'chatter', 'crackle', 'splash'] as const;
/** Each other kind's file's length (s), as it is: LEAD_S, its delay, how long it sounds, and TAIL_S. */
const OTHERS_S: Record<(typeof OTHERS)[number], number> = {
  crack: 0.13, 'impact-soil': 0.2158309, 'impact-timber': 0.2158309, 'impact-metal': 0.5158309, whistle: 1.61, blast: 1.9658309,
  scrape: 0.4642047, flare: 3.2158309, rumble: 4.5254519, thump: 1.4930904, chatter: 1.2849271, crackle: 0.1658309, splash: 0.2258309,
};
/** The order the reports weigh in and the tail rules (G5's final review): all three read alike, so one reading serves each render (tools/sounds/page.ts). */
const ORDER = { band: [20, 20000], firstS: 0.08, db: 0 } as const;
/** Each gun's own body heard (G5's final review): the share of the first 80 ms in its body's band, halfway between the share with the gun's own body and with the defaults' 140 Hz in its place (measured 0.772 and 0.516 for the M870, 0.880 and 0.112 for the pistol). */
const M870_BODY = 0.64;
const PISTOL_BODY = 0.5;

describe("the sounds' proof: what it renders", () => {
  it('48 kHz, a voice 10 ms in and its file 100 ms past its end; a frame at 60 Hz', () => {
    expect([RATE, LEAD_S, TAIL_S, FRAME_S]).toEqual([48000, 0.01, 0.1, 1 / 60]);
  });

  it("one report shape (the reports' shared tail), src/audio's, the engine is given (app/main.ts) and the renders read", () => {
    expect(report).toEqual({ bodyHz: tun.f('viewkick.defaults.report_body_hz'), tailS: tun.f('viewkick.defaults.report_tail_s'), suppressedHz: tun.f('attachment.suppressor.blast_hz'), suppressedBlast: tun.f('attachment.suppressor.blast_share') });
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
      expect(r.lengthS, kind).toBeCloseTo(LEAD_S + voiceLength(placed[0]) + TAIL_S, 9);
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
      expect(r.lengthS, cue).toBeCloseTo(LEAD_S + voiceLength(placed[0]) + TAIL_S, 9);
    }
  });

  it('every voice at the ear is held to the small speaker: at least a quarter of its energy over 400 Hz', () => {
    for (const kind of [...EARS, ...CUES]) expect(byName(kind).rules?.high, kind).toBe(0.25);
    for (const name of ['ding-30m', 'ding-85m', 'headshot-kill', 'headshot-kill-dry']) expect(byName(name).rules?.high, name).toBeUndefined();
  });

  it("the gush gushes: at least 55% of its energy in 400 Hz–2 kHz, and its loudest 50 ms within 3 dB of the kill's thud's (the kill under 400 Hz, apart from its chime)", () => {
    expect(byName('gush').rules).toEqual({ high: 0.25, band: { hz: [400, 2000], share: 0.55 }, near: { of: 'kill', withinDb: 3, low: true } });
    // No other render is held to another's level, and only the gush, the headshot that kills and two reports' bodies to a band.
    for (const r of list) if (r.name !== 'gush') expect(r.rules?.near, r.name).toBeUndefined();
    expect(list.filter((r) => r.rules?.band).map((r) => r.name)).toEqual(['gush', 'headshot-kill', 'report-m870', 'report-pistol']);
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
      expect(r.lengthS).toBeCloseTo(LEAD_S + r.plans[0].delayS + voiceLength(placed[0]) + TAIL_S, 9);
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
    expect(r.lengthS).toBeCloseTo(LEAD_S + Math.max(...r.plans.map((p) => p.delayS + voiceLength(p))) + TAIL_S, 9);
    // The same without the gush: the crack, and the kill a frame later; held to its peak's range alone.
    const dry = byName('headshot-kill-dry');
    expect(dry.plans).toEqual([now[0], { ...kill, delayS: FRAME_S }]);
    expect(dry.plans.map((p) => p.kind)).toEqual(['head', 'kill']);
    expect([dry.gated, dry.rules]).toEqual([true, undefined]);
    expect(dry.lengthS).toBeCloseTo(LEAD_S + Math.max(...dry.plans.map((p) => p.delayS + voiceLength(p))) + TAIL_S, 9);
    // No other render is held over another's but the reports' (their weights' order, and a suppressed shot over its reload).
    expect(list.filter((x) => x.rules?.over).map((x) => x.name)).toEqual(['headshot-kill', 'report-ak', 'report-svd', 'report-svd-suppressed', 'report-m870']);
  });

  it('every name is its own (a file each), and a render held to another names one rendered', () => {
    expect(new Set(list.map((r) => r.name)).size).toBe(list.length);
    for (const r of list) if (r.rules?.near) expect(list.map((x) => x.name), r.name).toContain(r.rules.near.of);
    for (const r of list) if (r.rules?.over) expect(list.map((x) => x.name), r.name).toContain(r.rules.over.of);
    for (const r of list) if (r.rules?.under) expect(list.map((x) => x.name), r.name).toContain(r.rules.under.of);
    for (const r of list) if (r.rules?.highOver) expect(list.map((x) => x.name), r.name).toContain(r.rules.highOver.of);
  });

  it('every render that another reads over (its `over` reading) is read alike by each: one band and one first span (page.ts reads one over-reading a render)', () => {
    const key = (o: { band: readonly number[]; firstS?: number }) => `${o.band.join('-')} Hz over ${o.firstS} s`;
    for (const r of list) {
      // How each rule that reads this render reads it: its own, and every one held over it.
      const reads = list.flatMap((x) => (x.rules?.over && (x === r || x.rules.over.of === r.name) ? [key(x.rules.over)] : []));
      expect(new Set(reads).size, r.name).toBeLessThanOrEqual(1);
    }
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

  it("the player's own reports at the muzzle, as planVoices plans the shot: every gun, the SVD bare and suppressed, each its gun's body and weight", () => {
    const own = [
      ['report-ak', 'ak74', false, 140],
      ['report-svd', 'svd', false, 110],
      ['report-svd-suppressed', 'svd', true, 110],
      ['report-m870', 'm870', false, 95],
      ['report-pistol', 'm17', false, 210],
      ['report-m4', 'm4', false, 150],
      ['report-mp5', 'mp5', false, 190],
      ['report-m249', 'm249', false, 135],
      ['report-pm', 'pm', false, 210],
    ] as const;
    for (const [name, gun, suppressed, bodyHz] of own) {
      const r = byName(name);
      expect(r.plans, name).toHaveLength(1);
      const [p] = r.plans;
      // Placed as the player's own: at the muzzle, at once, whole and undulled; at its gun's report share.
      expect(p, name).toMatchObject({ kind: 'report', at: MUZZLE, delayS: 0, lowpassHz: t.openLowpassHz, bodyHz, suppressed });
      expect(p.gain, name).toBeCloseTo(armSpec(tun, gun, { ...BARE, muzzle: suppressed ? 'suppressor' : 'none' }).report * t.reportGain[gun], 12);
      expect(p.send, name).toBe(suppressed ? t.reportTailSend / 2 : t.reportTailSend);
      expect(r.lengthS, name).toBeCloseTo(LEAD_S + voiceLength(p) + report.tailS + TAIL_S, 9);
    }
    // The muzzle half a metre ahead, a little right and under the eye.
    expect(MUZZLE).toEqual([0.1, -0.1, -0.6]);
    // The suppressed SVD, quieter by its suppressor's report_gain.
    expect(byName('report-svd-suppressed').plans[0].gain).toBeCloseTo(tun.f('attachment.suppressor.report_gain') * t.reportGain.svd, 12);
    // Every gun has its own file: the user hears each before the release.
    expect(new Set(own.map(([, gun]) => gun))).toEqual(new Set(['ak74', 'm4', 'mp5', 'svd', 'm249', 'm870', 'm17', 'pm']));
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
    expect(r.lengthS).toBeCloseTo(LEAD_S + p.delayS + voiceLength(p) + report.tailS + TAIL_S, 9);
  });

  it("the suppressed SVD's report: its loudest 50 ms 6 dB or more under the bare SVD's, more of it over 400 Hz than the bare one's, and its first 50 ms 2 dB or more over its own reload's mag-out", () => {
    expect(byName('report-svd-suppressed').rules).toEqual({ under: { of: 'report-svd', db: 6 }, highOver: { of: 'report-svd', by: 0.1 }, over: { of: 'mag-out', band: [20, 20000], firstS: 0.05, db: 2 } });
    for (const r of list) if (r.name !== 'report-svd-suppressed') expect([r.rules?.under, r.rules?.highOver], r.name).toEqual([undefined, undefined]);
  });

  it("the reports' weight, in order: the M870 and the SVD over the AK, the AK over the pistol, each its first 80 ms's energy across the band (20 Hz-20 kHz)", () => {
    expect(byName('report-m870').rules?.over).toEqual({ of: 'report-ak', ...ORDER });
    expect(byName('report-svd').rules?.over).toEqual({ of: 'report-ak', ...ORDER });
    expect(byName('report-ak').rules?.over).toEqual({ of: 'report-pistol', ...ORDER });
  });

  it("the reports' tail, held from both sides: the M870's and the SVD's loudest 50 ms after their own layers 3 to 24 dB under their report's; an AK burst's after its last report 6 to 24 dB under", () => {
    expect(REPORT_S).toBeCloseTo(0.07, 12);
    expect(byName('report-m870').rules?.tail).toEqual({ afterS: REPORT_S, underDb: [3, 24] });
    expect(byName('report-svd').rules?.tail).toEqual({ afterS: REPORT_S, underDb: [3, 24] });
    expect(byName('report-ak-burst').rules).toEqual({ tail: { afterS: 0.9 + REPORT_S, underDb: [6, 24] } });
    expect(list.filter((r) => r.rules?.tail).map((r) => r.name)).toEqual(['report-svd', 'report-m870', 'report-ak-burst']);
  });

  it("each gun's own body heard: the M870's (95 to 63 Hz) under 120 Hz, the pistol's (210 to 140 Hz) in 130-400 Hz, over their first 80 ms", () => {
    expect(byName('report-m870').rules?.band).toEqual({ hz: [20, 120], share: M870_BODY, firstS: 0.08 });
    expect(byName('report-pistol').rules).toEqual({ band: { hz: [130, 400], share: PISTOL_BODY, firstS: 0.08 } });
    // Only these reports hold more than their peak's range; the rest, nothing else.
    for (const name of ['report', 'report-mp5', 'report-m249', 'report-m4', 'report-pm', 'report-m249-burst'] as const) expect(byName(name).rules, name).toBeUndefined();
  });

  it('an AK burst: ten of its reports at the muzzle 0.1 s apart (600 rpm), each as report-ak plans it, its file the tail past the last', () => {
    const r = byName('report-ak-burst');
    const [one] = byName('report-ak').plans;
    expect(r.plans).toEqual(Array.from({ length: 10 }, (_, k) => ({ ...one, delayS: k * 0.1 })));
    expect(r.lengthS).toBeCloseTo(LEAD_S + 0.9 + REPORT_S + report.tailS + TAIL_S, 9);
  });

  it("a long M249 burst: twenty of its reports at the muzzle at its own rate (750 rpm, 0.08 s apart), each as report-m249 plans it, held to its peak's range alone: through the compressor a stream comes hotter than a shot from silence, and it must keep under -1 dBFS", () => {
    const r = byName('report-m249-burst');
    const [one] = byName('report-m249').plans;
    const gap = 60 / armSpec(tun, 'm249', BARE).weapon.rpm;
    expect(gap).toBeCloseTo(0.08, 12);
    expect(r.plans).toEqual(Array.from({ length: 20 }, (_, k) => ({ ...one, delayS: k * gap })));
    expect([r.gated, r.rules]).toEqual([true, undefined]);
    expect(PEAK_DB[1]).toBe(-1);
    expect(r.lengthS).toBeCloseTo(LEAD_S + 19 * gap + REPORT_S + report.tailS + TAIL_S, 9);
  });

  it("every other kind as planVoices plans it from its event where the game plays it whole, held to its peak's range alone, its file as long as it sounds", () => {
    for (const name of OTHERS) {
      const r = byName(name);
      expect(r.gated, name).toBe(true);
      expect(r.rules, name).toBeUndefined();
      expect(r.lengthS, name).toBeCloseTo(OTHERS_S[name], 6);
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
