/**
 * What the game and its room say to each other (the multiplayer spec's §2): JSON text over one
 * WebSocket a player. Control messages are small objects; a player's state, sent twenty times a
 * second, is a short array of integers (millimetres, centidegrees), so a frame of eight players
 * stays well under a kilobyte.
 *
 * Everything that arrives is checked here before it is believed: the room hears from anyone with
 * the link, and a client from whatever answers at the relay's address.
 */

export const PROTOCOL = 1;
export const MAX_PLAYERS = 8;
/** A name, at most this long once trimmed. */
export const NAME_MAX = 16;

export type Team = 'red' | 'blue';
export const TEAMS: readonly Team[] = ['red', 'blue'];
export type Intensity = 'off' | 'light' | 'heavy';
export type Phase = 'lobby' | 'playing';

export interface Seat {
  /** 0–7, kept while the player stays connected; also their rounds' owner (2 + id). */
  id: number;
  name: string;
  team: Team;
  ready: boolean;
  /** Not drawn and not targeted: a hidden tab, or nothing heard from them for a while. */
  away: boolean;
}

export interface RoomConfig {
  map: string;
  /** Kills that win the match. */
  killTarget: number;
  /** The clock at the start, in hours, and how fast it runs (game minutes a second). */
  timeOfDay: number;
  lapse: number;
  /** The battle's fire and shells. */
  intensity: Intensity;
  /** Seconds dead before a respawn. */
  respawnS: number;
}

export interface MatchInfo {
  /** The room's clock (ms) at the match's first tick. */
  startAt: number;
  seed: number;
  config: RoomConfig;
}

export function defaultConfig(): RoomConfig {
  return { map: 'ravine', killTarget: 30, timeOfDay: 19.5, lapse: 0, intensity: 'light', respawnS: 5 };
}

/** A player's body as others need it: where, how fast, which way they look and how they stand. */
export interface PlayerState {
  /** The sender's session tick. */
  tick: number;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  stance: number;
  height: number;
  flags: number;
}

/** What `PlayerState.flags` carries. */
export const STATE = { ON_GROUND: 1, FIRING: 2, RELOADING: 4, DIGGING: 8, CLIMBING: 16, ON_STEP: 32 } as const;

export type WireState = number[];

export function encodeState(s: PlayerState): WireState {
  const mm = (m: number) => Math.round(m * 1000);
  const cdeg = (d: number) => Math.round(d * 100);
  return [s.tick, ...s.position.map(mm), ...s.velocity.map(mm), cdeg(s.yaw), cdeg(s.pitch), s.stance, mm(s.height), s.flags];
}

const STATE_LENGTH = 12;

export function decodeState(w: unknown): PlayerState | null {
  if (!Array.isArray(w) || w.length !== STATE_LENGTH || !w.every((n) => Number.isInteger(n) && Math.abs(n) < 2147483648)) return null;
  const m = (i: number) => (w[i] as number) / 1000;
  const d = (i: number) => (w[i] as number) / 100;
  const stance = w[9] as number;
  if (stance < 0 || stance > 4) return null;
  return { tick: w[0] as number, position: [m(1), m(2), m(3)], velocity: [m(4), m(5), m(6)], yaw: d(7), pitch: d(8), stance, height: m(10), flags: (w[11] as number) & 0xff };
}

/** What a player sends their room. */
export type ClientMsg =
  | { t: 'hello'; v: number; build: string; name: string }
  | { t: 'name'; name: string }
  | { t: 'team'; team: Team }
  | { t: 'ready'; ready: boolean }
  /** The owner's: a change to the match's settings. */
  | { t: 'config'; config: Partial<RoomConfig> }
  /** The owner's: start the match, or end it and go back to the lobby. */
  | { t: 'start' }
  | { t: 'end' }
  | { t: 'ping'; c: number }
  | { t: 's'; s: WireState }
  | { t: 'away'; away: boolean };

export type Refusal = 'full' | 'version' | 'no-room' | 'bad-hello';

/** What a room sends its players. */
export type RoomMsg =
  | { t: 'welcome'; you: number; room: string; owner: number; seats: Seat[]; config: RoomConfig; phase: Phase; match: MatchInfo | null; now: number }
  | { t: 'refused'; reason: Refusal }
  | { t: 'roster'; owner: number; seats: Seat[] }
  | { t: 'config'; config: RoomConfig }
  | { t: 'start'; match: MatchInfo }
  | { t: 'end' }
  | { t: 'pong'; c: number; s: number }
  /** A frame: the room's clock, and each other player's latest state as [id, ...WireState]. */
  | { t: 'f'; s: number; ps: number[][] };

/** Control characters, and the invisible and direction-changing ones a name could hide behind. */
function hidden(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
}

