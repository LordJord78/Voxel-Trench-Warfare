/**
 * The view through a trench periscope: dark all round a long mirror. It fades
 * in as the field of view narrows toward the periscope's, so it arrives with
 * the zoom rather than as a cut.
 */

export class PeriscopeFrame {
  private readonly el: HTMLElement;

  constructor(doc: Document) {
    this.el = doc.getElementById('periscope')!;
  }

  /** How far the view has narrowed toward the periscope's, 0 to 1. */
  set(amount: number): void {
    const a = Math.min(1, Math.max(0, amount));
    this.el.hidden = a < 0.02;
    this.el.style.opacity = a.toFixed(3);
  }
}
