/**
 * The other players, as this one draws them: their seats as the room last listed them, and each
 * one's states, played back INTERP_DELAY_MS behind the room's clock (net/interp.ts).
 */

import { INTERP_DELAY_MS, SnapshotBuffer } from '../net/interp';
import { decodeState, type PlayerState, type Seat } from '../net/protocol';

export interface RemotePlayer {
  seat: Seat;
  state: PlayerState;
}

export class RemotePlayers {
  private readonly buffers = new Map<number, SnapshotBuffer>();
  private seats = new Map<number, Seat>();
  /** This player's own seat: never drawn. */
  you = -1;

  /** The room's list of seats: players gone are forgotten. */
  roster(seats: readonly Seat[]): void {
    this.seats = new Map(seats.map((s) => [s.id, s]));
    for (const id of [...this.buffers.keys()]) if (!this.seats.has(id)) this.buffers.delete(id);
  }

  /** A frame of the room's: every other player's latest state, stamped with the room's clock. */
  frame(serverAt: number, ps: readonly number[][]): void {
    for (const p of ps) {
      const id = p[0];
      if (id === this.you || !this.seats.has(id)) continue;
      const s = decodeState(p.slice(1));
      if (!s) continue;
      let b = this.buffers.get(id);
      if (!b) this.buffers.set(id, (b = new SnapshotBuffer()));
      b.push(serverAt, s);
    }
  }

  /** Forget every state (a match over, or a new one). */
  clear(): void {
    this.buffers.clear();
  }

  /** Every other player present (not away), as they were INTERP_DELAY_MS before the room's `serverNow`. */
  at(serverNow: number): RemotePlayer[] {
    const out: RemotePlayer[] = [];
    for (const [id, b] of this.buffers) {
      const seat = this.seats.get(id);
      if (!seat || seat.away) continue;
      const state = b.sample(serverNow - INTERP_DELAY_MS);
      if (state) out.push({ seat, state });
    }
    return out.sort((a, b) => a.seat.id - b.seat.id);
  }
}
