import { describe, expect, it } from 'vitest';
import { Gaits, mapAction, relayUrl, shotTracer, type Figure } from '../../src/app/together';
import { TRACER_KIND } from '../../src/net/gear';
import type { Seat } from '../../src/net/protocol';
import { P } from '../../src/world/materials';

describe('where the relay is', () => {
  const q = (s: string) => new URLSearchParams(s);
  it("is the build's own, the local one on localhost, or none", () => {
    expect(relayUrl(q(''), 'lordjord78.github.io', false, 'https://relay.example.dev/')).toBe('https://relay.example.dev');
    expect(relayUrl(q(''), 'localhost', true, undefined)).toBe('http://127.0.0.1:8787');
    expect(relayUrl(q(''), 'lordjord78.github.io', false, undefined)).toBeNull();
  });
  it('takes ?relay= only on a development build or localhost, and only a bare origin', () => {
    expect(relayUrl(q('relay=http://127.0.0.1:9000'), 'localhost', false, 'https://r.dev')).toBe('http://127.0.0.1:9000');
    expect(relayUrl(q('relay=https://evil.example'), 'lordjord78.github.io', false, 'https://r.dev')).toBe('https://r.dev');
    expect(relayUrl(q('relay=javascript:alert(1)'), 'localhost', true, undefined)).toBe('http://127.0.0.1:8787');
  });
});

describe('which map a room is played on', () => {
  it('stays on its map, claims a room it just made for it, or goes to the room’s', () => {
    expect(mapAction('corridor', 'corridor', false, false)).toBe('stay');
    expect(mapAction('corridor', 'ravine', true, true)).toBe('claim');
    // A friend, or the owner of a room someone else set: to the room's map.
    expect(mapAction('ravine', 'corridor', false, false)).toBe('switch');
    expect(mapAction('ravine', 'corridor', false, true)).toBe('switch');
    expect(mapAction('ravine', 'corridor', true, false)).toBe('switch');
    // A map this build does not know is not gone to.
    expect(mapAction('ravine', 'atlantis', false, false)).toBe('stay');
  });
});

describe('figures posed as soldiers', () => {
  it("a figure's own tape goes to its soldier; without one, the soldier wears its team's", () => {
    const figure = (seat: number, tape?: number): Figure => ({
      seat, team: 'blue', position: [12.8, 0.4, 30], velocity: [0, 0, 0], yaw: 180, pitch: 0, height: 1.8, deadFor: null,
      ...(tape === undefined ? {} : { tape }),
    });
    const [dummy, soldier] = new Gaits().pose([figure(200, P.TAPE_RANGE), figure(3)], 1 / 60);
    expect(dummy.tape).toBe(P.TAPE_RANGE);
    expect(dummy.team).toBe('blue');
    expect(soldier).not.toHaveProperty('tape');
  });
});

describe("the colour another player's shot is drawn in", () => {
  const seat = (id: number, team: 'red' | 'blue', away = false): Seat => ({ id, name: `p${id}`, team, ready: true, away });
  const drawn = (id: number, team: 'red' | 'blue') => ({ seat: id, team });

  it("is their seat's team's, from their soldier as drawn or, with none drawn, from the room's seats", () => {
    const seats = [seat(0, 'red'), seat(1, 'blue'), seat(2, 'red', true)];
    expect(shotTracer(1, [drawn(1, 'blue')], seats)).toBe(TRACER_KIND.blue);
    // Away (the room still relays their shots), not yet in the states, or with nothing buffered: no
    // soldier drawn, and their seat says their team.
    expect(shotTracer(1, [], seats)).toBe(TRACER_KIND.blue);
    expect(shotTracer(2, [drawn(1, 'blue')], seats)).toBe(TRACER_KIND.red);
    // Seated nowhere the room has said: none given, and the shot's own word says.
    expect(shotTracer(5, [drawn(1, 'blue')], seats)).toBeUndefined();
  });
});
