import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readLocalRecordingRows, localCalendarQuery } from './recordings-local.js';
import { CameraMedia } from './media.js';

const query = { since: Date.parse('2026-09-27T05:00:00Z'), until: Date.parse('2026-09-28T02:00:00Z'), limit: 5 };
function setup(ensure) {
  const session = new EventEmitter();
  session.isConnected = false;
  const calls = [];
  const manager = { get: () => session, retain: () => calls.push('retain'), release: () => calls.push('release'), close: async () => calls.push('close') };
  const router = { manager, stationKeyOf: () => 'CAMERA', ensureStation: async (...args) => { calls.push('connect'); await ensure?.(...args); session.isConnected = true; } };
  session.queryDatabase = (table, options) => {
    assert.equal(session.isConnected, true); calls.push('query');
    assert.equal(table, 'history_record_info'); assert.equal(options.innerCmd, 10017);
    queueMicrotask(() => session.emit('data', { commandId: 1306, json: { cmd: 10017, mIntRet: 0, data: [] } }));
  };
  return { session, calls, context: { eufy: { p2p: router, api: { auth: { userId: 'OWNER' } } },
    media: new CameraMedia(async () => ({})), cameraSn: 'CAMERA', device: { sn: 'CAMERA', raw: { member: { admin_user_id: 'OWNER' } } } } };
}

test('calendar uses the camera civil day across the UTC date boundary', () => {
  const body = localCalendarQuery('CAMERA', query);
  assert.equal(body.start_date, '20260927'); assert.equal(body.end_date, '20260928');
  assert.equal(body.start_time, '0'); // First page, not midnight: captured from the iPhone app.
  assert.equal(body.device_info, undefined); assert.equal(body.res_unzip, undefined);
});

test('waits for the completed handshake and holds the existing media lock', async () => {
  let connect; const s = setup(() => new Promise(resolve => { connect = resolve; }));
  const pending = readLocalRecordingRows(s.context, query);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s.calls, ['retain', 'connect']);
  await assert.rejects(s.context.media.exclusive(() => {}), { status: 409 });
  connect(); assert.deepEqual(await pending, []);
  assert.deepEqual(s.calls, ['retain', 'connect', 'query', 'release']);
  assert.equal(s.context.media.busy, false);
  assert.equal(s.session.listenerCount('data'), 0);
});

test('connection errors are sanitized and do not issue a database command', async () => {
  const s = setup(() => { throw new Error('private token'); });
  await assert.rejects(readLocalRecordingRows(s.context, query), { message: 'Local recordings connection failed' });
  assert.deepEqual(s.calls, ['retain', 'connect', 'release']); assert.equal(s.context.media.busy, false);
});

test('query abort removes listeners and releases the media lock', async () => {
  const s = setup(); const controller = new AbortController();
  s.session.queryDatabase = () => controller.abort();
  await assert.rejects(readLocalRecordingRows(s.context, query, { signal: controller.signal }), { status: 504 });
  for (const event of ['data', 'dbChunk', 'error', 'close']) assert.equal(s.session.listenerCount(event), 0);
  assert.equal(s.context.media.busy, false);
});

test('camera rejection without a command id fails promptly', async () => {
  const s = setup(); s.session.queryDatabase = () => s.session.emit('data', { commandId: 1306, json: { mIntRet: -6006 } });
  await assert.rejects(readLocalRecordingRows(s.context, query), { status: 501 });
});

test('foreign records and non-owner sessions fail closed', async () => {
  const s = setup(); s.session.queryDatabase = () => s.session.emit('data', { commandId: 1306,
    json: { cmd: 10017, mIntRet: 0, data: [{ table_name: 'history_record_info', payload: [{ device_sn: 'OTHER', station_sn: 'CAMERA' }] }] } });
  await assert.rejects(readLocalRecordingRows(s.context, query), /out-of-scope/);
  s.context.device.raw.member.admin_user_id = 'OTHER';
  await assert.rejects(readLocalRecordingRows(s.context, query), { status: 403 });
});

test('one cold-connection retry shares the deadline and closes its session', async () => {
  const s = setup(); const router = s.context.eufy.p2p;
  let present = false, attempts = 0; const signal = new AbortController().signal;
  router.manager.get = () => present ? s.session : undefined;
  router.manager.close = async () => { present = false; s.calls.push('close'); };
  router.ensureStation = async (_, suppliedSignal) => {
    assert.equal(suppliedSignal, signal); present = true; s.calls.push('connect');
    if (++attempts === 1) throw new Error('P2P connect timeout for PRIVATE_SERIAL');
    s.session.isConnected = true;
  };
  assert.deepEqual(await readLocalRecordingRows(s.context, query, { signal }), []);
  assert.deepEqual(s.calls, ['retain', 'connect', 'close', 'retain', 'connect', 'query', 'release', 'close']);
  assert.equal(present, false);
});


test('accepts complete SDK database chunks but not partial JSON', async () => {
  const s = setup();
  s.session.queryDatabase = () => {
    s.session.emit('dbChunk', { text: '{"cmd":10017,' });
    s.session.emit('dbChunk', { text: '{"cmd":10017,"mIntRet":0,"data":[]}\0padding' });
  };
  assert.deepEqual(await readLocalRecordingRows(s.context, query), []);
  assert.equal(s.session.listenerCount('dbChunk'), 0);
});

test('rejects invalid date ranges before connecting', async () => {
  const s = setup();
  await assert.rejects(readLocalRecordingRows(s.context, { ...query, limit: 0 }), { status: 400 });
  await assert.rejects(readLocalRecordingRows(s.context, { ...query, since: NaN }), { status: 400 });
  assert.deepEqual(s.calls, []);
});

test('negative command acknowledgment fails without waiting for a calendar timeout', async () => {
  const s = setup(); const data = Buffer.alloc(36); data.writeInt32LE(-1);
  s.session.queryDatabase = () => s.session.emit('data', { commandId: 1350, dataType: 0, type: 1, data });
  await assert.rejects(readLocalRecordingRows(s.context, query), { status: 502 });
  assert.equal(s.context.media.busy, false);
});


test('parses the reference local table wrapper (synthetic, not a captured record)', async () => {
  const s = setup(); const row = { device_sn: 'CAMERA', station_sn: 'CAMERA', record_id: 123 };
  s.session.queryDatabase = () => s.session.emit('data', { commandId: 1306,
    json: { cmd: 10017, mIntRet: 0, data: [{ table_name: 'history_record_info', payload: [row] }] } });
  assert.deepEqual(await readLocalRecordingRows(s.context, query), [row]);
});
