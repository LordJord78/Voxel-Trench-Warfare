/**
 * The simulation's structural rules, as a checker the architecture test runs
 * over src/. Same boundary the Python game's test_architecture.py enforced,
 * plus the determinism rule the browser needs.
 *
 * It walks a real syntax tree (Vite's bundled parser) rather than matching
 * text, so template substitutions, regex literals and destructuring cannot
 * hide a violation, and a field called `window` is not mistaken for the DOM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';

export type Violation = { file: string; line: number; rule: 'import' | 'global' | 'math'; text: string };

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FORBIDDEN = ['src/render', 'src/ui', 'src/app', 'src/audio'];

/** Browser globals (WebAudio's among them), wall-clock time and reflective global access. */
const BANNED_GLOBALS = new Set([
  'document', 'window', 'navigator', 'self', 'globalThis', 'location', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Date', 'AudioContext', 'OfflineAudioContext',
]);

/** Math members every engine computes exactly: IEEE-rounded or integer operations, and constants. */
const MATH_ALLOWED = new Set([
  'sqrt', 'floor', 'ceil', 'round', 'trunc', 'abs', 'sign', 'min', 'max', 'imul', 'fround', 'clz32',
  'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2',
]);

const CRYPTO_BANNED = new Set(['getRandomValues', 'randomUUID']);

const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'crypto', 'child_process', 'worker_threads', 'url', 'util']);

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Visit every node with its parent and the key it hangs from. */
function walk(node: Node, visit: (node: Node, parent: Node | null, key: string) => void, parent: Node | null = null, key = ''): void {
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === 'start' || k === 'end' || k === 'type') continue;
    const child = node[k];
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visit, node, k);
    } else if (isNode(child)) {
      walk(child, visit, node, k);
    }
  }
}

/** Names bound anywhere in a pattern: `a`, `{ a, b: c }`, `[a, ...b]`, `a = 1`. */
function bindings(pattern: unknown, out: Set<string>): void {
  if (!isNode(pattern)) return;
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern.name as string);
      break;
    case 'ObjectPattern':
      for (const p of pattern.properties as Node[]) bindings(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of pattern.elements as unknown[]) bindings(e, out);
      break;
    case 'RestElement':
      bindings(pattern.argument, out);
      break;
    case 'AssignmentPattern':
      bindings(pattern.left, out);
      break;
    case 'TSParameterProperty':
      bindings(pattern.parameter, out);
      break;
  }
}

/** Every name this file declares itself, so its own `GPU_BUDGET_MS` is not taken for a global. */
function declaredNames(ast: Node): Set<string> {
  const names = new Set<string>();
  walk(ast, (node) => {
    switch (node.type) {
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        bindings(node.local, names);
        break;
      case 'VariableDeclarator':
        bindings(node.id, names);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        bindings(node.id, names);
        for (const p of (node.params as unknown[]) ?? []) bindings(p, names);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'TSTypeAliasDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSEnumDeclaration':
      case 'TSModuleDeclaration':
        bindings(node.id, names);
        break;
      case 'TSTypeParameter':
        bindings(node.name, names);
        break;
      case 'CatchClause':
        bindings(node.param, names);
        break;
    }
  });
  return names;
}

/** Is this identifier a name being read, rather than a property key, label or declaration? */
function isReference(parent: Node | null, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression':
      return key !== 'property' || parent.computed === true;
    case 'Property':
      return key === 'value' || parent.computed === true;
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
    case 'TSEnumMember':
      return key !== 'key' || parent.computed === true;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'TSTypeParameter':
      return false;
    case 'TSQualifiedName':
      return key === 'left';
    case 'VariableDeclarator':
      return key === 'init';
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration':
      return key !== 'id' && key !== 'params';
    default:
      return true;
  }
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The literal specifier of an import, or the static prefix of a template one, or null if it is computed. */
function specifierOf(source: unknown): { spec: string; computed: boolean } | null {
  if (!isNode(source)) return null;
  if (source.type === 'Literal' && typeof source.value === 'string') return { spec: source.value, computed: false };
  if (source.type === 'TemplateLiteral') {
    const quasis = source.quasis as Node[];
    const head = (quasis[0]?.value as { cooked?: string })?.cooked ?? '';
    return { spec: head, computed: quasis.length > 1 };
  }
  if (source.type === 'TSLiteralType') return specifierOf(source.literal);
  return { spec: '', computed: true };
}

