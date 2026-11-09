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
 * - **Caught up** (`catchUp`, spec notes 5, 6 and 10): a page that joins or reloads lands the room's
 *   log (the welcome's) in time order, quietly, each crater settled before the next, and runs the
 *   battle around it along the log, given each crater's strike as it goes in; so its world is a
 *   client's that was there all along. The shells still in the air are heard for the time they have
 *   left.
 *
 * Times are the room's clock as this page reckons it (ms).
 */

import type { Strike } from '../battle/director';
import { roomStrike, type FireTunables } from '../battle/fires';
import { scoopBox } from '../combat/entrenching';
import { matchSeconds, SILENT_STEP_S } from '../net/clock';
import { decodeDig, decodeShell, HURT_MAX, type ClientMsg, type Dig, type MatchLog, type RoomShell } from '../net/protocol';
import { detonationRegion } from '../world/detonation';
import type { Box } from '../world/region';
import type { Crater } from './destruction';
import type { CombatEvents, Session } from './session';

/** A harm smaller than this is not told: a scratch, which the room's health would not show. */
const HURT_LEAST = 1;

/**
 * The most ticks a catch-up's settle gives its craters before it gives up, loudly: a crater whose
 * bricks never come back, or one that waits on something nothing will do. A crater takes a few ticks
 * once its worker hands it back, and the page yields to the worker between ticks (at least 4 ms
 * each, in a browser), so this is a minute and more of one crater not going in.
 */
const SETTLE_TICKS_MAX = 20_000;

/**
 * The battle around the page (main.ts's Director) as the catch-up runs it: `runTo(s, strikes)` gives
 * it `strikes` first, even when it is already at match second `s` (they wait to light on its next
 * step, as a live frame's do), then runs it on to `s`, never back, in steps of at most 1 s, its
 * fires' chars made in the world before it returns.
 */
export interface BattleCatchUp {
  runTo(s: number, strikes: readonly Strike[]): void;
}

/** A log's entry: a shell at its landing, or a scoop at its stamp; ranked so a shell comes before a scoop of the same ms (`dug` lands the shells due by its stamp first). */
type Entry = { at: number; rank: 0; n: number; shell: RoomShell } | { at: number; rank: 1; n: number; dig: Dig };

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
    this.hold(dig);
  }

  /**
   * The room's log caught up: a page that joins, or reloads, mid-match given the world of one that was
   * there all along (the shared-battle spec's "Join and reload"; notes 5, 6 and 10). `startAt` is this
   * match's start (null in the lobby); `now` the room's clock as this page reckons it; `battle` the
   * battle around the page, run along the log (null: none to run); `yieldNow` lets the page, and its
   * destruction worker, breathe between a settle's ticks.
   *
   * - The session is set to the room first, and again as each shell lands: the welcome comes between
   *   frames, before any prepare of the match has set it (a hidden tab may run none during the whole
   *   catch-up), a frame between the settles sets it off the room once the match is over, and a crater
   *   landed off the room is cut where its shell landed, says nothing of what it struck, and strikes nothing.
   * - Its entries that decode, in time order, a shell before a scoop of the same ms: in a match, those
   *   due by the room's time as the catch-up begins; in the lobby, every one, whatever its time (a
   *   shell still in the air at the match's end, which `finish` landed on every page there).
   * - Each shell lands quietly and its crater settles before the next entry: its id is heard, so the
   *   room telling it again lands nothing. (One this battle heard before, and landed, is not landed
   *   again; one heard and still in the air lands here, in its place.) Each scoop is held and dug as
   *   `tick` digs them.
   * - One of this match's (at or after its start) first runs the battle on to its second; a shell's
   *   crater, once in, is the battle's strike if it stands on what burns, and the shell is one
   *   `landed`. An earlier match's lands with no battle run and is not `landed` (a live client's
   *   battle holds only this match's), so that match's fires' chars are not caught up: colour only.
   * - In a match, the battle is then run to the second the catch-up began at, and the shells still in
   *   the air are heard at the room's time as it is then (the catch-up takes time): each whistles for
   *   what it has left, or, already due, lands on the next tick. A scoop stamped after the catch-up
   *   began (this page's clock a little behind the room's) is given as the room's next edits are, after
   *   them (`dug`).
   *
   * While it runs, the page ticks neither the session nor this battle (together.ts caughtUp), and the
   * room's edits wait in its queue. A match that ends meanwhile waits for it too (together.ts ended):
   * `now` is then after every time, so the shells still in the air are heard with none left, and the
   * match's end lands them, quietly, after the log.
   */
  async catchUp(log: MatchLog, startAt: number | null, now: () => number, battle: BattleCatchUp | null, yieldNow: () => Promise<void>): Promise<void> {
    const { session } = this;
    session.room = true;
    const nowMs = now();
    const shells = log.shells.map((w) => decodeShell(w)).filter((s): s is RoomShell => s !== null);
    const digs = log.digs.map((w) => decodeDig(w)).filter((d): d is Dig => d !== null);
    const entries: Entry[] = [
      ...shells.map((shell): Entry => ({ at: shell.landAt, rank: 0, n: shell.id, shell })),
      ...digs.map((dig, n): Entry => ({ at: dig.at, rank: 1, n, dig })),
    ];
    const due = entries.filter((e) => startAt === null || e.at <= nowMs).sort((a, b) => a.at - b.at || a.rank - b.rank || a.n - b.n);
    for (const e of due) {
      const s = startAt !== null && e.at >= startAt ? (e.at - startAt) / 1000 : null;
      if (e.rank === 1) {
        if (s !== null) battle?.runTo(s, []);
        this.hold(e.dig);
        this.dig();
        continue;
      }
      const { shell } = e;
      if (this.heard.has(shell.id)) {
        // Heard before the catch-up: landed already, or still in the air, when it lands here, in its place.
        const i = this.air.findIndex((a) => a.id === shell.id);
        if (i < 0) continue;
        this.air.splice(i, 1);
      }
      this.heard.add(shell.id);
      if (s !== null) battle?.runTo(s, []);
      // Set again for each: a frame between the settles sets the session as the room is, off it once
      // the match is over (it may end while the page catches up), and the shell is the room's all the same.
      session.room = true;
      const id = session.land(shell.at[0], shell.at[1], shell.radius, shell.seed, true);
      const craters = await this.settle(yieldNow, shell);
      if (s === null) continue;
      this.down.push(shell);
      const crater = id === null ? undefined : craters.find((c) => c.id === id);
      const strike = crater ? roomStrike(session.map, crater, shell.seed, session.voxel, this.fireT) : null;
      battle?.runTo(s, strike ? [strike] : []);
    }
    if (startAt === null) return;
    battle?.runTo(matchSeconds(nowMs, startAt), []);
    for (const shell of shells) if (shell.landAt > nowMs) this.hear(shell, now());
    const later = digs.filter((d) => d.at > nowMs).sort((a, b) => a.at - b.at);
    for (const dig of later) this.dug(dig, now());
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

  /** Another's scoop held, to be dug in its turn: after every crater the session has given an id by now, before every later one. */
  private hold(dig: Dig): void {
    this.digs.push({ dig, box: scoopBox(this.session.map.dims, dig.cells), after: this.session.destruction.lastId });
  }

  /**
   * The catch-up's craters cut until none is pending, the page let breathe (`yieldNow`) between ticks,
   * and the held scoops dug as they come free, before each tick as `tick` digs them before the
   * session's (a crater after a held scoop waits for it: Destruction.waits). The craters that went in.
   * A crater not in after SETTLE_TICKS_MAX ticks is an error, naming it, not a page spinning for ever.
   */
  private async settle(yieldNow: () => Promise<void>, shell: RoomShell): Promise<Crater[]> {
    const d = this.session.destruction;
    const landed: Crater[] = [];
    for (let ticks = 0; d.pending > 0; ticks++) {
      if (ticks === SETTLE_TICKS_MAX) {
        const stuck = d.oldest!;
        throw new Error(`The battle's catch-up is stuck: crater ${stuck.id} is still ${stuck.state} after ${SETTLE_TICKS_MAX} ticks (settling shell ${shell.id}'s; craters pending: ${d.pending}, scoops held: ${this.digs.length}).`);
      }
      if (ticks > 0) await yieldNow();
      this.dig();
      landed.push(...d.tick());
    }
    this.dig();
    return landed;
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
