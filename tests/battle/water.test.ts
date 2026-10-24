import { describe, expect, it } from 'vitest';
import { ringAt, ringStrength, waterTunables, type Ring } from '../../src/battle/water';
import { loadTunables } from '../../src/core/tunables';

// The water's rings (the battle spec's §6): a round, a shell falling in water starts a ring that
// spreads at 1 m/s and fades over 2 s, a shell's larger than a round's.
const tun = loadTunables();
const wt = waterTunables(tun);

describe("the water's rings", () => {
  it("a ring spreads at 1 m/s and fades over 2 s, a shell's larger than a round's", () => {
    expect([wt.ringSpeedMps, wt.ringFadeS, wt.maxRings]).toEqual([1, 2, 32]);
    const round: Ring = { at: [10, 1, 10], t0: 5, strength: ringStrength(1500, wt) };
    const shell: Ring = { at: [10, 1, 10], t0: 5, strength: ringStrength(3e6, wt) };
    expect(round.strength).toBeGreaterThan(0);
    expect(shell.strength).toBeGreaterThan(round.strength);
    expect(shell.strength).toBeLessThanOrEqual(1);
    expect(ringAt(round, 4.9, wt)).toBeNull();
    const second = ringAt(round, 6, wt)!;
    expect(second.radiusM).toBeCloseTo(1, 9);
    expect(second.age).toBeCloseTo(1, 9);
    // Fading as (1 − age / fade)².
    expect(second.heightM).toBeCloseTo(round.strength * wt.ringHeightM * 0.25, 9);
    expect(ringAt(round, 5.5, wt)!.heightM).toBeGreaterThan(second.heightM);
    expect(ringAt(round, 5 + wt.ringFadeS + 1e-6, wt)).toBeNull();
    expect(ringAt(shell, 6, wt)!.heightM).toBeGreaterThan(second.heightM);
  });
});
