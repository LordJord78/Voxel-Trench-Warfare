/**
 * The pause menu: quality, mouse sensitivity, field of view, the clock and how
 * fast it runs, each applied as it changes, so the world behind the menu shows
 * the effect.
 */

import { clockText } from '../core/sky-clock';
import type { Settings } from './settings';

export interface PauseHandlers {
  resume(): void;
  /** A preference changed; the menu passes the whole set. */
  /** The form's settings; whether the preset is the visitor's own is the game's to say (it was, or they changed it). */
  change(settings: Omit<Settings, 'presetChosen'>): void;
  /** The clock, in hours. */
  time(hours: number): void;
  /** How fast the clock runs, in game minutes a second (0: held). */
  lapse(speed: number): void;
}

export class PauseMenu {
  private readonly root: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly sensitivity: HTMLInputElement;
  private readonly fov: HTMLInputElement;
  private readonly time: HTMLInputElement;
  private readonly timeValue: HTMLOutputElement;
  private readonly sensitivityValue: HTMLOutputElement;
  private readonly fovValue: HTMLOutputElement;
  private readonly resumeButton: HTMLButtonElement;

  constructor(doc: Document, handlers: PauseHandlers) {
    this.root = doc.getElementById('pause')!;
    this.form = doc.getElementById('settings') as HTMLFormElement;
    this.sensitivity = doc.getElementById('sensitivity') as HTMLInputElement;
    this.fov = doc.getElementById('fov') as HTMLInputElement;
    this.time = doc.getElementById('time') as HTMLInputElement;
    this.timeValue = doc.getElementById('time-value') as HTMLOutputElement;
    this.sensitivityValue = doc.getElementById('sensitivity-value') as HTMLOutputElement;
    this.fovValue = doc.getElementById('fov-value') as HTMLOutputElement;
    this.resumeButton = doc.getElementById('resume') as HTMLButtonElement;
    this.resumeButton.addEventListener('click', () => handlers.resume());
    this.form.addEventListener('submit', (e) => e.preventDefault());
    this.form.addEventListener('input', (e) => {
      if (e.target === this.time) {
        this.label();
        handlers.time(Number(this.time.value));
        return;
      }
      if (e.target instanceof HTMLInputElement && e.target.name === 'lapse') {
        handlers.lapse(Number(e.target.value));
        return;
      }
      this.label();
      handlers.change(this.read());
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(settings: Settings, hours: number, lapse: number): void {
    const preset = this.form.querySelector<HTMLInputElement>(`input[name="preset"][value="${settings.preset}"]`);
    if (preset) preset.checked = true;
    const intensity = this.form.querySelector<HTMLInputElement>(`input[name="intensity"][value="${settings.intensity}"]`);
    if (intensity) intensity.checked = true;
    this.sensitivity.value = String(settings.sensitivity);
    this.fov.value = String(settings.fov);
    this.time.value = String(hours);
    const speed = this.form.querySelector<HTMLInputElement>(`input[name="lapse"][value="${lapse}"]`);
    if (speed) speed.checked = true;
    this.label();
    this.root.hidden = false;
    this.resumeButton.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  private read(): Omit<Settings, 'presetChosen'> {
    const preset = this.form.querySelector<HTMLInputElement>('input[name="preset"]:checked')?.value === 'low' ? 'low' : 'high';
    const chosen = this.form.querySelector<HTMLInputElement>('input[name="intensity"]:checked')?.value;
    const intensity = chosen === 'off' || chosen === 'heavy' ? chosen : 'light';
    return { preset, sensitivity: Number(this.sensitivity.value), fov: Number(this.fov.value), intensity };
  }

  private label(): void {
    this.sensitivityValue.value = Number(this.sensitivity.value).toFixed(2);
    this.fovValue.value = `${this.fov.value}°`;
    this.timeValue.value = clockText(Number(this.time.value));
  }
}
