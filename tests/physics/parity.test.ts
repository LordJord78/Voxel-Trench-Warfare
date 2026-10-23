import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { CharacterController, controllerTunables, newCharacter, type CharacterState, type ControllerTunables, type Stance } from '../../src/physics/character';
import { boxGrid } from '../../src/physics/grid';
import { Vec3 } from '../../src/physics/vec';

interface Recorded {
  position: [number, number, number];
  velocity: [number, number, number];
  stance: number;
  height: number;
  onGround: boolean;
  onFiringStep: boolean;
  wadeDepth: number;
  landingImpact: number;
  bobPhase: number;
  blockedStance: boolean;
}

interface Fixture {
  scenario: string;
  voxel: number;
  dims: [number, number, number];
  boxes: number[][];
  controller: ControllerTunables;
  dt: number;
  start: { position: [number, number, number]; yaw: number; pitch: number; onGround: boolean };
  ticks: { forward: number; strafe: number; jump: boolean; sprint: boolean; stance: number; periscope: boolean; yaw: number; pitch: number }[];
  states: Recorded[];
}

const DIR = new URL('../fixtures/parity/', import.meta.url);
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Fixture);

const MM = 1e-3;

/** What differs between this tick's state and Python's, beyond a millimetre (or exactly, for flags). */
function differences(s: CharacterState, want: Recorded): string[] {
  const out: string[] = [];
  const near = (name: string, got: number, expected: number) => {
    if (!(Math.abs(got - expected) <= MM)) out.push(`${name} ${got} vs ${expected}`);
  };
  s.position.toArray().forEach((v, i) => near(`position[${i}]`, v, want.position[i]));
  s.velocity.toArray().forEach((v, i) => near(`velocity[${i}]`, v, want.velocity[i]));
  near('height', s.height, want.height);
  near('wadeDepth', s.wadeDepth, want.wadeDepth);
  near('landingImpact', s.landingImpact, want.landingImpact);
  near('bobPhase', s.bobPhase, want.bobPhase);
  if (s.stance !== want.stance) out.push(`stance ${s.stance} vs ${want.stance}`);
  for (const flag of ['onGround', 'onFiringStep', 'blockedStance'] as const) {
    if (s[flag] !== want[flag]) out.push(`${flag} ${s[flag]} vs ${want[flag]}`);
  }
  return out;
}

describe('movement parity with the Python controller', () => {
  it('has the four scenarios', () => {
    expect(fixtures.map((f) => f.scenario)).toEqual(['ceiling', 'fall-wade', 'steps', 'walk-slide']);
  });

  for (const fx of fixtures) {
    it(`${fx.scenario}: every tick within a millimetre`, () => {
      const controller = new CharacterController(boxGrid(fx.dims, fx.voxel, fx.boxes), fx.controller);
      const s = newCharacter(new Vec3(...fx.start.position), fx.start.yaw, fx.start.pitch);
      s.onGround = fx.start.onGround;
      fx.ticks.forEach((t, i) => {
        s.yaw = t.yaw;
        s.pitch = t.pitch;
        controller.tick(s, { forward: t.forward, strafe: t.strafe, jump: t.jump, sprint: t.sprint, stance: t.stance as Stance, periscope: t.periscope, fire: false, reload: false }, fx.dt);
        const problems = differences(s, fx.states[i]);
        if (problems.length) throw new Error(`${fx.scenario} tick ${i}: ${problems.join('; ')}`);
      });
      expect(fx.ticks.length).toBe(fx.states.length);
    });
  }

  it('walks the game with the numbers Python was checked with', () => {
    // The climb onto the firing step is the port's own (Python's controller has none, and its
    // fixtures, without these keys, never climb).
    const { climbM, climbSpeed, ...game } = controllerTunables(loadTunables());
    expect(climbM).toBeGreaterThan(game.stepUp);
    expect(climbSpeed).toBeGreaterThan(0);
    for (const fx of fixtures) expect(game).toEqual(fx.controller);
  });
});
