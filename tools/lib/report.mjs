// A capture tool's report (artifacts/sp7/<tool>/report.json): an entry per capture, kept across runs of a
// few of them (--only), each stamped with the commit it was taken at and when, so a review reads which
// build drew what. A capture that does not finish leaves its failure in its entry and none of its
// pictures: a review never reads an older run's pictures as this one's.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** The commit the tree is at, whether it has changes not committed (null for each outside a repository), and now. */
export function stamp(cwd = process.cwd(), now = new Date()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit = null;
  let dirty = null;
  try {
    commit = git('rev-parse', 'HEAD');
    dirty = git('status', '--porcelain') !== '';
  } catch {
    // Not a repository, or no git: the entry says so by its nulls.
  }
  return { commit, dirty, at: now.toISOString() };
}

/** The report a run of a few captures adds to: the last run's, or none. */
export function readReport(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

export function writeReport(path, report) {
  writeFileSync(path, JSON.stringify(report, null, 2));
}

/** A capture's entry when it did not finish: its failures, stamped, and nothing measured. */
export const failedEntry = (failures, stamped) => ({ failures: [...failures], ...stamped });

/** A capture's pictures removed (those there are): a failed capture shows none. */
export function removePictures(paths) {
  for (const p of paths) rmSync(p, { force: true });
}
