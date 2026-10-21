/**
 * The world as a sparse brick map.
 *
 * Voxels are grouped into 8³ bricks. Each brick has one 32-bit table entry:
 * `0` empty, `UNIFORM | id` when every voxel holds the same palette id, or
 * `slot + 1` for a dense brick of 512 raw bytes in the pool. Most of a trench
 * map is open sky or solid subsoil, so most bricks cost four bytes; only the
 * ones the surface and the props pass through cost 512.
 *
 * Every write marks its brick dirty. `takeDirty()` compacts those bricks — a
 * brick that is uniform again stops costing a slot — and hands the list to
 * whoever mirrors the world elsewhere (the GPU heap, a worker).
 *
 * Bricks group again into 32³-voxel sectors; each sector counts its non-empty
 * bricks so the tracer can skip empty space 3.2 m at a time.
 */

export const BRICK = 8;
export const SECTOR = 32;
export const UNIFORM = 0x80000000;

const CHUNK_SHIFT = 13;
const CHUNK_BRICKS = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_BRICKS - 1;

export interface Dims {
  x: number;
  y: number;
  z: number;
}

function checkId(p: number): void {
  if ((p & 255) !== p) throw new RangeError(`palette id must be an integer in 0..255, got ${p}`);
}

export class BrickMap {
  readonly dims: Dims;
  readonly bricks: Dims;
  readonly sectors: Dims;
  readonly table: Uint32Array;
  private readonly chunks: Uint8Array[] = [];
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  private dense = 0;
  private readonly dirtyFlag: Uint8Array;
  private dirtyList: number[] = [];
  private readonly sectorCounts: Uint16Array;

