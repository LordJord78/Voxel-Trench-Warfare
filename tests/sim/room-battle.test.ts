import { describe, expect, it } from 'vitest';
import { Director, type BattleEvents, type BattleInputs, type Strike } from '../../src/battle/director';
import { fireTunables, roomStrike } from '../../src/battle/fires';
import { packCell, scoopBox } from '../../src/combat/entrenching';
import { loadTunables } from '../../src/core/tunables';
import { SILENT_STEP_S } from '../../src/net/clock';
import type { ClientMsg, Dig, MatchLog, RoomShell } from '../../src/net/protocol';
import type { Crater, DetonationRunner } from '../../src/sim/destruction';
import { RoomBattle, type BattleCatchUp } from '../../src/sim/room-battle';
import { idleIntent, type CombatEvents, type Harm } from '../../src/sim/session';
import type { BrickMap } from '../../src/world/bricks';
import { CharQueue, fuelNear } from '../../src/world/char';
import { detonationRegion } from '../../src/world/detonation';
import { K, kindOf, P } from '../../src/world/materials';
import type { Box } from '../../src/world/region';
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
//
// And the room's scoops (spec note 9): one stamped `s` lands every heard shell due by `s` first,
// then waits while a crater's region it touches is pending, or an earlier held scoop overlaps it,
// so every client digs it on the same side of the same craters as its digger did. Every call of
// `dug` passes, as its `nowMs`, the client's own clock (room time + offsetMs).
const tun = loadTunables();
const fireT = fireTunables(tun);
const PLAYER: [number, number, number] = [12.8, 6.4, 3.0];
const V = 0.1;

const shell = (id: number, landAt: number, x: number, z: number, radius = 3, seed = 100 + id): RoomShell => ({ id, landAt, at: [x, z], radius, seed });

/**
 * The arena with a bank of spoil 0.6 m high along x on the open clay, z 4.8–6.2 m at its foot, at
 * its angle of repose (standing steeper, a crater's slump runs the length of it): shovel work for a
 * player at z 4.4 facing +z.
 */
function heaped(): BrickMap {
  const map = trenchArena();
  for (let y = 64; y < 70; y++) map.fillBox(0, y, 48 + (y - 64), 256, y + 1, 62 - (y - 64), P.SPOIL);
  map.takeDirty();
  return map;
}
/** At the bank, facing it. */
const DIGGER: [number, number, number] = [12.8, 6.4, 4.4];
/** Beyond the parapet, out of everyone's way: where a receiver stands. */
const AWAY: [number, number, number] = [12.8, 6.4, 20.0];

/** A scoop as its digger made it: its cells, and the room time of the frame it was made in. */
interface Made {
  cells: number[];
  ms: number;
}

/** `c`, stepped to room time `from`, digs (F held) until it has made a scoop, then lets go: the scoop. Each frame's events go to `each` too. */
function digOnce(c: RoomClient, from: number, each?: (events: CombatEvents) => void): Made {
  let made: Made | null = null;
  c.session.intent = { ...idleIntent(), dig: true };
  for (let ms = from; made === null; ms += 10) {
    if (ms > from + 10_000) throw new Error('no scoop in 10 s');
    c.step(ms, (e) => {
      each?.(e);
      if (e.scoops.length) made = { cells: e.scoops[0].cells, ms };
    });
  }
  c.session.intent = idleIntent();
  return made;
}

