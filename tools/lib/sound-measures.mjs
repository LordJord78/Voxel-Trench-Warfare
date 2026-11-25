// The sounds' proof's measures (tools/render-sounds.mjs, npm run sounds; the shots spec's §6, G3's Task 5):
// a voice rendered offline is written as a stereo WAV, and read with both ears together: its peak (the
// louder ear's), RMS and loudest 50 ms (dBFS), its body's loudest 50 ms (its part under 400 Hz alone),
// the share of its energy in 400 Hz–2 kHz and over 400 Hz (an FFT of each ear, their energy summed).
// Each file's peak is held between −30 and −1 dBFS and none may be silent; a render may be held besides
// to a band, to the small speaker (its share over 400 Hz), to a floor under its peak, to another
// render's loudest 50 ms, or its body's (a kill's thud, apart from its chime), over another render's
// energy in a band (a headshot's kill over the same kill without its gush), its loudest 50 ms under
// another's (a suppressed SVD's report under a bare one's: its loudness, as `near` and `tail` read it,
// never its sample peak, which a noise burst's seed swings by 4 dB), its share over 400 Hz over
// another's (the same, its tone), or its tail's loudest 50 ms between so many dB under its report's (a
// report's shared tail, neither missing nor outweighing it). Plain JS, so the render page
// (tools/sounds/page.ts, which runs the FFT where it renders) and the tests read the same code.

/** A file's peak must lie in this range (dBFS): over the top it may clip, under the bottom it is too quiet. */
export const PEAK_DB = [-30, -1];
/** A file whose peak is under this (dBFS) is silent: nothing a 16-bit file holds. */
export const SILENT_DB = -90;
/** The band the table reads every file in (Hz): where the gush lies, and the ear is keenest. */
export const BAND = [400, 2000];
/** A laptop's speakers barely play what lies under this (Hz): the small speaker's share is over it. */
export const SMALL_SPEAKER_HZ = 400;
/** The window a voice's loudness is read over (s): its loudest 50 ms. */
export const LOUDEST_S = 0.05;
/** A sound starts at its first sample this loud or louder (dBFS), in either ear. */
export const ONSET_DB = -60;
/** A band rule's share, when it asks none. */
const HALF = 0.5;

/** `x` (a linear level, full scale 1) in dBFS; −Infinity for 0. */
export const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** `x`, one channel (an array of samples) or a list of them, as a list of channels. */
function channelsOf(x) {
  return x.length > 0 && typeof x[0] !== 'number' ? Array.from(x) : [x];
}

/**
 * `x` (one channel, or a list of channels of one length; full scale ±1) as a WAV of 16-bit PCM at `rate`,
 * its channels interleaved: each sample scaled to 32767, rounded half away from zero, and clipped at
 * full scale.
 */
export function wav(x, rate) {
  const channels = channelsOf(x);
  const n = channels[0].length;
  if (channels.some((c) => c.length !== n)) throw new Error(`wav: the channels' length differs (${channels.map((c) => c.length).join(', ')})`);
  const k = channels.length;
  const bytes = new Uint8Array(44 + n * k * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, k, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * k * 2, true);
  view.setUint16(32, k * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, n * k * 2, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i])) * 32767;
      view.setInt16(44 + (i * k + c) * 2, Math.sign(v) * Math.round(Math.abs(v)), true);
    }
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
 * One channel's part under `hz` Hz: its FFT (zero-padded to a power of 2) with every bin over `hz`
 * zeroed, and back, cut to its length. A brick wall, so a kill's thud (under 100 Hz) comes out whole and
 * its chime (880 Hz and up) not at all.
 */
function under(samples, rate, hz) {
  let n = 1;
  while (n < samples.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < samples.length; i++) re[i] = samples[i];
  fft(re, im);
  for (let k = 0; k < n; k++) {
    if ((Math.min(k, n - k) * rate) / n > hz) {
      re[k] = 0;
      im[k] = 0;
    }
  }
  // The inverse: the FFT of the conjugate, conjugated, over n (its real part is all there is).
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fft(re, im);
  const out = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = re[i] / n;
  return out;
}

