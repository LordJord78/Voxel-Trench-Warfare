import { describe, expect, it } from 'vitest';
import { decodeGear, decodeShotMark, encodeGear, encodeShotMark, GUNS, gunDamage, MUZZLES, OPTICS, SIDES, TRACER_KIND, TRACERS, UNDERS, type Gear } from '../../src/net/gear';
import { decodeShot, decodeState, encodeShot, encodeState, parseClient } from '../../src/net/protocol';

// What a player carries, as the others and the room know it (net/gear.ts): packed above the
// state's eight flags and into a shot's last word, so the room relays it without knowing.
describe('gear on the wire', () => {
  it('packs every gun, fit, tracer and light, and the shovel, and unpacks them', () => {
    for (const gun of [...GUNS, null]) {
      for (const [k, optic] of OPTICS.entries()) {
        const g: Gear = { gun, fit: { optic, muzzle: MUZZLES[k % 3], under: UNDERS[(k + 1) % 3], side: SIDES[(k + 2) % 3] }, tracer: TRACERS[k % 3], light: k % 2 === 1 };
        expect(decodeGear(encodeGear(g))).toEqual(g);
        expect(encodeGear(g)).toBeLessThan(1 << 15);
      }
    }
    // Nothing (or junk) is the bare AK.
    expect(decodeGear(0)).toEqual({ gun: 'ak74', fit: { optic: 'iron', muzzle: 'none', under: 'none', side: 'none' }, tracer: 'off', light: false });
    expect(decodeGear(-5).gun).toBe('ak74');
  });

  it("rides above a state's flags, which keep their own eight bits", () => {
    const gear = encodeGear({ gun: 'm4', fit: { optic: 'scope', muzzle: 'suppressor', under: 'angled', side: 'laser' }, tracer: 'green', light: true });
    const s = { tick: 9, position: [1, 2, 3] as [number, number, number], velocity: [0, 0, 0] as [number, number, number], yaw: 10, pitch: -5, stance: 1, height: 1.8, flags: 0b101001, gear };
    const back = decodeState(encodeState(s))!;
    expect(back.flags).toBe(0b101001);
    expect(back.gear).toBe(gear);
    // A state from before gear was sent: none.
    expect(decodeState(encodeState({ ...s, gear: undefined }))!.gear).toBe(0);
  });

  it("marks a shot with its gun, its tracer's colour and a suppressor; bit 0 is still the tracer", () => {
    const mark = encodeShotMark({ tracer: true, kind: TRACER_KIND.green, suppressed: true, gun: 'svd' });
    expect(decodeShotMark(mark)).toEqual({ tracer: true, kind: TRACER_KIND.green, suppressed: true, gun: 'svd' });
    const shot = { tick: 4, origin: [1, 1.6, 2] as [number, number, number], dir: [0, 0, 1] as [number, number, number], tracer: true, mark };
    const back = decodeShot(encodeShot(shot))!;
    expect(back.tracer).toBe(true);
    expect(back.mark).toBe(mark);
    // A bare word of 1 (a tracer, said as it always was): the battle's amber, from the AK.
    expect(decodeShotMark(1)).toEqual({ tracer: true, kind: TRACER_KIND.amber, suppressed: false, gun: 'ak74' });
    expect(decodeShot(encodeShot({ ...shot, mark: undefined }))!.mark).toBeUndefined();
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
