import { createHmac, randomBytes } from 'node:crypto';
import { MediaError } from './media.js';
import { checkRecordingBytes, validateRecordingMp4 } from './recordings-mp4.js';

export const RECORDINGS_LIST_INTERVAL_MS = 60000;
const CACHE_TTL_MS = 15 * 60000;
const EVENT_PATH = '/v3/event/app/get_all_video_record';

function dateValue(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d))?$/.test(value))
    throw new MediaError(`${name} must be an ISO date or timestamp with timezone`, 400);
  const time = Date.parse(value);
  const day = value.slice(0, 10);
  if (!Number.isFinite(time) || new Date(Date.parse(day)).toISOString().slice(0, 10) !== day)
    throw new MediaError(`${name} is not a valid date`, 400);
  return time;
}

export function recordingQuery({ since, until, limit } = {}, now = Date.now()) {
  const end = dateValue(until, 'until', now);
  const start = dateValue(since, 'since', end - 86400000);
  const count = limit === undefined ? 20 : typeof limit === 'number' ? limit :
    typeof limit === 'string' && /^[1-9]\d*$/.test(limit) ? Number(limit) : NaN;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100)
    throw new MediaError('limit must be an integer from 1 to 100', 400);
  if (start >= end || end - start > 7 * 86400000 || end > now + 60000)
    throw new MediaError('Date range must be ordered, at most seven days, and not in the future', 400);
  return { since: start, until: end, limit: count };
}

/** Explicit field selection is essential: upstream records contain credentials. */
export function parseRecording(record, cameraSn, id) {
  if (!record || record.device_sn !== cameraSn)
    throw new MediaError('Recording response contains an unexpected device');
  if (![1, 2, 3].includes(record.storage_type))
    throw new MediaError('Recording storage type is unsupported', 501);
  const start = record.start_time, end = record.end_time;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
      end <= start || end * 1000 > 8640000000000000 ||
      !Number.isSafeInteger(record.video_type) || !Number.isSafeInteger(record.monitor_id) || record.monitor_id < 0)
    throw new MediaError('Recording metadata is invalid');
  return { id, startedAt: new Date(start * 1000).toISOString(), endedAt: new Date(end * 1000).toISOString(),
    durationSeconds: end - start, storage: record.storage_type === 1 ? 'local' : 'cloud', eventType: record.video_type };
}

/** Read-only SDK wrapper. No camera API, live stream, or settings transport is used.
 * The current account returns null from the event endpoint; that is a failure,
 * not evidence of an empty day. See docs/RECORDINGS_RESEARCH.md.
 */
export class Recordings {
  constructor(getContext, { now = Date.now, validateMp4 = validateRecordingMp4 } = {}) {
    this.getContext = getContext;
    this.now = now;
    this.validateMp4 = validateMp4;
    this.nextListAt = 0;
    this.listing = false;
    this.downloading = false;
    this.records = new Map();
    this.key = randomBytes(32);
  }

  async context() {
    const context = await this.getContext();
    const { api, device, cameraSn } = context;
    if (!api?.auth?.userId || !cameraSn || device?.sn !== cameraSn ||
        device.raw?.member?.admin_user_id !== api.auth.userId)
      throw new MediaError('Recordings require the configured camera owner session', 403);
    return context;
  }

  async listRecordings(options = {}) {
    const now = this.now();
    const query = recordingQuery(options, now);
    if (this.listing || now < this.nextListAt)
      throw new MediaError('Recording lists are limited to one request per minute', 429);
    this.nextListAt = now + RECORDINGS_LIST_INTERVAL_MS;
    this.listing = true;
    try {
      const { api, device, cameraSn } = await this.context();
      const rows = await api.securityAppPost(EVENT_PATH, {
        device_sn: cameraSn, station_sn: device.stationSn || cameraSn,
        start_time: Math.floor(query.since / 1000), end_time: Math.floor(query.until / 1000),
        exclude_guest: true, house_id: 'HOUSEID_ALL_DEVICE', id: 0, id_type: 1,
        is_favorite: false, num: query.limit, pullup: true, shared: false, storage: 0,
        transaction: String(now),
      });
      if (!Array.isArray(rows))
        throw new MediaError('Recordings API returned no event array; saved recordings are not yet available', 502);
      if (rows.length > query.limit) throw new MediaError('Recordings API exceeded the requested limit');
      const pending = new Map();
      const metadata = rows.map(row => {
        const id = createHmac('sha256', this.key).update(JSON.stringify([
          cameraSn, row.monitor_id, row.start_time, row.end_time, row.storage_type,
        ])).digest('hex');
        const result = parseRecording(row, cameraSn, id);
        if (row.start_time < Math.floor(query.since / 1000) || row.start_time > Math.floor(query.until / 1000))
          throw new MediaError('Recordings API returned an event outside the requested range');
        if (pending.has(id)) throw new MediaError('Recordings API returned duplicate events');
        pending.set(id, { cameraSn, ownerId: api.auth.userId, expiresAt: this.now() + CACHE_TTL_MS,
          storage: result.storage, cipherId: row.cipher_id,
          url: row.cloud_path || row.storage_path, durationSeconds: result.durationSeconds });
        return result;
      });
      // Keep a bounded cache; old handles expire and must be listed again.
      for (const [id, record] of this.records) if (record.expiresAt <= now) this.records.delete(id);
      for (const [id, record] of pending) this.records.set(id, record);
      while (this.records.size > 500) this.records.delete(this.records.keys().next().value);
      // Pagination is unverified; explicitly report when this page may be truncated.
      return { recordings: metadata, possiblyTruncated: rows.length === query.limit };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('Recordings service unavailable');
    } finally { this.listing = false; }
  }

  async downloadRecording(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new MediaError('Unknown recording', 404);
    const record = this.records.get(id);
    if (!record || record.expiresAt <= this.now()) {
      this.records.delete(id);
      throw new MediaError('Recording handle expired or unknown; list recordings again', 404);
    }
    if (this.downloading) throw new MediaError('A recording download is already in progress', 409);
    this.downloading = true;
    try {
      const { api, cameraSn } = await this.context();
      if (cameraSn !== record.cameraSn || api.auth.userId !== record.ownerId)
        throw new MediaError('Unknown recording', 404);
      if (record.storage === 'local')
        throw new MediaError('Local recording download is not verified for this camera', 501);
      if (record.cipherId !== 0)
        throw new MediaError('Recording encryption is not supported by the verified download path', 501);
      if (record.durationSeconds > 20.5)
        throw new MediaError('Recording exceeds the 20-second consumer limit', 413);
      // Keep the SDK's host, redirect, DNS, timeout, credential and 10 MiB guards.
      // Direct object-store URLs are deliberately refused; do not relax this on guesses.
      let url;
      try { url = new URL(record.url); } catch { throw new MediaError('Recording download URL is unsupported', 501); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !/^security-app(?:-(?:eu|ie))?\.eufylife\.com$/.test(url.hostname))
        throw new MediaError('Recording download host is not supported', 501);
      const bytes = await api.downloadMedia(url.href);
      checkRecordingBytes(bytes);
      return await this.validateMp4(bytes);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('Recording download failed; the SDK transport also limits downloads to 10 MB');
    } finally { this.downloading = false; }
  }
}
