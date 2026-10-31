/**
 * The relay: `POST /rooms` makes a room and gives its five-letter code; `GET /room/CODE`, as a
 * WebSocket upgrade, joins it. Each room is a Durable Object named by its code, running the
 * room's logic (src/net/room-core.ts) over its players' sockets and ticking it every 50 ms while
 * anyone is connected.
 *
 * Only the game's pages may make or join rooms: its GitHub Pages origin (ALLOWED_ORIGINS) and
 * any localhost, for development. A room forgets itself a day after its last player left.
 */

import { DurableObject } from 'cloudflare:workers';
import { RoomCore, type Conn } from '../../src/net/room-core';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
}

/** Letters a code is made of: no I or O, which read as 1 and 0. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE = /^\/room\/([A-HJ-NP-Z]{5})$/;
const TICK_MS = 50;
const FORGET_MS = 24 * 3600 * 1000;

function newCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

function allowed(origin: string | null, env: Env): boolean {
  if (!origin) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).includes(origin);
}

function cors(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (url.pathname === '/rooms') {
      if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin!) });
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      for (let tries = 0; tries < 6; tries++) {
        const code = newCode();
        if (await env.ROOM.get(env.ROOM.idFromName(code)).create()) {
          return Response.json({ room: code }, { status: 201, headers: cors(origin!) });
        }
      }
      return new Response('no free room code', { status: 503, headers: cors(origin!) });
    }
    const join = CODE.exec(url.pathname);
    if (join) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });
      return env.ROOM.get(env.ROOM.idFromName(join[1])).fetch(new Request(request, { headers: { ...Object.fromEntries(request.headers), 'X-Room': join[1] } }));
    }
    if (url.pathname === '/') return new Response('TRENCHLINE relay', { headers: { 'Content-Type': 'text/plain' } });
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Make the room, if its code is free: whether it was. */
  async create(): Promise<boolean> {
    if (await this.ctx.storage.get('created')) return false;
    await this.ctx.storage.put('created', Date.now());
    await this.ctx.storage.setAlarm(Date.now() + FORGET_MS);
    return true;
  }

  override async fetch(request: Request): Promise<Response> {
    const code = request.headers.get('X-Room') ?? '';
    const pair = new WebSocketPair();
    const [client, socket] = [pair[0], pair[1]];
    socket.accept();
    if (!(await this.ctx.storage.get('created'))) {
      socket.send(JSON.stringify({ t: 'refused', reason: 'no-room' }));
      socket.close(1008, 'no-room');
      return new Response(null, { status: 101, webSocket: client });
    }
    const core = (this.core ??= new RoomCore(code));
    const conn: Conn = {
      send: (text) => socket.send(text),
      close: (c, reason) => socket.close(c, reason),
    };
    core.open(conn, Date.now());
    socket.addEventListener('message', (e) => core.message(conn, typeof e.data === 'string' ? e.data : null, Date.now()));
    const gone = () => {
      core.close(conn);
      if (core.empty && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
    socket.addEventListener('close', gone);
    socket.addEventListener('error', gone);
    this.timer ??= setInterval(() => core.tick(Date.now()), TICK_MS);
    await this.ctx.storage.setAlarm(Date.now() + FORGET_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A day since anyone came: the room is forgotten, and its code free again. */
  override async alarm(): Promise<void> {
    if (this.core && !this.core.empty) {
      await this.ctx.storage.setAlarm(Date.now() + FORGET_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.core = null;
  }
}
