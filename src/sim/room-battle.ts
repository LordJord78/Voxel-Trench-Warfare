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
 * - **Told** (`outgoing`): the battle's harm to the player, as hurts for the room, while in play.
 * - **Over** (`finish`): the match ended, every shell still in the air lands at once, quietly.
 *
 * Times are the room's clock as this page reckons it (ms).
 */

import type { Strike } from '../battle/director';
import { roomStrike, type FireTunables } from '../battle/fires';
import { SILENT_STEP_S } from '../net/clock';
import { HURT_MAX, type ClientMsg, type RoomShell } from '../net/protocol';
import type { CombatEvents, Session } from './session';

/** A harm smaller than this is not told: a scratch, which the room's health would not show. */
const HURT_LEAST = 1;

export class RoomBattle {
  /** Every shell id heard: each is taken once. */
  private readonly heard = new Set<number>();
  /** Heard and not landed, in id order. */
  private air: RoomShell[] = [];
  /** Landed, in the order they landed. */
  private readonly down: RoomShell[] = [];
  /** Each of its shells' craters, by the crater's id: the shell's seed, until its strike is made. */
  private readonly seeds = new Map<number, number>();

  constructor(
    readonly session: Session,
    private readonly fireT: FireTunables,
  ) {}

  /** The shells heard and not yet landed, in id order. */
  get waiting(): readonly RoomShell[] {
    return this.air;
  }

  /** The shells landed, in the order they landed. */
  get landed(): readonly RoomShell[] {
    return this.down;
  }

  /** A shell the room told, heard at `nowMs`: whistling for the time it has left, if it has any. */
  hear(shell: RoomShell, nowMs: number): void {
    if (this.heard.has(shell.id)) return;
    this.heard.add(shell.id);
    this.air.push(shell);
    this.air.sort((a, b) => a.id - b.id);
    if (shell.landAt > nowMs) this.session.whistle(shell.at[0], shell.at[1], (shell.landAt - nowMs) / 1000);
  }

  /** At `nowMs`: every heard shell whose time has come lands, in id order; quietly, one long overdue. */
  tick(nowMs: number): void {
    if (!this.air.some((s) => s.landAt <= nowMs)) return;
    const due = this.air.filter((s) => s.landAt <= nowMs);
    this.air = this.air.filter((s) => s.landAt > nowMs);
    for (const s of due) this.land(s, nowMs - s.landAt > 1000 * SILENT_STEP_S);
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

  /** What to tell the room of this frame's harms: each of 1 or more a hurt, at most HURT_MAX; nothing unless `inPlay`. */
  outgoing(events: CombatEvents, inPlay: boolean): ClientMsg[] {
    if (!inPlay) return [];
    const out: ClientMsg[] = [];
    for (const h of events.harms) if (h.amount >= HURT_LEAST) out.push({ t: 'hurt', a: Math.min(HURT_MAX, h.amount), c: h.cause });
    return out;
  }

  /**
   * The match over: every shell still in the air lands at once, quietly. They are the room's, cut on
   * the ground as every other client cuts them, though no frame of the match ran here to set the
   * session to the room (a tab hidden throughout); the next frame's Together sets it as it is.
   */
  finish(): void {
    this.session.room = true;
    const all = this.air;
    this.air = [];
    for (const s of all) this.land(s, true);
  }

  private land(s: RoomShell, quiet: boolean): void {
    const id = this.session.land(s.at[0], s.at[1], s.radius, s.seed, quiet);
    if (id !== null) this.seeds.set(id, s.seed);
    this.down.push(s);
  }
}
