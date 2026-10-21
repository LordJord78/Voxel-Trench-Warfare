/**
 * The pause menu: quality, mouse sensitivity, field of view and time of day,
 * each applied as it changes, so the world behind the menu shows the effect.
 */

import type { Settings } from './settings';

export interface PauseHandlers {
  resume(): void;
  /** A preference changed; the menu passes the whole set. */
  change(settings: Settings): void;
  time(t: number): void;
}

export class PauseMenu {
  private readonly root: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly sensitivity: HTMLInputElement;
  private readonly fov: HTMLInputElement;
  private readonly time: HTMLInputElement;
  private readonly sensitivityValue: HTMLOutputElement;
  private readonly fovValue: HTMLOutputElement;
  private readonly resumeButton: HTMLButtonElement;

  constructor(doc: Document, handlers: PauseHandlers) {
    this.root = doc.getElementById('pause')!;
    this.form = doc.getElementById('settings') as HTMLFormElement;
    this.sensitivity = doc.getElementById('sensitivity') as HTMLInputElement;
    this.fov = doc.getElementById('fov') as HTMLInputElement;
    this.time = doc.getElementById('time') as HTMLInputElement;
    this.sensitivityValue = doc.getElementById('sensitivity-value') as HTMLOutputElement;
    this.fovValue = doc.getElementById('fov-value') as HTMLOutputElement;
    this.resumeButton = doc.getElementById('resume') as HTMLButtonElement;
    this.resumeButton.addEventListener('click', () => handlers.resume());
    this.form.addEventListener('submit', (e) => e.preventDefault());
    this.form.addEventListener('input', (e) => {
      if (e.target === this.time) {
        handlers.time(Number(this.time.value));
        return;
      }
      this.label();
      handlers.change(this.read());
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(settings: Settings, timeOfDay: number): void {
    const preset = this.form.querySelector<HTMLInputElement>(`input[name="preset"][value="${settings.preset}"]`);
    if (preset) preset.checked = true;
    this.sensitivity.value = String(settings.sensitivity);
    this.fov.value = String(settings.fov);
    this.time.value = String(timeOfDay);
    this.label();
    this.root.hidden = false;
    this.resumeButton.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  private read(): Settings {
    const preset = this.form.querySelector<HTMLInputElement>('input[name="preset"]:checked')?.value === 'low' ? 'low' : 'high';
    return { preset, sensitivity: Number(this.sensitivity.value), fov: Number(this.fov.value) };
  }

  private label(): void {
    this.sensitivityValue.value = Number(this.sensitivity.value).toFixed(2);
    this.fovValue.value = `${this.fov.value}°`;
  }
}
