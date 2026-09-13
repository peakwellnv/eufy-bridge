import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaError } from './media.js';

/** Normalize the camera's HEVC fragments to a seekable H.264/AAC phone video. */
export async function whatsappVideo(input, seconds = 10) {
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > 20) throw new MediaError('Video length must be 2–20 seconds', 400);
  const directory = await mkdtemp(join(tmpdir(), 'sage-booth-video-'));
  const output = join(directory, 'booth.mp4');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
        '-f', 'mp4', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0?',
        '-map_metadata', '-1', '-t', String(seconds), '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-r', '15', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-movflags', '+faststart',
        '-fs', String(24 * 1024 * 1024), '-y', output,
      ], { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new MediaError('Camera video conversion timed out')); }, 25000);
      child.on('error', () => { clearTimeout(timer); reject(new MediaError('Video converter unavailable')); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new MediaError('Camera video conversion failed')); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
    const data = await readFile(output);
    if (data.length < 12 || data.length >= 24 * 1024 * 1024 || data.subarray(4,8).toString() !== 'ftyp')
      throw new MediaError('Camera video is invalid or too large');
    return data;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