/**
 * One channel's energy (its power spectrum's sum, Parseval's) all told, and between `lo` and `hi` Hz,
 * one-sided; and that in-band part as the sum of squares of the samples it stands for (`squares`: each
 * bin but the ends counted for its mirror too, over the FFT's length).
 */
function energy(samples, rate, lo, hi) {
  let n = 1;
  while (n < samples.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < samples.length; i++) re[i] = samples[i];
  fft(re, im);
  let all = 0;
  let inBand = 0;
  let squares = 0;
  for (let k = 0; k <= n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const hz = (k * rate) / n;
    all += p;
    if (hz >= lo && hz <= hi) {
      inBand += p;
      squares += (k === 0 || 2 * k === n ? 1 : 2) * p;
    }
  }
  return { all, inBand, squares: squares / n };
}

/**
 * The share of `x`'s energy (one channel or a list, at `rate`) between `lo` and `hi` Hz: each channel's
 * power spectrum's bins in the band over all of it (Parseval's), the whole file zero-padded to a power of
 * 2, the channels' energy summed (both ears together). No window: a window over the whole file would
 * weigh its middle over its ends, and a voice's thud at its start would count for next to nothing. A
 * voice fades in and out, so its ends leak little. 0 for silence.
 */
export function bandShare(x, rate, lo, hi) {
  let all = 0;
  let inBand = 0;
  for (const c of channelsOf(x)) {
    const e = energy(c, rate, lo, hi);
    all += e.all;
    inBand += e.inBand;
  }
  return all > 0 ? inBand / all : 0;
}

/**
 * The loudest `windowS` of `x` (one channel or a list, at `rate`): its RMS in dBFS (the window's mean
 * power over every channel), and where it starts (s). A file shorter than the window is read whole.
 */
export function loudest(x, rate, windowS = LOUDEST_S) {
  const channels = channelsOf(x);
  const n = channels[0].length;
  const w = Math.max(1, Math.min(n, Math.round(windowS * rate)));
  const power = new Float64Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) power[i] += c[i] * c[i];
  let sum = 0;
  for (let i = 0; i < w; i++) sum += power[i];
  let best = sum;
  let at = 0;
  for (let i = w; i < n; i++) {
    sum += power[i] - power[i - w];
    if (sum > best) {
      best = sum;
      at = i - w + 1;
    }
  }
  return { db: dbfs(Math.sqrt(Math.max(0, best) / (w * channels.length))), atS: at / rate };
}

/**
 * The loudest `windowS` of `x`'s part under `hz` Hz alone (one channel or a list, at `rate`; each
 * channel cut by under()): its RMS in dBFS, both ears together, and where it starts (s). A voice's body
 * apart from its bright parts: a kill's thud, under its louder chime.
 */
export function loudestUnder(x, rate, hz, windowS = LOUDEST_S) {
  return loudest(channelsOf(x).map((c) => under(c, rate, hz)), rate, windowS);
}

/**
 * `x` (one channel or a list, at `rate`) read with both ears together: its peak (the louder ear's), RMS
 * and loudest 50 ms in dBFS and where that starts (s), its body's loudest 50 ms (its part under
 * SMALL_SPEAKER_HZ alone: a kill's thud), the share of its energy in BAND (the table's column, always
 * BAND), and the small speaker's: its share over SMALL_SPEAKER_HZ.
 */
export function measure(x, rate) {
  const channels = channelsOf(x);
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (const c of channels) {
    for (const s of c) {
      peak = Math.max(peak, Math.abs(s));
      sum += s * s;
    }
    count += c.length;
  }
  const l = loudest(channels, rate);
  return {
    peakDb: dbfs(peak),
    rmsDb: dbfs(Math.sqrt(sum / Math.max(1, count))),
    loudestDb: l.db,
    loudestAtS: l.atS,
    lowLoudestDb: loudestUnder(channels, rate, SMALL_SPEAKER_HZ).db,
    bandShare: bandShare(channels, rate, BAND[0], BAND[1]),
    highShare: bandShare(channels, rate, SMALL_SPEAKER_HZ, Infinity),
  };
}

