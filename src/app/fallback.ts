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

/** The page's own place, before WebGPU is asked for an adapter: WebGPU there as the renderer needs it (a navigator.gpu, not merely the name). */
export function placeHere(win: Window): Place {
  return { gpu: Boolean((win.navigator as Navigator & { gpu?: unknown }).gpu), coarse: win.matchMedia('(pointer: coarse)').matches, fine: win.matchMedia('(any-pointer: fine)').matches };
}

/** What the page says under the video, by why it shows it (without WebGPU, the failure itself names the browsers). */
export function fallbackLine(reason: FallbackReason): string {
  if (reason === 'touch') return "It's played with a keyboard and mouse. Here it is in motion.";
  if (reason === 'no-webgpu') return 'Here it is in motion.';
  return 'Here it is in motion — or open it in Chrome or Edge, or Safari 26, on a computer.';
}

/**
 * The video behind the loading screen's block, where the still is, filling the page; and what the
 * page says:
 * - for a failure, a line under the failure's own status;
 * - for touch, the status itself (nothing is loading), and a button that tries the game anyway: the
 *   video goes, the progress comes back, and `tryAnyway` runs.
 */
export function showFallback(doc: Document, reason: FallbackReason, tryAnyway?: () => void): HTMLVideoElement {
  const video = doc.createElement('video');
  video.id = 'motion';
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  // The attributes too: autoplay is allowed to a muted, inline video, and some browsers read them.
  for (const a of ['muted', 'loop', 'autoplay', 'playsinline']) video.setAttribute(a, '');
  video.poster = './stills/dusk.webp';
  video.preload = 'auto';
  for (const [src, type] of [['./video/trenchline.webm', 'video/webm'], ['./video/trenchline.mp4', 'video/mp4']]) {
    const source = doc.createElement('source');
    source.src = src;
    source.type = type;
    video.append(source);
  }
  doc.getElementById('still')?.after(video);
  const status = doc.getElementById('status')!;
  // Its control, as a looping video must have (WCAG 2.2.2): Pause while it plays, Play while it waits.
  // Where motion is reduced it waits to be asked; where the browser refuses to play it, it waits too.
  const toggle = doc.createElement('button');
  toggle.id = 'motion-toggle';
  toggle.type = 'button';
  const label = () => (toggle.textContent = video.paused ? 'Play' : 'Pause');
  video.addEventListener('play', label);
  video.addEventListener('pause', label);
  toggle.onclick = () => (video.paused ? void video.play().catch(label) : video.pause());
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) {
    video.autoplay = false;
    video.removeAttribute('autoplay');
  }
  if (reason === 'touch') {
    // An SVG element: hidden by its attribute (index.html's [hidden] rule), as SVG has no hidden property.
    const trace = doc.querySelector('#loading .trace');
    const was = status.textContent;
    status.textContent = fallbackLine(reason);
    trace?.setAttribute('hidden', '');
    const button = doc.createElement('button');
    button.id = 'anyway';
    button.type = 'button';
    button.textContent = 'Try it anyway';
    button.onclick = () => {
      video.pause();
      video.remove();
      toggle.remove();
      button.remove();
      status.textContent = was;
      trace?.removeAttribute('hidden');
      tryAnyway?.();
    };
    status.after(button);
    button.after(toggle);
  } else {
    const line = doc.createElement('p');
    line.id = 'motion-line';
    line.textContent = fallbackLine(reason);
    status.after(line);
    line.after(toggle);
  }
  label();
  if (!still) void video.play().then(label, label);
  return video;
}
