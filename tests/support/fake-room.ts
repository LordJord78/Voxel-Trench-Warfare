/**
 * A room's sockets in Node, for the room's tests: a fake socket that keeps every message the room sent
 * it (parsed as a page parses them, so the room says nothing malformed) and how the room closed it; and
 * a player who opens one and says hello, with a page's rejoin token when given one.
 */
import { parseRoom, PROTOCOL, type RoomMsg } from '../../src/net/protocol';
import type { Conn, RoomCore } from '../../src/net/room-core';

export class Fake implements Conn {
  readonly got: RoomMsg[] = [];
  /** The reason the room closed it with, and its code; null while open. */
  closed: string | null = null;
  code: number | null = null;
  send(text: string): void {
    const m = parseRoom(text);
    if (!m) throw new Error(`the room sent something malformed: ${text}`);
    this.got.push(m);
  }
  close(code: number, reason: string): void {
    this.code = code;
    this.closed = reason;
  }
  last<T extends RoomMsg['t']>(t: T): Extract<RoomMsg, { t: T }> | undefined {
    return [...this.got].reverse().find((m) => m.t === t) as Extract<RoomMsg, { t: T }> | undefined;
  }
}

export const say = (room: RoomCore, c: Fake, msg: object, now: number): void => room.message(c, JSON.stringify(msg), now);

/** A page's hello: this build, its name, and its rejoin token if it has one. */
export const hello = (name: string, token?: string, build = 'b1') => ({ t: 'hello', v: PROTOCOL, build, name, ...(token === undefined ? {} : { token }) });

/** A player's socket opened at `now`, and their hello said at once. */
export function join(room: RoomCore, name: string, now = 0, token?: string): Fake {
  const c = new Fake();
  room.open(c, now);
  say(room, c, hello(name, token), now);
  return c;
}

/** A token as a page makes one (together.ts rejoinToken): 32 hex digits, here `k` repeated. */
export const token = (k: string): string => k.repeat(32).slice(0, 32);
