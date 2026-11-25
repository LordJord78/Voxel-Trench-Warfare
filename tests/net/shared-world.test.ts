import { beforeAll, describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { MAP_SEEDS } from '../../src/net/room-core';
import { SHELL_FIELDS } from '../../src/net/shell-fields';
import { idleIntent } from '../../src/sim/session';
import { UNIFORM, type BrickMap } from '../../src/world/bricks';
import { fingerprint } from '../../src/world/fingerprint';
import { fillBand } from '../../src/world/generation/fill';
import { generateWorld } from '../../src/world/generation/generate';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { pickSpawns } from '../../src/world/generation/spawn';
import { K, kindOf, P } from '../../src/world/materials';
import type { Box } from '../../src/world/region';
import { RoomNet, type NodeClient, type PlayerSpec } from '../support/room-net';
import { cloneMap, lateRunner } from '../support/worlds';

// The proof (the shared-battle plan's Task 8): players in one room, each on its own copy of the
// generated Corridor, each a page in Node (tests/support/room-net.ts) against the real RoomCore over
// JSON, build one world. A minute of heavy shelling; a player digging and shooting; their clocks 80 ms
// apart, their lines 30 and 120 ms each way, their frames 60 and 45 a second, and the second's craters
// handed back 90 ticks late, as a slow worker would. Then a third joins 45 s in and catches up from
// the room's log. Every world hashes the same once all of it has settled, the fires burned out to their
// chars. Every shot here comes after the third's welcome: chips made before a join are not caught up
// (the spec's Join and reload, deferred).
//
// The site, by Red's first start (pinned as the room's shell field pins it): the start's bay (front #9)
// is 6.3 m long, so the heap and the block stand in the leg that runs back from its east end, a straight
// trench 1.5 m wide and 8.8 m long. The heap of spoil, 1.6 m along the leg, 0.8 m high and 1.4 m across
// it, at the leg's far end, about 7 m from the start; the sod block, a metre on a side, at the leg's
// near end, where it meets the bay, under 4 m from the start. The room keeps its shells 15 m from every
// start, so the block is over 11 m from any landing: beyond any crater's work (about 7.5 m for a 3.4 m
// shell), so its chips race no crater. The digger stands at the heap, facing it to dig, then turns to
// the block down the leg, 4.5 m off: far enough that an M870's pattern from the hip (160 MOA) spreads
// over a dozen voxels of its face, so its pellets' seed decides which it chips. (From 2.3 m the pattern
// is two voxels across, and every seed chips the same ones.)
const tun = loadTunables();
const params = genParams(tun, undefined, 'corridor');
const SEED = MAP_SEEDS.corridor;
const plan = planWorld(params, SEED);
const V = params.voxel;

let base: BrickMap;
/** The heap, the block (voxels), and where the digger stands (metres). */
let heap: Box;
let block: Box;
let stand: [number, number, number];

const centre = (b: Box): [number, number, number] => [((b.x0 + b.x1) / 2) * V, ((b.y0 + b.y1) / 2) * V, ((b.z0 + b.z1) / 2) * V];
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ x0, y0, z0, x1, y1, z1 });
/** Every voxel of `b` in `map`, x fastest. */
function voxels(map: BrickMap, b: Box): number[] {
  const out: number[] = [];
  for (let z = b.z0; z < b.z1; z++) for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) out.push(map.get(x, y, z));
  return out;
}

