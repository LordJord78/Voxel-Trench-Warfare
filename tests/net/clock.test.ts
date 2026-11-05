import { describe, expect, it } from 'vitest';
import { ServerClock } from '../../src/net/clock';
import { BARE, encodeGear } from '../../src/net/gear';
import { INTERP_DELAY_MS, SnapshotBuffer } from '../../src/net/interp';
import type { PlayerState } from '../../src/net/protocol';

const at = (x: number, yaw: number, tick: number, stance = 0): PlayerState => ({ tick, position: [x, 0, 0], velocity: [0, 0, 0], yaw, pitch: 0, stance, height: 1.8, flags: 0 });

describe("the room's clock", () => {
  it('believes the round trip that took least', () => {
    // The room runs 5000 ms ahead; trips of 40 ms evenly split, then a slow one that queued on the way back.
    const c = new ServerClock();
    expect(c.synced).toBe(false);
    c.sample(1000, 6020, 1040);
    c.sample(2000, 7020, 2300);
    expect(c.rtt).toBe(40);
    expect(c.serverAt(3000)).toBeCloseTo(8000, 6);
    expect(c.localAt(8000)).toBeCloseTo(3000, 6);
  });
});

describe('the snapshot buffer', () => {
  it('blends position and view between the states either side, the short way round', () => {
    const b = new SnapshotBuffer();
    b.push(1000, at(0, 350, 1));
    b.push(1050, at(1, 10, 4, 1));
    const mid = b.sample(1025)!;
    expect(mid.position[0]).toBeCloseTo(0.5, 9);
    expect(((mid.yaw % 360) + 360) % 360).toBeCloseTo(0, 6);
    expect(b.sample(1040)!.stance).toBe(1);
    // Before the first and after the last: held at the ends, not guessed beyond them.
    expect(b.sample(900)!.position[0]).toBe(0);
    expect(b.sample(2000)!.position[0]).toBe(1);
  });

  it('keeps what they show between two states: the gear as the flags are, the nearer state\'s', () => {
    // An SVD with its scope and its light on, then the shovel (net/gear.ts): a sample nearly always
    // falls between two states, and without the gear every other player was drawn with the bare AK.
    const svd = encodeGear({ gun: 'svd', fit: { ...BARE, optic: 'scope', side: 'flashlight' }, light: true });
    const shovel = encodeGear({ gun: null, fit: BARE, light: false });
    expect(svd).not.toBe(shovel);
    const b = new SnapshotBuffer();
    b.push(1000, { ...at(0, 0, 1), gear: svd });
    b.push(1050, { ...at(1, 0, 4), gear: shovel });
    expect(b.sample(1020)!.gear).toBe(svd);
    expect(b.sample(1030)!.gear).toBe(shovel);
    // A state that says nothing of it (an older sender's) says nothing in a blend either.
    const bare = new SnapshotBuffer();
    bare.push(1000, at(0, 0, 1));
    bare.push(1050, at(1, 0, 4));
    expect(bare.sample(1020)).not.toHaveProperty('gear');
  });

  it('drops states out of order, and lets go of old ones', () => {
    const b = new SnapshotBuffer();
    b.push(1000, at(0, 0, 10));
    b.push(990, at(5, 0, 11));
    b.push(1010, at(5, 0, 9));
    expect(b.newest!.at).toBe(1000);
    for (let k = 1; k <= 60; k++) b.push(1000 + k * 50, at(k, 0, 10 + k));
    expect(b.sample(1000 + INTERP_DELAY_MS)!.position[0]).toBeGreaterThan(1.5);
    expect(b.sample(1000)!.position[0]).toBeGreaterThan(20);
  });
});