/** Whether two boxes overlap across x and z, as Destruction asks of regions. */
const across = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

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
      struck.push(...c.battle.strikes(e));
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
    // A crater on the timber that is none of the room's shells (the session's own land): no strike,
    // though its crater says it struck timber and would light it were it the room's.
    const own = c.session.land(3.0, 24.0, 2.2, 4_244);
    const ownCraters: Crater[] = [];
    c.step(6_000, (e) => {
      expect(c.battle.strikes(e)).toEqual([]);
      ownCraters.push(...e.craters);
    });
    expect(ownCraters.map((k) => k.id)).toEqual([own]);
    expect(ownCraters[0].material).toBe(P.TIMBER);
    expect(roomStrike(c.session.map, ownCraters[0], 4_244, V, fireT)).not.toBeNull();
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
    // As after a match in which no frame ran here: nothing set the session to the room.
    c.session.room = false;
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
    // Cut where the ground is, as the room's are on every page: each says what it struck.
    expect(craters.map((k) => k.material)).toEqual([P.CLAY, P.SPOIL]);
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

  it("a dig stamped after a shell landed waits for its crater, then goes in: the digger's world and a receiver's agree", () => {
    // Review Focus: a dig and a crater. S lands on the bank 2.6 m ahead of A.
    const S = shell(1, 3_000, 12.8, 7.0, 1.5, 501);
    // A: its clock true, its craters back at once. It hears S, and digs: its scoop waits for S's
    // crater, then goes in its rim, stamped 300 ms after S landed.
    const a = roomClient(heaped(), DIGGER);
    a.step(1_530);
    a.battle.hear(S, 1_530);
    a.step(2_000);
    const made = digOnce(a, 2_000);
    expect(made.ms).toBeGreaterThan(S.landAt);
    expect(made.ms).toBeLessThan(S.landAt + 270);
    a.step(8_000);
    const d: Dig = { seat: 0, at: S.landAt + 300, cells: made.cells };
    // B: its clock 200 ms behind, 45 frames a second, its craters back 60 ticks (1 s) after they go
    // out. It hears S; its frames reach room time S.landAt + 150 (its clock 50 ms short of S's time)
    // and stall, and the dig is handed it at room time S.landAt + 330, before its next tick, as
    // Together feeds the room's edits before it ticks the battle.
    const b = roomClient(heaped(), AWAY, -200, 1 / 45, lateRunner(60));
    b.step(1_560);
    b.battle.hear(S, 1_560 + b.offsetMs);
    b.step(S.landAt + 150);
    expect(b.battle.waiting).toEqual([S]);
    b.battle.dug(d, S.landAt + 330 + b.offsetMs);
    // S lands at once, the dig after it: held while S's crater is pending, then in.
    expect(b.battle.landed).toEqual([S]);
    expect(b.battle.waiting).toEqual([]);
    expect(b.battle.held).toEqual([d]);
    const box = scoopBox(b.session.map.dims, d.cells);
    expect(b.session.destruction.overlapsPending(box)).toBe(true);
    let held = 0;
    b.step(8_000, () => {
      if (!b.session.destruction.overlapsPending(box)) return;
      held++;
      expect(b.battle.held).toEqual([d]);
    });
    expect(held).toBeGreaterThan(30);
    expect(b.battle.held).toEqual([]);
    expect(b.session.destruction.pending).toBe(0);
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
    expect(sameWorld(a.session.map, heaped())).toBe(false);
  }, 30_000);

  it('a dig stamped before a shell lands goes in first, on a client whose clock has not reached it too', () => {
    // A digs once at the bank, then hears S. The room stamped the scoop 40 ms after A dug it and 20 ms
    // after it told S, so a receiver hears S first, and then the dig, stamped 1.48 s before S lands.
    const a = roomClient(heaped(), DIGGER);
    a.step(1_000);
    const made = digOnce(a, 1_000);
    const stamp = Math.round(made.ms) + 40;
    const S = shell(1, stamp - 20 + 1_500, 12.8, 7.0, 1.5, 502);
    a.step(stamp + 10);
    a.battle.hear(S, stamp + 10);
    a.step(S.landAt + 4_000);
    const d: Dig = { seat: 0, at: stamp, cells: made.cells };
    // Receivers whose craters come back half a second late: one whose clock is 200 ms behind, which
    // has not reached the dig's stamp when it is handed it, and one 200 ms ahead.
    for (const offset of [-200, 200]) {
      const r = roomClient(heaped(), AWAY, offset, 1 / 45, lateRunner(30));
      r.step(stamp + 10);
      r.battle.hear(S, stamp + 10 + offset);
      r.step(stamp + 30);
      r.battle.dug(d, stamp + 30 + offset);
      expect(r.battle.landed, `${offset}`).toEqual([]);
      expect(r.battle.held).toEqual([d]);
      const order: string[] = [];
      r.step(S.landAt + 4_000, (e) => {
        if (r.battle.held.length === 0 && !order.includes('dig')) order.push('dig');
        if (e.blasts.length) order.push('blast');
      });
      expect(order, `${offset}`).toEqual(['dig', 'blast']);
      expect(r.battle.landed).toEqual([S]);
      expect(r.session.destruction.pending).toBe(0);
      expect(sameWorld(a.session.map, r.session.map), `${offset}`).toBe(true);
    }
  }, 30_000);

  it('held digs go in in the order they came', () => {
    // S on the bank toward the arena's west end. A digs, once S's crater is in, at x 12.75 m, then
    // 0.6 m east, then far east: d1 reaches into S's region; d2 does not, but overlaps d1; d3
    // overlaps neither.
    const S = shell(1, 3_000, 4.0, 7.0, 1.5, 503);
    const a = roomClient(heaped(), [12.75, 6.4, 4.4]);
    a.step(1_530);
    a.battle.hear(S, 1_530);
    a.step(2_000);
    const made: Made[] = [digOnce(a, 2_000)];
    for (const x of [13.35, 22.0]) {
      a.session.teleport([x, 6.4, 4.4], 0, 0);
      made.push(digOnce(a, made[made.length - 1].ms));
    }
    a.step(9_000);
    const [d1, d2, d3] = made.map((m): Dig => ({ seat: 0, at: Math.round(m.ms) + 30, cells: m.cells }));
    const dims = a.session.map.dims;
    const region = detonationRegion(dims, [S.at[0] / V, 0, S.at[1] / V], S.radius / V, tun.f('destruction.loosen_radius_scale'))!;
    const [b1, b2, b3] = [d1, d2, d3].map((d) => scoopBox(dims, d.cells));
    expect([across(b1, region), across(b2, region), across(b3, region)]).toEqual([true, false, false]);
    expect([across(b2, b1), across(b3, b1), across(b3, b2)]).toEqual([true, false, false]);
    // B: its craters back 2.5 s late, so S's is still pending as the three come.
    const b = roomClient(heaped(), AWAY, -200, 1 / 45, lateRunner(150));
    b.step(1_560);
    b.battle.hear(S, 1_560 + b.offsetMs);
    const heldAfter: Dig[][] = [];
    for (const d of [d1, d2, d3]) {
      b.step(d.at + 30);
      b.battle.dug(d, d.at + 30 + b.offsetMs);
      b.step(d.at + 60);
      heldAfter.push([...b.battle.held]);
    }
    expect(b.battle.landed).toEqual([S]);
    expect(b.session.destruction.pending).toBe(1);
    // d1 waits for S's crater, d2 for d1; d3 goes in at once.
    expect(heldAfter).toEqual([[d1], [d1, d2], [d1, d2]]);
    let wider = false;
    b.step(9_000, () => (wider ||= b.session.destruction.out.some((o) => o.x1 > region.x1)));
    expect(wider).toBe(false);
    expect(b.battle.held).toEqual([]);
    expect(b.session.destruction.pending).toBe(0);
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
  }, 30_000);

  it("a dig between two craters stays between them on a tab back from hidden and behind a slow worker: the digger's world and the receivers' agree", () => {
    // S1 lands on the bank 2.6 m ahead of A; A digs in its rim once its crater is in; S2, told after
    // that, lands over the scoop. A's world is S1, the dig, then S2.
    const S1 = shell(1, 3_000, 12.8, 7.0, 1.5, 505);
    const S2 = shell(2, 6_000, 12.4, 6.6, 1.5, 506);
    const a = roomClient(heaped(), DIGGER);
    a.step(1_530);
    a.battle.hear(S1, 1_530);
    a.step(2_000);
    const made = digOnce(a, 2_000);
    expect(made.ms).toBeLessThan(S2.landAt - 1_500);
    a.step(4_530);
    a.battle.hear(S2, 4_530);
    a.step(12_000);
    const d: Dig = { seat: 0, at: Math.round(made.ms) + 30, cells: made.cells };
    const box = scoopBox(a.session.map.dims, d.cells);
    const loosen = tun.f('destruction.loosen_radius_scale');
    const region = (s: RoomShell) => detonationRegion(a.session.map.dims, [s.at[0] / V, 0, s.at[1] / V], s.radius / V, loosen)!;
    expect([across(box, region(S1)), across(box, region(S2))]).toEqual([true, true]);
    /** What `r` does from here to room time 14 000: each crater as it lands, and the dig as it goes in. */
    const order = (r: RoomClient) => {
      const seen: string[] = [];
      r.step(14_000, (e) => {
        if (r.battle.held.length === 0 && !seen.includes('dig')) seen.push('dig');
        for (const c of e.craters) seen.push(`crater ${c.id}`);
      });
      return seen;
    };
    // B: its tab hidden from room time 1 000 to 8 000. Back, it is fed the three edits it queued, in
    // the room's order, before its first tick: S1, the dig (which lands S1, quietly), then S2.
    const b = roomClient(heaped(), AWAY, -200);
    b.step(1_000);
    b.skip(8_000);
    b.battle.hear(S1, 8_000 + b.offsetMs);
    b.battle.dug(d, 8_000 + b.offsetMs);
    b.battle.hear(S2, 8_000 + b.offsetMs);
    expect(b.battle.landed).toEqual([S1]);
    expect(b.battle.held).toEqual([d]);
    expect(order(b)).toEqual(['crater 1', 'dig', 'crater 2']);
    // C: its frames run on, but its craters come back 240 ticks (4 s) after they go out, so S1's is
    // still being cut when S2 lands, and the dig is held behind it all that while.
    const c = roomClient(heaped(), AWAY, -200, 1 / 45, lateRunner(240));
    c.step(1_560);
    c.battle.hear(S1, 1_560 + c.offsetMs);
    c.step(d.at + 30);
    c.battle.dug(d, d.at + 30 + c.offsetMs);
    c.step(4_530);
    c.battle.hear(S2, 4_530 + c.offsetMs);
    c.step(S2.landAt - c.offsetMs + 100);
    expect(c.battle.landed).toEqual([S1, S2]);
    expect(c.battle.held).toEqual([d]);
    expect(c.session.destruction.pending).toBe(2);
    expect(order(c)).toEqual(['crater 1', 'dig', 'crater 2']);
    for (const r of [b, c]) {
      expect(r.battle.held).toEqual([]);
      expect(r.session.destruction.pending).toBe(0);
    }
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
    expect(sameWorld(a.session.map, c.session.map)).toBe(true);
  }, 30_000);

  it('a dig that lands a shell more than SILENT_STEP_S overdue lands it quietly', () => {
    // A hidden tab back: its queued edits are fed before its tick. The player 2 m from the shell,
    // heard at 9 000; the dig, stamped 10 200, fed at `back`.
    const run = (back: number) => {
      const c = client(9_000);
      const s = shell(1, 10_000, PLAYER[0], PLAYER[2] + 2);
      c.battle.hear(s, 9_000);
      c.session.drainEvents();
      const d: Dig = { seat: 3, at: 10_200, cells: [packCell(c.session.map.dims, 128, 70, 150)] };
      c.battle.dug(d, back);
      const e = c.session.drainEvents();
      expect(c.battle.landed, `${back}`).toEqual([s]);
      expect(c.battle.held).toEqual([d]);
      const craters: Crater[] = [];
      c.step(10_000, (ev) => craters.push(...ev.craters));
      return { e, craters: craters.length, held: c.battle.held.length };
    };
    const away = run(13_000);
    expect([away.e.incoming, away.e.blasts, away.e.harms]).toEqual([[], [], []]);
    expect([away.craters, away.held]).toEqual([1, 0]);
    const soon = run(10_500);
    expect(soon.e.blasts).toHaveLength(1);
    expect(soon.e.harms.map((h) => h.cause)).toEqual(['shell']);
    expect(soon.e.harms[0].amount).toBeGreaterThan(100);
    expect([soon.craters, soon.held]).toEqual([1, 0]);
  });

  it('sends each scoop it dug, and nothing while not in play', () => {
    const a = roomClient(heaped(), DIGGER);
    a.step(1_000);
    a.session.intent = { ...idleIntent(), dig: true };
    const digs: Dig[] = [];
    let frame = 60;
    a.step(4_000, (e) => {
      frame++;
      const sent = a.battle.outgoing(e, true);
      expect(sent).toEqual(e.scoops.map((s) => ({ t: 'dig', c: s.cells })));
      expect(a.battle.outgoing(e, false)).toEqual([]);
      for (const m of sent) if (m.t === 'dig') digs.push({ seat: 0, at: Math.round((frame * 1000) / 60) + 30, cells: m.c });
    });
    expect(digs.length).toBeGreaterThanOrEqual(8);
    // B, not digging, is given each of A's: dug in its world, never sent back, and no scoop of its own.
    const b = roomClient(heaped(), AWAY, -200);
    b.step(4_050);
    for (const d of digs) b.battle.dug(d, 4_050 + b.offsetMs);
    expect(b.battle.held).toEqual(digs);
    let frames = 0;
    b.step(4_500, (e) => {
      frames++;
      expect(e.scoops).toEqual([]);
      expect(b.battle.outgoing(e, true).filter((m) => m.t === 'dig')).toEqual([]);
    });
    expect(frames).toBeGreaterThan(20);
    expect(b.battle.held).toEqual([]);
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
  });

  it("a dig held when the match ends goes in during the next: the digger's world and the holder's agree", () => {
    const S = shell(1, 3_000, 12.8, 7.0, 1.5, 504);
    const a = roomClient(heaped(), DIGGER);
    a.step(1_530);
    a.battle.hear(S, 1_530);
    a.step(2_000);
    const made = digOnce(a, 2_000);
    a.step(8_000);
    const d: Dig = { seat: 0, at: Math.round(made.ms) + 30, cells: made.cells };
    // B stands 2.6 m from S, its craters back 1 s late; its tab hidden through the match, no frame
    // ran. The match ends: Together hears the queued edits at +∞ (the controller's ruling), so S, due
    // by the dig's stamp, lands quietly as the dig is fed (no whistle, blast or harm), and the dig is
    // held behind its crater.
    const b = roomClient(heaped(), DIGGER, -200, 1 / 45, lateRunner(60));
    b.step(1_000);
    b.battle.hear(S, Number.POSITIVE_INFINITY);
    b.battle.dug(d, Number.POSITIVE_INFINITY);
    const e = b.session.drainEvents();
    expect([e.incoming, e.blasts, e.harms]).toEqual([[], [], []]);
    expect(b.battle.landed).toEqual([S]);
    expect(b.battle.held).toEqual([d]);
    const carried = b.battle.finish();
    expect(carried).toEqual([d]);
    expect(b.battle.held).toEqual([]);
    // The lobby ticks nothing. The next match's battle on B's session is given the dig before its first tick.
    b.battle = new RoomBattle(b.session, fireT);
    for (const k of carried) b.battle.dug(k, 1_000 + b.offsetMs);
    expect(b.battle.held).toEqual([d]);
    const box = scoopBox(b.session.map.dims, d.cells);
    let held = 0;
    b.step(4_000, () => {
      if (!b.session.destruction.overlapsPending(box)) return;
      held++;
      expect(b.battle.held).toEqual([d]);
    });
    expect(held).toBeGreaterThan(30);
    expect(b.battle.held).toEqual([]);
    expect(b.session.destruction.pending).toBe(0);
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
  }, 30_000);
});

