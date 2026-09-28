import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateRecordingMp4 } from './recordings-mp4.js';

function clip({ seconds = 1, rate = 15, audioOnly = false } = {}) {
  const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    audioOnly ? 'sine=frequency=440' : `color=c=blue:s=160x90:r=${rate}`,
    '-t', String(seconds), ...(audioOnly ? ['-c:a','aac'] : ['-r',String(rate),'-c:v','libx264']),
    '-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1',
  ]);
  assert.equal(result.status, 0, 'ffmpeg must be installed to run media tests');
  return result.stdout;
}

test('real MP4 decoding accepts bounded video and rejects false signatures and truncation', async () => {
  const bytes = clip();
  assert.deepEqual(await validateRecordingMp4(bytes, { expectedFrames: 15 }), bytes);
  await assert.rejects(validateRecordingMp4(bytes, { expectedFrames: 16 }), /every saved video frame/);
  await assert.rejects(validateRecordingMp4(Buffer.from('0000ftyp0000000000000000')));
  await assert.rejects(validateRecordingMp4(bytes.subarray(0, bytes.length - 100)));
});

test('reject audio-only, excessive frame rate, and excessive duration', async () => {
  for (const options of [{ audioOnly: true }, { rate: 121 }, { seconds: 22 }])
    await assert.rejects(validateRecordingMp4(clip(options)), /1–120 fps video|bounded decodable video|duration bound/);
});

// Keep every decoded frame: no trimming or increased frame-count tolerance.
test('accepts fractional media duration of a nominal 20-second event', async () => {
  const bytes = clip({ seconds: 20.6 });
  assert.deepEqual(await validateRecordingMp4(bytes, { expectedFrames: 309 }), bytes);
  await assert.rejects(validateRecordingMp4(bytes, { expectedFrames: 310 }), /every saved video frame/);
  await assert.rejects(validateRecordingMp4(clip({ seconds: 21.2 })), /duration bound/);
});
