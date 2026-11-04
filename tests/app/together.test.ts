import { describe, expect, it } from 'vitest';
import { Gaits, mapAction, relayUrl, type Figure } from '../../src/app/together';
import { holdOf } from '../../src/combat/arsenal';
import { pose, type PoseInput, type V3 } from '../../src/combat/soldier-rig';
import { decodeGear } from '../../src/net/gear';
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

  it("a figure's flinch and fall go into its pose, which is drawn and struck; the caller sets them each frame", () => {
    const still: Figure = { seat: 3, team: 'blue', position: [12.8, 0.4, 30], velocity: [0, 0, 0], yaw: 180, pitch: 0, height: 1.8, deadFor: null };
    // Standing still, the stride stays at its start: the pose is the rig's from the figure alone.
    const posed = (f: Figure, over: Partial<PoseInput> = {}) => pose({ position: f.position, yaw: f.yaw, pitch: f.pitch, height: f.height, speed: 0, bob: 0, deadFor: f.deadFor, hold: holdOf(decodeGear(0)), ...over });
    const flinch = { dir: [0, 0, 1] as V3, age: 0.05, head: true };
    const gaits = new Gaits();
    const [struck] = gaits.pose([{ ...still, flinch }], 1 / 60);
    expect(struck.frames).toEqual(posed(still, { flinch }));
    expect(struck.frames).not.toEqual(posed(still));
    // The next frame without one, it stands as it did: Gaits keeps none of it.
    expect(gaits.pose([still], 1 / 60)[0].frames).toEqual(posed(still));
    // Killed: it falls toward its fallYaw, in its fallS.
    const killed: Figure = { ...still, deadFor: 0.3, fallYaw: 90, fallS: 0.3 };
    const [fallen] = gaits.pose([killed], 1 / 60);
    expect(fallen.frames).toEqual(posed(killed, { fallYaw: 90, fallS: 0.3 }));
    expect(fallen.frames).not.toEqual(posed(killed));
  });
});
