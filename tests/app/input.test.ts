import { describe, expect, it } from 'vitest';
import { Input } from '../../src/app/input';
import { Stance } from '../../src/physics/character';

const press = (i: Input, code: string) => {
  i.keyDown(code, false);
  i.keyUp(code);
};

describe('input', () => {
  it('moves with W A S D, sprints with either Shift and jumps with Space', () => {
    const i = new Input();
    i.keyDown('KeyW', false);
    expect(i.intent().forward).toBe(1);
    i.keyDown('KeyS', false);
    expect(i.intent().forward).toBe(0);
    i.keyUp('KeyW');
    expect(i.intent().forward).toBe(-1);
    i.keyUp('KeyS');
    i.keyDown('KeyD', false);
    expect(i.intent().strafe).toBe(1);
    i.keyUp('KeyD');
    i.keyDown('KeyA', false);
    expect(i.intent().strafe).toBe(-1);
    i.keyUp('KeyA');
    for (const shift of ['ShiftLeft', 'ShiftRight']) {
      i.keyDown(shift, false);
      expect(i.intent().sprint).toBe(true);
      i.keyUp(shift);
    }
    expect(i.intent().sprint).toBe(false);
    i.keyDown('Space', false);
    expect(i.intent().jump).toBe(true);
  });

  it('toggles crouch with C and prone with Z', () => {
    const i = new Input();
    const stances: number[] = [];
    for (const key of ['KeyC', 'KeyC', 'KeyZ', 'KeyC', 'KeyZ', 'KeyZ']) {
      press(i, key);
      stances.push(i.intent().stance);
    }
    expect(stances).toEqual([Stance.CROUCHED, Stance.STANDING, Stance.PRONE, Stance.CROUCHED, Stance.PRONE, Stance.STANDING]);
  });

  it('raises and lowers the periscope with Q, and lowers it when told', () => {
    const i = new Input();
    press(i, 'KeyQ');
    expect(i.intent().periscope).toBe(true);
    press(i, 'KeyQ');
    expect(i.intent().periscope).toBe(false);
    press(i, 'KeyQ');
    i.lowerPeriscope();
    expect(i.intent().periscope).toBe(false);
  });

  it("toggles nothing on a held key's repeats", () => {
    const i = new Input();
    i.keyDown('KeyC', false);
    i.keyDown('KeyC', true);
    i.keyDown('KeyC', true);
    expect(i.intent().stance).toBe(Stance.CROUCHED);
  });

  it('lets go of every held key when the page loses focus, and keeps the toggles', () => {
    const i = new Input();
    press(i, 'KeyC');
    i.keyDown('KeyW', false);
    i.keyDown('ShiftLeft', false);
    i.mouse(50, 0);
    i.blur();
    const intent = i.intent();
    expect([intent.forward, intent.sprint, intent.stance]).toEqual([0, false, Stance.CROUCHED]);
    const s = { yaw: 0, pitch: 0 };
    i.look(s, 0.14, 88);
    expect(s.yaw).toBe(0);
  });

  it('turns with the mouse in degrees per pixel, wrapping the yaw and clamping the pitch', () => {
    const i = new Input();
    const s = { yaw: 350, pitch: 0 };
    i.mouse(60, 0);
    i.mouse(40, 0);
    i.look(s, 0.14, 88);
    expect(s.yaw).toBeCloseTo(4, 9);
    i.mouse(0, 100);
    i.look(s, 0.14, 88);
    expect(s.pitch).toBeCloseTo(-14, 9);
    i.mouse(-200, 0);
    i.look(s, 0.14, 88);
    expect(s.yaw).toBeCloseTo(336, 9);
    i.mouse(0, -10000);
    i.look(s, 0.14, 88);
    expect(s.pitch).toBe(88);
    i.look(s, 0.14, 88);
    expect([s.yaw, s.pitch].map((v) => +v.toFixed(9))).toEqual([336, 88]);
  });
});
