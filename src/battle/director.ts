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
 *
 * And the machine guns (§4): at night, bursts from guns on both lines further than `clear_m` along
 * them from the player, every fifth round a tracer (tracers.ts) swept across a bearing over no man's
 * land and the field, ending on the field's undisturbed ground; a burst whose fire would pass within
 * `miss_m` of the player is not fired.
 */

import { atan2, cos, radians, sin } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import type { WorldPlan } from '../world/generation/plan';
import type { Intensity } from '../combat/front';
import { barrageTunables, flashTunables, HORIZON_FLASHES, planBarrage, type BarrageTunables, type FlashTunables, type PlannedShell } from './barrages';
import { columnPuffs, farShellTunables, planFarShell, type ColumnPuff, type FarShellTunables } from './far-shells';
import { flareAt, flareTunables, type FlareState, type FlareTunables, type Launch } from './flares';
import { planShot, tracerAt, tracerTunables, type Shot, type TracerState, type TracerTunables } from './tracers';
import { fieldHeight } from '../world/generation/terrain';
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

/** A machine gun's burst as it starts: where the gun is (metres), when, its rounds and their rate. */
export interface Burst {
  id: number;
  gun: [number, number, number];
  t: number;
  rounds: number;
  rpm: number;
}

export interface BattleEvents {
  launches: Launch[];
  /** Each distant shell as it lands. */
  distant: DistantShell[];
  /** Each machine gun's burst as it starts. */
  bursts: Burst[];
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
  private readonly tt: TracerTunables;
  private readonly gunRng: Rng;
  /** The field's undisturbed height (metres) under a point: where a tracer ends; and the most it can be. */
  private readonly field: (xM: number, zM: number) => number;
  private readonly fieldTop: number;
  /** Tracers fired and not yet out. */
  private alive: Shot[] = [];
  private nextTracer = 1;
  private nextBurst = 1;

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
    this.tt = tracerTunables(tun);
    this.gunRng = root.derive('battle.guns');
    this.field = plan ? (x, z) => fieldHeight(plan.terrain, plan.params, x / plan.params.voxel, z / plan.params.voxel) * plan.params.voxel : () => -Infinity;
    // fbm is under 1, and the swale only dips: the field is never higher than this.
    const span = plan ? plan.terrain.reliefMax - plan.terrain.reliefMin : 0;
    this.fieldTop = plan ? (plan.params.ground + ((span > 1e-12 ? (1 - plan.terrain.reliefMin) / span : 0.5) - 0.5) * 2 * plan.params.field.amplitude) * plan.params.voxel : Infinity;
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
    const events: BattleEvents = { launches: [], distant: [], bursts: [] };
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

  /** The battle's tracers in flight now. */
  tracers(): TracerState[] {
    const now = this.seconds;
    const out: TracerState[] = [];
    for (const s of this.alive) {
      const at = tracerAt(s, now, this.tt);
      if (at) out.push(at);
    }
    return out;
  }

  /** The tracers fired and not yet out, as planned (their flights, for tests). */
  shots(): readonly Shot[] {
    return this.alive;
  }

  /** Barrages started since the start, and those in progress. */
  get barrages(): { started: number; running: number } {
    return { started: this.started, running: this.running.length };
  }

  /** The director at `seconds` from its start, stepped there at `inputs`. */
  static at(seconds: number, plan: WorldPlan | null, tun: Tunables, seed: number, inputs: BattleInputs, ground?: (xM: number, zM: number) => number): Director {
    const d = new Director(plan, tun, seed, ground);
    d.given = seconds;
    const events: BattleEvents = { launches: [], distant: [], bursts: [] };
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
    this.fireGuns(t, now, inputs, events);
  }

  /** A step of the machine guns, from `t` to `now`: maybe a burst, in the dark and with the front firing; the tracers out dropped. */
  private fireGuns(t: number, now: number, inputs: BattleInputs, events: BattleEvents): void {
    const tt = this.tt;
    if (inputs.intensity !== 'off' && inputs.darkness > this.ft.darkAbove && this.posts.length > 0) {
      const rate = tt.burstsLight * (inputs.intensity === 'heavy' ? tt.heavyScale : 1);
      if (this.gunRng.float() < rate / HZ) this.burst(t, inputs.player, events);
    }
    this.alive = this.alive.filter((s) => now <= s.legs[s.legs.length - 1].t1);
  }

  /** A burst from a gun away from the player: its tracers planned as it starts, every draw made whether or not it is fired. */
  private burst(t: number, player: readonly number[], events: BattleEvents): void {
    const tt = this.tt;
    const r = this.gunRng;
    const guns = this.posts.filter((p) => Math.abs(p.along - (p.longAxis === 0 ? player[0] : player[2])) > tt.clearM);
    const post = guns.length > 0 ? guns[r.randint(0, guns.length)] : null;
    const rounds = r.randint(tt.rounds[0], tt.rounds[1] + 1);
    const bearing = post ? post.across : 0;
    const from = bearing + radians(r.uniform(-tt.spreadDeg, tt.spreadDeg));
    const sweep = radians(r.uniform(-tt.sweepDeg, tt.sweepDeg));
    const elevation = radians(r.uniform(tt.elevationDeg[0], tt.elevationDeg[1]));
    const graze = r.float() < tt.grazeShare;
    const reach = r.uniform(tt.grazeM[0], tt.grazeM[1]);
    const gun: [number, number, number] = post ? [post.at[0], post.at[1] + 0.5, post.at[2]] : [0, 0, 0];
    // A grazing burst is laid on the field `reach` out, so it strikes, and ricochets, near.
    const aim = graze ? atan2(this.field(gun[0] + sin(from) * reach, gun[2] + cos(from) * reach) - gun[1], reach) : elevation;
    const shots: Shot[] = [];
    for (let k = 0; k < rounds; k += tt.tracerEvery) {
      const b = from + (rounds > 1 ? (sweep * k) / (rounds - 1) : 0);
      const dir = [sin(b) * cos(aim), sin(aim), cos(b) * cos(aim)];
      shots.push(planShot(this.nextTracer++, gun, dir, t + (k * 60) / tt.rpm, this.field, r, tt, this.fieldTop));
    }
    if (!post || shots.some((s) => s.legs.some((leg) => this.passes(leg, player)))) return;
    this.alive.push(...shots);
    events.bursts.push({ id: this.nextBurst++, gun, t, rounds, rpm: tt.rpm });
  }

  /** Whether a tracer's flight passes within miss_m of the player across the ground. */
  private passes(leg: Shot['legs'][number], player: readonly number[]): boolean {
    const end = tracerAt({ id: 0, legs: [leg] }, leg.t1, this.tt)!.position;
    const dx = end[0] - leg.from[0];
    const dz = end[2] - leg.from[2];
    const s = Math.max(0, Math.min(1, ((player[0] - leg.from[0]) * dx + (player[2] - leg.from[2]) * dz) / Math.max(dx * dx + dz * dz, 1e-9)));
    const ox = leg.from[0] + dx * s - player[0];
    const oz = leg.from[2] + dz * s - player[2];
    return ox * ox + oz * oz < this.tt.missM * this.tt.missM;
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
