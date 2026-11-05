import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { CharacterController, controllerTunables, newCharacter, Stance, type MoveIntent } from '../../src/physics/character';
import { brickGrid } from '../../src/physics/grid';
import { Vec3 } from '../../src/physics/vec';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

const DT = 1 / 60;
const intent = (stance: Stance): MoveIntent => ({ forward: 0, strafe: 0, jump: false, sprint: false, stance, periscope: false, fire: false, reload: false, dig: false });

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

describe('a landing, recorded once as the body comes down', () => {
  // landingImpact (m/s) is what the eye's and the gun's landing dips read (camera-rig.ts, handling.ts).
  // It is the speed of the tick the body comes down on, whichever way it is set down: by a vertical
  // move that meets the ground, or by the ground probe, a fall ending its tick within 0.06 m of it (as
  // every jump on flat ground does). A walk, a step down off a duckboard and standing record none. It
  // is read after its tick, which postMove decays by 1 − 6·dt, so 0.85–1.05 of the speed.
  const T = controllerTunables(loadTunables());
  const g = Math.abs(T.gravity);
  const walk = (): MoveIntent => ({ ...intent(Stance.STANDING), forward: 1 });

  /** A sod floor with its top at 0.4 m, and a duckboard step `rise` voxels high over its first 6 m. */
  function floor(rise = 0): CharacterController {
    const map = new BrickMap({ x: 64, y: 64, z: 256 });
    map.fillBox(0, 0, 0, 64, 4, 256, P.SOD);
    if (rise > 0) map.fillBox(0, 4, 0, 64, 4 + rise, 60, P.DUCKBOARD);
    return new CharacterController(brickGrid(map, 0.1), T);
  }

  /** On from the air until the body comes down: the speed it came down at (its tick's, as integrate moves it) and what it recorded. */
  function comeDown(c: CharacterController, s: ReturnType<typeof newCharacter>): { speed: number; impact: number } {
    expect(s.onGround).toBe(false);
    for (let k = 0; k < 300; k++) {
      const vy = s.velocity.y;
      c.tick(s, intent(Stance.STANDING), DT);
      if (s.onGround) return { speed: Math.min(T.maxFall, -(vy + T.gravity * DT)), impact: s.landingImpact };
    }
    throw new Error('never came down');
  }

  it('a standing jump on flat ground records the speed it comes down at, about the jump speed', () => {
    const c = floor();
    const s = newCharacter(new Vec3(3.2, 0.4, 3.2));
    for (let t = 0; t < 60; t++) c.tick(s, intent(Stance.STANDING), DT);
    c.tick(s, { ...intent(Stance.STANDING), jump: true }, DT);
    const { speed, impact } = comeDown(c, s);
    expect(s.position.y).toBeCloseTo(0.4, 9);
    // Down at the speed it went up at, to a tick's gravity.
    expect(Math.abs(speed - T.jumpSpeed)).toBeLessThanOrEqual(g * DT);
    expect(impact / speed).toBeGreaterThanOrEqual(0.85);
    expect(impact / speed).toBeLessThanOrEqual(1.05);
  });

  it('drops of 0.3–3 m record speeds rising with the height, each the speed it comes down at (about √(2·|g|·h))', () => {
    const impacts: number[] = [];
    for (const h of [0.3, 0.6, 0.9, 1.2, 1.5, 2, 3]) {
      const c = floor();
      const s = newCharacter(new Vec3(3.2, 0.4 + h, 3.2));
      const { speed, impact } = comeDown(c, s);
      expect(s.position.y, `${h} m`).toBeCloseTo(0.4, 9);
      // A fall's speed, set down within 0.06 m of the ground, to a tick's gravity either way.
      expect(speed, `${h} m`).toBeGreaterThanOrEqual(Math.min(T.maxFall, Math.sqrt(2 * g * (h - 0.06))) - g * DT);
      expect(speed, `${h} m`).toBeLessThanOrEqual(Math.min(T.maxFall, Math.sqrt(2 * g * h)) + g * DT);
      expect(impact / speed, `${h} m`).toBeGreaterThanOrEqual(0.85);
      expect(impact / speed, `${h} m`).toBeLessThanOrEqual(1.05);
      if (impacts.length > 0) expect(impact, `${h} m`).toBeGreaterThan(impacts[impacts.length - 1]);
      impacts.push(impact);
    }
  });

  it('standing still on flat ground for 2 s records none: under 0.05 once the spawn has settled, and falling', () => {
    // Put down as a spawn is (not on the ground): its settling is a landing, recorded once.
    const c = floor();
    const s = newCharacter(new Vec3(3.2, 0.4, 3.2));
    for (let t = 0; t < 30; t++) c.tick(s, intent(Stance.STANDING), DT);
    let last = s.landingImpact;
    for (let t = 0; t < 120; t++) {
      c.tick(s, intent(Stance.STANDING), DT);
      expect(s.onGround, `tick ${t}`).toBe(true);
      expect(s.landingImpact, `tick ${t}`).toBeLessThan(0.05);
      expect(s.landingImpact, `tick ${t}`).toBeLessThanOrEqual(last);
      last = s.landingImpact;
    }
  });

  it('walking on flat ground, and walking off a duckboard step (the step-down), record none', () => {
    const c = floor();
    const s = newCharacter(new Vec3(3.2, 0.4, 3.2));
    for (let t = 0; t < 60; t++) c.tick(s, intent(Stance.STANDING), DT);
    for (let t = 0; t < 120; t++) {
      c.tick(s, walk(), DT);
      expect(s.landingImpact, `walking, tick ${t}`).toBeLessThan(0.05);
    }
    expect(s.velocity.horizontalLength).toBeGreaterThan(4);
    // Off a step one and three duckboards high: down it in a tick, never leaving the ground.
    for (const rise of [1, 3]) {
      const step = floor(rise);
      const b = newCharacter(new Vec3(3.2, 0.4 + rise * 0.1, 3.2));
      for (let t = 0; t < 60; t++) step.tick(b, intent(Stance.STANDING), DT);
      let downs = 0;
      for (let t = 0; t < 150; t++) {
        const y = b.position.y;
        step.tick(b, walk(), DT);
        if (b.position.y < y - 0.05) {
          downs++;
          expect(y - b.position.y, `${rise} high`).toBeCloseTo(rise * 0.1, 9);
        }
        expect(b.onGround, `${rise} high, tick ${t}`).toBe(true);
        expect(b.landingImpact, `${rise} high, tick ${t}`).toBeLessThan(0.05);
      }
      expect(downs, `${rise} high`).toBe(1);
      expect(b.position.y, `${rise} high`).toBeCloseTo(0.4, 9);
    }
  });

  it('at 5 cm voxels, walking off a one-voxel step is set down by the ground probe, and records none', () => {
    // The probe sets down a body whose tick ends within 0.06 m of the ground. At 10 cm no step is that
    // shallow, so a body on the ground never meets it; at 5 cm a duckboard step one voxel high is, and
    // a body walking off it is on the ground last tick: it is walking, and lands on none.
    const map = new BrickMap({ x: 64, y: 64, z: 256 });
    map.fillBox(0, 0, 0, 64, 8, 256, P.SOD);
    map.fillBox(0, 8, 0, 64, 9, 120, P.DUCKBOARD);
    const c = new CharacterController(brickGrid(map, 0.05), T);
    const s = newCharacter(new Vec3(1.6, 0.45, 1.6));
    for (let t = 0; t < 60; t++) c.tick(s, intent(Stance.STANDING), DT);
    expect(s.onGround).toBe(true);
    let downs = 0;
    for (let t = 0; t < 120; t++) {
      const y = s.position.y;
      c.tick(s, walk(), DT);
      if (s.position.y < y - 0.025) {
        downs++;
        // Down the step in the one tick, by its whole height.
        expect(y - s.position.y, `tick ${t}`).toBeCloseTo(0.05, 9);
      }
      expect(s.onGround, `tick ${t}`).toBe(true);
      expect(s.landingImpact, `tick ${t}`).toBeLessThan(0.05);
    }
    expect(downs).toBe(1);
    expect(s.position.y).toBeCloseTo(0.4, 9);
    expect(s.velocity.horizontalLength).toBeGreaterThan(4);
  });
});