beforeAll(async () => {
  base = (await generateWorld(plan, async (bands) => bands.map((b) => fillBand(plan, b)))).map;
  const start = pickSpawns(base, plan, 'front', 4)[0];
  expect([start.position[0], start.position[2]]).toEqual(SHELL_FIELDS.corridor.spawns[0]);
  const bay = start.bay;
  const leg = plan.lines.find((l) => l.spec.name === 'front')!.legs.find((g) => g.longAxis === 0 && g.a0 === bay.x1)!;
  expect([leg.a0, leg.a1, leg.b0, leg.b1, leg.floorY]).toEqual([1188, 1203, 355, 443, 127]);
  const y = leg.floorY + 1;
  heap = box(leg.a0 + 1, y, leg.b0, leg.a0 + 15, y + 8, leg.b0 + 16);
  block = box(leg.a0 + 2, y, leg.b0 + 70, leg.a0 + 12, y + 10, leg.b0 + 80);
  stand = [(leg.a0 + 7.5) * V, y * V + 0.05, (heap.z1 + 9.5) * V];
  // Air over the leg's duckboards (their slats, and the gaps between them) where they go, as the pinned world has it.
  for (const b of [heap, block]) {
    expect(voxels(base, b).every((v) => v === P.AIR)).toBe(true);
    expect(voxels(base, { ...b, y0: leg.floorY, y1: y }).every((v) => v === P.DUCKBOARD || v === P.DUCKBOARD_WORN || v === P.AIR)).toBe(true);
  }
  const from = (b: Box) => Math.hypot(centre(b)[0] - start.position[0], centre(b)[2] - start.position[2]);
  expect(from(heap)).toBeLessThan(8);
  expect(from(block)).toBeLessThan(4);
  expect(block.z0 * V - stand[2]).toBeGreaterThan(4.4);
  base.fillBox(heap.x0, heap.y0, heap.z0, heap.x1, heap.y1, heap.z1, P.SPOIL);
  base.fillBox(block.x0, block.y0, block.z0, block.x1, block.y1, block.z1, P.SOD);
  base.takeDirty();
}, 180_000);

/** Whether a column of voxels (x, z) differs between two worlds, anywhere from the bottom to the top. */
function columnDiffers(a: BrickMap, b: BrickMap, x: number, z: number): boolean {
  for (let y = 0; y < a.dims.y; y++) if (a.get(x, y, z) !== b.get(x, y, z)) return true;
  return false;
}

/** Where two worlds differ: how many voxels, and the first few (for a failure's message). */
function differences(a: BrickMap, b: BrickMap): string {
  const x = new Uint8Array(512);
  const y = new Uint8Array(512);
  let count = 0;
  const first: string[] = [];
  for (let bi = 0; bi < a.table.length; bi++) {
    const ea = a.table[bi];
    const eb = b.table[bi];
    if (ea === eb && (ea === 0 || ea & UNIFORM)) continue;
    a.readBrick(bi, x);
    b.readBrick(bi, y);
    for (let i = 0; i < 512; i++) {
      if (x[i] === y[i]) continue;
      count++;
      if (first.length < 12) {
        const bx = bi % a.bricks.x;
        const by = Math.floor(bi / a.bricks.x) % a.bricks.y;
        const bz = Math.floor(bi / (a.bricks.x * a.bricks.y));
        first.push(`(${bx * 8 + (i & 7)}, ${by * 8 + ((i >> 3) & 7)}, ${bz * 8 + (i >> 6)}): ${x[i]} vs ${y[i]}`);
      }
    }
  }
  return `${count} voxels differ: ${first.join('; ')}`;
}

interface Played {
  A: NodeClient;
  B: NodeClient;
  C: NodeClient;
  hash: { A: string; B: string; C: string };
  /** The block's voxels SOD at 50 s and of kind SPOIL after 52 s, on A. */
  chipped: number;
  /** When the room's match started (its clock), and when the last strike was, of the match. */
  startAt: number;
  lastStrikeS: number;
}

/**
 * The match, once for both tests: A hosts and B joins in the lobby; A sets the Corridor and heavy
 * shelling and starts; A digs at the heap from 20 s to 28 s, turns to the block at 45 s and fires three
 * M870 shots into it at 50, 51 and 52 s; C joins at 45 s. The room ticks to 63 s after the start and
 * stops; every page runs on 2 s more (the last shells land), then on with its battle 25 s, and at
 * least until 20 s after the last strike (every fire at its full burn), then settles.
 */
