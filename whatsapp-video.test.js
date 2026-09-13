import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { whatsappVideo } from './whatsapp-video.js';

test('WhatsApp video is a seekable playable H264 MP4; invalid input fails', async () => {
 const ffmpeg=process.env.FFMPEG_PATH || 'ffmpeg';
 const source=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=15','-t','3','-c:v','libx264','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
 assert.equal(source.status,0);
 const output=await whatsappVideo(source.stdout,2);
 assert.equal(output.subarray(4,8).toString(),'ftyp');
 assert.ok(output.indexOf(Buffer.from('moov'))<output.indexOf(Buffer.from('mdat')));
 const decoded=spawnSync(ffmpeg,['-hide_banner','-i','pipe:0','-f','null','-'],{input:output});
 assert.equal(decoded.status,0);assert.match(decoded.stderr.toString(),/Video: h264/);assert.match(decoded.stderr.toString(),/Duration: 00:00:02\.00/);
 await assert.rejects(whatsappVideo(Buffer.from('invalid')),/conversion failed/);
});
