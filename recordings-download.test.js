import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { recordingAckKey, decodeSavedVideo, downloadLocalRecording } from './recordings-download.js';
import { CameraMedia } from './media.js';
const cameraSn = 'T86P2TEST0000001', did = 'TEST-123456-TEST';
const ack = Buffer.alloc(36); ack.write('1790536954', 4); // Synthetic seed; no account material.
const body = Buffer.concat([Buffer.from([0, 0, 0, 1, 64, 1]), Buffer.alloc(130)]);
function frame(timestamp, sign = 0) {
  const h = Buffer.alloc(22); h.writeUInt32LE(body.length); h[4] = 1; h[5] = 2; h.writeUIntLE(timestamp, 14, 6);
  let data = body;
  if (sign) { const c = createCipheriv('aes-128-ecb', recordingAckKey(ack, cameraSn, did), null); c.setAutoPadding(false);
    data = Buffer.concat([c.update(body.subarray(0, 128)), c.final(), body.subarray(128)]); }
  return { commandId: 1300, dataType: 3, signCode: sign, data: Buffer.concat([h, data]) };
}
test('ACK-derived key decrypts only the first 128 saved-frame bytes', () => {
  assert.deepEqual(decodeSavedVideo(frame(1000, 1), recordingAckKey(ack, cameraSn, did)), body);
  assert.throws(() => decodeSavedVideo(frame(1000, 1)), /key/);
  assert.throws(() => recordingAckKey(Buffer.alloc(36), cameraSn, did), /key response/);
  const corrupt = frame(1000); corrupt.data.writeUInt32LE(999);
  assert.throws(() => decodeSavedVideo(corrupt), /Unsupported/);
});
function setup({ incomplete = false } = {}) {
  const session = new EventEmitter(); const commands = []; const calls = [];
  const original = () => {}; session.onData = original; session.isConnected = true;
  session.level1Key = Buffer.alloc(16, 1); session.seqNumber = 0; session.cfg = { p2pDid: did };
  session.lastSeqByType = new Map();
  session.send = (_, __, payload) => {
    const command = payload.readUInt16LE(8); commands.push(command);
    if (command === 1024) queueMicrotask(() => {
      session.emit('data', { commandId: 1024, dataType: 0, type: 1, data: ack });
      session.emit('data', frame(1000, 1));
      if (!incomplete) session.emit('data', frame(2000));
      session.emit('data', { commandId: 1304, dataType: 2 });
    });
  };
  const manager = { retain() { calls.push('retain'); }, get: () => session,
    close: async () => calls.push('close'), release() { calls.push('release'); } };
  const context = { cameraSn, media: new CameraMedia(async () => ({})), device: { sn: cameraSn, raw: { member: { admin_user_id: 'OWNER' } } },
    eufy: { api: { auth: { userId: 'OWNER' } }, p2p: { stationKeyOf: () => cameraSn, manager, ensureStation: async () => {} } } };
  const row = { device_sn: cameraSn, station_sn: cameraSn, cipher_id: 0, storage_type: 1, storage_cloud: 0,
    storage_path: 'SYNTHETIC_PATH', frame_num: 2, start_time: 1, end_time: 2 };
  return { session, commands, calls, context, row, original };
}
test('requires real finish plus all listed frames; closes session before releasing media', async () => {
  const s = setup();
  const result = await downloadLocalRecording(s.context, s.row, { mux: async (bytes, fps) => {
    assert.deepEqual(bytes, Buffer.concat([body, body])); assert.equal(fps, 1); return 'MP4';
  } });
  assert.equal(result, 'MP4'); assert.deepEqual(s.commands, [1024]);
  assert.deepEqual(s.calls, ['retain', 'close', 'release']); assert.equal(s.context.media.busy, false);
  assert.equal(s.session.onData, s.original); assert.equal(s.session.listenerCount('data'), 0);
});
test('incomplete saved media times out, cancels and never reaches mux', async () => {
  const s = setup({ incomplete: true }); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(downloadLocalRecording(s.context, s.row, { signal: controller.signal, mux: assert.fail }), { status: 504 }); }
  finally { clearTimeout(timer); }
  assert.deepEqual(s.commands, [1024, 1051]); assert.equal(s.context.media.busy, false);
  assert.equal(s.session.onData, s.original);
});
test('foreign owner, oversized recordings and occupied camera fail before download', async () => {
  const s = setup();
  await assert.rejects(downloadLocalRecording(s.context, { ...s.row, end_time: 30 }), { status: 413 });
  await assert.rejects(downloadLocalRecording(s.context, { ...s.row, device_sn: 'OTHER' }), { status: 403 });
  await s.context.media.exclusive(async () => { await assert.rejects(downloadLocalRecording(s.context, s.row), { status: 409 }); });
  assert.deepEqual(s.commands, []);
});