async function play(): Promise<Played> {
  const net = new RoomNet();
  const player = (name: string, offsetMs: number, lineMs: number, frameS: number, more: Partial<PlayerSpec> = {}): PlayerSpec => ({ name, map: cloneMap(base), plan, seed: SEED, offsetMs, lineMs, frameS, ...more });
  let before: number[] | null = null;
  let chipped = -1;
  /** The M870's shots fired before its first pull here. */
  let pulled: number | null = null;
  const A = net.connect(
    player('A', 0, 30, 1 / 60, {
      loadout: { primary: 'm870', secondary: 'm17', fits: {} },
      place: (p) => p.session.teleport(stand, 180, 0),
      act: (p, s) => {
        const session = p.session;
        session.intent = idleIntent();
        if (s === null) return;
        if (s >= 20 && s < 28) session.intent = { ...idleIntent(), dig: true };
        if (s < 45) return;
        // Turned to the block, at its middle from the eye.
        const me = session.player;
        const [, cy, cz] = centre(block);
        const eye = me.position.y + session.controller.eyeHeight(me);
        me.yaw = 0;
        me.pitch = (Math.atan2(cy - eye, cz - me.position.z) * 180) / Math.PI;
        pulled ??= session.weapon.shotsFired;
        if (s >= 50 && before === null) before = voxels(session.map, block);
        // A pull at 50, 51 and 52 s: the trigger held until it fires, let go before the next.
        const due = [50, 51, 52].filter((at) => s >= at).length;
        if (session.weapon.shotsFired - pulled < due) session.intent = { ...idleIntent(), fire: true };
        if (s >= 53 && chipped < 0) {
          const after = voxels(session.map, block);
          chipped = before!.filter((v, i) => v === P.SOD && kindOf(after[i]) === K.SPOIL).length;
        }
      },
    }),
  );
  await net.runTo(300);
  A.say({ t: 'config', config: { map: 'corridor', intensity: 'heavy' } });
  const B = net.connect(player('B', 80, 120, 1 / 45, { runner: lateRunner(90) }));
  await net.runTo(1_000);
  A.say({ t: 'start' });
  await net.runTo(1_500);
  expect(A.match?.config).toMatchObject({ map: 'corridor', intensity: 'heavy' });
  const startAt = A.match!.startAt;
  await net.runTo(startAt + 45_000);
  const C = net.connect(player('C', -40, 50, 1 / 50, { runner: lateRunner(20) }));
  await net.runTo(startAt + 63_000);
  net.stopTicking();
  await net.runTo(startAt + 65_000);
  await net.runTo(startAt + 90_000);
  const lastStrikeS = Math.max(...net.players.map((p) => p.lastStrikeS));
  if (lastStrikeS + 20 > 89) await net.runTo(startAt + (lastStrikeS + 21) * 1000);
  expect(await net.settle()).toBe(true);
  const [a, b, c] = await Promise.all([fingerprint(A.map), fingerprint(B.map), fingerprint(C.map)]);
  return { A, B, C, hash: { A: a, B: b, C: c }, chipped, startAt, lastStrikeS };
}

interface Hidden {
  A: NodeClient;
  D: NodeClient;
  hash: { A: string; D: string };
  startAt: number;
}

/**
 * A tab hidden mid-match (the final review's item 15.5): A hosts and D joins in the lobby; A sets the
 * Corridor and heavy shelling and starts. D's tab is hidden from 10 s to 35 s of the match (25 s): it
 * runs no frame, and the room's shells, A's scoops and A's shots queue on its line. Meanwhile A digs at
 * the heap from 14 s to 17 s, between two shells (S1 < dig < S2), and from 20 s fires an M249's belt
 * into the block, more than 64 shots (NetClient kept only 64 before the final review's item 3). D comes
 * back at 35 s: its first frames land the overdue shells quietly and give the scoops in their stamps'
 * order, and fly the shots, all of them, as many a frame as the round pool has room for, silently (each
 * is far more than SILENT_STEP_S old). The room ticks to 50 s and stops; both run on until 20 s after
 * the last strike, and settle.
 */
