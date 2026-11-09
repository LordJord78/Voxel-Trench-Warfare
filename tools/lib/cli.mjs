// The tools' shared command line: what each capture or render tool takes (tools/range-captures.mjs,
// tools/render-sounds.mjs). Plain JS, so the tools and the tests read the same code.

/**
 * What `argv` (a run's arguments) asks for of `names`: `--only a,b` or `--only=a,b`, each one of
 * `names`; none asked, null (every one). A missing list, or a name that is none of them, is an error
 * for the run to print with its usage, saying what it lists in `noun` (singular: "capture", "render").
 */
export function parseOnly(argv, names, noun) {
  const at = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (at < 0) return { only: null };
  const value = argv[at] === '--only' ? argv[at + 1] : argv[at].slice('--only='.length);
  if (value === undefined || value === '' || value.startsWith('--')) return { error: `--only: no list of ${noun}s` };
  const only = value.split(',');
  const unknown = only.find((n) => !names.includes(n));
  if (unknown !== undefined) return { error: `--only: no ${noun} ${unknown}` };
  return { only };
}
