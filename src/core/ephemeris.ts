/**
 * Where the sun and moon stand: Jean Meeus's methods (Astronomical Algorithms,
 * 2nd ed.) at low precision, about 0.01° for the sun and 0.05° for the moon,
 * which is far finer than a frame can show. Angles are degrees; Julian days
 * are counted as Meeus counts them, and dynamical time is taken as universal
 * time (in 1916 they differed by 18 s, a few hundredths of a degree of sky).
 * Built from dmath, so every browser puts the moon in the same place.
 */

import { atan2, cos, degrees, radians, sin } from './dmath';

function asin(x: number): number {
  return atan2(x, Math.sqrt(Math.max(0, 1 - x * x)));
}

/** Degrees into [0, 360). */
function wrap(deg: number): number {
  return deg - 360 * Math.floor(deg / 360);
}

const sind = (d: number) => sin(radians(d));
const cosd = (d: number) => cos(radians(d));

/** The Julian day of a Gregorian date; `day` carries the fraction of the day (UT). Meeus 7.1. */
export function julianDay(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

/** Greenwich mean sidereal time, degrees. Meeus 12.4. */
export function siderealTimeDeg(jd: number): number {
  const t = (jd - 2451545) / 36525;
  return wrap(280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - (t * t * t) / 38710000);
}

/** The obliquity of the ecliptic, with the nutation term the low-precision methods use. Meeus 22.2, 25.8. */
function obliquity(t: number): number {
  const omega = 125.04 - 1934.136 * t;
  return 23.4392911 - 0.0130042 * t - 1.64e-7 * t * t + 5.04e-7 * t * t * t + 0.00256 * cosd(omega);
}

function equatorial(lambda: number, beta: number, eps: number): { ra: number; dec: number } {
  const ra = wrap(degrees(atan2(sind(lambda) * cosd(eps) - (sind(beta) / cosd(beta)) * sind(eps), cosd(lambda))));
  const dec = degrees(asin(sind(beta) * cosd(eps) + cosd(beta) * sind(eps) * sind(lambda)));
  return { ra, dec };
}

/** The sun's apparent place. Meeus chapter 25, low precision. */
export function sunEquatorial(jde: number): { ra: number; dec: number; lambda: number; distanceKm: number } {
  const t = (jde - 2451545) / 36525;
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = 357.52911 + 35999.05029 * t - 0.0001537 * t * t;
  const e = 0.016708634 - 0.000042037 * t - 0.0000001267 * t * t;
  const c = (1.914602 - 0.004817 * t - 0.000014 * t * t) * sind(m) + (0.019993 - 0.000101 * t) * sind(2 * m) + 0.000289 * sind(3 * m);
  const trueLongitude = l0 + c;
  const nu = m + c;
  const au = (1.000001018 * (1 - e * e)) / (1 + e * cosd(nu));
  const omega = 125.04 - 1934.136 * t;
  const lambda = wrap(trueLongitude - 0.00569 - 0.00478 * sind(omega));
  return { ...equatorial(lambda, 0, obliquity(t)), lambda, distanceKm: au * 149597870.7 };
}

// The largest terms of Meeus's tables 47.A and 47.B: multiples of D, M, M', F, and the sine
// coefficient for longitude (1e-6 degrees) and cosine coefficient for distance (metres).
const LONGITUDE: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];

// Multiples of D, M, M', F, and the sine coefficient for latitude (1e-6 degrees).
const LATITUDE: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
];

