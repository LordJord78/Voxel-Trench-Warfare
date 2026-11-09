/**
 * Test worlds for shelling: a trench with a parapet at its angle of repose, a copy of a world, and a
 * voxel-for-voxel comparison; and for the room's battle, a runner that hands craters back late, a client of the
 * room (a session and its RoomBattle) stepped along the room's clock, and the front's view of a
 * generated world's starts.
 */
import { fireTunables } from '../../src/battle/fires';
import { loadTunables } from '../../src/core/tunables';
import type { DetonationRunner } from '../../src/sim/destruction';
import { RoomBattle } from '../../src/sim/room-battle';
import { idleIntent, Session, type CombatEvents } from '../../src/sim/session';
import { BrickMap, UNIFORM } from '../../src/world/bricks';
import type { WorldPlan } from '../../src/world/generation/plan';
import { pickSpawns } from '../../src/world/generation/spawn';
import type { DetonateOptions } from '../../src/world/destruction';
import { runDetonation, type DetonationResult } from '../../src/world/detonation';
import { P } from '../../src/world/materials';

const tun = loadTunables();

/** `[destruction]`'s options, with the trench arena's water table (y 42). */
export function shellOptions(): DetonateOptions {
  return {
    hardLimit: tun.f('destruction.resists_above_hardness'),
    core: tun.f('destruction.core_radius_scale'),
    loosen: tun.f('destruction.loosen_radius_scale'),
    waterTable: 42,
  };
}

/**
 * 25.6 × 12.8 × 25.6 m: clay to y 64, a trench along x floored at 44 from z 120 to 136, and a
 * parapet of spoil behind it at its angle of repose, z 138–162 at its foot, its crest at y 76; the
 * water table at 42. (Standing steeper, the whole ridge slumps when a shell disturbs it: 0.8 s.)
 */
export function trenchArena(): BrickMap {
  const map = new BrickMap({ x: 256, y: 128, z: 256 });
  map.fillBox(0, 0, 0, 256, 64, 256, P.CLAY);
  map.fillBox(0, 44, 120, 256, 64, 136, P.AIR);
  for (let y = 64; y < 76; y++) map.fillBox(0, y, 138 + (y - 64), 256, y + 1, 162 - (y - 64), P.SPOIL);
  map.takeDirty();
  return map;
}

/**
 * A copy of `map`, brick by brick (its table, each dense brick's bytes through denseView, loaded with
 * loadBrick): every client of a room on its own world, the one generated once. Nothing in it is dirty.
 */
export function cloneMap(map: BrickMap): BrickMap {
  const out = new BrickMap(map.dims);
  for (let bi = 0; bi < map.table.length; bi++) {
    const e = map.table[bi];
    if (e === 0) continue;
    if (e & UNIFORM) out.loadBrick(bi, e);
    else out.loadBrick(bi, 0, map.denseView(bi)!);
  }
  return out;
}

