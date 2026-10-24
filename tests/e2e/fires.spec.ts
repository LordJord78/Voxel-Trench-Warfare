import { expect, test } from '@playwright/test';
import { hooks, openGame } from './support/app';

// The hamlet's fires, lit at nightfall (src/battle/fires.ts): a minute into the night, each a light
// over its fuel lighting the ruins round it, and its plume in the haze. At rest there are none.

const NIGHT = 22;
type V3 = [number, number, number];

/** A minute into the night at the hamlet: the battle's fires, the plumes and the fire lights. */
async function burning(page: Parameters<typeof hooks>[0]) {
  return hooks(page, async (h, night) => {
    h.view('hamlet');
    h.setTimeOfDay(night as number);
    h.jitter(false);
    h.runLights(60);
    h.freeze();
    await h.stepFrames(2);
    const eye = h.camera().position;
    const b = h.battle();
    const near = (a: readonly number[]) => Math.hypot(a[0] - eye[0], a[2] - eye[2]);
    const fire = [...b.fires].sort((x, y) => near(x.at) - near(y.at))[0];
    return { fires: b.fires, plumes: b.plumes, fire, lights: h.lights().filter((l) => l.kind === 'fire') };
  }, NIGHT);
}

test('a fire lights the ruins round it', async ({ page }) => {
  const errors = await openGame(page);
  const { fires, fire, lights } = await burning(page);
  // The hamlet's 2–4, burning at full strength a minute after they were lit, each a light over its fuel.
  expect(fires.length).toBeGreaterThanOrEqual(2);
  expect(fires.length).toBeLessThanOrEqual(4);
  expect(fires.every((f) => f.hamlet && f.strength === 1)).toBe(true);
  expect(lights).toHaveLength(fires.length);
  const light = lights.find((l) => Math.hypot(l.position[0] - fire.at[0], l.position[2] - fire.at[2]) < 1e-6)!;
  expect(light.position[1]).toBeCloseTo(fire.at[1] + 0.3, 5);
  expect(light.colour[0]).toBeGreaterThan(light.colour[2]);
  // Looking down on it from 6 m: the ruins round it, lit, and at rest.
  const lit = await hooks(page, async (h, at) => {
    const a = at as V3;
    const above = { position: [a[0], a[1] + 6, a[2]] as V3, yaw: 0, pitch: -89.9 };
    const [w, hh] = h.stats().res;
    const box: [number, number, number, number] = [Math.floor(w / 2) - 12, Math.floor(hh / 2) - 12, 25, 25];
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    h.flyTo(above);
    await h.stepFrames(30);
    const burning = lum(await h.colourAt(box));
    h.holdLights();
    // Flown there again, the lighting's history starts afresh, as it does on any cut: the fire's light does not linger in it.
    h.flyTo(above);
    await h.stepFrames(30);
    const rest = lum(await h.colourAt(box));
    return { burning, rest };
  }, fire.at);
  console.log(`a hamlet fire from 6 m above: ${lit.burning.toExponential(3)} burning, ${lit.rest.toExponential(3)} at rest (${(lit.burning / lit.rest).toFixed(1)}×)`);
  expect(lit.burning).toBeGreaterThan(20 * lit.rest);
  expect(errors).toEqual([]);
});

test('its plume thickens the haze above it', async ({ page }) => {
  const errors = await openGame(page);
  const { fire, plumes } = await burning(page);
  // Its plume: the puffs standing over it, leaning downwind; the third, 6 m up.
  const own = plumes.filter((p) => Math.hypot(p.centre[0] - fire.at[0], p.centre[2] - fire.at[2]) < 20).sort((a, b) => a.centre[1] - b.centre[1]);
  expect(own).toHaveLength(6);
  const puff = own[2];
  expect(puff.centre[1]).toBeCloseTo(fire.at[1] + 6, 5);
  // From 15 m off across the wind, at its height, looking at it.
  const lean = [puff.centre[0] - fire.at[0], puff.centre[2] - fire.at[2]];
  const n = Math.hypot(lean[0], lean[1]) || 1;
  const side = [-lean[1] / n, lean[0] / n];
  const position: V3 = [puff.centre[0] + side[0] * 15, puff.centre[1], puff.centre[2] + side[1] * 15];
  const yaw = (Math.atan2(-side[0], -side[1]) * 180) / Math.PI;
  const haze = await hooks(page, async (h, pose) => {
    h.flyTo(pose as { position: V3; yaw: number; pitch: number });
    await h.stepFrames(4);
    const burning = await h.hazeAt([[0.5, 0.5]]);
    h.holdLights();
    await h.stepFrames(4);
    const rest = await h.hazeAt([[0.5, 0.5]]);
    return { burning: burning[0], rest: rest[0] };
  }, { position, yaw, pitch: 0 });
  console.log(`through a hamlet fire's plume 15 m off: ${haze.burning[3].toFixed(3)} of the haze behind it shows, ${haze.rest[3].toFixed(3)} at rest`);
  // Through its plume the haze lets less through than at rest, when there is none.
  expect(haze.burning[3]).toBeLessThan(0.85 * haze.rest[3]);
  expect(errors).toEqual([]);
});

test("a burning fire's flames are drawn", async ({ page }) => {
  const errors = await openGame(page);
  const { fires, fire } = await burning(page);
  // From 8 m off and 3 m up, looking at its flames: the image with the effects and without, burning and at rest.
  const r = await hooks(page, async (h, at) => {
    const a = at as V3;
    const pose = { position: [a[0], a[1] + 3, a[2] - 8] as V3, yaw: 0, pitch: (Math.atan2(-2.5, 8) * 180) / Math.PI };
    const [w, hh] = h.stats().res;
    const box: [number, number, number, number] = [Math.floor(w / 2) - 12, Math.floor(hh / 2) - 12, 25, 25];
    const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const seen = async () => {
      const px = await h.sharpAt(box);
      const sum = [0, 0, 0];
      for (let i = 0; i < px.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += px[i + c];
      return { flames: h.effects().flames, sharp: lum(sum.map((v) => v / (px.length / 3))), shaded: lum(await h.colourAt(box)) };
    };
    h.flyTo(pose);
    await h.stepFrames(30);
    const burning = await seen();
    h.holdLights();
    h.flyTo(pose);
    await h.stepFrames(30);
    return { burning, rest: await seen() };
  }, fire.at);
  console.log(`a hamlet fire's flames from 8 m: with the effects ${r.burning.sharp.toFixed(3)}, without ${r.burning.shaded.toFixed(3)}; at rest ${r.rest.sharp.toFixed(4)} and ${r.rest.shaded.toFixed(4)}`);
  // Ten flames and eight embers a fire, every fire's drawn; none at rest.
  expect(r.burning.flames).toBe(fires.length * 18);
  expect(r.rest.flames).toBe(0);
  // Where they burn, they add their own light over the ruins they light.
  expect(r.burning.sharp).toBeGreaterThan(1.25 * r.burning.shaded);
  expect(Math.abs(r.rest.sharp / r.rest.shaded - 1)).toBeLessThan(0.15);
  expect(errors).toEqual([]);
});
