# Showcase, Milestone 3: Video Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Where the game cannot run, the page shows a 20–30 s video of it in place of the game, says why in a sentence and what would run it, and costs a visitor who can play nothing. The cases are a browser without WebGPU, a GPU that gives no adapter, a renderer that fails to start, and a phone or tablet; the last may "try it anyway".

**Architecture:**
- **The video** is recorded from the game itself by `tools/record-video.mjs` (`npm run video`):
  - Chrome through Playwright, at 1280 × 720 and the high preset;
  - the game frozen, and stepped two frames (1/60 s each) per video frame;
  - five shots flown along scripted paths with a new `glide(pose)` hook, which moves the flying camera without starting its histories afresh;
  - encoded by ffmpeg into `public/video/trenchline.webm` (VP9) and `.mp4` (H.264, faststart).
- **The fallback** (`src/app/fallback.ts`) is in two parts:
  - `fallbackReason(place)`, pure, says whether and why the page falls back;
  - `showFallback(doc, reason, tryAnyway?)` puts the video (made only then) behind the loading screen's block, filling the page where the still is, with the still as its poster, and puts its line under the block's status.
- **`main.ts`** wires it in:
  - a touch-only device is asked before anything is generated;
  - a failure to start (no WebGPU, no adapter, the device refused or lost while loading) falls back after the failure's own line.

**Tech Stack:** TypeScript, Playwright (Chrome), Vitest, ffmpeg (libx264, libvpx-vp9), ffprobe.

**Spec:** docs/superpowers/specs/2026-10-25-trenchline-web-showcase-design.md (done-table row 3; §3; build order item 3).

## Global Constraints

- **The video is the game's own:** recorded by the tool from the live renderer, never edited by hand; made again with `npm run video`.
- **1280 × 720 at 30 fps, 20–30 s;** H.264 (CRF 26, faststart) and VP9 (CRF 36), each ≤ 6 MB, with the CRF raised until it fits.
- **Free to a visitor who can play:** no video request on a normal load, as the element is made only when the page falls back.
- **The load budget holds:** the production prompt within 4 s.
- **Unit tests run without the GPU tools** (the Pages workflow): the files' properties are checked by ffprobe in the e2e suite, which runs locally.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays on `web/world`, and nothing is pushed.

## Rulings made in planning

1. **The shots** (24 s, 720 frames), each set up and held 20 frames (unrecorded) for its histories, then flown:
   1. the step view at dusk, panning 12° to the right over 5 s;
   2. along the bay at dusk, at a walk (1 m/s) for 5 s;
   3. no man's land at night (21:00), the front heavy, sought to fifteen flares burning, turned to where they hang and pushed forward 2 m over 5 s;
   4. the hamlet burning (22:00), drawing 3 m toward the nearest fire over 5 s;
   5. the overview at night, heavy, sinking 4 m over 4 s.
2. **The fallback's sentence by reason:**
   - no WebGPU / no adapter / a failure: "This browser can't draw it: it needs WebGPU. Here it is in motion — or open it in Chrome or Edge, or Safari 26, on a computer."
   - touch: "It's played with a keyboard and mouse. Here it is in motion." plus a "Try it anyway" button.
3. **Touch alone** is `(pointer: coarse)` without `(any-pointer: fine)`; a tablet with a mouse plays.
4. **The failure's own line stays above the video** (the existing messages for no WebGPU, a lost device and so on); a failure after play has begun (device lost mid-game) keeps today's stop and message, without the video. A check run (`?check=`) never falls back: it reports.
5. **The video fills the page,** behind the title and the scrim, where the live world would be (`object-fit: cover`), not a player in the block: the page is the game in motion, its title over it, as when it plays.
6. **Its URLs are relative** (`./video/…`, `./stills/…`), so the site works from any path; and the fallback is tested on the production build at `/Voxel-Trench-Warfare/` too (S1's review).

## Review Focus

- **No video bytes on a normal visit.** Pinned in Task 3.
- **Autoplay** muted, inline and looping (Safari and Chrome's autoplay rules), with the poster until it plays. Pinned in Task 3.
- **"Try it anyway"** loads the game as on a desktop, the fallback gone. Pinned in Task 3.
- **The recording's smoothness:** no history reset inside a shot, and no stutter at 30 fps. Pinned in Task 2 (review of the video), and by ffprobe's frame count.
- **The files' sizes and formats** on the slowest connection a recruiter has: ≤ 6 MB each, MP4 faststart. Pinned in Task 2.

---

### Task 1: The fallback's reasons

**Files:** Create `src/app/fallback.ts` (`fallbackReason`); Test `tests/app/fallback.test.ts`.

- [ ] **Step 1: Write the failing test** `'the page falls back without WebGPU, without an adapter, on a failure to start, and on touch alone'`:
  - `fallbackReason({ gpu: false, coarse: false, fine: true })` is `'no-webgpu'`;
  - `{ gpu: true, adapter: null }` is `'no-adapter'`;
  - `{ gpu: true, failed: true }` is `'failed'`;
  - `{ gpu: true, coarse: true, fine: false }` is `'touch'`;
  - `{ gpu: true, coarse: true, fine: true }` (a tablet with a mouse) is `null`;
  - a desktop is `null`.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** ("Say when the page cannot play the game").

### Task 2: The recording tool and the video

**Files:**
- Create: `tools/record-video.mjs`; `public/video/trenchline.webm`, `public/video/trenchline.mp4` (made by the tool).
- Modify: `src/app/main.ts` (`glide(pose)`), `package.json` (`"video"`).
- Test: `tests/e2e/video.spec.ts` (`'the video is 20–30 s of 1280 × 720 at 30 fps, VP9 and H.264, each ≤ 6 MB, the MP4 faststart'`, by ffprobe); `tests/e2e/hooks.spec.ts` or the nearest (`'glide moves the flying camera without starting its histories afresh'`).

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** `glide` and the tool; run `npm run video`. Watch the video (frames sampled at 1 s) and ledger the look calls.
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit** ("Record the game for those who cannot play it").

### Task 3: The fallback on the page

**Files:**
- Modify: `src/app/fallback.ts` (`showFallback`), `src/app/main.ts`, `src/ui/loading.ts` (the fallback's place), `index.html` (its styles).
- Test: `tests/e2e/fallback.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `'without WebGPU the page shows the video playing, muted and looping, and says why'`;
  - `'with no adapter, the same'`;
  - `'on a touch-only device the video shows first, and "Try it anyway" loads the game'` (context `hasTouch`, `isMobile`; the test first checks the context reports a coarse pointer and no fine one);
  - `'a visitor who can play downloads no video'`;
  - `'the built site at a sub-path falls back with its video found'` (S1's `servedBuild`).
- [ ] **Step 2–4:** fail, implement, pass; review captures of the fallback (desktop without WebGPU; a phone) into artifacts/s3.
- [ ] **Step 5: Commit** ("Show the video where the game cannot run").

### Task 4: Proof

- [ ] **Step 1: Run everything:** `npx vitest run && npx tsc --noEmit -p . && npx playwright test`, on mains power; the production load.
- [ ] **Step 2: Commit** any fix.
