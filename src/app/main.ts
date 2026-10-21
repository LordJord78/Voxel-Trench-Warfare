// Bootstrap. For now it only reports whether this browser can run the renderer.
const statusEl = document.getElementById('status')!;
statusEl.textContent = `TRENCHLINE — building\nWebGPU available: ${'gpu' in navigator ? 'yes' : 'no'}`;

export {};
