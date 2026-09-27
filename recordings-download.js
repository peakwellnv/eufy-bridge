import { createDecipheriv } from 'node:crypto';
import { getImageKey, p2pCodec } from '@mega-yfue/eufy-sdk';
import { MediaError } from './media.js';
import { orderedRecordingPackets } from './recordings-transport.js';
import { RECORDING_MAX_BYTES, muxSavedRecording } from './recordings-mp4.js';

export function recordingAckKey(data, cameraSn, did) {
  if (!Buffer.isBuffer(data) || data.length !== 36 || data.readInt32LE(0) !== 0)
    throw new MediaError('Camera rejected the saved recording download');
  const code = data.subarray(4).toString('ascii').replace(/\0.*$/s, '');
  if (!/^\d{10}$/.test(code)) throw new MediaError('Unsupported saved recording key response', 501);
  return Buffer.from(getImageKey(cameraSn, did, code), 'ascii').subarray(0, 16);
}

export function decodeSavedVideo(frame, key) {
  const data = frame.data;
  if (!Buffer.isBuffer(data) || data.length < 22 || data.readUInt32LE(0) !== data.length - 22 ||
      data[5] !== 2 || ![0, 1].includes(frame.signCode))
    throw new MediaError('Unsupported saved video frame', 501);
  let body = data.subarray(22);
  if (frame.signCode === 1) {
    if (!key || body.length < 128) throw new MediaError('Saved video key is unavailable');
    const decipher = createDecipheriv('aes-128-ecb', key, null); decipher.setAutoPadding(false);
    body = Buffer.concat([decipher.update(body.subarray(0, 128)), decipher.final(), body.subarray(128)]);
  }
  if (body.length < 5 || body[0] !== 0 || body[1] !== 0 || !(body[2] === 1 || body[2] === 0 && body[3] === 1))
    throw new MediaError('Saved video frame could not be decrypted');
  return body;
}

function sendSavedCommand(session, command, plain) {
  // Deliberately limited to download and cancellation, never live or settings.
  if (![1024, 1051].includes(command)) throw new MediaError('Unsupported recording command');
  const payload = p2pCodec.encryptP2PData(p2pCodec.paddingP2PData(plain), session.level1Key);
  const bytes = Buffer.concat([p2pCodec.buildCommandHeader(session.seqNumber, command),
    p2pCodec.buildRawCommandPayload(payload, 0, 1)]);
  session.seqNumber = (session.seqNumber + 1) & 65535;
  session.send(session.connectAddress, p2pCodec.RequestMessageType.DATA, bytes);
}

