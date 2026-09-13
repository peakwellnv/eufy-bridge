import { createHash } from 'node:crypto';

export class MediaError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function normalizeSnapshot(value, requestedSource) {
  const jpeg = Buffer.isBuffer(value) ? value : value?.jpeg;
  if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9)
    throw new MediaError('Camera did not return a valid JPEG');
  const source = value?.retained ? 'stored' : requestedSource;
  return { jpeg, source, capturedAt: source === 'live' ? new Date().toISOString() : null,
    retrievedAt: new Date().toISOString(), sha256: createHash('sha256').update(jpeg).digest('hex') };
}

/** One media operation at a time; reject overlap instead of piling up battery wakeups. */
export class CameraMedia {
  constructor(getCamera) { this.getCamera = getCamera; this.busy = false; }
  async exclusive(fn) {
    if (this.busy) throw new MediaError('Camera is busy; retry after the current operation finishes', 409);
    this.busy = true;
    try { return await fn(await this.getCamera()); } finally { this.busy = false; }
  }
  async snapshot(mode = 'live') {
    if (!['live', 'stored', 'auto'].includes(mode)) throw new MediaError('mode must be live, stored, or auto', 400);
    return this.exclusive(async cam => {
      if (mode !== 'stored') {
        try {
          if (typeof cam.snapshotLive !== 'function') throw new MediaError('Live snapshot API unavailable', 501);
          const shot = normalizeSnapshot(await cam.snapshotLive({ signal: AbortSignal.timeout(45000), timeoutMs: 40000 }), 'live');
          if (mode === 'live' && shot.source !== 'live') throw new MediaError('Only a retained image is available; no fresh view');
          if (shot.source === 'live') this.lastLiveImageAt = shot.capturedAt;
          return shot;
        } catch (error) { if (mode === 'live') throw error; }
      }
      if (typeof cam.snapshotStored !== 'function') throw new MediaError('Stored snapshot API unavailable', 501);
      return normalizeSnapshot(await cam.snapshotStored(), 'stored');
    });
  }
  async clip(seconds = 10) {
    if (!Number.isInteger(seconds) || seconds < 2 || seconds > 20) throw new MediaError('seconds must be an integer from 2 to 20', 400);
    return this.exclusive(async cam => {
      if (typeof cam.recordFragments !== 'function') throw new MediaError('Video/audio recording API unavailable', 501);
      const controller = new AbortController();
      const stream = cam.recordFragments({ fragmentSeconds: 1, signal: controller.signal });
      const chunks = []; let bytes = 0; let mediaBytes = 0; let initialized = false; let timer;
      const startup = setTimeout(() => controller.abort(new Error('Camera did not start video')), 45000);
      try {
        for await (const fragment of stream) {
          if (fragment.init) { chunks.push(fragment.init); bytes += fragment.init.length; initialized = true; }
          if (fragment.data?.length) {
            if (!timer) { clearTimeout(startup); timer = setTimeout(() => stream.stop(), seconds * 1000); }
            chunks.push(fragment.data); bytes += fragment.data.length; mediaBytes += fragment.data.length;
          }
          if (bytes > 25 * 1024 * 1024) throw new MediaError('Clip exceeded the 25 MB limit');
        }
        if (!initialized || !mediaBytes) throw new MediaError('Camera delivered no playable video');
        return Buffer.concat(chunks);
      } finally { clearTimeout(startup); clearTimeout(timer); controller.abort(); stream.stop(); }
    });
  }
  async speak(aac) {
    if (!Buffer.isBuffer(aac) || !aac.length || aac.length > 512 * 1024) throw new MediaError('Send a nonempty AAC clip up to 512 KB', 400);
    validateAac(aac);
    return this.exclusive(async cam => {
      if (typeof cam.talkback !== 'function') throw new MediaError('Talkback is not verified for this device by the SDK', 501);
      // The cellular camera must actually be streaming before accepting talkback.
      // SDK talkback attaches a live consumer but does not await the first frame.
      let warm;
      // A failed cellular cold start can recover on a fresh acquisition. Retry
      // only this pre-speech stage, never talkback or audio transmission.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          warm = normalizeSnapshot(await cam.snapshotLive({ signal: AbortSignal.timeout(25000), timeoutMs: 24000 }), 'live');
          if (warm.source !== 'live') throw new MediaError('No fresh live frame');
          break;
        } catch {
          warm = undefined;
        }
      }
      if (!warm) {
        const error = new MediaError('Camera could not wake for speech; nothing was spoken', 503);
        error.code = 'camera_not_ready';
        throw error;
      }
      this.lastLiveImageAt = warm.capturedAt;
      const talk = await cam.talkback();
      try {
        await new Promise((resolve, reject) => {
          let finished = false;
          const timer = setTimeout(() => reject(new MediaError('Talkback timed out; playback is unconfirmed')), 45000);
          const fail = err => { clearTimeout(timer); reject(err); };
          talk.on('error', fail);
          talk.on('stop', () => { if (!finished) fail(new MediaError('Talkback stopped early; playback is unconfirmed')); });
          talk.on('finished', () => { finished = true; clearTimeout(timer); resolve(); });
          try { talk.write(aac); talk.end(); } catch (err) { fail(err); }
        });
        return { status: 'transmitted', audibleAtCamera: 'unconfirmed', completedAt: new Date().toISOString() };
      } finally { await talk.stop(); }
    });
  }
}

