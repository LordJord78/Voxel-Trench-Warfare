# Showcase, Milestone 2: First Impression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the first paint the page shows the title over a still of the game (the first view the live world draws: the firing step's view over the parapet at dusk), which crossfades to the live world at the same view when it is drawn. Link previews carry a title, a description and an image. The production build still shows its prompt within 4 s.

**Architecture:**
- **The stills tool** (`tools/stills.mjs`, `npm run stills`) opens the game in Chrome through Playwright at 1920 × 1200 and hides the loading screen. Once the world's histories have settled, it photographs the first view the live world draws. It writes `public/stills/dusk.webp` (cwebp) and `public/stills/og.jpg`, a 1200 × 630 crop (ffmpeg).
- **The page** holds the still as a plain image under the loading screen's title block. The still is fitted to the window's width and centred, as the camera's field of view is horizontal. The loading screen carries its scrim from the start. When the world is first drawn (`LoadingScreen.ready`), the still fades out over 0.8 s.
- **The page's head** gains a description, Open Graph and Twitter tags, a theme colour and an SVG favicon. A small Vite plugin makes the preview image's URL absolute when `VITE_SITE_URL` is set.

**Tech Stack:** TypeScript, Vite, Playwright (Chrome), Vitest, cwebp, ffmpeg.

**Spec:** docs/superpowers/specs/2026-10-25-trenchline-web-showcase-design.md (done-table row 2; §2; build order item 2).

## Global Constraints

- **The still is the game's own:** rendered by it, never painted or edited by hand, and made again by `npm run stills` when the look changes.
- **First paint:** the still is the page's largest contentful paint within 1 s of navigation, in the production build served at a sub-path.
- **The load budget holds:** the production build shows its prompt within 4 s (`node tools/preview-gen.mjs --prod`).
- **The approved look is unchanged:** the renderer is not touched.
- **Unit tests run without the GPU tools:** the Pages workflow runs them on Ubuntu without ffmpeg or cwebp, so image sizes are read from the files' headers in TypeScript.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays on `web/world`, and nothing is pushed.

## Rulings made in planning

1. **The still is fitted to the window's width and centred vertically,** not cropped to cover. The camera keeps a horizontal field of view whatever the aspect, so this framing matches the live render at every window shape: a taller window shows night above and below the still, a wider one crops it top and bottom, as the render does.
2. **The loading screen wears its scrim from the start,** not the solid night: the still is the world until the world is drawn.
3. **First paint is measured as Chrome's largest contentful paint** of the still, against the production build served under `/Voxel-Trench-Warfare/` (S1's `servedBuild`).
4. **The still against the live view:** both are reduced to a 16 × 10 grid of mean luma. The grids must correlate at ≥ 0.95, with means within 10% (the battle's light drift and the WebP's loss allowed). The two images are also ledgered side by side for review.
5. **The tool runs at the defaults a first visit has:** the high preset, dynamic resolution off, the settings' default field of view, the clock's dusk key, and the front at light. It waits 240 frames after the world is first drawn.

## Review Focus

- **The crossfade** at the same view: no jump in framing at any window shape (16:10, 16:9, 4:3, 21:9). Pinned in Task 2 (the grid match at 16:10), and by review captures at the other shapes.
- **A first visit on a slow connection or a failed still:** the title and progress still show on the night colour, and nothing waits on the image. Pinned in Task 2 (the still blocked, the game still loads).
- **The failure sheet** (no WebGPU) still reads over the still. Pinned in Task 2.
- **Link previews:** absolute image URLs when the site's address is known, relative otherwise, and valid tags. Pinned in Task 3.
- **The load budget,** with the image in the page. Pinned in Task 2.

---

### Task 1: The backdrop, the stills tool and the stills