/** Whether two maps hold the same voxels everywhere. */
export function sameWorld(a: BrickMap, b: BrickMap): boolean {
  const x = new Uint8Array(512);
  const y = new Uint8Array(512);
  for (let bi = 0; bi < a.table.length; bi++) {
    a.readBrick(bi, x);
    b.readBrick(bi, y);
    for (let i = 0; i < 512; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

/**
 * A runner that hands each crater back (its cut, then the rest, or its ask for a wider region)
 * `ticks` session ticks after it was posted: the destruction worker on a slow machine. It counts its
 * takes, which the session makes one a tick.
 */
export function lateRunner(ticks: number): DetonationRunner {
  let taken = 0;
  const waiting: { due: number; result: DetonationResult }[] = [];
  return {
    post: (req) => {
      const due = taken + ticks;
      const result = runDetonation(req, (cut) => waiting.push({ due, result: cut }));
      waiting.push({ due, result });
    },
    take: () => {
      taken++;
      const out: DetonationResult[] = [];
      for (let i = 0; i < waiting.length; ) {
        if (waiting[i].due <= taken) out.push(waiting.splice(i, 1)[0].result);
        else i++;
      }
      return out;
    },
  };
}

/** A client of the room: its session (set to a room), its battle, and how far its clock is off the room's (ms). */
export interface RoomClient {
  session: Session;
  /** The battle its frames tick: a test may put the next match's in its place. */
  battle: RoomBattle;
  offsetMs: number;
  /**
   * Its frames run on from the last up to room time `roomMs` (from room time 0): each frame ticks the
   * battle at the client's own clock (room time + offsetMs), advances the session by its frame, and
   * hands the frame's drained events to `each`.
   */
  step(roomMs: number, each?: (events: CombatEvents) => void): void;
  /** Its tab hidden until room time `roomMs`: no frame runs, and the next `step`'s first frame is the first after it. */
  skip(roomMs: number): void;
}

/**
 * A client on `map` standing at `spawn` (metres), its clock `offsetMs` off the room's, running frames
 * of `frameS`, its craters cut by `runner` (in-process by default). Its session is set to a room
 * (`room` true), as Together sets it in a match: no Together is here to set it.
 */
export function roomClient(map: BrickMap, spawn: [number, number, number], offsetMs = 0, frameS = 1 / 60, runner?: DetonationRunner): RoomClient {
  const session = Session.create({ map, plan: null, spawn: { position: spawn }, ...(runner ? { runner } : {}) }, tun, 7, 0);
  session.intent = idleIntent();
  session.room = true;
  let frames = 0;
  const client: RoomClient = {
    session,
    battle: new RoomBattle(session, fireTunables(tun)),
    offsetMs,
    step(roomMs, each) {
      while ((frames + 1) * frameS * 1000 <= roomMs) {
        frames++;
        client.battle.tick(frames * frameS * 1000 + offsetMs);
        session.advance(frameS);
        const events = session.drainEvents();
        each?.(events);
      }
    },
    skip(roomMs) {
      frames = Math.max(frames, Math.floor(roomMs / (frameS * 1000)));
    },
  };
  return client;
}

/**
 * The front's view of a generated world's starts: each side's (pickSpawns, as the room's shell field
 * pins them) from the front line across from it (side 1's for Red's, side 0's for Blue's). A
 * standing player's eye at each start, looked at (Session.sight) from every bay of that line within
 * reach_m along it, as planSource picks them: from its ends and its middle, at its front edge, 1.2 m
 * over its crest, the highest a muzzle stands. Each start with how many points looked at it, and
 * every sight that got through.
 */
export function frontViewOfStarts(s: Session, plan: WorldPlan): { starts: { line: string; at: number[]; points: number }[]; seen: string[] } {
  const v = plan.params.voxel;
  const eyeM = tun.f('player.eye_height_standing');
  const reachM = tun.f('front.reach_m');
  const starts: { line: string; at: number[]; points: number }[] = [];
  const seen: string[] = [];
  for (const [line, across] of [['front', 1], ['enemy_front', 0]] as const) {
    const enemy = plan.lines.find((l) => l.spec.side === across && l.spec.firingSteps)!;
    for (const start of pickSpawns(s.map, plan, line, 4)) {
      const eye: [number, number, number] = [start.position[0], start.position[1] + eyeM, start.position[2]];
      let points = 0;
      for (const b of enemy.bays) {
        const along = b.longAxis === 0 ? eye[0] : eye[2];
        if (Math.abs(((b.a0 + b.a1) / 2) * v - along) > reachM) continue;
        const edge = (b.facing > 0 ? b.b1 : b.b0) * v;
        for (const a of [b.a0, (b.a0 + b.a1) / 2, b.a1]) {
          const point: [number, number, number] = b.longAxis === 0 ? [a * v, b.crestY * v + 1.2, edge] : [edge, b.crestY * v + 1.2, a * v];
          if (s.sight(point, eye) === null) seen.push(`${line} start at ${eye.join(', ')}, from ${point.join(', ')}`);
          points++;
        }
      }
      starts.push({ line, at: start.position, points });
    }
  }
  return { starts, seen };
}
