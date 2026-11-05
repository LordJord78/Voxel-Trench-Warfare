// Types for report.mjs (a capture tool's report), for the tests that read it.

export interface Stamp {
  commit: string | null;
  dirty: boolean | null;
  at: string;
}

export function stamp(cwd?: string, now?: Date): Stamp;
export function readReport(path: string): Record<string, unknown>;
export function writeReport(path: string, report: Record<string, unknown>): void;
export function failedEntry(failures: readonly string[], stamped: Stamp): { failures: string[] } & Stamp;
export function removePictures(paths: readonly string[]): void;
