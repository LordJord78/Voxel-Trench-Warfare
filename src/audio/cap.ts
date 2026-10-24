/**
 * The engine's voice cap (the battle spec's §7): at most `max` voices sounding or waiting to (a
 * distant one is scheduled seconds ahead), each holding its place from its play until its end. At the
 * cap a new voice farther than all held is not played; a nearer one cuts the farthest held. A voice
 * is made only when it is played. Pure bookkeeping: the engine plays and cuts.
 */
export class VoiceCap<H> {
  private held: { distance: number; until: number; handle: H }[] = [];

  constructor(private readonly max: number) {}

  /** The voices held now. */
  get count(): number {
    return this.held.length;
  }

  /** A voice `distance` metres off, ending at `until`, asked to play at `now` (seconds on one clock): whether it plays, and the voice it cuts. */
  admit(distance: number, until: number, now: number, make: () => H): { play: boolean; cut?: H } {
    this.held = this.held.filter((v) => v.until > now);
    if (this.held.length < this.max) {
      this.held.push({ distance, until, handle: make() });
      return { play: true };
    }
    let far = 0;
    for (let i = 1; i < this.held.length; i++) if (this.held[i].distance > this.held[far].distance) far = i;
    if (distance >= this.held[far].distance) return { play: false };
    const [cut] = this.held.splice(far, 1);
    this.held.push({ distance, until, handle: make() });
    return { play: true, cut: cut.handle };
  }
}
