/**
 * The water's reflection (reflect.wgsl): a pool in a floor before a brick wall lit by a low sun
 * behind the camera, seen from above its near edge. What its water reflects on the high preset, with
 * the wall and without it, on the low preset, and with the reflection's reach (1 m) short of the wall; a
 * flare's glint where its mirror image lies; and each sampled pixel's ray and depth, so the test can
 * follow the mirrored ray on the CPU.
 */
import { projectToPixel, rayDir, type CameraPose } from '../../../src/render/camera';
import { FLAGS, PROBE_DUSK } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import type { SceneLight } from '../../../src/render/lights';
import type { Preset } from '../../../src/render/quality';
import { Renderer } from '../../../src/render/renderer';
import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import { gpu, readTexture } from '../support/gpu';
import { halfToFloat } from '../support/half';

const DIMS = { x: 128, y: 128, z: 128 };
const SIZE: [number, number] = [320, 180];
/** Over the pool's near edge, looking along it at the wall, down 18°. */
const POSE: CameraPose = { position: [6.4, 3.2, 0.6], yaw: 0, pitch: -18 };
/** The low sun behind the camera, lighting the wall's face toward it. */
const KEY: [number, number, number] = (() => {
  const v = [0, 0.45, -1];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();
/** The water's top, metres. */
export const WATER_Y = 1.6;
/** A flare over the pool, 2.9 m above the water. */
const FLARE: SceneLight = { position: [6.43, 4.5, 6.07], radius: 65, colour: [1, 0.88, 0.7], intensity: 260, kind: 'flare', phase: 0 };

/** A floor 1.6 m deep, a pool cut into its top (0.3 m deep) from 1.6 m to 8 m out, and, `wall` given, a brick wall 9.6 m out. */
function world(wall: boolean): BrickMap {
  const map = new BrickMap(DIMS);
  map.fillBox(0, 0, 0, 128, 16, 128, P.SOD);
  map.fillBox(16, 13, 16, 112, 16, 80, P.WATER);
  if (wall) map.fillBox(0, 16, 96, 128, 64, 100, P.BRICK);
  return map;
}

/** The reflection, depth and hit of the last frame of `frames` from POSE over `map`. */
async function look(map: BrickMap, options: { preset?: Preset; reachM?: number; lights?: SceneLight[] } = {}) {
  const g = await gpu();
  const gw = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
  const renderer = await Renderer.create(g, null, gw, null, { size: SIZE, preset: options.preset ?? 'high' });
  // The sky's own light a twentieth of dusk's, and no fog: the sunlit wall stands clear of the sky in the water.
  renderer.sky = { ...PROBE_DUSK, keyDir: KEY, keyColour: [3, 2.6, 2.2], sunLight: [0.3, 0.3, 0.3], fogDensity: 0 };
  renderer.flags |= FLAGS.JITTER_OFF;
  if (options.reachM !== undefined) renderer.waterTerms = { ...renderer.waterTerms, frame: { ...renderer.waterTerms.frame, reflectM: options.reachM } };
  renderer.setLights(options.lights ?? [], 1);
  let now = 0;
  for (let k = 0; k < 12; k++) renderer.render(POSE, 0, (now += 16));
  const reflection = new Uint16Array(await readTexture(renderer.texture('reflection')));
  const depth = new Float32Array(await readTexture(renderer.texture('gDepth')));
  const hit = new Uint32Array(await readTexture(renderer.texture('gHit')));
  const colour = new Uint16Array(await readTexture(renderer.texture('colour')));
  const w = renderer.texture('reflection').width;
  const rgb = (px: number, py: number, data: Uint16Array) => [0, 1, 2].map((c) => halfToFloat(data[(py * w + px) * 4 + c]));
  return {
    w,
    reflection: (px: number, py: number) => rgb(px, py, reflection),
    colour: (px: number, py: number) => rgb(px, py, colour),
    depth: (px: number, py: number) => depth[py * w + px],
    water: (px: number, py: number) => (hit[(py * w + px) * 2 + 1] >>> 16) === P.WATER,
    errors: [...g.errors],
  };
}

export const cases = {
  /**
   * Over a grid of the image's pixels: whether each is water, its ray and depth (metres), and what
   * it reflects in each case; and the flare's glint where its mirror image lies, with and without it.
   */
  async waterReflect() {
    const walled = await look(world(true));
    const bare = await look(world(false));
    const low = await look(world(true), { preset: 'low' });
    const short = await look(world(true), { reachM: 1 });
    const samples: { px: number; py: number; ray: number[]; depthM: number; high: number[]; bare: number[]; low: number[]; short: number[] }[] = [];
    for (let j = 0; j < 36; j++) {
      for (let i = 0; i < 64; i++) {
        const px = Math.floor(((i + 0.5) / 64) * SIZE[0]);
        const py = Math.floor(((j + 0.5) / 36) * SIZE[1]);
        if (!walled.water(px, py)) continue;
        samples.push({
          px,
          py,
          ray: rayDir(POSE, SIZE, px + 0.5, py + 0.5),
          depthM: walled.depth(px, py) * 0.1,
          high: walled.reflection(px, py),
          bare: bare.reflection(px, py),
          low: low.reflection(px, py),
          short: short.reflection(px, py),
        });
      }
    }
    // The flare's mirror image, and what the water there reflects with it and without.
    const image: [number, number, number] = [FLARE.position[0], 2 * WATER_Y - FLARE.position[1], FLARE.position[2]];
    const at = projectToPixel(POSE, SIZE, image);
    const glint = at && { px: Math.floor(at[0]), py: Math.floor(at[1]) };
    const lit = await look(world(true), { lights: [FLARE] });
    const lowLit = await look(world(true), { lights: [FLARE], preset: 'low' });
    const glints = glint && {
      ...glint,
      water: lit.water(glint.px, glint.py),
      with: lit.reflection(glint.px, glint.py),
      without: walled.reflection(glint.px, glint.py),
      low: lowLit.reflection(glint.px, glint.py),
      aside: lit.reflection(Math.min(SIZE[0] - 1, glint.px + 12), glint.py),
    };
    return { pose: POSE, waterY: WATER_Y, samples, glint: glints, errors: [...walled.errors, ...bare.errors, ...low.errors, ...short.errors, ...lit.errors, ...lowLit.errors] };
  },
};
