import { describe, expect, it } from 'vitest';
import { CLIENT_TEXT_MAX, cleanConfig, cleanName, decodeDig, decodeShell, decodeShot, decodeState, defaultConfig, DIG_CELLS_MAX, encodeShot, encodeState, HURT_MAX, NAME_MAX, parseClient, parseRoom, PROTOCOL, ROOM_TEXT_MAX, SHOTS_MAX, type PlayerState, type WireDig } from '../../src/net/protocol';

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

  it('carries shells and digs as integers, and believes no malformed one', () => {
    expect(PROTOCOL).toBe(2);
    expect(DIG_CELLS_MAX).toBe(64);
    // A player's scoop: 1–64 packed cells, each an integer in [0, 2^31).
    const most = Array.from({ length: DIG_CELLS_MAX }, (_, i) => 2147483647 - i);
    expect(parseClient(JSON.stringify({ t: 'dig', c: [0, 5, 2147483647] }))).toEqual({ t: 'dig', c: [0, 5, 2147483647] });
    expect(parseClient(JSON.stringify({ t: 'dig', c: most }))).toEqual({ t: 'dig', c: most });
    for (const c of [[], Array(DIG_CELLS_MAX + 1).fill(1), [1.5], [-1], [2147483648], [1, null], ['1'], 'x', 7, null]) {
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
    for (const bad of [[8, 12_000, 1], [-1, 12_000, 1], [0.5, 12_000, 1], [0, 12_000], [0, 12_000, 1.5], [0, 12_000, -1], [0, 12_000, 2147483648], [0, 1.5, 1], [0, 12_000, ...most, 1], 'x', null]) {
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

  it("takes a room's message up to a mebibyte, a player's still not past 4,096 characters", () => {
    expect(ROOM_TEXT_MAX).toBe(1 << 20);
    expect(CLIENT_TEXT_MAX).toBe(4096);
    const seats = [{ id: 0, name: 'Jordan', team: 'red', ready: false, away: false }];
    const welcome = (digs: WireDig[]) => JSON.stringify({ t: 'welcome', you: 0, room: 'ABCDE', owner: 0, seats, config: defaultConfig(), phase: 'lobby', match: null, now: 5, log: { shells: [[1, 9000, 120_500, 2_000, 2_750, 77]], digs } });
    const scoop = (k: number): WireDig => [k % 8, 12_000 + k, ...Array.from({ length: DIG_CELLS_MAX }, (_, i) => 2147483647 - i)];
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
