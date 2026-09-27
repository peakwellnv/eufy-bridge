import { MediaError } from './media.js';

export function recordingCivilTime(time, timeZone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(time);
  const get = key => parts.find(part => part.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function localRecordingEpoch(value, timeZone = 'America/Chicago') {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value))
    throw new MediaError('Invalid local recording timestamp');
  const nominal = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(nominal)) throw new MediaError('Invalid local recording timestamp');
  // Determine possible offsets on both sides of a daylight-saving transition.
  const candidates = new Set();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = nominal + delta;
    const civil = Date.parse(recordingCivilTime(sample, timeZone).replace(' ', 'T') + 'Z');
    const candidate = nominal - (civil - sample);
    if (recordingCivilTime(candidate, timeZone) === value) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new MediaError('Local recording timestamp is invalid or ambiguous');
  return [...candidates][0] / 1000;
}

export function normalizeLocalRecording(row, cameraSn, timeZone) {
  if (row?.device_sn !== cameraSn || row.station_sn !== cameraSn || row.storage_type !== 1 || row.storage_cloud !== 0)
    throw new MediaError('Unexpected local recording scope or storage');
  if (!Number.isSafeInteger(row.record_id) || row.record_id < 0 || typeof row.storage_path !== 'string' ||
      !row.storage_path.length || Buffer.byteLength(row.storage_path) > 1024 || row.storage_path.includes('\0'))
    throw new MediaError('Invalid local recording identity');
  return { ...row, monitor_id: row.record_id, start_time: localRecordingEpoch(row.start_time, timeZone),
    end_time: localRecordingEpoch(row.end_time, timeZone) };
}
