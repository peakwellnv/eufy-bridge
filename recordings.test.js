import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Recordings, recordingQuery, parseRecording } from './recordings.js';
import { RECORDING_MAX_BYTES, checkRecordingBytes } from './recordings-mp4.js';

// Synthetic schema examples, not captured camera recordings. The only captured
// list evidence is the null response in docs/fixtures/recordings-api-observations.json.
const now = Date.parse('2026-09-27T18:00:00Z');
const cameraSn = 'CAMERA_REDACTED';
const row = { monitor_id: 42, device_sn: cameraSn, storage_type: 2,
  start_time: now / 1000 - 100, end_time: now / 1000 - 90, video_type: 1,
  cloud_path: 'https://security-app.eufylife.com/redacted', cipher_id: 0,
  auth_token: 'DO_NOT_EXPOSE', p2p_license: 'DO_NOT_EXPOSE', cipher_user_id: 'OWNER_REDACTED' };
const fakeMp4 = Buffer.from([0,0,0,12,102,116,121,112,105,115,111,109]);
function setup(rows = [row], overrides = {}) {
  let time = now; const requests = []; const downloads = [];
  const api = { auth: { userId: 'OWNER_REDACTED' },
    securityAppPost: async (...args) => { requests.push(args); return rows; },
    downloadMedia: async url => { downloads.push(url); return fakeMp4; }, ...overrides };
  const context = { api, cameraSn, device: { sn: cameraSn, stationSn: cameraSn,
    raw: { member: { admin_user_id: api.auth.userId } } } };
  const recordings = new Recordings(async () => context, { now: () => time, validateMp4: async bytes => bytes });
  return { recordings, api, requests, downloads, context, advance: ms => { time += ms; } };
}

test('list projects safe metadata and opaque handles, scopes the request to the owner camera', async () => {
  const { recordings, requests } = setup();
  const result = await recordings.listRecordings();
  assert.equal(result.recordings.length, 1);
  assert.deepEqual(Object.keys(result.recordings[0]), ['id','startedAt','endedAt','durationSeconds','storage','eventType']);
  assert.match(result.recordings[0].id, /^[a-f0-9]{64}$/);
  assert.equal(result.recordings[0].durationSeconds, 10);
  assert.equal(result.possiblyTruncated, false);
  assert.doesNotMatch(JSON.stringify(result), /REDACTED|DO_NOT_EXPOSE|https|license|token/);
  assert.equal(requests[0][0], '/v3/event/app/get_all_video_record');
  assert.equal(requests[0][1].device_sn, cameraSn);
  assert.equal(requests[0][1].shared, false);
});

test('captured decrypted null fails instead of being presented as no recordings', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./docs/fixtures/recordings-api-observations.json', import.meta.url)));
  const { recordings } = setup(fixture.probes.at(-1).decryptedData);
  await assert.rejects(recordings.listRecordings(), /no event array/);
});

test('explicit empty arrays and full pages have distinct completion metadata', async () => {
  assert.deepEqual(await setup([]).recordings.listRecordings(), { recordings: [], possiblyTruncated: false });
  assert.equal((await setup().recordings.listRecordings({ limit: 1 })).possiblyTruncated, true);
});

test('query rejects malformed, ambiguous, oversized and future requests before API access', async () => {
  const invalid = [{ limit: '1.5' }, { limit: 0 }, { limit: 101 }, { limit: ['2'] },
    { since: 'today' }, { since: '2026-02-30' }, { since: '2026-09-27T12:00:00' },
    { since: '2026-09-01' }, { until: '2027-01-01' }, { since: '2026-09-27', until: '2026-09-27' }];
  const { recordings, requests } = setup();
  for (const query of invalid) await assert.rejects(recordings.listRecordings(query), { status: 400 });
  assert.equal(requests.length, 0);
  assert.equal(recordingQuery({ since: '2026-09-27' }, now).since, Date.parse('2026-09-27'));
});

test('rate limiter rejects overlap and rapid repeats including failed requests', async () => {
  let finish;
  const { recordings, requests, advance } = setup();
  const original = recordings.getContext;
  recordings.getContext = () => new Promise(resolve => { finish = () => resolve(original()); });
  const first = recordings.listRecordings();
  await assert.rejects(recordings.listRecordings(), { status: 429 });
  finish(); await first;
  recordings.getContext = original;
  await assert.rejects(recordings.listRecordings(), { status: 429 });
  advance(60000); await recordings.listRecordings();
  assert.equal(requests.length, 2);
  const failed = setup(null);
  await assert.rejects(failed.recordings.listRecordings());
  await assert.rejects(failed.recordings.listRecordings(), { status: 429 });
});

