import { describe, expect, it } from 'vitest';
import { mapAction, relayUrl } from '../../src/app/together';

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
