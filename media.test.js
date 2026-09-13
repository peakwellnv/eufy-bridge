import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CameraMedia, normalizeSnapshot, validateAac, connectionDiagnostics } from './media.js';
const jpeg = Buffer.from([255,216,1,2,255,217]);
const aac = Buffer.from([255,241,96,64,1,31,252,0]);

test('unwrap the actual SDK live snapshot object', () => {
  const shot = normalizeSnapshot({ jpeg, width: 1, height: 1 }, 'live');
  assert.equal(shot.jpeg, jpeg); assert.equal(shot.source, 'live'); assert.ok(shot.capturedAt);
});
test('never label a retained result as a live view', async () => {
  const media = new CameraMedia(async () => ({ snapshotLive: async () => ({jpeg, retained:true}) }));
  await assert.rejects(media.snapshot('live'), /retained/);
  const shot = await media.snapshot('auto'); assert.equal(shot.source, 'stored'); assert.equal(shot.capturedAt, null);
});
test('stored snapshots have unknown capture time', () => {
  assert.equal(normalizeSnapshot(jpeg, 'stored').capturedAt, null);
});
test('failures are not an empty booth observation; release lock', async () => {
  const media = new CameraMedia(async () => ({ snapshotLive: async () => { throw Error('P2P failed'); } }));
  await assert.rejects(media.snapshot(), /P2P failed/); assert.equal(media.busy, false);
});
test('only explicit auto falls back to stored', async () => {
  let calls = 0;
  const media = new CameraMedia(async () => ({ snapshotLive: async () => { throw Error('offline'); }, snapshotStored: async () => {calls++;return jpeg;} }));
  await assert.rejects(media.snapshot(), /offline/); assert.equal(calls,0);
  assert.equal((await media.snapshot('auto')).source,'stored'); assert.equal(calls,1);
});
test('reject overlapping camera operations without starting another wakeup', async () => {
  let release; const media = new CameraMedia(async () => ({}));
  const pending = media.exclusive(() => new Promise(resolve => release=resolve));
  await assert.rejects(media.snapshot(), /busy/); release(); await pending;
});
test('reject malformed camera images', () => {
  for (const value of [undefined, Buffer.alloc(0), {jpeg:Buffer.from('not jpeg')}]) assert.throws(() => normalizeSnapshot(value,'live'), /valid JPEG/);
});
test('validate complete AAC-LC 16k mono frames before waking camera', () => {
  validateAac(aac);
  assert.throws(() => validateAac(aac.subarray(0,7)), /length/);
  const wrongRate=Buffer.from(aac); wrongRate[2]=64; assert.throws(()=>validateAac(wrongRate), /16 kHz/);
  assert.throws(()=>validateAac(Buffer.concat(Array(470).fill(aac))), /30 seconds/);
});
test('talkback awaits paced finished event, closes handle, reports transmission only', async () => {
  const talk = new EventEmitter(); let stopped = false;
  talk.write = () => {}; talk.end = () => queueMicrotask(()=>talk.emit('finished'));
  talk.stop = async()=> { stopped=true; talk.emit('stop'); };
  const media = new CameraMedia(async()=>({snapshotLive:async()=>({jpeg}),talkback:async()=>talk}));
  const result=await media.speak(aac); assert.equal(result.status,'transmitted'); assert.equal(result.audibleAtCamera,'unconfirmed'); assert.ok(stopped);
});
test('talkback transport errors and early stop never report success', async () => {
  for (const event of ['error','stop']) {
    const talk = new EventEmitter(); let stopped=false;
    talk.write=()=>{}; talk.end=()=>queueMicrotask(()=>talk.emit(event,new Error('lost audio')));
    talk.stop=async()=>{stopped=true;};
    const media=new CameraMedia(async()=>({snapshotLive:async()=>({jpeg}),talkback:async()=>talk}));
    await assert.rejects(media.speak(aac)); assert.ok(stopped); assert.equal(media.busy,false);
  }
});
test('unsupported talkback fails explicitly', async()=>{
  await assert.rejects(new CameraMedia(async()=>({})).speak(aac), /not verified/);
});
test('protocol diagnostics retain counters, never payloads or secrets',()=>{
  const d=connectionDiagnostics();
  d.logger.debug('[p2p] PRIVATE_SERIAL <<< 192.0.2.1:32100 header=f169 len=40');
  d.logger.debug('UNHANDLED payload hex: PRIVATE_KEY');
  const out=JSON.stringify(d.snapshot()); assert.equal(d.snapshot().counts.relayOffer,1);
  assert.doesNotMatch(out,/PRIVATE|192\.0/);
});

test('retry one failed camera wakeup before transmitting exactly once', async()=>{
  let wakes=0, starts=0, writes=0;
  const talk=new EventEmitter();talk.write=()=>writes++;talk.end=()=>queueMicrotask(()=>talk.emit('finished'));talk.stop=async()=>{};
  const media=new CameraMedia(async()=>({snapshotLive:async()=>{if(++wakes===1)throw Error('cold start timed out');return {jpeg};},talkback:async()=>{starts++;return talk;}}));
  assert.equal((await media.speak(aac)).status,'transmitted');
  assert.equal(wakes,2);assert.equal(starts,1);assert.equal(writes,1);
});
test('two failed wakeups report definitely unspoken and never start talkback',async()=>{
  let wakes=0,starts=0;
  const media=new CameraMedia(async()=>({snapshotLive:async()=>{wakes++;throw Error('offline');},talkback:async()=>{starts++;}}));
  await assert.rejects(media.speak(aac),error=>error.code==='camera_not_ready'&&error.status===503);
  assert.equal(wakes,2);assert.equal(starts,0);assert.equal(media.busy,false);
});

test('live diagnostics keep phase counters while discarding source and arbitrary fields',()=>{
 const d=connectionDiagnostics();
 d.logger.debug('[live] start trace',{phase:'video-decode-empty',source:'PRIVATE_SERIAL',secret:'PRIVATE_KEY'});
 d.logger.debug('[live] start trace',{phase:'media-command',action:'start',level2:false});
 assert.equal(d.snapshot().counts['live_video-decode-empty'],1);
 assert.equal(d.snapshot().counts.mediaStartL1,1);
 assert.doesNotMatch(JSON.stringify(d.snapshot()),/PRIVATE/);
});
