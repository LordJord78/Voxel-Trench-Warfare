import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The game's video (npm run video; the showcase spec's §3), as ffprobe reads it: what the page plays
// where the game cannot run.
interface Probe {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate: string }[];
  format: { duration: string };
}
const probe = (file: string): Probe => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' }));

/** An MP4's top-level boxes, in order. */
function boxes(file: string): string[] {
  const b = readFileSync(file);
  const out: string[] = [];
  for (let i = 0; i + 8 <= b.length; ) {
    let size = b.readUInt32BE(i);
    out.push(b.toString('latin1', i + 4, i + 8));
    if (size === 1) size = Number(b.readBigUInt64BE(i + 8));
    if (size < 8) break;
    i += size;
  }
  return out;
}

test('the video is 20–30 s of 1280 × 720 at 30 fps, VP9 and H.264, each ≤ 6 MB, the MP4 faststart', () => {
  for (const [file, codec] of [['public/video/trenchline.webm', 'vp9'], ['public/video/trenchline.mp4', 'h264']] as const) {
    const p = probe(file);
    const video = p.streams.find((s) => s.codec_type === 'video')!;
    expect(video.codec_name, file).toBe(codec);
    expect([video.width, video.height], file).toEqual([1280, 720]);
    expect(video.avg_frame_rate, file).toBe('30/1');
    expect(p.streams.some((s) => s.codec_type === 'audio'), file).toBe(false);
    const seconds = Number(p.format.duration);
    expect(seconds, file).toBeGreaterThanOrEqual(20);
    expect(seconds, file).toBeLessThanOrEqual(30);
    expect(statSync(file).size, file).toBeLessThanOrEqual(6 * 1024 * 1024);
  }
  // Its index first, so it plays as it arrives.
  const order = boxes('public/video/trenchline.mp4');
  expect(order.indexOf('moov')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'));
});
