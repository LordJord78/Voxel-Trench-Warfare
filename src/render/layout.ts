/**
 * WGSL struct layout, from one definition.
 *
 * A uniform struct is declared in TypeScript as a list of fields; the WGSL
 * declaration is generated from that list and the per-frame values are
 * written through it, so the shader and the code that fills its buffer can
 * never disagree about an offset. Offsets follow the WGSL alignment rules:
 * scalars align to 4, vec2 to 8, vec3 and vec4 to 16 (a vec3 is 12 bytes, so
 * a scalar can sit in its fourth lane), a struct to its widest member, and a
 * struct's size rounds up to its alignment.
 */

export type ScalarType = 'f32' | 'u32' | 'i32';
export type VectorType = 'vec2f' | 'vec2u' | 'vec3f' | 'vec3u' | 'vec4f' | 'vec4u';
export interface StructDef {
  name: string;
  fields: readonly (readonly [string, WgslType])[];
}
export interface ArrayDef {
  element: WgslType;
  count: number;
}
export type WgslType = ScalarType | VectorType | StructDef | ArrayDef;

interface Shape {
  size: number;
  align: number;
}

const BASIC: Record<ScalarType | VectorType, Shape & { kind: ScalarType; lanes: number }> = {
  f32: { size: 4, align: 4, kind: 'f32', lanes: 1 },
  u32: { size: 4, align: 4, kind: 'u32', lanes: 1 },
  i32: { size: 4, align: 4, kind: 'i32', lanes: 1 },
  vec2f: { size: 8, align: 8, kind: 'f32', lanes: 2 },
  vec2u: { size: 8, align: 8, kind: 'u32', lanes: 2 },
  vec3f: { size: 12, align: 16, kind: 'f32', lanes: 3 },
  vec3u: { size: 12, align: 16, kind: 'u32', lanes: 3 },
  vec4f: { size: 16, align: 16, kind: 'f32', lanes: 4 },
  vec4u: { size: 16, align: 16, kind: 'u32', lanes: 4 },
};

const roundUp = (align: number, n: number) => Math.ceil(n / align) * align;
const isStruct = (t: WgslType): t is StructDef => typeof t === 'object' && 'fields' in t;
const isArray = (t: WgslType): t is ArrayDef => typeof t === 'object' && 'element' in t;

function shape(t: WgslType): Shape {
  if (isStruct(t)) {
    const l = structLayout(t);
    return { size: l.size, align: l.align };
  }
  if (isArray(t)) {
    const e = shape(t.element);
    return { size: roundUp(e.align, e.size) * t.count, align: e.align };
  }
  return BASIC[t];
}

export function structLayout(def: StructDef): { size: number; align: number; offsets: Record<string, number> } {
  const offsets: Record<string, number> = {};
  let end = 0;
  let align = 1;
  for (const [name, type] of def.fields) {
    const s = shape(type);
    const offset = roundUp(s.align, end);
    offsets[name] = offset;
    end = offset + s.size;
    align = Math.max(align, s.align);
  }
  return { size: roundUp(align, end), align, offsets };
}

function typeName(t: WgslType): string {
  if (isStruct(t)) return t.name;
  if (isArray(t)) return `array<${typeName(t.element)}, ${t.count}>`;
  return t;
}

/** The declarations of `def` and every struct it uses, each once, users last. */
export function structWgsl(def: StructDef): string {
  const done = new Set<string>();
  const out: string[] = [];
  const visit = (t: WgslType) => {
    if (isArray(t)) return visit(t.element);
    if (!isStruct(t) || done.has(t.name)) return;
    for (const [, field] of t.fields) visit(field);
    done.add(t.name);
    out.push(`struct ${t.name} {\n${t.fields.map(([n, ft]) => `  ${n}: ${typeName(ft)},`).join('\n')}\n}`);
  };
  visit(def);
  return out.join('\n\n');
}

/** A buffer laid out as `def`, written field by field with dotted paths ('cam.origin', 'pyramid.3'). */
export class StructWriter {
  readonly buffer: ArrayBuffer;
  private readonly f32: Float32Array;
  private readonly u32: Uint32Array;
  private readonly i32: Int32Array;
  private readonly def: StructDef;

  constructor(def: StructDef) {
    this.def = def;
    this.buffer = new ArrayBuffer(structLayout(def).size);
    this.f32 = new Float32Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
    this.i32 = new Int32Array(this.buffer);
  }

  set(path: string, value: number | readonly number[]): void {
    let type: WgslType = this.def;
    let offset = 0;
    for (const part of path.split('.')) {
      if (isStruct(type)) {
        const field: readonly [string, WgslType] | undefined = type.fields.find(([n]) => n === part);
        if (!field) throw new Error(`${this.def.name} has no field '${path}'`);
        offset += structLayout(type).offsets[part];
        type = field[1];
      } else if (isArray(type)) {
        const i = Number(part);
        if (!Number.isInteger(i) || i < 0 || i >= type.count) throw new Error(`'${path}' indexes outside its array`);
        const e = shape(type.element);
        offset += roundUp(e.align, e.size) * i;
        type = type.element;
      } else {
        throw new Error(`'${path}' goes inside a ${type}`);
      }
    }
    if (isStruct(type) || isArray(type)) throw new Error(`'${path}' is not a scalar or vector`);
    const { kind, lanes } = BASIC[type];
    const values = typeof value === 'number' ? [value] : value;
    if (values.length !== lanes) throw new Error(`'${path}' takes ${lanes} value(s), got ${values.length}`);
    const view = kind === 'f32' ? this.f32 : kind === 'u32' ? this.u32 : this.i32;
    values.forEach((v, k) => (view[offset / 4 + k] = v));
  }
}
