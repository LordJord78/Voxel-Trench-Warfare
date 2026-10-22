import { BrickMap } from '../../../src/world/bricks';
import { HeapMirror } from '../../../src/world/encode';
import { P } from '../../../src/world/materials';
import type { CameraPose } from '../../../src/render/camera';
import { PROBE_DUSK, type FrameSky } from '../../../src/render/frame-uniforms';
import { GpuWorld } from '../../../src/render/gpu-world';
import { lanternLight, type SceneLight } from '../../../src/render/lights';
import { Renderer } from '../../../src/render/renderer';
import { gpu, readBuffer, readTexture } from '../support/gpu';
import { halfToFloat } from '../support/half';

const DIMS = { x: 128, y: 128, z: 128 };
type Scene = 'open' | 'roof' | 'box' | 'lantern' | 'pair' | 'single' | 'broken';

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
  // A light whose weight is NaN, after one the pick has already taken; and that one alone.
  if (name === 'broken') lights.push(light(6.0, 6.5, 6.4, 3), light(6.8, 6.5, 6.4, NaN));
  if (name === 'single') lights.push(light(6.0, 6.5, 6.4, 3));
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
  /**
   * At the middle lighting pixel over `frames` frames: the mean point light (rgb) and key
   * visibility (a); the mean of the sky samples it traced, and how many; the history's colour
   * after the last frame; and the analytic expectations.
   */
  async lighting(args: { scene: Scene; frames: number; keyElevation?: number }) {
    const g = await gpu();
    const { map, pose, lights } = scene(args.scene);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const renderer = await Renderer.create(g, null, world, null, { size: [64, 64] });
    const el = ((args.keyElevation ?? 45) * Math.PI) / 180;
    const sky: FrameSky = { ...PROBE_DUSK, keyDir: [0, Math.sin(el), Math.cos(el)], keyColour: [1, 1, 1] };
    renderer.sky = sky;
    renderer.setLights(lights, 1);
    const [lw, lh] = renderer.lightResolution;
    const qx = lw >> 1;
    const qy = lh >> 1;
    const sum = [0, 0, 0, 0];
    let keyMin = 1;
    let skySum = 0;
    let skyTraced = 0;
    for (let f = 0; f < args.frames; f++) {
      renderer.render(pose, 0, f * 16);
      const px = new Uint16Array(await readTexture(renderer.texture('lNoisy')));
      const i = (qy * lw + qx) * 4;
      const v = [halfToFloat(px[i]), halfToFloat(px[i + 1]), halfToFloat(px[i + 2]), halfToFloat(px[i + 3])];
      for (let k = 0; k < 4; k++) sum[k] += v[k];
      keyMin = Math.min(keyMin, v[3]);
      const sky = new Float32Array(await readTexture(renderer.texture('lSky')))[qy * lw + qx];
      if (sky >= 0) {
        skySum += sky;
        skyTraced++;
      }
    }
    const mean = sum.map((s) => s / args.frames);
    const h = new Uint16Array(await readTexture(renderer.texture('hColour')));
    const history = [0, 1, 2, 3].map((k) => halfToFloat(h[(qy * lw + qx) * 4 + k]));
    // The floor's top face under the middle pixel, in metres.
    const floor: [number, number, number] = [pose.position[0], 4.0, pose.position[2]];
    // The sky's light on an upward face (face 3): the atmosphere's irradiance from the sun's sky and the moon's.
    const irradiance = new Float32Array(await readBuffer(renderer.atmosphere.irradiance, 12 * 16));
    const skyUp = [0, 1, 2].map((c) => sky.sunLight[c] * irradiance[3 * 4 + c] + sky.moonLight[c] * irradiance[9 * 4 + c]);
    const lit = lights.map((l) => analytic(l, floor));
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { mean, keyMin, skyMean: skySum / skyTraced, skyTraced, history, skyUp, lit, errors: [...g.errors] };
  },

  /**
   * Which lighting pixels trace the sky ray, over two frames of open ground: those whose row is in
   * a band of four (rows 0-3, 4-7, ...) taking its turn, a band's turn every other frame. Pixels
   * that break the rule, and how many traced in each frame.
   */
  async skyBands() {
    const g = await gpu();
    const { map, pose } = scene('open');
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const renderer = await Renderer.create(g, null, world, null, { size: [64, 64] });
    const [lw, lh] = renderer.lightResolution;
    let broken = 0;
    const traced: number[] = [];
    for (let f = 0; f < 2; f++) {
      renderer.render(pose, 0, f * 16);
      const sky = new Float32Array(await readTexture(renderer.texture('lSky')));
      let n = 0;
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          const turn = ((y >> 2) + f) % 2 === 0;
          const v = sky[y * lw + x];
          if (v >= 0) n++;
          if (turn !== v >= 0 || (v >= 0 && v !== 0 && v !== 1)) broken++;
        }
      }
      traced.push(n);
    }
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { broken, traced, pixels: lw * lh, errors: [...g.errors] };
  },

  /**
   * A lantern on a wall, lit as the game places its light: of the wall faces touching the glass,
   * the light they receive over 64 frames against what reaches them unshadowed. (A light just in
   * front of the glass throws the glass's own shadow, three voxels square, onto exactly these.)
   */
  async lanternFrame() {
    const g = await gpu();
    const map = new BrickMap(DIMS);
    map.fillBox(0, 0, 0, 128, 40, 128, P.SOD);
    map.fillBox(40, 40, 100, 90, 80, 104, P.BRICK);
    const glass: [number, number, number] = [64, 60, 99];
    map.set(...glass, P.LANTERN_GLOW);
    const world = GpuWorld.create(g.device, { map, mirror: HeapMirror.fromMap(map) });
    const renderer = await Renderer.create(g, null, world, null, { size: [128, 128] });
    renderer.sky = { ...PROBE_DUSK, keyColour: [0, 0, 0], sunLight: [0, 0, 0], moonLight: [0, 0, 0] };
    // The room is toward -z: the lantern faces it.
    const light: SceneLight = { position: lanternLight(glass, [0, 0, -1], 0.1), radius: 7, colour: [1, 1, 1], intensity: 2.5, kind: 'lantern' };
    renderer.setLights([light], 1);
    const pose: CameraPose = { position: [6.45, 6.05, 8.0], yaw: 0, pitch: 0 };
    const [lw, lh] = [64, 64];
    const sum = new Float64Array(lw * lh);
    const ring = new Map<number, [number, number]>();
    for (let f = 0; f < 64; f++) {
      renderer.render(pose, 0, f);
      const noisy = Array.from(new Uint16Array(await readTexture(renderer.texture('lNoisy'))), halfToFloat);
      const hit = new Uint32Array(await readTexture(renderer.texture('hHit')));
      for (let i = 0; i < lw * lh; i++) {
        const w0 = hit[i * 2];
        const w1 = hit[i * 2 + 1];
        const face = (w0 >>> 24) & 7;
        const cell = [w0 & 0xfff, w1 & 0xffff, (w0 >>> 12) & 0xfff];
        // The wall's front face (normal -z, face 4), in the ring of eight voxels touching the glass.
        const near = Math.max(Math.abs(cell[0] - glass[0]), Math.abs(cell[1] - glass[1]));
        if (face !== 4 || cell[2] !== 100 || near !== 1) continue;
        sum[i] += noisy[i * 4];
        ring.set(i, [cell[0], cell[1]]);
      }
    }
    let ratio = 0;
    let n = 0;
    for (const [i, [x, y]] of ring) {
      // The face's centre point, and the unshadowed light there as lighting.wgsl computes it.
      const at = [(x + 0.5) * 0.1, (y + 0.5) * 0.1, 10.0];
      const d = [light.position[0] - at[0], light.position[1] - at[1], light.position[2] - at[2]];
      const dist = Math.hypot(d[0], d[1], d[2]);
      const ndl = Math.max(-d[2] / dist, 0);
      const win = Math.min(1, Math.max(0, 1 - (dist / light.radius) ** 4));
      const unshadowed = (light.intensity * ndl * win * win) / (dist * dist + 1);
      if (unshadowed <= 0) continue;
      ratio += sum[i] / 64 / unshadowed;
      n++;
    }
    for (const b of [world.table, world.sectors, world.heap, world.palette, world.pyramid]) b.destroy();
    return { ring: n, ratio: ratio / n, errors: [...g.errors] };
  },
};
