import { describe, expect, it } from 'vitest';
import { BattleClock, type ClockedBattle } from '../../src/app/battle-clock';
import { Director, noBattleEvents, type BattleEvents, type BattleInputs, type Strike } from '../../src/battle/director';
import { loadTunables } from '../../src/core/tunables';
import { matchHours, SILENT_STEP_S } from '../../src/net/clock';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { P } from '../../src/world/materials';

// The battle around the page on a room's match clock (src/app/battle-clock.ts): run on by each frame
// to the match's second, heard; past SILENT_STEP_S behind (a tab back from hidden), caught up
// silently in SILENT_STEP_S chunks, each at the dark of the match's time of day as it ends, no more
// than a frame's budget of them a frame, the frames' strikes held until it reaches the second they
// came at. So a page whose tab was hidden across a nightfall lights the hamlet as one that never hid.
const tun = loadTunables();
const plan = planWorld(genParams(tun), 7);
const v = plan.params.voxel;
const CHUNKS = tun.i('room_battle.catch_up_chunks');
/** The most Director steps (60 a second) a frame may run. */
const BUDGET = Math.round(CHUNKS * SILENT_STEP_S * 60);
const player: [number, number, number] = [(plan.params.dims.x / 2) * v, plan.params.ground * v, (plan.params.dims.z / 2) * v];

// The match: from 18:00 at ten game minutes a second, the room's fastest lapse, so an hour is 6 s.
// Dark from 21:00 to 05:00: 18 s to 66 s in, and again from 162 s.
const config = { timeOfDay: 18, lapse: 10 };
const darknessAt = (s: number) => {
  const h = matchHours(config, s);
  return h >= 21 || h < 5 ? 1 : 0;
};
const inputsAt = (s: number): BattleInputs => ({ intensity: 'light', darkness: darknessAt(s), player });
const FRAMES = 170 * 60;
/** The frame a page's tab is hidden after, and the one it is back on: 10 s to 100 s, the first night and its dawn between. */
const HIDDEN = [600, 6_000] as const;
/** Seeded shells on timber, given every page at frame 6 005 (100.08 s): on a page back from hidden, while it catches up. */
const STRUCK_AT = 6_005;
const struck: Strike[] = Array.from({ length: 6 }, (_, i) => ({ at: [150 + 20 * i, 16, 120], material: P.TIMBER, crater: null, seed: 4_100 + i }));

/** A page's battle over the match's first 170 s at 60 frames a second, its tab hidden through `hidden` (frames run none). */
function page(hidden?: readonly [number, number]) {
  const d = new Director(plan, tun, 7);
  const clock = new BattleClock(CHUNKS);
  /** Each time the hamlet's fires lit or began to die down, as [burning, the battle's second]; and the battle's second each time strikes were given it. */
  const hamlet: [boolean, number][] = [];
  const struckAt: number[] = [];
  let burning = false;
  const battle: ClockedBattle = {
    tick: (seconds, inputs) => {
      if (inputs.strikes?.length) struckAt.push(d.seconds);
      const events = d.tick(seconds, inputs);
      const now = d.fires().some((f) => f.hamlet && !f.dying);
      if (now !== burning) hamlet.push([(burning = now), d.seconds]);
      return events;
    },
  };
  /** Each frame run: its steps, what was heard, and whether the battle was behind after it. */
  const frames: { k: number; steps: number; heard: BattleEvents; behind: boolean }[] = [];
  for (let k = 1; k <= FRAMES; k++) {
    if (hidden && k > hidden[0] && k < hidden[1]) continue;
    const before = d.seconds;
    const { heard } = clock.frame(battle, k / 60, inputsAt, k === STRUCK_AT ? struck : [], []);
    frames.push({ k, steps: Math.round((d.seconds - before) * 60), heard, behind: clock.behind });
  }
  return { d, clock, hamlet, struckAt, frames };
}

describe("the battle on a room's match clock", () => {
  it('a gap stepped in chunks lights the hamlet at nightfall as a client that never hid does', () => {
    const stayed = page();
    const back = page(HIDDEN);
    // The page that stayed: lit at nightfall, out at dawn, lit at the next nightfall.
    expect(stayed.hamlet.map(([on]) => on)).toEqual([true, false, true]);
    expect(stayed.hamlet.map(([, s]) => Math.floor(s))).toEqual([18, 66, 162]);
    // The page back from hidden lit and put out the first night's in its catch-up, each within a
    // chunk of when the other did, though its tab was hidden through both.
    expect(back.hamlet.map(([on]) => on)).toEqual([true, false, true]);
    back.hamlet.forEach(([, s], i) => expect(Math.abs(s - stayed.hamlet[i][1]), `${i}`).toBeLessThanOrEqual(SILENT_STEP_S));
    // The strikes of a frame while it caught up were held until it reached the second they came at;
    // on the page that stayed, they went with that frame's step, from the frame before.
    expect(back.struckAt).toEqual([STRUCK_AT / 60]);
    expect(stayed.struckAt).toEqual([(STRUCK_AT - 1) / 60]);
    // So its second night's fires are the other's: the same lighting of the hamlet, the same sizes;
    // and its strikes' fires are the other's too, grown full.
    expect(back.d.fires().filter((f) => !f.hamlet).length).toBeGreaterThan(0);
    expect(back.d.fires()).toEqual(stayed.d.fires());
    expect(back.clock.given).toBe(stayed.clock.given);
  });

  it('no frame runs more than its budget of steps: the gap is spread over frames, unheard, until caught up', () => {
    const back = page(HIDDEN);
    expect(Math.max(...back.frames.map((f) => f.steps))).toBeLessThanOrEqual(BUDGET);
    // From the frame it is back on, behind until caught up: as few frames as the budget allows.
    const from = back.frames.findIndex((f) => f.k === HIDDEN[1]);
    const behind = back.frames.slice(from).findIndex((f) => !f.behind);
    const gap = (HIDDEN[1] - HIDDEN[0]) / 60;
    expect(behind).toBe(Math.ceil(gap / (CHUNKS * SILENT_STEP_S - 1 / 60)) - 1);
    for (const f of back.frames.slice(from, from + behind + 1)) {
      expect(f.steps, `${f.k}`).toBeGreaterThan(1);
      expect(f.heard, `${f.k}`).toEqual(noBattleEvents());
    }
    // Then a frame's step at a time, heard.
    expect(back.frames[from + behind + 1].steps).toBe(1);
    expect(back.frames.every((f) => !f.behind || f.k >= HIDDEN[1])).toBe(true);
    // The page that stayed never fell behind, and ran a step a frame.
    const stayed = page();
    expect(stayed.frames.every((f) => !f.behind && f.steps === 1)).toBe(true);
  });
});
