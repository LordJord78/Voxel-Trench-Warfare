/**
 * The loadout, chosen before going in (the start screen's, the lobby's, the pause menu's): a long
 * gun and a pistol, each with its own fit — an optic, a muzzle device, a grip, a light or a laser,
 * only what that gun takes — and the tracers' colour. The gun being fitted is drawn from its right
 * side as its voxels are (combat/gun-models.ts), with its numbers against the arsenal's as bars.
 * Kept in local storage between visits; anything stale or hand-edited falls back to the default.
 */

import { armSpec, ATTACHMENT_NAMES, cleanLoadout, defaultLoadout, fitOf, GUN_DEFS, gunStats, PRIMARY_GUNS, SECONDARY_GUNS, TRACER_NAMES, type GunStats, type Loadout } from '../combat/arsenal';
import { gunModel } from '../combat/gun-models';
import type { RifleModel } from '../combat/rifle-model';
import type { Tunables } from '../core/tunables';
import { DAMAGE_SCALE, TRACERS, type Fit, type GunKey, type Tracer } from '../net/gear';
import { PALETTE } from '../world/materials';

const KEY = 'trenchline.loadout';

export function loadLoadout(storage: Pick<Storage, 'getItem'> | null): Loadout {
  try {
    return cleanLoadout(JSON.parse(storage?.getItem(KEY) ?? 'null'));
  } catch {
    return defaultLoadout();
  }
}

export function saveLoadout(storage: Pick<Storage, 'setItem'> | null, l: Loadout): void {
  try {
    storage?.setItem(KEY, JSON.stringify(l));
  } catch {
    // Private browsing or a full quota: the loadout lasts this visit.
  }
}

/** A gun with what is fitted to it, in a line: "M4A1 with a red dot and a suppressor". */
export function gunLine(gun: GunKey, fit: Fit): string {
  const on = [fit.optic === 'iron' ? null : fit.optic, fit.muzzle, fit.under, fit.side].filter((k): k is NonNullable<typeof k> => k !== null && k !== 'none');
  const name = GUN_DEFS[gun].name;
  if (on.length === 0) return name;
  const words = on.map((k) => ATTACHMENT_NAMES[k].toLowerCase());
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `${name}: ${list}`;
}

/** The loadout in a line, for the start screen and the lobby. */
export function kitSummary(l: Loadout): string {
  return `${gunLine(l.primary, fitOf(l, l.primary))} · ${GUN_DEFS[l.secondary].name} · ${TRACER_NAMES[l.tracer]}`;
}

const SLOTS: readonly { key: keyof Fit; name: string }[] = [
  { key: 'optic', name: 'Optic' },
  { key: 'muzzle', name: 'Muzzle' },
  { key: 'under', name: 'Grip' },
  { key: 'side', name: 'Light' },
];

const STATS: readonly { key: keyof GunStats; name: string }[] = [
  { key: 'damage', name: 'Damage' },
  { key: 'rate', name: 'Fire rate' },
  { key: 'accuracy', name: 'Accuracy' },
  { key: 'control', name: 'Recoil control' },
  { key: 'range', name: 'Range' },
  { key: 'handling', name: 'Handling' },
  { key: 'mobility', name: 'Mobility' },
];

export interface LoadoutOpen {
  /** The button that takes the loadout and goes: "Deploy", "Done". */
  action: string;
  /** A line under the choices (e.g. that it is taken at the next respawn). */
  note?: string;
  done(l: Loadout): void;
  cancel?(): void;
}

export class LoadoutMenu {
  private readonly root: HTMLElement;
  private loadout: Loadout = defaultLoadout();
  /** The gun being fitted: one of the two carried. */
  private editing: GunKey = 'ak74';
  private opened: LoadoutOpen | null = null;

