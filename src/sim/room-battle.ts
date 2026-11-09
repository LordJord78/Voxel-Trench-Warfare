/**
 * The room's shells on this page (the shared-battle spec's "Clients"): every shell the room tells
 * lands here at its time on the room's clock, in id order, once, so every client cuts the same
 * craters in the same order.
 *
 * - **Heard** (`hear`, each id once): it whistles for the time it has left. One heard after its
 *   time has none, and lands on the next `tick`.
 * - **Landed** (`tick`): each heard shell whose time has come, through `Session.land`; in a room its
 *   crater is cut on the ground where it is when the crater goes out (sim/destruction.ts). One more
 *   than SILENT_STEP_S overdue (a hidden tab come back) lands quietly: its crater, and no blast or
 *   harm, so a player back from away takes no backlog of blasts at once.
 * - **Struck** (`strikes`): a crater of one of its shells, once in, on what burns, is a strike from
 *   that shell's seed (battle/fires.ts roomStrike), so every client lights the same fires.
 * - **Dug** (`dug`, spec note 9): another's scoop, stamped with the room's clock, comes after every
 *   heard shell due by its stamp (they land first) and before every one after it. It is held while a
 *   crater's region it touches is pending (Session.applyDig), or an earlier held scoop overlaps it,
 *   then dug in the order the scoops came. A later shell's crater over it waits to go out until it
 *   is in (`holds`, which Destruction.waits asks), so a tab back from hidden, or a worker slow to
 *   hand an earlier crater back, still cuts that crater after the scoop, as its digger did. The
 *   player's own scoop waits while a heard shell would take its ground (`reserves`, which the session
 *   asks), so it is never made between a shell's telling and its crater.
 * - **Told** (`outgoing`): the battle's harm to the player, as hurts for the room, and the player's
 *   own scoops, while in play.
 * - **Over** (`finish`): the match ended, every shell still in the air lands at once, quietly; the
 *   scoops still held are handed on, for the next match's battle on this session.
 *
 * Times are the room's clock as this page reckons it (ms).
 */

import type { Strike } from '../battle/director';
import { roomStrike, type FireTunables } from '../battle/fires';
import { scoopBox } from '../combat/entrenching';
import { SILENT_STEP_S } from '../net/clock';
import { HURT_MAX, type ClientMsg, type Dig, type RoomShell } from '../net/protocol';
import { detonationRegion } from '../world/detonation';
import type { Box } from '../world/region';
import type { CombatEvents, Session } from './session';

/** A harm smaller than this is not told: a scratch, which the room's health would not show. */
const HURT_LEAST = 1;

/** Whether two boxes overlap across x and z, as Destruction asks of its regions. */
const across = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

/** Another's scoop, held: its box (scoopBox), and the last crater id the session had given when it was put in order, which it comes after (every later crater comes after it). */
interface Held {
  dig: Dig;
  box: Box;
  after: number;
}

export class RoomBattle {
  /** Every shell id heard: each is taken once. */
  private readonly heard = new Set<number>();
  /** Heard and not landed, in id order. */
  private air: RoomShell[] = [];
  /** Landed, in the order they landed. */
  private readonly down: RoomShell[] = [];
  /** Each of its shells' craters, by the crater's id: the shell's seed, until its strike is made. */
  private readonly seeds = new Map<number, number>();
  /** Others' scoops given to `dug` and not yet dug, in the order they came. */
  private digs: Held[] = [];

  constructor(
    readonly session: Session,
    private readonly fireT: FireTunables,
  ) {
    session.reserved = (box) => this.reserves(box);
    session.destruction.waits = (id, box) => this.holds(id, box);
  }

  /** The shells heard and not yet landed, in id order. */
  get waiting(): readonly RoomShell[] {
    return this.air;
  }

  /** The shells landed, in the order they landed. */
  get landed(): readonly RoomShell[] {
    return this.down;
  }

  /** Others' scoops given to `dug` and not yet dug, in the order they came. */
  get held(): readonly Dig[] {
    return this.digs.map((h) => h.dig);
  }

  /** A shell the room told, heard at `nowMs`: whistling for the time it has left, if it has any. */
  hear(shell: RoomShell, nowMs: number): void {
    if (this.heard.has(shell.id)) return;
    this.heard.add(shell.id);
    this.air.push(shell);
    this.air.sort((a, b) => a.id - b.id);
    if (shell.landAt > nowMs) this.session.whistle(shell.at[0], shell.at[1], (shell.landAt - nowMs) / 1000);
  }