test('foreign, malformed, duplicate and out-of-range records fail without caching partial results', async () => {
  for (const rows of [[{ ...row, device_sn: 'FOREIGN' }], [{ ...row, end_time: 0 }],
    [{ ...row, storage_type: 99 }], [row, row], [{ ...row, start_time: 1 }]]) {
    const { recordings } = setup(rows);
    await assert.rejects(recordings.listRecordings());
    assert.equal(recordings.records.size, 0);
  }
  assert.equal(parseRecording({ ...row, storage_type: 1 }, cameraSn, 'id').storage, 'local');
  assert.equal(parseRecording({ ...row, storage_type: 3 }, cameraSn, 'id').storage, 'cloud');
});

test('owner mismatch blocks all API work', async () => {
  const { recordings, context, requests } = setup();
  context.device.raw.member.admin_user_id = 'OTHER';
  await assert.rejects(recordings.listRecordings(), { status: 403 });
  assert.equal(requests.length, 0);
});

test('only listed unencrypted supported cloud URLs reach the SDK downloader', async () => {
  const { recordings, downloads } = setup();
  const { recordings: [record] } = await recordings.listRecordings();
  assert.deepEqual(await recordings.downloadRecording(record.id), fakeMp4);
  assert.deepEqual(downloads, [row.cloud_path]);
  await assert.rejects(recordings.downloadRecording('https://example.com'), { status: 404 });
  await assert.rejects(recordings.downloadRecording('a'.repeat(64)), { status: 404 });
});

test('unsupported storage, cipher, duration and hosts fail before any download', async () => {
  for (const changes of [{ storage_type: 1 }, { cipher_id: 42 }, { cipher_id: undefined },
    { end_time: row.start_time + 30 }, { cloud_path: 'http://security-app.eufylife.com/x' },
    { cloud_path: 'https://evil.example/x' }, { cloud_path: 'https://user:password@security-app.eufylife.com/x' },
    { cloud_path: 'https://security-app.eufylife.com:444/x' }, { cloud_path: '/local/file' }]) {
    const { recordings, downloads } = setup([{ ...row, ...changes }]);
    const { recordings: [record] } = await recordings.listRecordings();
    await assert.rejects(recordings.downloadRecording(record.id));
    assert.equal(downloads.length, 0);
  }
});

test('expired handles and changed account identities cannot download', async () => {
  const s = setup();
  const { recordings: [record] } = await s.recordings.listRecordings();
  s.advance(15 * 60000);
  await assert.rejects(s.recordings.downloadRecording(record.id), { status: 404 });
  const t = setup();
  const listed = (await t.recordings.listRecordings()).recordings[0];
  t.api.auth.userId = 'OTHER'; t.context.device.raw.member.admin_user_id = 'OTHER';
  await assert.rejects(t.recordings.downloadRecording(listed.id), { status: 404 });
  assert.equal(t.downloads.length, 0);
});

test('download overlap is rejected and SDK errors never escape with secrets', async () => {
  let finish;
  const s = setup([row], { downloadMedia: () => new Promise(resolve => { finish = resolve; }) });
  const { recordings: [record] } = await s.recordings.listRecordings();
  const first = s.recordings.downloadRecording(record.id);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(s.recordings.downloadRecording(record.id), { status: 409 });
  finish(fakeMp4); await first;
  s.api.downloadMedia = async () => { throw Error('https://private.example/token=DO_NOT_EXPOSE'); };
  await assert.rejects(s.recordings.downloadRecording(record.id), error => !/DO_NOT_EXPOSE|private/.test(error.message));
  assert.equal(s.recordings.downloading, false);
});

test('25 MB ceiling is checked before decoding; truncated/non-MP4 bytes are rejected', async () => {
  assert.throws(() => checkRecordingBytes(Buffer.alloc(RECORDING_MAX_BYTES)), { status: 413 });
  assert.throws(() => checkRecordingBytes(Buffer.alloc(RECORDING_MAX_BYTES + 1)), { status: 413 });
  assert.throws(() => checkRecordingBytes(Buffer.from('not an mp4 file')), /not an MP4/);
  const s = setup([row], { downloadMedia: async () => Buffer.alloc(RECORDING_MAX_BYTES) });
  const { recordings: [record] } = await s.recordings.listRecordings();
  let validated = false; s.recordings.validateMp4 = async () => { validated = true; };
  await assert.rejects(s.recordings.downloadRecording(record.id), { status: 413 });
  assert.equal(validated, false);
});

test('recordings module has no SDK settings or live-camera command references', () => {
  const source = readFileSync(new URL('./recordings.js', import.meta.url), 'utf8');
  const commands = readFileSync(new URL('./node_modules/@mega-yfue/eufy-sdk/dist/transport/p2p/commands.d.ts', import.meta.url), 'utf8');
  const settings = [...commands.matchAll(/\bCMD_[A-Z0-9_]+/g)].map(match => match[0])
    .filter(name => /SET|SWITCH|ENABLE|DISABLE|FORMAT|REBOOT|DELETE/.test(name));
  assert.ok(settings.length > 0);
  for (const name of settings) assert.equal(source.includes(name), false, name);
  assert.doesNotMatch(source, /\.setDetection\(|\.live\(|\.snapshotLive\(|\.recordFragments\(|\.sendCommand\(/);
});