/**
 * Where `x` (one channel or a list, at `rate`) starts (s): its first sample at ONSET_DB or louder, in
 * either ear; null for silence. A render's voices start after its lead, and the compressor's look-ahead
 * and the HRTF's filter delay them further.
 */
export function onset(x, rate) {
  const floor = 10 ** (ONSET_DB / 20);
  let first = Infinity;
  for (const c of channelsOf(x)) {
    for (let i = 0; i < Math.min(c.length, first); i++) {
      if (Math.abs(c[i]) >= floor) {
        first = i;
        break;
      }
    }
  }
  return first === Infinity ? null : first / rate;
}

/** `x`'s channels (one or a list, at `rate`), whole, or their first `firstS` seconds from its onset; null for silence cut so. */
function firstOf(x, rate, firstS) {
  const channels = channelsOf(x);
  if (firstS === undefined) return channels;
  const at = onset(channels, rate);
  if (at === null) return null;
  const from = Math.round(at * rate);
  const to = from + Math.round(firstS * rate);
  return channels.map((c) => (c.subarray ? c.subarray(from, to) : Array.prototype.slice.call(c, from, to)));
}

/**
 * A band rule's own share of `x` (one channel or a list, at `rate`): its energy in `rule.hz`, over the
 * whole file, or over its first `rule.firstS` seconds from its onset.
 */
export function ruleShare(x, rate, rule) {
  const channels = firstOf(x, rate, rule.firstS);
  return channels === null ? 0 : bandShare(channels, rate, rule.hz[0], rule.hz[1]);
}

/**
 * An `over` rule's own reading of `x` (one channel or a list, at `rate`): its energy in `rule.hz` (the
 * sum of the squares of its samples there, by Parseval's; both ears' summed), over the whole file, or
 * over its first `rule.firstS` seconds from its onset, in dB; −Infinity for silence. Two files read
 * alike differ by as many dB as their energy there does.
 */
export function ruleEnergyDb(x, rate, rule) {
  const channels = firstOf(x, rate, rule.firstS);
  if (channels === null) return -Infinity;
  let sum = 0;
  for (const c of channels) sum += energy(c, rate, rule.hz[0], rule.hz[1]).squares;
  return sum > 0 ? 10 * Math.log10(sum) : -Infinity;
}

/**
 * A `tail` rule's own reading of `x` (one channel or a list, at `rate`): from its onset, its loudest
 * 50 ms before `rule.afterS` (`dryDb`: the report, or a burst's reports) and from `rule.afterS` on
 * (`tailDb`: the tail alone, its layers done), in dBFS, both ears together; −Infinity for a window with
 * nothing in it (silence, a missing tail, or nothing left past the file's end).
 */
export function ruleTail(x, rate, rule) {
  const channels = channelsOf(x);
  const at = onset(channels, rate);
  if (at === null) return { dryDb: -Infinity, tailDb: -Infinity };
  const from = Math.round(at * rate);
  const split = Math.min(channels[0].length, from + Math.round(rule.afterS * rate));
  const cut = (a, b) => channels.map((c) => (c.subarray ? c.subarray(a, b) : Array.prototype.slice.call(c, a, b)));
  const read = (a, b) => (b > a ? loudest(cut(a, b), rate).db : -Infinity);
  return { dryDb: read(from, split), tailDb: read(split, channels[0].length) };
}

