import { describe, expect, it } from 'vitest';
import { cleanConfig, cleanName, decodeState, encodeState, NAME_MAX, parseClient, parseRoom, type PlayerState } from '../../src/net/protocol';

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
    expect(parseClient(JSON.stringify({ t: 's', s: encodeState(state) }))).toEqual({ t: 's', s: encodeState(state) });
    expect(parseRoom(JSON.stringify({ t: 'roster', owner: 0, seats: [{ id: 9, name: 'x', team: 'red' }] }))).toBeNull();
    expect(parseRoom(JSON.stringify({ t: 'f', s: 5, ps: [[1, ...encodeState(state)], [2, 1, 2], 'x'] }))).toEqual({ t: 'f', s: 5, ps: [[1, ...encodeState(state)]] });
  });

  it('cleans names: no control or invisible characters, no runs of space, at most NAME_MAX', () => {
    expect(cleanName('  Jord   the\tGreat  ')).toBe('Jord the Great');
    expect(cleanName('a\u0000b‮c​d')).toBe('abcd');
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
