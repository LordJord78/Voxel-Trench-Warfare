import { describe, expect, it } from 'vitest';
import { decodeGear, decodeShotMark, encodeGear, encodeShotMark, GUNS, gunDamage, MUZZLES, OPTICS, SHOT_SHARES, shareStep, SIDES, stepShare, TRACER_KIND, teamTracer, UNDERS, type Gear } from '../../src/net/gear';
import { decodeShot, decodeState, encodeShot, encodeState, parseClient } from '../../src/net/protocol';

// What a player carries, as the others and the room know it (net/gear.ts): packed above the
// state's eight flags and into a shot's last word, so the room relays it without knowing.
describe('gear on the wire', () => {
  it('packs every gun, fit and light, and the shovel, and unpacks them', () => {
    for (const gun of [...GUNS, null]) {
      for (const [k, optic] of OPTICS.entries()) {
        const g: Gear = { gun, fit: { optic, muzzle: MUZZLES[k % 3], under: UNDERS[(k + 1) % 3], side: SIDES[(k + 2) % 3] }, light: k % 2 === 1 };
        expect(decodeGear(encodeGear(g))).toEqual(g);
        expect(encodeGear(g)).toBeLessThan(1 << 15);
      }
    }
    // Nothing (or junk) is the bare AK.
    expect(decodeGear(0)).toEqual({ gun: 'ak74', fit: { optic: 'iron', muzzle: 'none', under: 'none', side: 'none' }, light: false });
    expect(decodeGear(-5).gun).toBe('ak74');
    // The old tracer bits (12-13) are ignored, and written as zero.
    expect(decodeGear(0b11 << 12)).toEqual(decodeGear(0));
    expect(encodeGear(decodeGear(0b11 << 12)) & (0b11 << 12)).toBe(0);
  });

  it("a team's tracer is its colour", () => {
    expect(teamTracer('red')).toBe(2);
    expect(teamTracer('blue')).toBe(3);
  });

  it("rides above a state's flags, which keep their own eight bits", () => {
    const gear = encodeGear({ gun: 'm4', fit: { optic: 'scope', muzzle: 'suppressor', under: 'angled', side: 'laser' }, light: true });
    const s = { tick: 9, position: [1, 2, 3] as [number, number, number], velocity: [0, 0, 0] as [number, number, number], yaw: 10, pitch: -5, stance: 1, height: 1.8, flags: 0b101001, gear };
    const back = decodeState(encodeState(s))!;
    expect(back.flags).toBe(0b101001);
    expect(back.gear).toBe(gear);
    // A state from before gear was sent: none.
    expect(decodeState(encodeState({ ...s, gear: undefined }))!.gear).toBe(0);
  });

  it("marks a shot with its gun, its tracer's colour and a suppressor; bit 0 is still the tracer", () => {
    const mark = encodeShotMark({ tracer: true, kind: TRACER_KIND.blue, suppressed: true, gun: 'svd' });
    // A word that says no share (a bullet's) reads as the hip's 1; none says a compensator.
    expect(decodeShotMark(mark)).toEqual({ tracer: true, kind: TRACER_KIND.blue, suppressed: true, gun: 'svd', comp: false, share: 1 });
    const shot = { tick: 4, origin: [1, 1.6, 2] as [number, number, number], dir: [0, 0, 1] as [number, number, number], tracer: true, mark };
    const back = decodeShot(encodeShot(shot))!;
    expect(back.tracer).toBe(true);
    expect(back.mark).toBe(mark);
    // A bare word of 1 (a tracer, said as it always was): the battle's amber, from the AK.
    expect(decodeShotMark(1)).toEqual({ tracer: true, kind: TRACER_KIND.amber, suppressed: false, gun: 'ak74', comp: false, share: 1 });
    expect(decodeShot(encodeShot({ ...shot, mark: undefined }))!.mark).toBeUndefined();
  });

  it("marks a compensator in bit 8, its flash drawn from it; bits 9–11 are the share's, not its", () => {
    const bare = encodeShotMark({ tracer: true, kind: TRACER_KIND.red, suppressed: false, gun: 'm4' });
    const comp = encodeShotMark({ tracer: true, kind: TRACER_KIND.red, suppressed: false, gun: 'm4', comp: true });
    expect(comp - bare).toBe(1 << 8);
    expect(comp >> 9).toBe(0);
    expect(decodeShotMark(comp)).toEqual({ tracer: true, kind: TRACER_KIND.red, suppressed: false, gun: 'm4', comp: true, share: 1 });
    expect(decodeShotMark(bare).comp).toBe(false);
    // Through the wire as it is.
    const back = decodeShot(encodeShot({ tick: 4, origin: [1, 1.6, 2], dir: [0, 0, 1], tracer: true, mark: comp }))!;
    expect(decodeShotMark(back.mark!).comp).toBe(true);
    // Bits above it (M6's pellet share, 9–11) do not read as a compensator.
    expect(decodeShotMark(bare | (5 << 9)).comp).toBe(false);
  });

  it("carries a pellet gun's pattern's share in bits 9–11, one of eight steps; a word without them is the hip's 1", () => {
    // Step 0 the hip's 1; the other seven from 0.25 to 2.8, each about √2 from the next.
    expect(SHOT_SHARES).toEqual([1, 0.25, 0.35, 0.5, 0.7, 1.4, 2.0, 2.8]);
    const ladder = [...SHOT_SHARES].sort((a, b) => a - b);
    for (let k = 1; k < ladder.length; k++) {
      expect(ladder[k] / ladder[k - 1], `${ladder[k - 1]} to ${ladder[k]}`).toBeGreaterThan(1.33);
      expect(ladder[k] / ladder[k - 1], `${ladder[k - 1]} to ${ladder[k]}`).toBeLessThan(1.5);
    }
    // Every step round-trips beside every gun, kind, suppressor and compensator, which read as they did
    // without it: the share lives in bits 9–11 alone, and bit 8 (the compensator's) is its own.
    for (const [step, share] of SHOT_SHARES.entries()) {
      for (const gun of GUNS) {
        for (const kind of [TRACER_KIND.none, TRACER_KIND.amber, TRACER_KIND.red, TRACER_KIND.blue]) {
          for (const suppressed of [false, true]) {
            for (const comp of [false, true]) {
              const m = { tracer: kind !== TRACER_KIND.none, kind, suppressed, gun, comp };
              const mark = encodeShotMark({ ...m, share });
              expect(Number.isInteger(mark)).toBe(true);
              expect((mark >> 9) & 7, `step ${step}`).toBe(step);
              expect((mark >> 8) & 1).toBe(comp ? 1 : 0);
              expect(mark & ((1 << 9) - 1)).toBe(encodeShotMark(m));
              expect(mark >> 12).toBe(0);
              expect(decodeShotMark(mark)).toEqual({ ...decodeShotMark(encodeShotMark(m)), share });
              expect(decodeShotMark(mark).comp).toBe(comp);
            }
          }
        }
      }
      // It rides a shot's words as any mark does.
      const mark = encodeShotMark({ tracer: true, kind: TRACER_KIND.red, suppressed: false, gun: 'm870', share });
      expect(decodeShot(encodeShot({ tick: 7, origin: [1, 1.6, 2], dir: [0, 0, 1], tracer: true, mark }))!.mark).toBe(mark);
    }
    // A word with bits 9–11 clear reads as the hip, whatever its others say.
    for (const n of [0, 1, 0b1111_1111, 0b1_1111_1111]) expect(decodeShotMark(n).share).toBe(1);
    // A share between steps is put to the nearest in proportion; past either end, that end.
    const put = (share: number) => SHOT_SHARES[shareStep(share)];
    expect([0.8, 0.72, 0.576, 0.38, 0.304, 0.2736, 1, 1.18, 1.426, 2.0016, 4.2].map(put)).toEqual([0.7, 0.7, 0.5, 0.35, 0.35, 0.25, 1, 1, 1.4, 2.0, 2.8]);
    expect([0.01, 100].map(put)).toEqual([0.25, 2.8]);
    // Not finite: past either end, that end (no number at all, the hip's).
    expect([1 / 0, Infinity, -Infinity, -1, 0, NaN].map(put)).toEqual([2.8, 2.8, 0.25, 0.25, 0.25, 1]);
    // The value a share is thrown at, defined once: its step's.
    for (const share of [0, 0.2736, 0.38, 0.8, 1, 1.18, 2.0016, 4.2, Infinity, NaN]) expect(stepShare(share)).toBe(put(share));
    expect(decodeShotMark(encodeShotMark({ tracer: false, kind: 0, suppressed: false, gun: 'm870', share: 0.8 })).share).toBe(0.7);
  });

  it("scales a hit's damage by its gun, and a claim says which", () => {
    expect(gunDamage(55, undefined)).toBe(55);
    expect(gunDamage(55, GUNS.indexOf('m4'))).toBe(55);
    // The marksman's rifle kills with a chest shot; a single pellet does a share.
    expect(gunDamage(55, GUNS.indexOf('svd'))).toBeGreaterThanOrEqual(100);
    expect(gunDamage(55, GUNS.indexOf('m870'))).toBeLessThan(30);
    expect(parseClient(JSON.stringify({ t: 'hit', v: 2, z: 'torso', w: 3 }))).toEqual({ t: 'hit', v: 2, z: 'torso', w: 3 });
    expect(parseClient(JSON.stringify({ t: 'hit', v: 2, z: 'torso', w: 99 }))).toEqual({ t: 'hit', v: 2, z: 'torso' });
  });
});