async function hide(): Promise<Hidden> {
  const net = new RoomNet();
  const player = (name: string, offsetMs: number, lineMs: number, frameS: number, more: Partial<PlayerSpec> = {}): PlayerSpec => ({ name, map: cloneMap(base), plan, seed: SEED, offsetMs, lineMs, frameS, ...more });
  let pulled: number | null = null;
  const A = net.connect(
    player('A', 0, 30, 1 / 60, {
      loadout: { primary: 'm249', secondary: 'm17', fits: {} },
      place: (p) => p.session.teleport(stand, 180, 0),
      act: (p, s) => {
        const session = p.session;
        session.intent = idleIntent();
        if (s === null) return;
        if (s >= 14 && s < 17) session.intent = { ...idleIntent(), dig: true };
        if (s < 18) return;
        // Turned to the block, at its middle from the eye, every frame (the belt's climb held down).
        const me = session.player;
        const [, cy, cz] = centre(block);
        const eye = me.position.y + session.controller.eyeHeight(me);
        me.yaw = 0;
        me.pitch = (Math.atan2(cy - eye, cz - me.position.z) * 180) / Math.PI;
        pulled ??= session.weapon.shotsFired;
        if (s >= 20 && session.weapon.shotsFired - pulled < 80) session.intent = { ...idleIntent(), fire: true };
      },
    }),
  );
  await net.runTo(300);
  A.say({ t: 'config', config: { map: 'corridor', intensity: 'heavy' } });
  const D = net.connect(player('D', 60, 80, 1 / 60, { hidden: [10, 35] }));
  await net.runTo(1_000);
  A.say({ t: 'start' });
  await net.runTo(1_500);
  const startAt = A.match!.startAt;
  await net.runTo(startAt + 50_000);
  net.stopTicking();
  await net.runTo(startAt + 52_000);
  const lastStrikeS = Math.max(...net.players.map((p) => p.lastStrikeS));
  if (lastStrikeS + 21 > 52) await net.runTo(startAt + (lastStrikeS + 21) * 1000);
  expect(await net.settle()).toBe(true);
  const [a, d] = await Promise.all([fingerprint(A.map), fingerprint(D.map)]);
  return { A, D, hash: { A: a, D: d }, startAt };
}

let played: Promise<Played> | null = null;
const scenario = () => (played ??= play());

