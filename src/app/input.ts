/**
 * Keys and the mouse, turned into the controller's intent. Movement keys are
 * read while held; the stance keys toggle: C crouches and stands, Z goes
 * prone and stands, Q raises and lowers the periscope (which needs a firing
 * step, so the app lowers it again when the player steps off one). Losing
 * focus lets go of every held key, so nobody walks on with W stuck down.
 */

import { Stance, type MoveIntent } from '../physics/character';

export class Input {
  private readonly held = new Set<string>();
  private posture: Stance = Stance.STANDING;
  private periscope = false;
  private dx = 0;
  private dy = 0;

  keyDown(code: string, repeat: boolean): void {
    this.held.add(code);
    if (repeat) return;
    if (code === 'KeyC') this.posture = this.posture === Stance.CROUCHED ? Stance.STANDING : Stance.CROUCHED;
    else if (code === 'KeyZ') this.posture = this.posture === Stance.PRONE ? Stance.STANDING : Stance.PRONE;
    else if (code === 'KeyQ') this.periscope = !this.periscope;
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  /** Focus left the page: nothing is held any more, and unapplied mouse movement is dropped. */
  blur(): void {
    this.held.clear();
    this.dx = 0;
    this.dy = 0;
  }

  /** Mouse movement in pixels, gathered until the next `look`. */
  mouse(dx: number, dy: number): void {
    this.dx += dx;
    this.dy += dy;
  }

  lowerPeriscope(): void {
    this.periscope = false;
  }

  intent(): MoveIntent {
    const held = (code: string) => (this.held.has(code) ? 1 : 0);
    return {
      forward: held('KeyW') - held('KeyS'),
      strafe: held('KeyD') - held('KeyA'),
      jump: this.held.has('Space'),
      sprint: this.held.has('ShiftLeft') || this.held.has('ShiftRight'),
      stance: this.posture,
      periscope: this.periscope,
      fire: false,
      reload: false,
    };
  }

  /** Turn by the gathered mouse movement: `sensitivity` degrees a pixel, moving up looks up. */
  look(state: { yaw: number; pitch: number }, sensitivity: number, pitchLimit: number): void {
    if (this.dx === 0 && this.dy === 0) return;
    state.yaw = (((state.yaw + this.dx * sensitivity) % 360) + 360) % 360;
    state.pitch = Math.max(-pitchLimit, Math.min(pitchLimit, state.pitch - this.dy * sensitivity));
    this.dx = 0;
    this.dy = 0;
  }
}
