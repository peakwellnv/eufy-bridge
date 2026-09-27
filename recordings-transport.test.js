import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedRecordingPackets } from './recordings-transport.js';
const packet = (seq, type = 3) => { const b = Buffer.alloc(12); b[5] = type; b.writeUInt16BE(seq, 6); return b; };
test('reorders saved-file packets, suppresses duplicates, and leaves control untouched', () => {
  const received = [], acknowledgments = [];
  const original = function(b) { received.push([b[5], b.readUInt16BE(6)]); };
  const session = { onData: original, send: (_, __, b) => acknowledgments.push(b.readUInt16BE(4)) };
  const adapter = orderedRecordingPackets(session, assert.fail);
  session.onData(packet(2)); session.onData(packet(0)); session.onData(packet(2));
  session.onData(packet(9, 2)); session.onData(packet(1)); session.onData(packet(0));
  assert.deepEqual(received, [[3, 0], [2, 9], [3, 1], [3, 2]]);
  assert.equal(adapter.pending, 0); assert.equal(acknowledgments.length, 5);
  adapter.close(); assert.equal(session.onData, original);
});
test('rejects an unbounded gap without passing corrupt data to the SDK', () => {
  let error; const session = { onData: () => assert.fail(), send() {} };
  const adapter = orderedRecordingPackets(session, e => { error = e; });
  session.onData(packet(2049)); assert.equal(error.status, 502); adapter.close();
});

test('reassembles headers split across packets without losing the next video frame', () => {
  const frames = []; const session = { onData: () => assert.fail('SDK lossy parser called'),
    send() {}, handleFrame: (h, b, type) => frames.push({ command: h.commandId, bytes: b.toString(), type }) };
  const frame = text => { const h = Buffer.alloc(16); h.write('XZYH'); h.writeUInt16LE(1300, 4);
    h.writeUInt32LE(text.length, 6); return Buffer.concat([h, Buffer.from(text)]); };
  const stream = Buffer.concat([frame('one'), frame('two')]);
  const part = (seq, bytes) => Buffer.concat([packet(seq).subarray(0, 8), bytes]);
  const adapter = orderedRecordingPackets(session, assert.fail);
  session.onData(part(1, stream.subarray(22))); session.onData(part(0, stream.subarray(0, 22)));
  assert.deepEqual(frames, [{ command: 1300, bytes: 'one', type: 3 }, { command: 1300, bytes: 'two', type: 3 }]);
  assert.equal(adapter.pending, 0); adapter.close();
});
