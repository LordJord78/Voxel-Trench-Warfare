import { describe, expect, it } from 'vitest';
import { actionFor, nextTimeKey, stepTime } from '../../src/app/keys';
import { VIEW_NAMES } from '../../src/app/views';

describe('keys', () => {
  it('1 to 6 jump to the standard views, in order', () => {
    VIEW_NAMES.forEach((name, i) => expect(actionFor(`Digit${i + 1}`)).toEqual({ kind: 'view', name }));
    expect(actionFor('Digit7')).toBeNull();
  });
  it('bind time, quality and the overlay', () => {
    expect(actionFor('KeyT')).toEqual({ kind: 'time-next' });
    expect(actionFor('BracketLeft')).toEqual({ kind: 'time-step', by: -1 });
    expect(actionFor('BracketRight')).toEqual({ kind: 'time-step', by: 1 });
    expect(actionFor('KeyP')).toEqual({ kind: 'preset' });
    expect(actionFor('KeyR')).toEqual({ kind: 'dynres' });
    expect(actionFor('F3')).toEqual({ kind: 'overlay' });
    expect(actionFor('KeyW')).toBeNull();
  });
  it('T walks dusk, twilight, night and back to dusk, from wherever the time is', () => {
    expect(nextTimeKey(0)).toBe(0.5);
    expect(nextTimeKey(0.5)).toBe(1);
    expect(nextTimeKey(1)).toBe(0);
    expect(nextTimeKey(0.3)).toBe(0.5);
    expect(nextTimeKey(0.75)).toBe(1);
  });
  it('[ and ] step the time by 0.05 within dusk and night, landing exactly on the keys', () => {
    expect(stepTime(0.5, 1)).toBe(0.55);
    expect(stepTime(1, 1)).toBe(1);
    expect(stepTime(0, -1)).toBe(0);
    let t = 0;
    for (let i = 0; i < 10; i++) t = stepTime(t, 1);
    expect(t).toBe(0.5);
  });
});
