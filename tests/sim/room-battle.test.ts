import { describe, expect, it } from 'vitest';
import type { Strike } from '../../src/battle/director';
import { fireTunables } from '../../src/battle/fires';
import { loadTunables } from '../../src/core/tunables';
import { SILENT_STEP_S } from '../../src/net/clock';
import type { ClientMsg, RoomShell } from '../../src/net/protocol';
import type { Crater } from '../../src/sim/destruction';
import type { Harm } from '../../src/sim/session';
import { fuelNear } from '../../src/world/char';
import { K, kindOf, P } from '../../src/world/materials';
import { lateRunner, roomClient, sameWorld, trenchArena, type RoomClient } from '../support/worlds';

// The room's shells on a page (the shared-battle spec's "Clients"): each whistles from when it is
// heard for the time it has left, and lands when the room's clock reaches it, in id order, once; its
// crater is cut where the ground is when it goes out, so clients whose clocks and workers disagree
// cut the same world; a crater on what burns is a strike from its shell's seed; a blast's harm on
// the player is sent as a hurt while they are in play; and a shell long overdue, or still in the
// air at the match's end, lands quietly: its crater, and no blast.
//
// Each client is a session on the trench arena (no plan) set to a room, as Together sets it in a
// match; its player on the open clay, 10 m clear of the parapet's foot.
const tun = loadTunables();
const fireT = fireTunables(tun);
const PLAYER: [number, number, number] = [12.8, 6.4, 3.0];
const V = 0.1;

const shell = (id: number, landAt: number, x: number, z: number, radius = 3, seed = 100 + id): RoomShell => ({ id, landAt, at: [x, z], radius, seed });

/** A client stepped to room time `ms`, its events since drained. */
function client(ms = 1_000, map = trenchArena(), offsetMs = 0, frameS = 1 / 60, late?: number): RoomClient {
  const c = roomClient(map, PLAYER, offsetMs, frameS, late === undefined ? undefined : lateRunner(late));
  c.step(ms);
  c.session.drainEvents();
  return c;
}

