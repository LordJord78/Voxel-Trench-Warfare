import { describe, expect, it } from 'vitest';
import { Ricochets, ricochetTunables } from '../../src/app/ricochets';
import type { Impact } from '../../src/combat/ballistics';
import { loadTunables } from '../../src/core/tunables';
import { P } from '../../src/world/materials';

// Embers and ricochets (the shots spec §1): every tracer strike leaves an ember; a graze sometimes
// glances off and flies on, burning, from the same hash of the impact every time.
const tun = loadTunables();
const t = ricochetTunables(tun);
type V3 = [number, number, number];

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A round of `speed` striking the top of cell (n, 3, 0) `deg` above the face's plane, going +x. */
function strike(n: number, material: number, deg: number, speed = 800, tick = 0): Impact & { tick: number } {
  const dir: V3 = [Math.cos(rad(deg)), -Math.sin(rad(deg)), 0];
  return { position: [n + 0.5, 4, 0.5], normal: [0, 1, 0], cell: [n, 3, 0], material, speed, distance: 100, energyJ: 3000, owner: 0, spec: 'ak', dir, kind: 1, tick };
}

const ricochetsOf = (material: number, deg: number, count = 1000): number => {
  const r = new Ricochets(t);
  let n = 0;
  for (let k = 0; k < count; k++) {
    r.strike(strike(k, material, deg), 1);
    n += r.flights().length;
    r.step(100); // all gone
  }
  return n;
};

const angle = (a: readonly number[], b: readonly number[]) => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]))))) * (180 / Math.PI);
};

describe('ricochets', () => {
  it('a grazing strike on steel ricochets about 60% of the time; one 40° to the face never does', () => {
    const steel = ricochetsOf(P.CORRUGATE, 10);
    expect(steel).toBeGreaterThan(540);
    expect(steel).toBeLessThan(660);
    expect(ricochetsOf(P.CORRUGATE, 40)).toBe(0);
    expect(ricochetsOf(P.CORRUGATE, 19)).toBe(0);
  });

  it('soil ricochets about 25% of grazing strikes', () => {
    const soil = ricochetsOf(P.SOD, 10);
    expect(soil).toBeGreaterThan(205);
    expect(soil).toBeLessThan(295);
  });

  it('a ricochet leaves along the reflection within 12°, at 0.35–0.6 of the speed, falls, and is gone by its burn', () => {
    const r = new Ricochets(t);
    let seen = 0;
    for (let k = 0; k < 200; k++) {
      r.step(100);
      r.strike(strike(k, P.CORRUGATE, 10), 1);
      const [f] = r.flights();
      if (!f) continue;
      seen++;
      // Advance a little: the head has moved off the strike along its way.
      r.step(0.01);
      const [g] = r.flights();
      const at: V3 = [k + 0.5, 4, 0.5];
      const way = [g.head[0] - at[0], g.head[1] - at[1], g.head[2] - at[2]];
      const reflection = [Math.cos(rad(10)), Math.sin(rad(10)), 0];
      // Over 10 ms gravity bends it by 0.5 mm: negligible against metres of travel.
      expect(angle(way, reflection)).toBeLessThanOrEqual(12.2);
      expect(way[1]).toBeGreaterThan(-0.05);
      const speed = Math.hypot(...way) / 0.01;
      expect(speed).toBeGreaterThanOrEqual(0.35 * 800 - 5);
      expect(speed).toBeLessThanOrEqual(0.6 * 800 + 5);
      // It falls: the next 0.2 s's drop is more than a straight line's.
      const y0 = g.head[1];
      r.step(0.1);
      const [h1] = r.flights();
      r.step(0.1);
      const [h2] = r.flights();
      expect(h2.head[1] - h1.head[1]).toBeLessThan(h1.head[1] - y0);
      expect(h2.alpha).toBeLessThan(h1.alpha);
      r.step(1);
      expect(r.flights()).toHaveLength(0);
    }
    expect(seen).toBeGreaterThan(80);
  });

  it('the same impacts give the same ricochets', () => {
    const a = new Ricochets(t);
    const b = new Ricochets(t);
    for (let k = 0; k < 50; k++) {
      a.strike(strike(k, P.TIMBER, 8, 800, k), 2);
      b.strike(strike(k, P.TIMBER, 8, 800, k), 2);
    }
    a.step(0.05);
    b.step(0.05);
    expect(a.flights().length).toBeGreaterThan(0);
    expect(a.flights()).toEqual(b.flights());
    expect(a.embers()).toEqual(b.embers());
  });

  it('never more than 64 fly; the oldest goes first', () => {
    const r = new Ricochets({ ...t, chanceHard: 1 });
    for (let k = 0; k < 100; k++) r.strike(strike(k, P.CORRUGATE, 5), 1);
    expect(r.flights()).toHaveLength(64);
    // The first 36 are gone: every flight left from a cell numbered 36 or more.
    for (const f of r.flights()) expect(f.head[0]).toBeGreaterThanOrEqual(36);
  });

  it('every tracer strike leaves an ember that fades over 0.35 s', () => {
    const r = new Ricochets(t);
    r.strike(strike(3, P.SOD, 80), 2);
    expect(r.flights()).toHaveLength(0);
    let [e] = r.embers();
    expect(e.at).toEqual([3.5, 4, 0.5]);
    expect(e.size).toBeCloseTo(0.06, 9);
    expect(e.kind).toBe(2);
    expect(e.alpha).toBeCloseTo(1, 9);
    r.step(0.175);
    [e] = r.embers();
    expect(e.alpha).toBeCloseTo(0.5, 6);
    r.step(0.18);
    expect(r.embers()).toHaveLength(0);
  });
});
