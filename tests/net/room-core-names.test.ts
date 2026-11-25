import { describe, expect, it } from 'vitest';
import { REJOIN_MS, RoomCore } from '../../src/net/room-core';
import { join, say, token, type Fake } from '../support/fake-room';

// Two friends aren't both "Soldier" (the G6 self-playtest's P4): the room gives a name already taken
// in it a number, on a hello and on a rename, "Soldier", then "Soldier 2", the lowest free. A seat
// that leaves with its page's rejoin token (R1) holds its name for REJOIN_MS, so a reload, or the map
// change that reloads every page in any order, gives each its own name back.

const names = (room: RoomCore) => room.seats().map((s) => s.name);
/** The name of the seat the room welcomed `c` to. */
const nameOf = (room: RoomCore, c: Fake) => room.seats().find((s) => s.id === c.last('welcome')!.you)!.name;

describe("a room's names", () => {
  it('numbers a name already taken on a hello, the lowest free, in any case; everyone is told the same', () => {
    const room = new RoomCore('NAMES');
    const a = join(room, '');
    const b = join(room, '', 10);
    const c = join(room, 'soldier', 20);
    expect(names(room)).toEqual(['Soldier', 'Soldier 2', 'soldier 3']);
    expect(c.last('welcome')!.seats.map((s) => s.name)).toEqual(['Soldier', 'Soldier 2', 'soldier 3']);
    expect(a.last('roster')!.seats.map((s) => s.name)).toEqual(['Soldier', 'Soldier 2', 'soldier 3']);
    // Without a rejoin token nothing is held: the lowest free goes to the next.
    room.close(b, 30);
    join(room, 'Soldier', 40);
    expect(names(room)).toEqual(['Soldier', 'Soldier 2', 'soldier 3']);
    // A name nobody has is the asker's as it is.
    join(room, 'Jord', 50);
    expect(names(room)).toContain('Jord');
  });

  it("numbers a rename to a name taken, and never takes a player's own name from them", () => {
    const room = new RoomCore('RENAM');
    const jord = join(room, 'Jord');
    const sam = join(room, 'Sam', 10);
    say(room, sam, { t: 'name', name: 'Jord' }, 20);
    expect(names(room)).toEqual(['Jord', 'Jord 2']);
    expect(jord.last('roster')!.seats.map((s) => s.name)).toEqual(['Jord', 'Jord 2']);
    // The same again, and the first Jord saying their own name: neither moves.
    say(room, sam, { t: 'name', name: 'jord' }, 30);
    say(room, jord, { t: 'name', name: 'Jord' }, 40);
    expect(names(room)).toEqual(['Jord', 'jord 2']);
    // A name of their own again.
    say(room, sam, { t: 'name', name: 'Sam' }, 50);
    expect(names(room)).toEqual(['Jord', 'Sam']);
  });

  it('gives a rejoin its own name back, through a reload and the same page on a new line', () => {
    const room = new RoomCore('RELOD');
    const t = { a: token('a'), b: token('b') };
    join(room, '', 0, t.a);
    let b = join(room, '', 10, t.b);
    expect(names(room)).toEqual(['Soldier', 'Soldier 2']);
    room.close(b, 1_000);
    b = join(room, '', 16_000, t.b);
    expect(names(room)).toEqual(['Soldier', 'Soldier 2']);
    // A reload before the old line's close came: the old line let go, its name the new one's.
    join(room, '', 17_000, t.b);
    expect(names(room)).toEqual(['Soldier', 'Soldier 2']);
  });

  it('keeps a rejoin its own number though a lower one came free meanwhile: names do not shift under friends', () => {
    const room = new RoomCore('SHIFT');
    const first = join(room, '');
    let second = join(room, '', 10, token('b'));
    join(room, 'Sam', 20);
    expect(names(room)).toEqual(['Soldier', 'Soldier 2', 'Sam']);
    // The second reloads; meanwhile the first (no token) leaves, and Soldier is free.
    room.close(second, 1_000);
    room.close(first, 1_100);
    second = join(room, '', 15_000, token('b'));
    expect(nameOf(room, second)).toBe('Soldier 2');
  });

  it('holds a name that left for its return, through a map change in which every page comes back in any order and a newcomer comes meanwhile', () => {
    const room = new RoomCore('MAPCH');
    const t = { a: token('a'), b: token('b'), c: token('c') };
    const a = join(room, '', 0, t.a);
    const b = join(room, '', 10, t.b);
    const c = join(room, 'Sam', 20, t.c);
    expect(names(room)).toEqual(['Soldier', 'Soldier 2', 'Sam']);
    // The host picks the Corridor: every page reloads, the room empty meanwhile; its memory kept
    // through its object's eviction (server/src/keeper.ts) and woken in another.
    say(room, a, { t: 'config', config: { map: 'corridor' } }, 1_000);
    room.close(a, 1_100);
    room.close(b, 1_200);
    room.close(c, 1_300);
    const next = new RoomCore('MAPCH');
    next.restore(room.snapshot());
    // Soldier 2's page is the quickest; a stranger asks for Soldier before the host is back.
    const back = {
      b: join(next, '', 15_000, t.b),
      stranger: join(next, 'Soldier', 16_000),
      a: join(next, '', 20_000, t.a),
      c: join(next, 'Sam', 21_000, t.c),
    };
    expect(Object.fromEntries(Object.entries(back).map(([who, c]) => [who, nameOf(next, c)]))).toEqual({ b: 'Soldier 2', stranger: 'Soldier 3', a: 'Soldier', c: 'Sam' });
  });

  it('lets a held name go after REJOIN_MS, or when its rejoin asks for another', () => {
    const room = new RoomCore('LAPSE');
    const t = { a: token('a'), b: token('b') };
    join(room, 'Lee', 0, t.a);
    const b = join(room, 'Kit', 10, t.b);
    room.close(b, 100);
    // Kit held: a newcomer named Kit is numbered.
    const other = join(room, 'Kit', 200);
    expect(names(room)).toEqual(['Lee', 'Kit 2']);
    room.close(other, 300);
    // Past REJOIN_MS the seat is forgotten, and its name with it.
    join(room, 'Kit', 100 + REJOIN_MS + 1);
    expect(names(room)).toEqual(['Lee', 'Kit']);
    // A rejoin asking for a name of its own: that name, numbered as any; the name it left is free.
    const lee = room.seats()[0];
    const c = join(room, 'Max', 200_000, token('c'));
    room.close(c, 200_100);
    join(room, 'Kit', 200_200, token('c'));
    expect(names(room)).toEqual([lee.name, 'Kit', 'Kit 2']);
    join(room, 'Max', 200_300);
    expect(names(room)).toContain('Max');
  });

  it('lets a rename have a name whose hold ran out, with no hello or tick between', () => {
    const room = new RoomCore('LAPSE');
    const sam = join(room, 'Sam');
    const kit = join(room, 'Kit', 10, token('k'));
    room.close(kit, 100);
    // Held: a rename to it is numbered.
    say(room, sam, { t: 'name', name: 'Kit' }, 200);
    expect(names(room)).toEqual(['Kit 2']);
    // The hold ran out: the same rename has it, though nothing else has happened since.
    say(room, sam, { t: 'name', name: 'Kit' }, 100 + REJOIN_MS + 1);
    expect(names(room)).toEqual(['Kit']);
  });

  it("restores a room's memory from before names were held without failing a hello", () => {
    const room = new RoomCore('OLDMM');
    join(room, 'Jord', 0, token('j'));
    const sam = join(room, 'Sam', 10, token('s'));
    room.close(sam, 100);
    const memory = room.snapshot();
    // A memory written before R2: its left seats carry no name.
    const old = { ...memory, left: memory.left.map(([t, l]) => [t, { ...l, name: undefined, asked: undefined }] as unknown as (typeof memory.left)[number]) };
    const next = new RoomCore('OLDMM');
    next.restore(old);
    expect(() => join(next, 'Sam', 200)).not.toThrow();
    expect(names(next)).toEqual(['Sam']);
  });
});
