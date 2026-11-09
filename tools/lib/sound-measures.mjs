// The sounds' proof's measures (tools/render-sounds.mjs, npm run sounds; the shots spec's §6): a voice
// rendered offline is written as a WAV, and read for its peak and RMS (dBFS) and the share of its energy
// in a band (an FFT); each file's peak is held between −30 and −1 dBFS, none may be silent, and a voice
// held to a band (the gush's 400 Hz–2 kHz) must have most of its energy in it. Plain JS, so the render
// page (tools/sounds/page.ts, which runs the FFT where it renders) and the tests read the same code.

/** A file's peak must lie in this range (dBFS): over the top it may clip, under the bottom it is too quiet. */
export const PEAK_DB = [-30, -1];
/** A file whose peak is under this (dBFS) is silent: nothing a 16-bit file holds. */
export const SILENT_DB = -90;
/** The band measure() reads unless told another (Hz). */
export const BAND = [400, 2000];

/** `x` (a linear level, full scale 1) in dBFS; −Infinity for 0. */
export const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** `samples` (full scale ±1) as a WAV of mono 16-bit PCM at `rate`: each scaled to 32767, rounded half away from zero, and clipped at full scale. */
export function wav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i])) * 32767;
    view.setInt16(44 + i * 2, Math.sign(v) * Math.round(Math.abs(v)), true);
  }
  return bytes;
}

/** An FFT in place over `re` and `im` (their length a power of 2): iterative, radix 2. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k;
        const q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci;
        const ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr;
        im[q] = im[p] - ti;
        re[p] += tr;
        im[p] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/**
 * The share of `samples`' energy (at `rate`) between `lo` and `hi` Hz: the power of its spectrum's bins
 * in the band over all of it (Parseval's), the whole file zero-padded to a power of 2. No window: a
 * window over the whole file would weigh its middle over its ends, and a voice's thud at its start
 * would count for next to nothing. A voice fades in and out, so its ends leak little. 0 for silence.
 */
export function bandShare(samples, rate, lo, hi) {
  let n = 1;
  while (n < samples.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < samples.length; i++) re[i] = samples[i];
  fft(re, im);
  let all = 0;
  let inBand = 0;
  for (let k = 0; k <= n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const hz = (k * rate) / n;
    all += p;
    if (hz >= lo && hz <= hi) inBand += p;
  }
  return all > 0 ? inBand / all : 0;
}

/** `samples` (at `rate`) read: its peak and RMS in dBFS, and the share of its energy in `band` (Hz). */
export function measure(samples, rate, band = BAND) {
  let peak = 0;
  let sum = 0;
  for (const s of samples) {
    peak = Math.max(peak, Math.abs(s));
    sum += s * s;
  }
  return { peakDb: dbfs(peak), rmsDb: dbfs(Math.sqrt(sum / Math.max(1, samples.length))), bandShare: bandShare(samples, rate, band[0], band[1]) };
}

const db1 = (x) => (x === -Infinity ? '-inf' : x.toFixed(1));

/**
 * What fails of a file read by measure(): its peak over −1 dBFS or under −30, or silent (under
 * SILENT_DB, which says only that); and, held to `band` with `share`, too little of its energy in it.
 */
export function checkSound(m, rules = {}) {
  if (!(m.peakDb >= SILENT_DB)) return ['it is silent'];
  const out = [];
  if (m.peakDb > PEAK_DB[1]) out.push(`its peak, ${db1(m.peakDb)} dBFS, is over ${PEAK_DB[1]} dBFS: it may clip`);
  if (m.peakDb < PEAK_DB[0]) out.push(`its peak, ${db1(m.peakDb)} dBFS, is under ${PEAK_DB[0]} dBFS: too quiet`);
  if (rules.band && !(m.bandShare > rules.share)) out.push(`only ${Math.round(m.bandShare * 100)}% of its energy is in ${rules.band[0]}-${rules.band[1]} Hz, not over ${Math.round(rules.share * 100)}%`);
  return out;
}

/**
 * Each file as a row: its name, peak and RMS (dBFS) and its share of energy in 400 Hz–2 kHz, and ok, or
 * what failed of it (FAIL; "(reported)" for a file reported and not gated, `gated` false).
 */
export function table(rows) {
  const head = ['name', 'peak dBFS', 'RMS dBFS', `${BAND[0]}-${BAND[1]} Hz`, ''];
  const cells = rows.map((r) => [r.name, db1(r.peakDb), db1(r.rmsDb), `${Math.round(r.bandShare * 100)}%`, r.failures.length === 0 ? 'ok' : `${r.gated === false ? '(reported)' : 'FAIL'} ${r.failures.join('; ')}`]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => (i < 4 ? c[i].length : 0))));
  const line = (c) => c.map((s, i) => (i < 4 ? s.padEnd(widths[i] + 2) : s)).join('');
  return [line(head), ...cells.map(line)].join('\n');
}