/** The moon's apparent place (without nutation in longitude). Meeus chapter 47. */
export function moonEquatorial(jde: number): { ra: number; dec: number; lambda: number; beta: number; distanceKm: number } {
  const t = (jde - 2451545) / 36525;
  const lp = wrap(218.3164477 + 481267.88123421 * t - 0.0015786 * t * t + (t * t * t) / 538841 - (t * t * t * t) / 65194000);
  const d = wrap(297.8501921 + 445267.1114034 * t - 0.0018819 * t * t + (t * t * t) / 545868 - (t * t * t * t) / 113065000);
  const m = wrap(357.5291092 + 35999.0502909 * t - 0.0001536 * t * t + (t * t * t) / 24490000);
  const mp = wrap(134.9633964 + 477198.8675055 * t + 0.0087414 * t * t + (t * t * t) / 69699 - (t * t * t * t) / 14712000);
  const f = wrap(93.272095 + 483202.0175233 * t - 0.0036539 * t * t - (t * t * t) / 3526000 + (t * t * t * t) / 863310000);
  const a1 = 119.75 + 131.849 * t;
  const a2 = 53.09 + 479264.29 * t;
  const a3 = 313.45 + 481266.484 * t;
  const e = 1 - 0.002516 * t - 0.0000074 * t * t;
  // Terms in the sun's anomaly M shrink with the earth's orbit's eccentricity.
  const scale = (km: number) => (km === 0 ? 1 : Math.abs(km) === 1 ? e : e * e);
  let sl = 0;
  let sr = 0;
  for (const [kd, km, kmp, kf, sinL, cosR] of LONGITUDE) {
    const arg = kd * d + km * m + kmp * mp + kf * f;
    sl += scale(km) * sinL * sind(arg);
    sr += scale(km) * cosR * cosd(arg);
  }
  let sb = 0;
  for (const [kd, km, kmp, kf, sinB] of LATITUDE) sb += scale(km) * sinB * sind(kd * d + km * m + kmp * mp + kf * f);
  sl += 3958 * sind(a1) + 1962 * sind(lp - f) + 318 * sind(a2);
  sb += -2235 * sind(lp) + 382 * sind(a3) + 175 * sind(a1 - f) + 175 * sind(a1 + f) + 127 * sind(lp - mp) - 115 * sind(lp + mp);
  const lambda = wrap(lp + sl / 1e6);
  const beta = sb / 1e6;
  return { ...equatorial(lambda, beta, obliquity(t)), lambda, beta, distanceKm: 385000.56 + sr / 1000 };
}

/** The moon's phase angle and the fraction of its disc lit. Meeus chapter 48. */
export function moonIllumination(jde: number): { phaseAngleDeg: number; illuminated: number } {
  const moon = moonEquatorial(jde);
  const sun = sunEquatorial(jde);
  // The geocentric elongation, then the phase angle seen from the moon.
  const cosPsi = Math.min(1, Math.max(-1, cosd(moon.beta) * cosd(moon.lambda - sun.lambda)));
  const sinPsi = Math.sqrt(1 - cosPsi * cosPsi);
  const phase = degrees(atan2(sun.distanceKm * sinPsi, moon.distanceKm - sun.distanceKm * cosPsi));
  return { phaseAngleDeg: phase, illuminated: (1 + cosd(phase)) / 2 };
}

/**
 * A place in the sky seen from latitude `latDeg`, longitude `lonEastDeg` (east positive), at
 * Julian day `jd` (UT): its compass bearing (from north, through east) and elevation. Meeus 13.5–13.6.
 */
export function horizontal(raDeg: number, decDeg: number, latDeg: number, lonEastDeg: number, jd: number): { azimuthDeg: number; elevationDeg: number } {
  const h = siderealTimeDeg(jd) + lonEastDeg - raDeg;
  // Meeus measures azimuth from the south, westward; a compass bearing is 180° round from that.
  const fromSouth = degrees(atan2(sind(h), cosd(h) * sind(latDeg) - (sind(decDeg) / cosd(decDeg)) * cosd(latDeg)));
  const elevation = degrees(asin(sind(latDeg) * sind(decDeg) + cosd(latDeg) * cosd(decDeg) * cosd(h)));
  return { azimuthDeg: wrap(fromSouth + 180), elevationDeg: elevation };
}

/**
 * A direction in the world from a compass bearing and an elevation: +z points along the map's
 * bearing (toward the enemy) and +x 90° clockwise of it, as the game's yaw turns.
 */
export function toWorld(azimuthDeg: number, elevationDeg: number, mapBearingDeg: number): [number, number, number] {
  const turn = azimuthDeg - mapBearingDeg;
  const c = cosd(elevationDeg);
  return [sind(turn) * c, sind(elevationDeg), cosd(turn) * c];
}
