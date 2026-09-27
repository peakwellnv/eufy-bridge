import { MediaError } from './media.js';

/** SDK 0.1.2 discards late datagrams. File transfers must preserve binary order.
 * Scoped to one exclusive download; ordinary control/live traffic is untouched.
 */
export function orderedRecordingPackets(session, fail, dataType = 3) {
  const original = session.onData;
  const queued = new Map();
  let next = dataType === 3 ? 0 : ((session.lastSeqByType?.get(dataType) ?? -1) + 1) & 65535;
  let bytes = 0, closed = false, stream = Buffer.alloc(0);
  function ordered(message, peer) {
    if (message[5] !== dataType) return original.call(this, message, peer);
    if (closed || message.length < 8) return;
    const sequence = message.readUInt16BE(6);
    const ahead = (sequence - next) & 65535;
    if (ahead > 32768) return acknowledge.call(this, peer, sequence);
    if (ahead > 2048 || bytes + message.length > 4 * 1024 * 1024) {
      closed = true; fail(new MediaError('Saved recording packet window exceeded', 502)); return;
    }
    acknowledge.call(this, peer, sequence);
    if (queued.has(sequence)) return;
    queued.set(sequence, { message, peer }); bytes += message.length;
    while (!closed && queued.has(next)) {
      const packet = queued.get(next); queued.delete(next); bytes -= packet.message.length;
      session.lastSeqByType?.set(dataType, next);
      next = (next + 1) & 65535;
      if (typeof session.handleFrame !== 'function') original.call(this, packet.message, packet.peer);
      else {
        stream = Buffer.concat([stream, packet.message.subarray(8)]);
        while (!closed && stream.length >= 16) {
          if (stream.toString('ascii', 0, 4) !== 'XZYH' || stream.readUInt32LE(6) > 1024 * 1024) {
            closed = true; fail(new MediaError('Invalid saved recording frame')); return;
          }
          const length = stream.readUInt32LE(6);
          if (stream.length < 16 + length) break;
          const header = { commandId: stream.readUInt16LE(4), bytesToRead: length,
            channel: stream[12], signCode: stream[13], type: stream[14] };
          const body = stream.subarray(16, 16 + length);
          stream = stream.subarray(16 + length);
          session.handleFrame(header, body, dataType);
        }
      }
    }
  }
  function acknowledge(peer, sequence) {
    const payload = Buffer.from([0xd1, dataType, 0, 1, 0, 0]);
    payload.writeUInt16BE(sequence, 4);
    this.send(peer, Buffer.from([0xf1, 0xd1]), payload);
  }
  session.onData = ordered;
  return {
    get pending() { return queued.size + (stream.length ? 1 : 0); },
    close() { closed = true; if (session.onData === ordered) session.onData = original; queued.clear(); stream = Buffer.alloc(0); },
  };
}
