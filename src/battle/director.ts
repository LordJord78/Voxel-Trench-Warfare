/**
 * The battle's director (the battle spec's §1): a deterministic simulation of
 * the war around the player, on the lights' clock rather than the session's,
 * so every view the world is drawn in sees it. It runs whole 60 Hz steps of
 * the time it is given, so the same steps come of the same time at any frame
 * rate, and `at` seeks a moment by stepping to it from the start.
 *
 * It fires the flares (§2): from posts on both front lines'
 * parapets, out over no man's land, at a rate by the front's intensity — about
 * `mean_light` alight at once at light, `heavy_scale` times that heavy,
 * `off_per_min` a minute off, never more than `max_alight` at once — and only
 * while the sky is dark enough and the sun down. A quarter come from the posts
 * near the player.
 *
 * And the distant fire (§3), by the front's intensity and not the dark: barrages
 * beyond the map, each planned whole as it starts (barrages.ts) and its shells
 * landing at their times, dropped when the front falls quiet; and shells into
 * the far field (far-shells.ts), each standing on the ground there with its
 * column of smoke. Every shell landed is a flash; the sky takes the newest.
 */

import { radians } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { WorldPlan } from '../world/generation/plan';
import type { Intensity } from '../combat/front';
import { barrageTunables, flashTunables, HORIZON_FLASHES, planBarrage, type BarrageTunables, type FlashTunables, type PlannedShell } from './barrages';
import { columnPuffs, farShellTunables, planFarShell, type ColumnPuff, type FarShellTunables } from './far-shells';
import { flareAt, flareTunables, type FlareState, type FlareTunables, type Launch } from './flares';
import { Wind, windTunables } from './wind';

export interface BattleInputs {
  /** The front's, the pause menu's. */
  intensity: Intensity;
  /** How dark it is, 0 to 1: the sky's flares key while the sun is down (battleDarkness). */
  darkness: number;
  /** The player's feet, metres. */
  player: readonly [number, number, number];
}

/** A distant shell landed: beyond the map in a barrage, or in the far field (`far`). Metres, and seconds on the battle's clock. */
export interface DistantShell {
  id: number;
  position: [number, number, number];
  t: number;
  power: number;
  far: boolean;
}

export interface BattleEvents {
  launches: Launch[];
  /** Each distant shell as it lands. */
  distant: DistantShell[];
}

/** How dark the battle takes it to be: the sky's flares key while the sun is below `sun_below_deg`, and none once it is up (no flare by day). */
export function battleDarkness(sunElevationDeg: number, flaresKey: number, ft: FlareTunables): number {
  return sunElevationDeg < ft.sunBelowDeg ? flaresKey : 0;
}

/** Steps a second. */
const HZ = 60;

interface Post {
  at: [number, number, number];
  /** Metres along its line, and which axis that is. */
  along: number;
  longAxis: 0 | 2;
  /** Radians as yaw: straight across, over no man's land. */
  across: number;
}

export class Director {
  readonly wind: Wind;
  readonly ft: FlareTunables;
  /** Whole steps run, and the time they make. */
  private ticks = 0;
  /** Time given, not yet run as a whole step. */
  private given = 0;
  private readonly posts: Post[] = [];
  private readonly rng: Rng;
  private alight: Launch[] = [];
  private nextId = 1;
  private readonly bt: BarrageTunables;
  private readonly fs: FarShellTunables;
  private readonly flashT: FlashTunables;
  private readonly barrageRng: Rng;
  private readonly farRng: Rng;
  /** The map's middle (x, z metres), which the distant fire falls about. */
  private readonly centre: [number, number];
  private readonly ground: (xM: number, zM: number) => number;
  /** Barrages in progress: their shells, and the next to land. */
  private running: { shells: PlannedShell[]; next: number }[] = [];
  private started = 0;
  /** Shells landed within a flash's window, and far shells while their smoke stands. */
  private recent: DistantShell[] = [];
  private columns: DistantShell[] = [];
  private nextShell = 1;

  /** `ground`: the height (metres) a far shell stands at, at (x, z) metres; the plan's ground level if not given. */
  constructor(plan: WorldPlan | null, tun: Tunables, seed: number, ground?: (xM: number, zM: number) => number) {
    const root = Rng.root(seed);
    this.wind = new Wind(windTunables(tun), root.derive('battle.wind'));
    this.rng = root.derive('battle.flares');
    this.ft = flareTunables(tun);
    this.bt = barrageTunables(tun);
    this.fs = farShellTunables(tun);
    this.flashT = flashTunables(tun);
    this.barrageRng = root.derive('battle.barrages');
    this.farRng = root.derive('battle.far');
    const v = plan?.params.voxel ?? 0;
    this.centre = [((plan?.params.dims.x ?? 0) / 2) * v, ((plan?.params.dims.z ?? 0) / 2) * v];
    const level = (plan?.params.ground ?? 0) * v;
    this.ground = ground ?? (() => level);
    for (const line of plan?.lines ?? []) {
      if (!line.spec.firingSteps) continue;
      for (const b of line.bays) {
        const a = ((b.a0 + b.a1) / 2) * v;
        const across = (b.facing > 0 ? b.b1 : b.b0) * v;
        const y = b.crestY * v;
        this.posts.push({
          at: b.longAxis === 0 ? [a, y, across] : [across, y, a],
          along: a,
          longAxis: b.longAxis,
          across: b.longAxis === 0 ? (b.facing > 0 ? 0 : Math.PI) : b.facing > 0 ? Math.PI / 2 : -Math.PI / 2,
        });
      }
    }
  }

