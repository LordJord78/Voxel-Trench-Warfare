# Showcase, Milestone 4: Quality Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first visit whose machine cannot hold the high preset within the budget, even at dynamic resolution's floor, is moved to the low preset as the world is first drawn, and told so in a line. A visitor's own choice of preset is kept and never overridden. A machine that holds the high preset never sees the note.

**Architecture:**
- **The settings** (`src/ui/settings.ts`) keep `presetChosen`, set when the visitor picks a preset in the pause menu.
- **The warm-up** (`src/app/tiers.ts`, `pickPreset`, pure) judges 120 frames drawn after the world is first drawn: its last 60, their dynamic-resolution scale and their GPU time.
- **`main.ts`** runs the warm-up behind the loading screen, or into play if the visitor clicks first. It moves the renderer and the session's settings to low (not saved, so the next visit warms up again) and shows the note (`#note`) for 8 s.
- **`?budget=<ms>`** overrides the GPU budget, so tests can force the move on a fast machine.

**Tech Stack:** TypeScript, Vitest, Playwright (Chrome).

**Spec:** docs/superpowers/specs/2026-10-25-trenchline-web-showcase-design.md (done-table row 4; §4; build order item 4).

## Global Constraints

- **The tiers are the presets that exist** (high, low) with dynamic resolution between 50% and 100% per axis; no new preset.
- **Never overridden:** a preset the visitor chose (`presetChosen`) is kept on every visit, and the warm-up never runs over it. The warm-up moves high to low, never low to high.
- **Not kept:** the move is for this visit; the next visit warms up again.
- **Inert where it should be:**
  - in a check run;
  - without GPU timestamps;
  - with dynamic resolution off;
  - when the renderer's preset is no longer high by the warm-up's end (a test or the visitor changed it);
  - on a machine that holds the budget. This machine at the high preset holds it: every view within 14 ms.
- **The approved look and the perf gates are untouched;** every earlier test passes.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays on `web/world`, and nothing is pushed.

## Rulings made in planning

1. **The judgement:**
   - It uses the last 60 of the first 120 frames after the world is first drawn; dynamic resolution adjusts every 30 frames, so by frame 60 it has had two goes.
   - The move is made when every one of those frames sat at the floor (scale ≤ 0.5) and their median GPU time is over the budget.
   - Frames without a GPU time do not count; fewer than 30 counted, no move.
2. **The budget it judges against** is the one the page started with (`render.gpu_budget_ms`, or `?budget=`), not one a test sets later.
3. **The note** is a line at the top of the page: "Quality set to Low for this machine — change it in the pause menu (Esc)." It shows for 8 s over the loading screen or the game, whichever is up.
4. **Old settings** without `presetChosen` read as not chosen. An old stored low stays low, as the warm-up only moves from high.

## Review Focus

- **No interference with play or tests:** the warm-up never changes the preset under a visitor who chose it, nor under a test that set its own quality. Pinned in Task 2.
- **The note** shows once, over whichever screen is up, and goes. Pinned in Task 2.
- **The pause menu** marks the choice, and a chosen preset survives a reload. Pinned in Task 1.
- **A fast machine** (this one) never moves. Pinned in Task 2 (no `?budget`, no move) and by every perf test.

---

### Task 1: The visitor's choice

**Files:**
- Modify: `src/ui/settings.ts` (`presetChosen`), `src/app/main.ts` (the pause menu's preset marks it chosen).
- Test: `tests/ui/settings.test.ts`; `tests/e2e/tiers.spec.ts` (`'a preset picked in the pause menu is the visitor's own, and kept across a reload'`).

- [ ] **Step 1: Write the failing tests:**
  - `'the settings keep whether the preset was the visitor's own; old settings without it read as not'`;
  - the e2e test above.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** ("Keep the visitor's own choice of quality").

### Task 2: The warm-up

**Files:**
- Create: `src/app/tiers.ts` (`pickPreset(samples: { gpuMs: number | null; scale: number }[], budgetMs: number, floor?: number): 'low' | null`).
- Modify: `src/app/main.ts` (the warm-up; `?budget=`; the note), `index.html` (`#note`).
- Test: `tests/app/tiers.test.ts`; `tests/e2e/tiers.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - unit: `'the low preset when every judged frame sat at the floor and their median is over the budget, else none'`;
  - e2e:
    - `'with an impossible budget a first visit moves to low as the world is drawn, and says so'` (`?budget=1`: the renderer's preset low; the note shown, then gone after 8 s; the stored settings not changed);
    - `'a visitor who chose high is never moved'` (`?budget=1` with stored settings `{ preset: 'high', presetChosen: true }`);
    - `'a machine that holds the budget is never moved'` (no `?budget`: 150 frames after ready, still high, no note).
- [ ] **Step 2–4:** fail, implement, pass; a review capture of the note over the loading screen into artifacts/s4.
- [ ] **Step 5: Commit** ("Move a first visit that cannot hold the high preset to low").

### Task 3: Proof

- [ ] **Step 1: Run everything:** `npx vitest run && npx tsc --noEmit -p . && npx playwright test`, on mains power; the production load.
- [ ] **Step 2: Commit** any fix.
