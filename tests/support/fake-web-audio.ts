import { vi } from 'vitest';

/**
 * A WebAudio stand-in for Node, enough for audio/voices.ts's playVoice and audio/engine.ts's
 * AudioEngine.start(): every node made is recorded, with its options and every AudioParam call, and an
 * AudioParam refuses what a browser's refuses (exponentialRampToValueAtTime to 0 throws a RangeError,
 * as the WebAudio spec says), so a voice that would stop the game in a browser throws here too.
 * install() stubs the globals; vi.unstubAllGlobals() puts them back.
 */

/** An AudioParam's call: its method's name, the value and the time. */
export type ParamCall = [method: string, value: number, time: number];

export class FakeParam {
  readonly calls: ParamCall[] = [];
  constructor(public value = 0) {}
  setValueAtTime(value: number, time: number): this {
    this.calls.push(['set', value, time]);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.calls.push(['linear', value, time]);
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    // The spec: "If value is equal to 0, throw a RangeError" (a browser does).
    if (value === 0 || !Number.isFinite(value)) throw new RangeError(`exponentialRampToValueAtTime: the value ${value} must be finite and not 0`);
    this.calls.push(['exponential', value, time]);
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.calls.push(['cancel', 0, time]);
    return this;
  }
}

/** Every node made since install(), in order. */
export const made: FakeNode[] = [];

export class FakeNode {
  readonly outs: unknown[] = [];
  readonly options: Record<string, unknown>;
  /** The options object itself, as given (a hoisted constant is the same object each time). */
  readonly given: unknown;
  constructor(_ctx: unknown, options: Record<string, unknown> = {}) {
    this.options = { ...options };
    this.given = options;
    made.push(this);
  }
  connect<T>(to: T): T {
    this.outs.push(to);
    return to;
  }
  disconnect(): void {}
}

export class Gain extends FakeNode {
  readonly gain: FakeParam;
  constructor(ctx: unknown, options: { gain?: number } = {}) {
    super(ctx, options);
    this.gain = new FakeParam(options.gain ?? 1);
  }
}

export class Biquad extends FakeNode {
  readonly type: string;
  readonly frequency: FakeParam;
  constructor(ctx: unknown, options: { type?: string; frequency?: number } = {}) {
    super(ctx, options);
    this.type = options.type ?? 'lowpass';
    this.frequency = new FakeParam(options.frequency ?? 350);
  }
}

export class Source extends FakeNode {
  readonly started: number[][] = [];
  start(...at: number[]): void {
    this.started.push(at);
  }
  stop(): void {}
}

export class Oscillator extends Source {
  readonly type: string;
  readonly frequency: FakeParam;
  constructor(ctx: unknown, options: { type?: string; frequency?: number } = {}) {
    super(ctx, options);
    this.type = options.type ?? 'sine';
    this.frequency = new FakeParam(options.frequency ?? 440);
  }
}

export class BufferSource extends Source {}
class Panner extends FakeNode {}
class Convolver extends FakeNode {}
class Compressor extends FakeNode {}
class Wave {
  constructor(_ctx: unknown, _options?: unknown) {}
}

/** A buffer: `channels` of `length` samples; a length of 0 is refused, as a browser's createBuffer refuses it. */
export function fakeBuffer(channels: number, length: number, rate: number) {
  if (!(length > 0)) throw new DOMException(`createBuffer: the length ${length} must be over 0`, 'NotSupportedError');
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: (k: number) => data[k], copyToChannel: (from: Float32Array, k: number) => data[k].set(from) };
}

/** A context: its rate, its clock, a destination, and createBuffer; running from the start. */
export class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new FakeNode(null);
  readonly listener = {};
  constructor(_options?: unknown) {}
  createBuffer(channels: number, length: number, rate: number) {
    return fakeBuffer(channels, length, rate);
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Stub WebAudio's globals with the stand-ins, and forget the nodes made before. */
export function install(): void {
  made.length = 0;
  vi.stubGlobal('GainNode', Gain);
  vi.stubGlobal('BiquadFilterNode', Biquad);
  vi.stubGlobal('OscillatorNode', Oscillator);
  vi.stubGlobal('AudioBufferSourceNode', BufferSource);
  vi.stubGlobal('PannerNode', Panner);
  vi.stubGlobal('ConvolverNode', Convolver);
  vi.stubGlobal('DynamicsCompressorNode', Compressor);
  vi.stubGlobal('PeriodicWave', Wave);
  vi.stubGlobal('AudioContext', FakeContext);
}

/** The nodes made of a kind (a stand-in's class: 'Gain', 'Biquad', 'Oscillator', 'BufferSource', 'Convolver' …). */
export function madeOf(kind: string): FakeNode[] {
  return made.filter((n) => n.constructor.name === kind);
}
