/**
 * Where the game cannot run (the showcase spec's §3), the page shows a video of it instead. That
 * covers a browser without WebGPU, a GPU that gives no adapter, a renderer that fails to start, and a
 * phone or tablet (touch alone), which may still try it. The video is the game's own (npm run video).
 * It fills the page behind the title, as the live world would; its element is made only here, so a
 * visitor who can play downloads none of it.
 */

export type FallbackReason = 'no-webgpu' | 'no-adapter' | 'failed' | 'touch';

/**
 * What the page knows of where it runs:
 * - whether it has WebGPU;
 * - whether an adapter was given (undefined: not asked yet);
 * - whether the renderer failed to start;
 * - whether its pointers are coarse, and whether any is fine.
 */
export interface Place {
  gpu: boolean;
  adapter?: boolean;
  failed?: boolean;
  coarse: boolean;
  fine: boolean;
}

/** Why the page shows the video instead of the game, or null to play it. */
export function fallbackReason(p: Place): FallbackReason | null {
  if (!p.gpu) return 'no-webgpu';
  if (p.adapter === false) return 'no-adapter';
  if (p.failed) return 'failed';
  // Touch alone: a tablet with a mouse or trackpad plays.
  if (p.coarse && !p.fine) return 'touch';
  return null;
}

/** The page's own place, before WebGPU is asked for an adapter. */
export function placeHere(win: Window): Place {
  return { gpu: 'gpu' in win.navigator, coarse: win.matchMedia('(pointer: coarse)').matches, fine: win.matchMedia('(any-pointer: fine)').matches };
}

/** What the page says under the video, by why it shows it. */
export function fallbackLine(reason: FallbackReason): string {
  return reason === 'touch'
    ? "It's played with a keyboard and mouse. Here it is in motion."
    : 'Here it is in motion — or open it in Chrome or Edge, or Safari 26, on a computer.';
}