  constructor(dims: Dims) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const n = dims[axis];
      if (!Number.isInteger(n) || n <= 0 || n % SECTOR !== 0) {
        throw new RangeError(`world ${axis} is ${n} voxels; it must be a positive multiple of ${SECTOR}`);
      }
    }
    this.dims = { x: dims.x, y: dims.y, z: dims.z };
    this.bricks = { x: dims.x / BRICK, y: dims.y / BRICK, z: dims.z / BRICK };
    this.sectors = { x: dims.x / SECTOR, y: dims.y / SECTOR, z: dims.z / SECTOR };
    const count = this.bricks.x * this.bricks.y * this.bricks.z;
    this.table = new Uint32Array(count);
    this.dirtyFlag = new Uint8Array(count);
    this.sectorCounts = new Uint16Array(this.sectors.x * this.sectors.y * this.sectors.z);
  }

  get denseCount(): number {
    return this.dense;
  }

  /** Pool capacity in slots: whole 8192-slot chunks allocated so far. */
  get poolCapacity(): number {
    return this.chunks.length * CHUNK_BRICKS;
  }

  /** Distinct dense slots ever handed out; stays flat while freed slots are being reused. */
  get slotsIssued(): number {
    return this.nextSlot;
  }

  /** Throw unless `bi` names a brick in this map: a bad index must fail where it was made. */
  private checkBrick(bi: number): void {
    if (!Number.isInteger(bi) || bi < 0 || bi >= this.table.length) {
      throw new RangeError(`brick index ${bi} is outside 0..${this.table.length - 1}`);
    }
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.dims.x && y < this.dims.y && z < this.dims.z;
  }

  brickIndex(bx: number, by: number, bz: number): number {
    return (bz * this.bricks.y + by) * this.bricks.x + bx;
  }

  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.dims.x || y >= this.dims.y || z >= this.dims.z) return 0;
    const e = this.table[((z >> 3) * this.bricks.y + (y >> 3)) * this.bricks.x + (x >> 3)];
    if (e === 0) return 0;
    if (e & UNIFORM) return e & 0xff;
    const slot = e - 1;
    return this.chunks[slot >> CHUNK_SHIFT][((slot & CHUNK_MASK) << 9) + (x & 7) + ((y & 7) << 3) + ((z & 7) << 6)];
  }

  set(x: number, y: number, z: number, p: number): void {
    checkId(p);
    if (x < 0 || y < 0 || z < 0 || x >= this.dims.x || y >= this.dims.y || z >= this.dims.z) return;
    const bi = ((z >> 3) * this.bricks.y + (y >> 3)) * this.bricks.x + (x >> 3);
    let e = this.table[bi];
    if (e === 0 || e & UNIFORM) {
      const fill = e === 0 ? 0 : e & 0xff;
      if (fill === p) return;
      const slot = this.alloc();
      const base = (slot & CHUNK_MASK) << 9;
      this.chunks[slot >> CHUNK_SHIFT].fill(fill, base, base + 512);
      e = slot + 1;
      this.setEntry(bi, e);
    }
    const slot = e - 1;
    const chunk = this.chunks[slot >> CHUNK_SHIFT];
    const i = ((slot & CHUNK_MASK) << 9) + (x & 7) + ((y & 7) << 3) + ((z & 7) << 6);
    if (chunk[i] === p) return;
    chunk[i] = p;
    this.markDirty(bi);
  }

  /**
   * Fill the half-open box [x0, x1) × [y0, y1) × [z0, z1), clamped to the world.
   * Bricks wholly inside become uniform (or empty) without touching the pool;
   * only the bricks the box's faces cut through are written voxel by voxel.
   */
  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, p: number): void {
    checkId(p);
    const ax = Math.max(0, Math.floor(x0));
    const ay = Math.max(0, Math.floor(y0));
    const az = Math.max(0, Math.floor(z0));
    const bx = Math.min(this.dims.x, Math.ceil(x1));
    const by = Math.min(this.dims.y, Math.ceil(y1));
    const bz = Math.min(this.dims.z, Math.ceil(z1));
    if (ax >= bx || ay >= by || az >= bz) return;
    for (let kz = az >> 3; kz <= (bz - 1) >> 3; kz++) {
      const z0b = Math.max(az, kz << 3);
      const z1b = Math.min(bz, (kz << 3) + BRICK);
      for (let ky = ay >> 3; ky <= (by - 1) >> 3; ky++) {
        const y0b = Math.max(ay, ky << 3);
        const y1b = Math.min(by, (ky << 3) + BRICK);
        for (let kx = ax >> 3; kx <= (bx - 1) >> 3; kx++) {
          const x0b = Math.max(ax, kx << 3);
          const x1b = Math.min(bx, (kx << 3) + BRICK);
          if (x1b - x0b === BRICK && y1b - y0b === BRICK && z1b - z0b === BRICK) {
            this.setUniform(this.brickIndex(kx, ky, kz), p);
            continue;
          }
          for (let z = z0b; z < z1b; z++)
            for (let y = y0b; y < y1b; y++)
              for (let x = x0b; x < x1b; x++) this.set(x, y, z, p);
        }
      }
    }
  }

  /** The brick's 512 voxels into `out`, indexed `lx + ly*8 + lz*64`. */
  readBrick(bi: number, out: Uint8Array): void {
    this.checkBrick(bi);
    const e = this.table[bi];
    if (e === 0) out.fill(0, 0, 512);
    else if (e & UNIFORM) out.fill(e & 0xff, 0, 512);
    else {
      const slot = e - 1;
      const base = (slot & CHUNK_MASK) << 9;
      out.set(this.chunks[slot >> CHUNK_SHIFT].subarray(base, base + 512));
    }
  }

  /** Replace a whole brick; stored compacted. */
  writeBrick(bi: number, raw: Uint8Array): void {
    this.checkBrick(bi);
    if (raw.length < 512) throw new RangeError(`a brick is 512 voxels; got ${raw.length}`);
    let e = this.table[bi];
    if (e === 0 || e & UNIFORM) {
      e = this.alloc() + 1;
      this.setEntry(bi, e);
    }
    const slot = e - 1;
    this.chunks[slot >> CHUNK_SHIFT].set(raw.subarray(0, 512), (slot & CHUNK_MASK) << 9);
    this.markDirty(bi);
    this.compact(bi);
  }

  /** Make a whole brick one palette id (0 empties it), releasing any dense slot. */
  setUniform(bi: number, p: number): void {
    this.checkBrick(bi);
    checkId(p);
    const e = this.table[bi];
    const next = p === 0 ? 0 : (UNIFORM | p) >>> 0;
    if (e === next) return;
    if (e !== 0 && !(e & UNIFORM)) this.release(e - 1);
    this.setEntry(bi, next);
    this.markDirty(bi);
  }

  /** A live view of a dense brick's bytes, or null if the brick is empty or uniform. */
  denseView(bi: number): Uint8Array | null {
    this.checkBrick(bi);
    const e = this.table[bi];
    if (e === 0 || e & UNIFORM) return null;
    const slot = e - 1;
    const base = (slot & CHUNK_MASK) << 9;
    return this.chunks[slot >> CHUNK_SHIFT].subarray(base, base + 512);
  }

  /** Turn a dense brick whose voxels are all equal back into a uniform or empty one. */
  compact(bi: number): void {
    this.checkBrick(bi);
    const e = this.table[bi];
    if (e === 0 || e & UNIFORM) return;
    const slot = e - 1;
    const chunk = this.chunks[slot >> CHUNK_SHIFT];
    const base = (slot & CHUNK_MASK) << 9;
    const first = chunk[base];
    for (let i = 1; i < 512; i++) if (chunk[base + i] !== first) return;
    this.release(slot);
    this.setEntry(bi, first === 0 ? 0 : (UNIFORM | first) >>> 0);
  }

  /** Compact and return every brick written since the last call, ascending. */
  takeDirty(): number[] {
    const list = this.dirtyList;
    this.dirtyList = [];
    for (const bi of list) {
      this.dirtyFlag[bi] = 0;
      this.compact(bi);
    }
    return list.sort((a, b) => a - b);
  }

  sectorCount(si: number): number {
    return this.sectorCounts[si];
  }

  /** 1 for every sector holding a non-empty brick, laid out like the table. */
  sectorMask(): Uint32Array {
    return Uint32Array.from(this.sectorCounts, (n) => (n > 0 ? 1 : 0));
  }

  private markDirty(bi: number): void {
    if (this.dirtyFlag[bi]) return;
    this.dirtyFlag[bi] = 1;
    this.dirtyList.push(bi);
  }

  private setEntry(bi: number, e: number): void {
    const old = this.table[bi];
    if (old === e) return;
    if (old === 0) this.sectorCounts[this.sectorOf(bi)]++;
    else if (e === 0) this.sectorCounts[this.sectorOf(bi)]--;
    this.table[bi] = e;
  }

  private sectorOf(bi: number): number {
    const bx = bi % this.bricks.x;
    const rest = (bi - bx) / this.bricks.x;
    const by = rest % this.bricks.y;
    const bz = (rest - by) / this.bricks.y;
    return ((bz >> 2) * this.sectors.y + (by >> 2)) * this.sectors.x + (bx >> 2);
  }

  private alloc(): number {
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      slot = this.nextSlot++;
      if (slot >> CHUNK_SHIFT >= this.chunks.length) this.chunks.push(new Uint8Array(CHUNK_BRICKS * 512));
    }
    this.dense++;
    return slot;
  }

  private release(slot: number): void {
    this.freeSlots.push(slot);
    this.dense--;
  }
}
