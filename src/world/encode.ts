/**
 * Bricks as the GPU stores them, and the CPU-side bookkeeping for that heap.
 *
 * A dense brick becomes a record: a 16-byte local palette, a 64-byte occupancy
 * mask (one bit per voxel), then each solid voxel's local palette index at the
 * fewest bits that hold the brick's distinct materials — 0, 1, 2 or 4 — or the
 * global palette id at 8 bits when there are more than 16. Air is never stored:
 * the mask says it. A surface brick of air, sod and mud is 208 bytes, not 512,
 * and shadow rays only ever read the mask.
 *
 * `HeapMirror` decides where every record lives and what the GPU's brick table
 * says, and hands each change over as an edit; the renderer uploads edits and
 * knows nothing else.
 */

import { BrickMap, UNIFORM } from './bricks';

export const FORMAT_BITS = [0, 1, 2, 4, 8] as const;
/** Record size per format, in 16-byte units: 1 palette + 4 mask + data. */
export const RECORD_UNITS = [5, 9, 13, 21, 37] as const;

const PALETTE_WORDS = 4;
const MASK_WORDS = 16;
const DATA_START = PALETTE_WORDS + MASK_WORDS;
const OFFSET_MASK = 0x0fffffff;

export function formatOfLength(words: number): number {
  const format = RECORD_UNITS.findIndex((units) => units * 4 === words);
  if (format < 0) throw new RangeError(`${words} words is not a brick record length`);
  return format;
}

export function encodeBrick(raw: Uint8Array): Uint32Array {
  const local = new Int16Array(256).fill(-1);
  const order: number[] = [];
  for (let i = 0; i < 512; i++) {
    const p = raw[i];
    if (p !== 0 && local[p] < 0) {
      local[p] = order.length;
      order.push(p);
    }
  }
  const k = order.length;
  const format = k <= 1 ? 0 : k === 2 ? 1 : k <= 4 ? 2 : k <= 16 ? 3 : 4;
  const rec = new Uint32Array(RECORD_UNITS[format] * 4);
  if (format < 4) for (let j = 0; j < k; j++) rec[j >> 2] |= order[j] << ((j & 3) * 8);
  for (let i = 0; i < 512; i++) if (raw[i] !== 0) rec[PALETTE_WORDS + (i >> 5)] |= 1 << (i & 31);
  if (format === 4) {
    for (let i = 0; i < 512; i++) rec[DATA_START + (i >> 2)] |= raw[i] << ((i & 3) * 8);
  } else if (format > 0) {
    const bits = FORMAT_BITS[format];
    for (let i = 0; i < 512; i++) {
      const p = raw[i];
      if (p === 0) continue;
      const bit = i * bits;
      rec[DATA_START + (bit >> 5)] |= local[p] << (bit & 31);
    }
  }
  return rec;
}

export function decodeBrick(record: Uint32Array, out: Uint8Array): void {
  const format = formatOfLength(record.length);
  const bits = FORMAT_BITS[format];
  const mask = (1 << bits) - 1;
  for (let i = 0; i < 512; i++) {
    if (((record[PALETTE_WORDS + (i >> 5)] >>> (i & 31)) & 1) === 0) {
      out[i] = 0;
    } else if (format === 4) {
      out[i] = (record[DATA_START + (i >> 2)] >>> ((i & 3) * 8)) & 0xff;
    } else {
      const bit = i * bits;
      const li = bits === 0 ? 0 : (record[DATA_START + (bit >> 5)] >>> (bit & 31)) & mask;
      out[i] = (record[li >> 2] >>> ((li & 3) * 8)) & 0xff;
    }
  }
}

/** GPU table entry for a record; unit 0 is reserved so a record entry is never 0 (empty). */
export function tableEntry(format: number, unit: number): number {
  if (!Number.isInteger(unit) || unit < 1 || unit > OFFSET_MASK) {
    throw new RangeError(`record unit ${unit} is outside 1..${OFFSET_MASK}`);
  }
  return ((format << 28) | unit) >>> 0;
}

/**
 * One brick's change for the GPU: its new table entry and, for a dense brick,
 * the record at `unit`. `retire` is the dense entry it replaces (0 if none):
 * the GPU table may still point at that record until this edit is uploaded,
 * so its units are only reused after `release(retire)`.
 */
export interface BrickEdit {
  brick: number;
  entry: number;
  unit: number;
  words: Uint32Array | null;
  retire: number;
}

/** A band's dense bricks as generation workers encode them (see `BandResult`). */
export interface EncodedBand {
  band: number;
  denseBricks: Uint32Array;
  records: Uint32Array;
  formats: Uint8Array;
}

const isRecord = (e: number) => e !== 0 && !(e & UNIFORM);

export class HeapMirror {
  readonly gpuTable: Uint32Array;
  private readonly map: BrickMap;
  private heap: Uint32Array;
  private used = 1;
  private readonly freeLists: number[][] = FORMAT_BITS.map(() => []);
  private edits: BrickEdit[] = [];

  private constructor(map: BrickMap, capacityWords = 1024 * 4) {
    this.map = map;
    this.gpuTable = new Uint32Array(map.table.length);
    this.heap = new Uint32Array(capacityWords);
  }