describe('the periscope at 10 cm', () => {
  // A bench under a roof (a step where a dugout's stairs come up beside it).
  function stepUnder(roofY: number | null) {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
    map.fillBox(0, 20, 0, 64, 21, 64, P.BENCH);
    if (roofY !== null) map.fillBox(0, roofY, 0, 64, roofY + 1, 64, P.TIMBER);
    const c = new CharacterController(brickGrid(map, 0.1), controllerTunables(loadTunables()));
    const s = newCharacter(new Vec3(3.2, 2.1, 3.2));
    s.onGround = true;
    for (let t = 0; t < 5; t++) c.tick(s, intent(Stance.STANDING), DT);
    return { c, s };
  }
  const raise = (): MoveIntent => ({ ...intent(Stance.STANDING), periscope: true });

  it('rises under open sky', () => {
    const { c, s } = stepUnder(null);
    expect(s.stance).toBe(Stance.FIRING_STEP);
    for (let t = 0; t < 30; t++) c.tick(s, raise(), DT);
    expect(s.stance).toBe(Stance.PERISCOPE);
  });

  it('is refused where its head would be in the roof, and the eye stays a standing one', () => {
    // A roof 2.0 m over the tread: room to stand (1.8 m), not for a mirror at 2.2 m.
    const { c, s } = stepUnder(41);
    expect(s.stance).toBe(Stance.FIRING_STEP);
    for (let t = 0; t < 30; t++) c.tick(s, raise(), DT);
    expect(s.stance).toBe(Stance.FIRING_STEP);
    expect(s.blockedStance).toBe(true);
    expect(c.eyeHeight(s)).toBeCloseTo(1.62, 9);
  });
});