// The room's log caught up (spec notes 5, 9 and 10): a page that joins or reloads mid-match lands the
// log's shells and scoops in time order, quietly, each crater settled before the next, and runs the
// battle around it (the page's Director) along the log, given each crater's strike; so its world is
// a client's that was there all along. Shells still in the air are heard for the time they have
// left. An earlier match's entries, and in the lobby every one, land with no battle run.

/** A shell as the room's log holds it: [id, landAt, x mm, z mm, radius mm, seed]. */
const wireShell = (s: RoomShell): number[] => [s.id, s.landAt, Math.round(s.at[0] * 1000), Math.round(s.at[1] * 1000), Math.round(s.radius * 1000), s.seed];
/** A scoop as the room's log holds it: [seat, at, ...cells]. */
const wireDig = (d: Dig): number[] => [d.seat, d.at, ...d.cells];
const logOf = (shells: readonly RoomShell[], digs: readonly Dig[] = []): MatchLog => ({ shells: shells.map(wireShell), digs: digs.map(wireDig) });

/** Whether any voxel of `map` is `material`. */
function holds(map: BrickMap, material: number): boolean {
  const voxels = new Uint8Array(512);
  for (let bi = 0; bi < map.table.length; bi++) {
    map.readBrick(bi, voxels);
    if (voxels.includes(material)) return true;
  }
  return false;
}

