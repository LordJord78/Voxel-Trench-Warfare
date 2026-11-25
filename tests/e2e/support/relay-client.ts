/**
 * A player in Node against the real relay (`wrangler dev`, which playwright.config.ts starts on 8787):
 * Node's own WebSocket, opened as a page of the game opens it (an allowed Origin, as the relay asks), every
 * message the room sends kept with the Node clock's time it came (the relay's clock is Date.now() on this
 * same machine, so the two read alike), and its text's length. No world and no session: what the relay
 * does with the game's words is all that is looked at here (the final review's item 15.7).
 */
import { parseRoom, PROTOCOL, type ClientMsg, type RoomMsg } from '../../../src/net/protocol';
import { RELAY } from './room';

/** The origin a page of the game comes from (any localhost is allowed). */
const ORIGIN = 'http://localhost:5320';

/** A room made at the relay, as the page's Host does: its code. */
export async function makeRoom(): Promise<string> {
  const r = await fetch(`${RELAY}/rooms`, { method: 'POST', headers: { Origin: ORIGIN } });
  if (!r.ok) throw new Error(`the relay said ${r.status}`);
  return ((await r.json()) as { room: string }).room;
}

/** A message from the room, as it came: when (Date.now()), its text's length, and what it says (parseRoom). */
export interface Heard {
  at: number;
  chars: number;
  msg: RoomMsg;
}

export class RelayClient {
  readonly heard: Heard[] = [];
  /** How the line closed (its code and reason), once it has. */
  closed: { code: number; reason: string } | null = null;
  private readonly ws: WebSocket;
  private readonly opened: Promise<void>;

  /** A line to room `room`; `hello` said once it opens (PROTOCOL, the build `build`, named `name`) unless null. */
  constructor(
    readonly room: string,
    name: string,
    hello: { v?: number; build?: string } | null = {},
  ) {
    this.ws = new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket)(`${RELAY.replace(/^http/, 'ws')}/room/${room}`, { headers: { Origin: ORIGIN } });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error(`the line to ${room} would not open`)));
    });
    this.ws.addEventListener('message', (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      const msg = parseRoom(text);
      if (msg) this.heard.push({ at: Date.now(), chars: text.length, msg });
    });
    this.ws.addEventListener('close', (e) => (this.closed = { code: e.code, reason: e.reason }));
    if (hello) void this.opened.then(() => this.say({ t: 'hello', v: hello.v ?? PROTOCOL, build: hello.build ?? 'relay.spec', name } as ClientMsg));
  }

  /** Once the line is open. */
  open(): Promise<void> {
    return this.opened;
  }

  say(msg: ClientMsg | Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close(1000, 'left');
  }

  /** The messages of kind `t` heard, in order. */
  all<T extends RoomMsg['t']>(t: T): (Heard & { msg: Extract<RoomMsg, { t: T }> })[] {
    return this.heard.filter((h) => h.msg.t === t) as (Heard & { msg: Extract<RoomMsg, { t: T }> })[];
  }

  /** The first message of kind `t` heard after the first `after` of them (0: the first), once it comes, within `ms`. */
  async next<T extends RoomMsg['t']>(t: T, after = 0, ms = 30_000): Promise<Heard & { msg: Extract<RoomMsg, { t: T }> }> {
    const t0 = Date.now();
    for (;;) {
      const got = this.all(t);
      if (got.length > after) return got[after];
      if (Date.now() - t0 > ms) throw new Error(`no '${t}' came to ${this.room} within ${ms} ms (heard ${this.heard.length} messages)`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Once `ok` holds, within `ms`. */
  static async until(ok: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${ms} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
