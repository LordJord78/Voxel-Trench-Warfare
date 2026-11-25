/**
 * The room's memory through its Durable Object's eviction (the R1 review's F1). A map change reloads
 * every page, the host's too, and each spends ten to thirty seconds making its world before it says
 * hello again: meanwhile the room has nobody in it, no timer (pacer.ts) and no request, and Cloudflare
 * evicts such an object after ten seconds, its memory with it. The room's settings (its map), the
 * seats that left and the claims on the host role must outlive that (room-core.ts RoomMemory), so the
 * keeper puts them in the object's storage as the room's last seat leaves, whatever let it go (a close,
 * or the room's own tick: a line gone silent, the room idle), and the next object wakes the room from
 * them. A seat taken again, the memory is the object's own once more and storage's copy goes, so a
 * restart while anyone is seated (a redeploy) cannot bring back settings changed since. The rest goes
 * with the object's storage a day after the room's last player left (index.ts alarm).
 *
 * Plain TypeScript with its storage given, so the tests run it (tests/net/room-keeper.test.ts); the
 * Durable Object gives it ctx.storage.
 */

import { RoomCore, type RoomMemory } from '../../src/net/room-core';

/** The storage key of the room's memory while nobody is in it. */
export const MEMORY = 'memory';

/** Storage as the keeper uses it: the Durable Object's ctx.storage. */
export interface Store {
  put(key: string, value: RoomMemory): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** The room `code`, as it was as its last seat left if its memory was kept, else as new. */
export function wakeRoom(code: string, memory: RoomMemory | undefined): RoomCore {
  const room = new RoomCore(code);
  if (memory) room.restore(memory);
  return room;
}

export class Keeper {
  private seated: boolean;

  /** `kept`: whether storage holds the room's memory now (the room was woken from it). */
  constructor(
    private readonly room: Pick<RoomCore, 'seats' | 'snapshot'>,
    private readonly store: Store,
    private kept: boolean,
  ) {
    this.seated = room.seats().length > 0;
  }

  /** After anything that may have seated the room's first player or let its last go: its memory put in storage, or taken out. */
  settle(): void {
    const seated = this.room.seats().length > 0;
    if (this.seated && !seated) {
      // Unawaited: the object's output gate holds anything it sends until the write is safe.
      this.store.put(MEMORY, this.room.snapshot()).catch((e) => console.error('the room\'s memory was not kept', e));
      this.kept = true;
    } else if (seated && this.kept) {
      this.store.delete(MEMORY).catch((e) => console.error('the room\'s kept memory was not dropped', e));
      this.kept = false;
    }
    this.seated = seated;
  }
}
