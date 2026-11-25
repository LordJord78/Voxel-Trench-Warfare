/**
 * The hours the game names, apart from the sky (sky-clock.ts) so that what cannot read the tunables
 * can read them: the room (src/net, bundled into the relay, which has no TOML) plays by the game's
 * clock, its default the game's dusk, and the lobby offers these four. Pure and small.
 */

/** The hours the game names: dusk and night are sub-project 1's keys, by the sun's elevation. */
export const CLOCK_KEYS = { dawn: 6 + 50 / 60, noon: 12, dusk: 17 + 35 / 60, night: 21 } as const;

export type ClockKey = keyof typeof CLOCK_KEYS;

/** Each named hour as a player reads it. */
export const CLOCK_KEY_NAMES: Readonly<Record<ClockKey, string>> = { dawn: 'Dawn', noon: 'Noon', dusk: 'Dusk', night: 'Night' };

/** The named hour nearest `hours`, the short way round the clock (00:30 is night's); on a tie, the earlier key of the day. */
export function nearestClockKey(hours: number): ClockKey {
  let best: ClockKey = 'dawn';
  let bestOff = Number.POSITIVE_INFINITY;
  for (const key of Object.keys(CLOCK_KEYS) as ClockKey[]) {
    const d = (((hours - CLOCK_KEYS[key]) % 24) + 24) % 24;
    const off = Math.min(d, 24 - d);
    if (off < bestOff) {
      best = key;
      bestOff = off;
    }
  }
  return best;
}
