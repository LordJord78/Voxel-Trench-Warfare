import { describe, expect, it } from 'vitest';
import { pointerLockAction } from '../../src/app/pointer';

describe('the pointer lock', () => {
  it('lost in play, pauses; held in play, is play', () => {
    expect(pointerLockAction(true, false)).toBe('pause');
    expect(pointerLockAction(true, true)).toBeNull();
  });

  it('given after play has stopped (Esc paused before the browser granted it, the match ended), is let go, so the menus have the cursor', () => {
    expect(pointerLockAction(false, true)).toBe('release');
    // Let go already: nothing to do.
    expect(pointerLockAction(false, false)).toBeNull();
  });
});