/** The heaped arena with a timber wall along the parapet's back, 0.8 m thick and as high as its crest: z 16.4–17.2 m. */
function walled(): BrickMap {
  const map = heaped();
  map.fillBox(0, 64, 164, 256, 76, 172, P.TIMBER);
  map.takeDirty();
  return map;
}

/** The battle's inputs around a client: the light tempo, by day, at its player's feet. */
const battleInputs = (c: RoomClient): BattleInputs => ({ intensity: 'light', darkness: 0, player: c.session.player.position.toArray() });
const BATTLE_SEED = 11;

/** The chars the battle's fires make at their full burn, made in `c`'s world once no crater is pending about them, as the page makes them in a match; and the crater each fire stood by. */
function charring(c: RoomClient): { made: (events: BattleEvents) => void; craters: (number | null)[] } {
  const chars = new CharQueue(fireT.charM, V);
  const craters: (number | null)[] = [];
  return {
    craters,
    made: (events) => {
      for (const ch of events.chars) {
        chars.add(ch.at);
        craters.push(ch.crater);
      }
      chars.make(c.session.map, (box) => c.session.destruction.overlapsPending(box));
    },
  };
}

/** A client there all along, from the match's start at room time 0: each frame its shells' strikes go to the battle around it (a Director over no plan), which runs on by the frame, its chars made as they come. */
function liveClient(map: BrickMap) {
  const c = roomClient(map, DIGGER);
  const director = new Director(null, tun, BATTLE_SEED);
  const char = charring(c);
  const frame = (e: CombatEvents) => char.made(director.tick(1 / 60, { ...battleInputs(c), strikes: c.battle.strikes(e) }));
  return { c, frame, charred: char.craters };
}

