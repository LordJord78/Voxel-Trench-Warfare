import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { CharacterController, controllerTunables, newCharacter, Stance, type MoveIntent } from '../../src/physics/character';
import { brickGrid } from '../../src/physics/grid';
import { Vec3 } from '../../src/physics/vec';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

const DT = 1 / 60;
const intent = (stance: Stance): MoveIntent => ({ forward: 0, strafe: 0, jump: false, sprint: false, stance, periscope: false });

describe('the controller at 10 cm', () => {
  it('lands a prone body falling at full speed on a one-voxel duckboard floor over air', () => {
    const map = new BrickMap({ x: 64, y: 256, z: 64 });
    map.fillBox(0, 20, 0, 64, 21, 64, P.DUCKBOARD);
    const c = new CharacterController(brickGrid(map, 0.1), controllerTunables(loadTunables()));
    // 0.92 m a tick against a 0.55 m body: from 19.6 m, tick 19 starts 0.08 m over the
    // boards and tick 20 would end wholly under them.
    const s = newCharacter(new Vec3(3.2, 19.6, 3.2));
    s.stance = Stance.PRONE;
    s.height = 0.55;
    s.velocity = new Vec3(0, -55, 0);
    for (let t = 0; t < 60; t++) c.tick(s, intent(Stance.PRONE), DT);
    expect(s.onGround).toBe(true);
    expect(s.position.y).toBeCloseTo(2.1, 9);
  });

  it('refuses to stand up under a 1.5 m ceiling, and keeps the crouched height', () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
    map.fillBox(0, 35, 0, 64, 36, 64, P.TIMBER);
    const c = new CharacterController(brickGrid(map, 0.1), controllerTunables(loadTunables()));
    const s = newCharacter(new Vec3(3.2, 2.0, 3.2));
    s.onGround = true;
    for (let t = 0; t < 30; t++) c.tick(s, intent(Stance.CROUCHED), DT);
    expect(s.height).toBeCloseTo(1.25, 9);
    c.tick(s, intent(Stance.STANDING), DT);
    expect(s.blockedStance).toBe(true);
    expect(s.stance).toBe(Stance.CROUCHED);
    expect(s.height).toBeCloseTo(1.25, 9);
    expect(c.eyeHeight(s)).toBeCloseTo(1.1, 9);
  });
});
