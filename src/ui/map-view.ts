/**
 * The trench map, held up on M: the world's plan drawn once as a field officer's sketch — the
 * trenches in ink, shell holes, the wood and the ruins — with north (+z) up, and over it each frame
 * where the player stands and faces, and where their teammates are. Red's lines are the south's,
 * Blue's the north's, as the teams start.
 */

import type { WorldPlan } from '../world/generation/plan';

export interface MapMark {
  /** Metres. */
  x: number;
  z: number;
  team: 'red' | 'blue';
}

const SIZE = 768;
const INK = { field: '#3b3a2c', crater: 'rgba(24, 22, 16, 0.55)', trench: '#14110e', parapet: '#6a5a44', tree: 'rgba(92, 112, 60, 0.85)', ruin: '#8d8478', grid: 'rgba(231, 211, 184, 0.08)' };
const TEAM = { red: '#e0644a', blue: '#6a9be0' } as const;

export class MapView {
  private base: HTMLCanvasElement | null = null;
  private readonly g: CanvasRenderingContext2D | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly plan: WorldPlan,
  ) {
    canvas.width = SIZE;
    canvas.height = SIZE;
    this.g = canvas.getContext('2d');
  }

  get open(): boolean {
    return !this.canvas.hidden;
  }

  show(on: boolean): void {
    this.canvas.hidden = !on;
  }

  /** The player (metres, and their yaw in degrees) and their teammates, over the map. */
  draw(you: { x: number; z: number; yaw: number; team: 'red' | 'blue' | null }, mates: readonly MapMark[]): void {
    const g = this.g;
    if (!g || this.canvas.hidden) return;
    g.drawImage(this.sketch(), 0, 0);
    const v = this.plan.params.voxel;
    const at = (x: number, z: number) => this.toPage(x / v, z / v);
    for (const m of mates) {
      const [px, py] = at(m.x, m.z);
      g.fillStyle = TEAM[m.team];
      g.beginPath();
      g.arc(px, py, 6, 0, Math.PI * 2);
      g.fill();
    }
    // The player: an arrow along their facing (yaw 0 is north, up the page; 90 east, to the right).
    const [px, py] = at(you.x, you.z);
    const a = (you.yaw * Math.PI) / 180;
    const fx = Math.sin(a);
    const fy = -Math.cos(a);
    g.fillStyle = you.team ? TEAM[you.team] : '#f2e3b3';
    g.strokeStyle = '#17141f';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px + fx * 14, py + fy * 14);
    g.lineTo(px - fx * 8 - fy * 8, py - fy * 8 + fx * 8);
    g.lineTo(px - fx * 4, py - fy * 4);
    g.lineTo(px - fx * 8 + fy * 8, py - fy * 8 - fx * 8);
    g.closePath();
    g.fill();
    g.stroke();
  }

  /** Voxels on the map to the canvas's pixels: north up. */
  private toPage(x: number, z: number): [number, number] {
    const d = this.plan.params.dims;
    return [(x / d.x) * SIZE, (1 - z / d.z) * SIZE];
  }

  /** The plan, drawn once. */
  private sketch(): HTMLCanvasElement {
    if (this.base) return this.base;
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    const g = c.getContext('2d')!;
    const plan = this.plan;
    const d = plan.params.dims;
    const scale = SIZE / d.x;
    g.fillStyle = INK.field;
    g.fillRect(0, 0, SIZE, SIZE);
    // A grid of 20 m squares, for reading distances off.
    const step = 20 / plan.params.voxel;
    g.strokeStyle = INK.grid;
    g.lineWidth = 1;
    for (let k = step; k < d.x; k += step) {
      const [x] = this.toPage(k, 0);
      const [, y] = this.toPage(0, k);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, SIZE);
      g.moveTo(0, y);
      g.lineTo(SIZE, y);
      g.stroke();
    }
    g.fillStyle = INK.crater;
    for (const cr of plan.craters) {
      const [x, y] = this.toPage(cr.x, cr.z);
      g.beginPath();
      g.arc(x, y, Math.max(1.5, cr.r * scale), 0, Math.PI * 2);
      g.fill();
    }
    for (const q of plan.props) {
      const [x, y] = this.toPage(q.x, q.z);
      if (q.kind === 'tree') {
        g.fillStyle = INK.tree;
        g.beginPath();
        g.arc(x, y, Math.max(1.5, ((q.a ?? 40) / 14) * scale), 0, Math.PI * 2);
        g.fill();
      } else if (q.kind === 'hamlet' || q.kind === 'farm' || q.kind === 'church' || q.kind === 'hull') {
        const w = Math.max(4, ((q.a ?? 60) + 10) * scale);
        const h = Math.max(4, ((q.b ?? 50) + 10) * scale);
        g.fillStyle = INK.ruin;
        g.fillRect(x - w / 2, y - h / 2, w, h);
      }
    }
    // The trenches: their parapets a little wider, then the trench itself in ink.
    const rects: [number, number, number, number][] = [];
    for (const line of plan.lines) {
      for (const b of line.bays) rects.push([b.x0, b.z0, b.x1, b.z1]);
      for (const l of line.legs) rects.push(l.longAxis === 0 ? [l.a0, l.b0, l.a1, l.b1] : [l.b0, l.a0, l.b1, l.a1]);
    }
    for (const [ink, grow] of [[INK.parapet, 6], [INK.trench, 0]] as const) {
      g.fillStyle = ink;
      for (const [x0, z0, x1, z1] of rects) {
        const [ax, ay] = this.toPage(x0 - grow, z1 + grow);
        const [bx, by] = this.toPage(x1 + grow, z0 - grow);
        g.fillRect(ax, ay, Math.max(1, bx - ax), Math.max(1, by - ay));
      }
    }
    // Who starts where.
    g.font = '600 22px Georgia, serif';
    g.textAlign = 'center';
    g.fillStyle = TEAM.blue;
    g.fillText('BLUE', SIZE / 2, 30);
    g.fillStyle = TEAM.red;
    g.fillText('RED', SIZE / 2, SIZE - 14);
    g.fillStyle = 'rgba(231, 211, 184, 0.8)';
    g.font = '15px Georgia, serif';
    g.textAlign = 'left';
    g.fillText('N ↑   one square is 20 m', 12, 22);
    this.base = c;
    return c;
  }
}