/** A joiner's battle as main.ts's catch-up runs it: on to each second asked, at most 1 s a step, its strikes given it first, its chars made at once. */
function catchUpBattle(c: RoomClient) {
  const director = new Director(null, tun, BATTLE_SEED);
  const char = charring(c);
  let reached = 0;
  const battle: BattleCatchUp = {
    runTo: (s, strikes) => {
      char.made(director.tick(0, { ...battleInputs(c), strikes }));
      while (reached < s) {
        const next = Math.min(s, reached + 1);
        char.made(director.tick(next - reached, battleInputs(c)));
        reached = next;
      }
    },
  };
  return { battle, charred: char.craters, reached: () => reached };
}

/** A catch-up's battle that runs nothing: each runTo asked of it, as [s, strikes given], with `look` called at each. */
function spyBattle(look?: (s: number) => void): BattleCatchUp & { calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    runTo: (s, strikes) => {
      calls.push([s, strikes.length]);
      look?.(s);
    },
  };
}

const noYield = async () => {};

describe("the room's log caught up on a page that joins or reloads", () => {
  it("a joiner caught up from the log has the world of a client that was there: craters, scoops and fires' chars", async () => {
    // Eight shells on the timber wall in the match's first 12 s, 3 m apart along it. Of their seeds,
    // the first's, the fourth's and the seventh's roll a fire on timber; the rest don't. At 12 s the
    // live client digs a scoop in the bank. Each fire chars what is about it at its full burn, 20 s on.
    const seeds = [7_000, 7_001, 7_004, 7_002, 7_006, 7_007, 7_005, 7_008];
    const shells = seeds.map((seed, k) => shell(k + 1, 1_000 + 1_500 * k, 2.0 + 3.0 * k, 16.8, 1.5, seed));
    const live = liveClient(walled());
    for (const s of shells) {
      live.c.step(s.landAt - 1_500, live.frame);
      live.c.battle.hear(s, s.landAt - 1_500);
    }
    live.c.step(12_000, live.frame);
    const made = digOnce(live.c, 12_000, live.frame);
    live.c.step(40_000, live.frame);
    expect(live.c.battle.landed).toEqual(shells);
    expect(live.c.session.destruction.pending).toBe(0);
    expect(live.charred).toContain(1);
    expect(live.charred.length).toBeGreaterThanOrEqual(2);
    expect(holds(live.c.session.map, P.CHAR_TIMBER)).toBe(true);
    const log = logOf(shells, [{ seat: 0, at: Math.round(made.ms) + 30, cells: made.cells }]);
    // The joiner, on a fresh copy of the arena, welcomed 40 s in. Its session is not yet set to the
    // room: the welcome comes between frames, before any prepare of the match has set it.
    const joiner = roomClient(walled(), PLAYER);
    joiner.session.room = false;
    const caught = catchUpBattle(joiner);
    await joiner.battle.catchUp(log, 0, () => 40_000, caught.battle, noYield);
    expect(joiner.battle.landed).toEqual(shells);
    expect(joiner.battle.waiting).toEqual([]);
    expect(joiner.session.destruction.pending).toBe(0);
    expect(caught.reached()).toBe(40);
    const byId = (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0);
    expect([...caught.charred].sort(byId)).toEqual([...live.charred].sort(byId));
    expect(holds(joiner.session.map, P.CHAR_TIMBER)).toBe(true);
    expect(sameWorld(live.c.session.map, joiner.session.map)).toBe(true);
  }, 60_000);

  it('a shell in the air at the join whistles for the time it has left, and lands at its time', async () => {
    // Review Focus: a late join mid-shell. The match started at 5 000; the joiner is welcomed at
    // 10 000. The log holds a shell that landed at 8 000, which the catch-up lands and settles, so it
    // yields; and one that lands at 10 900, 0.9 s after the catch-up began. The page's first yield
    // takes half a second: the catch-up takes time.
    const before = shell(1, 8_000, 9.0, 15.0, 2.0, 801);
    const inTheAir = shell(2, 10_900, 18.0, 15.0, 2.0, 802);
    const j = client(10_000);
    let t = 10_000;
    let yields = 0;
    const spy = spyBattle();
    await j.battle.catchUp(logOf([before, inTheAir]), 5_000, () => t, spy, async () => {
      if (yields++ === 0) t += 500;
    });
    expect(yields).toBeGreaterThan(0);
    const e = j.session.drainEvents();
    expect(e.incoming.map((i) => i.landsInS)).toEqual([0.4]);
    expect(e.blasts).toEqual([]);
    expect(j.battle.landed).toEqual([before]);
    expect(j.battle.waiting).toEqual([inTheAir]);
    // The battle run along the log, then to the match's second the catch-up began at (5 s), not the one it ended at.
    expect(spy.calls).toEqual([[3, 0], [3, 0], [5, 0]]);
    // It lands at its time, once, though told again.
    j.battle.tick(10_899);
    expect(j.session.drainEvents().blasts).toEqual([]);
    j.battle.tick(10_900);
    expect(j.session.drainEvents().blasts.map((b) => b.seed)).toEqual([802]);
    j.battle.hear(inTheAir, 11_000);
    j.battle.tick(11_100);
    expect(j.session.drainEvents().blasts).toEqual([]);
    expect(j.battle.landed).toEqual([before, inTheAir]);
  });

  it('a shell that landed while the page was away lands in the catch-up, once', async () => {
    // Review Focus: a shell landing during a reload. Two overlapping shells land on the parapet while
    // the page regenerates its world; it is welcomed at 9 000, and both are told it again live after
    // (as the room's edits might carry one). One crater each, as the client that stayed has them.
    const S1 = shell(1, 3_000, 11.0, 15.0, 2.0, 811);
    const S2 = shell(2, 5_000, 12.5, 15.2, 2.0, 812);
    const stayed = client(1_000);
    stayed.battle.hear(S1, 1_500);
    stayed.battle.hear(S2, 3_500);
    stayed.step(12_000);
    const back = client(9_000);
    await back.battle.catchUp(logOf([S1, S2]), 1_000, () => 9_000, null, noYield);
    expect(back.battle.landed).toEqual([S1, S2]);
    expect(back.session.destruction.pending).toBe(0);
    back.battle.hear(S2, 9_000);
    back.battle.hear(S1, 9_000);
    const seen: CombatEvents[] = [];
    back.step(12_000, (e) => seen.push(e));
    expect(seen.flatMap((e) => [...e.blasts, ...e.incoming, ...e.craters])).toEqual([]);
    expect(back.battle.landed).toEqual([S1, S2]);
    expect(back.session.destruction.lastId).toBe(2);
    expect(sameWorld(stayed.session.map, back.session.map)).toBe(true);
  });

  it('a shell the battle heard before the catch-up lands in its place in the log, once; one it landed, not again', async () => {
    // Not the page's own path (Together makes the battle at the welcome), but the catch-up's rule for
    // any battle given it: the log's order. Three overlapping shells on the parapet; the page landed
    // the first live, and heard the second, still in the air when its frames stopped.
    const S1 = shell(1, 3_000, 11.0, 15.0, 2.0, 851);
    const S2 = shell(2, 5_000, 12.5, 15.2, 2.0, 852);
    const S3 = shell(3, 7_000, 11.8, 15.4, 2.0, 853);
    const stayed = client(1_000);
    for (const s of [S1, S2, S3]) stayed.battle.hear(s, s.landAt - 1_500);
    stayed.step(14_000);
    const back = client(1_000);
    back.battle.hear(S1, 1_500);
    back.step(4_000);
    back.battle.hear(S2, 4_000);
    expect([back.battle.landed, back.battle.waiting]).toEqual([[S1], [S2]]);
    await back.battle.catchUp(logOf([S1, S2, S3]), 1_000, () => 9_000, null, noYield);
    expect([back.battle.landed, back.battle.waiting]).toEqual([[S1, S2, S3], []]);
    expect(back.session.destruction.pending).toBe(0);
    back.step(14_000);
    expect(back.session.destruction.lastId).toBe(3);
    expect(sameWorld(stayed.session.map, back.session.map)).toBe(true);
  }, 30_000);

  it("an earlier match's shells and scoops are caught up quietly, before this match's", async () => {
    // The digger was there throughout. In the last match, a shell on the parapet, then a scoop in the
    // bank; in this one, from 10 000, another shell on the parapet, then another scoop further along.
    const S1 = shell(1, 2_000, 6.0, 15.0, 2.0, 821);
    const S2 = shell(2, 12_000, 19.0, 15.0, 2.0, 822);
    const a = roomClient(heaped(), DIGGER);
    a.step(500);
    a.battle.hear(S1, 500);
    a.step(3_000);
    const m1 = digOnce(a, 3_000);
    a.step(10_500);
    a.battle.hear(S2, 10_500);
    a.step(13_000);
    a.session.teleport([20.0, 6.4, 4.4], 0, 0);
    const m2 = digOnce(a, 13_000);
    a.step(15_000);
    expect(m1.ms).toBeLessThan(10_000);
    const d1: Dig = { seat: 0, at: Math.round(m1.ms) + 30, cells: m1.cells };
    const d2: Dig = { seat: 0, at: Math.round(m2.ms) + 30, cells: m2.cells };
    // The joiner, welcomed at 15 000: what it lands and digs, and the battle's runs, in order.
    const j = client(15_000, heaped());
    const order: string[] = [];
    const land = j.session.land.bind(j.session);
    j.session.land = (x, z, r, seed, quiet) => {
      order.push(`shell ${seed}${quiet ? '' : ' aloud'}`);
      return land(x, z, r, seed, quiet);
    };
    const applyDig = j.session.applyDig.bind(j.session);
    j.session.applyDig = (cells, after) => {
      order.push(`dig ${[d1, d2].findIndex((d) => d.cells.join() === cells.join()) + 1}`);
      return applyDig(cells, after);
    };
    const spy = spyBattle((s) => order.push(`run ${s}`));
    await j.battle.catchUp(logOf([S1, S2], [d1, d2]), 10_000, () => 15_000, spy, noYield);
    const e = j.session.drainEvents();
    expect([e.blasts, e.harms, e.incoming]).toEqual([[], [], []]);
    expect(order).toEqual(['shell 821', 'dig 1', 'run 2', 'shell 822', 'run 2', `run ${(d2.at - 10_000) / 1000}`, 'dig 2', 'run 5']);
    // This match's shell joins those landed; the last match's does not, as a live client's battle holds only this match's.
    expect(j.battle.landed).toEqual([S2]);
    expect(j.session.destruction.pending).toBe(0);
    expect(sameWorld(a.session.map, j.session.map)).toBe(true);
  }, 30_000);

  it('in the lobby every logged shell and scoop lands quietly in time order: no runTo, no harm, nothing heard', async () => {
    // A's last match: S1 on the bank ahead of it, its scoop in S1's rim, and S2, told after the scoop,
    // over it. S2 was still in the air when the match ended at 5 000, so finish() landed it. The
    // joiner is welcomed in the lobby at 5 500, before S2's time.
    const S1 = shell(1, 3_000, 12.8, 7.0, 1.5, 831);
    const S2 = shell(2, 6_000, 12.4, 6.6, 1.5, 832);
    const a = roomClient(heaped(), DIGGER);
    a.step(1_530);
    a.battle.hear(S1, 1_530);
    a.step(2_000);
    const made = digOnce(a, 2_000);
    expect(made.ms).toBeLessThan(S2.landAt - 1_500);
    a.step(4_530);
    a.battle.hear(S2, 4_530);
    a.step(5_000);
    a.battle.finish();
    a.step(10_000);
    const d: Dig = { seat: 0, at: Math.round(made.ms) + 30, cells: made.cells };
    const box = scoopBox(a.session.map.dims, d.cells);
    const region = detonationRegion(a.session.map.dims, [S2.at[0] / V, 0, S2.at[1] / V], S2.radius / V, tun.f('destruction.loosen_radius_scale'))!;
    expect(across(box, region)).toBe(true);
    const j = client(5_500, heaped());
    const spy = spyBattle();
    await j.battle.catchUp(logOf([S1, S2], [d]), null, () => 5_500, spy, noYield);
    expect(spy.calls).toEqual([]);
    const e = j.session.drainEvents();
    expect([e.incoming, e.blasts, e.harms]).toEqual([[], [], []]);
    expect([j.battle.waiting, j.battle.landed, j.battle.held]).toEqual([[], [], []]);
    expect(j.session.destruction.pending).toBe(0);
    // Each heard already: told again, nothing.
    j.battle.hear(S2, 5_500);
    j.battle.tick(6_000);
    const again = j.session.drainEvents();
    expect([again.incoming, again.blasts]).toEqual([[], []]);
    expect(j.session.destruction.lastId).toBe(2);
    expect(sameWorld(a.session.map, j.session.map)).toBe(true);
  }, 30_000);

  it("a catch-up whose log holds a dig behind a crater it overlaps completes, with the digger's world", async () => {
    // The controller's ruling on Task 6's crater gate. A was there: S1 on the bank, its scoop in S1's
    // rim, then S2 over the scoop.
    const S1 = shell(1, 3_000, 12.8, 7.0, 1.5, 841);
    const S2 = shell(2, 6_000, 12.4, 6.6, 1.5, 842);
    const a = roomClient(heaped(), DIGGER);
    a.step(1_530);
    a.battle.hear(S1, 1_530);
    a.step(2_000);
    const made = digOnce(a, 2_000);
    a.step(4_530);
    a.battle.hear(S2, 4_530);
    a.step(12_000);
    const d: Dig = { seat: 0, at: Math.round(made.ms) + 30, cells: made.cells };
    // B's worker hands craters back 4 s late, and its battle heard S1 and landed it before the
    // catch-up began, at 6 500: S1's crater is still out. So the log's scoop is held behind it, and
    // S2, which comes after the scoop, waits to go out until the scoop is in (Destruction.waits). The
    // settle digs the held scoop once S1's crater is in, as a tick would; no tick runs while it does.
    const b = roomClient(heaped(), AWAY, 0, 1 / 60, lateRunner(240));
    b.step(1_530);
    b.battle.hear(S1, 1_530);
    b.step(3_100);
    expect(b.battle.landed).toEqual([S1]);
    expect(b.session.destruction.pending).toBe(1);
    await b.battle.catchUp(logOf([S1, S2], [d]), 1_000, () => 6_500, null, noYield);
    expect(b.battle.landed).toEqual([S1, S2]);
    expect(b.battle.held).toEqual([]);
    expect(b.session.destruction.pending).toBe(0);
    expect(sameWorld(a.session.map, b.session.map)).toBe(true);
  }, 30_000);

  it("a frame that sets the session off the room between the catch-up's settles changes nothing: each shell still lands on the room's ground, and strikes", async () => {
    // The page's frames run between the settles' yields, and each sets the session as the room is:
    // off it once the match is over (the room may end it while the page catches up). Two shells on
    // the timber wall: each crater says what it struck, so each is the battle's strike.
    const S1 = shell(1, 1_000, 2.0, 16.8, 1.5, 7_000);
    const S2 = shell(2, 2_500, 11.0, 16.8, 1.5, 7_002);
    const j = roomClient(walled(), PLAYER);
    const spy = spyBattle();
    await j.battle.catchUp(logOf([S1, S2]), 0, () => 3_000, spy, async () => {
      j.session.room = false;
    });
    expect(spy.calls).toEqual([[1, 0], [1, 1], [2.5, 0], [2.5, 1], [3, 0]]);
  });

  it("a logged scoop stamped after the catch-up began, given once the match is over, lands the shells before it on the room's ground, though a frame set the session off it", async () => {
    // The page reckons the room's clock 9 000 at the welcome, a little behind it: the log already
    // holds a scoop stamped 9 250, after two overlapping shells in the air. The match ends during
    // S1's settle (the catch-up's clock then after every time), and the page's frame sets the session
    // off the room. The scoop lands S2 and S3 together; S3's crater must still be centred on the
    // ground after S2's, as on the page that landed them live.
    const S1 = shell(1, 3_000, 11.0, 15.0, 2.0, 881);
    const S2 = shell(2, 9_100, 11.8, 15.4, 2.0, 882);
    const S3 = shell(3, 9_200, 12.0, 14.8, 2.0, 883);
    const dims = trenchArena().dims;
    const D: Dig = { seat: 1, at: 9_250, cells: [packCell(dims, 230, 75, 150), packCell(dims, 230, 74, 150)] };
    const stayed = client(1_000);
    for (const s of [S1, S2, S3]) stayed.battle.hear(s, s.landAt - 1_500);
    stayed.step(9_290);
    stayed.battle.dug(D, 9_290);
    stayed.step(12_000);
    expect([stayed.battle.landed, stayed.battle.held]).toEqual([[S1, S2, S3], []]);
    const j = client(1_000);
    let over = false;
    await j.battle.catchUp(logOf([S1, S2, S3], [D]), 1_000, () => (over ? Number.POSITIVE_INFINITY : 9_000), null, async () => {
      over = true;
      j.session.room = false;
    });
    expect(over).toBe(true);
    expect([j.battle.landed, j.battle.waiting, j.battle.held]).toEqual([[S1, S2, S3], [], [D]]);
    j.battle.finish();
    j.step(4_000);
    expect(j.battle.held).toEqual([]);
    expect(j.session.destruction.pending).toBe(0);
    expect(sameWorld(stayed.session.map, j.session.map)).toBe(true);
  });

  it('a catch-up whose crater never comes back fails loudly, naming it, rather than waiting for ever', async () => {
    const lost: DetonationRunner = { post: () => {}, take: () => [] };
    const j = roomClient(trenchArena(), PLAYER, 0, 1 / 60, lost);
    let yields = 0;
    const caught = j.battle.catchUp(logOf([shell(4, 2_000, 12.8, 15.0)]), null, () => 3_000, null, async () => void yields++);
    await expect(caught).rejects.toThrow(/crater 1 is still out/);
    expect(yields).toBeGreaterThan(1_000);
  });
});
