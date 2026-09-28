import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaError } from './media.js';

// Strictly below the consumer's 25 MiB ceiling, including the container.
export const RECORDING_MAX_BYTES = 25 * 1024 * 1024;
// Camera calendar boundaries have whole-second precision. A nominal 20-second
// event can decode longer than 20.5 seconds; retain every frame within 21 seconds.
const MAX_SECONDS = 21;

export function checkRecordingBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12)
    throw new MediaError('Recording is not an MP4', 502);
  if (bytes.length >= RECORDING_MAX_BYTES)
    throw new MediaError('Recording must be smaller than 25 MB', 413);
  if (bytes.toString('ascii', 4, 8) !== 'ftyp')
    throw new MediaError('Recording is not an MP4', 502);
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let failure;
    const fail = error => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new MediaError('Recording validation timed out', 504)), 25000);
    child.on('error', () => { failure ??= new MediaError('Recording validator unavailable', 503); });
    child.stderr.on('data', () => fail(new MediaError('Recording could not be decoded cleanly')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) fail(new MediaError('Recording validation output exceeded limit'));
      else chunks.push(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new MediaError('Recording could not be decoded'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Validate the entire clip, not merely an ftyp signature or the first frame. */
export async function validateRecordingMp4(bytes, { expectedFrames } = {}) {
  checkRecordingBytes(bytes);
  const directory = await mkdtemp(join(tmpdir(), 'eufy-recording-'));
  const file = join(directory, 'recording.mp4');
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    const input = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];
    let probe;
    try {
      probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', [
        '-v', 'error', ...input, '-show_entries',
        'format=duration:stream=codec_type,width,height,avg_frame_rate,duration', '-of', 'json', file,
      ]));
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('Recording metadata is invalid');
    }
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const rate = /^(\d+)\/(\d+)$/.exec(video?.avg_frame_rate ?? '');
    const fps = rate ? Number(rate[1]) / Number(rate[2]) : NaN;
    const duration = Number(probe.format?.duration);
    if (Number.isFinite(duration) && duration > MAX_SECONDS)
      throw new MediaError(`Recording exceeds the 21-second duration bound (${duration.toFixed(3)}s)`, 413);
    if (!video || !Number.isFinite(fps) || fps < 1 || fps > 120 ||
        !Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS ||
        !Number.isInteger(video.width) || !Number.isInteger(video.height) ||
        video.width <= 0 || video.height <= 0 || video.width * video.height > 3840 * 2160)
      throw new MediaError('Recording must contain 1–120 fps video of at most 21 seconds');
    const progress = await run(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
      ...input, '-i', file, '-map', '0:v:0', '-an', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-',
    ]);
    const frames = [...progress.matchAll(/^frame=(\d+)$/gm)].map(match => Number(match[1]));
    const times = [...progress.matchAll(/^out_time_us=(\d+)$/gm)].map(match => Number(match[1]) / 1e6);
    if (!frames.length || Math.max(...frames) < 1 || Math.max(...frames) > 120 * MAX_SECONDS ||
        !times.length || Math.max(...times) > MAX_SECONDS)
      throw new MediaError('Recording has no bounded decodable video');
    if (expectedFrames !== undefined && Math.max(...frames) !== expectedFrames)
      throw new MediaError('MP4 does not contain every saved video frame');
    return bytes;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Convert verified complete H.265 saved frames into a portable, video-only MP4. */
export async function muxSavedRecording(annexb, fps) {
  if (!Buffer.isBuffer(annexb) || !annexb.length || annexb.length >= RECORDING_MAX_BYTES ||
      !Number.isFinite(fps) || fps < 1 || fps > 120) throw new MediaError('Invalid saved video bounds');
  const directory = await mkdtemp(join(tmpdir(), 'eufy-recording-mux-'));
  try {
    const input = join(directory, 'source.hevc'), output = join(directory, 'saved.mp4');
    await writeFile(input, annexb, { mode: 0o600 });
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-xerror', '-err_detect', 'explode', '-protocol_whitelist', 'file', '-f', 'hevc', '-r', String(fps),
      '-i', input, '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-movflags', '+faststart', '-fs', String(RECORDING_MAX_BYTES), output]);
    const bytes = await readFile(output);
    checkRecordingBytes(bytes);
    return bytes;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
