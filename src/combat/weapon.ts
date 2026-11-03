/**
 * The rifle, ported from the reference's `combat/weapons.py`: a weapon is its
 * `[weapon.<key>]` table — rate, magazine, cone, reload, whether it is
 * automatic, how often a round is a tracer — and its round's. Adding a weapon
 * adds a table, not code.
 *
 * The fire timer carries its remainder, so a held trigger at 650 rounds a
 * minute fires 5 and 6 ticks apart in turn (the reference reset it each shot
 * and fired at 600). While the trigger rests, or the rifle cannot fire, the
 * timer is held at one interval: a fresh pull fires at once, with no catch-up
 * burst. A semi-automatic weapon fires once per press. A reload runs its time
 * and then fills the magazine; there is no round in the chamber to keep.
 *
 * Dispersion is decided at the muzzle, as the reference does it: a uniform
 * disc of the cone's half-angle (MOA / 60 degrees, times the caller's sway) in
 * yaw and pitch, drawn angle first, then radius, from the caller's stream.
 */

import { cos, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { fromYawPitch } from '../physics/vec';
import { projectileSpec, type ProjectileSpec } from './ballistics';

export interface WeaponSpec {
  key: string;
  name: string;
  rpm: number;
  magazine: number;
  /** The cone's half-angle in minutes of arc, at a sway of 1. */
  dispersionMoa: number;
  reloadS: number;
  automatic: boolean;
  /** Every n-th round is a tracer; 0, none. */
  tracerEvery: number;
  projectile: ProjectileSpec;
  /** Rounds a shot throws, each the cone's own: a shotgun's pellets; 1 for a bullet. */
  pellets: number;
  /** Aimed down the sights: the cone's share, and the seconds the sights take to come up. */
  adsSpread: number;
  adsTimeS: number;
  /** Its carrier's speed, as a share of the stance's. */
  moveScale: number;
}

export function weaponSpec(tun: Tunables, key: string): WeaponSpec {
  const k = `weapon.${key}`;
  const table = tun.section(k);
  const or = (name: string, fallback: number) => (typeof table[name] === 'number' ? (table[name] as number) : fallback);
  return {
    pellets: Math.max(1, Math.round(or('pellets', 1))),
    adsSpread: or('ads_spread', 0.4),
    adsTimeS: or('ads_time_s', 0.22),
    moveScale: or('move_scale', 1),
    key,
    name: String(table.name),
    rpm: tun.f(`${k}.rounds_per_minute`),
    magazine: tun.i(`${k}.magazine`),
    dispersionMoa: tun.f(`${k}.dispersion_moa`),
    reloadS: tun.f(`${k}.reload_time_s`),
    automatic: table.automatic === true,
    tracerEvery: table.tracer === true ? tun.i(`${k}.tracer_every`) : 0,
    projectile: projectileSpec(tun, key),
  };
}

/** Float slack in the timer's sums of ticks. */
const EPS = 1e-9;

export class Weapon {
  rounds: number;
  shotsFired = 0;
  /** An automatic weapon switched to single shots (B): one a press, as a semi-automatic's. */
  semi = false;
  private readonly interval: number;
  private sinceShot: number;
  private reloadLeft = 0;
  private held = false;

  constructor(readonly spec: WeaponSpec) {
    this.rounds = spec.magazine;
    this.interval = 60 / spec.rpm;
    this.sinceShot = this.interval;
  }

  get reloading(): boolean {
    return this.reloadLeft > 0;
  }

  /** A full magazine, nothing under way: a soldier back in after being killed. */
  rearm(): void {
    this.rounds = this.spec.magazine;
    this.reloadLeft = 0;
    this.held = false;
    this.sinceShot = this.interval;
  }

  /** The timer, and a reload under way. */
  tick(dt: number): void {
    this.sinceShot += dt;
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= EPS) {
        this.reloadLeft = 0;
        this.rounds = this.spec.magazine;
      }
    }
  }

  /** Start a reload: false if one is running or the magazine is full. */
  beginReload(): boolean {
    if (this.reloading || this.rounds >= this.spec.magazine) return false;
    this.reloadLeft = this.spec.reloadS;
    return true;
  }

  /** Put away mid-reload: the magazine stays as it was, and the next one starts afresh. */
  cancelReload(): void {
    this.reloadLeft = 0;
    this.held = false;
    this.sinceShot = Math.min(this.sinceShot, this.interval);
  }

  /** Automatic and single shots in turn, for a weapon that has both; whether it now fires singly. */
  toggleMode(): boolean {
    if (this.spec.automatic) this.semi = !this.semi;
    return this.semi || !this.spec.automatic;
  }

  /** Once a tick, with the trigger as it is: whether a shot leaves now. */
  wants(trigger: boolean): boolean {
    const pressed = trigger && !this.held;
    this.held = trigger;
    if (!trigger || this.reloading || this.rounds <= 0) {
      this.sinceShot = Math.min(this.sinceShot, this.interval);
      return false;
    }
    if ((!this.spec.automatic || this.semi) && !pressed) return false;
    return this.sinceShot + EPS >= this.interval;
  }

  /** A shot's direction (unit) aimed along `yawDeg`, `pitchDeg`, with the cone scaled by `sway`, drawn from `rng`. */
  aim(yawDeg: number, pitchDeg: number, sway: number, rng: Rng): [number, number, number] {
    const spread = (this.spec.dispersionMoa / 60) * sway;
    const angle = rng.uniform(0, 2 * Math.PI);
    const r = spread * Math.sqrt(rng.float());
    const d = fromYawPitch(yawDeg + r * cos(angle), pitchDeg + r * sin(angle));
    return [d.x, d.y, d.z];
  }

  /** Commit a shot the pool took: one round, and one interval off the timer. */
  shot(): void {
    this.rounds--;
    this.shotsFired++;
    this.sinceShot = Math.max(0, this.sinceShot - this.interval);
  }

  /** Whether the next shot is a tracer. */
  tracer(): boolean {
    const n = this.spec.tracerEvery;
    return n > 0 && (this.shotsFired + 1) % n === 0;
  }
}
