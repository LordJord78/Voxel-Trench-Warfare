# Showcase, Milestone 1: Deployable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The production build works from any path, a GitHub Actions workflow is ready to test, build and deploy it to Pages, and the README presents the web game; nothing is published.

**Architecture:** Vite builds with a relative base (`./`), so a static host can serve the site under a sub-path, as Pages serves a project. An e2e test builds the site into a scratch directory, serves it under `/Voxel-Trench-Warfare/` with Vite's preview server and plays it. The workflow (`.github/workflows/pages.yml`) runs the unit tests and the type check, builds with `VITE_SITE_URL` set from the Pages address, and deploys. The README leads with the web game.

**Tech Stack:** Vite, TypeScript, Playwright (Chrome), Vitest, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-10-25-trenchline-web-showcase-design.md (done-table rows 1 and 6; §1; §6; build order item 1).

## Global Constraints

- **Nothing is published:** no push, no merge to `main`, Pages not turned on. The workflow is committed on `web/world` only.
- **The dev server is unchanged,** and so is its report endpoint (dev-only); every earlier test passes.
- **The load budget holds:** the production build shows its prompt within 4 s (`node tools/preview-gen.mjs --prod`).
- **The workflow runs no GPU suite,** which needs a GPU: the unit tests, the type check and the build.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays on `web/world`.

## Rulings made in planning

1. **The sub-path test builds its own site** into `artifacts/s1/site` (git-ignored) through Vite's `build()` with the project's config, and serves it with `preview()` on port 5331 under `/Voxel-Trench-Warfare/`. `dist/` is left alone, for `preview-gen --prod`.
2. **The README's still** comes in milestone 2, with the stills tool. This milestone writes the text, and the links it holds are checked to exist.
3. **The workflow's checks** are by a unit test that reads the file as text: its triggers, permissions, steps and the site URL. Its YAML is parsed once locally (Ruby's YAML), and that is ledgered. No YAML library is added.

## Review Focus

- **Assets at a sub-path.** The HTML's scripts, the generation and destruction workers, and anything fetched at run time are found under `/Voxel-Trench-Warfare/`. No root-absolute URL is left in the built HTML. Pinned in Task 1.
- **The dev server and every e2e test** are unaffected by the relative base. Pinned in Task 1 (the whole suite at the milestone's end).
- **The workflow on GitHub** has the permissions, concurrency and artifact steps Pages needs, and builds with Node 22 from the lockfile. Pinned in Task 2.
- **The README** is accurate about browsers, controls and how to run it. Pinned in Task 3 (links), and by review.

---

### Task 1: A build that works from any path

**Files:**
- Modify: `vite.config.ts` (`base: './'`).
- Test: `tests/e2e/deploy.spec.ts`.

**Interfaces:**
- Produces: the built site at a sub-path, for later milestones' tests: a helper `servedBuild(base: string, port: number): Promise<{ url: string; close(): Promise<void> }>` in `tests/e2e/support/build.ts`.

- [ ] **Step 1: Write the failing test** `'the production build, served under /Voxel-Trench-Warfare/, generates the world in its workers and plays'`:
  - `servedBuild('/Voxel-Trench-Warfare/', 5331)`;
  - the built `index.html` holds no `src="/` or `href="/`;
  - the page at the sub-path is ready (`__trenchline.ready`) with no error and a prompt time over 0;
  - a click on `#play` hides the loading screen;
  - 60 frames are drawn;
  - no console or page errors.
- [ ] **Step 2: Run it to see it fail.** Expected: the page never becomes ready (its scripts are asked for at the root).
- [ ] **Step 3: Implement** the relative base.
- [ ] **Step 4: Run it to see it pass,** and `node tools/preview-gen.mjs --prod` after `npm run build`. Expected: the prompt within 4 s.
- [ ] **Step 5: Commit** ("Build the site to work from any path").

### Task 2: The Pages workflow

**Files:**
- Create: `.github/workflows/pages.yml`.
- Test: `tests/tools/pages-workflow.test.ts`.

- [ ] **Step 1: Write the failing test** `'the Pages workflow tests, builds and deploys on a push to main, and by hand'`. It asserts, reading the file as text:
  - `push` to `main` and `workflow_dispatch`;
  - `permissions` with `pages: write` and `id-token: write`;
  - a `concurrency` group;
  - Node 22 with `npm ci`;
  - `npx vitest run` and `npx tsc --noEmit -p .`;
  - `npm run build` with `VITE_SITE_URL` from `actions/configure-pages`;
  - `actions/upload-pages-artifact` of `dist`;
  - `actions/deploy-pages` in a second job that needs the first.
- [ ] **Step 2: Run it to see it fail** (no file).
- [ ] **Step 3: Write the workflow.** Parse it with `ruby -ryaml -e 'YAML.load_file(".github/workflows/pages.yml")'`, and ledger that it parses.
- [ ] **Step 4: Run it to see it pass.**
- [ ] **Step 5: Commit** ("Ready a workflow to publish the site to Pages").

### Task 3: The README

**Files:**
- Modify: `README.md`.
- Test: `tests/tools/readme.test.ts`.

- [ ] **Step 1: Write the failing test** `'the README leads with the web game, and every link it holds exists'`:
  - its first section names WebGPU, the browsers (Chrome or Edge 113+, Safari 26), and the controls;
  - every relative link's file exists.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Write the README,** as the spec's §6 has it (the still waits for milestone 2).
- [ ] **Step 4: Run it to see it pass;** then the whole suite (`npx vitest run && npx tsc --noEmit -p . && npx playwright test`) on mains power. Expected: all green.
- [ ] **Step 5: Commit** ("Present the web game in the README").
