/**
 * Read-only dotted-key view over data/tunables.toml, the single home for every
 * feel and structure number. Logic reads values by key and never hard-codes a
 * magnitude. Same accessors as the Python game's `Tunables`, stricter about
 * types: `i()` refuses a float rather than truncating it.
 */

import raw from '../../data/tunables.toml';

export class Tunables {
  private readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
  }

  get(key: string): unknown {
    let node: unknown = this.raw;
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object' || Array.isArray(node) || !(part in node)) {
        throw new Error(`tunable '${key}' not found (missing '${part}')`);
      }
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  }

  has(key: string): boolean {
    try {
      this.get(key);
      return true;
    } catch {
      return false;
    }
  }

  f(key: string): number {
    const value = this.get(key);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`tunable '${key}' is not a finite number: ${String(value)}`);
    }
    return value;
  }

  i(key: string): number {
    const value = this.f(key);
    if (!Number.isInteger(value)) throw new TypeError(`tunable '${key}' is not an integer: ${value}`);
    return value;
  }

  section(key: string): Record<string, unknown> {
    const value = this.get(key);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`tunable '${key}' is not a section`);
    }
    return { ...(value as Record<string, unknown>) };
  }

  sections(key: string): string[] {
    return Object.keys(this.section(key)).sort();
  }
}

let loaded: Tunables | undefined;

/** The game's tunables, compiled into the bundle from data/tunables.toml. */
export function loadTunables(): Tunables {
  loaded ??= new Tunables(raw);
  return loaded;
}
