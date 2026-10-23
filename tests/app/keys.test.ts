import { describe, expect, it } from 'vitest';
import { actionFor, nextTimeKey, stepTime } from '../../src/app/keys';
import { VIEW_NAMES } from '../../src/app/views';
import { CLOCK_KEYS } from '../../src/core/sky-clock';

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
    // R reloads the rifle (input.ts); dynamic resolution's developer key is Y.
    expect(actionFor('KeyY')).toEqual({ kind: 'dynres' });
    expect(actionFor('KeyR')).toBeNull();
    expect(actionFor('F3')).toEqual({ kind: 'overlay' });
    expect(actionFor('KeyW')).toBeNull();
  });
  it("T walks the clock's keys in the day's order, dusk, night, dawn, noon and dusk again, from wherever the time is", () => {
    const { dawn, noon, dusk, night } = CLOCK_KEYS;
    expect(nextTimeKey(dusk)).toBe(night);
    expect(nextTimeKey(night)).toBe(dawn);
    expect(nextTimeKey(dawn)).toBe(noon);
    expect(nextTimeKey(noon)).toBe(dusk);
    expect(nextTimeKey(19)).toBe(night);
    expect(nextTimeKey(23.5)).toBe(dawn);
    expect(nextTimeKey(3)).toBe(dawn);
  });
  it('[ and ] step the clock by a quarter of an hour, on the quarters, round midnight', () => {
    expect(stepTime(12, 1)).toBe(12.25);
    expect(stepTime(12.1, 1)).toBe(12.25);
    expect(stepTime(0, -1)).toBe(23.75);
    expect(stepTime(23.75, 1)).toBe(0);
    let h = 6;
    for (let i = 0; i < 24; i++) h = stepTime(h, 1);
    expect(h).toBe(12);
  });
});
