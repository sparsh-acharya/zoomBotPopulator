// server/transcode.js
// Transcode an uploaded video to WebM (VP8 + Opus) that the presenter bot's
// browser can actually decode.
//
// The presenter bot runs Playwright's BUNDLED Chromium, which is built WITHOUT
// proprietary codecs — no H.264, no AAC. A normal .mp4 (H.264/AAC) therefore
// fails to play in the bot's <video> ("no supported source was found") and the
// screen share is a black, silent frame. VP8 video + Opus audio in a WebM
// container play natively in that Chromium, fixing both video and audio.
//
// We also downscale to <=720p / 30fps: the headless ARM VM must RE-ENCODE the
// captured surface for Zoom in real time, and 1080p60 chokes it. 720p30 is
// plenty for a shared clip and keeps the pipeline smooth. Encoding runs once,
// at upload, so its cost never touches playback.

import { spawn } from 'node:child_process';

// Overridable in case ffmpeg isn't on PATH (e.g. a custom install location).
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
// Hard cap so a pathological upload can't hang the request forever.
const TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
// Keep only the tail of ffmpeg's (verbose) stderr for error messages.
const STDERR_KEEP_BYTES = 8_000;

/**
 * Transcode `inputPath` to a sibling `.webm` (VP8 + Opus, <=720p30).
 * Never upscales: sources at or below 720p keep their height.
 *
 * @param {string} inputPath absolute path to the source video
 * @returns {Promise<string>} absolute path to the produced .webm
 * @throws if ffmpeg is missing (ENOENT), times out, or exits non-zero.
 */
export function transcodeToWebm(inputPath) {
  // Swap the extension for .webm; guard the (rare) case the input already is one.
  const base = inputPath.replace(/\.[^.\\/]+$/, '');
  let target = `${base}.webm`;
  if (target === inputPath) target = `${base}-vp8.webm`;

  const args = [
    '-y',
    '-i', inputPath,
    // Downscale to <=720 tall (even width, keep aspect) and cap 30fps. The
    // escaped comma keeps min(720,ih) inside the scale filter rather than being
    // read as a filterchain separator.
    '-vf', 'scale=-2:min(720\\,ih),fps=30',
    '-c:v', 'libvpx',
    '-b:v', '2M',
    // realtime + a high cpu-used trades a little quality for speed so the
    // encode finishes quickly on the ARM box.
    '-deadline', 'realtime',
    '-cpu-used', '5',
    '-auto-alt-ref', '0',
    // Opus for audio; if the source has no audio track this simply produces a
    // video-only WebM (ffmpeg maps whatever streams exist).
    '-c:a', 'libopus',
    '-b:a', '128k',
    target,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > STDERR_KEEP_BYTES) stderr = stderr.slice(-STDERR_KEEP_BYTES);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg transcode timed out after ${TRANSCODE_TIMEOUT_MS}ms`));
    }, TRANSCODE_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err); // ENOENT when ffmpeg isn't installed, etc.
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(target);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}