  /** Encode every dense brick into one contiguous image, in table order, from unit 1. */
  static fromMap(map: BrickMap): HeapMirror {
    const mirror = new HeapMirror(map);
    for (let bi = 0; bi < map.table.length; bi++) {
      const e = map.table[bi];
      if (!isRecord(e)) {
        mirror.gpuTable[bi] = e;
        continue;
      }
      const rec = encodeBrick(map.denseView(bi)!);
      const format = formatOfLength(rec.length);
      const unit = mirror.bump(RECORD_UNITS[format]);
      mirror.heap.set(rec, unit * 4);
      mirror.gpuTable[bi] = tableEntry(format, unit);
    }
    return mirror;
  }

  /**
   * The same mirror from records the bands already encoded, each band's copied
   * whole, in band order. `map` must be exactly the assembly of `bands`.
   */
  static fromBands(map: BrickMap, bands: readonly EncodedBand[], bandBricks = 4): HeapMirror {
    let words = 0;
    for (const b of bands) words += b.records.length;
    const mirror = new HeapMirror(map, Math.ceil((4 + words) * 1.25 / 4) * 4);
    for (let bi = 0; bi < map.table.length; bi++) {
      const e = map.table[bi];
      if (!isRecord(e)) mirror.gpuTable[bi] = e;
    }
    const by = map.bricks.y;
    for (const b of bands) {
      let unit = mirror.used;
      mirror.heap.set(b.records, unit * 4);
      for (let k = 0; k < b.denseBricks.length; k++) {
        const li = b.denseBricks[k];
        const lx = li % bandBricks;
        const rest = (li - lx) / bandBricks;
        const ly = rest % by;
        const lz = (rest - ly) / by;
        const bi = map.brickIndex(b.band * bandBricks + lx, ly, lz);
        if (!isRecord(map.table[bi])) throw new Error(`band ${b.band}: brick ${li} is not dense in the map`);
        const format = b.formats[k];
        mirror.gpuTable[bi] = tableEntry(format, unit);
        unit += RECORD_UNITS[format];
      }
      if ((unit - mirror.used) * 4 !== b.records.length) throw new Error(`band ${b.band}: records do not match its formats`);
      mirror.used = unit;
    }
    return mirror;
  }

  get usedUnits(): number {
    return this.used;
  }

  get capacityUnits(): number {
    return this.heap.length / 4;
  }

  /** Everything allocated so far, from unit 0, as a copy. */
  heapImage(): Uint32Array {
    return this.heap.slice(0, this.used * 4);
  }

  /** Everything allocated so far, from unit 0, without copying. Valid until the next update. */
  heapView(): Uint32Array {
    return this.heap.subarray(0, this.used * 4);
  }

  /**
   * Re-encode these bricks from the map. A brick whose record comes out
   * unchanged makes no edit; otherwise the new record takes a released unit of
   * its size if there is one.
   */
  update(bricks: readonly number[]): void {
    for (const bi of bricks) {
      if (!Number.isInteger(bi) || bi < 0 || bi >= this.gpuTable.length) {
        throw new RangeError(`brick index ${bi} is outside 0..${this.gpuTable.length - 1}`);
      }
      const old = this.gpuTable[bi];
      const e = this.map.table[bi];
      if (!isRecord(e)) {
        if (e === old) continue;
        this.gpuTable[bi] = e;
        this.edits.push({ brick: bi, entry: e, unit: 0, words: null, retire: isRecord(old) ? old : 0 });
        continue;
      }
      const rec = encodeBrick(this.map.denseView(bi)!);
      const format = formatOfLength(rec.length);
      if (isRecord(old) && old >>> 28 === format && this.sameRecord(old, rec)) continue;
      const unit = this.freeLists[format].pop() ?? this.bump(RECORD_UNITS[format]);
      this.heap.set(rec, unit * 4);
      const entry = tableEntry(format, unit);
      this.gpuTable[bi] = entry;
      this.edits.push({ brick: bi, entry, unit, words: rec, retire: isRecord(old) ? old : 0 });
    }
  }

  takeEdits(): BrickEdit[] {
    const out = this.edits;
    this.edits = [];
    return out;
  }

  /** Make a retired record's units reusable: the GPU no longer points at it. */
  release(entry: number): void {
    if (isRecord(entry)) this.freeLists[entry >>> 28].push(entry & OFFSET_MASK);
  }

  private sameRecord(entry: number, rec: Uint32Array): boolean {
    const at = (entry & OFFSET_MASK) * 4;
    for (let i = 0; i < rec.length; i++) if (this.heap[at + i] !== rec[i]) return false;
    return true;
  }

  private bump(units: number): number {
    const unit = this.used;
    this.used += units;
    if (this.used * 4 > this.heap.length) {
      let words = Math.max(Math.ceil(this.heap.length * 0.375) * 4, 1024 * 4);
      while (words < this.used * 4) words = Math.ceil(words * 0.375) * 4;
      const grown = new Uint32Array(words);
      grown.set(this.heap);
      this.heap = grown;
    }
    return unit;
  }
}
