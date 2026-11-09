import { describe, expect, it } from 'vitest';
import type { Strike } from '../../src/battle/director';
import { fireTunables, roomStrike } from '../../src/battle/fires';
import { packCell, scoopBox } from '../../src/combat/entrenching';
import { loadTunables } from '../../src/core/tunables';
import { SILENT_STEP_S } from '../../src/net/clock';
import type { ClientMsg, Dig, RoomShell } from '../../src/net/protocol';
import type { Crater } from '../../src/sim/destruction';
import { RoomBattle } from '../../src/sim/room-battle';
import { idleIntent, type Harm } from '../../src/sim/session';
import type { BrickMap } from '../../src/world/bricks';
import { fuelNear } from '../../src/world/char';
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

/** `c`, stepped to room time `from`, digs (F held) until it has made a scoop, then lets go: the scoop. */
function digOnce(c: RoomClient, from: number): Made {
  let made: Made | null = null;
  c.session.intent = { ...idleIntent(), dig: true };
  for (let ms = from; made === null; ms += 10) {
    if (ms > from + 10_000) throw new Error('no scoop in 10 s');
    c.step(ms, (e) => {
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
