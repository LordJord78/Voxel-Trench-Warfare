/**
 * The sky by the clock: where the sun and moon stand at an hour of the day of
 * `[sky]` (the Somme, 10 October 1916; the hours before noon are the next
 * morning's), as world directions. The map's
 * bearing puts the dusk sun where the approved dusk frame had it. dmath
 * throughout (via the ephemeris), so every browser lights the same sky.
 */

import { horizontal, julianDay, moonEquatorial, moonIllumination, sunEquatorial, toWorld } from './ephemeris';
import type { Tunables } from './tunables';

/** The hours the game names: dusk and night are sub-project 1's keys, by the sun's elevation. */
export const CLOCK_KEYS = { dawn: 6 + 50 / 60, noon: 12, dusk: 17 + 35 / 60, night: 21 } as const;

/** An hour of the clock as a 24-hour time, to the minute: 17.5833 is 17:35. */
export function clockText(hours: number): string {
  const minutes = Math.round((((hours % 24) + 24) % 24) * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export interface Body {
  /** Unit vector in the world: +z ahead (toward the enemy), +x to the right, +y up. */
  dir: [number, number, number];
  elevationDeg: number;
}

export interface Celestial {
  sun: Body;
  moon: Body & { illuminated: number; phaseAngleDeg: number };
  /** The celestial sphere's axes in the world, turned by the sidereal clock: right ascension 0° and 90° on the equator, and the north pole. */
  stars: [[number, number, number], [number, number, number], [number, number, number]];
}

export function celestial(tun: Tunables, hours: number): Celestial {
  const [year, month, day] = tun.get('sky.date') as [number, number, number];
  const lat = tun.f('sky.latitude_deg');
  const lon = tun.f('sky.longitude_deg');
  const bearing = tun.f('sky.map_bearing_deg');
  // The game's day turns at noon: the hours after midnight are the next morning's, so the night runs
  // on unbroken; the cut falls at midday, when the full moon is down and a day's change in the sun
  // cannot be seen.
  const morning = hours < 12 ? 1 : 0;
  const jd = julianDay(year, month, day + morning + (hours - tun.f('sky.utc_offset_h')) / 24);
  const s = sunEquatorial(jd);
  const sunAt = horizontal(s.ra, s.dec, lat, lon, jd);
  const m = moonEquatorial(jd);
  const moonAt = horizontal(m.ra, m.dec, lat, lon, jd);
  const lit = moonIllumination(jd);
  const at = (ra: number, dec: number) => {
    const h = horizontal(ra, dec, lat, lon, jd);
    return toWorld(h.azimuthDeg, h.elevationDeg, bearing);
  };
  return {
    sun: { dir: toWorld(sunAt.azimuthDeg, sunAt.elevationDeg, bearing), elevationDeg: sunAt.elevationDeg },
    moon: { dir: toWorld(moonAt.azimuthDeg, moonAt.elevationDeg, bearing), elevationDeg: moonAt.elevationDeg, ...lit },
    stars: [at(0, 0), at(90, 0), at(0, 90)],
  };
}