const db1 = (x) => (x === -Infinity ? '-inf' : x.toFixed(1));
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * What fails of a file read by measure() (with its rule's share, `ruleShare`, if it has a band rule, its
 * `over` rule's reading, `overDb`, if it has one or another's names it, and its `tail` rule's, `dryDb`
 * and `tailDb`, if it has one):
 * its peak over −1 dBFS or under −30, or silent (under SILENT_DB, which says only that); and, by
 * `rules`, under its floor (`floorDb`), too little of its energy in its band (`band`: at least `share`
 * of it in `hz`, over its first `firstS` seconds if given; half, if it asks no share), too little over
 * 400 Hz for a small speaker (`high`), its loudest 50 ms further than `near.withinDb` from render
 * `near.of`'s, read in `others` (each render's measure by its name): from its loudest 50 ms, or with
 * `near.low` from its body's, under SMALL_SPEAKER_HZ alone (the kill's thud, never its louder chime);
 * or its energy in `over.band` (over its first `over.firstS` seconds if given) less than `over.db` dB
 * over render `over.of`'s, read alike (`overDb`, each): a headshot's kill over the same without its
 * gush, as the kill's chime alone fills the band a share can ask of it; its loudest 50 ms less than
 * `under.db` dB under render `under.of`'s (a suppressed SVD's report under a bare one's: read on its
 * loudness, never its sample peak, which a noise burst's seed swings by 4 dB); its share over
 * 400 Hz less than `highOver.by` over render `highOver.of`'s (the same, its tone); or its tail's loudest
 * 50 ms from `tail.afterS` on, from its onset, not between `tail.underDb` (lo to hi) dB under its
 * loudest 50 ms before (a report's shared tail: over `hi`, or silent, it is missing; under `lo`, it
 * outweighs the report). Another render missing or silent, a silent report, or a reading not taken,
 * fails: never a pass.
 */