export function checkSource(file: string, source: string): Violation[] {
  const absolute = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
  const shown = path.relative(REPO_ROOT, absolute);
  const ast = parseAst(source, { lang: 'ts' }) as unknown as Node;
  const starts = lineStarts(source);
  const declared = declaredNames(ast);
  const found: { at: number; v: Violation }[] = [];
  const add = (at: number, rule: Violation['rule'], text: string) =>
    found.push({ at, v: { file: shown, line: lineAt(starts, at), rule, text } });

  const checkImport = (node: Node, source: unknown) => {
    const s = specifierOf(source);
    if (!s) return;
    if (s.spec.startsWith('node:') || NODE_BUILTINS.has(s.spec)) {
      add(node.start, 'import', s.spec);
      return;
    }
    if (s.spec.startsWith('.')) {
      const target = path.relative(REPO_ROOT, path.resolve(path.dirname(absolute), s.spec));
      if (FORBIDDEN.some((dir) => target === dir || target.startsWith(dir + path.sep) || (s.computed && dir.startsWith(target)))) {
        add(node.start, 'import', s.spec);
        return;
      }
    }
    if (s.computed) add(node.start, 'import', `computed import ${s.spec}…`);
  };

  walk(ast, (node, parent, key) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        if (node.source) checkImport(node, node.source);
        return;
      case 'ImportExpression':
        checkImport(node, node.source);
        return;
      case 'TSImportType':
        checkImport(node, node.argument ?? node.source);
        return;
      case 'BinaryExpression':
        if (node.operator === '**') add(node.start, 'math', '**');
        return;
      case 'AssignmentExpression':
        if (node.operator === '**=') add(node.start, 'math', '**=');
        return;
      case 'Identifier': {
        const name = node.name as string;
        if (declared.has(name) || !isReference(parent, key)) return;
        if (name === 'Math') {
          const member = parent?.type === 'MemberExpression' && key === 'object' ? parent : null;
          const prop = member && !member.computed && isNode(member.property) ? (member.property.name as string) : null;
          if (!prop || !MATH_ALLOWED.has(prop)) add(node.start, 'math', prop ? `Math.${prop}` : 'Math used as a value');
          return;
        }
        if (name === 'crypto' && parent?.type === 'MemberExpression' && key === 'object' && isNode(parent.property)) {
          if (CRYPTO_BANNED.has(parent.property.name as string)) add(node.start, 'global', `crypto.${parent.property.name}`);
          return;
        }
        if (BANNED_GLOBALS.has(name) || name.startsWith('GPU')) add(node.start, 'global', name);
        return;
      }
    }
  });

  return found.sort((a, b) => a.at - b.at).map((f) => f.v);
}

function walkFiles(dir: string, files: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, files);
    else if (/\.(m?ts|tsx)$/.test(entry.name)) files.push(full);
  }
}

/** Every source file under root/<dir>, with root taken from the repo, not the working directory. */
export function listFiles(root: string, dirs: string[]): string[] {
  const base = path.resolve(REPO_ROOT, root);
  const files: string[] = [];
  for (const dir of dirs) {
    const full = path.join(base, dir);
    if (fs.existsSync(full)) walkFiles(full, files);
  }
  return files;
}

/** Check every source file under root/<dir>; dirs that don't exist yet are skipped. */
export function checkTree(root: string, dirs: string[]): Violation[] {
  return listFiles(root, dirs).flatMap((file) => checkSource(file, fs.readFileSync(file, 'utf8')));
}