/** Reject malformed or overly long input before waking the camera. */
export function validateAac(data) {
  let offset = 0, frames = 0;
  while (offset < data.length) {
    if (offset + 7 > data.length) throw new MediaError('Truncated ADTS header', 400);
    const b = data.subarray(offset);
    const length = ((b[3] & 3) << 11) | (b[4] << 3) | (b[5] >> 5);
    const channels = ((b[2] & 1) << 2) | (b[3] >> 6);
    if (b[0] !== 255 || (b[1] & 0xf6) !== 0xf0 || (b[2] >> 6) !== 1 || ((b[2] >> 2) & 15) !== 8 || channels !== 1 || (b[6] & 3) !== 0)
      throw new MediaError('Audio must be AAC-LC, 16 kHz, mono ADTS', 400);
    if (length < ((b[1] & 1) ? 7 : 9) || length > 640 || offset + length > data.length) throw new MediaError('Invalid ADTS frame length', 400);
    offset += length; frames++;
    if (frames * 1024 / 16000 > 30) throw new MediaError('Speech must be at most 30 seconds', 400);
  }
}

/** Keep only connection milestones. Never retain raw SDK payloads, keys, addresses, or identities. */
export function connectionDiagnostics() {
  const counts = {}; let lastEventAt = null;
  const patterns = { cloudLookup: /sendLookups: cloud/, missingCloudLookup: /NO cloud lookup/, peerAddress: /LOOKUP_ADDR ->/,
    checkingPeer: /beginCheckCam ->/, connected: /\] .* connected /, connectTimeout: /P2P connect timeout/,
    relayOffer: /header=f169/, incomingPacket: /<<< .*header=/ };
  const phases = new Set(['warming','media-command','first-video-command','first-video-unit','first-keyframe','video-decode-empty','datagram-gap','warm-timeout','start-failed','first-audio','first-foreign-frame']);
  const record = (message, detail) => {
    if (message === '[live] start trace' && phases.has(detail?.phase)) {
      const key = 'live_' + detail.phase;
      counts[key] = (counts[key] || 0) + 1;
      if (detail.phase === 'media-command' && detail.action === 'start') {
        const mode = detail.level2 ? 'mediaStartL2' : 'mediaStartL1';
        counts[mode] = (counts[mode] || 0) + 1;
      }
      lastEventAt = new Date().toISOString();
    }
    if (String(message).includes('dropped an incomplete access unit')) counts.incompleteVideoUnit = (counts.incompleteVideoUnit || 0) + 1;

    const stage = String(message).match(/relay-step: (\w+)/);
    if (stage) counts[stage[1]] = (counts[stage[1]] || 0) + 1;
    const header = String(message).match(/header=(f1[0-9a-f]{2})/);
    if (header) counts[header[1]] = (counts[header[1]] || 0) + 1;
    for (const [key, pattern] of Object.entries(patterns)) if (pattern.test(String(message))) {
      counts[key] = (counts[key] || 0) + 1; lastEventAt = new Date().toISOString();
    }
  };
  return { logger: { debug: record, info: record, warn: record, error: record },
    snapshot: () => ({ counts: { ...counts }, lastEventAt }) };
}
