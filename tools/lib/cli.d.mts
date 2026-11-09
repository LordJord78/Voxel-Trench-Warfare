// Types for cli.mjs (the tools' shared command line), for the tools and the tests that read it.

/** What --only asked for of `names` (null: every one), or the error to print with the usage. */
export function parseOnly(argv: readonly string[], names: readonly string[], noun: string): { only: string[] | null } | { error: string };
