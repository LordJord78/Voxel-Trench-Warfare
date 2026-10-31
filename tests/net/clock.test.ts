import { describe, expect, it } from 'vitest';
import { ServerClock } from '../../src/net/clock';
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
