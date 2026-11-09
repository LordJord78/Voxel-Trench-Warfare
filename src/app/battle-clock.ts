/**
 * The battle around the page in a room's match, on the match's clock (main.ts): every client's
 * Director at the same moment of the same battle.
 *
 * - **Given** (`given`): the match's seconds the battle has run. Its deploy starts it at 0 (`reset`);
 *   a catch-up on the room's log (main.ts's catchUp hook, sim/room-battle.ts, run by `catchUpRunner`)
 *   sets it to the second that run reached.
 * - **A frame** (`frame`): the battle run on to the match's second now, never back (a clock sample
 *   that pulls the room's time back holds it until the room's time catches up); within
 *   SILENT_STEP_S, at once, with the frame's strikes and splashes, and heard.
 * - **Behind** (`behind`), by more than SILENT_STEP_S (a tab back from hidden, a page that has just
 *   caught up on the log): caught up silently, in SILENT_STEP_S chunks, each at the inputs of the
 *   second it ends at (`inputsAt`: the dark of the match's time of day then), so the hamlet's fires
 *   light and die down at the match's nightfall and dawn, as on a page that never hid. It is spread
 *   over frames, at most `chunks` of them a frame (a dark second is 60 Director steps, each of tens
 *   of microseconds at heavy). Meanwhile nothing of it is heard (its chars are made), and each frame's
 *   strikes and splashes are held until it reaches the second they came at, and given it there.
 */

import { noBattleEvents, type BattleEvents, type BattleInputs, type Strike } from '../battle/director';
import { battleStep, SILENT_STEP_S } from '../net/clock';
import type { BattleCatchUp } from '../sim/room-battle';

/** The Director as the clock runs it. */
export interface ClockedBattle {
  tick(seconds: number, inputs: BattleInputs): BattleEvents;
}

type Splash = NonNullable<BattleInputs['splashes']>[number];
type Chars = BattleEvents['chars'];

/**
 * `battle`, given `fromS` of the match, run on to `toS` in chunks of at most SILENT_STEP_S, each at
 * the inputs of the second it ends at; each chunk's events to `each`. The second it reached: `toS`,
 * or `fromS` when that is not before it.
 */
export function runChunks(battle: ClockedBattle, fromS: number, toS: number, inputsAt: (s: number) => BattleInputs, each: (events: BattleEvents) => void): number {
  let at = fromS;
  while (at < toS) {
    const next = Math.min(toS, at + SILENT_STEP_S);
    each(battle.tick(next - at, inputsAt(next)));
    at = next;
  }
  return at;
}

/**
 * The battle as a catch-up on the room's log runs it (sim/room-battle.ts catchUp, main.ts's hook):
 * `runTo(s, strikes)` gives `battle` the strikes first, at the second it has reached (they light on its
 * next step, as a live frame's do), then runs it on to `s` in SILENT_STEP_S chunks at the inputs of the
 * second each ends at (runChunks), never back; every step's events to `made`, which makes their chars.
 * `reached`: the second it has run to, from 0 (the deploy's battle), which the clock is given after.
 */
export function catchUpRunner(battle: ClockedBattle, inputsAt: (s: number) => BattleInputs, made: (events: BattleEvents) => void): BattleCatchUp & { readonly reached: number } {
  let reached = 0;
  return {
    get reached() {
      return reached;
    },
    runTo(s, strikes) {
      made(battle.tick(0, { ...inputsAt(reached), strikes }));
      reached = runChunks(battle, reached, s, inputsAt, made);
    },
  };
}

export class BattleClock {
  /** The match's seconds given the battle so far. */
  given = 0;
  /** Catching up: behind the room's clock by more than SILENT_STEP_S when it began. */
  private catching = false;
  /** Each frame's strikes and splashes while it catches up, at the match's second they came at, in order. */
  private held: { s: number; strikes: readonly Strike[]; splashes: readonly Splash[] }[] = [];

  /** `chunks`: the most SILENT_STEP_S chunks a frame runs while catching up ([room_battle] catch_up_chunks). */
  constructor(readonly chunks: number) {}

  /** Whether the battle is behind the room's clock, catching up: what it shows is a past moment of it. */
  get behind(): boolean {
    return this.catching;
  }

  /** The match's start: none given, nothing held. */
  reset(): void {
    this.given = 0;
    this.catching = false;
    this.held = [];
  }

  /**
   * A frame at the match's second `nowS`, with its strikes and splashes: the battle run on to it,
   * never back; past SILENT_STEP_S behind, silently, a chunk at a time, at most `chunks` this frame.
   * What is heard of it (nothing while it catches up), and the chars its fires made.
   */
  frame(battle: ClockedBattle, nowS: number, inputsAt: (s: number) => BattleInputs, strikes: readonly Strike[], splashes: readonly Splash[]): { heard: BattleEvents; chars: Chars } {
    const { stepS, silent } = battleStep(this.given, nowS);
    if (!this.catching && !silent) {
      this.given += stepS;
      const heard = battle.tick(stepS, { ...inputsAt(nowS), strikes, splashes });
      return { heard, chars: heard.chars };
    }
    this.catching = true;
    if (strikes.length > 0 || splashes.length > 0) this.held.push({ s: nowS, strikes, splashes });
    const chars: Chars = [];
    const made = (events: BattleEvents) => chars.push(...events.chars);
    const until = Math.min(nowS, this.given + this.chunks * SILENT_STEP_S);
    for (;;) {
      const next = this.held[0];
      // Each frame held is given at its second, once the battle has reached it.
      if (next && next.s <= this.given) {
        this.held.shift();
        made(battle.tick(0, { ...inputsAt(this.given), strikes: next.strikes, splashes: next.splashes }));
        continue;
      }
      const to = next ? Math.min(until, next.s) : until;
      if (to <= this.given) break;
      this.given = runChunks(battle, this.given, to, inputsAt, made);
    }
    if (this.given >= nowS && this.held.length === 0) this.catching = false;
    return { heard: noBattleEvents(), chars };
  }
}
