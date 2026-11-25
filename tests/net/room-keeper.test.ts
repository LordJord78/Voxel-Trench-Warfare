import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/net/protocol';
import { HELLO_MS, REJOIN_MS, SEAT_SILENT_MS } from '../../src/net/room-core';
import { Keeper, MEMORY, wakeRoom, type Store } from '../../server/src/keeper';
import { join, say, token } from '../support/fake-room';

// The room's memory through its Durable Object's eviction (server/src/keeper.ts; the R1 review's F1).
// A map change reloads every page, so for the ten to thirty seconds each spends making its world the
// room has nobody in it: no socket, no timer, no request. Cloudflare evicts such an object after ten
// seconds, its memory with it. What the room must keep through that (its settings, the seats that left
// and the host's claim) goes to storage as its last seat leaves, and comes back with the next object.

/** The object's storage: what is put, kept as storage keeps it (a copy, here through JSON), and every write counted. */
class FakeStore implements Store {
  readonly items = new Map<string, unknown>();
  writes = 0;
  async put(key: string, value: unknown): Promise<void> {
    this.writes++;
    this.items.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    this.writes++;
    return this.items.delete(key);
  }
}

const teams = (room: { seats(): { name: string; team: string }[] }) => room.seats().map((s) => [s.name, s.team]);

describe("the room's memory", () => {
  it('is kept as its last seat leaves and forgotten as a seat is taken again, so a map change outlives the object: the map, the host and every team held', () => {
    const store = new FakeStore();
    let room = wakeRoom('KEEPS', undefined);
    let keeper = new Keeper(room, store, false);
    const t = { host: token('1'), sam: token('2'), lee: token('3') };
    // The Durable Object settles its keeper after each thing that happens to the room.
    const host = join(room, 'Host', 0, t.host);
    keeper.settle();
    const sam = join(room, 'Sam', 10, t.sam);
    keeper.settle();
    const lee = join(room, 'Lee', 20, t.lee);
    keeper.settle();
    say(room, lee, { t: 'team', team: 'blue' }, 30);
    keeper.settle();
    say(room, host, { t: 'config', config: { map: 'corridor' } }, 1_000);
    keeper.settle();
    // Every page reloads for the Corridor: nothing written while anyone is seated, once as the last goes.
    for (const [c, at] of [[host, 1_100], [lee, 1_200]] as const) {
      room.close(c, at);
      keeper.settle();
    }
    expect(store.writes).toBe(0);
    room.close(sam, 1_300);
    keeper.settle();
    keeper.settle();
    expect(store.writes).toBe(1);
    expect(store.items.has(MEMORY)).toBe(true);
    // Evicted: the next object wakes the room from storage.
    room = wakeRoom('KEEPS', store.items.get(MEMORY) as never);
    keeper = new Keeper(room, store, true);
    const sam2 = join(room, 'Sam', 15_000, t.sam);
    keeper.settle();
    expect(sam2.last('welcome')!.config.map).toBe('corridor');
    // A seat taken: the memory is the object's again, and storage's copy goes, so a later restart (a
    // redeploy mid-match) cannot bring back settings since changed.
    expect(store.items.has(MEMORY)).toBe(false);
    expect(store.writes).toBe(2);
    join(room, 'Lee', 16_000, t.lee);
    keeper.settle();
    const host2 = join(room, 'Host', 20_000, t.host);
    keeper.settle();
    expect(host2.last('welcome')).toMatchObject({ you: 0, owner: 0 });
    expect(teams(room)).toEqual([['Host', 'red'], ['Sam', 'blue'], ['Lee', 'blue']]);
    expect(store.writes).toBe(2);
  });

  it('is kept too when the room lets its last seat go (a line gone silent), and not for a socket that never said hello', () => {
    const store = new FakeStore();
    const room = wakeRoom('QUIET', undefined);
    const keeper = new Keeper(room, store, false);
    // A socket that opens and never says hello comes and goes: nobody was seated, nothing to keep.
    room.open({ send: () => {}, close: () => {} }, 0);
    room.tick(HELLO_MS + 1);
    keeper.settle();
    expect(store.writes).toBe(0);
    // A lone friend whose laptop lid shuts: let go SEAT_SILENT_MS on, by the room's own tick.
    join(room, 'Kim', 1_000, token('k'));
    keeper.settle();
    room.tick(1_000 + SEAT_SILENT_MS + 1);
    expect(room.seats()).toEqual([]);
    keeper.settle();
    expect(store.writes).toBe(1);
    // The friend's page, reloaded within REJOIN_MS on a new object, has its place back.
    const again = wakeRoom('QUIET', store.items.get(MEMORY) as never);
    const kim = join(again, 'Kim', 1_000 + SEAT_SILENT_MS + REJOIN_MS, token('k'));
    expect(kim.last('welcome')).toMatchObject({ you: 0, owner: 0 });
    // No memory at all is a room as new.
    expect(wakeRoom('FRESH', undefined).config).toEqual(defaultConfig());
  });
});