/** A name as shown: control and invisible characters out, runs of space closed up, trimmed to NAME_MAX; "Soldier" if nothing is left. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Soldier';
  const spaced = raw.slice(0, 256).replace(/\s+/g, ' ');
  const name = [...[...spaced].filter((ch) => !hidden(ch.codePointAt(0)!)).join('').trim()].slice(0, NAME_MAX).join('').trim();
  return name || 'Soldier';
}

const INTENSITIES: readonly Intensity[] = ['off', 'light', 'heavy'];
const MAPS = ['ravine', 'corridor'];

/** A config change's fields that are well formed and in range; the rest dropped. */
export function cleanConfig(raw: unknown): Partial<RoomConfig> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<RoomConfig> = {};
  const num = (k: string, lo: number, hi: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= lo && (r[k] as number) <= hi ? (r[k] as number) : undefined);
  if (typeof r.map === 'string' && MAPS.includes(r.map)) out.map = r.map;
  const kills = num('killTarget', 1, 200);
  if (kills !== undefined) out.killTarget = Math.round(kills);
  const hours = num('timeOfDay', 0, 24);
  if (hours !== undefined) out.timeOfDay = hours;
  const lapse = num('lapse', 0, 10);
  if (lapse !== undefined) out.lapse = lapse;
  if (typeof r.intensity === 'string' && INTENSITIES.includes(r.intensity as Intensity)) out.intensity = r.intensity as Intensity;
  const respawn = num('respawnS', 1, 30);
  if (respawn !== undefined) out.respawnS = respawn;
  return out;
}

function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { t?: unknown }).t === 'string' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A player's message, if it is one: the room's guard against whatever a socket sends. */
export function parseClient(raw: unknown): ClientMsg | null {
  const m = parse(raw);
  if (!m) return null;
  switch (m.t) {
    case 'hello':
      return typeof m.v === 'number' && typeof m.build === 'string' && m.build.length <= 64 ? { t: 'hello', v: m.v, build: m.build, name: cleanName(m.name) } : null;
    case 'name':
      return { t: 'name', name: cleanName(m.name) };
    case 'team':
      return m.team === 'red' || m.team === 'blue' ? { t: 'team', team: m.team } : null;
    case 'ready':
      return typeof m.ready === 'boolean' ? { t: 'ready', ready: m.ready } : null;
    case 'config':
      return { t: 'config', config: cleanConfig(m.config) };
    case 'start':
      return { t: 'start' };
    case 'end':
      return { t: 'end' };
    case 'ping':
      return typeof m.c === 'number' && Number.isFinite(m.c) ? { t: 'ping', c: m.c } : null;
    case 's':
      return decodeState(m.s) ? { t: 's', s: m.s as WireState } : null;
    case 'away':
      return typeof m.away === 'boolean' ? { t: 'away', away: m.away } : null;
    default:
      return null;
  }
}

function seat(raw: unknown): Seat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!Number.isInteger(s.id) || (s.id as number) < 0 || (s.id as number) >= MAX_PLAYERS) return null;
  if (s.team !== 'red' && s.team !== 'blue') return null;
  return { id: s.id as number, name: cleanName(s.name), team: s.team, ready: s.ready === true, away: s.away === true };
}

function seats(raw: unknown): Seat[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PLAYERS) return null;
  const out = raw.map(seat);
  return out.every((s): s is Seat => s !== null) ? out : null;
}

function config(raw: unknown): RoomConfig {
  return { ...defaultConfig(), ...cleanConfig(raw) };
}

function match(raw: unknown): MatchInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  return typeof m.startAt === 'number' && Number.isInteger(m.seed) ? { startAt: m.startAt, seed: m.seed as number, config: config(m.config) } : null;
}

/** A room's message, if it is one. */
export function parseRoom(raw: unknown): RoomMsg | null {
  const m = parse(raw);
  if (!m) return null;
  switch (m.t) {
    case 'welcome': {
      const s = seats(m.seats);
      if (!s || !Number.isInteger(m.you) || typeof m.room !== 'string' || typeof m.now !== 'number') return null;
      return { t: 'welcome', you: m.you as number, room: m.room, owner: Number.isInteger(m.owner) ? (m.owner as number) : -1, seats: s, config: config(m.config), phase: m.phase === 'playing' ? 'playing' : 'lobby', match: match(m.match), now: m.now };
    }
    case 'refused':
      return m.reason === 'full' || m.reason === 'version' || m.reason === 'no-room' || m.reason === 'bad-hello' ? { t: 'refused', reason: m.reason } : null;
    case 'roster': {
      const s = seats(m.seats);
      return s ? { t: 'roster', owner: Number.isInteger(m.owner) ? (m.owner as number) : -1, seats: s } : null;
    }
    case 'config':
      return { t: 'config', config: config(m.config) };
    case 'start': {
      const info = match(m.match);
      return info ? { t: 'start', match: info } : null;
    }
    case 'end':
      return { t: 'end' };
    case 'pong':
      return typeof m.c === 'number' && typeof m.s === 'number' ? { t: 'pong', c: m.c, s: m.s } : null;
    case 'f': {
      if (typeof m.s !== 'number' || !Array.isArray(m.ps)) return null;
      const ps = (m.ps as unknown[]).filter((p): p is number[] => Array.isArray(p) && p.length === STATE_LENGTH + 1 && Number.isInteger(p[0]) && decodeState(p.slice(1)) !== null);
      return { t: 'f', s: m.s, ps };
    }
    default:
      return null;
  }
}
