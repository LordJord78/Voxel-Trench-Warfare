# TRENCHLINE for the web — sub-project 5: the showcase

Written under the user's standing instruction (build out without stopping; ask only if super necessary). The design decisions are the agent's, and the user has not reviewed this spec, as for sub-projects 2–4. Two steps are the user's and are only prepared here: publishing the site (pushing and turning on GitHub Pages) and changing the user's portfolio site, which is not under version control.

## Why

Sub-projects 1–4 built the game: a front-line trench at 10 cm a voxel, lit from dusk into night, that a visitor can walk, fight in and watch the battle around. It runs from a dev server on the user's machine. A portfolio piece has to work for someone who follows a link:
- it must be reachable as a static site;
- its first seconds must look like the game, not a blank page;
- it must hold its frame rate on the visitor's machine, not only on the user's M1 Pro;
- where it cannot run (a browser without WebGPU, a phone), it must still show what it is;
- the user's portfolio site needs a card that leads to it.

It is built on what exists:
- the production build (Vite), 820 KB, which generates the world in the browser and needs no cross-origin isolation, so plain static hosting serves it;
- the loading screen (a trench-trace progress, the click to play, a failure that stays);
- the two presets and dynamic resolution (sub-project 2), and the settings the pause menu keeps;
- the test hooks that fly the camera, set the clock, run the battle and step frames one at a time;
- the GitHub repository (public; Pages not enabled), and ffmpeg and cwebp on the user's machine.

## What "done" means for this sub-project

| # | Criterion | Measured by |
|---|---|---|
| 1 | **Deployable:** the production build works from any path. Served under a sub-path, as GitHub Pages serves a project (`/Voxel-Trench-Warfare/`), it loads, generates the world and plays in Chrome, its workers and assets found. A GitHub Actions workflow tests, builds and deploys it to Pages on a push to `main`. Nothing is pushed and Pages is not turned on without the user. | e2e against the build at a sub-path; the workflow file; review |
| 2 | **First impression:** within 1 s of navigation the page shows the title over a still of the game: the first view the live world draws, at dusk, as approved. When the world is drawn it takes the still's place by a crossfade at the same view. A shared link previews with a title, a description and an image. The production build still shows its prompt within 4 s. | e2e; `tools/preview-gen.mjs --prod`; review |
| 3 | **Video fallback:** where the game cannot run, the page shows a 20–30 s video of it (dusk in the bay, over the parapet, night falling under flares and tracers, a barrage, the hamlet burning), looping and muted, and says why in a sentence and what would run it. That covers a browser without WebGPU, a GPU that gives no adapter, a renderer that fails to start, and a phone or tablet (touch alone), which may still "try it anyway". The video is recorded from the game itself, 1280 × 720 at 30 fps, as H.264 and VP9, each ≤ 6 MB, and costs nothing to a visitor who can play. | e2e (WebGPU removed; touch emulated); ffprobe of the files; review |
| 4 | **Quality tiers:** a first visit whose machine cannot hold the high preset within the budget, even at dynamic resolution's floor, is moved to the low preset before play begins, and told so in a line on the loading screen. A visitor's own choice of preset in the pause menu is kept and never overridden. A machine that holds the high preset never sees the note. | unit tests; e2e with the budget forced down; review |
| 5 | **Portfolio card:** a card for the user's portfolio site, in its own markup and classes, with a square thumbnail of the game and the links to the repository and the live site, ready to paste, with a note on how. A review capture shows it among the site's projects. The user's site itself is changed only with their go-ahead. | review capture; review |
| 6 | **The repository's front page:** the README presents the web game: what it is, a still, how to play, which browsers run it, how it is built and tested, and how it is deployed. | review |
| 7 | **Nothing lost:** every earlier test passes; the perf gates and the load budget hold. | the whole suite; the production load |

## 1. A build that works from any path

- **Relative base:** Vite builds with `base: './'`, so the HTML, scripts, workers and public files are found under whatever path serves them. The dev server is unchanged; its report endpoint stays dev-only.
- **The site's address,** where a page needs it absolute (the link preview's image), comes from `VITE_SITE_URL` at build time. The Pages workflow sets it from the Pages URL; without it the image is relative, which local previews accept.
- **The workflow** (`.github/workflows/pages.yml`) runs on a push to `main` and by hand:
  - one job tests and builds: the unit tests, the type check, the production build;
  - a second deploys the build to Pages, with the permissions Pages asks for.
  - It cannot run the GPU suites, which need a GPU; those stay local, as now.
- **Proof:** an e2e test builds the site into a scratch directory, serves it under `/Voxel-Trench-Warfare/` with Vite's preview server, and plays it: the world generated in its workers, the prompt, a click, frames drawn, no errors.

## 2. The first impression