describe("the room's battle, in Node: every page one world", () => {
  it("two clients' worlds hash the same after 60 s of heavy shelling, a player's digging and shooting, their clocks 80 ms apart and their frames 60 and 45 a second", async () => {
    const { A, B, hash, chipped } = await scenario();
    const landed = A.battle!.landed.map((s) => s.id);
    console.log(`A and B: ${landed.length} shells landed, ${A.strikes} and ${B.strikes} strikes, ${A.charsAsked} and ${B.charsAsked} chars, ${A.digsSent} scoops dug and ${B.digsGiven} given B, ${A.shotsSent} shots sent and ${B.shotsFired} fired on B, ${chipped} of the block's voxels chipped; hashes ${hash.A.slice(0, 12)} and ${hash.B.slice(0, 12)}`);
    expect(hash.B, hash.A === hash.B ? '' : differences(A.map, B.map)).toBe(hash.A);
    expect(landed.length).toBeGreaterThanOrEqual(16);
    expect(landed.length).toBeLessThanOrEqual(25);
    expect(B.battle!.landed.map((s) => s.id)).toEqual(landed);
    expect(A.digsSent).toBeGreaterThanOrEqual(20);
    expect(B.digsGiven).toBe(A.digsSent);
    expect(B.battle!.held).toEqual([]);
    expect(A.shotsSent).toBe(3);
    expect(B.shotsFired).toBe(3);
    expect(chipped).toBeGreaterThanOrEqual(2);
    // The shelling reached the world: a strike lit on each page, and the column under every landed
    // shell's centre is no longer the generated world's (a crater was cut there), so the hashes agree
    // on a cratered world, not a quiet one.
    expect(A.strikes).toBeGreaterThanOrEqual(1);
    expect(B.strikes).toBeGreaterThanOrEqual(1);
    const cut = A.battle!.landed.filter((s) => columnDiffers(base, A.map, Math.floor(s.at[0] / V), Math.floor(s.at[1] / V)));
    expect(cut.map((s) => s.id)).toEqual(landed);
  }, 900_000);

  it('a third who joins at 45 s and catches up from the log hashes the same at the end', async () => {
    const { A, C, hash } = await scenario();
    console.log(`C: caught up on ${C.catchUp?.entries} of the log's entries in ${C.catchUp?.ms.toFixed(0)} ms; ${C.battle!.landed.length} shells landed, ${C.strikes} strikes live, ${C.charsAsked} chars; ${C.shotsFired} shots fired; hash ${hash.C.slice(0, 12)}`);
    expect(C.catchUp!.entries).toBeGreaterThan(0);
    expect(hash.C, hash.A === hash.C ? '' : differences(A.map, C.map)).toBe(hash.A);
    expect(C.battle!.landed.map((s) => s.id)).toEqual(A.battle!.landed.map((s) => s.id));
    expect(C.shotsFired).toBe(3);
    expect(C.battle!.held).toEqual([]);
  }, 900_000);
});

describe("the room's battle, in Node: a tab hidden mid-match", () => {
  it('a page hidden for 25 s across a shell, a scoop and a shell comes back to the same world, flying its backlog of more than 64 shots, silently', async () => {
    const { A, D, hash, startAt } = await hide();
    const landed = A.battle!.landed;
    const hid = D.hid!;
    // Hidden 25 s, from 10 s into the match on its clock.
    expect((hid.to - hid.from) / 1000).toBeCloseTo(25, 1);
    // S1 < dig < S2, all of them while D was hidden (the room's clock: D's is 60 ms ahead of the true one).
    const inWindow = (ms: number) => ms > hid.from + 60 && ms < hid.to + 60;
    const digs = D.digStamps.filter(inWindow);
    expect(digs.length).toBeGreaterThan(0);
    const before = landed.filter((s) => inWindow(s.landAt) && s.landAt < digs[0]);
    const after = landed.filter((s) => inWindow(s.landAt) && s.landAt > digs[digs.length - 1]);
    console.log(`D hidden ${((hid.from - startAt) / 1000).toFixed(1)}-${((hid.to - startAt) / 1000).toFixed(1)} s: ${landed.filter((s) => inWindow(s.landAt)).length} shells landed meanwhile (${before.length} before the first of ${digs.length} scoops, ${after.length} after the last); ${A.shotsSent} shots sent by A, ${D.shotsFired} fired on D (${D.shotsSilent} silent, ${D.shotsSeen} seen); ${landed.length} shells in all, ${A.strikes} and ${D.strikes} strikes; hashes ${hash.A.slice(0, 12)} and ${hash.D.slice(0, 12)}`);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(D.digsGiven).toBe(A.digsSent);
    // The backlog: every shot A sent, more than 64, flown on D, every one silent, none seen.
    expect(A.shotsSent).toBeGreaterThan(64);
    expect(D.shotsFired).toBe(A.shotsSent);
    expect(D.shotsSilent).toBe(D.shotsFired);
    expect(D.shotsSeen).toBe(0);
    // One world.
    expect(D.battle!.landed.map((s) => s.id)).toEqual(landed.map((s) => s.id));
    expect(D.battle!.held).toEqual([]);
    expect(hash.D, hash.A === hash.D ? '' : differences(A.map, D.map)).toBe(hash.A);
  }, 900_000);
});
