import { describe, expect, it } from 'vitest';
import { CLOCK_KEYS as KEYS, CLOCK_KEY_NAMES, nearestClockKey } from '../../src/core/clock-keys';
import { CLOCK_KEYS, clockText } from '../../src/core/sky-clock';

// The hours the game names, in a module of their own that reads no tunables, so the room (src/net,
// bundled into the relay) takes its default hour and the lobby its choices from the clock itself
// (the G6 self-playtest's P1: a room's dusk at 19:30, the sun 14° under, against the clock's 17:35).

describe("the clock's named hours", () => {
  it("are the sky clock's own: one set of keys, not a copy", () => {
    expect(KEYS).toBe(CLOCK_KEYS);
    expect(Object.keys(CLOCK_KEY_NAMES)).toEqual(Object.keys(CLOCK_KEYS));
    expect(Object.values(CLOCK_KEY_NAMES)).toEqual(['Dawn', 'Noon', 'Dusk', 'Night']);
    expect(Object.values(CLOCK_KEYS).map(clockText)).toEqual(['06:50', '12:00', '17:35', '21:00']);
  });

  it('the nearest to any hour, round the clock: each key its own, an older room’s 5.5, 19.5 and 22 the keys either side', () => {
    for (const [key, hours] of Object.entries(CLOCK_KEYS)) expect(nearestClockKey(hours)).toBe(key);
    // The lobby's old Dawn, Dusk and Night (index.html before R2).
    expect(nearestClockKey(5.5)).toBe('dawn');
    expect(nearestClockKey(19.5)).toBe('night');
    expect(nearestClockKey(22)).toBe('night');
    // Between dusk and noon, and past midnight: the night before dawn is night's.
    expect(nearestClockKey(14.5)).toBe('noon');
    expect(nearestClockKey(15)).toBe('dusk');
    expect(nearestClockKey(0.5)).toBe('night');
    expect(nearestClockKey(23.9)).toBe('night');
    expect(nearestClockKey(3)).toBe('dawn');
    expect(nearestClockKey(24)).toBe('night');
  });
});
