import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpeechLedger } from './speech-ledger.js';
import { transcode } from './transcode.js';
import { validateAac } from './media.js';

test('speech receipts survive restart and refuse changed or uncertain replay',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'sage-speech-'));
 try {
  const ledger=new SpeechLedger(dir);let sends=0;
  const send=async()=>{sends++;return {status:'transmitted'};};
  await ledger.run('request-one',Buffer.from('a'),send);
  assert.deepEqual(await new SpeechLedger(dir).run('request-one',Buffer.from('a'),send),{status:'transmitted'});
  await assert.rejects(ledger.run('request-one',Buffer.from('b'),send),/different audio/);
  await assert.rejects(ledger.run('request-two',Buffer.from('a'),async()=>{throw Error('connection lost');}));
  await assert.rejects(new SpeechLedger(dir).run('request-two',Buffer.from('a'),send),/uncertain/);
  assert.equal(sends,1);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('concurrent speech requests cannot both transmit',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'sage-speech-'));let release;
 try{
  const ledger=new SpeechLedger(dir);
  const first=ledger.run('same-request',Buffer.from('a'),()=>new Promise(r=>release=r));
  await assert.rejects(ledger.run('same-request',Buffer.from('a'),async()=>({})),/uncertain/);
  release({status:'transmitted'});await first;
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('decode real PCM tone to camera AAC; reject corrupt input',async()=>{
 const samples=16000;const wav=Buffer.alloc(44+samples*2);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
 wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
 wav.write('data',36);wav.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*12000),44+i*2);
 const aac=await transcode(wav,'wav','adts');validateAac(aac);assert.ok(aac.length>1000);
 await assert.rejects(transcode(Buffer.from('invalid'),'mp3','adts'),/decoded/);
 assert.throws(()=>transcode(wav,'file','adts'),/Unsupported/);
});