/** The verified T86P2 cipher-0 path uses an ACK-derived key, not a cloud cipher. */
export async function downloadLocalRecording(context, row, { signal = AbortSignal.timeout(40000), mux = muxSavedRecording } = {}) {
  const { eufy, media, device, cameraSn } = context;
  if (!media?.exclusive || device?.sn !== cameraSn || row?.device_sn !== cameraSn || row.station_sn !== cameraSn ||
      device.raw?.member?.admin_user_id !== eufy?.api?.auth?.userId)
    throw new MediaError('Saved download requires the configured camera owner session', 403);
  if (row.cipher_id !== 0 || row.storage_type !== 1 || row.storage_cloud !== 0 ||
      !cameraSn.startsWith('T86P2')) throw new MediaError('Recording format is not supported by the verified download path', 501);
  if (typeof row.storage_path !== 'string' || !row.storage_path.length || Buffer.byteLength(row.storage_path) > 1024 || row.storage_path.includes('\0') ||
      !Number.isSafeInteger(row.frame_num) || row.frame_num < 1 || row.frame_num > 2460 ||
      !(row.end_time > row.start_time) || row.end_time - row.start_time > 20.5)
    throw new MediaError('Recording exceeds the verified media bounds', 413);
  const router = eufy.p2p, parent = router.stationKeyOf(cameraSn);
  if (parent !== cameraSn) throw new MediaError('Saved downloads require a standalone camera', 501);
  const saved = await media.exclusive(async () => {
    const manager = router.manager;
    manager.retain(parent);
    let session;
    try {
      await router.ensureStation(parent, signal); signal.throwIfAborted();
      session = manager.get(parent);
      if (!session?.isConnected) throw new MediaError('Saved download connection is not ready', 503);
      // Binary sequence starts at zero for a fresh transfer. Close this session
      // before releasing exclusivity so later media cannot inherit its buffers.
      return await new Promise((resolve, reject) => {
        let settled = false, key, finishReceived = false, bytes = 0, count = 0, firstTimestamp, lastTimestamp;
        let packets, control, settleTimer;
        const video = [];
        const finish = error => {
          if (settled) return; settled = true; clearTimeout(settleTimer);
          session.off('data', onData); session.off('close', onClose); session.off('error', onClose);
          signal.removeEventListener('abort', onAbort); control?.close(); packets?.close();
          if (error) {
            try { sendSavedCommand(session, 1051, Buffer.concat([Buffer.alloc(4), p2pCodec.stringWithLength(device.raw.member.admin_user_id)])); } catch {}
            reject(error);
          } else {
            const span = lastTimestamp - firstTimestamp;
            const fps = span > 0 ? (count - 1) * 1000 / span : NaN;
            if (!Number.isFinite(fps) || fps < 1 || fps > 120) return reject(new MediaError('Saved recording timing is invalid'));
            resolve({ annexb: Buffer.concat(video), fps });
          }
        };
        const complete = () => {
          if (!finishReceived || count !== row.frame_num || packets.pending || control.pending) return;
          clearTimeout(settleTimer); settleTimer = setTimeout(() => {
            if (!packets.pending && !control.pending && count === row.frame_num) finish();
          }, 250);
        };
        const onClose = () => finish(new MediaError('Saved recording connection closed'));
        const onAbort = () => finish(new MediaError('Saved recording download timed out', 504));
        const onData = frame => {
          try {
            if (frame.commandId === 1024 && frame.dataType === 0 && frame.type === 1)
              key = recordingAckKey(frame.data, cameraSn, session.cfg.p2pDid);
            if (frame.commandId === 1304) { finishReceived = true; complete(); return; }
            if (frame.dataType !== 3) return;
            bytes += frame.data.length;
            if (bytes >= RECORDING_MAX_BYTES) throw new MediaError('Recording must be smaller than 25 MB', 413);
            if (frame.commandId === 1300) {
              const body = decodeSavedVideo(frame, key);
              if (++count > row.frame_num) throw new MediaError('Saved recording frame count exceeded');
              const timestamp = frame.data.readUIntLE(14, 6);
              if (lastTimestamp !== undefined && timestamp <= lastTimestamp) throw new MediaError('Invalid saved frame order');
              firstTimestamp ??= timestamp; lastTimestamp = timestamp; video.push(body);
            } else if (frame.commandId !== 1301) throw new MediaError('Unexpected saved media frame');
            complete();
          } catch (error) { finish(error instanceof MediaError ? error : new MediaError('Saved recording decode failed')); }
        };
        packets = orderedRecordingPackets(session, finish, 3);
        control = orderedRecordingPackets(session, finish, 2);
        session.on('data', onData); session.on('close', onClose); session.on('error', onClose);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) return onAbort();
        try { sendSavedCommand(session, 1024, Buffer.concat([Buffer.alloc(5),
          p2pCodec.stringWithLength(row.storage_path), p2pCodec.stringWithLength(device.raw.member.admin_user_id)])); }
        catch { finish(new MediaError('Saved recording request failed')); }
      });
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('Saved recording connection failed', signal.aborted ? 504 : 502);
    } finally { await manager.close(parent); manager.release(parent); }
  });
  return mux(saved.annexb, saved.fps);
}
