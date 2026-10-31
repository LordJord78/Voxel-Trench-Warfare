import { expect, test, type Page } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The other players drawn (the multiplayer spec's §3), stood in the world by the puppets hook so no
// room is needed: each wears their team's tape; one in the open is where the frame's depth says,
// and one behind the parapet is hidden by it.

type Box = [number, number, number, number];
type Puppet = { team: 'red' | 'blue'; position: [number, number, number]; yaw: number; pitch: number; height: number };
type H = {
  teleport(a: { position: [number, number, number]; yaw: number; pitch: number }): void;
  puppets(list: Puppet[]): void;
  soldiersDrawn(): Box[];
  setTimeOfDay(t: number): void;
  views: Record<string, { position: [number, number, number]; yaw: number }>;
  waitFrames(n: number): Promise<void>;
  sharpAt(box: Box): Promise<number[]>;
  depthAt(points: [number, number][]): Promise<number[]>;
  play(): void;
};

/** In no man's land at noon, looking along +x, the ground's height under the eye; the puppets then stand 4 m ahead. */
async function field(page: Page, puppets: (feet: [number, number, number]) => Puppet[]): Promise<{ boxes: Box[]; feet: [number, number, number] }> {
  return hooks(page, async (raw, arg) => {
    const h = raw as unknown as H;
    h.play();
    const v = h.views['nml-night'].position;
    const feet: [number, number, number] = [v[0], v[1] - 1.62, v[2]];
    h.setTimeOfDay(12);
    h.teleport({ position: [feet[0], feet[1] + 0.2, feet[2]], yaw: 90, pitch: 0 });
    h.puppets(new Function('feet', `return (${arg as string})(feet)`)(feet) as Puppet[]);
    await h.waitFrames(40);
    return { boxes: h.soldiersDrawn(), feet };
  }, puppets.toString());
}

test('each soldier wears their own team\'s tape', async ({ page }) => {
  const errors = await openGame(page);
  // The same soldier at the same spot in either team's tape: the sky behind is the same, so what
  // differs between the two is the tape.
  const counts: Record<string, { red: number; blue: number }> = {};
  for (const team of ['red', 'blue'] as const) {
    const { boxes } = await field(page, new Function('feet', `return [{ team: '${team}', position: [feet[0] + 3, feet[1], feet[2]], yaw: 270, pitch: 0, height: 1.8 }]`) as (feet: [number, number, number]) => Puppet[]);
    expect(boxes).toHaveLength(1);
    const px = await hooks(page, (raw, box) => (raw as unknown as H).sharpAt(box as Box), boxes[0]);
    let red = 0;
    let blue = 0;
    // Three floats a pixel: its red, green and blue.
    for (let i = 0; i < px.length; i += 3) {
      if (px[i] > 2.5 * Math.max(px[i + 1], px[i + 2]) && px[i] > 0.02) red++;
      if (px[i + 2] > 2.5 * Math.max(px[i], px[i + 1]) && px[i + 2] > 0.02) blue++;
    }
    counts[team] = { red, blue };
  }
  const line = JSON.stringify(counts);
  expect(counts.red.red - counts.blue.red, line).toBeGreaterThan(8);
  expect(counts.blue.blue - counts.red.blue, line).toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('a soldier in the open is where the depth says, and one behind the parapet is hidden', async ({ page }) => {
  const errors = await openGame(page);
  const { boxes } = await field(page, (feet) => [{ team: 'red', position: [feet[0] + 4, feet[1], feet[2]], yaw: 270, pitch: 0, height: 1.8 }]);
  const [x, y, w, hgt] = boxes[0];
  const [seen] = await hooks(page, (raw, p) => (raw as unknown as H).depthAt([p as [number, number]]), [x + (w >> 1), y + Math.floor(hgt * 0.4)]);
  expect(seen).toBeGreaterThan(3.3);
  expect(seen).toBeLessThan(4.3);

  // On the duckboards facing the parapet: a soldier 5 m out beyond it, his feet on the field.
  const hidden = await hooks(page, async (raw) => {
    const h = raw as unknown as H;
    const v = h.views.step;
    const yaw = v.yaw;
    const f: [number, number] = [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)];
    h.teleport({ position: [v.position[0] - f[0] * 1.6, v.position[1] - 1.62 - 1.6, v.position[2] - f[1] * 1.6], yaw, pitch: 8 });
    h.puppets([{ team: 'blue', position: [v.position[0] + f[0] * 5, v.position[1] - 1.62 - 0.2, v.position[2] + f[1] * 5], yaw: yaw + 180, pitch: 0, height: 1.8 }]);
    await h.waitFrames(30);
    const b = h.soldiersDrawn()[0];
    if (!b) return null;
    return h.depthAt([[b[0] + (b[2] >> 1), b[1] + (b[3] >> 1)]]);
  });
  expect(hidden).not.toBeNull();
  expect(hidden![0]).toBeLessThan(4.5);
  expect(errors).toEqual([]);
});
