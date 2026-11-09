/**
 * A shader's small arithmetic function, run on the CPU: `fn name(a: f32, ...) -> T { ... }` taken from
 * WGSL `source` and turned into JavaScript, so a unit test holds the shader's own numbers and not a copy
 * of them. Only what such a function needs: scalar parameters, `let` and `var`, `return`, min, max,
 * abs, clamp and sqrt, and vec2f to vec4f as arrays. Anything else it reads (a uniform such as
 * `frame` or `draw`, a function of the shader's) is not in scope, and throws when called: what the
 * function draws on must be passed in.
 */
export function wgslFn(source: string, name: string): (...args: number[]) => number | number[] {
  const head = new RegExp(`\\bfn\\s+${name}\\s*\\(([^)]*)\\)\\s*(?:->\\s*[\\w<>]+\\s*)?\\{`).exec(source);
  if (!head) throw new Error(`no fn ${name} in the WGSL`);
  // Its body, to the brace that closes it.
  let depth = 1;
  let end = head.index + head[0].length;
  for (; end < source.length && depth > 0; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}') depth--;
  }
  if (depth !== 0) throw new Error(`fn ${name}'s body is not closed`);
  const params = head[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.split(':')[0].trim());
  const body = source
    .slice(head.index + head[0].length, end - 1)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\b(?:let|var)\s+(\w+)\s*(?::\s*[\w<>]+)?\s*=/g, 'let $1 =')
    // A literal's f suffix (1.0f), not a name's (vec2f).
    .replace(/\b(\d+(?:\.\d*)?(?:e[+-]?\d+)?)f\b/g, '$1');
  const run = new Function('min', 'max', 'abs', 'clamp', 'sqrt', 'vec2f', 'vec3f', 'vec4f', ...params, `'use strict';\n${body}`);
  const vec = (...xs: number[]) => xs;
  const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
  return (...args: number[]) => run(Math.min, Math.max, Math.abs, clamp, Math.sqrt, vec, vec, vec, ...args);
}