- **The still** is the first view the live world draws (the spawn, at the clock's dusk key), rendered by the game, converged, at the high preset. It is captured by a tool (`npm run stills`), never by hand, so it is made again when the look changes.
- **Its forms:**
  - a WebP at 1920 × 1200 for the loading screen (≤ 200 KB);
  - a 1200 × 630 JPEG for link previews;
  - a square 1080 × 1080 crop for the portfolio card.
- **On the page** the still lies behind the loading screen's title block and its scrim, from the first paint. When the world is first drawn, the still fades out over 0.8 s and the live world is there at the same view. It is a plain image in the HTML, preloaded, so it paints before the scripts run, and it does not hold up generation.
- **The page's head:**
  - a description;
  - Open Graph and Twitter card tags (title, description, image, type);
  - a theme colour (the night sky's);
  - an SVG favicon: the trench trace's red bay and traverse.

## 3. The video fallback

- **When:**
  - `navigator.gpu` is missing;
  - `requestAdapter()` gives nothing;
  - the device has touch and no fine pointer (`(pointer: coarse)` without `(any-pointer: fine)`): a phone or tablet. Only this case offers "Try it anyway", which loads the game as on a desktop.
- **What the page shows:**
  - the title block;
  - the video (autoplay, muted, looping, inline; its poster the still; WebM then MP4);
  - a sentence of why and what would run it, e.g. "This browser can't draw it: it needs WebGPU. Here it is in motion — or open it in Chrome or Edge, or Safari 26, on a computer."
  - The video element is made only when the page falls back, so a visitor who can play downloads none of it.
- **The recording** (`npm run video`, `tools/record-video.mjs`):
  - Chrome through Playwright, 1280 × 720, at the high preset, the game frozen and stepped two frames (1/60 s each) per video frame.
  - It flies a scripted path in five shots, each held for 20 frames before it is recorded, so its histories settle:
    1. along the bay at dusk;
    2. rising over the parapet to no man's land at dusk, a barrage on the horizon;
    3. no man's land at night under the heavy battle's flares and tracers;
    4. the hamlet burning;
    5. the overview at night.
  - The frames are encoded with ffmpeg (H.264 at CRF 26 with faststart; VP9 at CRF 36) into `public/video/`. If either file is over 6 MB, the CRF is raised until it fits.
- The fallback is also what the page shows when the renderer fails to start on a browser that has WebGPU (its device lost or refused while loading). The failure line stays, and the video plays below it.

## 4. Quality tiers

- **The tiers are the presets that exist:** high (1.5 MP, lit at one pixel in four) and low. Dynamic resolution holds the frame under the budget within either preset, between 50% and 100% of the image per axis.
- **The visitor's choice:** the settings keep whether the preset was the visitor's own (`presetChosen`, set when they pick one in the pause menu). A chosen preset is kept on every visit.
- **The warm-up:** this only happens on a visit whose preset is not chosen and whose GPU gives timestamps. When the world is first drawn behind the loading screen, before the click, the renderer draws 120 frames at high. If dynamic resolution has fallen to its floor by the last 60 and their median GPU time is over the budget, the preset becomes low. The loading screen then says: "Quality set to Low for this machine — change it in the pause menu (Esc)." The move is not kept: the next visit warms up again.
- **For tests:** `?budget=<ms>` overrides the GPU budget, so the drop can be forced on a fast machine.

## 5. The portfolio card

- **`showcase/portfolio/`** holds what the user needs:
  - `card.html`: the card, in the site's `details-container color-container` markup with its `project-img`, `project-title` and `btn-container` classes;
  - `trenchline.png`: the square thumbnail;
  - `README.md`: copy the image into `assets/` and paste the card first in `#projects`.
- **The links:** the repository and `https://lordjord78.github.io/Voxel-Trench-Warfare/` (the Pages address the workflow would publish to).
- **The review capture** opens the user's site from disk read-only, puts the card first among its projects in the browser's copy of the page, and photographs it. No file of the user's site is written.

## 6. The README

The repository's front page leads with the web game:
- the still;
- a paragraph on what it is;
- the controls;
- the browsers that run it (desktop Chrome or Edge 113+, Safari 26), and the video for the rest;
- how it is built: TypeScript and raw WebGPU, a voxel ray tracer, many lights with reuse, a froxel haze, a physical sky, destruction at 10 cm, and the battle around the player;
- how it is tested: unit, GPU e2e, the perf gates, the Safari report;
- how to run it, and how it is deployed.

The Python reference keeps its section.

## Testing

**Unit (Vitest):**
- the warm-up's decision (chosen, no timestamps, the floor, the median against the budget);
- the settings' `presetChosen`, kept and read back, with old settings that lack it;
- the fallback's reasons (no `gpu`, no adapter, touch alone, a device lost);
- the page's head tags (`index.html` read as text).

**e2e (Playwright, Chrome):**
- the build under a sub-path, played;
- the still painted within 1 s, then gone after the world is drawn;
- the fallback with WebGPU removed, and on a touch-only device (and "Try it anyway");
- the drop to low with `?budget=1`, and no drop with a chosen high;
- the video files probed by ffprobe (duration, size, codec, frame size).

**Review captures** (artifacts/s5):
- the loading screen over the still;
- the fallback with its video;
- the card among the portfolio's projects;
- the note after a drop to low.

## Build order

Each milestone has its own plan:

1. **Deployable:** the relative base, the build played under a sub-path, the Pages workflow, the README.
2. **First impression:** the stills tool, the still behind the loading screen and its crossfade, the page's head.
3. **Video fallback:** the recording tool and its encodes, and the fallback for no WebGPU, no adapter and touch.
4. **Quality tiers:** the chosen flag, the warm-up and the drop to low, the note.
5. **Proof:** the portfolio card and its capture, the review captures, the whole suite, the production load, Safari.

## Not in this sub-project

- Publishing: pushing to the remote, merging to `main`, and turning on Pages are the user's, asked once when this is done.
- Changing the user's portfolio site, which is not under version control: the card is prepared here, and pasting it is the user's go-ahead.
- A custom domain, analytics, cookies.
- Touch controls and phone play.
- Sound in the video.
- A server of any kind.