  get seconds(): number {
    return this.ticks / HZ;
  }

  /** `seconds` of the lights' clock, at `inputs`: what was fired. */
  tick(seconds: number, inputs: BattleInputs): BattleEvents {
    this.given += seconds;
    const events: BattleEvents = { launches: [], distant: [] };
    const target = Math.floor(this.given * HZ + 1e-6);
    while (this.ticks < target) this.step(inputs, events);
    return events;
  }

  /** The flares climbing and burning now, by id. */
  flares(): FlareState[] {
    const t = this.seconds;
    return this.alight.map((l) => flareAt(l, t, this.wind, this.ft)).filter((f) => f.stage !== 'out');
  }

  /** The newest distant shells' flashes, newest first: at most `HORIZON_FLASHES`, landed within `window_s`. */
  flashes(): DistantShell[] {
    const now = this.seconds;
    return this.recent
      .filter((s) => now - s.t <= this.flashT.windowS)
      .sort((a, b) => b.t - a.t)
      .slice(0, HORIZON_FLASHES);
  }

  /** The far shells' columns of smoke standing now, puff by puff. */
  smoke(): ColumnPuff[] {
    const now = this.seconds;
    return this.columns.flatMap((s) => columnPuffs(s, now, this.wind, this.fs));
  }

  /** Barrages started since the start, and those in progress. */
  get barrages(): { started: number; running: number } {
    return { started: this.started, running: this.running.length };
  }

  /** The director at `seconds` from its start, stepped there at `inputs`. */
  static at(seconds: number, plan: WorldPlan | null, tun: Tunables, seed: number, inputs: BattleInputs, ground?: (xM: number, zM: number) => number): Director {
    const d = new Director(plan, tun, seed, ground);
    d.given = seconds;
    const events: BattleEvents = { launches: [], distant: [] };
    const target = Math.round(seconds * HZ);
    while (d.ticks < target) d.step(inputs, events);
    return d;
  }

  private step(inputs: BattleInputs, events: BattleEvents): void {
    const t = this.ticks / HZ;
    const ft = this.ft;
    const perSecond = inputs.intensity === 'off' ? ft.offPerMin / 60 : (ft.meanLight / ft.burnS) * (inputs.intensity === 'heavy' ? ft.heavyScale : 1);
    if (inputs.darkness > ft.darkAbove && this.posts.length > 0 && this.alight.length < ft.maxAlight && this.rng.float() < perSecond / HZ) {
      const launch = this.fire(t, inputs);
      this.alight.push(launch);
      events.launches.push(launch);
    }
    this.ticks++;
    // Out at its launch, its climb and its burn: no need to fly it to know.
    const now = this.ticks / HZ;
    this.alight = this.alight.filter((l) => now <= l.t0 + Math.sqrt((2 * l.burstM) / ft.gravity) + ft.burnS);
    this.fireDistant(t, now, inputs, events);
  }

  /** A step of the distant fire, from `t` to `now`: maybe a barrage started and a far shell landed; the barrages' shells due landed; nothing while off. */
  private fireDistant(t: number, now: number, inputs: BattleInputs, events: BattleEvents): void {
    if (inputs.intensity === 'off') {
      this.running = [];
    } else {
      const heavy = inputs.intensity === 'heavy';
      if (this.barrageRng.float() < 1 / HZ / (heavy ? this.bt.everyHeavyS : this.bt.everyLightS)) {
        this.running.push({ shells: planBarrage(t, this.centre, this.barrageRng, this.bt), next: 0 });
        this.started++;
      }
      if (this.farRng.float() < 1 / HZ / (heavy ? this.fs.everyHeavyS : this.fs.everyLightS)) this.land(planFarShell(now, this.centre, this.farRng, this.fs), true, events);
    }
    for (const b of this.running) while (b.next < b.shells.length && b.shells[b.next].t <= now) this.land(b.shells[b.next++], false, events);
    this.running = this.running.filter((b) => b.next < b.shells.length);
    const old = (list: DistantShell[], keep: number) => {
      let k = 0;
      while (k < list.length && now - list[k].t > keep) k++;
      if (k > 0) list.splice(0, k);
    };
    old(this.recent, this.flashT.windowS);
    old(this.columns, this.fs.smokeS);
  }

  private land(s: PlannedShell, far: boolean, events: BattleEvents): void {
    const shell: DistantShell = { id: this.nextShell++, position: [s.x, this.ground(s.x, s.z), s.z], t: s.t, power: s.power, far };
    events.distant.push(shell);
    this.recent.push(shell);
    if (far) this.columns.push(shell);
  }

  private fire(t: number, inputs: BattleInputs): Launch {
    const ft = this.ft;
    const r = this.rng;
    const near = this.posts.filter((p) => Math.abs(p.along - (p.longAxis === 0 ? inputs.player[0] : inputs.player[2])) <= ft.nearM);
    const from = near.length > 0 && r.float() < ft.nearShare ? near : this.posts;
    const post = from[r.randint(0, from.length)];
    return {
      id: this.nextId++,
      post: [post.at[0], post.at[1], post.at[2]],
      t0: t,
      bearing: post.across + radians(r.uniform(-ft.spreadDeg, ft.spreadDeg)),
      elevation: radians(r.uniform(ft.elevationDeg[0], ft.elevationDeg[1])),
      burstM: r.uniform(ft.burstM[0], ft.burstM[1]),
      colour: r.float() < ft.redShare ? [...ft.red] : [...ft.white],
    };
  }
}
