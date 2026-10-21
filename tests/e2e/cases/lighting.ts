import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import type { CameraPose } from '../../../src/render/camera';
import { PROBE_DUSK, type FrameSky } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import type { SceneLight } from '../../../src/render/lights';
import { Renderer } from '../../../src/render/renderer';
import { gpu, readTexture } from '../support/gpu';
import { halfToFloat } from '../support/half';

const DIMS = { x: 128, y: 128, z: 128 };
type Scene = 'open' | 'roof' | 'box' | 'lantern' | 'pair';

/** Small worlds for one lighting question each; the camera looks straight down at the middle of the floor. */
function scene(name: Scene): { map: BrickMap; pose: CameraPose; lights: SceneLight[] } {
  const map = new BrickMap(DIMS);
  map.fillBox(0, 0, 0, 128, 40, 128, P.SOD);
  let pose: CameraPose = { position: [6.4, 9.6, 6.4], yaw: 0, pitch: -89.9 };
  const lights: SceneLight[] = [];
  const light = (x: number, y: number, z: number, intensity: number): SceneLight => ({
    position: [x, y, z], radius: 30, colour: [1, 1, 1], intensity, kind: 'lantern',
  });
  if (name === 'roof') {
    // The camera stands under the slab, looking at the ground it shades.
    map.fillBox(4, 70, 4, 124, 72, 124, P.TIMBER);
    pose = { position: [6.4, 6.0, 6.4], yaw: 0, pitch: -89.9 };
  }
  if (name === 'box') {
    // Every corner within the 4 m a sky ray looks: 19 voxels to the walls, 25 to the ceiling.
    map.fillBox(44, 40, 44, 86, 67, 86, P.CONCRETE);
    map.fillBox(46, 40, 46, 84, 65, 84, P.AIR);
    pose = { position: [6.5, 5.5, 6.5], yaw: 0, pitch: -89.9 };
  }
  if (name === 'lantern') {
    // A wall 4.6 m off (past the sky ray's reach) hides one lantern; the other hangs over the open floor.
    map.fillBox(20, 40, 110, 110, 90, 112, P.BRICK);
    lights.push(light(6.4, 5.5, 12.0, 3), light(6.4, 6.5, 6.4, 3));
  }
  if (name === 'pair') lights.push(light(6.0, 6.5, 6.4, 3), light(6.8, 6.5, 6.4, 1));
  return { map, pose, lights };
}

/** The light from one unshadowed point light on a +y face, as lighting.wgsl computes it. */
function analytic(l: SceneLight, at: [number, number, number]): number[] {
  const d = [l.position[0] - at[0], l.position[1] - at[1], l.position[2] - at[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  if (dist >= l.radius) return [0, 0, 0];
  const ndl = Math.max(d[1] / dist, 0);
  const x = dist / l.radius;
  const win = Math.min(1, Math.max(0, 1 - x ** 4));
  return l.colour.map((c) => (c * l.intensity * ndl * win * win) / (dist * dist + 1));
}

export const cases = {
  /** Mean lighting at the middle pixel over `frames` frames: [r, g, b, key visibility], and the analytic expectations. */
  async lighting(args: { scene: Scene; frames: number; keyElevation?: number }) {
    const g = await gpu();
    const { map, pose, lights } = scene(args.scene);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const renderer = await Renderer.create(g, null, world, null, { size: [64, 64] });
    const el = ((args.keyElevation ?? 45) * Math.PI) / 180;
    const sky: FrameSky = { ...PROBE_DUSK, keyDir: [0, Math.sin(el), Math.cos(el)], keyColour: [1, 1, 1], ambient: 1 };
    renderer.sky = sky;
    renderer.setLights(lights, 1);
    const [lw, lh] = renderer.lightResolution;
    const qx = lw >> 1;
    const qy = lh >> 1;
    const sum = [0, 0, 0, 0];
    let keyMin = 1;
    for (let f = 0; f < args.frames; f++) {
      renderer.render(pose, 0, f * 16);
      const px = new Uint16Array(await readTexture(renderer.texture('lNoisy')));
      const i = (qy * lw + qx) * 4;
      const v = [halfToFloat(px[i]), halfToFloat(px[i + 1]), halfToFloat(px[i + 2]), halfToFloat(px[i + 3])];
      for (let k = 0; k < 4; k++) sum[k] += v[k];
      keyMin = Math.min(keyMin, v[3]);
    }
    const mean = sum.map((s) => s / args.frames);
    // The floor's top face under the middle pixel, in metres.
    const floor: [number, number, number] = [pose.position[0], 4.0, pose.position[2]];
    const skyUp = [0, 1, 2].map((c) => (sky.horizon[c] * 0.55 + (sky.zenith[c] - sky.horizon[c] * 0.55) * 1) * sky.ambient);
    const lit = lights.map((l) => analytic(l, floor));
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { mean, keyMin, skyUp, lit, errors: [...g.errors] };
  },
};
