import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { defaultSettings, loadSettings, saveSettings, type Settings } from '../../src/ui/settings';

const defaults = defaultSettings(loadTunables());

/** A storage holding one raw value. */
const holding = (raw: string | null) => ({ getItem: () => raw });

describe('settings', () => {
  it('default to the high preset, the tunables sensitivity and a 90° view', () => {
    expect(defaults).toEqual({ preset: 'high', sensitivity: 0.14, fov: 90 });
    expect(loadSettings(null, defaults)).toEqual(defaults);
    expect(loadSettings(holding(null), defaults)).toEqual(defaults);
  });
  it('fall back to the defaults for anything unreadable', () => {
    expect(loadSettings(holding('{not json'), defaults)).toEqual(defaults);
    expect(loadSettings(holding('7'), defaults)).toEqual(defaults);
    expect(loadSettings(holding('{"preset":"ultra","fov":"wide"}'), defaults)).toEqual(defaults);
    const throwing = { getItem: (): string | null => { throw new Error('SecurityError'); } };
    expect(loadSettings(throwing, defaults)).toEqual(defaults);
  });
  it('clamp values from outside their range', () => {
    expect(loadSettings(holding('{"preset":"low","sensitivity":5,"fov":10}'), defaults)).toEqual({ preset: 'low', sensitivity: 0.6, fov: 60 });
    expect(loadSettings(holding('{"sensitivity":0,"fov":400}'), defaults)).toEqual({ preset: 'high', sensitivity: 0.02, fov: 110 });
  });
  it('come back as they were saved, and a full or blocked storage loses only the save', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const mine: Settings = { preset: 'low', sensitivity: 0.3, fov: 75 };
    saveSettings(storage, mine);
    expect(loadSettings(storage, defaults)).toEqual(mine);
    const full = { setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => saveSettings(full, mine)).not.toThrow();
  });
});
