// Types for image.mjs (the capture tools' measures over displayed screenshots), for the tests that read it.

/** A decoded image: RGBA bytes, displayed luminance per pixel, its size. */
export interface Image {
  data: Uint8Array;
  lum: Float32Array;
  w: number;
  h: number;
}

/** Frames as the eye holds them: each pixel as its frame most unlike its background; the background's luminance (`least`) and colour (`back`, RGB a pixel), its least over the frames no tracer is drawn near it; with frames skipped at pixels, whether any frame was read there (`open`, 1 a pixel; null with none skipped). */
export interface Composite extends Image {
  least: Float32Array;
  back: Uint8Array;
  open?: Uint8Array | null;
}

export interface Ring {
  mean: number | null;
  meanV: number | null;
  meanRGB: [number, number, number] | null;
  n: number;
  dropped: number;
}

export interface Hsv {
  hue: number;
  saturation: number;
  chroma: number;
}

export interface LitPixel {
  at: [number, number];
  rgb: [number, number, number];
}

export interface LitRule {
  ratio: number;
  min: number;
}

export function luminance(r: number, g: number, b: number): number;
export function decode(buffer: Uint8Array): Image;
export function encode(data: Uint8Array, w: number, h: number): Buffer;
export function composite(imgs: readonly Image[], near?: readonly Uint8Array[] | null, skip?: readonly Uint8Array[] | null): Composite;
export function at(img: { w: number; h: number }, q: readonly number[]): number;
export function ringMean(img: Image, cx: number, cy: number, radii: readonly [number, number] | readonly number[], drop?: (x: number, y: number, lum: number) => boolean): Ring;
export function brightest(img: Image, cx: number, cy: number, r: number): number;
export function topChannel(img: Image, cx: number, cy: number, r: number, prefer?: number): { value: number; channel: number };
export function hsv(rgb: readonly number[]): Hsv;
export function hueOff(a: number, b: number): number;
export function colourOf(pixels: readonly { rgb: readonly number[] }[]): { saturation: number | null; hueDeg: number | null; n: number };
export function lit(v: number, bg: number, rule: LitRule): boolean;
export function litNear(img: Image, comp: Composite, q: readonly number[], r: number, taken: Set<number>, out: LitPixel[], rule: LitRule): void;
export function percentile(values: ArrayLike<number> & Iterable<number>, share: number): number | null;
export function median(values: ArrayLike<number> & Iterable<number>): number | null;
export function p95(values: ArrayLike<number> & Iterable<number>): number | null;
export function round3(x: number | null | undefined): number | null;
