import { afterEach, describe, expect, it } from 'vitest';
import type { BandResult } from '../../src/world/generation/fill';

/** A stand-in for a generation worker: empty bands, and a far field that fails. */
class StubWorker {
  static all: StubWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = false;

  constructor() {
    StubWorker.all.push(this);
  }

  postMessage(message: { type: string; id: number; band: number }): void {
    if (message.type === 'plan') return;
    setTimeout(() => {
      if (message.type === 'band') {
        const result: BandResult = {
          band: message.band,
          table: new Uint32Array(4 * 40 * 320),
          dense: new Uint8Array(0),
          denseBricks: new Uint32Array(0),
        } as BandResult;
        this.onmessage?.({ data: { type: 'band', id: message.id, result } });
      } else {
        this.onerror?.({ message: 'far field failed' });
      }
    }, 0);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (type === 'error') this.onerror = fn as (event: { message: string }) => void;
    if (type === 'messageerror') this.onmessageerror = fn;
  }

  terminate(): void {
    this.terminated = true;
  }
}

const realWorker = (globalThis as { Worker?: unknown }).Worker;
afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
  StubWorker.all = [];
});

describe('generating in workers', () => {
  it('fails, and lets its workers go, when a far-field job fails', async () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    const { generateInWorkers } = await import('../../src/app/generate-in-workers');
    const outcome = await Promise.race([
      generateInWorkers(7).then(
        () => 'resolved',
        (error: unknown) => `rejected: ${String(error)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting after 20 s'), 20_000)),
    ]);
    expect(outcome).toMatch(/^rejected: .*far field failed/);
    expect(StubWorker.all.length).toBeGreaterThan(0);
    expect(StubWorker.all.every((w) => w.terminated)).toBe(true);
  }, 60_000);
});