export function checkSound(m, rules = {}, others = {}) {
  if (!(m.peakDb >= SILENT_DB)) return ['it is silent'];
  const out = [];
  if (m.peakDb > PEAK_DB[1]) out.push(`its peak, ${db1(m.peakDb)} dBFS, is over ${PEAK_DB[1]} dBFS: it may clip`);
  if (m.peakDb < PEAK_DB[0]) out.push(`its peak, ${db1(m.peakDb)} dBFS, is under ${PEAK_DB[0]} dBFS: too quiet`);
  if (rules.floorDb !== undefined && m.peakDb < rules.floorDb) out.push(`its peak, ${db1(m.peakDb)} dBFS, is under its floor of ${rules.floorDb} dBFS`);
  if (rules.band) {
    const { hz, firstS } = rules.band;
    const share = rules.band.share ?? HALF;
    const whose = firstS === undefined ? 'its energy' : `its first ${Math.round(firstS * 1000)} ms's energy`;
    if (m.ruleShare === undefined) out.push(`its energy's share in ${hz[0]}-${hz[1]} Hz was not measured`);
    else if (!(m.ruleShare >= share)) out.push(`only ${pct1(m.ruleShare)} of ${whose} is in ${hz[0]}-${hz[1]} Hz, not ${pct(share)} or more`);
  }
  if (rules.high !== undefined && !(m.highShare >= rules.high)) out.push(`only ${pct1(m.highShare)} of its energy is over ${SMALL_SPEAKER_HZ} Hz, not ${pct(rules.high)} or more: a small speaker barely plays it`);
  if (rules.near) {
    const { of, withinDb, low } = rules.near;
    const other = others[of];
    const whose = low ? `${of}'s under ${SMALL_SPEAKER_HZ} Hz` : `${of}'s`;
    const level = other && (low ? other.lowLoudestDb : other.loudestDb);
    if (!other) out.push(`its level is held to ${of}'s, which was not rendered`);
    else if (typeof level !== 'number') out.push(`its level is held to ${whose}, which was not measured`);
    else {
      const gap = m.loudestDb - level;
      if (!(Math.abs(gap) <= withinDb)) out.push(`its loudest 50 ms, ${db1(m.loudestDb)} dBFS, is ${Math.abs(gap).toFixed(1)} dB ${gap < 0 ? 'under' : 'over'} ${whose} (${db1(level)} dBFS), not within ${withinDb} dB`);
    }
  }
  if (rules.over) {
    const { of, band, firstS, db } = rules.over;
    const other = others[of];
    const whose = `${firstS === undefined ? 'its energy' : `its first ${Math.round(firstS * 1000)} ms's energy`} in ${band[0]}-${band[1]} Hz`;
    if (!other) out.push(`its energy is held over ${of}'s, which was not rendered`);
    else if (typeof m.overDb !== 'number' || typeof other.overDb !== 'number') out.push(`${whose} over ${of}'s was not measured`);
    else {
      const gap = m.overDb - other.overDb;
      if (!(gap >= db)) out.push(`${whose} is ${Math.abs(gap).toFixed(1)} dB ${gap < 0 ? 'under' : 'over'} ${of}'s, not ${db} dB or more over it`);
    }
  }
  if (rules.under) {
    const { of, db } = rules.under;
    const other = others[of];
    if (!other) out.push(`its loudest 50 ms is held under ${of}'s, which was not rendered`);
    else if (!(other.peakDb >= SILENT_DB)) out.push(`its loudest 50 ms is held under ${of}'s, which is silent`);
    else if (typeof other.loudestDb !== 'number') out.push(`its loudest 50 ms is held under ${of}'s, which was not measured`);
    else {
      const gap = other.loudestDb - m.loudestDb;
      if (!(gap >= db)) out.push(`its loudest 50 ms, ${db1(m.loudestDb)} dBFS, is ${Math.abs(gap).toFixed(1)} dB ${gap < 0 ? 'over' : 'under'} ${of}'s (${db1(other.loudestDb)} dBFS), not ${db} dB or more under it`);
    }
  }
  if (rules.highOver) {
    const { of, by } = rules.highOver;
    const other = others[of];
    if (!other) out.push(`its share over ${SMALL_SPEAKER_HZ} Hz is held over ${of}'s, which was not rendered`);
    else if (!(other.peakDb >= SILENT_DB)) out.push(`its share over ${SMALL_SPEAKER_HZ} Hz is held over ${of}'s, which is silent`);
    else {
      const gap = m.highShare - other.highShare;
      if (!(gap >= by)) out.push(`${pct1(m.highShare)} of its energy is over ${SMALL_SPEAKER_HZ} Hz, ${(Math.abs(gap) * 100).toFixed(1)} points ${gap < 0 ? 'under' : 'over'} ${of}'s (${pct1(other.highShare)}), not ${Math.round(by * 100)} or more over it`);
    }
  }
  if (rules.tail) {
    const { afterS, underDb } = rules.tail;
    const [lo, hi] = underDb;
    const ms = Math.round(afterS * 1000);
    if (typeof m.dryDb !== 'number' || typeof m.tailDb !== 'number') out.push(`its tail from ${ms} ms was not measured`);
    else if (!(m.dryDb >= SILENT_DB)) out.push(`its loudest 50 ms before ${ms} ms is silent: no report to hold its tail under`);
    else if (!(m.tailDb >= SILENT_DB)) out.push(`its tail from ${ms} ms is silent: no tail`);
    else {
      const gap = m.dryDb - m.tailDb;
      if (!(gap >= lo && gap <= hi)) out.push(`its tail's loudest 50 ms from ${ms} ms, ${db1(m.tailDb)} dBFS, is ${Math.abs(gap).toFixed(1)} dB ${gap < 0 ? 'over' : 'under'} its loudest 50 ms before (${db1(m.dryDb)} dBFS), not ${lo} to ${hi} dB under`);
    }
  }
  return out;
}

/**
 * Each file as a row: its name, peak, RMS and loudest 50 ms (dBFS), its share of energy in BAND (never a
 * rule's own band) and over 400 Hz, and ok, or what failed of it (FAIL; "(reported)" for a file
 * reported and not gated, `gated` false).
 */
export function table(rows) {
  const head = ['name', 'peak dBFS', 'RMS dBFS', 'loudest 50 ms', `${BAND[0]}-${BAND[1]} Hz`, `over ${SMALL_SPEAKER_HZ} Hz`, ''];
  const last = head.length - 1;
  const cells = rows.map((r) => [r.name, db1(r.peakDb), db1(r.rmsDb), db1(r.loudestDb), pct(r.bandShare), pct(r.highShare), r.failures.length === 0 ? 'ok' : `${r.gated === false ? '(reported)' : 'FAIL'} ${r.failures.join('; ')}`]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => (i < last ? c[i].length : 0))));
  const line = (c) => c.map((s, i) => (i < last ? s.padEnd(widths[i] + 2) : s)).join('');
  return [line(head), ...cells.map(line)].join('\n');
}