  constructor(
    private readonly doc: Document,
    private readonly tun: Tunables,
  ) {
    this.root = doc.getElementById('loadout')!;
    doc.getElementById('loadout-go')?.addEventListener('click', () => this.finish());
    doc.getElementById('loadout-back')?.addEventListener('click', () => this.back());
    this.root.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.back();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(l: Loadout, how: LoadoutOpen): void {
    this.loadout = cleanLoadout(JSON.parse(JSON.stringify(l)));
    this.editing = this.loadout.primary;
    this.opened = how;
    const go = this.doc.getElementById('loadout-go');
    if (go) go.textContent = how.action;
    const note = this.root.querySelector<HTMLElement>('.loadout-note');
    if (note) {
      note.textContent = how.note ?? '';
      note.hidden = !how.note;
    }
    this.root.hidden = false;
    this.render();
    (go as HTMLButtonElement | null)?.focus();
  }

  close(): void {
    this.root.hidden = true;
    this.opened = null;
  }

  private finish(): void {
    const how = this.opened;
    this.close();
    how?.done(cleanLoadout(this.loadout));
  }

  private back(): void {
    const how = this.opened;
    this.close();
    how?.cancel?.();
  }

  private render(): void {
    const l = this.loadout;
    // The guns: a press carries it, and fits it next.
    for (const [slot, guns] of [['primary', PRIMARY_GUNS], ['secondary', SECONDARY_GUNS]] as const) {
      const list = this.root.querySelector<HTMLElement>(`.guns[data-slot="${slot}"]`);
      if (!list) continue;
      list.replaceChildren(
        ...guns.map((g) => {
          const b = this.doc.createElement('button');
          b.type = 'button';
          b.className = `gun-pick${l[slot] === g ? ' on' : ''}${this.editing === g ? ' editing' : ''}`;
          const name = this.doc.createElement('b');
          name.textContent = GUN_DEFS[g].name;
          const role = this.doc.createElement('span');
          role.textContent = GUN_DEFS[g].role;
          b.append(name, role);
          b.setAttribute('aria-pressed', String(l[slot] === g));
          b.onclick = () => {
            l[slot] = g;
            this.editing = g;
            this.render();
          };
          return b;
        }),
      );
    }
    const tracers = this.root.querySelector<HTMLElement>('[data-tracers]');
    if (tracers) tracers.replaceChildren(...TRACERS.map((t) => this.choice(TRACER_NAMES[t].replace(' tracers', ''), l.tracer === t, () => this.setTracer(t), `tracer-${t}`)));

    const gun = this.editing;
    const fit = fitOf(l, gun);
    const def = GUN_DEFS[gun];
    const title = this.root.querySelector<HTMLElement>('.gun-title');
    if (title) title.textContent = `${def.name} — ${def.role}`;
    const fitEl = this.root.querySelector<HTMLElement>('.fit');
    if (fitEl) {
      fitEl.replaceChildren(
        ...SLOTS.map(({ key, name }) => {
          const row = this.doc.createElement('div');
          row.className = 'fit-row';
          const label = this.doc.createElement('span');
          label.className = 'slot-name';
          label.textContent = name;
          const options = def.fits[key] as readonly string[];
          row.append(label, ...options.map((o) => this.choice(ATTACHMENT_NAMES[o as keyof typeof ATTACHMENT_NAMES], fit[key] === o, () => this.setFit(gun, key, o))));
          if (options.length <= 1) row.classList.add('fixed');
          return row;
        }),
      );
    }
    const spec = armSpec(this.tun, gun, fit, l.tracer);
    const stats = gunStats(spec, DAMAGE_SCALE[gun]);
    const statsEl = this.root.querySelector<HTMLElement>('.stats');
    if (statsEl) {
      statsEl.replaceChildren(
        ...STATS.flatMap(({ key, name }) => {
          const dt = this.doc.createElement('dt');
          dt.textContent = name;
          const dd = this.doc.createElement('dd');
          const bar = this.doc.createElement('i');
          bar.style.width = `${Math.round(stats[key] * 100)}%`;
          dd.append(bar);
          return [dt, dd];
        }),
      );
    }
    const facts = this.root.querySelector<HTMLElement>('.facts');
    if (facts) {
      const w = spec.weapon;
      const fire = w.pellets > 1 ? `${w.pellets} pellets` : w.automatic ? 'automatic' : 'single shots';
      facts.textContent = `${w.magazine} rounds · ${Math.round(w.rpm)} a minute · ${fire} · ${Math.round(w.projectile.muzzleVelocity)} m/s · ${spec.zoom > 1.5 ? `${Math.round(spec.zoom + 0.4)}x sight` : 'aimed in ' + spec.adsTimeS.toFixed(2) + ' s'}`;
    }
    const preview = this.root.querySelector<HTMLCanvasElement>('canvas.preview');
    if (preview) drawPreview(preview, gunModel(gun, fit));
  }

  private choice(text: string, on: boolean, pick: () => void, cls = ''): HTMLButtonElement {
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.className = `pick${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`;
    b.textContent = text;
    b.setAttribute('aria-pressed', String(on));
    b.onclick = pick;
    return b;
  }

  private setFit(gun: GunKey, key: keyof Fit, value: string): void {
    this.loadout.fits[gun] = { ...fitOf(this.loadout, gun), [key]: value } as Fit;
    this.render();
  }

  private setTracer(t: Tracer): void {
    this.loadout.tracer = t;
    this.render();
  }
}

/** A model drawn from its right side, the muzzle to the right, a voxel a square: the nearest voxel of each column, darker the deeper it lies, lighter where nothing is over it. */
function drawPreview(canvas: HTMLCanvasElement, m: RifleModel): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const [nx, ny, nz] = m.dims;
  const scale = Math.max(1, Math.floor(Math.min((canvas.width - 24) / nz, (canvas.height - 24) / ny)));
  const ox = Math.round((canvas.width - nz * scale) / 2);
  const oy = Math.round((canvas.height - ny * scale) / 2);
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : m.voxels[i + nx * (j + ny * k)]);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = nx - 1; i >= 0; i--) {
        const p = at(i, j, k);
        if (p === 0) continue;
        const [r, gr, b] = PALETTE[p]?.srgb ?? [128, 128, 128];
        const depth = nx - 1 - i;
        const lit = (1 - 0.1 * depth) * (at(i, j + 1, k) === 0 ? 1.18 : 1) * (at(i, j - 1, k) === 0 ? 0.85 : 1);
        const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * lit)));
        g.fillStyle = `rgb(${c(r)}, ${c(gr)}, ${c(b)})`;
        g.fillRect(ox + k * scale, oy + (ny - 1 - j) * scale, scale, scale);
        break;
      }
    }
  }
}