  /**
   * Another's scoop, given at `nowMs` (this page's room clock, as `tick`'s): every heard shell due by
   * its stamp lands first, in id order, as `tick` lands them (quietly, one more than SILENT_STEP_S
   * overdue at `nowMs`: a tab back from hidden feeds its queued scoops before it ticks); then it is
   * held, to be dug by `tick`, after every crater the session has given an id by now and before
   * every later one.
   */
  dug(dig: Dig, nowMs: number): void {
    this.landDue(dig.at, nowMs);
    this.digs.push({ dig, box: scoopBox(this.session.map.dims, dig.cells), after: this.session.destruction.lastId });
  }

  /** Whether crater `id`'s job, over `box`, waits to go out: a scoop held that comes before it overlaps it across x and z. */
  holds(id: number, box: Box): boolean {
    return this.digs.some((h) => h.after < id && across(h.box, box));
  }

  /** Whether ground in `box` would be taken by a shell heard and not yet landed: its crater's region overlaps it across x and z. */
  reserves(box: Box): boolean {
    const { session } = this;
    const v = session.voxel;
    const loosen = session.destruction.t.options.loosen;
    return this.air.some((s) => {
      const region = detonationRegion(session.map.dims, [s.at[0] / v, 0, s.at[1] / v], s.radius / v, loosen);
      return region !== null && across(region, box);
    });
  }

  /** At `nowMs`: every heard shell whose time has come lands, in id order (quietly, one long overdue); then each held scoop that can be is dug. */
  tick(nowMs: number): void {
    this.landDue(nowMs, nowMs);
    this.dig();
  }

  /** The strikes of this frame's craters that are its shells': on what burns, each from its shell's seed. */
  strikes(events: CombatEvents): Strike[] {
    const out: Strike[] = [];
    for (const c of events.craters) {
      const seed = this.seeds.get(c.id);
      if (seed === undefined) continue;
      this.seeds.delete(c.id);
      const strike = roomStrike(this.session.map, c, seed, this.session.voxel, this.fireT);
      if (strike) out.push(strike);
    }
    return out;
  }

  /**
   * What to tell the room of this frame: each harm of 1 or more a hurt, at most HURT_MAX, and each of
   * the player's own scoops (`events.scoops`; another's, dug here, is none of them) its cells;
   * nothing unless `inPlay`.
   */
  outgoing(events: CombatEvents, inPlay: boolean): ClientMsg[] {
    if (!inPlay) return [];
    const out: ClientMsg[] = [];
    for (const h of events.harms) if (h.amount >= HURT_LEAST) out.push({ t: 'hurt', a: Math.min(HURT_MAX, h.amount), c: h.cause });
    for (const s of events.scoops) out.push({ t: 'dig', c: s.cells });
    return out;
  }

  /**
   * The match over: each held scoop that can be is dug, before the shells after it; then every shell
   * still in the air lands at once, quietly. They are the room's, cut on the ground as every other
   * client cuts them, though no frame of the match ran here to set the session to the room (a tab
   * hidden throughout); the next frame's Together sets it as it is. The scoops still held, which it
   * hands on: the next match's battle is given them (`dug`) before its first tick, and digs them once
   * the craters they wait for are in (the lobby ticks nothing).
   */
  finish(): Dig[] {
    this.session.room = true;
    this.dig();
    const all = this.air;
    this.air = [];
    for (const s of all) this.land(s, true);
    return this.digs.splice(0).map((h) => h.dig);
  }

  /** Every heard shell due by `byMs` lands, in id order; quietly, one more than SILENT_STEP_S overdue at `nowMs`. */
  private landDue(byMs: number, nowMs: number): void {
    if (!this.air.some((s) => s.landAt <= byMs)) return;
    const due = this.air.filter((s) => s.landAt <= byMs);
    this.air = this.air.filter((s) => s.landAt > byMs);
    for (const s of due) this.land(s, nowMs - s.landAt > 1000 * SILENT_STEP_S);
  }

  /** Each held scoop dug, in the order they came, unless a crater pending before it holds it (Session.applyDig) or an earlier one still held overlaps it. */
  private dig(): void {
    if (this.digs.length === 0) return;
    const held: Held[] = [];
    for (const h of this.digs) {
      if (held.some((e) => across(e.box, h.box)) || !this.session.applyDig(h.dig.cells, h.after)) held.push(h);
    }
    this.digs = held;
  }

  private land(s: RoomShell, quiet: boolean): void {
    const id = this.session.land(s.at[0], s.at[1], s.radius, s.seed, quiet);
    if (id !== null) this.seeds.set(id, s.seed);
    this.down.push(s);
  }
}