describe("the room's shells on a page", () => {
  it("whistles a shell from when it is heard, for the time it has left, and lands it when the room's clock reaches it", () => {
    const c = client(8_600);
    const s = shell(1, 10_000, 12.8, 15.0);
    c.battle.hear(s, 8_600);
    expect(c.session.drainEvents().incoming).toEqual([{ tick: c.session.ticks, at: [12.8, 7.6000000000000005, 15.0], landsInS: 1.4 }]);
    expect(c.battle.waiting).toEqual([s]);
    expect(c.battle.landed).toEqual([]);
    c.battle.tick(9_999);
    expect(c.session.drainEvents().blasts).toEqual([]);
    c.battle.tick(10_000);
    const e = c.session.drainEvents();
    expect(e.blasts.map((b) => [b.at[0], b.at[2], b.radiusM, b.seed])).toEqual([[12.8, 15.0, 3, s.seed]]);
    expect(c.battle.waiting).toEqual([]);
    expect(c.battle.landed).toEqual([s]);
  });

  it('lands a shell heard late at once, without a whistle, and a shell heard twice once', () => {
    const c = client(10_500);
    const s = shell(1, 10_000, 12.8, 15.0);
    // Half a second late: within SILENT_STEP_S, so it is heard landing.
    c.battle.hear(s, 10_500);
    expect(c.session.drainEvents().incoming).toEqual([]);
    c.battle.tick(10_500);
    expect(c.session.drainEvents().blasts).toHaveLength(1);
    c.battle.hear(s, 10_600);
    c.battle.tick(10_600);
    expect(c.session.drainEvents().blasts).toEqual([]);
    const craters: Crater[] = [];
    c.step(11_500, (e) => craters.push(...e.craters));
    expect(craters).toHaveLength(1);
    expect(c.battle.landed).toEqual([s]);
  });

  it('lands shells in id order, however they were heard', () => {
    const c = client(9_600);
    const two = shell(2, 9_000, 9.0, 15.0);
    const three = shell(3, 9_500, 16.0, 15.0);
    c.battle.hear(three, 9_600);
    c.battle.hear(two, 9_600);
    c.battle.tick(9_600);
    const e = c.session.drainEvents();
    expect(e.blasts.map((b) => b.seed)).toEqual([two.seed, three.seed]);
    expect(c.battle.landed.map((s) => s.id)).toEqual([2, 3]);
    const craters: Crater[] = [];
    c.step(10_600, (ev) => craters.push(...ev.craters));
    expect(craters.map((k) => k.id)).toEqual(e.blasts.map((b) => b.crater));
  });

  it('two clients whose clocks disagree by 0.2 s, and whose craters come back at different times, cut the same craters', () => {
    // Review Focus: clock skew. Six overlapping shells on the parapet, 2.5 s apart.
    const shells = Array.from({ length: 6 }, (_, k) => shell(10 + k, 10_000 + 2_500 * k, 9.5 + 1.3 * k, 15.4 - 0.25 * k, 2.4 + 0.2 * k, 7_000 + k));
    // Each client hears each shell 1.5 s before it lands, by the room's clock, after its own latency;
    // it tells the time by its own clock.
    const run = (c: RoomClient, latencyMs: number) => {
      const blasts: number[] = [];
      for (const s of shells) {
        const heard = s.landAt - 1_500 + latencyMs;
        c.step(heard, (e) => blasts.push(...e.blasts.map((b) => b.seed!)));
        c.battle.hear(s, heard + c.offsetMs);
      }
      c.step(shells[5].landAt + 14_000, (e) => blasts.push(...e.blasts.map((b) => b.seed!)));
      return blasts;
    };
    // A: its clock true, 60 frames a second, its craters back at once. B: its clock 200 ms behind, 45
    // frames a second, each crater back 200 ticks (3.3 s) after it went out: later than the next shell.
    const a = client(0);
    const b = client(0, trenchArena(), -200, 1 / 45, 200);
    expect(run(a, 30)).toEqual(shells.map((s) => s.seed));
    expect(run(b, 120)).toEqual(shells.map((s) => s.seed));
    for (const c of [a, b]) {
      expect(c.battle.landed.map((s) => s.id)).toEqual(shells.map((s) => s.id));
      expect(c.session.destruction.pending).toBe(0);
    }
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
    expect(sameWorld(a.session.map, trenchArena())).toBe(false);
  }, 60_000);

  it("a crater on timber is a strike from its shell's seed once it is in, standing on what it left", () => {
    // A timber floor a metre thick on the clay beyond the parapet; and a shell on the parapet's spoil, which cannot burn.
    const map = trenchArena();
    map.fillBox(20, 64, 180, 100, 74, 250, P.TIMBER);
    const c = client(1_000, map);
    const timber = shell(1, 2_000, 6.0, 21.5, 2.2, 4_242);
    const spoil = shell(2, 2_500, 20.0, 15.0, 2.2, 4_243);
    c.battle.hear(timber, 1_000);
    c.battle.hear(spoil, 1_000);
    const struck: Strike[] = [];
    const craters: Crater[] = [];
    c.step(4_000, (e) => {
      const got = c.battle.strikes(e);
      // None as the shell lands: only once its crater is in.
      if (got.length > 0) expect(e.craters.map((k) => k.id)).toContain(got[0].crater);
      struck.push(...got);
      craters.push(...e.craters);
    });
    expect(craters).toHaveLength(2);
    const [onTimber, onSpoil] = craters;
    expect(onTimber.material).toBe(P.TIMBER);
    expect(onSpoil.material).toBe(P.SPOIL);
    const fuel = fuelNear(c.session.map, onTimber.centre.map((m) => m * V), onTimber.radius * V + fireT.charM, V);
    expect(fuel).not.toBeNull();
    expect(struck).toEqual([{ at: fuel, material: P.TIMBER, crater: onTimber.id, seed: 4_242 }]);
    // On what the crater left: timber under it, open air over it.
    const [x, y, z] = [Math.floor(fuel![0] / V), Math.round(fuel![1] / V), Math.floor(fuel![2] / V)];
    expect(kindOf(c.session.map.get(x, y - 1, z))).toBe(K.TIMBER);
    expect(c.session.map.get(x, y, z)).toBe(P.AIR);
  });

  it('sends each harm as a hurt, at most 200, and nothing while not in play', () => {
    const c = client(1_000);
    // A shell 2 m ahead of the player.
    c.battle.hear(shell(1, 1_500, PLAYER[0], PLAYER[2] + 2), 1_000);
    const harms: Harm[] = [];
    const sent: ClientMsg[] = [];
    const out: ClientMsg[] = [];
    c.step(1_600, (e) => {
      harms.push(...e.harms);
      sent.push(...c.battle.outgoing(e, true));
      out.push(...c.battle.outgoing(e, false));
    });
    expect(harms.map((h) => h.cause)).toEqual(['shell']);
    expect(harms[0].amount).toBeGreaterThan(100);
    expect(sent).toEqual([{ t: 'hurt', a: harms[0].amount, c: 'shell' }]);
    expect(out).toEqual([]);
    // Capped at the room's most; under 1, nothing; each by its own cause.
    const events = { ...c.session.drainEvents(), harms: [{ tick: 1, amount: 250, cause: 'shell' }, { tick: 1, amount: 0.6, cause: 'shell' }, { tick: 2, amount: 33, cause: 'round' }] satisfies Harm[] };
    expect(c.battle.outgoing(events, true)).toEqual([{ t: 'hurt', a: 200, c: 'shell' }, { t: 'hurt', a: 33, c: 'round' }]);
    expect(c.battle.outgoing(events, false)).toEqual([]);
  });

  it('the match over, every shell heard lands at once, quietly', () => {
    const c = client(1_000);
    const near = shell(1, 3_000, PLAYER[0], PLAYER[2] + 2);
    const far = shell(2, 5_500, 12.8, 15.0);
    c.battle.hear(far, 1_000);
    c.battle.hear(near, 1_000);
    expect(c.session.drainEvents().incoming).toHaveLength(2);
    c.battle.finish();
    expect(c.battle.waiting).toEqual([]);
    expect(c.battle.landed.map((s) => s.id)).toEqual([1, 2]);
    const e = c.session.drainEvents();
    expect([e.blasts, e.harms, e.incoming]).toEqual([[], [], []]);
    // Their craters are cut all the same, and harm no one.
    const craters: Crater[] = [];
    const harms: Harm[] = [];
    c.step(2_000, (ev) => {
      craters.push(...ev.craters);
      harms.push(...ev.harms);
    });
    expect(craters).toHaveLength(2);
    expect(harms).toEqual([]);
    expect(c.session.destruction.pending).toBe(0);
    expect(sameWorld(c.session.map, trenchArena())).toBe(false);
    // The room's clock reaching them lands nothing again.
    c.battle.tick(6_000);
    expect(c.session.drainEvents().blasts).toEqual([]);
  });

  it('a shell 3 s overdue (a hidden tab back) lands its crater with no harm', () => {
    // The player 2 m from it; the tab back at `back`, its queued shell heard and the battle ticked then.
    const run = (back: number) => {
      const c = client(back);
      c.battle.hear(shell(1, 10_000, PLAYER[0], PLAYER[2] + 2), back);
      c.battle.tick(back);
      const e = c.session.drainEvents();
      const craters: Crater[] = [];
      c.step(back + 500, (ev) => craters.push(...ev.craters));
      return { e, craters: craters.length, landed: c.battle.landed.length };
    };
    const away = run(13_000);
    expect([away.e.incoming, away.e.blasts, away.e.harms]).toEqual([[], [], []]);
    expect([away.craters, away.landed]).toEqual([1, 1]);
    // Within SILENT_STEP_S, its blast and its harm; past it by a millisecond, quiet.
    expect(SILENT_STEP_S).toBe(1);
    for (const back of [10_500, 11_000]) {
      const soon = run(back);
      expect(soon.e.blasts, `${back}`).toHaveLength(1);
      expect(soon.e.harms.map((h) => h.cause), `${back}`).toEqual(['shell']);
      expect(soon.e.harms[0].amount).toBeGreaterThan(100);
      expect(soon.craters).toBe(1);
    }
    const past = run(11_001);
    expect([past.e.blasts, past.e.harms]).toEqual([[], []]);
    expect(past.craters).toBe(1);
  });
});
