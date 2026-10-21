/**
 * Edits on their way to the GPU.
 *
 * The CPU world runs ahead: an explosion re-encodes hundreds of bricks at once,
 * and they reach the GPU over the next frames, nearest the camera first, within
 * a byte budget per frame. What the GPU reads must stay true of the table it
 * actually holds, so:
 * - an edit writes its record before its table entry, and only then is the
 *   record it replaced released for reuse;
 * - an edit superseded before it was uploaded releases its own record at once,
 *   since the GPU never saw it;
 * - a sector's bit is set as soon as anything lands in it, and never cleared
 *   (a stale bit costs a little traversal, a missing one would hide geometry);
 * - a column's pyramid value rises at once and falls only when nothing in that
 *   column is still pending, so it is never lower than what the GPU's table
 *   holds there.
 */

import type { BrickMap } from '../world/bricks';
import type { BrickEdit, HeapMirror } from '../world/encode';
import { columnTop, propagate, type Pyramid } from './pyramid';

export interface GpuSink {
  table(index: number, entry: number): void;
  heap(unit: number, words: Uint32Array): void;
  sector(index: number, value: number): void;
  pyramid(index: number, value: number): void;
}

export class UploadQueue {
  private readonly map: BrickMap;
  private readonly mirror: HeapMirror;
  private readonly pyramid: Pyramid;
  private readonly queued = new Map<number, BrickEdit>();
  private readonly columnPending: Uint32Array;
  private readonly staleColumns = new Set<number>();
  private readonly gpuSectors: Uint32Array;
  private readonly gpuPyramid: Uint32Array;

  /** `gpu` holds what the GPU's sector mask and pyramid contain now; the queue keeps it current. */
  constructor(map: BrickMap, mirror: HeapMirror, pyramid: Pyramid, gpu: { sectors: Uint32Array; pyramid: Uint32Array }) {
    this.map = map;
    this.mirror = mirror;
    this.pyramid = pyramid;
    this.columnPending = new Uint32Array(map.bricks.x * map.bricks.z);
    this.gpuSectors = gpu.sectors;
    this.gpuPyramid = gpu.pyramid;
  }

  get pending(): number {
    return this.queued.size;
  }

  push(edits: readonly BrickEdit[]): void {
    for (const edit of edits) {
      const column = this.column(edit.brick);
      const prev = this.queued.get(edit.brick);
      if (prev) {
        if (prev.words) this.mirror.release(prev.entry);
        this.queued.set(edit.brick, { ...edit, retire: prev.retire });
      } else {
        this.queued.set(edit.brick, edit);
        this.columnPending[column]++;
      }
      this.staleColumns.add(column);
    }
  }

  /**
   * Upload whole edits nearest `eye` (voxels) first until `budgetBytes` is
   * spent, always at least one, then bring sectors and the pyramid along.
   * Returns the bytes of edits written.
   */
  flush(budgetBytes: number, eye: readonly [number, number, number], sink: GpuSink): number {
    let bytes = 0;
    if (this.queued.size > 0) {
      const order = [...this.queued.values()].map((edit) => ({ edit, d: this.distance2(edit.brick, eye) }));
      order.sort((a, b) => a.d - b.d);
      for (const { edit } of order) {
        const cost = 4 + (edit.words ? edit.words.byteLength : 0);
        if (bytes > 0 && bytes + cost > budgetBytes) break;
        if (edit.words) sink.heap(edit.unit, edit.words);
        sink.table(edit.brick, edit.entry);
        this.mirror.release(edit.retire);
        this.queued.delete(edit.brick);
        this.columnPending[this.column(edit.brick)]--;
        if (edit.entry !== 0) {
          const s = this.sector(edit.brick);
          if (!this.gpuSectors[s]) {
            this.gpuSectors[s] = 1;
            sink.sector(s, 1);
          }
        }
        bytes += cost;
      }
    }
    const raised: number[] = [];
    for (const c of [...this.staleColumns]) {
      const exact = columnTop(this.map, c % this.map.bricks.x, Math.floor(c / this.map.bricks.x));
      const settled = this.columnPending[c] === 0;
      const value = settled ? exact : Math.max(this.gpuPyramid[c], exact);
      if (settled) this.staleColumns.delete(c);
      if (value === this.gpuPyramid[c]) continue;
      this.gpuPyramid[c] = value;
      sink.pyramid(c, value);
      raised.push(c);
    }
    for (const i of propagate(this.pyramid.levels, this.gpuPyramid, raised)) sink.pyramid(i, this.gpuPyramid[i]);
    return bytes;
  }

  private coords(bi: number): [number, number, number] {
    const { x, y } = this.map.bricks;
    const bx = bi % x;
    const rest = (bi - bx) / x;
    const by = rest % y;
    return [bx, by, (rest - by) / y];
  }

  private column(bi: number): number {
    const [bx, , bz] = this.coords(bi);
    return bz * this.map.bricks.x + bx;
  }

  private sector(bi: number): number {
    const [bx, by, bz] = this.coords(bi);
    return ((bz >> 2) * this.map.sectors.y + (by >> 2)) * this.map.sectors.x + (bx >> 2);
  }

  private distance2(bi: number, eye: readonly [number, number, number]): number {
    const [bx, by, bz] = this.coords(bi);
    const dx = bx * 8 + 4 - eye[0];
    const dy = by * 8 + 4 - eye[1];
    const dz = bz * 8 + 4 - eye[2];
    return dx * dx + dy * dy + dz * dz;
  }
}