**Files:**
- Create: `tools/stills.mjs`; `public/stills/dusk.webp`, `public/stills/og.jpg` (made by the tool); `tests/support/image-size.ts` (PNG, JPEG and WebP sizes from their headers).
- Modify: `package.json` (`"stills": "node tools/stills.mjs"`); `src/app/main.ts` (until the click, the frame's pose is the `step` view at the settings' field of view).
- Test: `tests/tools/stills.test.ts`; `tests/e2e/first-paint.spec.ts` (`'until the click the world is drawn from the firing step over the parapet, and the click starts play at the spawn'`).

**Interfaces:**
- Produces: `public/stills/dusk.webp` (1920 × 1440, ≤ 200 KB) and `public/stills/og.jpg` (1200 × 630, ≤ 150 KB), served at `./stills/…`; `imageSize(bytes: Uint8Array): { width: number; height: number; type: 'png' | 'jpeg' | 'webp' }`.

- [ ] **Step 1: Write the failing tests:**
  - `'image sizes are read from PNG, JPEG and WebP headers'` (small fixtures built in the test: a PNG IHDR, a JPEG SOF0, and a WebP VP8 / VP8L / VP8X header each);
  - `'the stills are the sizes the page and link previews use, and small'`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** `imageSize` and the tool, and run `npm run stills`. Look at the still, and ledger what it shows.
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit** ("Photograph the game's first view for the page").

### Task 2: The still behind the loading screen

**Files:**
- Modify: `index.html` (the still and its styles; the loading screen's scrim from the start), `src/ui/loading.ts` (the still faded and hidden at `ready`).
- Test: `tests/e2e/first-paint.spec.ts`; `tests/ui/loading.test.ts` (or the nearest).

**Interfaces:**
- Consumes: Task 1's stills; S1's `servedBuild`.

- [ ] **Step 1: Write the failing tests:**
  - `'the still is the page's largest contentful paint within 1 s of navigation'` (the production build at `/Voxel-Trench-Warfare/`);
  - `'when the world is drawn the still fades out over 0.8 s, and the live world is the same view'`: the grid match of ruling 4, the page at 1920 × 1200, the live frame taken 240 frames after ready with the loading screen hidden;
  - `'with the still blocked the game loads, the title over the night'` (the still's request aborted);
  - `'the failure sheet reads over the still'` (`navigator.gpu` removed: the message shows over it).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** as rulings 1 and 2 set out.
- [ ] **Step 4: Run them to see them pass;** then `npm run build && node tools/preview-gen.mjs --prod`. Expected: the prompt within 4 s. Take review captures of the loading screen over the still at 16:9, 4:3 and 21:9 into `artifacts/s2`.
- [ ] **Step 5: Commit** ("Show the game's still from the first paint").

### Task 3: The page's head

**Files:**
- Create: `public/favicon.svg`; `tools/vite-plugin-site.ts` (`sitePlugin()`: `%SITE%` in index.html becomes `VITE_SITE_URL` with a trailing slash, or `./` without).
- Modify: `index.html` (description, `og:title`, `og:description`, `og:type`, `og:image` = `%SITE%stills/og.jpg`, `twitter:card` = `summary_large_image`, `twitter:image`, `theme-color` #17141f, the favicon), `vite.config.ts`.
- Test: `tests/tools/site.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `'the page's head describes the game for link previews'` (index.html read as text: every tag above, the image named under `%SITE%`);
  - `'the preview image's address is whole when the site's is known, and relative otherwise'`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass,** and `VITE_SITE_URL=https://lordjord78.github.io/Voxel-Trench-Warfare/ npm run build`. Then read the built `og:image` and ledger it.
- [ ] **Step 5: Commit** ("Describe the game for link previews").

### Task 4: The README's still, and proof

**Files:**
- Modify: `README.md` (the still at the top).

- [ ] **Step 1:** The README leads with `public/stills/dusk.webp`; the README test (every relative link exists) covers it.
- [ ] **Step 2: Run everything:** `npx vitest run && npx tsc --noEmit -p . && npx playwright test`, on mains power. Expected: all green.
- [ ] **Step 3: Commit** ("Lead the README with the game's still").
