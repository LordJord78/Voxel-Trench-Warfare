import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { encodeShotMark } from '../../src/net/gear';
import { CLIENT_TEXT_MAX, cleanConfig, CODE_LETTERS, isRoomCode, isToken, cleanName, decodeDig, decodeShell, decodeShot, decodeState, defaultConfig, DIG_CELLS_MAX, DIG_SPAN_MAX, encodeShot, encodeState, HURT_MAX, NAME_MAX, parseClient, parseRoom, PROTOCOL, ROOM_TEXT_MAX, sent, SHOTS_MAX, WORLD_DIMS, type PlayerState, type ShotState, type WireDig } from '../../src/net/protocol';
import { genParams, MAP_IDS } from '../../src/world/generation/params';
import { LAST_CELL as LAST, MOST_CELLS as MOST, worldCell as cell } from '../support/cells';

const state: PlayerState = { tick: 1234, position: [128.4567, 13.05, 105.2], velocity: [-4.1, 0, 0.25], yaw: 271.25, pitch: -12.5, stance: 3, height: 1.8, flags: 33 };

describe('the protocol', () => {
  it('carries a state to a millimetre and a hundredth of a degree, as a dozen integers', () => {
    const wire = encodeState(state);
    expect(wire).toHaveLength(12);
    expect(wire.every(Number.isInteger)).toBe(true);
    const back = decodeState(wire)!;
    back.position.forEach((v, i) => expect(v).toBeCloseTo(state.position[i], 3));
    back.velocity.forEach((v, i) => expect(v).toBeCloseTo(state.velocity[i], 3));
    expect(back.yaw).toBeCloseTo(state.yaw, 2);
    expect(back.pitch).toBeCloseTo(state.pitch, 2);
    expect({ tick: back.tick, stance: back.stance, flags: back.flags }).toEqual({ tick: 1234, stance: 3, flags: 33 });
    // A frame of eight players stays under a kilobyte.
    expect(JSON.stringify({ t: 'f', s: 1e12, ps: Array.from({ length: 8 }, (_, i) => [i, ...wire]) }).length).toBeLessThan(1024);
  });

  it('believes nothing malformed', () => {
    for (const bad of [null, 42, '{', '[]', '{"t":1}', 'x'.repeat(5000), JSON.stringify({ t: 'team', team: 'green' }), JSON.stringify({ t: 's', s: [1, 2, 3] }), JSON.stringify({ t: 's', s: [0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0] }), JSON.stringify({ t: 'ping', c: 'soon' }), JSON.stringify({ t: 'what' })]) {
      expect(parseClient(bad), String(bad).slice(0, 40)).toBeNull();
    }
    expect(parseClient(JSON.stringify({ t: 's', s: encodeState(state) }))).toEqual({ t: 's', s: encodeState(state), sh: [] });
    // Shots: well formed ones kept, at most SHOTS_MAX; a direction that is not near a unit dropped.
    const shot = encodeShot({ tick: 9, origin: [1, 2, 3], dir: [0, 0.6, 0.8], tracer: true });
    const parsed = parseClient(JSON.stringify({ t: 's', s: encodeState(state), sh: [shot, [1, 2], [9, 0, 0, 0, 0, 0, 0, 0], ...Array(9).fill(shot)] }));
    expect(parsed).toMatchObject({ t: 's' });
    expect((parsed as { sh: number[][] }).sh).toHaveLength(SHOTS_MAX - 2);
    const back = decodeShot(shot)!;
    expect(back.dir[1]).toBeCloseTo(0.6, 4);
    expect(back.tracer).toBe(true);
    expect(parseClient(JSON.stringify({ t: 'hit', v: 2, z: 'head' }))).toEqual({ t: 'hit', v: 2, z: 'head' });
    expect(parseClient(JSON.stringify({ t: 'hit', v: 2, z: 'soul' }))).toBeNull();
    expect(parseClient(JSON.stringify({ t: 'hurt', a: 500, c: 'shell' }))).toBeNull();
    expect(parseRoom(JSON.stringify({ t: 'roster', owner: 0, seats: [{ id: 9, name: 'x', team: 'red' }] }))).toBeNull();
    expect(parseRoom(JSON.stringify({ t: 'f', s: 5, ps: [[1, ...encodeState(state)], [2, 1, 2], 'x'] }))).toEqual({ t: 'f', s: 5, ps: [[1, ...encodeState(state)]], sh: [] });
  });

  it("carries a page's rejoin token in its hello when it is one, the room's word that it is closing a line, and the relay's letters for codes", () => {
    const hello = { t: 'hello', v: PROTOCOL, build: 'b', name: 'n' };
    // A page's token (together.ts rejoinToken): 32 hex digits, 128 random bits.
    const token = '0123456789abcdef0123456789abcdef';
    expect(isToken(token)).toBe(true);
    expect(parseClient(JSON.stringify({ ...hello, token }))).toEqual({ ...hello, token });
    // One that is not a page's (short enough to guess, too long, not its letters, not a string): the hello stands, without it.
    for (const bad of ['short', 'aaaaaaaaaaaaaaaaaaaa', 'x'.repeat(65), 'has spaces in it, and is long enough', 42, null]) {
      expect(isToken(bad), String(bad)).toBe(false);
      expect(parseClient(JSON.stringify({ ...hello, token: bad })), String(bad)).toEqual(hello);
    }
    for (const reason of ['idle', 'replaced'] as const) expect(parseRoom(JSON.stringify({ t: 'closing', reason }))).toEqual({ t: 'closing', reason });
    expect(parseRoom(JSON.stringify({ t: 'closing', reason: 'bored' }))).toBeNull();
    // A code is five of the relay's letters: never I or O, which read as 1 and 0.
    expect(CODE_LETTERS).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ');
    for (const ok of ['KXQRT', 'ABCDE', 'ZZZZZ']) expect(isRoomCode(ok), ok).toBe(true);
    for (const bad of ['HOUSE', 'OOOOO', 'IIIII', 'abcde', 'ABCD', 'ABCDEF', 'AB DE']) expect(isRoomCode(bad), bad).toBe(false);
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') expect(isRoomCode(letter.repeat(5)), letter).toBe(CODE_LETTERS.includes(letter));
  });

  it('carries shells and digs as integers, and believes no malformed one', () => {
    expect(PROTOCOL).toBe(2);
    expect(DIG_CELLS_MAX).toBe(64);
    // A player's scoop: 1–64 packed cells of the world (each an integer in [0, X·Y·Z)), close together.
    const most = MOST;
    expect(parseClient(JSON.stringify({ t: 'dig', c: [0, 5, 2] }))).toEqual({ t: 'dig', c: [0, 5, 2] });
    expect(parseClient(JSON.stringify({ t: 'dig', c: [LAST] }))).toEqual({ t: 'dig', c: [LAST] });
    expect(parseClient(JSON.stringify({ t: 'dig', c: most }))).toEqual({ t: 'dig', c: most });
    for (const c of [[], Array(DIG_CELLS_MAX + 1).fill(1), [1.5], [-1], [LAST + 1], [2147483648], [1, null], ['1'], 'x', 7, null]) {
      expect(parseClient(JSON.stringify({ t: 'dig', c })), JSON.stringify(c).slice(0, 40)).toBeNull();
    }
    expect(parseClient(JSON.stringify({ t: 'dig' }))).toBeNull();
    // The room's shell: [id, landAt (room ms), x mm, z mm, radius mm, seed], its seed any u32.
    const shell = [3, 1_762_600_001_623, 120_500, 2_000, 2_750, 4294967295];
    expect(decodeShell(shell)).toEqual({ id: 3, landAt: 1_762_600_001_623, at: [120.5, 2], radius: 2.75, seed: 4294967295 });
    expect(decodeShell([1, 0, 0, 0, 1, 0])).toEqual({ id: 1, landAt: 0, at: [0, 0], radius: 0.001, seed: 0 });
    const swap = (i: number, v: unknown) => shell.map((n, k) => (k === i ? v : n));
    for (const bad of [shell.slice(0, 5), [...shell, 1], swap(0, 1.5), swap(1, 1.5), swap(2, 0.5), swap(4, 2.5), swap(4, 0), swap(5, 4294967296), swap(5, -1), swap(5, 0.5), swap(3, '2000'), 'x', null, {}]) {
      expect(decodeShell(bad), JSON.stringify(bad)).toBeNull();
    }
    // The room's dig: [seat, at (room ms), ...cells], from a seat 0–7.
    expect(decodeDig([7, 12_000, 1, 2, 3])).toEqual({ seat: 7, at: 12_000, cells: [1, 2, 3] });
    expect(decodeDig([0, 12_000, ...most])).toEqual({ seat: 0, at: 12_000, cells: most });
    for (const bad of [[8, 12_000, 1], [-1, 12_000, 1], [0.5, 12_000, 1], [0, 12_000], [0, 12_000, 1.5], [0, 12_000, -1], [0, 12_000, LAST + 1], [0, 12_000, 2147483648], [0, 1.5, 1], [0, 12_000, ...most, LAST], 'x', null]) {
      expect(decodeDig(bad), JSON.stringify(bad).slice(0, 40)).toBeNull();
    }
    expect(parseRoom(JSON.stringify({ t: 'shell', s: shell }))).toEqual({ t: 'shell', s: shell });
    expect(parseRoom(JSON.stringify({ t: 'shell', s: shell.slice(0, 5) }))).toBeNull();
    expect(parseRoom(JSON.stringify({ t: 'dig', d: [1, 12_000, 4, 5] }))).toEqual({ t: 'dig', d: [1, 12_000, 4, 5] });
    expect(parseRoom(JSON.stringify({ t: 'dig', d: [9, 12_000, 4, 5] }))).toBeNull();
    // A hurt's amount is at most HURT_MAX.
    expect(HURT_MAX).toBe(200);
    expect(parseClient(JSON.stringify({ t: 'hurt', a: HURT_MAX, c: 'shell' }))).toEqual({ t: 'hurt', a: HURT_MAX, c: 'shell' });
    expect(parseClient(JSON.stringify({ t: 'hurt', a: HURT_MAX + 0.5, c: 'shell' }))).toBeNull();
    // A hurt names its cause as the kill feed does: a blast's is 'shell'.
    expect(parseClient(JSON.stringify({ t: 'hurt', a: 10, c: 'blast' }))).toBeNull();
  });

  it("refuses a scoop whose cells span more of the world than a shovel reaches, whoever sends it: the room logs and relays none, and no page digs one", () => {
    // Corner to corner, two cells: a settle over the whole map, hundreds of megabytes on every page.
    const corners = [cell(0, 150, 0), cell(WORLD_DIMS.x - 1, 150, WORLD_DIMS.z - 1)];
    expect(parseClient(JSON.stringify({ t: 'dig', c: corners }))).toBeNull();
    expect(decodeDig([1, 12_000, ...corners])).toBeNull();
    expect(parseRoom(JSON.stringify({ t: 'dig', d: [1, 12_000, ...corners] }))).toBeNull();
    const seats = [{ id: 0, name: 'Jordan', team: 'red', ready: false, away: false }];
    const welcome = parseRoom(JSON.stringify({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'lobby', match: null, now: 5, log: { shells: [], digs: [[1, 9_000, ...corners], [1, 9_100, 7]] } }));
    expect((welcome as Extract<typeof welcome, { t: 'welcome' }>).log.digs).toEqual([[1, 9_100, 7]]);
    // On every axis, DIG_SPAN_MAX cells across is a scoop; one more is not.
    const at = [1_000, 100, 1_000];
    for (const axis of [0, 1, 2]) {
      const far = (n: number) => cell(...(at.map((v, k) => (k === axis ? v + n : v)) as [number, number, number]));
      expect(decodeDig([1, 12_000, far(0), far(DIG_SPAN_MAX - 1)]), `axis ${axis}`).not.toBeNull();
      expect(decodeDig([1, 12_000, far(0), far(DIG_SPAN_MAX)]), `axis ${axis}`).toBeNull();
      expect(parseClient(JSON.stringify({ t: 'dig', c: [far(DIG_SPAN_MAX), far(0)] })), `axis ${axis}`).toBeNull();
    }
    // Unpacked as packed: x the fastest, so cells a row apart in y are near, not 2,560 apart in x.
    expect(decodeDig([1, 12_000, cell(2_559, 10, 7), cell(2_559, 11, 7), cell(2_524, 12, 8)])).not.toBeNull();
  });

  it("pins the world's dims, the same as both maps generate, and a scoop's span to what the shovel reaches", () => {
    const tun = loadTunables();
    for (const map of MAP_IDS) expect(genParams(tun, undefined, map).dims, map).toEqual(WORLD_DIMS);
    // The shovel takes its voxels within ceil(reach) of a point (combat/entrenching.ts scan): an honest
    // scoop is at most 2·ceil(reach) + 1 across, and the room allows a few voxels more.
    const reach = Math.ceil(tun.f('entrenching.reach_m') / tun.f('world.voxel_size') - 1e-9);
    expect(DIG_SPAN_MAX).toBe(2 * reach + 4);
    expect(DIG_SPAN_MAX).toBeGreaterThanOrEqual(2 * reach + 1);
  });

  it('a shot flown as sent is what its words say', () => {
    // A shot is flown as the others will fly it (sent): the words it goes out as, and the shot they
    // say, which is the shot every other client decodes from the room's frame ([seat, ...words]).
    const rng = Rng.root(11).derive('protocol.sent');
    const guns = ['ak74', 'm4', 'mp5', 'svd', 'm249', 'm870', 'm17', 'pm'] as const;
    let moved = 0;
    for (let k = 0; k < 50; k++) {
      const d = [rng.normal(), rng.normal(), rng.normal()];
      const l = Math.hypot(d[0], d[1], d[2]);
      const tracer = rng.chance(0.5);
      const s: ShotState = {
        tick: rng.randint(0, 2_000_000),
        origin: [rng.uniform(-50, 300), rng.uniform(-5, 40), rng.uniform(-50, 300)],
        dir: [d[0] / l, d[1] / l, d[2] / l],
        tracer,
        ...(rng.chance(0.8) ? { mark: encodeShotMark({ tracer, kind: rng.randint(0, 4), suppressed: rng.chance(0.5), gun: rng.choice(guns) }) } : {}),
      };
      const out = sent(s);
      expect(out.wire).toEqual(encodeShot(s));
      const seat = rng.randint(0, 8);
      const frame = parseRoom(JSON.stringify({ t: 'f', s: 5, ps: [], sh: [[seat, ...out.wire]] }));
      expect(frame).toMatchObject({ t: 'f' });
      const relayed = (frame as Extract<typeof frame, { t: 'f' }>).sh;
      expect(relayed).toHaveLength(1);
      expect(relayed[0][0]).toBe(seat);
      expect(decodeShot(relayed[0].slice(1)), `shot ${k}`).toEqual(out.shot);
      // Rounded to the millimetre and to 1e-4 of a unit: not the shot as aimed.
      if (out.shot.origin.some((v, i) => v !== s.origin[i]) || out.shot.dir.some((v, i) => v !== s.dir[i])) moved++;
    }
    expect(moved).toBe(50);
  });

  it("takes a room's message up to a mebibyte, a player's still not past 4,096 characters", () => {
    expect(ROOM_TEXT_MAX).toBe(1 << 20);
    expect(CLIENT_TEXT_MAX).toBe(4096);
    const seats = [{ id: 0, name: 'Jordan', team: 'red', ready: false, away: false }];
    const welcome = (digs: WireDig[]) => JSON.stringify({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'lobby', match: null, now: 5, log: { shells: [[1, 9000, 120_500, 2_000, 2_750, 77]], digs } });
    const scoop = (k: number): WireDig => [k % 8, 12_000 + k, ...MOST];
    const digs = Array.from({ length: 150 }, (_, k) => scoop(k));
    const text = welcome(digs);
    expect(JSON.stringify({ shells: [[1, 9000, 120_500, 2_000, 2_750, 77]], digs }).length).toBeGreaterThan(100_000);
    const parsed = parseRoom(text);
    expect(parsed).toMatchObject({ t: 'welcome', you: 0 });
    expect((parsed as Extract<typeof parsed, { t: 'welcome' }>).log).toEqual({ shells: [[1, 9000, 120_500, 2_000, 2_750, 77]], digs });
    // Past a mebibyte, not even the room's.
    const huge = welcome(Array.from({ length: 1600 }, (_, k) => scoop(k)));
    expect(huge.length).toBeGreaterThan(ROOM_TEXT_MAX);
    expect(parseRoom(huge)).toBeNull();
    // A player's name message: valid JSON, but 5,022 characters, past CLIENT_TEXT_MAX; at 4,022 it is heard.
    const long = JSON.stringify({ t: 'name', name: 'x'.repeat(5000) });
    expect(long).toHaveLength(5022);
    expect(parseClient(long)).toBeNull();
    const shorter = JSON.stringify({ t: 'name', name: 'x'.repeat(4000) });
    expect(shorter).toHaveLength(4022);
    expect(parseClient(shorter)).toEqual({ t: 'name', name: 'x'.repeat(NAME_MAX) });
  });

  it("gives a welcome without a log an empty one, and drops a log's malformed entries", () => {
    const seats = [{ id: 0, name: 'Jordan', team: 'red', ready: false, away: false }];
    const base = { t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'lobby', match: null, now: 5 };
    expect((parseRoom(JSON.stringify(base)) as { log?: unknown }).log).toEqual({ shells: [], digs: [] });
    const good = [2, 9000, 1000, 2000, 2500, 1];
    const parsed = parseRoom(JSON.stringify({ ...base, log: { shells: [good, [1, 2], 'x'], digs: [[0, 9500, 7], [9, 9600, 7], null] } }));
    expect((parsed as { log?: unknown }).log).toEqual({ shells: [good], digs: [[0, 9500, 7]] });
  });

  it('cleans names: no control or invisible characters, no runs of space, at most NAME_MAX', () => {
    expect(cleanName('  Jord   the\tGreat  ')).toBe('Jord the Great');
    expect(cleanName('a\u0000b\u202ec\u200bd')).toBe('abcd');
    expect(cleanName('x'.repeat(40))).toHaveLength(NAME_MAX);
    expect(cleanName('')).toBe('Soldier');
    expect(cleanName(7)).toBe('Soldier');
  });

  it("keeps a config's fields only when they are in range", () => {
    expect(cleanConfig({ map: 'corridor', killTarget: 25.4, timeOfDay: 22, lapse: 1, intensity: 'heavy', respawnS: 3 })).toEqual({ map: 'corridor', killTarget: 25, timeOfDay: 22, lapse: 1, intensity: 'heavy', respawnS: 3 });
    expect(cleanConfig({ map: 'moon', killTarget: 0, timeOfDay: 25, lapse: -1, intensity: 'nuclear', respawnS: 999 })).toEqual({});
    expect(cleanConfig('no')).toEqual({});
  });
});
