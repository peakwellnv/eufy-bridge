import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeLocalRecording, localRecordingEpoch, recordingCivilTime } from './recordings-metadata.js';
const row = JSON.parse(readFileSync(new URL('./fixtures/recording-local-captured.json', import.meta.url)));
test('captured owner recording matches the iPhone timestamp in CDT', () => {
  const normalized = normalizeLocalRecording(row, 'CAMERA_REDACTED', 'America/Chicago');
  assert.equal(new Date(normalized.start_time * 1000).toISOString(), '2026-09-27T20:22:34.000Z');
  assert.equal(normalized.end_time - normalized.start_time, 10);
  assert.equal(recordingCivilTime(normalized.start_time * 1000), row.start_time);
});
test('timestamps reject invalid civil dates and ambiguous daylight-saving times', () => {
  for (const value of ['2026-02-30 12:00:00', '2026-11-01 01:30:00', '2026-03-08 02:30:00', 'invalid'])
    assert.throws(() => localRecordingEpoch(value));
  assert.equal(new Date(localRecordingEpoch('2026-01-01 12:00:00') * 1000).toISOString(), '2026-01-01T18:00:00.000Z');
});
test('local metadata refuses foreign cameras, unsafe paths and mismatched storage', () => {
  for (const changes of [{ device_sn: 'OTHER' }, { station_sn: 'OTHER' }, { storage_cloud: 1 }, { storage_path: 'x\0y' }])
    assert.throws(() => normalizeLocalRecording({ ...row, ...changes }, 'CAMERA_REDACTED'));
});
