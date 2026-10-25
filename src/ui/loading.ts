/**
 * The loading screen: what generation is doing, inked as a trench trace from
 * left to right; then the world drawn behind it and the way in. A failure
 * replaces the progress with what went wrong and what to do about it, and
 * stays.
 */

export class LoadingScreen {
  /** Each phase named so far, once. */
  readonly phases: string[] = [];
  /** Told each new phase as it starts. */
  onPhase: ((phase: string) => void) | null = null;
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly bar: SVGElement;
  private readonly dug: SVGPathElement;
  private readonly play: HTMLButtonElement;
  private readonly controls: HTMLElement;
  /** The game's still behind the sheet until the world is drawn (index.html), if the page has one. */
  private readonly still: HTMLElement | null;
  private failed = false;

  constructor(doc: Document) {
    this.root = doc.getElementById('loading')!;
    this.status = doc.getElementById('status')!;
    this.bar = this.root.querySelector('.trace')!;
    this.dug = this.root.querySelector('.trace .dug')!;
    this.play = doc.getElementById('play') as HTMLButtonElement;
    this.controls = doc.getElementById('controls')!;
    this.still = doc.getElementById('still');
  }

  /** A phase, with a detail such as "strip 3 of 32", and the fraction of the whole load done. */
  progress(phase: string, detail: string | null, fraction: number): void {
    if (this.failed) return;
    if (this.phases[this.phases.length - 1] !== phase) {
      this.phases.push(phase);
      this.onPhase?.(phase);
    }
    this.status.textContent = detail ? `${phase}, ${detail}` : phase;
    const f = Math.min(1, Math.max(0, fraction));
    this.dug.style.strokeDashoffset = String(1 - f);
    this.bar.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  }

  /** The world is drawing behind the sheet (the still over it until reveal): the way in is offered. */
  ready(onPlay: () => void): void {
    if (this.failed) return;
    this.progress('Ready', null, 1);
    this.root.classList.add('over-world');
    this.play.hidden = false;
    this.controls.hidden = false;
    this.play.onclick = onPlay;
    this.play.focus();
  }

  /** The world has settled behind the still: the still fades out over it. */
  reveal(): void {
    const still = this.still;
    if (!still || still.hidden || still.classList.contains('gone')) return;
    still.classList.add('gone');
    // Gone from the page once faded (at once where motion is reduced: no transition ends).
    const remove = () => (still.hidden = true);
    still.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 1000);
  }

  /** The sheet gone, and the still with it at once (play, or flying, before or during its fade). */
  hide(): void {
    this.root.hidden = true;
    if (this.still) this.still.hidden = true;
  }

  fail(message: string): void {
    this.failed = true;
    this.root.hidden = false;
    this.root.classList.add('failed');
    this.status.textContent = message;
    this.play.hidden = true;
    this.controls.hidden = true;
  }
}
